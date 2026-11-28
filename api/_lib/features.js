// Feature extraction: turns raw NWS data into the handful of numbers that drive
// a school decision, all measured against one specific school morning.
//
// Superintendents decide around 5 AM using what fell overnight, what the roads
// and bus stops will be like from 5 to 9 AM, and what is coming during the
// school day. Every input here is cut to those windows in Eastern time.

const { easternToMs, addDays } = require('./easternTime');
const { calculateWindChill, INDIANA_COUNTY_CODE } = require('./noaa');

const HOUR = 60 * 60 * 1000;

// Time windows (epoch ms) around target school day T, Eastern wall-clock:
//   overnight   6 PM the evening before -> 8 AM T   what lands on the roads
//   busTime     4 AM -> 9 AM T                      decision time and the bus run
//   schoolDay   8 AM -> 3 PM T                      weather that forces an early dismissal
function getWindows(targetDate) {
  const eveningBefore = easternToMs(addDays(targetDate, -1), 18);
  return {
    overnight: [eveningBefore, easternToMs(targetDate, 8)],
    lateEvening: [eveningBefore, easternToMs(targetDate, 4)],
    busTime: [easternToMs(targetDate, 4), easternToMs(targetDate, 9)],
    coldCheck: [easternToMs(targetDate, 5), easternToMs(targetDate, 9)],
    schoolDay: [easternToMs(targetDate, 8), easternToMs(targetDate, 15)],
    afterBuses: [easternToMs(targetDate, 9), easternToMs(targetDate, 15)],
    ice: [eveningBefore, easternToMs(targetDate, 12)]
  };
}

function overlapMs(aStart, aEnd, [bStart, bEnd]) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

// Total of a per-period quantity (snow, ice) inside a window. Periods that
// straddle the window edge are counted in proportion to their overlap.
function accumulate(series, window) {
  let total = 0;
  let coveredMs = 0;
  for (const point of series || []) {
    const overlap = overlapMs(point.start, point.end, window);
    if (overlap <= 0 || point.value == null) continue;
    total += point.value * (overlap / (point.end - point.start));
    coveredMs += overlap;
  }
  if (coveredMs === 0) return null;
  return { total, coverage: coveredMs / (window[1] - window[0]) };
}

// The parts of a per-period series that fall inside a window, as
// { start, end, value } with each straddling period cut to the window and its
// amount scaled to match.
function clipToWindow(series, window) {
  const pieces = [];
  for (const point of series || []) {
    // Saved blocks are stored compactly as [start, end, value]
    const { start, end, value } = Array.isArray(point)
      ? { start: point[0], end: point[1], value: point[2] }
      : point;
    const overlap = overlapMs(start, end, window);
    if (overlap <= 0 || value == null) continue;
    pieces.push({
      start: Math.max(start, window[0]),
      end: Math.min(end, window[1]),
      value: value * (overlap / (end - start))
    });
  }
  return pieces.sort((x, y) => x.start - y.start);
}

// Per-period amounts for a window that may be partly in the past.
//
// The grid drops hours as they pass (it keeps about six), so by early morning
// it only reports the snow still to come: the total shrinks although the storm
// did exactly what was forecast. The hours the grid no longer covers are taken
// from the periods saved with the forecast on file - those hours only, so
// nothing is counted twice.
function blocksForWindow(series, window, savedBlocks, nowMs) {
  const live = clipToWindow(series, window);
  if (!savedBlocks || savedBlocks.length === 0 || nowMs <= window[0]) return live;

  const liveFrom = live.length > 0 ? live[0].start : window[1];
  if (liveFrom <= window[0]) return live;
  return [...clipToWindow(savedBlocks, [window[0], liveFrom]), ...live];
}

const sumBlocks = blocks => (blocks.length > 0 ? blocks.reduce((sum, block) => sum + block.value, 0) : null);

function minimumOver(series, window) {
  let min = null;
  for (const point of series || []) {
    if (point.value == null || overlapMs(point.start, point.end, window) <= 0) continue;
    if (min === null || point.value < min) min = point.value;
  }
  return min;
}

// --- Alerts ------------------------------------------------------------------

