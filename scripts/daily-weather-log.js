#!/usr/bin/env node
/**
 * Daily Weather Logger Script
 *
 * Run this script once daily (recommended: 7-8 AM EST during school year)
 * to automatically log weather conditions and school statuses to historicalData.json
 *
 * Usage:
 *   node scripts/daily-weather-log.js              # Normal mode (log disruptions only)
 *   node scripts/daily-weather-log.js --force      # Force log even if schools are open
 *   node scripts/daily-weather-log.js --dry-run    # Preview without saving
 *
 * Scheduling Examples:
 *
 * Cron (Linux/Mac):
 *   0 7 * * 1-5 cd /path/to/Janus-Weather && node scripts/daily-weather-log.js
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
  console.log(`Force Log: ${forceLog ? 'Yes' : 'No (disruptions only)'}`);
  console.log('='.repeat(60));
  console.log('');

  try {
    const result = await logWeatherData({ forceLog, dryRun });

    if (result.summary && result.summary.weatherConditions) {
      console.log('Weather Conditions:');
      console.log(`  Temperature: ${result.summary.weatherConditions.temperature ?? 'N/A'}°F`);
      console.log(`  Wind Chill: ${result.summary.weatherConditions.windChill ?? 'N/A'}°F`);
      console.log(`  Snowfall: ${result.summary.weatherConditions.snowfall ?? 0}"`);
      console.log(`  Type: ${result.summary.weatherConditions.type || 'None'}`);
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
