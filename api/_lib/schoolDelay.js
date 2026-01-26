// School Delay Prediction for Indiana County, PA
// Analyzes weather conditions to estimate delay/closure probability

const INDIANA_COUNTY_SCHOOLS = [
  { name: 'Indiana Area School District', code: 'IASD' },
  { name: 'Homer-Center School District', code: 'HCSD' },
  { name: 'Blairsville-Saltsburg School District', code: 'BSSD' },
  { name: 'Marion Center Area School District', code: 'MCASD' },
  { name: 'Penns Manor Area School District', code: 'PMASD' },
  { name: 'Purchase Line School District', code: 'PLSD' },
  { name: 'United School District', code: 'USD' },
  { name: 'IUP (Indiana University of Pennsylvania)', code: 'IUP' }
];

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

  // Cap probability at 95% (never 100% certain)
  probability = Math.min(probability, 95);

  // Determine status
  let status, recommendation;
  if (probability >= 70) {
    status = 'high';
    recommendation = 'High likelihood of delay or closure. Monitor local announcements.';
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
    status,
    recommendation,
    factors: uniqueFactors,
    schools: INDIANA_COUNTY_SCHOOLS,
    disclaimer: 'This is an estimate based on weather conditions. Always check official school district announcements for actual delay/closure information.'
  };
}

module.exports = {
  calculateDelayProbability,
  INDIANA_COUNTY_SCHOOLS
};