// NWS products that actually move school decisions, with a starting weight:
// the chance of a disruption when that product is in effect at bus time.
//
// Weights are provisional. They come from cross-checking archived Indiana
// County alerts against this project's closure history: over three winters, at
// least 19 of the 32 school mornings (59%) with a winter advisory or warning in
// effect at bus time ended in a recorded delay or closure. The other 13 have no
// record either way, because the history before Feb 2026 only lists disruptions.
// Recalibrate once the prediction log holds a full winter of open and closed days.
//
// Not listed on purpose: Freeze Warning / Freeze Watch / Frost Advisory. Those
// are growing-season notices for gardeners and farmers and have nothing to do
// with roads or buses.
const ALERT_CATALOG = [
  { pattern: /blizzard warning/i, kind: 'storm', level: 'warning', weight: 0.85 },
  { pattern: /ice storm warning/i, kind: 'storm', level: 'warning', weight: 0.80 },
  { pattern: /winter storm warning/i, kind: 'storm', level: 'warning', weight: 0.75 },
  { pattern: /lake effect snow warning/i, kind: 'storm', level: 'warning', weight: 0.70 },
  { pattern: /(extreme cold|wind chill) warning/i, kind: 'cold', level: 'warning', weight: 0.70 },
  { pattern: /freezing rain advisory/i, kind: 'storm', level: 'advisory', weight: 0.55 },
  { pattern: /winter weather advisory/i, kind: 'storm', level: 'advisory', weight: 0.50 },
  { pattern: /(cold weather|wind chill) advisory/i, kind: 'cold', level: 'advisory', weight: 0.45 },
  { pattern: /snow squall warning/i, kind: 'squall', level: 'warning', weight: 0.25 },
  { pattern: /(winter storm|blizzard|lake effect snow|extreme cold|wind chill) watch/i, kind: 'watch', level: 'watch', weight: 0.15 }
];

// How much an alert counts depending on when it is in effect.
const ALERT_TIMING = {
  'bus-time': { factor: 1.0, label: 'in effect for the morning bus run' },
  'school-day': { factor: 0.6, label: 'begins during the school day' },
  'overnight': { factor: 0.5, label: 'ends overnight before buses run' }
};

function classifyAlert(eventName) {
  return ALERT_CATALOG.find(entry => entry.pattern.test(eventName || '')) || null;
}

// Winter alerts that apply to this place and this morning: one per kind
// (the strongest), so the same advisory issued for several zones counts once.
function selectAlerts(alerts, windows, zones) {
  const strongestByKind = new Map();

  for (const alert of alerts || []) {
    // Alerts for neighboring counties ride along for the banner only
    if (alert.affectsIndianaCounty === false) continue;
    if (zones && Array.isArray(alert.zones) &&
        !alert.zones.some(code => zones.includes(code) || code === INDIANA_COUNTY_CODE)) {
      continue;
    }

    const entry = classifyAlert(alert.event);
    if (!entry) continue;

    const parsedStart = Date.parse(alert.onset);
    const parsedEnd = Date.parse(alert.ends || alert.expires);
    const start = Number.isFinite(parsedStart) ? parsedStart : -Infinity;
    const end = Number.isFinite(parsedEnd) ? parsedEnd : Infinity;

    let timing = null;
    if (overlapMs(start, end, windows.busTime) > 0) timing = 'bus-time';
    else if (overlapMs(start, end, windows.afterBuses) > 0) timing = 'school-day';
    else if (overlapMs(start, end, windows.lateEvening) > 0) timing = 'overnight';
    if (!timing) continue;

    // Squalls last under an hour; one that is over before buses run is history
    if (entry.kind === 'squall' && timing !== 'bus-time') continue;

    keepStrongest(strongestByKind, {
      event: alert.event,
      kind: entry.kind,
      level: entry.level,
      timing,
      weight: entry.weight * ALERT_TIMING[timing].factor,
      ends: Number.isFinite(parsedEnd) ? new Date(parsedEnd).toISOString() : null
    });
  }

  return rankAlerts(strongestByKind);
}

function keepStrongest(strongestByKind, alert) {
  const current = strongestByKind.get(alert.kind);
  if (!current || alert.weight > current.weight) {
    strongestByKind.set(alert.kind, alert);
  }
}

function rankAlerts(strongestByKind) {
  // A watch is the early heads-up for a warning or advisory; once one of those
  // is out for the same morning the watch adds nothing.
  if (strongestByKind.has('storm') || strongestByKind.has('cold')) {
    strongestByKind.delete('watch');
  }
  return [...strongestByKind.values()].sort((a, b) => b.weight - a.weight);
}

