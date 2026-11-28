// Weekly Forecast Module
// School closure/delay/open predictions for each weekday (Monday-Friday),
// using the same inputs and scoring as the main school prediction.

const fs = require('fs');
const path = require('path');
const { calculateWindChill } = require('./noaa');
const { predictAllDistricts, summarizeCounty, scoreDisruption, INDIANA_COUNTY_SCHOOLS, PREDICT_DISRUPTION_AT } = require('./schoolDelay');
const { withSavedAlerts } = require('./features');
const { fetchForecastInputs } = require('./schoolForecast');
const { getForecastOnFile } = require('./weatherLogger');
const { easternParts, addDays, weekdayName } = require('./easternTime');
const { getNonSchoolReason } = require('./schoolCalendar');

const WEEKLY_FORECAST_PATH = path.join(__dirname, 'weeklyForecast.json');

// Parse wind speed string like "10 to 15 mph" or "10 mph" to a number
function parseWindSpeed(windSpeedStr) {
  if (!windSpeedStr) return 0;
  const match = windSpeedStr.match(/(\d+)\s*(?:to\s*(\d+))?\s*mph/i);
  if (!match) return 0;
  return match[2] ? parseInt(match[2]) : parseInt(match[1]);
}

// Monday of the current school week (next week's Monday on a weekend)
function getWeekStartDate(now = new Date()) {
  const eastern = easternParts(now);
  if (eastern.dow === 0) return addDays(eastern.dateStr, 1);
  if (eastern.dow === 6) return addDays(eastern.dateStr, 2);
  return addDays(eastern.dateStr, 1 - eastern.dow);
}

// NWS period start times carry the local offset, so the first ten characters
// are the local calendar date.
const localDate = period => String(period.startTime).slice(0, 10);

// The forecast periods that describe one school day: the daytime period, and
// the night before it - the night whose low and snowfall the buses deal with.
function matchPeriodsToDate(periods, dateStr) {
  const previousDate = addDays(dateStr, -1);
  return {
    dayPeriod: periods.find(p => localDate(p) === dateStr && p.isDaytime),
    nightBefore: periods.find(p => localDate(p) === previousDate && !p.isDaytime)
  };
}

function predictedStatus(probability, delayProbability, closureProbability) {
  if (probability < PREDICT_DISRUPTION_AT) return 'open';
  return closureProbability > delayProbability ? 'closed' : 'delay';
}

function placeholderDay(day, date, message, status = 'unknown') {
  return {
    day,
    date,
    temperature: null,
    forecast: message,
    schoolPrediction: {
      predictedStatus: status,
      overallProbability: 0,
      closureProbability: 0,
      delayProbability: 0,
      factors: [message]
    },
    schools: []
  };
}

