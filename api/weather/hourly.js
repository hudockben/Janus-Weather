const { getHourlyForecast } = require('../_lib/noaa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  try {
    const location = req.query.location || 'indiana';
    const hourly = await getHourlyForecast(location);
    res.json(hourly);
  } catch (error) {
    console.error('Error fetching hourly forecast:', error);
    res.status(500).json({ error: error.message });
  }
};
