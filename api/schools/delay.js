const { getCurrentConditions, getForecast, getHourlyForecast, getAlerts } = require('../_lib/noaa');
const { calculateDelayProbability, getSchoolStatuses, INDIANA_COUNTY_SCHOOLS } = require('../_lib/schoolDelay');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    // Fetch weather data and school statuses in parallel
    const [currentConditions, forecast, hourlyForecast, alertsData, schoolStatuses] = await Promise.all([
      getCurrentConditions('indiana').catch(() => null),
      getForecast('indiana').catch(() => null),
      getHourlyForecast('indiana').catch(() => null),
      getAlerts().catch(() => ({ alerts: [] })),
      getSchoolStatuses().catch(() => ({}))
    ]);

    // Calculate delay probability
    const prediction = calculateDelayProbability(
      currentConditions,
      forecast,
      hourlyForecast,
      alertsData.alerts
    );

    // Combine school info with real-time statuses
    const schoolsWithStatus = INDIANA_COUNTY_SCHOOLS.map(school => ({
      ...school,
      currentStatus: schoolStatuses[school.code]?.status || 'unknown',
      statusSource: schoolStatuses[school.code]?.source || 'unavailable',
      lastChecked: schoolStatuses[school.code]?.lastChecked || null
    }));

    res.json({
      location: 'Indiana County, PA',
      timestamp: new Date().toISOString(),
      weather: {
        current: currentConditions ? {
          temperature: currentConditions.temperature?.fahrenheit,
          conditions: currentConditions.description,
          wind: currentConditions.windSpeed?.mph
        } : null,
        forecast: forecast ? forecast.periods.slice(0, 2).map(p => ({
          name: p.name,
          forecast: p.shortForecast,
          temp: p.temperature
        })) : null
      },
      ...prediction,
      schools: schoolsWithStatus
    });
  } catch (error) {
    console.error('Error calculating school delay:', error);
    res.status(500).json({ error: error.message });
  }
};
