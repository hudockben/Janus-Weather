const BASE_URL = 'https://api.weather.gov';
const USER_AGENT = 'JanusForecastModel/1.0 (contact@example.com)';

// Indiana County locations
const LOCATIONS = {
  indiana: { name: 'Indiana', lat: 40.6215, lon: -79.1525 },
  homercity: { name: 'Homer City', lat: 40.5423, lon: -79.1556 },
  blairsville: { name: 'Blairsville', lat: 40.4312, lon: -79.2609 },
  saltsburg: { name: 'Saltsburg', lat: 40.4884, lon: -79.4517 },
  clymer: { name: 'Clymer', lat: 40.6687, lon: -79.0117 },
  marioncenter: { name: 'Marion Center', lat: 40.7687, lon: -79.0467 }
};

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/geo+json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function getGridPoint(lat, lon) {
  const data = await fetchWithRetry(`${BASE_URL}/points/${lat},${lon}`);
  return data.properties;
}

async function getCurrentConditions(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const stationsUrl = gridPoint.observationStations;

  const stationsData = await fetchWithRetry(stationsUrl);
  const nearestStation = stationsData.features[0];

  if (!nearestStation) {
    throw new Error('No observation stations found');
  }

  const stationId = nearestStation.properties.stationIdentifier;
  const observationUrl = `${BASE_URL}/stations/${stationId}/observations/latest`;

  const observation = await fetchWithRetry(observationUrl);
  const props = observation.properties;

  return {
    location: location.name,
    station: nearestStation.properties.name,
    timestamp: props.timestamp,
    temperature: {
      value: props.temperature?.value,
      unit: 'C',
      fahrenheit: props.temperature?.value != null
        ? Math.round(props.temperature.value * 9/5 + 32)
        : null
    },
    humidity: props.relativeHumidity?.value,
    windSpeed: {
      value: props.windSpeed?.value,
      unit: 'km/h',
      mph: props.windSpeed?.value != null
        ? Math.round(props.windSpeed.value * 0.621371)
        : null
    },
    windDirection: props.windDirection?.value,
    description: props.textDescription,
    icon: props.icon,
    barometricPressure: props.barometricPressure?.value,
    visibility: props.visibility?.value,
    dewpoint: {
      value: props.dewpoint?.value,
      fahrenheit: props.dewpoint?.value != null
        ? Math.round(props.dewpoint.value * 9/5 + 32)
        : null
    }
  };
}

async function getForecast(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const forecastUrl = gridPoint.forecast;

  const forecast = await fetchWithRetry(forecastUrl);

  return {
    location: location.name,
    updated: forecast.properties.updated,
    periods: forecast.properties.periods.map(period => ({
      name: period.name,
      startTime: period.startTime,
      endTime: period.endTime,
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit,
      windSpeed: period.windSpeed,
      windDirection: period.windDirection,
      shortForecast: period.shortForecast,
      detailedForecast: period.detailedForecast,
      icon: period.icon,
      isDaytime: period.isDaytime
    }))
  };
}

async function getHourlyForecast(locationKey = 'indiana') {
  const location = LOCATIONS[locationKey];
  if (!location) {
    throw new Error(`Unknown location: ${locationKey}`);
  }

  const gridPoint = await getGridPoint(location.lat, location.lon);
  const hourlyUrl = gridPoint.forecastHourly;

  const forecast = await fetchWithRetry(hourlyUrl);
  const periods = forecast.properties.periods.slice(0, 48);

  return {
    location: location.name,
    updated: forecast.properties.updated,
    periods: periods.map(period => ({
      startTime: period.startTime,
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit,
      windSpeed: period.windSpeed,
      windDirection: period.windDirection,
      shortForecast: period.shortForecast,
      icon: period.icon,
      probabilityOfPrecipitation: period.probabilityOfPrecipitation?.value || 0
    }))
  };
}

async function getAlerts() {
  // Use Pittsburgh forecast zone for western PA alerts
  const alertsUrl = `${BASE_URL}/alerts/active?zone=PAZ021,PAZ020,PAZ019,PAZ018`;
  const alerts = await fetchWithRetry(alertsUrl);

  // Filter for Indiana County and surrounding Pittsburgh area
  const westernPACounties = ['indiana', 'allegheny', 'westmoreland', 'armstrong', 'cambria', 'jefferson', 'clearfield'];

  const relevantAlerts = alerts.features.filter(alert => {
    const areas = (alert.properties.areaDesc || '').toLowerCase();
    return westernPACounties.some(county => areas.includes(county));
  });

  return {
    count: relevantAlerts.length,
    alerts: relevantAlerts.map(alert => ({
      id: alert.properties.id,
      event: alert.properties.event,
      severity: alert.properties.severity,
      certainty: alert.properties.certainty,
      urgency: alert.properties.urgency,
      headline: alert.properties.headline,
      description: alert.properties.description,
      instruction: alert.properties.instruction,
      onset: alert.properties.onset,
      expires: alert.properties.expires,
      areas: alert.properties.areaDesc
    }))
  };
}

function getLocations() {
  return Object.entries(LOCATIONS).map(([key, value]) => ({
    key,
    name: value.name,
    lat: value.lat,
    lon: value.lon
  }));
}

module.exports = {
  getCurrentConditions,
  getForecast,
  getHourlyForecast,
  getAlerts,
  getLocations,
  LOCATIONS
};
