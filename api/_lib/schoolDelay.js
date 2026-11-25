// School Delay Prediction for Indiana County, PA
// Analyzes weather conditions to estimate delay/closure probability

const { buildFeatures, ALERT_TIMING } = require('./features');
const { getNonSchoolReason, getTargetSchoolDay } = require('./schoolCalendar');

// lat/lon is the point whose NWS forecast grid represents the district.
// zones are the NWS forecast zones its bus routes run through: PAZ077 is
// "Indiana", PAZ078 is "Higher Elevations of Indiana" (the southeast ridges),
// which regularly gets a warning while the rest of the county gets an advisory.
const INDIANA_COUNTY_SCHOOLS = [
  {
    name: 'Indiana Area School District',
    code: 'IASD',
    shortName: 'Indiana Area',
    website: 'https://www.iasd.cc',
    statusUrl: 'https://www.iasd.cc',
    twitter: '@IndianaAreaSD',
    lat: 40.6215,
    lon: -79.1525,
    zones: ['PAZ077']
  },
  {
    name: 'Homer-Center School District',
    code: 'HCSD',
    shortName: 'Homer-Center',
    website: 'https://www.homercenter.org',
    statusUrl: 'https://www.homercenter.org',
    twitter: null,
    lat: 40.5423,
    lon: -79.1556,
    zones: ['PAZ077']
  },
  {
    name: 'Marion Center Area School District',
    code: 'MCASD',
    shortName: 'Marion Center',
    website: 'https://www.mcasd.net',
    statusUrl: 'https://www.mcasd.net',
    twitter: null,
    lat: 40.7687,
    lon: -79.0467,
    zones: ['PAZ077']
  },
  {
    // Clymer sits in the lower zone; the schools near Heilwood and the eastern
    // half of the district are in the higher-elevation zone.
    name: 'Penns Manor Area School District',
    code: 'PMASD',
    shortName: 'Penns Manor',
    website: 'https://www.pennsmanor.org',
    statusUrl: 'https://www.pennsmanor.org',
    twitter: null,
    lat: 40.6367,
    lon: -78.9539,
    zones: ['PAZ077', 'PAZ078']
  },
  {
    name: 'Purchase Line School District',
    code: 'PLSD',
    shortName: 'Purchase Line',
    website: 'https://www.plsd.k12.pa.us',
    statusUrl: 'https://www.plsd.k12.pa.us',
    twitter: null,
    lat: 40.7092,
    lon: -78.9447,
    zones: ['PAZ077']
  },
  {
    name: 'United School District',
    code: 'USD',
    shortName: 'United',
    website: 'https://www.unitedsd.net',
    statusUrl: 'https://www.unitedsd.net',
    twitter: null,
    lat: 40.4536,
    lon: -79.0314,
    zones: ['PAZ078']
  }
];

