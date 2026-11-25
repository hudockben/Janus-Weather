// Weather Logger
//
// Each run does three things, and is safe to run any number of times a day:
//   1. Records today's actual school statuses with the conditions buses ran in.
//   2. Scores the forecast that was on file for today.
//   3. Saves (or refreshes) the forecast for the next school day.
//
// Nothing here assumes the run happens at a particular time. GitHub starts
// scheduled jobs hours late, so dates are Eastern calendar dates, the morning
// weather comes from the station's 5-9 AM record, and SchoolCast's own date
// header decides which day a status belongs to.

const fs = require('fs');
const path = require('path');
const { getObservedWindow } = require('./noaa');
const {
  getSchoolStatuses,
  predictAllDistricts,
  isNonWeatherRecord,
  INDIANA_COUNTY_SCHOOLS,
  NON_WINTER_TEMP_F
} = require('./schoolDelay');
const { fetchForecastInputs } = require('./schoolForecast');
const { getWindows, selectAlerts } = require('./features');
const { easternParts } = require('./easternTime');
const { getNonSchoolReason, getTargetSchoolDay, isWinterSeason } = require('./schoolCalendar');

const HISTORICAL_DATA_PATH = path.join(__dirname, 'historicalData.json');
const PREDICTION_LOG_PATH = path.join(__dirname, 'predictionLog.json');

// Version 2 = Indiana County alerts + numeric NWS grid (Nov 2026).
// Entries without a version are the original keyword model.
const MODEL_VERSION = 2;

// Districts post decisions by about 5:30 AM; before this hour today's status
// cannot be read yet.
const OUTCOME_READY_HOUR = 6;

// A forecast made before this hour is still about this morning; after it, the
// forecast is for the next school day.
const FORECAST_ROLLOVER_HOUR = 3;

// Map school codes to names used in historical data
const SCHOOL_CODE_TO_NAME = {
  'IASD': 'Indiana',
  'HCSD': 'Homer-Center',
  'MCASD': 'Marion Center',
  'PMASD': 'Penns Manor',
  'PLSD': 'Purchase Line',
  'USD': 'United'
};

const SCHOOL_NAME_FIXES = { 'Homer Center': 'Homer-Center' };

// Normalize status to match historical data format
function normalizeStatus(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === 'closed' || s.includes('remote')) return 'closed';
  if (s.includes('delay')) return 'delay';
  if (s.includes('early dismissal')) return 'early dismissal';
  if (s.includes('flexible instruction')) return 'flexible instruction day';
  if (s === 'open') return 'open';
  return null; // Unknown status, don't log
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return [];
  }
}

function loadHistoricalData() {
  return loadJson(HISTORICAL_DATA_PATH);
}

function saveHistoricalData(data) {
  fs.writeFileSync(HISTORICAL_DATA_PATH, JSON.stringify(data, null, 2));
}

function loadPredictionLog() {
  return loadJson(PREDICTION_LOG_PATH);
}

function savePredictionLog(log) {
  fs.writeFileSync(PREDICTION_LOG_PATH, JSON.stringify(log, null, 2));
}

function findRecord(historicalData, school, date) {
  return historicalData.find(record =>
    (SCHOOL_NAME_FIXES[record.school] || record.school) === school && record.date === date
  );
}

// --- Reading today's outcome -----------------------------------------------------

// Decide what SchoolCast is telling us about one district today.
// Returns { status } or { skip: reason, problem?: true }.
function readTodayStatus(statusInfo, today, easternHour) {
  if (easternHour < OUTCOME_READY_HOUR) {
    return { skip: `Too early to read today's status (before ${OUTCOME_READY_HOUR} AM Eastern)` };
  }
  if (!statusInfo || statusInfo.source !== 'SchoolCast') {
    return { skip: `No reliable status source (${statusInfo?.source || 'unavailable'})`, problem: true };
  }

  const status = normalizeStatus(statusInfo.status);
  if (!status) {
    return { skip: `Unknown status${statusInfo.raw ? ` "${statusInfo.raw}"` : ''}`, problem: true };
  }

  const pageDate = statusInfo.statusDate;
  if (pageDate && pageDate > today) {
    // The page has moved on to tomorrow's announcements
    return { skip: `SchoolCast already shows statuses for ${pageDate}; today's were missed`, problem: true };
  }
  if (pageDate && pageDate < today && status !== 'open') {
    // A status left up from an earlier day is not an announcement for today
    return { skip: `SchoolCast still shows "${statusInfo.raw}" from ${pageDate}; not confirmed for today`, problem: true };
  }

  return { status };
}

