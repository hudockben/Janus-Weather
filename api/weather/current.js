const { getCurrentConditions } = require('../_lib/noaa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    const location = req.query.location || 'indiana';
    const conditions = await getCurrentConditions(location);
    res.json(conditions);
  } catch (error) {
    console.error('Error fetching current conditions:', error);
    res.status(500).json({ error: error.message });
  }
};
