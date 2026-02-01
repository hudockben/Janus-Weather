// School Delay Prediction for Indiana County, PA
// Analyzes weather conditions to estimate delay/closure probability

const INDIANA_COUNTY_SCHOOLS = [
  {
    name: 'Indiana Area School District',
    code: 'IASD',
    shortName: 'Indiana Area',
    website: 'https://www.iasd.cc',
    statusUrl: 'https://www.iasd.cc',
    twitter: '@IndianaAreaSD'
  },
  {
    name: 'Homer-Center School District',
    code: 'HCSD',
    shortName: 'Homer-Center',
    website: 'https://www.homercenter.org',
    statusUrl: 'https://www.homercenter.org',
    twitter: null
  },
  {
    name: 'Marion Center Area School District',
    code: 'MCASD',
    shortName: 'Marion Center',
    website: 'https://www.mcasd.net',
    statusUrl: 'https://www.mcasd.net',
    twitter: null
  },
  {
    name: 'Penns Manor Area School District',
    code: 'PMASD',
    shortName: 'Penns Manor',
    website: 'https://www.pennsmanor.org',
    statusUrl: 'https://www.pennsmanor.org',
    twitter: null
  },
  {
    name: 'Purchase Line School District',
    code: 'PLSD',
    shortName: 'Purchase Line',
    website: 'https://www.plsd.k12.pa.us',
    statusUrl: 'https://www.plsd.k12.pa.us',
    twitter: null
  },
  {
    name: 'United School District',
    code: 'USD',
    shortName: 'United',
    website: 'https://www.unitedsd.net',
    statusUrl: 'https://www.unitedsd.net',
    twitter: null
  }
];

// Status cache to avoid hitting sources too frequently
let statusCache = {
  lastUpdated: null,
  statuses: {}
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Fetch school closings from ARIN IU28 SchoolCast (official source for Indiana County)
async function checkSchoolCast() {
  try {
    const response = await fetch('https://schoolcast.iu28.org', {
      headers: { 'User-Agent': 'JanusForecastModel/1.0' }
    });
    if (!response.ok) return null;
    const html = await response.text();
    return html;
  } catch (error) {
    console.error('Error fetching SchoolCast:', error);
    return null;
  }
}

// Fallback: fetch from local radio station closings pages
async function checkLocalRadio() {
  const urls = [
    'https://www.wccsradio.com/?s=school+closings',
    'https://www.wdadradio.com/?s=school+closings'
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'JanusForecastModel/1.0' }
      });
      if (!response.ok) continue;
      const html = await response.text();
      if (html) return html;
    } catch (error) {
      console.error(`Error fetching ${url}:`, error);
    }
  }
  return null;
}

// Pattern matching for school names in HTML content
const SCHOOL_PATTERNS = {
  'IASD': ['indiana area'],
  'HCSD': ['homer-center', 'homer center'],
  'MCASD': ['marion center'],
  'PMASD': ['penns manor'],
  'PLSD': ['purchase line'],
  'USD': ['united']
};

// Parse school status from HTML content
function parseSchoolStatus(schoolCode, htmlContent) {
  if (!htmlContent) return 'unknown';

  const lowerHtml = htmlContent.toLowerCase();
  const patterns = SCHOOL_PATTERNS[schoolCode] || [];

  for (const pattern of patterns) {
    const idx = lowerHtml.indexOf(pattern);
    if (idx === -1) continue;

    // Extract context around the match (200 chars after, 50 before)
    const context = lowerHtml.substring(Math.max(0, idx - 50), idx + 200);

    // For 'united', avoid false positives (e.g. "United States")
    if (schoolCode === 'USD' && pattern === 'united') {
      if (context.includes('united states') || context.includes('united nations')) {
        continue;
      }
    }

    if (context.includes('closed') || context.includes('closure')) {
      return 'closed';
    } else if (context.includes('2 hour') || context.includes('2-hour') || context.includes('two hour') || context.includes('two-hour')) {
      return '2-hour delay';
    } else if (context.includes('delay')) {
      return 'delayed';
    } else if (context.includes('early dismissal')) {
      return 'early dismissal';
    } else if (context.includes('remote learning') || context.includes('remote instruction')) {
      return 'closed';
    } else if (context.includes('flexible instruction')) {
      return 'flexible instruction';
    }
  }

  return 'unknown';
}