// Generate the weekly forecast with school predictions
//   deadlineMs  how long to wait for each NWS source (this runs inside a page
//               request, which the host stops at about ten seconds)
async function generateWeeklyForecast({ now = new Date(), deadlineMs = 7000 } = {}) {
  const inputs = await fetchForecastInputs({ deadlineMs });
  const periods = inputs.forecast?.periods || [];

  if (periods.length === 0 && !Object.values(inputs.grids).some(Boolean)) {
    throw new Error('Could not fetch NOAA forecast data');
  }

  const today = easternParts(now).dateStr;
  const weekStart = getWeekStartDate(now);
  const days = [];

  for (let i = 0; i < 5; i++) {
    const dateStr = addDays(weekStart, i);
    const dayName = weekdayName(dateStr);

    if (dateStr < today) {
      days.push(placeholderDay(dayName, dateStr, 'Day has passed'));
      continue;
    }

    const noSchool = getNonSchoolReason(dateStr);
    if (noSchool) {
      days.push(placeholderDay(dayName, dateStr, `No school: ${noSchool}`, 'no school'));
      continue;
    }

    const onFile = getForecastOnFile(dateStr);

    // Once this morning's buses have run there is nothing left to predict, and
    // NWS has dropped the overnight hours and expired alerts from its feeds.
    // Show the forecast that was on file for the morning, not a recalculation
    // that would drift toward "quiet" as the day goes on.
    const morningHasPassed = dateStr === today && easternParts(now).hour >= 9;
    if (morningHasPassed && Object.keys(onFile).length === 0) {
      days.push(placeholderDay(dayName, dateStr, 'Morning has passed'));
      continue;
    }

    let county;
    let districts;
    let noData = false;
    if (morningHasPassed) {
      districts = INDIANA_COUNTY_SCHOOLS.filter(school => onFile[school.code]).map(school => {
        const saved = onFile[school.code];
        const features = {
          ...saved,
          targetDate: dateStr,
          alerts: withSavedAlerts([], saved, new Date(now).getTime(), { feedDown: true })
        };
        return { school, features, ...scoreDisruption(features) };
      });
      county = summarizeCounty(districts);
    } else {
      ({ county, districts, noData } = predictAllDistricts(inputs, { now, targetDate: dateStr, onFile }));
    }
    const { dayPeriod, nightBefore } = matchPeriodsToDate(periods, dateStr);
    const features = county.features;

    // Nothing reaches this far out yet
    if (noData || (!dayPeriod && !nightBefore && features.source === 'none' && features.alerts.length === 0)) {
      days.push(placeholderDay(dayName, dateStr, 'Forecast not yet available'));
      continue;
    }

    const tempHigh = dayPeriod ? dayPeriod.temperature : null;
    const tempLow = features.minTempF ?? (nightBefore ? nightBefore.temperature : null);
    const dayWind = dayPeriod ? parseWindSpeed(dayPeriod.windSpeed) : 0;
    const nightWind = nightBefore ? parseWindSpeed(nightBefore.windSpeed) : 0;

    days.push({
      day: dayName,
      date: dateStr,
      temperature: {
        high: tempHigh,
        low: tempLow
      },
      feelsLike: {
        high: calculateWindChill(tempHigh, dayWind),
        low: features.minWindChillF ?? calculateWindChill(tempLow, nightWind)
      },
      wind: {
        speed: Math.max(dayWind, nightWind),
        direction: dayPeriod?.windDirection || null
      },
      forecast: dayPeriod?.shortForecast || nightBefore?.shortForecast || 'Unknown',
      detailedForecast: dayPeriod?.detailedForecast || '',
      // Snow on the ground by the morning bus run, and more during the day
      snowfall: features.snowOvernightIn ?? 0,
      snowfallDuringSchool: features.snowSchoolDayIn ?? 0,
      iceAccumulation: features.iceIn ?? 0,
      alerts: [...new Set(districts.flatMap(d => d.features.alerts.map(a => a.event)))],
      schoolPrediction: {
        predictedStatus: predictedStatus(county.probability, county.delayProbability, county.closureProbability),
        overallProbability: county.probability,
        closureProbability: county.closureProbability,
        delayProbability: county.delayProbability,
        factors: county.factors.map(f => f.factor)
      },
      schools: districts.map(d => ({
        code: d.school.code,
        name: d.school.shortName,
        predictedStatus: predictedStatus(d.probability, d.delayProbability, d.closureProbability),
        closureProbability: d.closureProbability,
        delayProbability: d.delayProbability,
        historicalMatches: d.historicalMatch?.matchCount || 0
      }))
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    location: 'Indiana County, PA',
    weekOf: weekStart,
    days,
    disclaimer: 'Predictions are estimates based on NOAA forecast data and historical patterns. Always check official school district announcements.'
  };
}

// Save weekly forecast to JSON file
async function saveWeeklyForecast() {
  const data = await generateWeeklyForecast();
  try {
    fs.writeFileSync(WEEKLY_FORECAST_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    // Read-only file systems (serverless hosts) can't cache; the fresh
    // forecast is still good to serve.
  }
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
  getWeekStartDate,
  matchPeriodsToDate,
  WEEKLY_FORECAST_PATH
};
