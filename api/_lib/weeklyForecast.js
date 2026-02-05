// Weekly Forecast Module
// Fetches NOAA forecast data for Monday-Friday and generates
// school closure/delay/open predictions for each weekday

const fs = require('fs');
const path = require('path');
const { getForecast, getHourlyForecast, getAlerts } = require('./noaa');
const { getSchoolHistoricalPrediction, INDIANA_COUNTY_SCHOOLS, SCHOOL_CODE_TO_HISTORICAL_NAME } = require('./schoolDelay');
const historicalData = require('./historicalData.json');

const WEEKLY_FORECAST_PATH = path.join(__dirname, 'weeklyForecast.json');

// Weather thresholds (matching schoolDelay.js)
const THRESHOLDS = {
  extremeCold: -10,
  veryCold: 0,
  cold: 10,
  heavySnow: 6,
  moderateSnow: 3,
  lightSnow: 1
};

// Calculate wind chill using standard NWS formula
function calculateWindChill(tempF, windMph) {
  if (tempF === null || windMph === null) return tempF;
  if (tempF > 50 || windMph <= 3) return tempF;
  const wc = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) +
             (0.4275 * tempF * Math.pow(windMph, 0.16));
  return Math.round(wc);
}

// Parse wind speed string like "10 to 15 mph" or "10 mph" to a number
function parseWindSpeed(windSpeedStr) {
  if (!windSpeedStr) return 0;
  const match = windSpeedStr.match(/(\d+)\s*(?:to\s*(\d+))?\s*mph/i);
  if (!match) return 0;
  return match[2] ? parseInt(match[2]) : parseInt(match[1]);
}

// Estimate snowfall from forecast text
function estimateSnowfall(forecastText) {
  if (!forecastText) return 0;
  const text = forecastText.toLowerCase();

  const snowMatch = text.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
  if (snowMatch) {
    return snowMatch[2] ? parseFloat(snowMatch[2]) : parseFloat(snowMatch[1]);
  }

  if (text.includes('heavy snow') || text.includes('blizzard')) return 6;
  if (text.includes('moderate snow')) return 3;
  if (text.includes('light snow')) return 1.5;
  if (text.includes('snow shower')) return 1;
  if (text.includes('flurries') || text.includes('dusting')) return 0.5;

  return 0;
}

// Determine weather type from forecast text
function determineWeatherType(forecastText, windChill) {
  if (!forecastText) {
    if (windChill !== null && windChill <= 10) return 'frigid temperature';
    return 'none';
  }
  const text = forecastText.toLowerCase();

  if (text.includes('ice') || text.includes('freezing rain') ||
      text.includes('freezing drizzle') || text.includes('sleet')) return 'ice';
  if (text.includes('heavy snow') || text.includes('blizzard')) return 'heavy snow';
  if (text.includes('snow') || text.includes('flurries')) return 'snow';
  if (windChill !== null && windChill <= 0) return 'frigid temperature';
  if (text.includes('high wind') || text.includes('strong wind')) return 'wind';

  return 'none';
}