// Was there anything wintry going on? A closure with no winter weather behind
// it (holiday, in-service day, burst pipe, heat) must not be scored or learned
// from as a weather closure.
function classifyCause(status, weather) {
  if (status === 'open') return null;
  if (weather.temperature != null && weather.temperature >= NON_WINTER_TEMP_F) return 'non-winter';

  const wintry = weather.alerts.length > 0 ||
    (weather.snowfall || 0) >= 0.3 ||
    (weather.iceIn || 0) >= 0.01 ||
    weather.commutePrecip != null ||
    (weather.feelsLike != null && weather.feelsLike <= 10);
  const freezing = weather.temperature != null && weather.temperature <= 32;
  const closed = status === 'closed' || status === 'flexible instruction day';

  // Above freezing, dry and no alert: a full closure is not about the weather.
  // (A delay under the same conditions is kept - black ice and fog are real.)
  if (!wintry && !freezing && closed) return 'non-winter';
  return null;
}

function describeType(status, cause, weather) {
  if (cause === 'non-winter') return 'non-weather';
  if ((weather.iceIn || 0) >= 0.01 || weather.commutePrecip === 'ice') return 'ice';
  if ((weather.snowfall || 0) >= 6) return 'heavy snow';
  if ((weather.snowfall || 0) >= 0.3 || weather.commutePrecip === 'snow' ||
      weather.alerts.some(event => /winter (storm|weather)|blizzard|snow/i.test(event))) return 'snow';
  if (weather.feelsLike != null && weather.feelsLike <= 0) return 'frigid temperature';
  return status === 'open' ? 'normal' : 'unknown';
}

// --- Prediction log ----------------------------------------------------------------

function compactFeatures(features) {
  return {
    source: features.source,
    snowOvernightIn: features.snowOvernightIn,
    snowSchoolDayIn: features.snowSchoolDayIn,
    iceIn: features.iceIn,
    minTempF: features.minTempF,
    minWindChillF: features.minWindChillF,
    commutePrecip: features.commutePrecip,
    alerts: features.alerts.map(alert => `${alert.event}@${alert.timing}`)
  };
}

// The forecast on file for a district and date (never a backtest seed)
function findPrediction(predictionLog, school, date) {
  return predictionLog.find(entry =>
    entry.date === date && entry.school === school && entry.source !== 'backtest');
}

// Features of the forecast on file for a school morning, by district code
function getForecastOnFile(targetDate, predictionLog = loadPredictionLog()) {
  const onFile = {};
  for (const school of INDIANA_COUNTY_SCHOOLS) {
    const entry = findPrediction(predictionLog, SCHOOL_CODE_TO_NAME[school.code], targetDate);
    if (entry?.features) onFile[school.code] = entry.features;
  }
  return onFile;
}

// Has the forecast moved since it was last written down?
function forecastChanged(existing, fields) {
  return existing.modelVersion !== fields.modelVersion ||
    existing.probability !== fields.probability ||
    existing.closureProbability !== fields.closureProbability ||
    existing.announcedBeforeForecast !== fields.announcedBeforeForecast ||
    (existing.features?.alerts || []).join('|') !== fields.features.alerts.join('|');
}

// Save the forecast for `targetDate`, replacing an earlier forecast for the
// same morning when it has changed. Earlier versions are kept in `history` so
// accuracy can later be compared by how far ahead the forecast was made.
// Returns how many entries were written.
function saveForecast(predictionLog, forecast, schoolStatuses, now) {
  let saved = 0;
  for (const district of forecast.districts) {
    const school = SCHOOL_CODE_TO_NAME[district.school.code];
    const existing = findPrediction(predictionLog, school, forecast.targetDate);
    if (existing && existing.actualStatus !== null) continue; // already scored

    const fields = {
      delayProbability: district.delayProbability,
      closureProbability: district.closureProbability,
      probability: district.probability,
      predictedDisruption: district.predictedDisruption,
      madeAt: new Date(now).toISOString(),
      leadHours: district.features.leadHours,
      modelVersion: MODEL_VERSION,
      features: compactFeatures(district.features)
    };

    // If the district has already announced for that morning, note it: the
    // forecast is still scored on the weather, but it was no longer a guess.
    const posted = schoolStatuses[district.school.code];
    const announced = posted?.statusDate === forecast.targetDate ? normalizeStatus(posted.status) : null;
    if (announced && announced !== 'open') fields.announcedBeforeForecast = announced;

    if (existing) {
      // An unchanged forecast keeps its original timestamp, so repeated runs
      // on a quiet day write nothing.
      if (!forecastChanged(existing, fields)) continue;
      if (existing.madeAt) {
        existing.history = [...(existing.history || []), {
          madeAt: existing.madeAt,
          probability: existing.probability
        }].slice(-6);
      }
      delete existing.announcedBeforeForecast;
      Object.assign(existing, fields);
    } else {
      predictionLog.push({
        date: forecast.targetDate,
        school,
        ...fields,
        actualStatus: null,
        correct: null
      });
    }
    saved++;
  }
  return saved;
}