// Get current status for all schools
async function getSchoolStatuses() {
  const now = Date.now();

  // Return cached statuses if still valid
  if (statusCache.lastUpdated && (now - statusCache.lastUpdated) < CACHE_DURATION) {
    return statusCache.statuses;
  }

  // Try SchoolCast first (official ARIN IU28 source), then local radio as fallback
  let html = await checkSchoolCast();
  let source = 'SchoolCast';

  if (!html) {
    html = await checkLocalRadio();
    source = 'Local Radio';
  }

  const statuses = {};

  for (const school of INDIANA_COUNTY_SCHOOLS) {
    let status = parseSchoolStatus(school.code, html);

    // If source is available but school not mentioned, assume open
    if (status === 'unknown' && html) {
      status = 'open';
    }

    statuses[school.code] = {
      status: status,
      source: html ? source : 'unavailable',
      lastChecked: new Date().toISOString()
    };
  }

  // Update cache
  statusCache = {
    lastUpdated: now,
    statuses: statuses
  };

  return statuses;
}

// Historical data for pattern-based predictions
const historicalData = require('./historicalData.json');

// Categorize a weather event based on snowfall and type
function categorizeEvent(snow, type) {
  const typeLower = (type || '').toLowerCase();
  if (typeLower.includes('ice') || typeLower.includes('freezing')) return 'ice';
  if (snow >= 3) return 'heavy-snow';
  if (snow >= 1) return 'light-snow';
  if (typeLower.includes('snow') || typeLower.includes('flurr')) return 'light-snow';
  return 'cold-only';
}

// Find similar historical days and calculate outcome rates
function getHistoricalPrediction(temperature, feelsLike, snowfall, weatherType) {
  if (!historicalData || historicalData.length === 0) return null;

  const currentCategory = categorizeEvent(snowfall, weatherType);

  // Score each historical record by similarity to current conditions
  const scored = historicalData.map(record => {
    let similarity = 0;

    const recordCategory = categorizeEvent(record.snowfall, record.type);

    // DISQUALIFY: If snowfall difference is too large (>5 inches), skip this record
    // A day with 0" snow should never match a day with 6"+ snow
    const snowDiff = Math.abs(record.snowfall - snowfall);
    if (snowDiff > 5) {
      return { ...record, similarity: 0, disqualified: true };
    }

    // Category matching - critical for finding truly similar days
    if (currentCategory === recordCategory) {
      similarity += 4; // Bonus for matching category
    } else if (
      (currentCategory === 'cold-only' && recordCategory === 'heavy-snow') ||
      (currentCategory === 'heavy-snow' && recordCategory === 'cold-only')
    ) {
      // Completely different event types - strong penalty
      similarity -= 6;
    } else {
      // Adjacent categories (e.g., cold-only vs light-snow) - moderate penalty
      similarity -= 2;
    }

    // Temperature similarity (within 10°F = good match)
    const tempDiff = Math.abs(record.temperature - temperature);
    if (tempDiff <= 5) similarity += 3;
    else if (tempDiff <= 10) similarity += 2;
    else if (tempDiff <= 15) similarity += 1;

    // Feels-like similarity
    const feelsDiff = Math.abs(record.feelsLike - feelsLike);
    if (feelsDiff <= 5) similarity += 3;
    else if (feelsDiff <= 10) similarity += 2;
    else if (feelsDiff <= 15) similarity += 1;

    // Snowfall similarity - stricter scoring
    if (snowDiff <= 0.5) similarity += 4;
    else if (snowDiff <= 1) similarity += 3;
    else if (snowDiff <= 2) similarity += 2;
    else if (snowDiff <= 3) similarity += 1;
    // No points for snowDiff > 3

    // Weather type match (reduced weight since category matching handles this)
    const currentType = (weatherType || '').toLowerCase();
    const recordType = (record.type || '').toLowerCase();
    if (currentType && recordType && currentType === recordType) similarity += 2;
    else if (currentType && recordType &&
             (currentType.includes(recordType) || recordType.includes(currentType))) similarity += 1;

    return { ...record, similarity };
  });

  // Filter to reasonably similar days (similarity >= 5) and not disqualified
  const similar = scored.filter(r => !r.disqualified && r.similarity >= 5)
                        .sort((a, b) => b.similarity - a.similarity);

  if (similar.length === 0) return null;

  // Take the top matches (up to 8)
  const matches = similar.slice(0, 8);

  const closedCount = matches.filter(r => r.status === 'closed').length;
  const delayCount = matches.filter(r => r.status === 'delay').length;
  const totalDisruptions = closedCount + delayCount;
  const disruptionRate = Math.round((totalDisruptions / matches.length) * 100);
  const closureRate = Math.round((closedCount / matches.length) * 100);
  const delayRate = Math.round((delayCount / matches.length) * 100);

  return {
    matchCount: matches.length,
    closedCount,
    delayCount,
    disruptionRate,
    closureRate,
    delayRate,
    topMatches: matches.slice(0, 3).map(m => ({
      date: m.date,
      status: m.status,
      temperature: m.temperature,
      feelsLike: m.feelsLike,
      snowfall: m.snowfall,
      type: m.type
    }))
  };
}

