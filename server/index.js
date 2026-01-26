const express = require('express');
const path = require('path');
const noaa = require('./services/noaa');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Start server
app.listen(PORT, () => {
  console.log(`Janus Forecast Model running on http://localhost:${PORT}`);
});