// Score the forecasts on file for today against what actually happened.
function resolvePredictions(predictionLog, outcomes, today) {
  let resolved = 0;
  for (const entry of predictionLog) {
    if (entry.date !== today || entry.actualStatus !== null || entry.source === 'backtest') continue;

    const noSchool = getNonSchoolReason(today, entry.school);
    if (noSchool) {
      entry.actualStatus = 'no school';
      entry.excluded = noSchool;
      resolved++;
      continue;
    }

    const outcome = outcomes[entry.school];
    if (!outcome || !outcome.status) continue;

    entry.actualStatus = outcome.status;
    if (outcome.cause === 'non-winter') {
      entry.excluded = 'Non-weather closure';
    } else {
      entry.correct = entry.predictedDisruption === (outcome.status !== 'open');
    }
    resolved++;
  }
  return resolved;
}

// --- Main ----------------------------------------------------------------------------

async function logWeatherData(options = {}) {
  const {
    forceLog = false,  // If true, log open days outside winter too (for testing)
    dryRun = false,    // If true, don't actually write to file
    now = new Date()
  } = options;

  // Where the data comes from. Tests replace these to replay a specific morning.
  const sources = { fetchForecastInputs, getSchoolStatuses, getObservedWindow, ...options.sources };

  const eastern = easternParts(now);
  const today = eastern.dateStr;
  const windows = getWindows(today);
  const results = {
    date: today,
    logged: [],
    skipped: [],
    errors: []
  };

  try {
    const morningIsOver = new Date(now).getTime() > windows.coldCheck[0];

    const [inputs, schoolStatuses, morningObs] = await Promise.all([
      sources.fetchForecastInputs(),
      sources.getSchoolStatuses().catch(err => {
        results.errors.push({ type: 'school_status_fetch', message: err.message });
        return {};
      }),
      morningIsOver
        ? sources.getObservedWindow('indiana', ...windows.coldCheck).catch(err => {
          results.errors.push({ type: 'morning_observations_fetch', message: err.message });
          return null;
        })
        : null
    ]);
    results.errors.push(...inputs.errors);

    const historicalData = loadHistoricalData();
    const predictionLog = loadPredictionLog();
    const outcomes = {};

    // --- 1. Today's outcomes ---
    for (const school of INDIANA_COUNTY_SCHOOLS) {
      const schoolName = SCHOOL_CODE_TO_NAME[school.code];

      // A record already written today is the outcome of record
      const existing = findRecord(historicalData, schoolName, today);
      if (existing) {
        outcomes[schoolName] = {
          status: existing.status,
          cause: isNonWeatherRecord(existing) ? 'non-winter' : null
        };
        results.skipped.push({ school: schoolName, reason: 'Record already exists for today' });
        continue;
      }

      // Weekends, holidays and listed days off (in-service days etc.) are not
      // school days: nothing to record, and no weather lesson in the closure.
      const noSchool = getNonSchoolReason(today, schoolName);
      if (noSchool) {
        results.skipped.push({ school: schoolName, reason: `Not a school day: ${noSchool}` });
        continue;
      }

      const reading = readTodayStatus(schoolStatuses[school.code], today, eastern.hour);
      if (reading.skip) {
        results.skipped.push({ school: schoolName, reason: reading.skip });
        if (reading.problem) {
          results.errors.push({ type: 'status_not_recorded', message: `${schoolName}: ${reading.skip}` });
        }
        continue;
      }

      // Conditions buses ran in: the station's 5-9 AM record, the forecast that
      // was on file for this morning, and alerts covering the district.
      const onFile = findPrediction(predictionLog, schoolName, today)?.features || {};
      const liveAlerts = selectAlerts(inputs.alerts, windows, school.zones).map(a => a.event);
      const filedAlerts = (onFile.alerts || []).map(label => label.split('@')[0]);
      const weather = {
        temperature: morningObs?.minTempF ?? onFile.minTempF ?? null,
        feelsLike: morningObs?.minWindChillF ?? onFile.minWindChillF ?? null,
        snowfall: onFile.snowOvernightIn ?? 0,
        iceIn: onFile.iceIn ?? 0,
        commutePrecip: onFile.commutePrecip ?? null,
        alerts: [...new Set([...filedAlerts, ...liveAlerts])]
      };

      if (weather.temperature === null) {
        results.skipped.push({ school: schoolName, reason: 'No morning weather observations available' });
        results.errors.push({ type: 'status_not_recorded', message: `${schoolName}: no morning weather observations` });
        continue;
      }

      const cause = classifyCause(reading.status, weather);
      outcomes[schoolName] = { status: reading.status, cause };

      // During winter season (Nov-Mar), log ALL days including open days
      // so there is baseline data for normal vs. disruption days.
      // Outside winter season, only log disruptions (or if forceLog is set).
      if (reading.status === 'open' && !isWinterSeason(today) && !forceLog) {
        results.skipped.push({
          school: schoolName,
          reason: 'School is open (outside winter season, no disruption to log)'
        });
        continue;
      }

      const record = {
        school: schoolName,
        date: today,
        status: reading.status,
        temperature: weather.temperature,
        snowfall: weather.snowfall,
        type: describeType(reading.status, cause, weather),
        feelsLike: weather.feelsLike ?? weather.temperature,
        v: 2,
        // Eastern time the status was read. A morning delay can be cleared
        // from SchoolCast by afternoon, so a late "open" is less certain.
        readAt: `${String(eastern.hour).padStart(2, '0')}:${String(eastern.minute).padStart(2, '0')}`
      };
      if (cause) record.cause = cause;
      if (weather.alerts.length > 0) record.alerts = weather.alerts;

      if (!dryRun) {
        historicalData.push(record);
      }
      results.logged.push(record);
    }

    if (results.logged.length > 0 && !dryRun) {
      saveHistoricalData(historicalData);
    }

    // --- 2. Score today's forecast, 3. save the next one ---
    try {
      const resolved = resolvePredictions(predictionLog, outcomes, today);

      const targetDate = getTargetSchoolDay(now, { cutoffHour: FORECAST_ROLLOVER_HOUR });
      const forecast = predictAllDistricts(inputs, {
        now,
        targetDate,
        onFile: getForecastOnFile(targetDate, predictionLog)
      });

      let saved = 0;
      if (forecast.noData) {
        results.errors.push({
          type: 'no_weather_data',
          message: 'Could not fetch alerts or forecasts from NOAA; no forecast saved'
        });
      } else {
        saved = saveForecast(predictionLog, forecast, schoolStatuses, now);
      }

      if (!dryRun) {
        savePredictionLog(predictionLog);
      }

      results.predictions = {
        resolved,
        targetDate,
        savedForTarget: saved,
        forecast: forecast.districts.map(d => ({
          school: SCHOOL_CODE_TO_NAME[d.school.code],
          probability: d.probability,
          delayProbability: d.delayProbability,
          closureProbability: d.closureProbability,
          factors: d.factors.map(f => f.factor)
        }))
      };
    } catch (error) {
      results.errors.push({ type: 'prediction_tracking', message: error.message });
    }

    const liveAlertNames = [...new Set(INDIANA_COUNTY_SCHOOLS.flatMap(school =>
      selectAlerts(inputs.alerts, windows, school.zones).map(a => a.event)))];

    results.summary = {
      totalSchools: INDIANA_COUNTY_SCHOOLS.length,
      recorded: results.logged.length,
      skipped: results.skipped.length,
      weatherConditions: {
        temperature: morningObs?.minTempF ?? null,
        windChill: morningObs?.minWindChillF ?? null,
        snowfall: results.logged[0]?.snowfall ?? 0,
        type: results.logged[0]?.type ?? null,
        alerts: liveAlertNames
      },
      dryRun: dryRun
    };

    return results;

  } catch (error) {
    results.errors.push({
      type: 'fetch_error',
      message: error.message
    });
    return results;
  }
}