// Get historical prediction for a specific school
function getSchoolHistoricalPrediction(schoolName, temperature, feelsLike, snowfall, weatherType) {
  if (!historicalData || historicalData.length === 0) return null;

  // Filter historical data for this specific school
  const schoolData = historicalData.filter(r => r.school === schoolName);
  if (schoolData.length === 0) return null;

  const currentCategory = categorizeEvent(snowfall, weatherType);

  // Score each historical record by similarity to current conditions
  const scored = schoolData.map(record => {
    let similarity = 0;

    const recordCategory = categorizeEvent(record.snowfall, record.type);

    // DISQUALIFY: If snowfall difference is too large (>5 inches), skip this record
    const snowDiff = Math.abs(record.snowfall - snowfall);
    if (snowDiff > 5) {
      return { ...record, similarity: 0, disqualified: true };
    }

    // Category matching
    if (currentCategory === recordCategory) {
      similarity += 4;
    } else if (
      (currentCategory === 'cold-only' && recordCategory === 'heavy-snow') ||
      (currentCategory === 'heavy-snow' && recordCategory === 'cold-only')
    ) {
      similarity -= 6;
    } else {
      similarity -= 2;
    }

    // Temperature similarity
    const tempDiff = Math.abs(record.temperature - temperature);
    if (tempDiff <= 5) similarity += 3;
    else if (tempDiff <= 10) similarity += 2;
    else if (tempDiff <= 15) similarity += 1;

    // Feels-like similarity
    const feelsDiff = Math.abs(record.feelsLike - feelsLike);
    if (feelsDiff <= 5) similarity += 3;
    else if (feelsDiff <= 10) similarity += 2;
    else if (feelsDiff <= 15) similarity += 1;

    // Snowfall similarity
    if (snowDiff <= 0.5) similarity += 4;
    else if (snowDiff <= 1) similarity += 3;
    else if (snowDiff <= 2) similarity += 2;
    else if (snowDiff <= 3) similarity += 1;

    // Weather type match
    const currentType = (weatherType || '').toLowerCase();
    const recordType = (record.type || '').toLowerCase();
    if (currentType && recordType && currentType === recordType) similarity += 2;
    else if (currentType && recordType &&
             (currentType.includes(recordType) || recordType.includes(currentType))) similarity += 1;

    return { ...record, similarity };
  });

  // Filter to reasonably similar days
  const similar = scored.filter(r => !r.disqualified && r.similarity >= 5)
                        .sort((a, b) => b.similarity - a.similarity);

  if (similar.length === 0) return null;

  // Take up to 5 matches for per-school (fewer records available)
  const matches = similar.slice(0, 5);

  const closedCount = matches.filter(r => r.status === 'closed').length;
  const delayCount = matches.filter(r => r.status === 'delay').length;
  const totalDisruptions = closedCount + delayCount;

  return {
    matchCount: matches.length,
    closedCount,
    delayCount,
    closureRate: Math.round((closedCount / matches.length) * 100),
    delayRate: Math.round((delayCount / matches.length) * 100),
    disruptionRate: Math.round((totalDisruptions / matches.length) * 100)
  };
}

// Weather condition thresholds for school delays
const THRESHOLDS = {
  // Temperature thresholds (Fahrenheit)
  extremeCold: -10,        // Wind chill below this = likely closure
  veryCold: 0,             // Wind chill below this = possible delay
  cold: 10,                // Wind chill below this = monitor

  // Snow thresholds (inches)
  heavySnow: 6,            // 6+ inches = likely closure
  moderateSnow: 3,         // 3-6 inches = likely delay
  lightSnow: 1,            // 1-3 inches = possible delay

  // Wind thresholds (mph)
  highWind: 40,            // High winds = increased risk

  // Ice accumulation (inches)
  iceAccumulation: 0.1     // Any ice = high risk
};

