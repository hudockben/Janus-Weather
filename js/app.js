// Janus Forecast Model - Frontend Application

const API_BASE = '/api';

// DOM Elements
const alertsSection = document.getElementById('alerts-section');
const alertsHeader = document.getElementById('alerts-header');
const alertsContainer = document.getElementById('alerts-container');
const alertsCount = document.getElementById('alerts-count');
const schoolDelayContainer = document.getElementById('school-delay-container');
const currentContainer = document.getElementById('current-container');
const hourlyContainer = document.getElementById('hourly-container');
const forecastContainer = document.getElementById('forecast-container');

// Initialize
async function init() {
  await refreshAllData();

  // Alerts collapsible toggle
  alertsHeader.addEventListener('click', toggleAlerts);

  // Auto-refresh every 10 minutes
  setInterval(refreshAllData, 600000);
}

// Toggle alerts section expanded/collapsed
function toggleAlerts() {
  alertsHeader.classList.toggle('collapsed');
  alertsContainer.classList.toggle('collapsed');
}

// Refresh all weather data
async function refreshAllData() {
  const location = 'indiana';

  // Load all data in parallel
  await Promise.all([
    loadCurrentConditions(location),
    loadHourlyForecast(location),
    loadForecast(location),
    loadAlerts(),
    loadSchoolDelay()
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
  const weatherType = getWeatherType(data.description);

  currentContainer.innerHTML = `
    <div class="current-container" data-weather="${weatherType}">
      <div class="weather-effects" aria-hidden="true"></div>
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

  // Spawn weather particles
  spawnWeatherEffects(weatherType);
}

// Determine weather type from description
function getWeatherType(description) {
  if (!description) return 'clear';
  const desc = description.toLowerCase();

  if (desc.includes('snow') || desc.includes('flurr')) return 'snow';
  if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) return 'rain';
  if (desc.includes('fog') || desc.includes('mist') || desc.includes('haze')) return 'fog';
  if (desc.includes('cloud') || desc.includes('overcast')) return 'cloudy';
  if (desc.includes('sun') || desc.includes('clear')) return 'clear';
  return 'clear';
}

// Spawn weather effect particles
function spawnWeatherEffects(weatherType) {
  const container = document.querySelector('.weather-effects');
  if (!container) return;

  container.innerHTML = '';

  if (weatherType === 'snow') {
    // Spawn 15 snowflakes
    for (let i = 0; i < 15; i++) {
      const flake = document.createElement('div');
      flake.className = 'snowflake';
      flake.style.left = Math.random() * 100 + '%';
      flake.style.animationDelay = Math.random() * 5 + 's';
      flake.style.animationDuration = (4 + Math.random() * 4) + 's';
      flake.style.opacity = 0.3 + Math.random() * 0.4;
      flake.style.fontSize = (8 + Math.random() * 8) + 'px';
      flake.textContent = '❄';
      container.appendChild(flake);
    }
  } else if (weatherType === 'rain') {
    // Spawn 20 rain drops
    for (let i = 0; i < 20; i++) {
      const drop = document.createElement('div');
      drop.className = 'raindrop';
      drop.style.left = Math.random() * 100 + '%';
      drop.style.animationDelay = Math.random() * 2 + 's';
      drop.style.animationDuration = (0.5 + Math.random() * 0.5) + 's';
      drop.style.opacity = 0.2 + Math.random() * 0.3;
      container.appendChild(drop);
    }
  } else if (weatherType === 'fog') {
    // Add fog layers
    for (let i = 0; i < 3; i++) {
      const fog = document.createElement('div');
      fog.className = 'fog-layer';
      fog.style.animationDelay = i * 2 + 's';
      fog.style.top = (20 + i * 25) + '%';
      container.appendChild(fog);
    }
  }
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
      ${data.periods.map(period => {
        const date = new Date(period.startTime);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `
        <div class="forecast-item">
          <div class="day">${period.name}<span class="date">${dateStr}</span></div>
          <img src="${period.icon}" alt="${period.shortForecast}" class="icon">
          <div class="desc">${period.shortForecast}</div>
          <div class="temp">${period.temperature}°${period.temperatureUnit}</div>
        </div>`;
      }).join('')}
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
    alertsCount.textContent = '';
    return;
  }

  alertsSection.classList.remove('hidden');
  alertsCount.textContent = data.count;
  alertsContainer.innerHTML = data.alerts.map(alert => `
    <div class="alert-item">
      <h3>${alert.event}</h3>
      <p><strong>${alert.headline}</strong></p>
      ${alert.instruction ? `<p>${alert.instruction}</p>` : ''}
      <p><small>Expires: ${new Date(alert.expires).toLocaleString()}</small></p>
    </div>
  `).join('');
}

// Load school delay prediction
async function loadSchoolDelay() {
  schoolDelayContainer.innerHTML = '<p>Analyzing weather conditions...</p>';
  schoolDelayContainer.classList.add('loading');

  try {
    const response = await fetch(`${API_BASE}/schools/delay`);
    if (!response.ok) throw new Error('Failed to fetch school delay prediction');

    const data = await response.json();
    schoolDelayContainer.classList.remove('loading');
    renderSchoolDelay(data);
  } catch (error) {
    console.error('Error loading school delay:', error);
    schoolDelayContainer.classList.remove('loading');
    schoolDelayContainer.innerHTML = `<div class="error">Unable to load school delay prediction.</div>`;
  }
}

// Render school delay prediction
function renderSchoolDelay(data) {
  const statusLabels = {
    minimal: 'Normal Operations Expected',
    low: 'Low Risk of Delays',
    moderate: 'Moderate Risk of Delays',
    high: 'High Risk of Delay/Closure'
  };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const forecastDate = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // Determine which probability is higher for styling
  const primaryType = data.closureProbability > data.delayProbability ? 'closure' : 'delay';

  schoolDelayContainer.innerHTML = `
    <div class="delay-date">Forecast for ${forecastDate}</div>
    <div class="delay-status">
      <div class="delay-probabilities">
        <div class="delay-probability ${primaryType === 'delay' ? data.status : 'secondary'}">
          <div class="percentage">${data.delayProbability}%</div>
          <div class="label">Delay</div>
        </div>
        <div class="delay-probability ${primaryType === 'closure' ? data.status : 'secondary'}">
          <div class="percentage">${data.closureProbability}%</div>
          <div class="label">Closure</div>
        </div>
      </div>
      <div class="delay-info">
        <div class="status-label ${data.status}">${statusLabels[data.status] || data.status}</div>
        <div class="recommendation">${data.recommendation}</div>
      </div>
    </div>

    <div class="delay-factors">
      <h4 class="collapsible-header section-toggle" data-target="factors-content">
        <span class="caret factors-caret"></span>
        Contributing Factors
        <span class="factor-count">${data.factors?.length || 0}</span>
      </h4>
      <div id="factors-content" class="collapsible-content section-content">
        <p class="factors-explanation">Each factor adds to the overall delay/closure probability</p>
        ${data.factors && data.factors.length > 0 ? `
          <ul>
            ${data.factors.map(f => `
              <li>
                <span>${f.factor}</span>
                <span class="impact">+${f.impact}%</span>
              </li>
            `).join('')}
          </ul>
        ` : '<p class="no-factors">No significant weather factors detected</p>'}
      </div>
    </div>

    ${data.historicalMatch ? `
      <div class="historical-match">
        <h4 class="collapsible-header section-toggle" data-target="historical-content">
          <span class="caret historical-caret"></span>
          Historical Pattern
          <span class="match-count">${data.historicalMatch.matchCount} matches</span>
        </h4>
        <div id="historical-content" class="collapsible-content section-content">
          <p>Based on <strong>${data.historicalMatch.matchCount}</strong> similar past days: <strong>${data.historicalMatch.closedCount}</strong> resulted in closures, <strong>${data.historicalMatch.delayCount}</strong> in delays</p>
          <div class="past-matches">
            ${data.historicalMatch.topMatches.map(m => `
              <div class="past-match-item">
                <span class="past-school">${m.school}</span>
                <span class="past-date">${new Date(m.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span class="past-type">${m.type}</span>
                <span class="past-conditions">${m.temperature}°F / Feels ${m.feelsLike}°F${m.snowfall > 0 ? ` / ${m.snowfall}" snow` : ''}</span>
                <span class="past-status ${m.status}">${m.status.charAt(0).toUpperCase() + m.status.slice(1)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}

    <div class="delay-schools">
      ${data.schools.map(s => {
        const statusClass = getStatusClass(s.currentStatus);
        const statusLabel = getStatusLabel(s.currentStatus);
        const riskTierLabel = getRiskTierLabel(s.riskTier);
        const todayDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
        return `
          <div class="school-card">
            <a href="${s.website}" target="_blank" class="school-name">${s.shortName}</a>
            <div class="school-row today-row">
              <span class="row-label">TODAY ${todayDate}:</span>
              <span class="school-current-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="school-row tomorrow-row">
              <span class="row-label">TOMORROW:</span>
              <span class="school-prob delay">${s.delayProbability}% delay</span>
              <span class="school-prob closure">${s.closureProbability}% closure</span>
              <span class="school-risk-tier ${s.riskTier}">${riskTierLabel}</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <p class="delay-disclaimer">${data.disclaimer}</p>
  `;

  // Attach click handlers for collapsible sections
  attachSectionToggles();
}

// Attach toggle handlers for collapsible sections
function attachSectionToggles() {
  const toggles = document.querySelectorAll('.section-toggle');
  toggles.forEach(toggle => {
    toggle.addEventListener('click', () => {
      const targetId = toggle.getAttribute('data-target');
      const content = document.getElementById(targetId);
      if (content) {
        toggle.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
      }
    });
  });
}

// Helper: Convert wind direction degrees to cardinal
function getWindDirection(degrees) {
  if (degrees === null || degrees === undefined) return '';

  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

// Helper: Get CSS class for school status
function getStatusClass(status) {
  switch (status) {
    case 'open': return 'status-open';
    case 'closed': return 'status-closed';
    case '2-hour delay':
    case 'delayed': return 'status-delayed';
    case 'early dismissal': return 'status-early';
    case 'flexible instruction':
    case 'flexible instruction day': return 'status-flexible';
    default: return 'status-unknown';
  }
}

// Helper: Get display label for school status
function getStatusLabel(status) {
  switch (status) {
    case 'open': return 'Open';
    case 'closed': return 'Closed';
    case '2-hour delay': return '2-Hour Delay';
    case 'delayed': return 'Delayed';
    case 'early dismissal': return 'Early Dismissal';
    case 'flexible instruction':
    case 'flexible instruction day': return 'Flexible Instruction';
    default: return 'Checking...';
  }
}

// Helper: Get display label for risk tier
function getRiskTierLabel(tier) {
  switch (tier) {
    case 'high': return 'High Risk';
    case 'moderate': return 'Moderate';
    case 'low': return 'Low Risk';
    case 'minimal': return 'Minimal';
    default: return '';
  }
}

// Start the app
init();
