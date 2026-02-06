// Weather Logger - Automatically logs weather conditions and school statuses
// to historicalData.json for continuous learning

const fs = require('fs');
const path = require('path');
const { getCurrentConditions, getForecast, getAlerts } = require('./noaa');
const { getSchoolStatuses, INDIANA_COUNTY_SCHOOLS } = require('./schoolDelay');

const HISTORICAL_DATA_PATH = path.join(__dirname, 'historicalData.json');

// Map school codes to names used in historical data
const SCHOOL_CODE_TO_NAME = {
  'IASD': 'Indiana',
  'HCSD': 'Homer-Center',
  'MCASD': 'Marion Center',
  'PMASD': 'Penns Manor',
  'PLSD': 'Purchase Line',
  'USD': 'United'
};

// Normalize status to match historical data format
function normalizeStatus(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === 'closed' || s.includes('remote')) return 'closed';
  if (s.includes('delay')) return 'delay';
  if (s.includes('early dismissal')) return 'early dismissal';
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

// Get logging status (check what would be logged without actually logging)
async function getLoggingPreview() {
  return logWeatherData({ dryRun: true, forceLog: true });
}

module.exports = {
  logWeatherData,
  getLoggingPreview,
  loadHistoricalData,
  SCHOOL_CODE_TO_NAME
};
