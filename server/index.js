const express = require('express');
const path = require('path');
const noaa = require('./services/noaa');
const { logWeatherData, getLoggingPreview } = require('../api/_lib/weatherLogger');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes

// Get available locations
app.get('/api/locations', (req, res) => {
  res.json(noaa.getLocations());
});

// Get current conditions
app.get('/api/weather/current', async (req, res) => {
  try {
    const location = req.query.location || 'indiana';
    const conditions = await noaa.getCurrentConditions(location);
    res.json(conditions);
  } catch (error) {
    console.error('Error fetching current conditions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get 7-day forecast
app.get('/api/weather/forecast', async (req, res) => {
  try {
    const location = req.query.location || 'indiana';
    const forecast = await noaa.getForecast(location);
    res.json(forecast);
  } catch (error) {
    console.error('Error fetching forecast:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hourly forecast
app.get('/api/weather/hourly', async (req, res) => {
  try {
    const location = req.query.location || 'indiana';
    const hourly = await noaa.getHourlyForecast(location);
    res.json(hourly);
  } catch (error) {
    console.error('Error fetching hourly forecast:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get weather alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await noaa.getAlerts();
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Weather logging endpoint - Preview (GET)
app.get('/api/log-weather', async (req, res) => {
  try {
    const preview = await getLoggingPreview();
    res.json({
      mode: 'preview',
      message: 'This is a preview. Use POST request to actually log data.',
      ...preview
    });
  } catch (error) {
    console.error('Error in log-weather preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Weather logging endpoint - Execute (POST)
app.post('/api/log-weather', async (req, res) => {
  // Simple API key validation (set LOG_API_KEY env var for security)
  const apiKey = process.env.LOG_API_KEY;
  if (apiKey) {
    const providedKey = req.headers['x-api-key'] ||
                        req.query.apiKey ||
                        req.headers.authorization?.replace('Bearer ', '');
    if (providedKey !== apiKey) {
      return res.status(401).json({ error: 'Unauthorized. Provide valid API key.' });
    }
  }

  try {
    const options = {
      forceLog: req.body?.forceLog === true || req.query.forceLog === 'true',
      dryRun: req.body?.dryRun === true || req.query.dryRun === 'true'
    };

    const result = await logWeatherData(options);

    res.json({
      success: true,
      message: result.logged.length > 0
        ? `Successfully logged ${result.logged.length} record(s)`
        : 'No records to log (schools are open or already logged today)',
      ...result
    });
  } catch (error) {
    console.error('Error logging weather data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Janus Forecast Model running on http://localhost:${PORT}`);
});
