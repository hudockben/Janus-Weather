#!/usr/bin/env node
/**
 * Backtest: replay the school prediction model against what actually happened.
 *
 * Run this before and after changing any weight in api/_lib/features.js or
 * api/_lib/schoolDelay.js. It rebuilds each past forecast from independent
 * archives and scores it against the recorded school statuses:
 *
 *   - NWS alerts for Indiana County exactly as issued, limited to what had been
 *     issued by forecast time (Iowa Environmental Mesonet VTEC archive)
 *   - the 5-9 AM low wind chill at the Indiana County airport, standing in for
 *     the wind chill forecast (IEM ASOS archive)
 *
 * Forecast snow and ice amounts are not archived anywhere, so they are left
 * out. The live model also uses them, which makes this replay the model at its
 * weakest: a storm it catches here on the alert alone, it catches live.
 *
 * Usage:
 *   node scripts/backtest.js                      # forecast as of 9 PM the evening before
 *   node scripts/backtest.js --forecast-hour 15   # ... as of 3 PM the day before
 *   node scripts/backtest.js --refresh            # re-download the archives
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = name => require(path.join(__dirname, '..', 'api', '_lib', name));
const { selectAlerts, getWindows } = lib('features');
const { scoreDisruption, isNonWeatherRecord, INDIANA_COUNTY_SCHOOLS } = lib('schoolDelay');
const { getScorableEntries, loadHistoricalData, tally, SCHOOL_CODE_TO_NAME } = lib('weatherLogger');
const { easternToMs, addDays, dayOfWeek } = lib('easternTime');
const { getNonSchoolReason } = lib('schoolCalendar');
const { calculateWindChill } = lib('noaa');

const ARCHIVE = 'https://mesonet.agron.iastate.edu';
const ARCHIVE_START = '2020-11-01';
const CACHE_DIR = path.join(os.tmpdir(), 'school-forecast-backtest');
const CACHE_HOURS = 12;

// Every scheduled weekday has been logged since this date. Before it, the
// history only lists days that had a disruption.
const COMPLETE_LOGGING_SINCE = '2026-02-26';

// The history has only a handful of records before the 2023-24 winter
const FIRST_SEASON_WITH_HISTORY = 2023;

const args = process.argv.slice(2);
const forecastHour = args.includes('--forecast-hour') ? Number(args[args.indexOf('--forecast-hour') + 1]) : 21;
const refresh = args.includes('--refresh');

// --- Archives ------------------------------------------------------------------

async function download(name, url) {
  const file = path.join(CACHE_DIR, name);
  const fresh = fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) < CACHE_HOURS * 3600 * 1000;
  if (!fresh || refresh) {
    const response = await fetch(url, { headers: { 'User-Agent': 'school-forecast-backtest/1.0' } });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, await response.text());
  }
  return fs.readFileSync(file, 'utf8');
}

// Alerts in the shape getAlerts() returns, plus when each was first issued
async function loadAlerts() {
  const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
  const sources = [
    ['PAZ077', ['PAZ077']],
    ['PAZ078', ['PAZ078']],
    ['PAZ023', ['PAZ077', 'PAZ078']],  // one zone covered the whole county until 2023
    ['PAC063', ['PAC063']]             // county-based products such as snow squall warnings
  ];
  const alerts = [];
  for (const [ugc, zones] of sources) {
    const text = await download(`alerts_${ugc}.json`,
      `${ARCHIVE}/json/vtec_events_byugc.py?ugc=${ugc}&sdate=${ARCHIVE_START}&edate=${tomorrow}`);
    for (const event of JSON.parse(text).events || []) {
      if (!(Date.parse(event.expire) > Date.parse(event.issue))) continue; // cancelled before it began
      const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(event.product_id || '');
      alerts.push({
        event: `${event.ph_name} ${event.sig_name}`,
        onset: event.issue,
        ends: event.expire,
        zones,
        affectsIndianaCounty: true,
        issuedAt: stamp
          ? Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5])
          : Date.parse(event.issue)
      });
    }
  }
  return alerts;
}

// Airport observations, oldest first: [{ ms, tempF, windMph }]
async function loadObservations() {
  const [y1, m1, d1] = ARCHIVE_START.split('-').map(Number);
  const [y2, m2, d2] = addDays(new Date().toISOString().slice(0, 10), 1).split('-').map(Number);
  const text = await download('observations_IDI.csv',
    `${ARCHIVE}/cgi-bin/request/asos.py?station=IDI&data=tmpf&data=sknt` +
    `&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    '&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4');
  return text.trim().split('\n').slice(1)
    .map(line => {
      const [, valid, tempF, knots] = line.split(',');
      const wind = parseFloat(knots);
      return {
        ms: Date.parse(`${valid.replace(' ', 'T')}:00Z`),
        tempF: parseFloat(tempF),
        windMph: Number.isFinite(wind) ? wind * 1.15078 : null
      };
    })
    .filter(row => Number.isFinite(row.ms) && Number.isFinite(row.tempF));
}

// --- Replay ----------------------------------------------------------------------

function makeReplay(alerts, observations) {
  const morningCache = new Map();

  // Low temperature and wind chill between 5 and 9 AM Eastern
  function morning(date) {
    if (!morningCache.has(date)) {
      const [from, to] = getWindows(date).coldCheck;
      let low = 0;
      let high = observations.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (observations[mid].ms < from) low = mid + 1; else high = mid;
      }
      let minTempF = null;
      let minWindChillF = null;
      for (let i = low; i < observations.length && observations[i].ms <= to; i++) {
        const chill = calculateWindChill(observations[i].tempF, observations[i].windMph);
        if (minTempF === null || observations[i].tempF < minTempF) minTempF = observations[i].tempF;
        if (minWindChillF === null || chill < minWindChillF) minWindChillF = chill;
      }
      morningCache.set(date, minTempF === null ? null : { minTempF: Math.round(minTempF), minWindChillF });
    }
    return morningCache.get(date);
  }

  // The current model's forecast for one district and school morning, made at
  // `forecastHour` Eastern the day before with the alerts issued by then.
  return function replay(date, zones) {
    const madeAt = easternToMs(addDays(date, -1), forecastHour);
    const observed = morning(date);
    const features = {
      targetDate: date,
      snowOvernightIn: 0,
      snowSchoolDayIn: 0,
      iceIn: 0,
      commutePrecip: null,
      minTempF: observed ? observed.minTempF : null,
      minWindChillF: observed ? observed.minWindChillF : null,
      alerts: selectAlerts(alerts.filter(a => a.issuedAt <= madeAt), getWindows(date), zones)
    };
    return { ...scoreDisruption(features), features };
  };
}

// --- Report ----------------------------------------------------------------------

function printScore(label, score) {
  const rate = score.disruptions ? `${Math.round(100 * score.caught / score.disruptions)}%` : 'n/a';
  console.log(`  ${label.padEnd(34)} caught ${score.caught}/${score.disruptions} (${rate})` +
    `   false alarms ${score.falseAlarms}   quiet days right ${score.quietDaysCorrect}` +
    `   Brier ${score.brier} (skill ${score.brierSkill})`);
}

async function main() {
  const [alerts, observations] = await Promise.all([loadAlerts(), loadObservations()]);
  const replay = makeReplay(alerts, observations);

  const zonesFor = Object.fromEntries(INDIANA_COUNTY_SCHOOLS.map(s => [SCHOOL_CODE_TO_NAME[s.code], s.zones]));
  const history = loadHistoricalData().map(r => ({ ...r, school: r.school === 'Homer Center' ? 'Homer-Center' : r.school }));
  const hour = forecastHour % 12 || 12;
  const when = `${hour} ${forecastHour < 12 ? 'AM' : 'PM'} the day before`;

  console.log(`Replaying with alerts issued by ${when} + observed morning wind chill.`);
  console.log('Forecast snow and ice amounts are not archived and are left out.\n');

  // 1. The district school days already scored in the live prediction log
  const scored = getScorableEntries();
  if (scored.length > 0) {
    console.log(`1. LIVE PREDICTION LOG, ${scored[0].date} to ${scored[scored.length - 1].date} (${scored.length} district school days)`);
    printScore('As logged at the time', tally(scored));
    printScore('Current model, replayed', tally(scored.map(entry => {
      const result = replay(entry.date, zonesFor[entry.school]);
      return { ...entry, predictedDisruption: result.predictedDisruption, probability: result.probability };
    })));
    console.log('  (A forecast that always says "open" catches 0 with 0 false alarms.)\n');

    for (const date of [...new Set(scored.filter(e => e.actualStatus !== 'open').map(e => e.date))]) {
      const entries = scored.filter(e => e.date === date);
      const result = replay(date, zonesFor.Indiana);
      const logged = entries[0].probability ?? (entries[0].delayProbability + entries[0].closureProbability);
      console.log(`  ${date}  actual: ${[...new Set(entries.map(e => e.actualStatus))].join(', ')}` +
        `  |  logged ${logged}%  |  replayed ${result.probability}%  ${result.factors.map(f => f.factor).join('; ')}`);
    }
    console.log('');
  }

  // 2. Every logged school day, including Mondays the original logger skipped
  const logged = history.filter(r => r.date >= COMPLETE_LOGGING_SINCE &&
    !getNonSchoolReason(r.date, r.school) && !isNonWeatherRecord(r));
  const loggedReplay = logged.map(r => {
    const result = replay(r.date, zonesFor[r.school]);
    return { date: r.date, school: r.school, actualStatus: r.status, predictedDisruption: result.predictedDisruption, probability: result.probability };
  });
  console.log(`2. EVERY RECORDED SCHOOL DAY since ${COMPLETE_LOGGING_SINCE} (${logged.length} district school days on ${new Set(logged.map(r => r.date)).size} dates)`);
  printScore('Current model, replayed', tally(loggedReplay));
  const missed = loggedReplay.filter(e => !e.predictedDisruption && e.actualStatus !== 'open');
  const falseAlarms = loggedReplay.filter(e => e.predictedDisruption && e.actualStatus === 'open');
  if (missed.length) console.log(`  missed: ${missed.map(e => `${e.date} ${e.school} (${e.actualStatus}, ${e.probability}%)`).join('; ')}`);
  if (falseAlarms.length) console.log(`  false alarms: ${[...new Set(falseAlarms.map(e => e.date))].join(', ')}`);
  console.log('');

  // 3. Older history: only disruptions were written down, so only "would it
  //    have been called?" can be asked, not "how many false alarms?"
  const older = history.filter(r => r.date < COMPLETE_LOGGING_SINCE && r.status !== 'open' &&
    !isNonWeatherRecord(r) && dayOfWeek(r.date) !== 0 && dayOfWeek(r.date) !== 6);
  const olderResults = older.map(r => ({ record: r, result: replay(r.date, zonesFor[r.school]) }));
  const called = olderResults.filter(x => x.result.predictedDisruption).length;
  console.log(`3. OLDER HISTORY before ${COMPLETE_LOGGING_SINCE} (${older.length} recorded disruptions on ${new Set(older.map(r => r.date)).size} dates)`);
  console.log(`  Current model would have called ${called} of ${older.length} (${Math.round(100 * called / older.length)}%). Not called:`);
  const listed = new Set();
  for (const { record, result } of olderResults.filter(x => !x.result.predictedDisruption)) {
    if (listed.has(record.date)) continue;
    listed.add(record.date);
    const observed = result.features.minTempF === null ? 'no observations'
      : `airport ${result.features.minTempF}°F, wind chill ${result.features.minWindChillF}°F`;
    console.log(`    ${record.date}  ${record.status.padEnd(16)} ${String(result.probability).padStart(2)}%  ` +
      `${observed}; alerts: ${result.features.alerts.map(a => `${a.event} (${a.timing})`).join(', ') || 'none'}; ` +
      `recorded as ${record.type}, ${record.snowfall}" snow`);
  }
  console.log('');

  // 4. How often the model would have raised its hand in past winters
  console.log('4. PAST WINTERS (Nov-Mar school days): mornings the current model would have called a disruption');
  const lastDate = new Date().toISOString().slice(0, 10);
  for (let year = FIRST_SEASON_WITH_HISTORY; `${year}-11-01` <= lastDate; year++) {
    let days = 0;
    let calls = 0;
    let confirmed = 0;
    const unconfirmed = [];
    const end = `${year + 1}-03-31` < lastDate ? `${year + 1}-03-31` : lastDate;
    for (let date = `${year}-11-01`; date <= end; date = addDays(date, 1)) {
      if (getNonSchoolReason(date)) continue;
      days++;
      const result = replay(date, zonesFor.Indiana);
      if (!result.predictedDisruption) continue;
      calls++;
      if (history.some(r => r.date === date && r.status !== 'open')) confirmed++;
      else unconfirmed.push(date);
    }
    console.log(`  ${year}-${String(year + 1).slice(2)}: ${days} school days, ${calls} called, ${confirmed} with a recorded disruption` +
      (unconfirmed.length ? `, ${unconfirmed.length} without (${unconfirmed.join(', ')})` : ''));
  }
  console.log(`  Before ${COMPLETE_LOGGING_SINCE} a call "without" a recorded disruption may be a false alarm,`);
  console.log('  a holiday, or a disruption nobody wrote down.');
}

main().catch(error => {
  console.error('Backtest failed:', error.message);
  process.exit(1);
});
