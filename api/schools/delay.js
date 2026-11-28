const { getSchoolStatuses, riskTier, DISCLAIMER } = require('../_lib/schoolDelay');
const { getSchoolForecast, withDeadline } = require('../_lib/schoolForecast');
const { getPredictionAccuracy, getForecastOnFile } = require('../_lib/weatherLogger');
const { easternParts, addDays, weekdayName } = require('../_lib/easternTime');
const { getTargetSchoolDay, getNonSchoolReason, tolerateBrokenCalendar } = require('../_lib/schoolCalendar');

const DISRUPTIONS = new Set(['closed', '2-hour delay', 'delayed', 'early dismissal', 'flexible instruction']);
const CLOSURES = new Set(['closed', 'flexible instruction']);

// Every outside source gets this long. The host stops a request at about ten
// seconds, so a source that has not answered by then is treated as down.
const SOURCE_DEADLINE_MS = 7000;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// "Monday, January 4" from YYYY-MM-DD
function longDate(dateStr) {
  const [, month, day] = dateStr.split('-').map(Number);
  return `${weekdayName(dateStr)}, ${MONTHS[month - 1]} ${day}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    // A days-off file or forecast log that cannot be read (a typo in a hand
    // edit) must not take the forecast off the page. The page carries on
    // without them; the logger is what stops and reports the broken file.
    const calendarProblem = tolerateBrokenCalendar();

    const now = new Date();
    const today = easternParts(now).dateStr;
    const targetDate = getTargetSchoolDay(now);

    let onFile = {};
    try {
      onFile = getForecastOnFile(targetDate);
    } catch (error) {
      console.error('Forecast log unreadable:', error.message);
    }

    // Forecast for the next school morning, plus what the districts have posted
    const [forecast, schoolStatuses] = await Promise.all([
      getSchoolForecast({ now, targetDate, onFile, deadlineMs: SOURCE_DEADLINE_MS }),
      withDeadline(getSchoolStatuses(), SOURCE_DEADLINE_MS).catch(() => ({}))
    ]);

    const { inputs, county, districts } = forecast;

    let targetLabel = weekdayName(targetDate);
    if (targetDate === today) targetLabel = 'This morning';
    else if (targetDate === addDays(today, 1)) targetLabel = 'Tomorrow';

    const schoolsWithStatus = districts.map(district => {
      const posted = schoolStatuses[district.school.code] || {};
      const status = posted.status || 'unknown';

      // A district that has already posted a delay or closure for the forecast
      // morning is no longer a prediction
      const announced = posted.statusDate === targetDate && DISRUPTIONS.has(status) ? status : null;

      return {
        ...district.school,
        currentStatus: status,
        statusSource: posted.source || 'unavailable',
        statusDate: posted.statusDate || null,
        lastChecked: posted.lastChecked || null,
        delayProbability: district.delayProbability,
        closureProbability: district.closureProbability,
        riskTier: riskTier(district.probability),
        announced,
        historicalMatches: district.historicalMatch?.matchCount || 0
      };
    });

    // What has already been posted for the forecast morning outranks any
    // percentage: the headline must not say "normal schedule expected" above
    // six announced delays.
    const announcedSchools = schoolsWithStatus.filter(s => s.announced);
    const announcements = announcedSchools.length === 0 ? null : {
      total: announcedSchools.length,
      closures: announcedSchools.filter(s => CLOSURES.has(s.announced)).length,
      delays: announcedSchools.filter(s => !CLOSURES.has(s.announced)).length,
      of: schoolsWithStatus.length
    };

    let status = county.status;
    let recommendation = county.recommendation;
    if (forecast.noData && forecast.noDataReason === 'beyond-range') {
      status = 'unknown';
      recommendation = `The next school day is ${longDate(targetDate)}, which is further out than the National Weather Service forecasts. A prediction will appear about a week before.`;
    } else if (forecast.noData) {
      status = 'unknown';
      recommendation = 'Weather data from NOAA is unavailable right now, so no prediction can be made. Check back shortly.';
    }

    // Get prediction accuracy stats
    const accuracy = getPredictionAccuracy();

    // Anything the forecast normally rests on that could not be loaded
    const notices = [];
    if (!forecast.noData) {
      if (!inputs.alertsAvailable) {
        notices.push('NWS alerts could not be loaded just now. Any alert shown is the last one on file; check weather.gov for current alerts.');
      }
      if (county.features.source === 'on-file') {
        notices.push('The NWS snow and temperature forecast could not be loaded just now; those figures are from the last forecast on file.');
      } else if (county.features.source === 'temps-only') {
        notices.push('The NWS snow and ice forecast could not be loaded just now, so this estimate rests on temperature and alerts alone.');
      }
    }
    if (calendarProblem) {
      notices.push('The list of school days off could not be read, so only the standard holidays are being skipped.');
    }

    res.json({
      location: 'Indiana County, PA',
      timestamp: now.toISOString(),
      predictionAccuracy: accuracy,
      weather: {
        current: inputs.current ? {
          temperature: inputs.current.temperature?.fahrenheit,
          conditions: inputs.current.description,
          wind: inputs.current.windSpeed?.mph
        } : null,
        forecast: inputs.forecast ? inputs.forecast.periods.slice(0, 2).map(p => ({
          name: p.name,
          forecast: p.shortForecast,
          temp: p.temperature
        })) : null
      },
      // Dates are Eastern, whatever time zone the viewer is in
      today,
      todayNoSchool: getNonSchoolReason(today),
      targetDate,
      targetLabel,
      // True when nothing is known about the forecast morning; the numbers
      // below are then placeholders, not a forecast of zero
      noData: forecast.noData,
      probability: county.probability,
      delayProbability: county.delayProbability,
      closureProbability: county.closureProbability,
      status,
      recommendation,
      announcements,
      // Set when something the forecast depends on could not be loaded
      notice: notices.length > 0 ? notices.join(' ') : null,
      factors: county.factors,
      historicalMatch: county.historicalMatch,
      // What the model saw for the county seat, for transparency
      conditions: forecast.noData ? null : {
        snowOvernightIn: county.features.snowOvernightIn,
        snowSchoolDayIn: county.features.snowSchoolDayIn,
        iceIn: county.features.iceIn,
        minWindChillF: county.features.minWindChillF,
        source: county.features.source
      },
      schools: schoolsWithStatus,
      disclaimer: DISCLAIMER
    });
  } catch (error) {
    console.error('Error calculating school delay:', error);
    res.status(500).json({ error: error.message });
  }
};