// Alerts saved with the forecast on file, as { event, timing, ends }. The log
// stores them compactly: labels like "Winter Weather Advisory@bus-time" plus a
// parallel list of end times.
function savedAlerts(onFile) {
  return (onFile?.alerts || []).map((alert, i) => {
    if (typeof alert !== 'string') return alert;
    const [event, timing] = alert.split('@');
    return { event, timing, ends: onFile.alertEnds?.[i] ?? null };
  });
}

// Add back alerts that were on file for this morning and are no longer in the
// live list.
//
// NWS removes an alert from its active feed the minute its end time passes.
// An advisory that ran until 1 AM, or until 7 AM, therefore disappears while
// it still explains the morning's roads. One whose scheduled end has passed
// ran its course and still counts; one that vanished before its end time was
// cancelled and does not. With `feedDown` (the feed could not be read at all)
// every saved alert is kept, since there is no newer information.
function withSavedAlerts(liveAlerts, onFile, nowMs, { feedDown = false } = {}) {
  const strongestByKind = new Map(liveAlerts.map(alert => [alert.kind, alert]));

  for (const saved of savedAlerts(onFile)) {
    const end = Date.parse(saved.ends);
    const ranItsCourse = Number.isFinite(end) && end <= nowMs;
    if (!feedDown && !ranItsCourse) continue;

    const entry = classifyAlert(saved.event);
    if (!entry || !ALERT_TIMING[saved.timing]) continue;
    keepStrongest(strongestByKind, {
      event: saved.event,
      kind: entry.kind,
      level: entry.level,
      timing: saved.timing,
      weight: entry.weight * ALERT_TIMING[saved.timing].factor,
      ends: saved.ends ?? null
    });
  }

  return rankAlerts(strongestByKind);
}

// --- Precipitation type at bus time -------------------------------------------

const ICE_TYPES = new Set(['freezing_rain', 'freezing_drizzle', 'sleet']);
const SNOW_TYPES = new Set(['snow', 'snow_showers', 'blowing_snow']);
const UNLIKELY_COVERAGE = new Set(['slight_chance', 'isolated', 'few']);

function commutePrecipFromGrid(weatherSeries, window) {
  let result = null;
  for (const point of weatherSeries || []) {
    if (overlapMs(point.start, point.end, window) <= 0) continue;
    for (const type of point.types) {
      if (UNLIKELY_COVERAGE.has(type.coverage)) continue;
      if (ICE_TYPES.has(type.weather)) return 'ice';
      if (SNOW_TYPES.has(type.weather)) result = 'snow';
    }
  }
  return result;
}

const ICE_WORDS = /freezing rain|freezing drizzle|sleet|wintry mix|ice pellets/;
const SNOW_WORDS = /snow|flurr/;

function commutePrecipFromHourly(hourlyForecast, window) {
  let result = null;
  for (const period of hourlyForecast?.periods || []) {
    const start = Date.parse(period.startTime);
    if (!(start >= window[0] && start < window[1])) continue;
    if ((period.probabilityOfPrecipitation ?? 100) < 30) continue;
    const text = (period.shortForecast || '').toLowerCase();
    if (ICE_WORDS.test(text)) return 'ice';
    if (SNOW_WORDS.test(text)) result = 'snow';
  }
  return result;
}

// --- Worded-forecast fallback -------------------------------------------------

