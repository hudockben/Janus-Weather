const { getCurrentConditions, getForecast, getHourlyForecast, getAlerts } = require('../_lib/noaa');
const { calculateDelayProbability, getHistoricalPrediction, getSchoolStatuses, getSchoolHistoricalPrediction, INDIANA_COUNTY_SCHOOLS, SCHOOL_CODE_TO_HISTORICAL_NAME } = require('../_lib/schoolDelay');
const { getPredictionAccuracy } = require('../_lib/weatherLogger');

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

    // Calculate weather metrics for per-school predictions
    const tempF = currentConditions?.temperature?.fahrenheit ?? 32;
    const windMph = currentConditions?.windSpeed?.mph || 0;
    let windChill = tempF;
    if (tempF <= 50 && windMph > 3) {
      windChill = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) + (0.4275 * tempF * Math.pow(windMph, 0.16));
      windChill = Math.round(windChill);
    }

    // Estimate snowfall and weather type from forecast
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

    // Combine school info with real-time statuses AND per-school probabilities
    const schoolsWithStatus = INDIANA_COUNTY_SCHOOLS.map(school => {
      const historicalName = SCHOOL_CODE_TO_HISTORICAL_NAME[school.code];
      const schoolPrediction = getSchoolHistoricalPrediction(
        historicalName,
        tempF,
        windChill,
        snowEstimate,
        weatherType
      );

      // Calculate per-school probabilities
      // Blend: 60% overall prediction + 40% school-specific history (if available)
      let delayProbability = prediction.delayProbability;
      let closureProbability = prediction.closureProbability;

      if (schoolPrediction && schoolPrediction.matchCount >= 2) {
        delayProbability = Math.max(0, Math.round(
          (prediction.delayProbability * 0.6) + (schoolPrediction.delayRate * 0.4)
        ));
        closureProbability = Math.max(0, Math.round(
          (prediction.closureProbability * 0.6) + (schoolPrediction.closureRate * 0.4)
        ));
      }

      // Calculate combined probability and determine risk tier
      const combinedProbability = Math.max(delayProbability, closureProbability);
      let riskTier;
      if (combinedProbability >= 70) {
        riskTier = 'high';
      } else if (combinedProbability >= 40) {
        riskTier = 'moderate';
      } else if (combinedProbability >= 15) {
        riskTier = 'low';
      } else {
        riskTier = 'minimal';
      }

      return {
        ...school,
        currentStatus: schoolStatuses[school.code]?.status || 'unknown',
        statusSource: schoolStatuses[school.code]?.source || 'unavailable',
        lastChecked: schoolStatuses[school.code]?.lastChecked || null,
        delayProbability,
        closureProbability,
        riskTier,
        historicalMatches: schoolPrediction?.matchCount || 0
      };
    });

    // Get prediction accuracy stats
    const accuracy = getPredictionAccuracy();

    res.json({
      location: 'Indiana County, PA',
      timestamp: new Date().toISOString(),
      predictionAccuracy: accuracy,
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
