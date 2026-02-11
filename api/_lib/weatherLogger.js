// Weather Logger - Automatically logs weather conditions and school statuses
// to historicalData.json for continuous learning

const fs = require('fs');
const path = require('path');
const { getCurrentConditions, getForecast, getAlerts } = require('./noaa');
const { getSchoolStatuses, calculateDelayProbability, getSchoolHistoricalPrediction, INDIANA_COUNTY_SCHOOLS, SCHOOL_CODE_TO_HISTORICAL_NAME } = require('./schoolDelay');

const HISTORICAL_DATA_PATH = path.join(__dirname, 'historicalData.json');
const NON_WEATHER_CLOSURES_PATH = path.join(__dirname, 'nonWeatherClosures.json');
const PREDICTION_LOG_PATH = path.join(__dirname, 'predictionLog.json');

// Map school codes to names used in historical data
const SCHOOL_CODE_TO_NAME = {
  'IASD': 'Indiana',
  'HCSD': 'Homer-Center',
  'MCASD': 'Marion Center',
  'PMASD': 'Penns Manor',
  'PLSD': 'Purchase Line',
  'USD': 'United'
};

// Load non-weather closure dates (inservice days, holidays, etc.)
function loadNonWeatherClosures() {
  try {
    const data = fs.readFileSync(NON_WEATHER_CLOSURES_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

// Check if a school has a non-weather closure on a given date
function getNonWeatherClosure(date, schoolName) {
  const closures = loadNonWeatherClosures();
  return closures.find(c => {
    if (c.date !== date) return false;
    if (c.schools === 'all') return true;
    if (Array.isArray(c.schools)) return c.schools.includes(schoolName);
    return c.schools === schoolName;
  });
}

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

// Determine weather type from forecast text and conditions
function determineWeatherType(forecast, currentConditions, windChill) {
  if (!forecast || !forecast.periods) {
    if (windChill !== null && windChill <= 10) {
      return 'frigid temperature';
    }
    return null;
  }

  // Analyze the next 24-48 hours of forecast
  const relevantText = forecast.periods.slice(0, 4)
    .map(p => (p.detailedForecast || p.shortForecast || '').toLowerCase())
    .join(' ');

  // Check for ice/freezing conditions first (highest priority)
  if (relevantText.includes('ice') ||
      relevantText.includes('freezing rain') ||
      relevantText.includes('freezing drizzle') ||
      relevantText.includes('sleet')) {
    return 'ice';
  }

  // Check for snow
  if (relevantText.includes('snow') || relevantText.includes('flurries')) {
    // Try to determine snow intensity
    const snowMatch = relevantText.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
    if (snowMatch) {
      const amount = snowMatch[2] ? parseInt(snowMatch[2]) : parseInt(snowMatch[1]);
      if (amount >= 6) return 'heavy snow';
    }
    if (relevantText.includes('heavy snow') || relevantText.includes('blizzard')) {
      return 'heavy snow';
    }
    return 'snow';
  }

  // Check for extreme cold
  if (windChill !== null && windChill <= 0) {
    return 'frigid temperature';
  }

  // Check for wind
  if (relevantText.includes('high wind') || relevantText.includes('strong wind')) {
    return 'wind';
  }

  return null;
}

// Estimate snowfall from forecast text
function estimateSnowfall(forecast) {
  if (!forecast || !forecast.periods) return 0;

  const relevantText = forecast.periods.slice(0, 4)
    .map(p => (p.detailedForecast || p.shortForecast || '').toLowerCase())
    .join(' ');

  // Look for explicit snow amounts
  const snowMatch = relevantText.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
  if (snowMatch) {
    // Return the higher estimate if a range is given
    return snowMatch[2] ? parseFloat(snowMatch[2]) : parseFloat(snowMatch[1]);
  }

  // Estimate based on descriptive terms
  if (relevantText.includes('heavy snow') || relevantText.includes('blizzard')) {
    return 6;
  }
  if (relevantText.includes('moderate snow')) {
    return 3;
  }
  if (relevantText.includes('light snow')) {
    return 1.5;
  }
  if (relevantText.includes('snow shower')) {
    return 1;
  }
  if (relevantText.includes('flurries') || relevantText.includes('dusting')) {
    return 0.5;
  }

  return 0;
}

// Calculate wind chill
function calculateWindChill(tempF, windMph) {
  if (tempF === null || windMph === null) return null;
  if (tempF > 50 || windMph <= 3) return tempF;

  const windChill = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) +
                    (0.4275 * tempF * Math.pow(windMph, 0.16));
  return Math.round(windChill);
}

// Load existing historical data
function loadHistoricalData() {
  try {
    const data = fs.readFileSync(HISTORICAL_DATA_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading historical data:', error);
    return [];
  }
}

// Save historical data
function saveHistoricalData(data) {
  fs.writeFileSync(HISTORICAL_DATA_PATH, JSON.stringify(data, null, 2));
}

// Check if a record already exists for this school/date combination
function recordExists(historicalData, school, date) {
  return historicalData.some(record =>
    record.school === school && record.date === date
  );
}

// Check if today is in the winter school season (Nov-Mar)
// when weather-related closures/delays are most likely
function isWinterSeason(dateStr) {
  const month = new Date(dateStr).getMonth(); // 0-indexed
  return month >= 10 || month <= 2; // Nov(10), Dec(11), Jan(0), Feb(1), Mar(2)
}

// Main function to log today's weather and school statuses
async function logWeatherData(options = {}) {
  const {
    forceLog = false,  // If true, log even if schools are open (for testing)
    dryRun = false     // If true, don't actually write to file
  } = options;

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  const results = {
    date: today,
    logged: [],
    skipped: [],
    errors: []
  };

  try {
    // Fetch all required data in parallel (with error handling for each)
    const [currentConditions, forecast, alerts, schoolStatuses] = await Promise.all([
      getCurrentConditions('indiana').catch(err => {
        results.errors.push({ type: 'weather_fetch', message: err.message });
        return null;
      }),
      getForecast('indiana').catch(err => {
        results.errors.push({ type: 'forecast_fetch', message: err.message });
        return null;
      }),
      getAlerts().catch(err => {
        results.errors.push({ type: 'alerts_fetch', message: err.message });
        return { alerts: [] };
      }),
      getSchoolStatuses().catch(err => {
        results.errors.push({ type: 'school_status_fetch', message: err.message });
        return {};
      })
    ]);

    // If we couldn't get any weather data, we can still proceed with school statuses
    if (!currentConditions && !forecast) {
      results.errors.push({
        type: 'no_weather_data',
        message: 'Could not fetch weather data from NOAA'
      });
    }

    // Calculate weather metrics (with null safety)
    const tempF = currentConditions?.temperature?.fahrenheit ?? null;
    const windMph = currentConditions?.windSpeed?.mph || 0;
    const windChill = calculateWindChill(tempF, windMph);
    const snowfall = estimateSnowfall(forecast);
    const weatherType = determineWeatherType(forecast, currentConditions, windChill);

    // Load existing historical data
    const historicalData = loadHistoricalData();

    // Process each school
    for (const school of INDIANA_COUNTY_SCHOOLS) {
      const schoolName = SCHOOL_CODE_TO_NAME[school.code];
      const statusInfo = schoolStatuses[school.code];
      const normalizedStatus = normalizeStatus(statusInfo?.status);

      // Skip if:
      // 1. Record already exists for this school/date
      // 2. Status is 'open' (we only log disruptions unless forceLog is true)
      // 3. Status is unknown/null
      if (recordExists(historicalData, schoolName, today)) {
        results.skipped.push({
          school: schoolName,
          reason: 'Record already exists for today'
        });
        continue;
      }

      // Skip non-weather closures (inservice days, holidays, etc.)
      // These would skew the data by associating weather conditions with
      // closures that had nothing to do with weather
      const nonWeatherClosure = getNonWeatherClosure(today, schoolName);
      if (nonWeatherClosure) {
        results.skipped.push({
          school: schoolName,
          reason: `Non-weather closure: ${nonWeatherClosure.reason}`
        });
        continue;
      }

      if (!normalizedStatus) {
        results.skipped.push({
          school: schoolName,
          reason: 'Unknown status'
        });
        continue;
      }

      // During winter season (Nov-Mar), log ALL days including open days
      // so the prediction model has baseline data for normal vs. disruption days.
      // Outside winter season, only log disruptions (or if forceLog is set).
      const winterSeason = isWinterSeason(today);

      if (normalizedStatus === 'open' && !winterSeason && !forceLog) {
        results.skipped.push({
          school: schoolName,
          reason: 'School is open (outside winter season, no disruption to log)'
        });
        continue;
      }

      // Create the record
      const record = {
        school: schoolName,
        date: today,
        status: normalizedStatus,
        temperature: tempF || 32, // Default to freezing if unavailable
        snowfall: snowfall,
        type: weatherType || (normalizedStatus !== 'open' ? 'unknown' : 'normal'),
        feelsLike: windChill || tempF || 32
      };

      if (!dryRun) {
        historicalData.push(record);
      }
      results.logged.push(record);
    }

    // Save if any records were logged
    if (results.logged.length > 0 && !dryRun) {
      saveHistoricalData(historicalData);
    }

    // --- Prediction accuracy tracking ---
    if (!dryRun) {
      try {
        const predictionLog = loadPredictionLog();

        // Resolve yesterday's predictions with today's actual statuses
        const resolved = resolvePredictions(predictionLog, schoolStatuses, today);

        // Save predictions for tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const prediction = calculateDelayProbability(currentConditions, forecast, null, alerts?.alerts || []);
        const saved = saveTomorrowPredictions(predictionLog, prediction, currentConditions, forecast, schoolStatuses, tomorrowStr);

        savePredictionLog(predictionLog);
        results.predictions = { resolved, savedForTomorrow: saved };
      } catch (error) {
        results.errors.push({ type: 'prediction_tracking', message: error.message });
      }
    }

    results.summary = {
      totalSchools: INDIANA_COUNTY_SCHOOLS.length,
      recorded: results.logged.length,
      skipped: results.skipped.length,
      weatherConditions: {
        temperature: tempF,
        windChill: windChill,
        snowfall: snowfall,
        type: weatherType
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

// --- Prediction Accuracy Tracking ---

function loadPredictionLog() {
  try {
    const data = fs.readFileSync(PREDICTION_LOG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

function savePredictionLog(log) {
  fs.writeFileSync(PREDICTION_LOG_PATH, JSON.stringify(log, null, 2));
}

// Resolve yesterday's predictions by comparing with today's actual statuses
function resolvePredictions(predictionLog, schoolStatuses, today) {
  let resolved = 0;
  for (const entry of predictionLog) {
    if (entry.date === today && entry.actualStatus === null) {
      // Find actual status for this school
      const schoolCode = Object.keys(SCHOOL_CODE_TO_NAME).find(
        code => SCHOOL_CODE_TO_NAME[code] === entry.school
      );
      const statusInfo = schoolStatuses[schoolCode];
      const actual = normalizeStatus(statusInfo?.status);
      if (!actual) continue;

      entry.actualStatus = actual;
      const actualIsDisruption = actual !== 'open';
      const predictedDisruption = entry.predictedDisruption;
      entry.correct = predictedDisruption === actualIsDisruption;
      resolved++;
    }
  }
  return resolved;
}

// Save predictions for tomorrow based on current weather
function saveTomorrowPredictions(predictionLog, prediction, currentConditions, forecast, schoolStatuses, tomorrow) {
  // Skip if predictions already exist for tomorrow
  if (predictionLog.some(e => e.date === tomorrow && e.actualStatus === null)) return 0;

  const tempF = currentConditions?.temperature?.fahrenheit ?? 32;
  const windMph = currentConditions?.windSpeed?.mph || 0;
  let windChill = tempF;
  if (tempF <= 50 && windMph > 3) {
    windChill = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) +
                (0.4275 * tempF * Math.pow(windMph, 0.16));
    windChill = Math.round(windChill);
  }

  let snowEstimate = 0;
  let weatherType = '';
  if (forecast && forecast.periods) {
    const relevantText = forecast.periods.slice(0, 4)
      .map(p => (p.detailedForecast || p.shortForecast || '').toLowerCase()).join(' ');
    const snowMatch = relevantText.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
    if (snowMatch) snowEstimate = snowMatch[2] ? parseInt(snowMatch[2]) : parseInt(snowMatch[1]);
    if (relevantText.includes('ice') || relevantText.includes('freezing rain')) weatherType = 'ice';
    else if (relevantText.includes('snow')) weatherType = 'snow';
    else if (windChill <= 10) weatherType = 'frigid temperature';
  }

  let saved = 0;
  for (const school of INDIANA_COUNTY_SCHOOLS) {
    const schoolName = SCHOOL_CODE_TO_NAME[school.code];
    const historicalName = SCHOOL_CODE_TO_HISTORICAL_NAME[school.code];
    const schoolPrediction = getSchoolHistoricalPrediction(
      historicalName, tempF, windChill, snowEstimate, weatherType
    );

    let delayProb = prediction.delayProbability;
    let closureProb = prediction.closureProbability;
    if (schoolPrediction && schoolPrediction.matchCount >= 2) {
      delayProb = Math.round((prediction.delayProbability * 0.6) + (schoolPrediction.delayRate * 0.4));
      closureProb = Math.round((prediction.closureProbability * 0.6) + (schoolPrediction.closureRate * 0.4));
    }

    const maxProb = Math.max(delayProb, closureProb);
    const predictedDisruption = maxProb >= 40;

    predictionLog.push({
      date: tomorrow,
      school: schoolName,
      delayProbability: delayProb,
      closureProbability: closureProb,
      predictedDisruption,
      actualStatus: null,
      correct: null
    });
    saved++;
  }
  return saved;
}

// Get prediction accuracy stats
function getPredictionAccuracy() {
  const log = loadPredictionLog();
  const resolved = log.filter(e => e.correct !== null);
  const pending = log.filter(e => e.correct === null);

  if (resolved.length === 0) {
    return {
      total: 0,
      correct: 0,
      accuracy: 0,
      status: pending.length > 0 ? 'collecting' : 'no-data',
      pendingCount: pending.length,
      totalResolved: 0
    };
  }

  // Last 30 resolved predictions
  const recent = resolved.slice(-30);
  const correctCount = recent.filter(e => e.correct).length;

  // Calculate current streak (consecutive correct predictions from most recent)
  let streak = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].correct) streak++;
    else break;
  }

  // Find the most recent resolved prediction date
  const lastResolvedDate = resolved[resolved.length - 1]?.date || null;

  // Count how many are from live predictions vs backtest seeds
  const liveCount = recent.filter(e => e.source !== 'backtest').length;

  return {
    total: recent.length,
    correct: correctCount,
    accuracy: Math.round((correctCount / recent.length) * 100),
    status: 'active',
    streak,
    lastResolvedDate,
    pendingCount: pending.length,
    totalResolved: resolved.length,
    liveCount,
    backtestCount: recent.length - liveCount
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
  SCHOOL_CODE_TO_NAME
};
