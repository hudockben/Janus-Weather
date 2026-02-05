const { generateWeeklyForecast, saveWeeklyForecast, loadWeeklyForecast } = require('../_lib/weeklyForecast');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  try {
    const refresh = req.query.refresh === 'true';
    let data;

    if (!refresh) {
      // Try to serve cached data if it's less than 2 hours old
      data = loadWeeklyForecast();
      if (data && data.generatedAt) {
        const age = Date.now() - new Date(data.generatedAt).getTime();
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        if (age < TWO_HOURS) {
          return res.json(data);
        }
      }
    }

    // Generate fresh forecast and save to JSON file
    data = await saveWeeklyForecast();
    res.json(data);
  } catch (error) {
    console.error('Error generating weekly forecast:', error);

    // Fall back to cached data if available
    const cached = loadWeeklyForecast();
    if (cached && cached.generatedAt) {
      return res.json({
        ...cached,
        _stale: true,
        _error: 'Using cached data due to fetch error'
      });
    }

    res.status(500).json({ error: error.message });
  }
};