// Predict school status for a single day based on weather conditions
function predictDayStatus(tempHigh, tempLow, windMph, snowfall, weatherType, feelsLikeLow) {
  let probability = 0;
  const factors = [];

  // Wind chill analysis (using the low temperature for worst-case morning)
  if (feelsLikeLow <= THRESHOLDS.extremeCold) {
    probability += 40;
    factors.push(`Extreme cold (wind chill ${feelsLikeLow}°F)`);
  } else if (feelsLikeLow <= THRESHOLDS.veryCold) {
    probability += 25;
    factors.push(`Very cold (wind chill ${feelsLikeLow}°F)`);
  } else if (feelsLikeLow <= THRESHOLDS.cold) {
    probability += 10;
    factors.push(`Cold temperatures (wind chill ${feelsLikeLow}°F)`);
  }

  // Snow analysis
  if (snowfall >= THRESHOLDS.heavySnow) {
    probability += 45;
    factors.push(`Heavy snow forecast (${snowfall}+ inches)`);
  } else if (snowfall >= THRESHOLDS.moderateSnow) {
    probability += 30;
    factors.push(`Moderate snow forecast (${snowfall} inches)`);
  } else if (snowfall >= THRESHOLDS.lightSnow) {
    probability += 15;
    factors.push(`Light snow forecast (${snowfall} inches)`);
  }

  // Ice/freezing rain
  if (weatherType === 'ice') {
    probability += 35;
    factors.push('Ice/freezing rain in forecast');
  }

  // Historical pattern matching
  const historicalMatch = getHistoricalPredictionForDay(tempLow, feelsLikeLow, snowfall, weatherType);
  if (historicalMatch) {
    probability = Math.round((probability * 0.6) + (historicalMatch.disruptionRate * 0.4));
    factors.push(`Historical pattern (${historicalMatch.matchCount} similar days: ${historicalMatch.closedCount} closed, ${historicalMatch.delayCount} delayed)`);
  }

  probability = Math.min(probability, 95);

  // Determine predicted status
  let status, closureProbability, delayProbability;
  if (historicalMatch && historicalMatch.disruptionRate > 0) {
    const closureRatio = historicalMatch.closureRate / historicalMatch.disruptionRate;
    const delayRatio = historicalMatch.delayRate / historicalMatch.disruptionRate;
    closureProbability = Math.round(probability * closureRatio);
    delayProbability = Math.round(probability * delayRatio);
  } else if (probability >= 70) {
    closureProbability = Math.round(probability * 0.55);
    delayProbability = Math.round(probability * 0.45);
  } else if (probability >= 40) {
    closureProbability = Math.round(probability * 0.35);
    delayProbability = Math.round(probability * 0.65);
  } else {
    closureProbability = Math.round(probability * 0.25);
    delayProbability = Math.round(probability * 0.75);
  }

  if (probability >= 70) {
    status = closureProbability > delayProbability ? 'closed' : 'delay';
  } else if (probability >= 40) {
    status = 'delay';
  } else {
    status = 'open';
  }

  return {
    overallProbability: probability,
    closureProbability,
    delayProbability,
    predictedStatus: status,
    factors
  };
}

// Historical pattern matching for a forecast day (reuses logic from schoolDelay.js)
function getHistoricalPredictionForDay(temperature, feelsLike, snowfall, weatherType) {
  if (!historicalData || historicalData.length === 0) return null;

  function categorize(snow, type) {
    const t = (type || '').toLowerCase();
    if (t.includes('ice') || t.includes('freezing')) return 'ice';
    if (snow >= 3) return 'heavy-snow';
    if (snow >= 1) return 'light-snow';
    if (t.includes('snow') || t.includes('flurr')) return 'light-snow';
    return 'cold-only';
  }

  const currentCategory = categorize(snowfall, weatherType);

  const scored = historicalData.map(record => {
    let similarity = 0;
    const recordCategory = categorize(record.snowfall, record.type);
    const snowDiff = Math.abs(record.snowfall - snowfall);

    if (snowDiff > 5) return { ...record, similarity: 0, disqualified: true };

    if (currentCategory === recordCategory) similarity += 4;
    else if ((currentCategory === 'cold-only' && recordCategory === 'heavy-snow') ||
             (currentCategory === 'heavy-snow' && recordCategory === 'cold-only')) similarity -= 6;
    else similarity -= 2;

    const tempDiff = Math.abs(record.temperature - temperature);
    if (tempDiff <= 5) similarity += 3;
    else if (tempDiff <= 10) similarity += 2;
    else if (tempDiff <= 15) similarity += 1;

    const feelsDiff = Math.abs(record.feelsLike - feelsLike);
    if (feelsDiff <= 5) similarity += 3;
    else if (feelsDiff <= 10) similarity += 2;
    else if (feelsDiff <= 15) similarity += 1;

    if (snowDiff <= 0.5) similarity += 4;
    else if (snowDiff <= 1) similarity += 3;
    else if (snowDiff <= 2) similarity += 2;
    else if (snowDiff <= 3) similarity += 1;

    const ct = (weatherType || '').toLowerCase();
    const rt = (record.type || '').toLowerCase();
    if (ct && rt && ct === rt) similarity += 2;
    else if (ct && rt && (ct.includes(rt) || rt.includes(ct))) similarity += 1;

    return { ...record, similarity };
  });

  const similar = scored.filter(r => !r.disqualified && r.similarity >= 5)
                        .sort((a, b) => b.similarity - a.similarity);

  if (similar.length === 0) return null;

  const matches = similar.slice(0, 8);
  const closedCount = matches.filter(r => r.status === 'closed').length;
  const delayCount = matches.filter(r => r.status === 'delay').length;
  const totalDisruptions = closedCount + delayCount;

  return {
    matchCount: matches.length,
    closedCount,
    delayCount,
    disruptionRate: Math.round((totalDisruptions / matches.length) * 100),
    closureRate: Math.round((closedCount / matches.length) * 100),
    delayRate: Math.round((delayCount / matches.length) * 100)
  };
}

