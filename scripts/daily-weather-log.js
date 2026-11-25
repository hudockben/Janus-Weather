#!/usr/bin/env node
/**
 * Daily Weather Logger Script
 *
 * Each run records today's school statuses, scores the forecast that was on
 * file for today, and saves the forecast for the next school day. It is safe
 * to run several times a day: outcomes are recorded once, and a later run
 * simply refreshes the forecast with newer data.
 *
 * Run it at least once on school-day mornings (statuses are readable from
 * 6 AM Eastern) and once in the evening (so the forecast on file is the one
 * people actually see the night before).
 *
 * Usage:
 *   node scripts/daily-weather-log.js              # Normal mode
 *   node scripts/daily-weather-log.js --force      # Also log open days outside winter
 *   node scripts/daily-weather-log.js --dry-run    # Preview without saving
 *
 * GitHub Actions: See .github/workflows/daily-weather-log.yml
 */

const path = require('path');

// Change to project root directory for proper module resolution
process.chdir(path.join(__dirname, '..'));

const { logWeatherData } = require('../api/_lib/weatherLogger');

async function main() {
  const args = process.argv.slice(2);
  const forceLog = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  console.log('='.repeat(60));
  console.log('Janus Weather - Daily Weather Logger');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Force Log: ${forceLog ? 'Yes' : 'No'}`);
  console.log('='.repeat(60));
  console.log('');

  try {
    const result = await logWeatherData({ forceLog, dryRun });

    if (result.summary && result.summary.weatherConditions) {
      const conditions = result.summary.weatherConditions;
      console.log('This Morning (5-9 AM at the Indiana County airport):');
      console.log(`  Low Temperature: ${conditions.temperature ?? 'N/A'}°F`);
      console.log(`  Low Wind Chill: ${conditions.windChill ?? 'N/A'}°F`);
      console.log(`  Winter Alerts: ${conditions.alerts && conditions.alerts.length ? conditions.alerts.join(', ') : 'None'}`);
      console.log('');
    } else {
      console.log('Weather Conditions: Unable to fetch (network error?)');
      console.log('');
    }

    if (result.logged.length > 0) {
      console.log(`Records Logged (${result.logged.length}):`);
      result.logged.forEach(record => {
        console.log(`  - ${record.school}: ${record.status} (${record.type})`);
      });
    } else {
      console.log('No records logged.');
    }
    console.log('');

    if (result.skipped.length > 0) {
      console.log(`Skipped (${result.skipped.length}):`);
      result.skipped.forEach(skip => {
        console.log(`  - ${skip.school}: ${skip.reason}`);
      });
    }
    console.log('');

    if (result.predictions) {
      const { resolved, targetDate, savedForTarget, forecast } = result.predictions;
      console.log(`Forecasts scored for today: ${resolved}`);
      console.log(`Forecast for ${targetDate} (${savedForTarget} saved):`);
      forecast.forEach(f => {
        const why = f.factors.length ? ` - ${f.factors.join('; ')}` : '';
        console.log(`  - ${f.school}: ${f.probability}% (delay ${f.delayProbability}%, closure ${f.closureProbability}%)${why}`);
      });
      console.log('');
    }

    if (result.errors.length > 0) {
      console.log('Errors:');
      result.errors.forEach(err => {
        console.log(`  - ${err.type}: ${err.message}`);
      });
      process.exit(1);
    }

    console.log('='.repeat(60));
    if (result.summary) {
      console.log(`Summary: ${result.summary.recorded} recorded, ${result.summary.skipped} skipped`);
    } else {
      console.log(`Summary: ${result.logged.length} recorded, ${result.skipped.length} skipped`);
    }
    console.log('='.repeat(60));

    process.exit(0);

  } catch (error) {
    console.error('Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
