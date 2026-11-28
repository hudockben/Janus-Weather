// Weather Logger
//
// Each run does three things, and is safe to run any number of times a day:
//   1. Records today's actual school statuses with the conditions buses ran in,
//      and revises that record if a later run sees more (a delay posted after
//      the first read, a delay that became a closure, an early dismissal, the
//      rest of the morning's temperatures).
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
const { getWindows, selectAlerts, compactFeatures } = require('./features');
const { easternParts } = require('./easternTime');
const { getNonSchoolReason, getTargetSchoolDay, isWinterSeason, loadNonWeatherClosures } = require('./schoolCalendar');

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

// The station's 5-9 AM record is complete this long after 9 AM (its reports
// reach the NWS API about half an hour late).
const OBSERVATION_LAG_MS = 45 * 60 * 1000;

// How disruptive each outcome is. A day's record only ever moves up this
// scale: a delay that is later cleared from SchoolCast stays a delay.
const SEVERITY = {
  'open': 0,
  'delay': 1,
  'early dismissal': 1,
  'closed': 2,
  'flexible instruction day': 2
};
const isFullClosure = status => SEVERITY[status] === 2;

// Forecasts built without a real weather forecast behind them are not filed
const DEGRADED_SOURCES = new Set(['none', 'on-file', 'observed']);

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