function calculateDelayProbability(currentConditions, forecast, hourlyForecast, alerts) {
  let probability = 0;
  let factors = [];

  // Check for active winter weather alerts
  if (alerts && alerts.length > 0) {
    const winterAlerts = alerts.filter(alert => {
      const event = (alert.event || '').toLowerCase();
      return event.includes('winter') ||
             event.includes('snow') ||
             event.includes('ice') ||
             event.includes('blizzard') ||
             event.includes('freeze') ||
             event.includes('cold');
    });

    if (winterAlerts.length > 0) {
      winterAlerts.forEach(alert => {
        const severity = (alert.severity || '').toLowerCase();
        if (severity === 'extreme') {
          probability += 50;
          factors.push({ factor: `${alert.event} (Extreme)`, impact: +50 });
        } else if (severity === 'severe') {
          probability += 40;
          factors.push({ factor: `${alert.event} (Severe)`, impact: +40 });
        } else if (severity === 'moderate') {
          probability += 25;
          factors.push({ factor: `${alert.event}`, impact: +25 });
        } else {
          probability += 15;
          factors.push({ factor: `${alert.event}`, impact: +15 });
        }
      });
    }
  }

  // Analyze current temperature
  if (currentConditions && currentConditions.temperature) {
    const tempF = currentConditions.temperature.fahrenheit;
    const windMph = currentConditions.windSpeed?.mph || 0;

    // Calculate wind chill (simplified formula)
    let windChill = tempF;
    if (tempF <= 50 && windMph > 3) {
      windChill = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) + (0.4275 * tempF * Math.pow(windMph, 0.16));
      windChill = Math.round(windChill);
    }

    if (windChill <= THRESHOLDS.extremeCold) {
      probability += 40;
      factors.push({ factor: `Extreme cold (wind chill ${windChill}°F)`, impact: +40 });
    } else if (windChill <= THRESHOLDS.veryCold) {
      probability += 25;
      factors.push({ factor: `Very cold (wind chill ${windChill}°F)`, impact: +25 });
    } else if (windChill <= THRESHOLDS.cold) {
      probability += 10;
      factors.push({ factor: `Cold temperatures (wind chill ${windChill}°F)`, impact: +10 });
    }
  }

  // Analyze forecast for snow/ice keywords
  if (forecast && forecast.periods && forecast.periods.length > 0) {
    // Look at tonight and tomorrow morning periods
    const relevantPeriods = forecast.periods.slice(0, 4);

    relevantPeriods.forEach(period => {
      const desc = (period.detailedForecast || period.shortForecast || '').toLowerCase();

      // Check for snow amounts
      const snowMatch = desc.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
      if (snowMatch) {
        const snowAmount = snowMatch[2] ? parseInt(snowMatch[2]) : parseInt(snowMatch[1]);
        if (snowAmount >= THRESHOLDS.heavySnow) {
          probability += 45;
          factors.push({ factor: `Heavy snow forecast (${snowAmount}+ inches)`, impact: +45 });
        } else if (snowAmount >= THRESHOLDS.moderateSnow) {
          probability += 30;
          factors.push({ factor: `Moderate snow forecast (${snowAmount} inches)`, impact: +30 });
        } else if (snowAmount >= THRESHOLDS.lightSnow) {
          probability += 15;
          factors.push({ factor: `Light snow forecast (${snowAmount} inches)`, impact: +15 });
        }
      }

      // Check for ice/freezing rain
      if (desc.includes('ice') || desc.includes('freezing rain') || desc.includes('sleet')) {
        probability += 35;
        factors.push({ factor: 'Ice/freezing rain in forecast', impact: +35 });
      }

      // Check for general snow mention without amounts
      if (!snowMatch && (desc.includes('snow') || desc.includes('flurries'))) {
        if (desc.includes('heavy')) {
          probability += 25;
          factors.push({ factor: 'Heavy snow mentioned', impact: +25 });
        } else if (desc.includes('light') || desc.includes('flurries')) {
          probability += 5;
          factors.push({ factor: 'Light snow/flurries possible', impact: +5 });
        } else {
          probability += 15;
          factors.push({ factor: 'Snow in forecast', impact: +15 });
        }
      }
    });
  }

  // Historical pattern analysis
  let historicalMatch = null;
  if (currentConditions && currentConditions.temperature) {
    const tempF = currentConditions.temperature.fahrenheit;
    const windMph = currentConditions.windSpeed?.mph || 0;
    let windChill = tempF;
    if (tempF <= 50 && windMph > 3) {
      windChill = 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16)) + (0.4275 * tempF * Math.pow(windMph, 0.16));
      windChill = Math.round(windChill);
    }

    // Determine snowfall estimate from forecast text
    let snowEstimate = 0;
    let weatherType = '';
    if (forecast && forecast.periods) {
      const relevantText = forecast.periods.slice(0, 4)
        .map(p => (p.detailedForecast || p.shortForecast || '').toLowerCase()).join(' ');
      const snowMatch = relevantText.match(/(\d+)\s*(?:to\s*(\d+))?\s*inch/);
      if (snowMatch) snowEstimate = snowMatch[2] ? parseInt(snowMatch[2]) : parseInt(snowMatch[1]);
      if (relevantText.includes('ice') || relevantText.includes('freezing rain')) weatherType = 'ice';
      else if (relevantText.includes('snow')) weatherType = 'snow';
      else if (windChill <= 10) weatherType = 'frigid temperature';
    }

    historicalMatch = getHistoricalPrediction(tempF, windChill, snowEstimate, weatherType);

    if (historicalMatch) {
      // Blend historical data with threshold-based probability
      // Weight: 40% historical, 60% threshold-based
      const historicalProb = historicalMatch.disruptionRate;
      probability = Math.round((probability * 0.6) + (historicalProb * 0.4));
      factors.push({
        factor: `Historical pattern (${historicalMatch.matchCount} similar days: ${historicalMatch.closedCount} closed, ${historicalMatch.delayCount} delayed)`,
        impact: Math.round(historicalProb * 0.4)
      });
    }
  }

  // Cap probability at 95% (never 100% certain)
  probability = Math.min(probability, 95);

  // Calculate separate delay and closure probabilities based on historical patterns
  let delayProbability, closureProbability;
  if (historicalMatch && historicalMatch.disruptionRate > 0) {
    // Split the probability based on historical closure vs delay rates
    const closureRatio = historicalMatch.closureRate / historicalMatch.disruptionRate;
    const delayRatio = historicalMatch.delayRate / historicalMatch.disruptionRate;
    closureProbability = Math.round(probability * closureRatio);
    delayProbability = Math.round(probability * delayRatio);
  } else {
    // No historical data - use heuristics based on severity
    // Higher probabilities lean toward closure, lower toward delay
    if (probability >= 70) {
      closureProbability = Math.round(probability * 0.6);
      delayProbability = Math.round(probability * 0.4);
    } else if (probability >= 40) {
      closureProbability = Math.round(probability * 0.4);
      delayProbability = Math.round(probability * 0.6);
    } else {
      closureProbability = Math.round(probability * 0.3);
      delayProbability = Math.round(probability * 0.7);
    }
  }

  // Determine status based on which outcome is more likely
  let status, recommendation;
  if (probability >= 70) {
    status = 'high';
    recommendation = closureProbability > delayProbability
      ? 'High likelihood of closure. Monitor local announcements closely.'
      : 'High likelihood of delay or closure. Monitor local announcements.';
  } else if (probability >= 40) {
    status = 'moderate';
    recommendation = 'Moderate chance of delay. Check school district communications.';
  } else if (probability >= 15) {
    status = 'low';
    recommendation = 'Low chance of delay. Normal schedule expected.';
  } else {
    status = 'minimal';
    recommendation = 'No significant weather concerns. Normal schedule expected.';
  }

  // Remove duplicate factors
  const uniqueFactors = factors.filter((f, i, arr) =>
    arr.findIndex(x => x.factor === f.factor) === i
  );

  return {
    probability,
    delayProbability,
    closureProbability,
    status,
    recommendation,
    factors: uniqueFactors,
    historicalMatch,
    schools: INDIANA_COUNTY_SCHOOLS,
    disclaimer: 'This is an estimate based on weather conditions and historical patterns. Always check official school district announcements for actual delay/closure information.'
  };
}

// Map school codes to names used in historical data
const SCHOOL_CODE_TO_HISTORICAL_NAME = {
  'IASD': 'Indiana',
  'HCSD': 'Homer-Center',
  'MCASD': 'Marion Center',
  'PMASD': 'Penns Manor',
  'PLSD': 'Purchase Line',
  'USD': 'United'
};

module.exports = {
  calculateDelayProbability,
  getSchoolStatuses,
  getSchoolHistoricalPrediction,
  INDIANA_COUNTY_SCHOOLS,
  SCHOOL_CODE_TO_HISTORICAL_NAME
};
