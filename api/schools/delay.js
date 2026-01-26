const { getCurrentConditions, getForecast, getAlerts } = require('../_lib/noaa');
const { calculateDelayProbability } = require('../_lib/schoolDelay');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    // Fetch weather data for Indiana, PA
    const [currentConditions, forecast, alertsData] = await Promise.all([
      getCurrentConditions('indiana').catch(() => null),
      getForecast('indiana').catch(() => null),
      getAlerts().catch(() => ({ alerts: [] }))
    ]);

    // Calculate delay probability
    const prediction = calculateDelayProbability(
      currentConditions,
      forecast,
      null,
      alertsData.alerts
    );

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
      ...prediction
    });
  } catch (error) {
    console.error('Error calculating school delay:', error);
    res.status(500).json({ error: error.message });
  }
};
