const { getSchoolStatuses, riskTier, DISCLAIMER } = require('../_lib/schoolDelay');
const { getSchoolForecast } = require('../_lib/schoolForecast');
const { getPredictionAccuracy, getForecastOnFile } = require('../_lib/weatherLogger');
const { easternParts, addDays, weekdayName } = require('../_lib/easternTime');
const { getTargetSchoolDay } = require('../_lib/schoolCalendar');

const DISRUPTIONS = new Set(['closed', '2-hour delay', 'delayed', 'early dismissal', 'flexible instruction']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    const now = new Date();
    const targetDate = getTargetSchoolDay(now);

    // Forecast for the next school morning, plus what the districts have posted
    const [forecast, schoolStatuses] = await Promise.all([
      getSchoolForecast({ now, targetDate, onFile: getForecastOnFile(targetDate), deadlineMs: 7000 }),
      getSchoolStatuses().catch(() => ({}))
    ]);

    const { inputs, county, districts } = forecast;
    const today = easternParts(now).dateStr;

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

    // Get prediction accuracy stats
    const accuracy = getPredictionAccuracy();

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
      targetDate,
      targetLabel,
      probability: county.probability,
      delayProbability: county.delayProbability,
      closureProbability: county.closureProbability,
      status: forecast.noData ? 'unknown' : county.status,
      recommendation: forecast.noData
        ? 'Weather data from NOAA is unavailable right now, so no prediction can be made. Check back shortly.'
        : county.recommendation,
      // Set when something the forecast depends on could not be loaded
      notice: !forecast.noData && !inputs.alertsAvailable
        ? 'NWS alerts could not be loaded just now. Any alert shown is the last one on file; check weather.gov for current alerts.'
        : null,
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