// A missing file is an empty log. A file that exists but cannot be parsed is
// an error: carrying on with [] would overwrite the real log on the next save.
function loadJson(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path.basename(filePath)} is not valid JSON (${error.message}). ` +
      'Nothing was written; repair or restore the file.');
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
  if (!pageDate && status !== 'open') {
    // Without the page's date there is no telling which day this is about
    return { skip: `SchoolCast shows "${statusInfo.raw}" but its date could not be read; not confirmed for today`, problem: true };
  }
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

// Was this closure about something other than winter weather (a day off that
// is not in the calendar, a building problem, heat)? Such a day must not be
// scored or learned from.
//
// Only outside facts decide this: the airport's morning temperature, alerts
// NWS actually issued, and what the six districts did. The forecast's own snow
// and ice numbers are deliberately not consulted - a storm the model failed to
// see has to count as a miss, not be waved away as "no weather".
function classifyCause(status, weather, countyWideClosure = false) {
  if (status === 'open') return null;
  if (weather.temperature != null && weather.temperature >= NON_WINTER_TEMP_F) return 'non-winter';

  // Every district closed outright with no winter alert from NWS: weather that
  // shuts all six districts without so much as an advisory needs at least
  // freezing temperatures and something falling, or bitter cold. If the airport
  // stayed above freezing, or its gauge measured nothing since the evening
  // before and the wind chill stayed above zero, this was a day off.
  if (countyWideClosure && weather.alerts.length === 0) {
    const aboveFreezing = weather.temperature != null && weather.temperature > 32;
    const dryAndNotBitter = weather.precipIn === 0 && weather.feelsLike != null && weather.feelsLike > 0;
    if (aboveFreezing || dryAndNotBitter) return 'non-winter';
  }

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

// Has the forecast itself moved since it was last written down?
function forecastChanged(existing, fields) {
  return existing.modelVersion !== fields.modelVersion ||
    existing.probability !== fields.probability ||
    existing.closureProbability !== fields.closureProbability;
}

// Have the inputs worth keeping current moved, with the forecast unchanged?
// (Alert end times and per-period snow are what a later run needs in order to
// account for hours and alerts NWS has since dropped.)
function inputsChanged(existing, fields) {
  const key = features => JSON.stringify([
    features?.alerts, features?.alertEnds, features?.snowOvernightIn, features?.iceIn
  ]);
  return key(existing.features) !== key(fields.features);
}

// Save the forecast for `targetDate`, replacing an earlier forecast for the
// same morning when it has changed. Earlier versions are kept in `history` so
// accuracy can later be compared by how far ahead the forecast was made.
// Returns how many entries were written.
function saveForecast(predictionLog, forecast, schoolStatuses, now) {
  let saved = 0;
  for (const district of forecast.districts) {
    // A "forecast" with no weather forecast behind it (NWS unreachable) must
    // never replace a real one, or be filed as one.
    if (DEGRADED_SOURCES.has(district.features.source)) continue;

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
    // Only a successful SchoolCast read can set or clear the note.
    const posted = schoolStatuses[district.school.code];
    const canSeeAnnouncements = posted?.source === 'SchoolCast';
    const announcedStatus = posted?.statusDate === forecast.targetDate ? normalizeStatus(posted.status) : null;
    const announced = announcedStatus && announcedStatus !== 'open' ? announcedStatus : undefined;

    if (!existing) {
      const entry = { date: forecast.targetDate, school, ...fields, actualStatus: null, correct: null };
      if (announced) entry.announcedBeforeForecast = announced;
      predictionLog.push(entry);
      saved++;
      continue;
    }

    let written = false;
    if (forecastChanged(existing, fields)) {
      if (existing.madeAt) {
        existing.history = [...(existing.history || []), {
          madeAt: existing.madeAt,
          probability: existing.probability
        }].slice(-6);
      }
      Object.assign(existing, fields);
      written = true;
    } else if (inputsChanged(existing, fields)) {
      // Same forecast, fresher inputs: keep its original timestamp
      existing.features = fields.features;
      written = true;
    }
    // (An unchanged forecast is left alone, so repeated runs on a quiet day
    // write nothing.)

    if (canSeeAnnouncements && existing.announcedBeforeForecast !== announced) {
      if (announced) existing.announcedBeforeForecast = announced;
      else delete existing.announcedBeforeForecast;
      written = true;
    }

    if (written) saved++;
  }
  return saved;
}

// Score the forecasts on file for today against what actually happened.
// Safe to repeat: if a later run revises the day's record (a status posted
// after the first read, a closure reclassified), the score follows it.
// Returns how many entries were scored or re-scored.
function resolvePredictions(predictionLog, outcomes, today) {
  let resolved = 0;
  for (const entry of predictionLog) {
    if (entry.date !== today || entry.source === 'backtest') continue;

    const noSchool = getNonSchoolReason(today, entry.school);
    if (noSchool) {
      if (entry.actualStatus !== 'no school') {
        entry.actualStatus = 'no school';
        entry.excluded = noSchool;
        entry.correct = null;
        resolved++;
      }
      continue;
    }

    const outcome = outcomes[entry.school];
    if (!outcome || !outcome.status) continue;

    // A scored day never moves back down (see SEVERITY)
    if (entry.actualStatus !== null && SEVERITY[outcome.status] < (SEVERITY[entry.actualStatus] ?? 0)) continue;

    const excluded = outcome.cause === 'non-winter' ? 'Non-weather closure' : undefined;
    const correct = excluded ? null : entry.predictedDisruption === (outcome.status !== 'open');
    if (entry.actualStatus === outcome.status && entry.excluded === excluded && entry.correct === correct) continue;

    entry.actualStatus = outcome.status;
    entry.correct = correct;
    if (excluded) entry.excluded = excluded;
    else delete entry.excluded;
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

  // Where the data comes from, and where the two logs are kept. Tests replace
  // these to replay a specific morning without touching the real files.
  const sources = { fetchForecastInputs, getSchoolStatuses, getObservedWindow, ...options.sources };
  const store = { loadHistoricalData, saveHistoricalData, loadPredictionLog, savePredictionLog, ...options.store };

  const eastern = easternParts(now);
  const today = eastern.dateStr;
  const windows = getWindows(today);
  const results = {
    date: today,
    logged: [],
    updated: [],
    skipped: [],
    errors: []
  };

  try {
    // Read the calendar and both logs before anything else: if any of them is
    // unreadable the run stops here, with nothing fetched and nothing written.
    loadNonWeatherClosures();
    const historicalData = store.loadHistoricalData();
    const predictionLog = store.loadPredictionLog();

    const nowMs = new Date(now).getTime();
    const morningHasBegun = nowMs > windows.coldCheck[0];
    // Only after 9 AM (plus the station's reporting lag) is the 5-9 AM record whole
    const morningIsComplete = nowMs >= windows.coldCheck[1] + OBSERVATION_LAG_MS;

    const [inputs, schoolStatuses, morningObs] = await Promise.all([
      sources.fetchForecastInputs(),
      sources.getSchoolStatuses().catch(err => {
        results.errors.push({ type: 'school_status_fetch', message: err.message });
        return {};
      }),
      morningHasBegun
        ? sources.getObservedWindow('indiana', ...windows.coldCheck, { precipFromMs: windows.overnight[0] }).catch(err => {
          results.errors.push({ type: 'morning_observations_fetch', message: err.message });
          return null;
        })
        : null
    ]);
    results.errors.push(...inputs.errors);

    const outcomes = {};
    const readAt = `${String(eastern.hour).padStart(2, '0')}:${String(eastern.minute).padStart(2, '0')}`;

    // --- 1. Today's outcomes ---
    //
    // First pass: what each district's status for today is right now - the
    // record already on file, moved up if SchoolCast now shows something more
    // disruptive.
    const day = INDIANA_COUNTY_SCHOOLS.map(school => {
      const schoolName = SCHOOL_CODE_TO_NAME[school.code];
      const existing = findRecord(historicalData, schoolName, today);
      const noSchool = getNonSchoolReason(today, schoolName);
      const reading = noSchool
        ? { skip: `Not a school day: ${noSchool}` }
        : readTodayStatus(schoolStatuses[school.code], today, eastern.hour);

      let status = existing ? existing.status : reading.status ?? null;
      const revisable = existing && existing.v === 2;
      if (revisable && reading.status && SEVERITY[reading.status] > (SEVERITY[existing.status] ?? 0)) {
        status = reading.status;
      }
      return { school, schoolName, existing, revisable, noSchool, reading, status };
    });

    // Did every district close outright? (Used to tell a day off from a storm.)
    const countyWideClosure = day.every(d => d.status && isFullClosure(d.status));

    let historyChanged = false;
    for (const d of day) {
      const { school, schoolName, existing, reading } = d;

      // Weekends, holidays and listed days off (in-service days etc.) are not
      // school days: nothing to record, and no weather lesson in the closure.
      if (d.noSchool && !existing) {
        results.skipped.push({ school: schoolName, reason: reading.skip });
        continue;
      }

      // Conditions buses ran in: the station's 5-9 AM record, the forecast that
      // was on file for this morning, and alerts covering the district.
      const onFile = findPrediction(predictionLog, schoolName, today)?.features || {};
      const liveAlerts = selectAlerts(inputs.alerts, windows, school.zones).map(a => a.event);
      const filedAlerts = (onFile.alerts || []).map(label => label.split('@')[0]);
      const alerts = [...new Set([...(existing?.alerts || []), ...filedAlerts, ...liveAlerts])];
      const forecastWeather = {
        snowfall: onFile.snowOvernightIn ?? 0,
        iceIn: onFile.iceIn ?? 0,
        commutePrecip: onFile.commutePrecip ?? null
      };

      // --- A record from an earlier run today: revise it if there is news ---
      if (existing) {
        if (d.revisable) {
          const changes = [];
          if (d.status !== existing.status) {
            changes.push(`status ${existing.status} -> ${d.status}`);
            existing.status = d.status;
            existing.readAt = readAt;
          }

          // The first read usually lands before 9 AM, with only part of the
          // morning observed (or none: then the forecast's low stood in).
          if (existing.obs && morningObs && (morningIsComplete || existing.obs === 'forecast')) {
            const feelsLike = morningObs.minWindChillF ?? morningObs.minTempF;
            if (existing.temperature !== morningObs.minTempF || existing.feelsLike !== feelsLike) {
              changes.push(`morning low ${existing.temperature}F -> ${morningObs.minTempF}F`);
            }
            existing.temperature = morningObs.minTempF;
            existing.feelsLike = feelsLike;
            if (morningIsComplete) delete existing.obs;
            else existing.obs = 'partial';
          }

          const weather = {
            ...forecastWeather,
            temperature: existing.temperature,
            feelsLike: existing.feelsLike,
            precipIn: morningObs?.precipIn ?? null,
            alerts
          };
          const cause = classifyCause(existing.status, weather, countyWideClosure);
          const type = describeType(existing.status, cause, weather);
          if ((existing.cause || null) !== cause || existing.type !== type) {
            if (changes.length === 0) changes.push(`type ${existing.type} -> ${type}`);
            if (cause) existing.cause = cause;
            else delete existing.cause;
            existing.type = type;
          }
          if (alerts.length > 0 && (existing.alerts || []).length !== alerts.length) {
            existing.alerts = alerts;
            if (changes.length === 0) changes.push('alerts updated');
          }

          if (changes.length > 0) {
            historyChanged = true;
            results.updated.push({ school: schoolName, changes });
          }
        }

        outcomes[schoolName] = {
          status: existing.status,
          cause: isNonWeatherRecord(existing) ? 'non-winter' : null
        };
        if (!results.updated.some(u => u.school === schoolName)) {
          results.skipped.push({ school: schoolName, reason: 'Record already exists for today' });
        }
        continue;
      }

      // --- No record yet today ---
      if (reading.skip) {
        results.skipped.push({ school: schoolName, reason: reading.skip });
        if (reading.problem) {
          results.errors.push({ type: 'status_not_recorded', message: `${schoolName}: ${reading.skip}` });
        }
        continue;
      }

      const weather = {
        ...forecastWeather,
        temperature: morningObs?.minTempF ?? onFile.minTempF ?? null,
        feelsLike: morningObs?.minWindChillF ?? onFile.minWindChillF ?? null,
        precipIn: morningObs?.precipIn ?? null,
        alerts
      };

      if (weather.temperature === null) {
        results.skipped.push({ school: schoolName, reason: 'No morning weather observations available' });
        results.errors.push({ type: 'status_not_recorded', message: `${schoolName}: no morning weather observations` });
        continue;
      }

      const cause = classifyCause(reading.status, weather, countyWideClosure);
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
        readAt
      };
      // Where the morning low came from, until the full 5-9 AM record is in:
      // 'partial' = the station's readings so far, 'forecast' = no readings yet.
      if (!morningObs) record.obs = 'forecast';
      else if (!morningIsComplete) record.obs = 'partial';
      if (cause) record.cause = cause;
      if (weather.alerts.length > 0) record.alerts = weather.alerts;

      historicalData.push(record);
      historyChanged = true;
      results.logged.push(record);
    }

    if (historyChanged && !dryRun) {
      store.saveHistoricalData(historicalData);
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
      } else if (!inputs.alertsAvailable) {
        // Without the alert feed the forecast would quietly lose its strongest
        // signal. Whatever is on file stays as it is until the feed is back.
        results.errors.push({
          type: 'alerts_unavailable',
          message: 'NWS alerts could not be fetched; the forecast on file was left unchanged'
        });
      } else {
        saved = saveForecast(predictionLog, forecast, schoolStatuses, now);
      }

      if (!dryRun) {
        store.savePredictionLog(predictionLog);
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
      updated: results.updated.length,
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
  let log;
  try {
    log = loadPredictionLog();
    loadHistoricalData();
  } catch (error) {
    // The page still has a forecast to show; the self-audit just has no data
    return { total: 0, correct: 0, accuracy: 0, status: 'no-data', pendingCount: 0, totalResolved: 0, error: error.message };
  }
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
  loadJson,
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
