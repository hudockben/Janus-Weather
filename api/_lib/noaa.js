const BASE_URL = 'https://api.weather.gov';
const USER_AGENT = 'JanusForecastModel/1.0 (contact@example.com)';

// Indiana County locations
const LOCATIONS = {
  indiana: { name: 'Indiana', lat: 40.6215, lon: -79.1525 },
  homercity: { name: 'Homer City', lat: 40.5423, lon: -79.1556 },
  blairsville: { name: 'Blairsville', lat: 40.4312, lon: -79.2609 },
  saltsburg: { name: 'Saltsburg', lat: 40.4884, lon: -79.4517 },
  clymer: { name: 'Clymer', lat: 40.6687, lon: -79.0117 },
  marioncenter: { name: 'Marion Center', lat: 40.7687, lon: -79.0467 }
};

// NWS forecast zones that make up Indiana County (verified with /points lookups):
//   PAZ077 "Indiana"                        - Indiana, Homer City, Marion Center, Clymer, Commodore
//   PAZ078 "Higher Elevations of Indiana"   - the southeast ridges: Armagh, Heilwood
// County-based products (e.g. Snow Squall Warnings) carry the county code instead.
const INDIANA_COUNTY_ZONES = ['PAZ077', 'PAZ078'];
const INDIANA_COUNTY_CODE = 'PAC063';
// Neighbors shown in the alerts banner for regional awareness (Allegheny, Beaver).
// These never feed the school prediction.
const REGIONAL_ZONES = ['PAZ021', 'PAZ020'];

const REQUEST_TIMEOUT_MS = 8000;
const MM_PER_INCH = 25.4;
const METERS_PER_MILE = 1609.344;

// How far back the alert history is read, and how long that request may take.
// Three days reaches well before the evening that opens any school morning's
// windows; the request is tried once so a slow answer cannot hold up the page.
const ALERT_HISTORY_MS = 72 * 60 * 60 * 1000;
const ALERT_HISTORY_TIMEOUT_MS = 5000;