// --- Scorecard -----------------------------------------------------------------------
//
// Disruptions are rare, so "percent of days called correctly" rewards a model
// that always says "open". The scorecard instead counts what matters:
//   caught        disruption forecast, disruption happened
//   missed        no disruption forecast, disruption happened
//   false alarms  disruption forecast, school was open
// Quiet days called correctly are counted but never inflate the headline.

function tally(entries) {
  const counts = { caught: 0, missed: 0, falseAlarms: 0, quietDaysCorrect: 0 };
  for (const entry of entries) {
    const disrupted = entry.actualStatus !== 'open';
    if (disrupted && entry.predictedDisruption) counts.caught++;
    else if (disrupted) counts.missed++;
    else if (entry.predictedDisruption) counts.falseAlarms++;
    else counts.quietDaysCorrect++;
  }

  const disruptions = counts.caught + counts.missed;
  const calls = counts.caught + counts.falseAlarms;
  const dates = entries.map(e => e.date).sort();

  // Brier score on winter-season days: average squared gap between the stated
  // chance and what happened (0 is perfect). Skill compares it with always
  // quoting the season's average rate; above 0 means the forecast adds value.
  const winter = entries.filter(e => isWinterSeason(e.date));
  let brier = null;
  let brierSkill = null;
  if (winter.length > 0) {
    const outcome = e => (e.actualStatus !== 'open' ? 1 : 0);
    const stated = e => Math.min(100, e.probability ?? (e.delayProbability + e.closureProbability)) / 100;
    brier = winter.reduce((sum, e) => sum + Math.pow(stated(e) - outcome(e), 2), 0) / winter.length;
    const baseRate = winter.reduce((sum, e) => sum + outcome(e), 0) / winter.length;
    const reference = baseRate * (1 - baseRate);
    brierSkill = reference > 0 ? Math.round((1 - brier / reference) * 100) / 100 : null;
    brier = Math.round(brier * 1000) / 1000;
  }

  return {
    scored: entries.length,
    disruptions,
    ...counts,
    hitRate: disruptions > 0 ? Math.round((counts.caught / disruptions) * 100) : null,
    falseAlarmRatio: calls > 0 ? Math.round((counts.falseAlarms / calls) * 100) : null,
    since: dates[0] || null,
    through: dates[dates.length - 1] || null,
    winterDaysScored: winter.length,
    brier,
    brierSkill
  };
}

