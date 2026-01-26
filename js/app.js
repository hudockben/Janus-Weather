// Janus Forecast Model - Frontend Application

const API_BASE = '/api';

// DOM Elements
const locationSelect = document.getElementById('location-select');
const refreshBtn = document.getElementById('refresh-btn');
const alertsSection = document.getElementById('alerts-section');
const alertsContainer = document.getElementById('alerts-container');
const currentContainer = document.getElementById('current-container');
const hourlyContainer = document.getElementById('hourly-container');
const forecastContainer = document.getElementById('forecast-container');

// Initialize
async function init() {
  await loadLocations();
  await refreshAllData();

  // Event listeners
  locationSelect.addEventListener('change', refreshAllData);
  refreshBtn.addEventListener('click', refreshAllData);

  // Auto-refresh every 10 minutes
  setInterval(refreshAllData, 600000);
}

// Load available locations
async function loadLocations() {
  try {
    const response = await fetch(`${API_BASE}/locations`);
    const locations = await response.json();

    locationSelect.innerHTML = locations
      .map(loc => `<option value="${loc.key}">${loc.name}</option>`)
      .join('');
  } catch (error) {
    console.error('Error loading locations:', error);
  }
}

// Refresh all weather data
async function refreshAllData() {
  const location = locationSelect.value;

  // Load all data in parallel
  await Promise.all([
    loadCurrentConditions(location),
    loadHourlyForecast(location),
    loadForecast(location),
    loadAlerts()
  ]);
}

// Load current conditions
async function loadCurrentConditions(location) {
  currentContainer.innerHTML = '<p>Loading current conditions...</p>';
  currentContainer.classList.add('loading');

  try {
    const response = await fetch(`${API_BASE}/weather/current?location=${location}`);
    if (!response.ok) throw new Error('Failed to fetch current conditions');

    const data = await response.json();
    currentContainer.classList.remove('loading');
    renderCurrentConditions(data);
  } catch (error) {
    console.error('Error loading current conditions:', error);
    currentContainer.classList.remove('loading');
    currentContainer.innerHTML = `<div class="error">Unable to load current conditions. Please try again.</div>`;
  }
}

// Render current conditions
function renderCurrentConditions(data) {
  const windDir = getWindDirection(data.windDirection);
  const updated = new Date(data.timestamp).toLocaleString();

  currentContainer.innerHTML = `
    <div class="current-container">
      <div class="current-main">
        ${data.icon ? `<img src="${data.icon}" alt="${data.description}" class="current-icon">` : ''}
        <div>
          <div class="current-temp">
            ${data.temperature.fahrenheit !== null ? data.temperature.fahrenheit : '--'}<span class="unit">°F</span>
          </div>
          <div class="current-desc">${data.description || 'No data'}</div>
        </div>
      </div>
      <div class="current-details">
        <div class="detail-item">
          <div class="label">Humidity</div>
          <div class="value">${data.humidity !== null ? Math.round(data.humidity) + '%' : '--'}</div>
        </div>
        <div class="detail-item">
          <div class="label">Wind</div>
          <div class="value">${data.windSpeed.mph !== null ? data.windSpeed.mph + ' mph ' + windDir : '--'}</div>
        </div>
        <div class="detail-item">
          <div class="label">Dewpoint</div>
          <div class="value">${data.dewpoint.fahrenheit !== null ? data.dewpoint.fahrenheit + '°F' : '--'}</div>
        </div>
        <div class="detail-item">
          <div class="label">Visibility</div>
          <div class="value">${data.visibility !== null ? Math.round(data.visibility / 1609.34) + ' mi' : '--'}</div>
        </div>
      </div>
      <div class="current-meta">
        Station: ${data.station}<br>
        Updated: ${updated}
      </div>
    </div>
  `;
}

// Load hourly forecast
async function loadHourlyForecast(location) {
  hourlyContainer.innerHTML = '<p>Loading hourly forecast...</p>';
  hourlyContainer.classList.add('loading');

  try {
    const response = await fetch(`${API_BASE}/weather/hourly?location=${location}`);
    if (!response.ok) throw new Error('Failed to fetch hourly forecast');

    const data = await response.json();
    hourlyContainer.classList.remove('loading');
    renderHourlyForecast(data);
  } catch (error) {
    console.error('Error loading hourly forecast:', error);
    hourlyContainer.classList.remove('loading');
    hourlyContainer.innerHTML = `<div class="error">Unable to load hourly forecast. Please try again.</div>`;
  }
}

// Render hourly forecast
function renderHourlyForecast(data) {
  // Show next 24 hours
  const periods = data.periods.slice(0, 24);

  hourlyContainer.innerHTML = periods.map(period => {
    const time = new Date(period.startTime);
    const hour = time.getHours();
    const displayTime = hour === 0 ? '12 AM' :
                        hour < 12 ? `${hour} AM` :
                        hour === 12 ? '12 PM' :
                        `${hour - 12} PM`;

    return `
      <div class="hourly-item">
        <div class="time">${displayTime}</div>
        <img src="${period.icon}" alt="${period.shortForecast}" class="icon">
        <div class="temp">${period.temperature}°</div>
        ${period.probabilityOfPrecipitation > 0 ?
          `<div class="precip">${period.probabilityOfPrecipitation}%</div>` : ''}
      </div>
    `;
  }).join('');
}

// Load 7-day forecast
async function loadForecast(location) {
  forecastContainer.innerHTML = '<p>Loading forecast...</p>';
  forecastContainer.classList.add('loading');

  try {
    const response = await fetch(`${API_BASE}/weather/forecast?location=${location}`);
    if (!response.ok) throw new Error('Failed to fetch forecast');

    const data = await response.json();
    forecastContainer.classList.remove('loading');
    renderForecast(data);
  } catch (error) {
    console.error('Error loading forecast:', error);
    forecastContainer.classList.remove('loading');
    forecastContainer.innerHTML = `<div class="error">Unable to load forecast. Please try again.</div>`;
  }
}

// Render 7-day forecast
function renderForecast(data) {
  forecastContainer.innerHTML = `
    <div class="forecast-grid">
      ${data.periods.map(period => `
        <div class="forecast-item">
          <div class="day">${period.name}</div>
          <img src="${period.icon}" alt="${period.shortForecast}" class="icon">
          <div class="desc">${period.shortForecast}</div>
          <div class="temp">${period.temperature}°${period.temperatureUnit}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// Load alerts
async function loadAlerts() {
  try {
    const response = await fetch(`${API_BASE}/alerts`);
    if (!response.ok) throw new Error('Failed to fetch alerts');

    const data = await response.json();
    renderAlerts(data);
  } catch (error) {
    console.error('Error loading alerts:', error);
    alertsSection.classList.add('hidden');
  }
}

// Render alerts
function renderAlerts(data) {
  if (data.count === 0) {
    alertsSection.classList.add('hidden');
    return;
  }

  alertsSection.classList.remove('hidden');
  alertsContainer.innerHTML = data.alerts.map(alert => `
    <div class="alert-item">
      <h3>${alert.event}</h3>
      <p><strong>${alert.headline}</strong></p>
      ${alert.instruction ? `<p>${alert.instruction}</p>` : ''}
      <p><small>Expires: ${new Date(alert.expires).toLocaleString()}</small></p>
    </div>
  `).join('');
}

// Helper: Convert wind direction degrees to cardinal
function getWindDirection(degrees) {
  if (degrees === null || degrees === undefined) return '';

  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

// Start the app
init();