async function fetchWithRetry(url, retries = 3, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/geo+json'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// Grid point metadata never changes for a coordinate, so look it up once per
// process instead of once per forecast call.
const gridPointCache = new Map();

async function getGridPoint(lat, lon) {
  const key = `${lat},${lon}`;
  if (!gridPointCache.has(key)) {
    const data = await fetchWithRetry(`${BASE_URL}/points/${lat},${lon}`);
    gridPointCache.set(key, data.properties);
  }
  return gridPointCache.get(key);
}

// The newest observation often arrives with the temperature still blank.
// Walk back through the last few reports to find one that has it.
async function getLatestCompleteObservation(stationId) {
  const latest = await fetchWithRetry(`${BASE_URL}/stations/${stationId}/observations/latest`);
  if (latest.properties?.temperature?.value != null) return latest.properties;

  try {
    const recent = await fetchWithRetry(`${BASE_URL}/stations/${stationId}/observations?limit=8`, 1);
    const complete = (recent.features || []).find(f => f.properties?.temperature?.value != null);
    if (complete) return complete.properties;
  } catch (error) {
    // Fall through to the incomplete report
  }
  return latest.properties;
}

// NWS wind chill formula (valid at or below 50 deg F with wind above 3 mph).
function calculateWindChill(tempF, windMph) {
  if (tempF == null) return null;
  if (windMph == null || tempF > 50 || windMph <= 3) return Math.round(tempF);
  const v = Math.pow(windMph, 0.16);
  return Math.round(35.74 + 0.6215 * tempF - 35.75 * v + 0.4275 * tempF * v);
}

const stationCache = new Map();

async function getNearestStation(location) {
  const key = `${location.lat},${location.lon}`;
  if (!stationCache.has(key)) {
    const gridPoint = await getGridPoint(location.lat, location.lon);
    const stationsData = await fetchWithRetry(gridPoint.observationStations);
    const nearestStation = stationsData.features[0];
    if (!nearestStation) {
      throw new Error('No observation stations found');
    }
    stationCache.set(key, nearestStation.properties);
  }
  return stationCache.get(key);
}

// What the station actually recorded between two instants, e.g. this morning's
// 5-9 AM bus window. Unlike "latest observation", the answer does not depend
// on what time of day the question is asked.
//
// With `precipFromMs` (earlier than startMs) the result also says what the
// station saw from then until endMs:
//   precipIn         what its gauge measured, in inches of water. The gauge at
//                    the Indiana County airport registers rain but not snow, so
//                    zero here does not mean nothing fell.
//   minVisibilityMi  the lowest visibility reported, in miles (null if the
//                    station sent none). Falling snow always cuts visibility;
//                    a night that stayed at six miles or more had none.
async function getObservedWindow(locationKey, startMs, endMs, { precipFromMs = null } = {}) {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const station = await getNearestStation(location);
  const fromMs = precipFromMs !== null ? Math.min(precipFromMs, startMs) : startMs;
  const url = `${BASE_URL}/stations/${station.stationIdentifier}/observations` +
    `?start=${new Date(fromMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const data = await fetchWithRetry(url);
  const observations = (data.features || []).map(f => f.properties);

  const readings = observations
    .filter(o => o.temperature?.value != null && Date.parse(o.timestamp) >= startMs)
    .map(o => {
      const tempF = o.temperature.value * 9 / 5 + 32;
      const windMph = o.windSpeed?.value != null ? o.windSpeed.value * 0.621371 : null;
      return { tempF, windMph, windChillF: calculateWindChill(tempF, windMph) };
    });

  if (readings.length === 0) return null;

  const result = {
    station: station.name,
    count: readings.length,
    minTempF: Math.round(Math.min(...readings.map(r => r.tempF))),
    minWindChillF: Math.min(...readings.map(r => r.windChillF))
  };

  if (precipFromMs !== null) {
    // Each report gives the last hour's total; several reports in one clock
    // hour repeat it, so count the largest per hour.
    const byHour = new Map();
    for (const o of observations) {
      const mm = o.precipitationLastHour?.value;
      if (mm == null) continue;
      const hour = Math.floor(Date.parse(o.timestamp) / 3600000);
      byHour.set(hour, Math.max(byHour.get(hour) || 0, mm));
    }
    const totalMm = [...byHour.values()].reduce((sum, mm) => sum + mm, 0);
    result.precipIn = Math.round((totalMm / MM_PER_INCH) * 100) / 100;

    const visibilities = observations.map(o => o.visibility?.value).filter(v => v != null);
    result.minVisibilityMi = visibilities.length > 0
      ? Math.round((Math.min(...visibilities) / METERS_PER_MILE) * 10) / 10
      : null;
  }

  return result;
}

async function getCurrentConditions(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const nearestStation = { properties: await getNearestStation(location) };

  const stationId = nearestStation.properties.stationIdentifier;
  const props = await getLatestCompleteObservation(stationId);

  return {
    location: location.name,
    station: nearestStation.properties.name,
    timestamp: props.timestamp,
    temperature: {
      value: props.temperature?.value,
      unit: 'C',
      fahrenheit: props.temperature?.value != null
        ? Math.round(props.temperature.value * 9/5 + 32)
        : null
    },
    humidity: props.relativeHumidity?.value,
    windSpeed: {
      value: props.windSpeed?.value,
      unit: 'km/h',
      mph: props.windSpeed?.value != null
        ? Math.round(props.windSpeed.value * 0.621371)
        : null
    },
    windDirection: props.windDirection?.value,
    description: props.textDescription,
    icon: props.icon,
    barometricPressure: props.barometricPressure?.value,
    visibility: props.visibility?.value,
    dewpoint: {
      value: props.dewpoint?.value,
      fahrenheit: props.dewpoint?.value != null
        ? Math.round(props.dewpoint.value * 9/5 + 32)
        : null
    }
  };
}

async function getForecast(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const forecastUrl = gridPoint.forecast;

  const forecast = await fetchWithRetry(forecastUrl);

  return {
    location: location.name,
    updated: forecast.properties.updated,
    periods: forecast.properties.periods.map(period => ({
      name: period.name,
      startTime: period.startTime,
      endTime: period.endTime,
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit,
      windSpeed: period.windSpeed,
      windDirection: period.windDirection,
      shortForecast: period.shortForecast,
      detailedForecast: period.detailedForecast,
      icon: period.icon,
      isDaytime: period.isDaytime
    }))
  };
}

async function getHourlyForecast(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const hourlyUrl = gridPoint.forecastHourly;

  const forecast = await fetchWithRetry(hourlyUrl);
  const periods = forecast.properties.periods.slice(0, 48);

  return {
    location: location.name,
    updated: forecast.properties.updated,
    periods: periods.map(period => ({
      startTime: period.startTime,
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit,
      windSpeed: period.windSpeed,
      windDirection: period.windDirection,
      shortForecast: period.shortForecast,
      icon: period.icon,
      probabilityOfPrecipitation: period.probabilityOfPrecipitation?.value || 0
    }))
  };
}

// Is this feed item an alert that is really in force?
//
// The "active" feed also carries test messages, and it keeps a cancellation
// notice listed until the cancelled alert's original end time. Such a notice
// looks like the alert itself (same event name, same end time) but says
// "has been cancelled": response AllClear, VTEC action CAN. An alert that was
// upgraded to another product (VTEC action UPG) is likewise no longer in force.
function isAlertInForce(props) {
  if (props.status && props.status !== 'Actual') return false;
  if (props.messageType === 'Cancel') return false;
  if (props.response === 'AllClear') return false;
  const actions = (props.parameters?.VTEC || []).map(code => code.split('.')[1]);
  if (actions.length > 0 && actions.every(action => action === 'CAN' || action === 'UPG')) return false;
  return true;
}

// --- Alert history ------------------------------------------------------------
//
// The "active" feed only shows what is in force this minute. An advisory that
// ended at 1 AM, or was cancelled at 4 AM, is simply gone from it, although
// what it said still explains the morning's roads. The history feed lists every
// message NWS sent: the alert, each update, and the notice that it was
// cancelled or had expired. Read together, they say when each alert was really
// in force.

// "/O.CON.KPBZ.WW.Y.0012.000000T0000Z-261127T0000Z/" - the tracking code NWS
// puts on every watch, warning and advisory. It names the action taken (NEW,
// CON-tinued, EXT-ended, CAN-celled, UPG-raded, EXP-ired ...), the event
// (office, product, number) and its start and end. A start of all zeros means
// the event is already under way.
const VTEC_PATTERN = /^\/?[A-Z]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6}T\d{4}Z)-(\d{6}T\d{4}Z)\/?$/;

function parseVtecTime(text) {
  const match = text.match(/^(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/);
  if (!match || text.startsWith('000000')) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return Date.UTC(2000 + year, month - 1, day, hour, minute);
}

function parseVtec(code) {
  const match = String(code).match(VTEC_PATTERN);
  if (!match) return null;
  return {
    action: match[1],
    event: `${match[2]}.${match[3]}.${match[4]}.${match[5]}`,
    begins: parseVtecTime(match[6]),
    ends: parseVtecTime(match[7])
  };
}

// When each alert was in force, worked out from every message about it.
//
//   features  alert messages from the NWS API (history and active feeds
//             together; duplicates are ignored)
//   codes     zone and county codes to follow
//
// Returns one entry per alert and code, shaped like getAlerts().alerts:
// { event, onset, ends, zones: [code], affectsIndianaCounty, cancelled }.
// `ends` is when the alert really stopped: the time NWS cancelled or upgraded
// it, otherwise the end time in its latest message (so an alert that was
// extended or cut short carries its final end time).
//
// Only messages with a tracking code are followed. Every product the school
// forecast uses carries one.
function buildAlertTimeline(features, codes = [...INDIANA_COUNTY_ZONES, INDIANA_COUNTY_CODE]) {
  const wanted = new Set(codes);
  const seen = new Set();
  const chains = new Map();

  for (const feature of features || []) {
    const props = feature?.properties;
    if (!props || seen.has(props.id)) continue;
    seen.add(props.id);
    if (props.status && props.status !== 'Actual') continue;

    const sent = Date.parse(props.sent);
    if (!Number.isFinite(sent)) continue;
    const vtecs = (props.parameters?.VTEC || []).map(parseVtec).filter(Boolean);

    for (const code of props.geocode?.UGC || []) {
      if (!wanted.has(code)) continue;
      for (const vtec of vtecs) {
        const key = `${code}|${vtec.event}`;
        if (!chains.has(key)) chains.set(key, { code, messages: [] });
        // A message that carries one tracking code is named after that event
        chains.get(key).messages.push({ props, sent, vtec, named: vtecs.length === 1 });
      }
    }
  }

  const timeline = [];
  for (const { code, messages } of chains.values()) {
    messages.sort((a, b) => a.sent - b.sent);
    const newestFirst = [...messages].reverse();
    const latest = newestFirst[0];

    // Cancelled, or replaced by a stronger product: over from that moment
    const cancelled = latest.vtec.action === 'CAN' || latest.vtec.action === 'UPG';
    const end = cancelled
      ? latest.sent
      : latest.vtec.ends ?? Date.parse(latest.props.ends || latest.props.expires);

    // The start comes from the newest message sent before the event began;
    // if none is in view, the event was already running at the oldest one.
    const beforeStart = newestFirst.find(message => message.vtec.begins !== null);
    const oldest = messages[0].props;
    const start = beforeStart
      ? beforeStart.vtec.begins
      : Date.parse(oldest.onset || oldest.effective || oldest.sent);

    // (An alert cancelled before it began was never in force)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    timeline.push({
      event: (newestFirst.find(message => message.named) || latest).props.event,
      onset: new Date(start).toISOString(),
      ends: new Date(end).toISOString(),
      zones: [code],
      affectsIndianaCounty: true,
      cancelled
    });
  }

  return timeline.sort((a, b) => a.onset.localeCompare(b.onset) || a.event.localeCompare(b.event));
}

// Alerts for Indiana County and its neighbors.
//
// With `history`, the result also carries `timeline`: when each Indiana County
// alert of the last three days was really in force (see buildAlertTimeline),
// or null if the history could not be read.
async function getAlerts({ history = false, now = new Date() } = {}) {
  const zones = [...INDIANA_COUNTY_ZONES, INDIANA_COUNTY_CODE, ...REGIONAL_ZONES];
  const alertsUrl = `${BASE_URL}/alerts/active?zone=${zones.join(',')}`;

  const since = new Date(new Date(now).getTime() - ALERT_HISTORY_MS).toISOString();
  const historyUrl = `${BASE_URL}/alerts?zone=${[...INDIANA_COUNTY_ZONES, INDIANA_COUNTY_CODE].join(',')}` +
    `&start=${since}&limit=200`;

  const [alerts, past] = await Promise.all([
    fetchWithRetry(alertsUrl),
    history ? fetchWithRetry(historyUrl, 1, ALERT_HISTORY_TIMEOUT_MS).catch(() => null) : null
  ]);

  const indianaCodes = new Set([...INDIANA_COUNTY_ZONES, INDIANA_COUNTY_CODE]);
  const westernPACounties = ['indiana', 'allegheny', 'westmoreland', 'armstrong', 'cambria', 'jefferson', 'clearfield'];

  const relevantAlerts = (alerts.features || [])
    .filter(alert => isAlertInForce(alert.properties))
    .map(alert => {
      const props = alert.properties;
      const ugc = props.geocode?.UGC || [];
      return {
        id: props.id,
        event: props.event,
        severity: props.severity,
        certainty: props.certainty,
        urgency: props.urgency,
        headline: props.headline,
        description: props.description,
        instruction: props.instruction,
        // onset/ends bracket the weather itself. `expires` is only when this
        // bulletin is due to be reissued, usually hours before the event ends.
        onset: props.onset || props.effective,
        ends: props.ends || props.expires,
        expires: props.expires,
        areas: props.areaDesc,
        zones: ugc,
        affectsIndianaCounty: ugc.some(code => indianaCodes.has(code))
      };
    })
    .filter(alert => {
      if (alert.affectsIndianaCounty) return true;
      const areas = (alert.areas || '').toLowerCase();
      return westernPACounties.some(county => areas.includes(county));
    })
    // Indiana County's own alerts lead the list
    .sort((a, b) => Number(b.affectsIndianaCounty) - Number(a.affectsIndianaCounty));

  return {
    count: relevantAlerts.length,
    alerts: relevantAlerts,
    timeline: past ? buildAlertTimeline([...(past.features || []), ...(alerts.features || [])]) : null
  };
}

// --- Quantitative forecast grid ---------------------------------------------
//
// The NWS grid carries the forecasters' actual numbers (inches of snow and ice
// per period, hourly wind chill) for a 2.5 km cell. Reading these beats pulling
// numbers back out of the worded forecast, where "1 to 2 inches" of rain looks
// the same as "1 to 2 inches" of snow.

const GRID_FIELDS = {
  snowfallAmount: mm => mm / MM_PER_INCH,          // inches
  iceAccumulation: mm => mm / MM_PER_INCH,         // inches
  windChill: c => c * 9 / 5 + 32,                  // deg F
  apparentTemperature: c => c * 9 / 5 + 32,        // deg F
  temperature: c => c * 9 / 5 + 32,                // deg F
  windSpeed: kmh => kmh * 0.621371,                // mph
  probabilityOfPrecipitation: pct => pct           // percent
};

// "PT6H", "P1DT6H", "PT30M" -> milliseconds
function parseIsoDuration(duration) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration || '');
  if (!match) return 0;
  const [, days = 0, hours = 0, minutes = 0] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 * 1000;
}

// "2026-11-25T12:00:00+00:00/PT6H" -> { start, end } in epoch ms
function parseValidTime(validTime) {
  const [startIso, duration] = String(validTime).split('/');
  const start = Date.parse(startIso);
  return { start, end: start + parseIsoDuration(duration) };
}

function normalizeGridSeries(field, convert) {
  return (field?.values || [])
    .map(({ validTime, value }) => ({
      ...parseValidTime(validTime),
      value: value == null ? null : convert(value)
    }))
    .filter(point => Number.isFinite(point.start) && point.end > point.start);
}

// Precipitation types by period: [{ start, end, types: [{ weather, coverage, intensity }] }]
function normalizeGridWeather(field) {
  return (field?.values || [])
    .map(({ validTime, value }) => ({
      ...parseValidTime(validTime),
      types: (value || [])
        .filter(w => w && w.weather)
        .map(w => ({ weather: w.weather, coverage: w.coverage, intensity: w.intensity }))
    }))
    .filter(point => Number.isFinite(point.start) && point.end > point.start);
}

// Quantitative forecast for a location key or a { lat, lon } point.
async function getGridForecast(target = 'indiana') {
  const location = typeof target === 'string' ? LOCATIONS[target] : target;
  if (!location) {
    throw new Error(`Unknown location: ${target}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const data = await fetchWithRetry(gridPoint.forecastGridData, 2);
  const props = data.properties;

  const series = {};
  for (const [name, convert] of Object.entries(GRID_FIELDS)) {
    series[name] = normalizeGridSeries(props[name], convert);
  }
  series.weather = normalizeGridWeather(props.weather);

  return {
    updated: props.updateTime,
    series
  };
}

function getLocations() {
  return Object.entries(LOCATIONS).map(([key, value]) => ({
    key,
    name: value.name,
    lat: value.lat,
    lon: value.lon
  }));
}

module.exports = {
  getCurrentConditions,
  getForecast,
  getHourlyForecast,
  getGridForecast,
  getObservedWindow,
  getAlerts,
  isAlertInForce,
  buildAlertTimeline,
  getLocations,
  parseValidTime,
  calculateWindChill,
  LOCATIONS,
  INDIANA_COUNTY_ZONES,
  INDIANA_COUNTY_CODE
};