// Live forecasts that have a verified outcome worth scoring: not backtest
// seeds, not non-school days, not closures unrelated to weather.
function getScorableEntries(log = loadPredictionLog()) {
  // Outcome records, to recognize non-weather closures among older entries
  const history = new Map(loadHistoricalData().map(record =>
    [`${record.date}:${SCHOOL_NAME_FIXES[record.school] || record.school}`, record]));

  return log.filter(entry => {
    if (entry.source === 'backtest') return false;
    if (typeof entry.correct !== 'boolean' || entry.excluded) return false;
    // Entries from before the calendar existed: drop non-school days and
    // closures that had nothing to do with weather
    if (getNonSchoolReason(entry.date, entry.school)) return false;
    const record = history.get(`${entry.date}:${entry.school}`);
    return !(record && isNonWeatherRecord(record));
  });
}

// Get prediction accuracy stats
function getPredictionAccuracy() {
  const log = loadPredictionLog();
  const today = easternParts().dateStr;

  const live = log.filter(e => e.source !== 'backtest');
  const scorable = getScorableEntries(log);
  const pending = live.filter(e => e.actualStatus === null && e.date >= today);

  if (scorable.length === 0) {
    return {
      total: 0,
      correct: 0,
      accuracy: 0,
      status: pending.length > 0 ? 'collecting' : 'no-data',
      pendingCount: pending.length,
      totalResolved: 0
    };
  }

  const currentEntries = scorable.filter(e => e.modelVersion === MODEL_VERSION);
  const previousEntries = scorable.filter(e => e.modelVersion !== MODEL_VERSION);

  // Fields the original self-audit display reads (last 30 scored predictions)
  const recent = scorable.slice(-30);
  const correctCount = recent.filter(e => e.correct).length;
  let streak = 0;
  for (let i = scorable.length - 1; i >= 0 && scorable[i].correct; i--) streak++;

  return {
    status: 'active',
    modelVersion: MODEL_VERSION,
    current: currentEntries.length > 0 ? tally(currentEntries) : null,
    previous: previousEntries.length > 0 ? tally(previousEntries) : null,
    total: recent.length,
    correct: correctCount,
    accuracy: Math.round((correctCount / recent.length) * 100),
    streak,
    lastResolvedDate: scorable[scorable.length - 1].date,
    pendingCount: pending.length,
    totalResolved: scorable.length,
    liveCount: recent.length,
    backtestCount: 0
  };
}

// Get logging status (check what would be logged without actually logging)
async function getLoggingPreview() {
  return logWeatherData({ dryRun: true, forceLog: true });
}

module.exports = {
  logWeatherData,
  getLoggingPreview,
  loadHistoricalData,
  getPredictionAccuracy,
  normalizeStatus,
  readTodayStatus,
  classifyCause,
  resolvePredictions,
  saveForecast,
  getScorableEntries,
  getForecastOnFile,
  tally,
  SCHOOL_CODE_TO_NAME,
  MODEL_VERSION
};