// Status cache to avoid hitting sources too frequently
let statusCache = {
  lastUpdated: null,
  statuses: {}
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Fetch school closings from ARIN IU28 SchoolCast (official source for Indiana County)
async function checkSchoolCast() {
  try {
    const response = await fetch('https://schoolcast.iu28.org', {
      headers: { 'User-Agent': 'JanusForecastModel/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const html = await response.text();
    return html;
  } catch (error) {
    console.error('Error fetching SchoolCast:', error);
    return null;
  }
}

// Fallback: fetch from local radio station closings pages
async function checkLocalRadio() {
  const urls = [
    'https://www.wccsradio.com/?s=school+closings',
    'https://www.wdadradio.com/?s=school+closings'
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'JanusForecastModel/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      const html = await response.text();
      if (html) return html;
    } catch (error) {
      console.error(`Error fetching ${url}:`, error);
    }
  }
  return null;
}

// --- SchoolCast parsing --------------------------------------------------------
//
// SchoolCast prints one block per district under a dated header:
//
//   <h4>Status for Monday, November 16, 2026</h4>
//   <p class="sc_entname">Indiana Area</p>
//   <p class="sc_entstatus">2 Hour Delay</p>
//
// The header date matters: the page keeps showing the last posted statuses
// until someone changes them, and the evening before a storm it already shows
// tomorrow's. A status only describes a given day if the header says so.

// District names as SchoolCast prints them (lower case). A longer form of the
// same name also matches, e.g. "Marion Center Area".
const SCHOOLCAST_NAMES = {
  'IASD': ['indiana area'],
  'HCSD': ['homer-center', 'homer center'],
  'MCASD': ['marion center'],
  'PMASD': ['penns manor'],
  'PLSD': ['purchase line'],
  'USD': ['united']
};

function findSchoolCastEntry(entries, schoolCode) {
  const names = SCHOOLCAST_NAMES[schoolCode] || [];
  const key = Object.keys(entries).find(entryName =>
    names.some(name => entryName === name || entryName.startsWith(`${name} `)));
  return key ? entries[key] : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// Map SchoolCast's status label (plus any note under it) to our status names
function classifyStatusText(statusText, detailText = '') {
  const status = (statusText || '').toLowerCase();
  const everything = `${status} ${(detailText || '').toLowerCase()}`;
  const remote = /flexible instruction|remote (learning|instruction)|virtual/;

  if (/^\s*(open|on time|normal)/.test(status)) return 'open';
  if (remote.test(everything)) return 'flexible instruction';
  if (/clos/.test(status)) return 'closed';
  if (/delay/.test(status)) return /(2|two)[\s-]*h(ou)?r/.test(status) ? '2-hour delay' : 'delayed';
  if (/dismiss/.test(status)) return 'early dismissal';
  return 'unknown';
}

// Parse the SchoolCast page into { statusDate, entries: { name: { status, raw, detail } } }
function parseSchoolCast(html) {
  if (!html) return null;

  const entries = {};
  const names = [...html.matchAll(/class="sc_entname"[^>]*>([^<]*)</gi)];

  names.forEach((match, i) => {
    const blockEnd = i + 1 < names.length ? names[i + 1].index : match.index + 2000;
    // Stop at the end of this district's block so a neighbor's status or the
    // next section heading can never leak in.
    const block = html.slice(match.index, blockEnd).split(/<div class="sc_entity"|<h[1-6]|<!--/i)[0];
    const status = block.match(/class="sc_entstatus"[^>]*>([^<]*)</i);
    if (!status) return;

    // (the match ends on the '<' of the closing tag; keep it so the tag strips cleanly)
    const detail = block.slice(status.index + status[0].length - 1)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    entries[match[1].trim().toLowerCase()] = {
      status: classifyStatusText(status[1], detail),
      raw: status[1].trim(),
      detail
    };
  });

  if (Object.keys(entries).length === 0) return null;

  let statusDate = null;
  const header = html.match(/Status for\s+(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (header) {
    const month = MONTHS.indexOf(header[1].toLowerCase()) + 1;
    if (month > 0) {
      statusDate = `${header[3]}-${String(month).padStart(2, '0')}-${header[2].padStart(2, '0')}`;
    }
  }

  return { statusDate, entries };
}

// Loose keyword matching for pages without SchoolCast's structure (the radio
// station fallback). Good enough to show on the site, not to keep as a record.
const SCHOOL_PATTERNS = {
  'IASD': ['indiana area'],
  'HCSD': ['homer-center', 'homer center'],
  'MCASD': ['marion center'],
  'PMASD': ['penns manor'],
  'PLSD': ['purchase line'],
  'USD': ['united']
};

function parseSchoolStatus(schoolCode, htmlContent) {
  if (!htmlContent) return 'unknown';

  const lowerHtml = htmlContent.toLowerCase();
  const patterns = SCHOOL_PATTERNS[schoolCode] || [];

  for (const pattern of patterns) {
    const idx = lowerHtml.indexOf(pattern);
    if (idx === -1) continue;

    // Extract context around the match (200 chars after, 50 before)
    const context = lowerHtml.substring(Math.max(0, idx - 50), idx + 200);

    // For 'united', avoid false positives (e.g. "United States")
    if (schoolCode === 'USD' && pattern === 'united') {
      if (context.includes('united states') || context.includes('united nations')) {
        continue;
      }
    }

    if (context.includes('closed') || context.includes('closure')) {
      return 'closed';
    } else if (context.includes('2 hour') || context.includes('2-hour') || context.includes('two hour') || context.includes('two-hour')) {
      return '2-hour delay';
    } else if (context.includes('delay')) {
      return 'delayed';
    } else if (context.includes('early dismissal')) {
      return 'early dismissal';
    } else if (context.includes('remote learning') || context.includes('remote instruction')) {
      return 'closed';
    } else if (context.includes('flexible instruction')) {
      return 'flexible instruction';
    }
  }

  return 'unknown';
}

// Get current status for all schools.
//
// Each entry carries `statusDate` (the day SchoolCast says its statuses are
// for) and `source`. Only source 'SchoolCast' is reliable enough to log.
async function getSchoolStatuses() {
  const now = Date.now();

  // Return cached statuses if still valid
  if (statusCache.lastUpdated && (now - statusCache.lastUpdated) < CACHE_DURATION) {
    return statusCache.statuses;
  }

  const lastChecked = new Date().toISOString();
  const statuses = {};

  const schoolCastHtml = await checkSchoolCast();
  const schoolCast = parseSchoolCast(schoolCastHtml);

  if (schoolCast) {
    for (const school of INDIANA_COUNTY_SCHOOLS) {
      const entry = findSchoolCastEntry(schoolCast.entries, school.code);
      statuses[school.code] = {
        // SchoolCast lists every district every day. One that is missing means
        // the page changed, so say 'unknown' rather than guessing 'open'.
        status: entry ? entry.status : 'unknown',
        source: 'SchoolCast',
        statusDate: schoolCast.statusDate,
        raw: entry ? entry.raw : null,
        detail: entry ? entry.detail : '',
        lastChecked
      };
    }
  } else {
    // SchoolCast is down or changed its layout: fall back to keyword matching
    const html = schoolCastHtml || await checkLocalRadio();
    const source = schoolCastHtml ? 'SchoolCast (unstructured)' : 'Local Radio';

    for (const school of INDIANA_COUNTY_SCHOOLS) {
      let status = parseSchoolStatus(school.code, html);

      // If source is available but school not mentioned, assume open
      if (status === 'unknown' && html) {
        status = 'open';
      }

      statuses[school.code] = {
        status,
        source: html ? source : 'unavailable',
        statusDate: null,
        raw: null,
        detail: '',
        lastChecked
      };
    }
  }

  // Update cache
  statusCache = {
    lastUpdated: now,
    statuses: statuses
  };

  return statuses;
}

// --- History ---------------------------------------------------------------------

const rawHistoricalData = require('./historicalData.json');

const SCHOOL_NAME_FIXES = { 'Homer Center': 'Homer-Center' };

// Above this morning temperature a closure cannot be about snow, ice or cold.
const NON_WINTER_TEMP_F = 45;

// A closure with nothing wintry going on (holiday, in-service day, building
// problem, summer heat) teaches the model nothing about weather.
function isNonWeatherRecord(record) {
  if (record.status === 'open') return false;
  if (record.cause === 'non-winter') return true;
  if (record.temperature >= NON_WINTER_TEMP_F) return true;
  const reason = getNonSchoolReason(record.date, record.school);
  return reason !== null && reason !== 'Weekend';
}

// History the model is allowed to learn from: district names made consistent,
// non-weather closures removed.
const historicalData = rawHistoricalData
  .map(record => ({ ...record, school: SCHOOL_NAME_FIXES[record.school] || record.school }))
  .filter(record => !isNonWeatherRecord(record));

// Categorize a weather event based on snowfall and type
function categorizeEvent(snow, type) {
  const typeLower = (type || '').toLowerCase();
  if (typeLower.includes('ice') || typeLower.includes('freezing')) return 'ice';
  if (snow >= 3) return 'heavy-snow';
  if (snow >= 1) return 'light-snow';
  if (typeLower.includes('snow') || typeLower.includes('flurr')) return 'light-snow';
  return 'cold-only';
}

const CLOSURE_LIKE = new Set(['closed', 'flexible instruction day']);
const DELAY_LIKE = new Set(['delay', 'early dismissal']);

// Find the most similar past days and tally how they turned out.
//
// Note what this can and cannot say. Before Feb 2026 only disruptions were
// recorded, so "8 of 8 similar days had a delay" mostly reflects which days got
// written down, not the odds of a delay. The tally is therefore used to judge
// delay-versus-closure once a disruption is likely, and shown for context, but
// it does not set the overall probability.
function findSimilarDays(temperature, feelsLike, snowfall, weatherType, { schoolName = null, limit = 8 } = {}) {
  // Skip matching for mild/non-winter conditions - the dataset is winter events
  const type = (weatherType || '').toLowerCase();
  if (!(snowfall > 0) && !type.includes('snow') && !type.includes('ice') && !type.includes('frigid') && !type.includes('cold')) return null;
  if (temperature == null || feelsLike == null) return null;

  const records = schoolName ? historicalData.filter(r => r.school === schoolName) : historicalData;
  if (records.length === 0) return null;

  const currentCategory = categorizeEvent(snowfall, weatherType);

  const scored = records.map(record => {
    // A day with 0" of snow should never match a day with 6"+
    const snowDiff = Math.abs(record.snowfall - snowfall);
    if (snowDiff > 5) return null;

    // Wind chill drives decisions: 10 deg F is a different day from -17 deg F
    const feelsDiff = Math.abs(record.feelsLike - feelsLike);
    if (feelsDiff > 20) return null;

    let similarity = 0;
    const recordCategory = categorizeEvent(record.snowfall, record.type);

    if (currentCategory === recordCategory) {
      similarity += 4;
    } else if (
      (currentCategory === 'cold-only' && recordCategory === 'heavy-snow') ||
      (currentCategory === 'heavy-snow' && recordCategory === 'cold-only')
    ) {
      similarity -= 6;
    } else {
      similarity -= 2;
    }

    const tempDiff = Math.abs(record.temperature - temperature);
    if (tempDiff <= 5) similarity += 3;
    else if (tempDiff <= 10) similarity += 2;
    else if (tempDiff <= 15) similarity += 1;

    if (feelsDiff <= 5) similarity += 4;
    else if (feelsDiff <= 10) similarity += 3;
    else if (feelsDiff <= 15) similarity += 2;
    else similarity += 1;

    if (snowDiff <= 0.5) similarity += 4;
    else if (snowDiff <= 1) similarity += 3;
    else if (snowDiff <= 2) similarity += 2;
    else if (snowDiff <= 3) similarity += 1;

    const recordType = (record.type || '').toLowerCase();
    if (type && recordType && type === recordType) similarity += 2;
    else if (type && recordType && (type.includes(recordType) || recordType.includes(type))) similarity += 1;

    return { ...record, similarity };
  });

  const matches = scored
    .filter(r => r && r.similarity >= 5)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  if (matches.length === 0) return null;

  const closedCount = matches.filter(r => CLOSURE_LIKE.has(r.status)).length;
  const delayCount = matches.filter(r => DELAY_LIKE.has(r.status)).length;

  return {
    matchCount: matches.length,
    closedCount,
    delayCount,
    disruptionRate: Math.round(((closedCount + delayCount) / matches.length) * 100),
    closureRate: Math.round((closedCount / matches.length) * 100),
    delayRate: Math.round((delayCount / matches.length) * 100),
    topMatches: matches.slice(0, 3).map(m => ({
      school: m.school,
      date: m.date,
      status: m.status,
      temperature: m.temperature,
      feelsLike: m.feelsLike,
      snowfall: m.snowfall,
      type: m.type
    }))
  };
}

function getHistoricalPrediction(temperature, feelsLike, snowfall, weatherType) {
  return findSimilarDays(temperature, feelsLike, snowfall, weatherType);
}

function getSchoolHistoricalPrediction(schoolName, temperature, feelsLike, snowfall, weatherType) {
  return findSimilarDays(temperature, feelsLike, snowfall, weatherType, { schoolName, limit: 5 });
}

// The weather label history records use, derived from the model's inputs
function describeWeatherType(features) {
  const snow = features.snowOvernightIn || 0;
  if ((features.iceIn || 0) >= 0.01 || features.commutePrecip === 'ice') return 'ice';
  if (snow >= 6) return 'heavy snow';
  if (snow >= 0.3 || features.commutePrecip === 'snow' || features.alerts.some(a => a.kind === 'storm')) return 'snow';
  if (features.minWindChillF != null && features.minWindChillF <= 10) return 'frigid temperature';
  return '';
}

// --- Scoring ---------------------------------------------------------------------
//
// Each factor carries the chance of a disruption if it were the only thing
// going on. Factors combine as independent chances (1 - product of misses), so
// stacking related signals - an advisory, the snow it was issued for, snow
// still falling at bus time - raises the total without racing to 95%.

const PREDICT_DISRUPTION_AT = 50;   // percent: "more likely than not"
const MAX_PROBABILITY = 95;

function inches(value) {
  return `${Math.round(value * 10) / 10}"`;
}

function collectFactors(features) {
  const factors = [];
  const add = (factor, chance) => factors.push({ factor, chance });

  for (const alert of features.alerts) {
    add(`${alert.event} ${ALERT_TIMING[alert.timing].label}`, alert.weight);
  }

  const snow = features.snowOvernightIn || 0;
  if (snow >= 6) add(`Heavy snow overnight (about ${inches(snow)})`, 0.60);
  else if (snow >= 3) add(`Snow overnight (about ${inches(snow)})`, 0.40);
  else if (snow >= 1) add(`Light snow overnight (about ${inches(snow)})`, 0.20);
  else if (snow >= 0.3) add(`Dusting of snow overnight (${inches(snow)})`, 0.08);

  const daySnow = features.snowSchoolDayIn || 0;
  if (daySnow >= 4) add(`Heavy snow during the school day (about ${inches(daySnow)})`, 0.35);
  else if (daySnow >= 2) add(`Snow during the school day (about ${inches(daySnow)})`, 0.20);
  else if (daySnow >= 1) add(`Light snow during the school day (about ${inches(daySnow)})`, 0.10);

  const ice = features.iceIn || 0;
  if (ice >= 0.25) add(`Significant icing (about ${Math.round(ice * 100) / 100}")`, 0.85);
  else if (ice >= 0.1) add(`Ice accumulation (about ${Math.round(ice * 100) / 100}")`, 0.65);
  else if (ice >= 0.01) add('Light icing possible', 0.40);

  const chill = features.minWindChillF;
  if (chill != null) {
    if (chill <= -20) add(`Dangerous cold at bus time (${chill}°F wind chill)`, 0.60);
    else if (chill <= -10) add(`Extreme cold at bus time (${chill}°F wind chill)`, 0.40);
    else if (chill <= 0) add(`Very cold at bus time (${chill}°F wind chill)`, 0.20);
    else if (chill <= 10) add(`Cold at bus time (${chill}°F wind chill)`, 0.05);
  }

  if (features.commutePrecip === 'ice') add('Freezing rain or sleet falling at bus time', 0.25);
  else if (features.commutePrecip === 'snow') add('Snow falling at bus time', 0.10);

  return factors.sort((a, b) => b.chance - a.chance);
}

// Share of a disruption that is a closure rather than a delay. Advisory-level
// snow and cold mostly produce two-hour delays here; warnings, 3"+ of snow and
// real icing mostly close schools.
function closureShareFromSeverity(features) {
  const busTimeAlerts = features.alerts.filter(a => a.timing === 'bus-time');
  const stormWarning = busTimeAlerts.some(a => a.kind === 'storm' && a.level === 'warning');
  const coldWarning = busTimeAlerts.some(a => a.kind === 'cold' && a.level === 'warning');
  const snow = features.snowOvernightIn || 0;
  const daySnow = features.snowSchoolDayIn || 0;
  const ice = features.iceIn || 0;
  const chill = features.minWindChillF;

  if (snow >= 6 || ice >= 0.25) return 0.85;
  if (stormWarning) return 0.75;
  if (snow >= 3 || ice >= 0.1 || snow + daySnow >= 5) return 0.65;
  if (coldWarning || (chill != null && chill <= -20)) return 0.60;
  if (snow + daySnow >= 3) return 0.50;
  if (snow >= 1.5) return 0.40;
  return 0.25;
}

function describeRisk(probability, delayProbability, closureProbability) {
  if (probability >= 70) {
    return {
      status: 'high',
      recommendation: closureProbability > delayProbability
        ? 'High likelihood of closure. Monitor local announcements closely.'
        : 'High likelihood of delay or closure. Monitor local announcements.'
    };
  }
  if (probability >= 40) {
    return { status: 'moderate', recommendation: 'Moderate chance of delay. Check school district communications.' };
  }
  if (probability >= 15) {
    return { status: 'low', recommendation: 'Low chance of delay. Normal schedule expected.' };
  }
  return { status: 'minimal', recommendation: 'No significant weather concerns. Normal schedule expected.' };
}

function riskTier(probability) {
  return describeRisk(probability, 0, 0).status;
}

// Score one place for one school morning from its features.
function scoreDisruption(features, { schoolName = null } = {}) {
  // Combine the factors, strongest first. Each factor's "impact" is what it
  // adds on top of the ones above it, so the impacts sum to the total.
  let missChance = 1;
  let runningTotal = 0;
  const factors = [];
  for (const { factor, chance } of collectFactors(features)) {
    missChance *= (1 - chance);
    const total = Math.min(MAX_PROBABILITY, Math.round((1 - missChance) * 100));
    if (total > runningTotal) {
      factors.push({ factor, impact: total - runningTotal });
      runningTotal = total;
    }
  }
  const probability = runningTotal;

  // Similar past days refine delay-versus-closure once there are a few of them
  const historicalMatch = findSimilarDays(
    features.minTempF,
    features.minWindChillF,
    features.snowOvernightIn || 0,
    describeWeatherType(features),
    schoolName ? { schoolName, limit: 5 } : {}
  );

  let closureShare = closureShareFromSeverity(features);
  const pastDisruptions = historicalMatch ? historicalMatch.closedCount + historicalMatch.delayCount : 0;
  if (pastDisruptions >= 3) {
    closureShare = (closureShare + historicalMatch.closedCount / pastDisruptions) / 2;
  }

  const closureProbability = Math.round(probability * closureShare);
  const delayProbability = probability - closureProbability;

  return {
    probability,
    delayProbability,
    closureProbability,
    predictedDisruption: probability >= PREDICT_DISRUPTION_AT,
    ...describeRisk(probability, delayProbability, closureProbability),
    factors,
    // Past days are only worth showing when a disruption is on the table
    historicalMatch: probability >= 15 ? historicalMatch : null
  };
}

const DISCLAIMER = 'This is an estimate based on NWS alerts and forecasts for Indiana County and historical patterns. Weather data refreshes every 10 minutes. Always check official school district announcements for actual delay/closure information.';

// County-wide prediction for one school morning (the county seat's forecast,
// all Indiana County alerts).
//
//   options.grid        getGridForecast() result; the worded forecasts are only
//                       used when it is missing
//   options.targetDate  school day to forecast (default: the next school morning)
//   options.now         time the forecast is being made
function calculateDelayProbability(currentConditions, forecast, hourlyForecast, alerts, options = {}) {
  const now = options.now || new Date();
  const targetDate = options.targetDate || getTargetSchoolDay(now);

  const features = buildFeatures({
    targetDate,
    grid: options.grid || null,
    forecast,
    hourlyForecast,
    alerts,
    zones: options.zones || null,
    current: currentConditions,
    now
  });

  return {
    ...scoreDisruption(features),
    targetDate,
    features,
    schools: INDIANA_COUNTY_SCHOOLS,
    disclaimer: DISCLAIMER
  };
}

// Prediction for every district plus the county-wide summary.
//
//   inputs: { current, forecast, hourlyForecast, alerts, grids: { [code]: grid } }
//   onFile: features saved earlier for this morning, by district code (optional)
function predictAllDistricts(inputs, { now = new Date(), targetDate = getTargetSchoolDay(now), onFile = {} } = {}) {
  const grids = inputs.grids || {};
  const fallbackGrid = grids.IASD || Object.values(grids).find(Boolean) || null;

  const districts = INDIANA_COUNTY_SCHOOLS.map(school => {
    const features = buildFeatures({
      targetDate,
      grid: grids[school.code] || fallbackGrid,
      forecast: inputs.forecast,
      hourlyForecast: inputs.hourlyForecast,
      alerts: inputs.alerts,
      zones: school.zones,
      current: inputs.current,
      onFile: onFile[school.code],
      now
    });
    return { school, features, ...scoreDisruption(features) };
  });

  // County summary: the average district.
  const average = key => districts.reduce((sum, d) => sum + d[key], 0) / districts.length;
  const probability = Math.round(average('probability'));
  const closureProbability = Math.min(probability, Math.round(average('closureProbability')));
  const delayProbability = probability - closureProbability;

  // Explain it as the county seat's factors, plus one line for districts whose
  // weather differs (usually the ridges), so the impacts still sum to the total.
  const seat = districts[0];
  const factors = seat.factors.map(f => ({ ...f }));
  const difference = probability - seat.probability;
  if (difference !== 0) {
    const others = districts.filter(d => Math.sign(d.probability - seat.probability) === Math.sign(difference));
    const names = others.map(d => d.school.shortName).join(', ');
    const seatFactors = new Set(seat.factors.map(f => f.factor));
    const reasons = [...new Set(others.flatMap(d => d.factors.map(f => f.factor)))]
      .filter(factor => !seatFactors.has(factor))
      .slice(0, 2);
    factors.push({
      factor: difference > 0
        ? `Higher risk in ${names}${reasons.length ? ` (${reasons.join('; ')})` : ''}`
        : `Lower risk in ${names}`,
      impact: difference
    });
  }

  // True when there was nothing to base a forecast on (NWS unreachable)
  const noData = !inputs.alertsAvailable && districts.every(d => d.features.source === 'none');

  return {
    targetDate,
    noData,
    county: {
      probability,
      delayProbability,
      closureProbability,
      predictedDisruption: probability >= PREDICT_DISRUPTION_AT,
      ...describeRisk(probability, delayProbability, closureProbability),
      factors,
      historicalMatch: districts[0].historicalMatch,
      features: districts[0].features
    },
    districts
  };
}

// Map school codes to names used in historical data
const SCHOOL_CODE_TO_HISTORICAL_NAME = {
  'IASD': 'Indiana',
  'HCSD': 'Homer-Center',
  'MCASD': 'Marion Center',
  'PMASD': 'Penns Manor',
  'PLSD': 'Purchase Line',
  'USD': 'United'
};

module.exports = {
  calculateDelayProbability,
  predictAllDistricts,
  scoreDisruption,
  riskTier,
  getHistoricalPrediction,
  getSchoolStatuses,
  getSchoolHistoricalPrediction,
  parseSchoolCast,
  findSchoolCastEntry,
  classifyStatusText,
  isNonWeatherRecord,
  INDIANA_COUNTY_SCHOOLS,
  SCHOOL_CODE_TO_HISTORICAL_NAME,
  NON_WINTER_TEMP_F,
  PREDICT_DISRUPTION_AT,
  DISCLAIMER
};
