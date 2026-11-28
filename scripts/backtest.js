#!/usr/bin/env node
/**
 * Backtest: replay the school prediction model against what actually happened.
 *
 * Run this before and after changing a weight in api/_lib/features.js or
 * api/_lib/schoolDelay.js. For each past school morning it rebuilds the inputs
 * the model would have had at a chosen hour the day before, from archives kept
 * by the Iowa Environmental Mesonet, runs the real feature and scoring code on
 * them, and scores the result against the recorded school statuses.
 *
 * Inputs replayed
 *   - NWS alerts for Indiana County that had been issued by forecast time.
 *   - The NWS National Blend of Models bulletin for the Indiana County airport
 *     that was available at forecast time: six-hourly snow and ice amounts,
 *     temperature and wind. The live model reads the same quantities from the
 *     NWS forecast grid, per district.
 *   - Where no bulletin is archived for a morning, the airport's observed 5-9 AM
 *     wind chill stands in for the forecast, and snow and ice are left out.
 *
 * What this cannot tell you
 *   - It is one forecast point for the whole county, and it has no forecast of
 *     what is falling at bus time, so it is close to the live model, not equal.
 *   - Alert start and end times are the archive's final ones. An advisory that
 *     was later extended, cut short or cancelled is replayed as it ended up,
 *     not as it stood at forecast time. In a check of 1,232 zone-mornings this
 *     changed 8 calls.
 *   - Before 2026-02-26 the history lists disruptions but not open days, so for
 *     those winters a call with no recorded disruption may be a false alarm, a
 *     day off, or a disruption nobody wrote down.
 *
 * Usage
 *   node scripts/backtest.js                      # forecasts at 10 AM and 9 PM the day before
 *   node scripts/backtest.js --forecast-hour 15   # one hour (Eastern, the day before), 0-23
 *   node scripts/backtest.js --refresh            # re-download the archives
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = name => require(path.join(__dirname, '..', 'api', '_lib', name));
const { buildFeatures, selectAlerts, getWindows } = lib('features');
const { scoreDisruption, isNonWeatherRecord, INDIANA_COUNTY_SCHOOLS } = lib('schoolDelay');
const { getScorableEntries, loadHistoricalData, tally, SCHOOL_CODE_TO_NAME } = lib('weatherLogger');
const { easternToMs, addDays, dayOfWeek } = lib('easternTime');
const { getNonSchoolReason } = lib('schoolCalendar');
const { calculateWindChill } = lib('noaa');

const ARCHIVE = 'https://mesonet.agron.iastate.edu';
const ARCHIVE_START = '2020-11-01';
const CACHE_DIR = path.join(os.tmpdir(), 'school-forecast-backtest');
const CACHE_HOURS = 12;
const HOUR = 60 * 60 * 1000;

// Nearly every scheduled weekday has been logged since this date. Before it,
// the history only lists days that had a disruption.
const COMPLETE_LOGGING_SINCE = '2026-02-26';

// The history has only a handful of records before the 2023-24 winter
const FIRST_SEASON_WITH_HISTORY = 2023;

// The old logger filed the next day's forecast at about this hour (Eastern)
// through spring 2026; the evening hour is what people look at the night before.
const MORNING_BEFORE = 10;
const EVENING_BEFORE = 21;

// Blend bulletins are issued for these UTC hours and are usable about an hour
// and a half later.
const BLEND_RUN_HOURS = [1, 7, 13, 19];
const BLEND_LAG_MS = 90 * 60 * 1000;

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
let forecastHours = [MORNING_BEFORE, EVENING_BEFORE];
if (args.includes('--forecast-hour')) {
  const hour = Number(args[args.indexOf('--forecast-hour') + 1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    console.error('--forecast-hour needs a whole hour from 0 to 23 (Eastern, the day before).');
    process.exit(1);
  }
  forecastHours = [hour];
}

// --- Archives ------------------------------------------------------------------

// Fetch a URL through a file cache. Returns null when the archive has nothing
// (HTTP 404), which is remembered too. Data for dates long past never changes,
// so only `fresh: true` downloads are re-fetched after CACHE_HOURS.
async function download(name, url, { fresh = false } = {}) {
  const file = path.join(CACHE_DIR, name);
  const cached = fs.existsSync(file);
  const stale = cached && fresh && (Date.now() - fs.statSync(file).mtimeMs) > CACHE_HOURS * HOUR;
  if (!cached || stale || refresh) {
    const response = await fetch(url, { headers: { 'User-Agent': 'school-forecast-backtest/1.0' } });
    if (!response.ok && response.status !== 404) throw new Error(`${name}: HTTP ${response.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, response.ok ? await response.text() : '');
  }
  const text = fs.readFileSync(file, 'utf8');
  return text === '' ? null : text;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

// Alerts in the shape getAlerts() returns, plus when each was first issued
async function loadAlerts() {
  const tomorrow = addDays(todayUtc(), 1);
  const sources = [
    ['PAZ077', ['PAZ077']],
    ['PAZ078', ['PAZ078']],
    ['PAZ023', ['PAZ077', 'PAZ078']],  // one zone covered the whole county until 2023
    ['PAC063', ['PAC063']]             // county-based products such as snow squall warnings
  ];
  const alerts = [];
  for (const [ugc, zones] of sources) {
    const text = await download(`alerts_${ugc}.json`,
      `${ARCHIVE}/json/vtec_events_byugc.py?ugc=${ugc}&sdate=${ARCHIVE_START}&edate=${tomorrow}`, { fresh: true });
    for (const event of JSON.parse(text || '{}').events || []) {
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
  const [y2, m2, d2] = addDays(todayUtc(), 1).split('-').map(Number);
  const text = await download('observations_IDI.csv',
    `${ARCHIVE}/cgi-bin/request/asos.py?station=IDI&data=tmpf&data=sknt` +
    `&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    '&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4', { fresh: true });
  return (text || '').trim().split('\n').slice(1)
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

// The newest blend bulletin that was usable at a given moment (epoch ms of its run)
function blendRunFor(forecastMs) {
  const usableBy = forecastMs - BLEND_LAG_MS;
  const day = new Date(usableBy);
  for (let back = 0; back < 2; back++) {
    for (const hour of [...BLEND_RUN_HOURS].reverse()) {
      const run = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - back, hour);
      if (run <= usableBy) return run;
    }
  }
  return null;
}

// One blend bulletin as a forecast grid in the shape getGridForecast() returns
// (inches, deg F), or null when the archive does not hold that run.
// Bulletin units: snow in tenths of an inch per 6 hours, ice in hundredths,
// temperature in deg F, wind in knots.
async function loadBlend(runMs) {
  const iso = new Date(runMs).toISOString();
  const text = await download(path.join('blend', `${iso.slice(0, 13)}.json`),
    `${ARCHIVE}/api/1/mos.json?station=KIDI&model=NBS&runtime=${iso.slice(0, 19)}Z`);
  const rows = text ? (JSON.parse(text).data || []) : [];
  if (rows.length === 0) return null;

  const series = { snowfallAmount: [], iceAccumulation: [], temperature: [], windChill: [], apparentTemperature: [], weather: [] };
  for (const row of rows) {
    const at = Date.parse(`${row.ftime_utc}Z`);
    if (!Number.isFinite(at)) continue;
    if (row.s06 != null) series.snowfallAmount.push({ start: at - 6 * HOUR, end: at, value: row.s06 / 10 });
    if (row.i06 != null) series.iceAccumulation.push({ start: at - 6 * HOUR, end: at, value: row.i06 / 100 });
    if (row.tmp != null) {
      // Three-hourly values: each stands for the hour and a half either side
      const span = { start: at - 1.5 * HOUR, end: at + 1.5 * HOUR };
      const chill = calculateWindChill(row.tmp, row.wsp != null ? row.wsp * 1.15078 : null);
      series.temperature.push({ ...span, value: row.tmp });
      series.windChill.push({ ...span, value: chill });
      series.apparentTemperature.push({ ...span, value: chill });
    }
  }
  return { updated: iso, series };
}

// --- Replay ----------------------------------------------------------------------

function makeReplay(alerts, observations) {
  const morningCache = new Map();

  // Low temperature and wind chill between 5 and 9 AM Eastern, as observed
  function observedMorning(date) {
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
  // `forecastHour` Eastern the day before with what was available then.
  return async function replay(date, zones, forecastHour) {
    const madeAt = easternToMs(addDays(date, -1), forecastHour);
    const run = blendRunFor(madeAt);
    const blend = run === null ? null : await loadBlend(run);

    const features = buildFeatures({
      targetDate: date,
      grid: blend,
      alerts: alerts.filter(a => a.issuedAt <= madeAt),
      zones,
      now: new Date(madeAt)
    });

    // No bulletin archived: fall back to the observed morning cold
    if (!blend) {
      const observed = observedMorning(date);
      if (observed) Object.assign(features, observed);
    }
    return { ...scoreDisruption(features), features, hadForecast: Boolean(blend) };
  };
}

// Run tasks a few at a time, so the first (uncached) run does not flood the archive
async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

// --- Report ----------------------------------------------------------------------

function hourLabel(hour) {
  return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'} the day before`;
}

function scoreLine(label, score) {
  const rate = score.disruptions ? `${Math.round(100 * score.caught / score.disruptions)}%` : 'n/a';
  return `  ${label.padEnd(42)} caught ${score.caught}/${score.disruptions} (${rate})` +
    `   false alarms ${score.falseAlarms}   quiet days right ${score.quietDaysCorrect}` +
    `   Brier ${score.brier} (skill ${score.brierSkill})`;
}

async function main() {
  const [alerts, observations] = await Promise.all([loadAlerts(), loadObservations()]);
  const replay = makeReplay(alerts, observations);

  const zonesFor = Object.fromEntries(INDIANA_COUNTY_SCHOOLS.map(s => [SCHOOL_CODE_TO_NAME[s.code], s.zones]));
  const history = loadHistoricalData().map(r => ({ ...r, school: r.school === 'Homer Center' ? 'Homer-Center' : r.school }));
  const evening = forecastHours[forecastHours.length - 1];

  // Replay a list of { date, school, ... } rows at one forecast hour
  const replayRows = (rows, hour) => mapLimited(rows, 6, async row => {
    const result = await replay(row.date, zonesFor[row.school], hour);
    return { ...row, predictedDisruption: result.predictedDisruption, probability: result.probability, result };
  });
  const coverage = rows => {
    const dates = new Map(rows.map(r => [r.date, r.result.hadForecast]));
    const withForecast = [...dates.values()].filter(Boolean).length;
    return `archived forecast for ${withForecast} of ${dates.size} mornings` +
      (withForecast < dates.size ? '; the rest use alerts and observed cold only' : '');
  };

  // 1. The district school days already scored in the live prediction log
  const scored = getScorableEntries();
  if (scored.length > 0) {
    console.log(`1. LIVE PREDICTION LOG, ${scored[0].date} to ${scored[scored.length - 1].date} (${scored.length} district school days)`);
    console.log(scoreLine('As logged at the time', tally(scored)));
    const byHour = {};
    for (const hour of forecastHours) {
      byHour[hour] = await replayRows(scored, hour);
      console.log(scoreLine(`Current model, ${hourLabel(hour)}`, tally(byHour[hour])));
    }
    console.log(`  (${coverage(byHour[evening])}.)`);

    console.log('\n  Mornings with a recorded weather delay or closure:');
    for (const date of [...new Set(scored.filter(e => e.actualStatus !== 'open').map(e => e.date))]) {
      const entries = scored.filter(e => e.date === date);
      const logged = entries[0].probability ?? (entries[0].delayProbability + entries[0].closureProbability);
      console.log(`  ${date}  ${[...new Set(entries.map(e => e.actualStatus))].join(', ')}  |  logged ${logged}%`);
      for (const hour of forecastHours) {
        const result = (await replay(date, zonesFor.Indiana, hour));
        console.log(`      ${hourLabel(hour).padEnd(22)} ${String(result.probability).padStart(2)}%  ${result.factors.map(f => f.factor).join('; ') || 'nothing in the forecast yet'}`);
      }
    }

    const opportunities = new Set(byHour[evening].filter(r => r.probability > 0).map(r => r.date)).size;
    const dates = new Set(scored.map(e => e.date)).size;
    console.log(`\n  Read this with care: the replay gave any chance above 0% on ${opportunities} of ${dates} dates,`);
    console.log('  so "false alarms 0" was barely tested, and the caught count rests on the mornings listed above.\n');
  }

  // 2. Every logged school day, including Mondays the original logger skipped
  const logged = history.filter(r => r.date >= COMPLETE_LOGGING_SINCE &&
    !getNonSchoolReason(r.date, r.school) && !isNonWeatherRecord(r))
    .map(r => ({ date: r.date, school: r.school, actualStatus: r.status }));
  const loggedReplay = await replayRows(logged, evening);
  console.log(`2. EVERY RECORDED SCHOOL DAY since ${COMPLETE_LOGGING_SINCE} (${logged.length} district school days on ${new Set(logged.map(r => r.date)).size} dates)`);
  console.log(scoreLine(`Current model, ${hourLabel(evening)}`, tally(loggedReplay)));
  console.log(`  (${coverage(loggedReplay)}.)`);
  const missed = loggedReplay.filter(e => !e.predictedDisruption && e.actualStatus !== 'open');
  const falseAlarms = loggedReplay.filter(e => e.predictedDisruption && e.actualStatus === 'open');
  if (missed.length) console.log(`  missed: ${missed.map(e => `${e.date} ${e.school} (${e.actualStatus}, ${e.probability}%)`).join('; ')}`);
  if (falseAlarms.length) console.log(`  false alarms: ${[...new Set(falseAlarms.map(e => `${e.date} (${e.probability}%)`))].join(', ')}`);
  console.log('');

  // 3. Older history: only disruptions were written down, so only "would it
  //    have been called?" can be asked, not "how many false alarms?"
  const older = history.filter(r => r.date < COMPLETE_LOGGING_SINCE && r.status !== 'open' &&
    !isNonWeatherRecord(r) && dayOfWeek(r.date) !== 0 && dayOfWeek(r.date) !== 6)
    .map(r => ({ date: r.date, school: r.school, actualStatus: r.status, record: r }));
  const olderReplay = await replayRows(older, evening);
  const called = olderReplay.filter(x => x.predictedDisruption).length;
  console.log(`3. OLDER HISTORY before ${COMPLETE_LOGGING_SINCE} (${older.length} recorded disruptions on ${new Set(older.map(r => r.date)).size} dates)`);
  console.log(`  Current model, ${hourLabel(evening)}, would have called ${called} of ${older.length} (${Math.round(100 * called / older.length)}%).`);
  console.log(`  (${coverage(olderReplay)}.) Not called:`);
  const listed = new Set();
  for (const row of olderReplay.filter(x => !x.predictedDisruption)) {
    if (listed.has(row.date)) continue;
    listed.add(row.date);
    const f = row.result.features;
    const seen = [
      f.snowOvernightIn != null ? `${f.snowOvernightIn}" snow` : null,
      f.iceIn ? `${f.iceIn}" ice` : null,
      f.minWindChillF != null ? `wind chill ${f.minWindChillF}°F` : null,
      f.alerts.length ? f.alerts.map(a => `${a.event} (${a.timing})`).join(', ') : 'no alert'
    ].filter(Boolean).join(', ');
    console.log(`    ${row.date}  ${row.actualStatus.padEnd(16)} ${String(row.probability).padStart(2)}%  forecast: ${seen}; recorded as ${row.record.type}, ${row.record.snowfall}" snow`);
  }
  console.log('');

  // 4. How often the model would have raised its hand in past winters
  console.log(`4. PAST WINTERS (Nov-Mar school days), Indiana zone, forecast at ${hourLabel(evening)}`);
  const lastDate = todayUtc();
  const totals = { days: 0, calls: 0, confirmed: 0, alertMornings: 0, alertConfirmed: 0 };
  for (let year = FIRST_SEASON_WITH_HISTORY; `${year}-11-01` <= lastDate; year++) {
    const end = `${year + 1}-03-31` < lastDate ? `${year + 1}-03-31` : lastDate;
    const mornings = [];
    for (let date = `${year}-11-01`; date <= end; date = addDays(date, 1)) {
      if (!getNonSchoolReason(date)) mornings.push({ date, school: 'Indiana' });
    }
    const season = await replayRows(mornings, evening);
    const disrupted = date => history.some(r => r.date === date && r.status !== 'open' && !isNonWeatherRecord(r));
    const calls = season.filter(r => r.predictedDisruption);
    const confirmed = calls.filter(r => disrupted(r.date));
    const unconfirmed = calls.filter(r => !disrupted(r.date));
    // Mornings with an advisory or warning in effect for the bus run, whatever the model made of them
    const alertMornings = mornings.filter(m =>
      selectAlerts(alerts, getWindows(m.date), zonesFor.Indiana).some(a => a.timing === 'bus-time' && a.level !== 'watch' && a.kind !== 'squall'));
    totals.days += mornings.length;
    totals.calls += calls.length;
    totals.confirmed += confirmed.length;
    totals.alertMornings += alertMornings.length;
    totals.alertConfirmed += alertMornings.filter(m => disrupted(m.date)).length;
    console.log(`  ${year}-${String(year + 1).slice(2)}: ${mornings.length} school days, ${calls.length} called, ${confirmed.length} with a recorded disruption` +
      (unconfirmed.length ? `, ${unconfirmed.length} without (${unconfirmed.map(r => `${r.date} ${r.probability}%`).join(', ')})` : '') +
      `  [${coverage(season)}]`);
  }
  console.log(`  All: ${totals.days} school days, ${totals.calls} called, ${totals.confirmed} with a recorded disruption.`);
  console.log(`  Mornings with a winter advisory or warning in effect for the bus run: ${totals.alertMornings}, of which ${totals.alertConfirmed} have a recorded disruption.`);
  console.log(`  Before ${COMPLETE_LOGGING_SINCE} a call "without" a recorded disruption may be a false alarm,`);
  console.log('  a day off, or a disruption nobody wrote down.');
}

main().catch(error => {
  console.error('Backtest failed:', error.message);
  process.exit(1);
});
