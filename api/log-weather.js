// API endpoint for logging weather data to historical records
// Can be triggered manually, via cron, or through scheduled tasks

const { logWeatherData, getLoggingPreview } = require('./_lib/weatherLogger');

// Simple API key validation (set LOG_API_KEY environment variable for security)
function validateApiKey(req) {
  const apiKey = process.env.LOG_API_KEY;
  if (!apiKey) return true; // No key configured, allow all requests

  const providedKey = req.headers['x-api-key'] ||
                      req.query.apiKey ||
                      req.headers.authorization?.replace('Bearer ', '');

  return providedKey === apiKey;
}

async function handler(req, res) {
  // Only allow POST for actual logging, GET for preview
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET for preview, POST to log.' });
  }

  // Validate API key for POST requests (actual logging)
  if (req.method === 'POST' && !validateApiKey(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide valid API key.' });
  }

  try {
    if (req.method === 'GET') {
      // Preview mode - show what would be logged
      const preview = await getLoggingPreview();
      return res.json({
        mode: 'preview',
        message: 'This is a preview. Use POST request to actually log data.',
        ...preview
      });
    }

    // POST - Actually log the data
    const options = {
      forceLog: req.body?.forceLog === true || req.query.forceLog === 'true',
      dryRun: req.body?.dryRun === true || req.query.dryRun === 'true'
    };

    const result = await logWeatherData(options);

    return res.json({
      success: true,
      message: result.logged.length > 0
        ? `Successfully logged ${result.logged.length} record(s)`
        : 'No records to log (schools are open or already logged today)',
      ...result
    });

  } catch (error) {
    console.error('Error in log-weather endpoint:', error);
    return res.status(500).json({
      error: 'Failed to log weather data',
      message: error.message
    });
  }
}

module.exports = handler;