// Snow amount from an NWS forecast sentence. Only reads phrases that are
// explicitly about snow accumulation, so rain totals ("between 1 and 2 inches")
// are never mistaken for snow. Ranges return their midpoint.
function parseSnowInches(text) {
  const match = (text || '').toLowerCase().match(/snow(?: and sleet)? accumulation of ([^.]*)/);
  if (!match) return 0;
  const phrase = match[1];

  const range = phrase.match(/(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)\s*inch/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  if (/less than (a |one )?half/.test(phrase)) return 0.25;
  if (/less than (an?|one) inch/.test(phrase)) return 0.5;
  if (/half (an|of an) inch|a half inch/.test(phrase)) return 0.5;
  const single = phrase.match(/(\d+(?:\.\d+)?)\s*inch/);
  if (single) return Number(single[1]);
  if (/(an|one) inch/.test(phrase)) return 1;
  return 0;
}

// Ice amount from an NWS forecast sentence (0.05 when ice is mentioned without
// a usable number).
function parseIceInches(text) {
  const lower = (text || '').toLowerCase();
  const match = lower.match(/ice accumulation of ([^.]*(?:\.\d[^.]*)*)/);
  if (match) {
    const phrase = match[1];
    const range = phrase.match(/(\d*\.\d+|\d+)\s*to\s*(\d*\.\d+|\d+)/);
    if (range) return (Number(range[1]) + Number(range[2])) / 2;
    if (/less than/.test(phrase)) return 0.05;
    if (/quarter/.test(phrase)) return 0.25;
    if (/tenth/.test(phrase)) return 0.1;
    const single = phrase.match(/(\d*\.\d+)/);
    if (single) return Number(single[1]);
    return 0.05;
  }
  return ICE_WORDS.test(lower) ? 0.05 : 0;
}

function windMphFromText(windSpeed) {
  const numbers = String(windSpeed || '').match(/\d+/g);
  return numbers ? Math.max(...numbers.map(Number)) : 0;
}

// Features from the worded forecast, used only when the numeric grid is down.
function featuresFromText(forecast, hourlyForecast, windows) {
  let snowOvernightIn = 0;
  let snowSchoolDayIn = 0;
  let iceIn = 0;
  let found = false;

  for (const period of forecast?.periods || []) {
    const start = Date.parse(period.startTime);
    const end = Date.parse(period.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const text = period.detailedForecast || period.shortForecast || '';

    if (overlapMs(start, end, windows.overnight) >= 3 * HOUR && !period.isDaytime) {
      snowOvernightIn += parseSnowInches(text);
      iceIn = Math.max(iceIn, parseIceInches(text));
      found = true;
    } else if (overlapMs(start, end, windows.schoolDay) >= 3 * HOUR) {
      snowSchoolDayIn += parseSnowInches(text);
      iceIn = Math.max(iceIn, parseIceInches(text));
      found = true;
    }
  }

  let minTempF = null;
  let minWindChillF = null;
  for (const period of hourlyForecast?.periods || []) {
    const start = Date.parse(period.startTime);
    if (!(start >= windows.coldCheck[0] && start < windows.coldCheck[1])) continue;
    if (period.temperature == null) continue;
    const chill = calculateWindChill(period.temperature, windMphFromText(period.windSpeed));
    if (minTempF === null || period.temperature < minTempF) minTempF = period.temperature;
    if (minWindChillF === null || chill < minWindChillF) minWindChillF = chill;
    found = true;
  }

  return found ? { snowOvernightIn, snowSchoolDayIn, iceIn, minTempF, minWindChillF } : null;
}

// --- Main entry ----------------------------------------------------------------

const round = (value, places) => {
  if (value == null) return null;
  const scale = Math.pow(10, places);
  return Math.round(value * scale) / scale;
};

// Everything the model looks at for one place and one school morning.
//
//   targetDate  YYYY-MM-DD of the school day being forecast
//   grid        getGridForecast() result for the place (preferred source)
//   forecast / hourlyForecast   worded forecasts (fallback when grid is missing)
//   alerts      getAlerts().alerts
//   zones       NWS zone codes covering the place, e.g. ['PAZ077']
//   current     getCurrentConditions() result, used once the morning is underway
//   onFile      features saved earlier for this same morning, if any. They
//               supply the hours the grid has dropped and the alerts that have
//               since run their course.
//   alertsAvailable  false when the alert feed could not be read
function buildFeatures({
  targetDate, grid, forecast, hourlyForecast, alerts, zones, current, onFile,
  alertsAvailable = true, now = new Date()
}) {
  const windows = getWindows(targetDate);
  const nowMs = new Date(now).getTime();

  const features = {
    targetDate,
    leadHours: Math.round((windows.busTime[0] + HOUR - nowMs) / HOUR),
    source: 'none',
    snowOvernightIn: null,
    snowSchoolDayIn: null,
    iceIn: null,
    minTempF: null,
    minWindChillF: null,
    commutePrecip: null,
    alerts: withSavedAlerts(selectAlerts(alerts, windows, zones), onFile, nowMs, { feedDown: !alertsAvailable }),
    alertsAvailable,
    snowBlocks: [],
    iceBlocks: []
  };

  const series = grid?.series;
  if (series) {
    features.snowSchoolDayIn = accumulate(series.snowfallAmount, windows.schoolDay)?.total ?? null;
    features.minTempF = minimumOver(series.temperature, windows.coldCheck);
    features.minWindChillF = minimumOver(series.windChill, windows.coldCheck) ??
      minimumOver(series.apparentTemperature, windows.coldCheck);
    features.commutePrecip = commutePrecipFromGrid(series.weather, windows.coldCheck);
  }

  // Snow and ice: what the grid still shows, plus the hours it has dropped
  features.snowBlocks = blocksForWindow(series?.snowfallAmount, windows.overnight, onFile?.snowBlocks, nowMs);
  features.iceBlocks = blocksForWindow(series?.iceAccumulation, windows.ice, onFile?.iceBlocks, nowMs);
  features.snowOvernightIn = sumBlocks(features.snowBlocks);
  features.iceIn = sumBlocks(features.iceBlocks);

  if (series && (features.snowOvernightIn !== null || features.minWindChillF !== null)) {
    features.source = 'grid';
  }

  // With the grid unreachable on the morning itself, the forecast on file is
  // the best information left. (When the grid does answer, its own numbers
  // stand: an older, colder forecast must not override a newer one.)
  if (onFile && !series && nowMs > windows.overnight[0]) {
    for (const key of ['snowOvernightIn', 'snowSchoolDayIn', 'iceIn', 'minTempF', 'minWindChillF', 'commutePrecip']) {
      if (features[key] === null && onFile[key] != null) features[key] = onFile[key];
    }
    if (features.snowOvernightIn !== null || features.minWindChillF !== null) features.source = 'on-file';
  }

  // The grid only carries snow and ice amounts about three days out, and can be
  // down altogether. Fill whatever it could not answer from the worded forecast.
  if (features.snowOvernightIn === null || features.minWindChillF === null) {
    const fallback = featuresFromText(forecast, hourlyForecast, windows);
    if (fallback) {
      for (const key of ['snowOvernightIn', 'snowSchoolDayIn', 'iceIn', 'minTempF', 'minWindChillF']) {
        if (features[key] === null) features[key] = fallback[key];
      }
      if (features.commutePrecip === null) {
        features.commutePrecip = commutePrecipFromHourly(hourlyForecast, windows.coldCheck);
      }
      features.source = features.source === 'grid' ? 'grid+text' : 'text';
    }
  }

  // Once the target morning has arrived, the thermometer outranks the forecast
  const observedF = current?.temperature?.fahrenheit;
  if (observedF != null && nowMs >= windows.busTime[0] && nowMs <= windows.coldCheck[1]) {
    const observedChill = calculateWindChill(observedF, current.windSpeed?.mph ?? null);
    features.minTempF = features.minTempF === null ? observedF : Math.min(features.minTempF, observedF);
    features.minWindChillF = features.minWindChillF === null ? observedChill : Math.min(features.minWindChillF, observedChill);
    if (features.source === 'none') features.source = 'observed';
  }

  features.snowOvernightIn = round(features.snowOvernightIn, 1);
  features.snowSchoolDayIn = round(features.snowSchoolDayIn, 1);
  features.iceIn = round(features.iceIn, 2);
  features.minTempF = round(features.minTempF, 0);
  features.minWindChillF = round(features.minWindChillF, 0);

  return features;
}

// The form a forecast's features take in the prediction log.
function compactFeatures(features) {
  const compactBlocks = blocks => blocks.map(b => [b.start, b.end, round(b.value, 3)]);
  return {
    source: features.source,
    snowOvernightIn: features.snowOvernightIn,
    snowSchoolDayIn: features.snowSchoolDayIn,
    iceIn: features.iceIn,
    minTempF: features.minTempF,
    minWindChillF: features.minWindChillF,
    commutePrecip: features.commutePrecip,
    alerts: features.alerts.map(alert => `${alert.event}@${alert.timing}`),
    alertEnds: features.alerts.map(alert => alert.ends ?? null),
    snowBlocks: compactBlocks(features.snowBlocks),
    iceBlocks: compactBlocks(features.iceBlocks)
  };
}

module.exports = {
  buildFeatures,
  compactFeatures,
  getWindows,
  selectAlerts,
  withSavedAlerts,
  classifyAlert,
  parseSnowInches,
  parseIceInches,
  ALERT_CATALOG,
  ALERT_TIMING
};
