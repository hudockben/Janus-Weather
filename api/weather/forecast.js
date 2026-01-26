const { getForecast } = require('../_lib/noaa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  try {
    const location = req.query.location || 'indiana';
    const forecast = await getForecast(location);
    res.json(forecast);
  } catch (error) {
    console.error('Error fetching forecast:', error);
    res.status(500).json({ error: error.message });
  }
};