// Get the Monday of the current or next school week
function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...6=Sat

  const monday = new Date(now);
  if (day === 0) {
    // Sunday: use tomorrow (Monday)
    monday.setDate(now.getDate() + 1);
  } else if (day === 6) {
    // Saturday: use next Monday
    monday.setDate(now.getDate() + 2);
  } else {
    // Weekday: use this week's Monday
    monday.setDate(now.getDate() - (day - 1));
  }

  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Format date as YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Get day name from date
function getDayName(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

// Match a NOAA forecast period to a specific date
function matchPeriodsToDate(periods, targetDate) {
  const targetStr = formatDate(targetDate);
  const dayPeriod = periods.find(p => {
    const pDate = new Date(p.startTime).toISOString().split('T')[0];
    return pDate === targetStr && p.isDaytime;
  });
  const nightPeriod = periods.find(p => {
    const pDate = new Date(p.startTime).toISOString().split('T')[0];
    return pDate === targetStr && !p.isDaytime;
  });
  // Also check the night before (overnight low applies to morning)
  const prevDate = new Date(targetDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevNight = periods.find(p => {
    const pDate = new Date(p.startTime).toISOString().split('T')[0];
    return pDate === formatDate(prevDate) && !p.isDaytime;
  });

  return { dayPeriod, nightPeriod, prevNight };
}

// Generate the weekly forecast with school predictions
async function generateWeeklyForecast(locationKey = 'indiana') {
  const forecast = await getForecast(locationKey);
  let alerts;
  try {
    const alertsData = await getAlerts();
    alerts = alertsData.alerts || [];
  } catch {
    alerts = [];
  }

  if (!forecast || !forecast.periods || forecast.periods.length === 0) {
    throw new Error('Could not fetch NOAA forecast data');
  }

  const weekStart = getWeekStartDate();
  const days = [];

  for (let i = 0; i < 5; i++) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);
    const dateStr = formatDate(date);
    const dayName = getDayName(date);

    const { dayPeriod, nightPeriod, prevNight } = matchPeriodsToDate(forecast.periods, date);

    // If no forecast data available for this day, mark as unavailable
    if (!dayPeriod && !nightPeriod) {
      days.push({
        day: dayName,
        date: dateStr,
        temperature: null,
        forecast: 'Forecast not yet available',
        schoolPrediction: {
          predictedStatus: 'unknown',
          overallProbability: 0,
          closureProbability: 0,
          delayProbability: 0,
          factors: ['Forecast data not available for this day']
        },
        schools: []
      });
      continue;
    }

    // Extract temperature data
    const tempHigh = dayPeriod ? dayPeriod.temperature : null;
    const tempLow = nightPeriod ? nightPeriod.temperature
                  : (prevNight ? prevNight.temperature : null);

    // Extract wind
    const dayWind = dayPeriod ? parseWindSpeed(dayPeriod.windSpeed) : 0;
    const nightWind = nightPeriod ? parseWindSpeed(nightPeriod.windSpeed) : 0;
    const maxWind = Math.max(dayWind, nightWind);

    // Combine forecast text for analysis
    const combinedForecast = [
      dayPeriod?.detailedForecast || dayPeriod?.shortForecast || '',
      nightPeriod?.detailedForecast || nightPeriod?.shortForecast || ''
    ].join(' ');

    // Calculate derived values
    const feelsLikeLow = calculateWindChill(tempLow, maxWind);
    const feelsLikeHigh = calculateWindChill(tempHigh, dayWind);
    const snowfall = estimateSnowfall(combinedForecast);
    const weatherType = determineWeatherType(combinedForecast, feelsLikeLow);

    // Overall prediction for the day
    const prediction = predictDayStatus(tempHigh, tempLow, maxWind, snowfall, weatherType, feelsLikeLow);

    // Per-school predictions
    const schoolPredictions = INDIANA_COUNTY_SCHOOLS.map(school => {
      const historicalName = SCHOOL_CODE_TO_HISTORICAL_NAME[school.code];
      const schoolHistory = getSchoolHistoricalPrediction(
        historicalName, tempLow || 32, feelsLikeLow || 32, snowfall, weatherType
      );

      let schoolDelay = prediction.delayProbability;
      let schoolClosure = prediction.closureProbability;

      if (schoolHistory && schoolHistory.matchCount >= 2) {
        schoolDelay = Math.round((prediction.delayProbability * 0.6) + (schoolHistory.delayRate * 0.4));
        schoolClosure = Math.round((prediction.closureProbability * 0.6) + (schoolHistory.closureRate * 0.4));
      }

      let schoolStatus;
      const totalProb = schoolDelay + schoolClosure;
      if (totalProb >= 70) {
        schoolStatus = schoolClosure > schoolDelay ? 'closed' : 'delay';
      } else if (totalProb >= 40) {
        schoolStatus = 'delay';
      } else {
        schoolStatus = 'open';
      }

      return {
        code: school.code,
        name: school.shortName,
        predictedStatus: schoolStatus,
        closureProbability: schoolClosure,
        delayProbability: schoolDelay,
        historicalMatches: schoolHistory?.matchCount || 0
      };
    });

    // Check if any active alerts apply to this day
    const dayAlerts = alerts.filter(alert => {
      const onset = new Date(alert.onset);
      const expires = new Date(alert.expires);
      return date >= onset && date <= expires;
    }).map(a => a.event);

    days.push({
      day: dayName,
      date: dateStr,
      temperature: {
        high: tempHigh,
        low: tempLow
      },
      feelsLike: {
        high: feelsLikeHigh,
        low: feelsLikeLow
      },
      wind: {
        speed: maxWind,
        direction: dayPeriod?.windDirection || null
      },
      forecast: dayPeriod?.shortForecast || nightPeriod?.shortForecast || 'Unknown',
      detailedForecast: dayPeriod?.detailedForecast || '',
      snowfall,
      weatherType,
      alerts: dayAlerts,
      schoolPrediction: {
        predictedStatus: prediction.predictedStatus,
        overallProbability: prediction.overallProbability,
        closureProbability: prediction.closureProbability,
        delayProbability: prediction.delayProbability,
        factors: prediction.factors
      },
      schools: schoolPredictions
    });
  }

  const weeklyData = {
    generatedAt: new Date().toISOString(),
    location: forecast.location || 'Indiana County, PA',
    weekOf: formatDate(weekStart),
    days,
    disclaimer: 'Predictions are estimates based on NOAA forecast data and historical patterns. Always check official school district announcements.'
  };

  return weeklyData;
}

// Save weekly forecast to JSON file
async function saveWeeklyForecast(locationKey = 'indiana') {
  const data = await generateWeeklyForecast(locationKey);
  fs.writeFileSync(WEEKLY_FORECAST_PATH, JSON.stringify(data, null, 2));
  return data;
}

// Load previously saved weekly forecast
function loadWeeklyForecast() {
  try {
    const raw = fs.readFileSync(WEEKLY_FORECAST_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  generateWeeklyForecast,
  saveWeeklyForecast,
  loadWeeklyForecast,
  WEEKLY_FORECAST_PATH
};
