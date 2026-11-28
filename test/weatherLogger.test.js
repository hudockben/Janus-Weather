const test = require('node:test');
const assert = require('node:assert/strict');
const {
  logWeatherData, loadJson, readTodayStatus, classifyCause, closurePattern, resolvePredictions, saveForecast, tally,
  getScorableEntries, getPredictionAccuracy, MODEL_VERSION
} = require('../api/_lib/weatherLogger');
const { easternToMs, addDays } = require('../api/_lib/easternTime');
const { predictAllDistricts } = require('../api/_lib/schoolDelay');
const { makeGrid, makeAlert, makeInputs } = require('./helpers');

// 2030 keeps these scenarios clear of anything in the real data files
const MONDAY = '2030-01-14';
const TUESDAY = '2030-01-15';
const WEDNESDAY = '2030-01-16';

const posted = (status, statusDate, extra = {}) => ({ status, statusDate, source: 'SchoolCast', raw: status, detail: '', ...extra });
const allSchools = info => Object.fromEntries(['IASD', 'HCSD', 'MCASD', 'PMASD', 'PLSD', 'USD'].map(code => [code, info]));

// The two log files, held in memory so staged runs can follow one another
function memoryStore(history = [], predictions = []) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const state = { history, predictions };
  return {
    state,
    loadHistoricalData: () => copy(state.history),
    saveHistoricalData: data => { state.history = copy(data); },
    loadPredictionLog: () => copy(state.predictions),
    savePredictionLog: log => { state.predictions = copy(log); }
  };
}

// Staged data sources. The station refuses any request that is not for 5-9 AM
// Eastern on the day of the run (with the gauge read from 6 PM the evening
// before), so a logger that asked about the afternoon would fail these tests.
function stagedSources({ inputs, statuses, morning }) {
  return {
    fetchForecastInputs: async () => inputs,
    getSchoolStatuses: async () => statuses,
    getObservedWindow: async (location, startMs, endMs, options = {}) => {
      const day = new Date(startMs - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const asked = new Date(startMs).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
      assert.equal(location, 'indiana');
      assert.equal(Number(asked), 5, 'observations must be requested from 5 AM Eastern');
      assert.equal(endMs - startMs, 4 * 3600 * 1000, 'observations must cover 5 to 9 AM');
      assert.equal(options.precipFromMs, easternToMs(addDays(day, -1), 18), 'the gauge is read from 6 PM the evening before');
      return morning;
    }
  };
}

// ---------- reading SchoolCast ----------

test('a status is only read for the day the page says it is for', () => {
  assert.deepEqual(readTodayStatus(posted('2-hour delay', TUESDAY), TUESDAY, 8), { status: 'delay' });
  assert.deepEqual(readTodayStatus(posted('closed', TUESDAY), TUESDAY, 13), { status: 'closed' });

  // Nothing posted since an earlier day means school is open today
  assert.deepEqual(readTodayStatus(posted('open', MONDAY), TUESDAY, 8), { status: 'open' });

  // A closure still showing from an earlier day is not today's news
  const leftover = readTodayStatus(posted('closed', MONDAY), TUESDAY, 8);
  assert.match(leftover.skip, /not confirmed for today/);
  assert.equal(leftover.problem, true);

  // By evening the page has moved on to tomorrow
  const movedOn = readTodayStatus(posted('closed', WEDNESDAY), TUESDAY, 20);
  assert.match(movedOn.skip, /already shows statuses for 2030-01-16/);
});

test('nothing is read from a page whose date cannot be read', () => {
  const undatedClosure = readTodayStatus(posted('closed', null), TUESDAY, 8);
  assert.match(undatedClosure.skip, /date could not be read/);
  assert.equal(undatedClosure.problem, true);
  // "Open" is refused too: on an undated page it may be tomorrow's status, or
  // what is left once this morning's delay has been cleared
  const undatedOpen = readTodayStatus(posted('open', null), TUESDAY, 16);
  assert.match(undatedOpen.skip, /date could not be read/);
  assert.equal(undatedOpen.problem, true);
});

test('a delay day is not turned into an open day by an undated page', async () => {
  const store = memoryStore();
  await fileStormForecast(store);

  // The page's date header has become unreadable. 7:17 AM: delays showing.
  const morning = await run(store, '2030-01-15T12:17:00Z', allSchools(posted('2-hour delay', null)));
  assert.equal(store.state.history.length, 0);
  assert.equal(morning.errors.filter(e => e.type === 'status_not_recorded').length, 6);

  // 4:17 PM: the delays have been cleared and the page shows Open
  const afternoon = await run(store, '2030-01-15T21:17:00Z', allSchools(posted('open', null)));
  assert.equal(store.state.history.length, 0);
  assert.equal(afternoon.errors.filter(e => e.type === 'status_not_recorded').length, 6);
  // The storm forecast is left unscored rather than marked a false alarm
  assert.ok(store.state.predictions.filter(e => e.date === TUESDAY).every(e => e.actualStatus === null));
});

test('statuses are not read before districts have posted, or from unreliable sources', () => {
  assert.match(readTodayStatus(posted('open', TUESDAY), TUESDAY, 4).skip, /Too early/);
  assert.match(readTodayStatus({ status: 'closed', source: 'Local Radio' }, TUESDAY, 8).skip, /No reliable status source/);
  assert.match(readTodayStatus(undefined, TUESDAY, 8).skip, /No reliable status source/);
  assert.match(readTodayStatus(posted('unknown', TUESDAY, { raw: 'See website' }), TUESDAY, 8).skip, /Unknown status "See website"/);
});

// ---------- weather or not ----------

test('a closure is set aside as non-weather only on outside facts', () => {
  const mild = { temperature: 39, feelsLike: 35, observed: true, precipIn: 0, minVisibilityMi: 10, countyAlerts: [] };

  assert.equal(classifyCause('open', mild, 'county-wide'), null);
  // Too warm for winter weather, whatever else is going on
  assert.equal(classifyCause('closed', { ...mild, temperature: 77, feelsLike: 77 }), 'non-winter');

  // All six districts closed, no alert anywhere in the county, above freezing: a day off
  assert.equal(classifyCause('closed', mild, 'county-wide'), 'non-winter');
  assert.equal(classifyCause('flexible instruction day', mild, 'county-wide'), 'non-winter');
  // One district closed or delayed while the others are open, above freezing: a local problem
  assert.equal(classifyCause('closed', mild, 'isolated'), 'non-winter');
  assert.equal(classifyCause('delay', mild, 'isolated'), 'non-winter');
  // Several districts disrupted is what weather looks like: scored, even above freezing
  assert.equal(classifyCause('closed', mild, null), null);
  assert.equal(classifyCause('delay', mild), null);
  // A winter alert for any part of the county: scored
  assert.equal(classifyCause('closed', { ...mild, countyAlerts: ['Winter Weather Advisory'] }, 'county-wide'), null);
  // A forecast temperature standing in for the airport's reading proves nothing: scored
  assert.equal(classifyCause('closed', { ...mild, observed: false }, 'county-wide'), null);
  // Rain at 39 F is still no winter weather; at 33 F something falling may be wet snow
  assert.equal(classifyCause('closed', { ...mild, precipIn: 0.3, minVisibilityMi: 2 }, 'county-wide'), 'non-winter');
  assert.equal(classifyCause('closed', { ...mild, temperature: 33, feelsLike: 27, precipIn: 0.12 }, 'county-wide'), null);
  assert.equal(classifyCause('closed', { ...mild, temperature: 33, feelsLike: 27 }, 'county-wide'), 'non-winter'); // clear and dry

  // At or below freezing it takes a clear, dry night that was not bitterly cold
  const coldAndClear = { temperature: 19, feelsLike: 12, observed: true, precipIn: 0, minVisibilityMi: 10, countyAlerts: [] };
  assert.equal(classifyCause('closed', coldAndClear, 'county-wide'), 'non-winter');   // e.g. an unlisted holiday in January
  // One district alone on a freezing morning may be its own back roads: scored
  assert.equal(classifyCause('closed', coldAndClear, 'isolated'), null);
  assert.equal(classifyCause('delay', coldAndClear, 'isolated'), null);
  assert.equal(classifyCause('closed', { ...coldAndClear, precipIn: 0.04 }, 'county-wide'), null);        // something fell
  // The airport's gauge reads zero in snow, but visibility drops: that is snow
  assert.equal(classifyCause('closed', { ...coldAndClear, minVisibilityMi: 0.8 }, 'county-wide'), null);
  assert.equal(classifyCause('closed', { ...coldAndClear, minVisibilityMi: null }, 'county-wide'), null); // not reported: assume weather
  assert.equal(classifyCause('closed', { ...coldAndClear, precipIn: null }, 'county-wide'), null);
  assert.equal(classifyCause('closed', { ...coldAndClear, feelsLike: -12 }, 'county-wide'), null);        // bitter cold
  assert.equal(classifyCause('closed', coldAndClear), null);                                              // no pattern: scored
});

test('what the districts did together: all closed, one alone, or neither', () => {
  const day = statuses => statuses.map(status => ({ status, noSchool: null }));
  assert.equal(closurePattern(day(['closed', 'closed', 'flexible instruction day', 'closed', 'closed', 'closed'])), 'county-wide');
  assert.equal(closurePattern(day(['closed', 'closed', 'delay', 'closed', 'closed', 'closed'])), null);
  assert.equal(closurePattern(day(['closed', 'open', 'open', 'open', 'open', 'open'])), 'isolated');
  assert.equal(closurePattern(day(['open', 'open', 'delay', 'open', 'open', 'open'])), 'isolated');
  assert.equal(closurePattern(day(['closed', 'delay', 'open', 'open', 'open', 'open'])), null);
  assert.equal(closurePattern(day(['open', 'open', 'open', 'open', 'open', 'open'])), null);
  // A district that could not be read leaves the picture incomplete
  assert.equal(closurePattern(day(['closed', null, 'open', 'open', 'open', 'open'])), null);
  assert.equal(closurePattern(day(['closed', 'closed', 'closed', 'closed', 'closed', null])), null);
  // A district on a listed day off is left out of the count
  const inService = { status: null, noSchool: 'Teacher inservice day' };
  assert.equal(closurePattern([inService, ...day(['closed', 'closed', 'closed', 'closed', 'closed'])]), 'county-wide');
  assert.equal(closurePattern([inService, ...day(['closed', 'open', 'open', 'open', 'open'])]), 'isolated');
});

test('a storm the forecast missed is scored as a miss, not waved away as non-weather', async () => {
  // Forecast on file: dry, 0%. Then wet snow at 33 F with no advisory: two delays,
  // three closures, one flexible instruction day.
  const store = memoryStore();
  const quiet = () => makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 0, 0, 0], windChill: [30, 30, 30, 30, 31], temperature: [34, 34, 34, 34, 35] }) });
  await logWeatherData({ now: new Date('2030-01-15T01:30:00Z'), store, sources: stagedSources({ inputs: quiet(), statuses: allSchools(posted('open', MONDAY)), morning: null }) });
  assert.equal(store.state.predictions.filter(e => e.date === TUESDAY && e.probability === 0).length, 6);

  const statuses = {
    IASD: posted('2-hour delay', TUESDAY), HCSD: posted('2-hour delay', TUESDAY),
    MCASD: posted('closed', TUESDAY), PMASD: posted('closed', TUESDAY), PLSD: posted('flexible instruction', TUESDAY),
    USD: posted('closed', TUESDAY)
  };
  await logWeatherData({
    now: new Date('2030-01-15T15:00:00Z'),
    store,
    sources: stagedSources({ inputs: makeInputs({ grid: makeGrid(WEDNESDAY, { windChill: [30, 30], temperature: [34, 34] }) }), statuses, morning: { minTempF: 33, minWindChillF: 27 } })
  });

  const scored = store.state.predictions.filter(e => e.date === TUESDAY);
  assert.equal(scored.filter(e => e.correct === false).length, 6);
  assert.equal(scored.filter(e => e.excluded).length, 0);
  assert.equal(store.state.history.filter(r => r.date === TUESDAY && r.cause).length, 0);
});

// ---------- forecast bookkeeping ----------

function stormForecast(targetDate, now) {
  const alerts = [makeAlert('Winter Weather Advisory', MONDAY, 22, 34)];
  const grid = makeGrid(targetDate, { snow: [0, 1.5, 1.5, 0.5], windChill: [12, 11, 11, 12, 15], temperature: [22, 21, 21, 22, 24] });
  return predictAllDistricts(makeInputs({ grid, alerts }), { now, targetDate });
}

test('a forecast is saved once per district and scored against the outcome', () => {
  const log = [];
  const eveningBefore = new Date('2030-01-15T01:30:00Z');
  const forecast = stormForecast(TUESDAY, eveningBefore);

  assert.equal(saveForecast(log, forecast, {}, eveningBefore), 6);
  assert.equal(log.length, 6);
  const indiana = log.find(e => e.school === 'Indiana');
  assert.equal(indiana.date, TUESDAY);
  assert.equal(indiana.modelVersion, MODEL_VERSION);
  assert.equal(indiana.predictedDisruption, true);
  assert.equal(indiana.probability, indiana.delayProbability + indiana.closureProbability);
  assert.deepEqual(indiana.features.alerts, ['Winter Weather Advisory@bus-time']);
  assert.equal(indiana.features.snowOvernightIn, 3.1); // 1.5 + 1.5 + one hour of the 7 AM block
  assert.equal(indiana.leadHours, 9);

  const outcomes = {
    'Indiana': { status: 'delay', cause: null },
    'Homer-Center': { status: 'closed', cause: null },
    'Marion Center': { status: 'open', cause: null },
    'Penns Manor': { status: 'flexible instruction day', cause: null },
    'Purchase Line': { status: 'closed', cause: 'non-winter' }
    // United: no outcome read
  };
  assert.equal(resolvePredictions(log, outcomes, TUESDAY), 5);

  const byschool = Object.fromEntries(log.map(e => [e.school, e]));
  assert.equal(byschool['Indiana'].correct, true);
  assert.equal(byschool['Homer-Center'].correct, true);
  assert.equal(byschool['Marion Center'].correct, false);          // false alarm
  assert.equal(byschool['Penns Manor'].correct, true);
  assert.equal(byschool['Purchase Line'].correct, null);           // not a weather closure: not scored
  assert.equal(byschool['Purchase Line'].excluded, 'Non-weather closure');
  assert.equal(byschool['United'].actualStatus, null);             // still pending
});

test('re-running with an unchanged forecast writes nothing; a changed one keeps its history', () => {
  const log = [];
  const afternoon = new Date('2030-01-14T19:00:00Z');
  const evening = new Date('2030-01-15T01:30:00Z');

  // Afternoon: nothing in the forecast yet
  const quiet = predictAllDistricts(makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 0, 0, 0], windChill: [25, 25, 25, 25, 25], temperature: [30, 30, 30, 30, 30] }) }), { now: afternoon, targetDate: TUESDAY });
  assert.equal(saveForecast(log, quiet, {}, afternoon), 6);
  assert.equal(saveForecast(log, quiet, {}, new Date('2030-01-14T22:00:00Z')), 0);
  assert.equal(log[0].madeAt, afternoon.toISOString());

  // Evening: an advisory has been issued
  assert.equal(saveForecast(log, stormForecast(TUESDAY, evening), {}, evening), 6);
  assert.equal(log.length, 6);
  assert.equal(log[0].madeAt, evening.toISOString());
  assert.deepEqual(log[0].history, [{ madeAt: afternoon.toISOString(), probability: 0 }]);
  assert.equal(log[0].predictedDisruption, true);
});

test('a forecast that has been scored is never overwritten', () => {
  const log = [];
  const evening = new Date('2030-01-15T01:30:00Z');
  saveForecast(log, stormForecast(TUESDAY, evening), {}, evening);
  resolvePredictions(log, { 'Indiana': { status: 'delay', cause: null } }, TUESDAY);
  const scored = { ...log.find(e => e.school === 'Indiana') };
  assert.equal(scored.correct, true);

  // Later that day the forecast for the same morning would come out quite differently
  const laterThatDay = new Date('2030-01-15T15:00:00Z');
  const quiet = predictAllDistricts(
    makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 0, 0, 0], windChill: [30, 30, 30, 30, 30], temperature: [34, 34, 34, 34, 34] }) }),
    { now: laterThatDay, targetDate: TUESDAY });
  assert.equal(quiet.districts[0].probability, 0);
  saveForecast(log, quiet, {}, laterThatDay);

  // The scored entry is untouched; the districts not yet scored do follow the new forecast
  assert.deepEqual(log.find(e => e.school === 'Indiana'), scored);
  assert.equal(log.find(e => e.school === 'United').probability, 0);
});

test('forecasts on file for a holiday are set aside, not scored', () => {
  const log = [{ date: '2026-11-26', school: 'Indiana', delayProbability: 0, closureProbability: 0, predictedDisruption: false, actualStatus: null, correct: null }];
  assert.equal(resolvePredictions(log, { 'Indiana': { status: 'open', cause: null } }, '2026-11-26'), 1);
  assert.equal(log[0].actualStatus, 'no school');
  assert.equal(log[0].excluded, 'Thanksgiving');
  assert.equal(log[0].correct, null);
});

// ---------- scorecard ----------

test('the scorecard counts disruptions caught and false alarms, not easy open days', () => {
  const entry = (date, predictedDisruption, actualStatus, probability) =>
    ({ date, school: 'Indiana', predictedDisruption, actualStatus, probability, correct: predictedDisruption === (actualStatus !== 'open') });
  const entries = [
    entry('2030-01-14', false, 'open', 0),
    entry('2030-01-15', true, 'delay', 70),
    entry('2030-01-16', true, 'open', 60),
    entry('2030-01-17', false, 'closed', 10),
    entry('2030-01-18', true, 'closed', 90),
    ...Array.from({ length: 95 }, (_, i) => entry(`2030-02-${String((i % 28) + 1).padStart(2, '0')}`, false, 'open', 0))
  ];
  const score = tally(entries);

  assert.equal(score.scored, 100);
  assert.equal(score.disruptions, 3);
  assert.equal(score.caught, 2);
  assert.equal(score.missed, 1);
  assert.equal(score.falseAlarms, 1);
  assert.equal(score.quietDaysCorrect, 96);
  assert.equal(score.hitRate, 67);
  assert.equal(score.falseAlarmRatio, 33);
  assert.equal(score.since, '2030-01-14');
  // (0.3^2 + 0.6^2 + 0.9^2 + 0.1^2) / 100 = 0.0127
  assert.equal(score.brier, 0.013);
  assert.ok(score.brierSkill > 0);
});

test('a forecast that never predicts anything shows no skill', () => {
  const entries = [
    ...Array.from({ length: 97 }, (_, i) => ({ date: `2030-01-${String((i % 28) + 1).padStart(2, '0')}`, predictedDisruption: false, actualStatus: 'open', probability: 0 })),
    ...Array.from({ length: 3 }, (_, i) => ({ date: `2030-02-0${i + 1}`, predictedDisruption: false, actualStatus: 'closed', probability: 0 }))
  ];
  const score = tally(entries);
  assert.equal(score.hitRate, 0);
  assert.equal(score.caught, 0);
  assert.ok(score.brierSkill < 0); // 97% "accurate", and worse than quoting the average
});

// ---------- whole runs (dry run, staged data) ----------

test('storm morning: outcomes are recorded with bus-time conditions, forecast rolls to the next day', async () => {
  const alerts = [makeAlert('Winter Weather Advisory', MONDAY, 22, 34)];
  const statuses = {
    IASD: posted('2-hour delay', TUESDAY),
    HCSD: posted('2-hour delay', TUESDAY),
    MCASD: posted('closed', TUESDAY),
    PMASD: posted('closed', TUESDAY),
    PLSD: posted('flexible instruction', TUESDAY),
    USD: posted('open', TUESDAY)
  };
  const result = await logWeatherData({
    dryRun: true,
    now: new Date('2030-01-15T12:30:00Z'), // 7:30 AM Eastern
    sources: stagedSources({
      inputs: makeInputs({ alerts, grid: makeGrid(WEDNESDAY, { snow: [0, 0, 0, 0], windChill: [20, 20, 20, 20, 22], temperature: [26, 26, 26, 26, 28] }) }),
      statuses,
      morning: { station: 'test', count: 6, minTempF: 21, minWindChillF: 11 }
    })
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.date, TUESDAY);
  assert.equal(result.logged.length, 6);
  assert.deepEqual(result.logged.map(r => r.status), ['delay', 'delay', 'closed', 'closed', 'flexible instruction day', 'open']);

  const indiana = result.logged[0];
  assert.equal(indiana.temperature, 21);   // the 5-9 AM low, whenever the job runs
  assert.equal(indiana.feelsLike, 11);
  assert.equal(indiana.type, 'snow');
  assert.deepEqual(indiana.alerts, ['Winter Weather Advisory']);
  assert.equal(indiana.cause, undefined);
  assert.equal(indiana.readAt, '07:30');

  // 7:30 AM is past the rollover: the forecast being saved is Wednesday's
  assert.equal(result.predictions.targetDate, WEDNESDAY);
  assert.equal(result.predictions.savedForTarget, 6);
  assert.equal(result.predictions.forecast[0].probability, 0);
});

test('a run that slips to the afternoon still records the morning, under the Eastern date', async () => {
  const result = await logWeatherData({
    dryRun: true,
    now: new Date('2030-01-16T00:10:00Z'), // 7:10 PM Eastern on Tuesday
    sources: stagedSources({
      inputs: makeInputs({ grid: makeGrid(WEDNESDAY, { snow: [0, 0, 0, 0], windChill: [20, 20], temperature: [26, 26] }) }),
      statuses: allSchools(posted('open', MONDAY)),
      morning: { station: 'test', count: 6, minTempF: 27, minWindChillF: 16 }
    })
  });

  assert.equal(result.date, TUESDAY);
  assert.equal(result.logged.length, 6);
  assert.equal(result.logged[0].date, TUESDAY);
  assert.equal(result.logged[0].temperature, 27);
  assert.equal(result.logged[0].type, 'normal');
  assert.equal(result.predictions.targetDate, WEDNESDAY);
});

test('evening before a storm: tomorrow\'s announcements are not recorded as today\'s', async () => {
  const result = await logWeatherData({
    dryRun: true,
    now: new Date('2030-01-15T01:30:00Z'), // Monday 8:30 PM Eastern
    sources: stagedSources({
      inputs: makeInputs({
        alerts: [makeAlert('Winter Storm Warning', MONDAY, 22, 40)],
        grid: makeGrid(TUESDAY, { snow: [0, 3, 4, 2], windChill: [10, 9, 9, 10, 12], temperature: [20, 19, 19, 20, 22] })
      }),
      statuses: allSchools(posted('closed', TUESDAY)),
      morning: { station: 'test', count: 6, minTempF: 30, minWindChillF: 25 }
    })
  });

  assert.equal(result.date, MONDAY);
  assert.equal(result.logged.length, 0);
  assert.equal(result.errors.filter(e => e.type === 'status_not_recorded').length, 6);
  assert.equal(result.predictions.targetDate, TUESDAY);
  assert.ok(result.predictions.forecast.every(f => f.probability >= 85));
});

test('a warm-weather closure is recorded as non-weather', async () => {
  const result = await logWeatherData({
    dryRun: true,
    now: new Date('2030-09-04T14:00:00Z'), // a Wednesday in September, 10 AM Eastern
    sources: stagedSources({
      inputs: makeInputs({ grid: makeGrid('2030-09-05', { windChill: [60, 60], temperature: [60, 60] }) }),
      statuses: { ...allSchools(posted('open', '2030-09-04')), USD: posted('closed', '2030-09-04') },
      morning: { station: 'test', count: 6, minTempF: 73, minWindChillF: 73 }
    })
  });

  // Outside winter only disruptions are logged
  assert.equal(result.logged.length, 1);
  assert.equal(result.logged[0].school, 'United');
  assert.equal(result.logged[0].cause, 'non-winter');
  assert.equal(result.logged[0].type, 'non-weather');
});

test('nothing is recorded on a holiday or without morning observations', async () => {
  const sources = stagedSources({
    inputs: makeInputs({ grid: makeGrid('2030-11-29', { windChill: [30, 30], temperature: [35, 35] }) }),
    statuses: allSchools(posted('open', '2030-11-20')),
    morning: null
  });

  const thanksgiving = await logWeatherData({ dryRun: true, now: new Date('2030-11-28T15:00:00Z'), sources });
  assert.equal(thanksgiving.logged.length, 0);
  assert.ok(thanksgiving.skipped.every(s => /Not a school day: Thanksgiving/.test(s.reason)));
  assert.equal(thanksgiving.predictions.targetDate, '2030-12-02'); // the following Monday

  const noObservations = await logWeatherData({
    dryRun: true,
    now: new Date('2030-01-15T15:00:00Z'),
    sources: { ...sources, getSchoolStatuses: async () => allSchools(posted('open', MONDAY)) }
  });
  assert.equal(noObservations.logged.length, 0);
  assert.ok(noObservations.errors.some(e => /no morning weather observations/.test(e.message)));
});

// ---------- a day's record over several runs ----------

const quietTomorrow = () => makeInputs({ grid: makeGrid(WEDNESDAY, { snow: [0, 0, 0, 0], windChill: [20, 20, 20, 20, 22], temperature: [26, 26, 26, 26, 28] }) });
const morningLow = { station: 'test', count: 6, minTempF: 21, minWindChillF: 11 };

async function fileStormForecast(store) {
  // Monday 8:30 PM: advisory and snow in the forecast for Tuesday
  const alerts = [makeAlert('Winter Weather Advisory', MONDAY, 22, 34)];
  const grid = makeGrid(TUESDAY, { snow: [0, 1.5, 1.5, 0.5], windChill: [12, 11, 11, 12, 15], temperature: [22, 21, 21, 22, 24] });
  await logWeatherData({
    now: new Date('2030-01-15T01:30:00Z'),
    store,
    sources: stagedSources({ inputs: makeInputs({ grid, alerts }), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.ok(store.state.predictions.filter(e => e.date === TUESDAY).every(e => e.predictedDisruption));
}

const run = (store, isoTime, statuses, morning = morningLow) => logWeatherData({
  now: new Date(isoTime),
  store,
  sources: stagedSources({ inputs: quietTomorrow(), statuses, morning })
});

test('a delay posted after the first read of the day is picked up by the next run', async () => {
  const store = memoryStore();
  await fileStormForecast(store);

  // 6:05 AM: nothing posted yet. Recorded open, and the forecast looks like a false alarm...
  await run(store, '2030-01-15T11:05:00Z', allSchools(posted('open', MONDAY)));
  assert.ok(store.state.history.every(r => r.status === 'open'));
  assert.ok(store.state.predictions.filter(e => e.date === TUESDAY).every(e => e.correct === false));

  // 7:17 AM: the districts have posted two-hour delays
  const result = await run(store, '2030-01-15T12:17:00Z', allSchools(posted('2-hour delay', TUESDAY)));
  assert.equal(result.updated.length, 6);
  assert.equal(store.state.history.length, 6); // revised in place, not duplicated
  assert.ok(store.state.history.every(r => r.status === 'delay' && r.readAt === '07:17'));
  const forecasts = store.state.predictions.filter(e => e.date === TUESDAY);
  assert.ok(forecasts.every(e => e.actualStatus === 'delay' && e.correct === true));
});

test('a delay that becomes a closure, and an early dismissal, move the record up', async () => {
  const store = memoryStore();
  await fileStormForecast(store);

  await run(store, '2030-01-15T12:17:00Z', { ...allSchools(posted('open', TUESDAY)), IASD: posted('2-hour delay', TUESDAY) });
  await run(store, '2030-01-15T15:17:00Z', { ...allSchools(posted('early dismissal', TUESDAY)), IASD: posted('closed', TUESDAY) });

  const status = school => store.state.history.find(r => r.school === school).status;
  assert.equal(status('Indiana'), 'closed');
  assert.equal(status('United'), 'early dismissal');
  assert.ok(store.state.predictions.filter(e => e.date === TUESDAY).every(e => e.correct === true));
});

test('a delay cleared from the page later in the day stays a delay', async () => {
  const store = memoryStore();
  await fileStormForecast(store);

  await run(store, '2030-01-15T12:17:00Z', allSchools(posted('2-hour delay', TUESDAY)));
  await run(store, '2030-01-15T15:17:00Z', allSchools(posted('2-hour delay', TUESDAY)));
  const before = JSON.stringify(store.state);
  const result = await run(store, '2030-01-15T18:17:00Z', allSchools(posted('open', TUESDAY)));

  assert.equal(result.updated.length, 0);
  assert.ok(store.state.history.every(r => r.status === 'delay'));
  assert.ok(store.state.predictions.filter(e => e.date === TUESDAY).every(e => e.actualStatus === 'delay'));
  // and nothing about Tuesday was rewritten
  assert.deepEqual(JSON.parse(before).history, store.state.history);
});

test('outside winter, a closure posted after an open read still reaches both logs', async () => {
  // April: open days are not stored, so the first run leaves no row behind
  const store = memoryStore();
  const alerts = [makeAlert('Winter Storm Warning', '2030-04-09', 20, 36)];
  const grid = makeGrid('2030-04-10', { snow: [0, 3, 4, 1], windChill: [18, 17, 17, 18, 20], temperature: [27, 26, 26, 27, 29] });
  await logWeatherData({ now: new Date('2030-04-10T00:30:00Z'), store, sources: stagedSources({ inputs: makeInputs({ grid, alerts }), statuses: allSchools(posted('open', '2030-04-08')), morning: null }) });

  const aprilQuiet = () => makeInputs({ grid: makeGrid('2030-04-11', { snow: [0, 0, 0, 0], windChill: [30, 30], temperature: [35, 35] }) });
  const aprilRun = (iso, statuses) => logWeatherData({ now: new Date(iso), store, sources: stagedSources({ inputs: aprilQuiet(), statuses, morning: { minTempF: 26, minWindChillF: 17 } }) });

  await aprilRun('2030-04-10T11:17:00Z', allSchools(posted('open', '2030-04-08')));
  assert.equal(store.state.history.length, 0);

  await aprilRun('2030-04-10T14:17:00Z', allSchools(posted('closed', '2030-04-10')));
  assert.equal(store.state.history.filter(r => r.date === '2030-04-10' && r.status === 'closed').length, 6);
  const forecasts = store.state.predictions.filter(e => e.date === '2030-04-10');
  assert.ok(forecasts.every(e => e.actualStatus === 'closed' && e.correct === true));
});

test('the morning low is completed once the whole 5-9 AM record is in', async () => {
  const store = memoryStore();

  // 7:17 AM: only part of the window has been observed
  await run(store, '2030-01-15T12:17:00Z', allSchools(posted('open', MONDAY)), { minTempF: 43, minWindChillF: 35 });
  assert.ok(store.state.history.every(r => r.temperature === 43 && r.obs === 'partial'));

  // 10:17 AM: the full record shows it got colder after sunrise
  const result = await run(store, '2030-01-15T15:17:00Z', allSchools(posted('open', MONDAY)), { minTempF: 39, minWindChillF: 29 });
  assert.equal(result.updated.length, 6);
  assert.ok(store.state.history.every(r => r.temperature === 39 && r.feelsLike === 29 && r.obs === undefined));

  // A third run has nothing left to change
  const before = JSON.stringify(store.state.history);
  await run(store, '2030-01-15T18:17:00Z', allSchools(posted('open', MONDAY)), { minTempF: 39, minWindChillF: 29 });
  assert.equal(JSON.stringify(store.state.history), before);
});

test('the "partial" note is removed once the morning is complete, even when the low did not change', async () => {
  const store = memoryStore();
  await run(store, '2030-01-15T12:17:00Z', allSchools(posted('open', MONDAY)), { minTempF: 27, minWindChillF: 16 });
  assert.ok(store.state.history.every(r => r.obs === 'partial'));

  const result = await run(store, '2030-01-15T15:17:00Z', allSchools(posted('open', MONDAY)), { minTempF: 27, minWindChillF: 16 });
  assert.equal(result.updated.length, 6);
  assert.deepEqual(result.updated[0].changes, ['morning record complete']);
  // What is stored (not just what was in memory) no longer carries the note
  assert.ok(store.state.history.every(r => r.temperature === 27 && r.feelsLike === 16 && !('obs' in r)));
});

test('a forecast low used because the station had not reported is replaced by the real one', async () => {
  const store = memoryStore();
  await fileStormForecast(store); // on file: 21 F / wind chill 11 F

  await run(store, '2030-01-15T12:17:00Z', allSchools(posted('2-hour delay', TUESDAY)), null);
  assert.ok(store.state.history.every(r => r.temperature === 21 && r.obs === 'forecast'));

  await run(store, '2030-01-15T15:17:00Z', allSchools(posted('2-hour delay', TUESDAY)), { minTempF: 9, minWindChillF: -6 });
  assert.ok(store.state.history.every(r => r.temperature === 9 && r.feelsLike === -6 && r.obs === undefined));
});

test('a day off that is not in the calendar is recognised once all six districts show closed', async () => {
  const store = memoryStore();
  const mild = { minTempF: 38, minWindChillF: 33 };

  // 7:17 AM: five districts show Closed, one has not posted
  await run(store, '2030-01-15T12:17:00Z', { ...allSchools(posted('closed', TUESDAY)), USD: posted('open', TUESDAY) }, mild);
  assert.equal(store.state.history.filter(r => r.cause === 'non-winter').length, 0);

  // 10:17 AM: the sixth shows Closed too. No alert, above freezing: a day off.
  await run(store, '2030-01-15T15:17:00Z', allSchools(posted('closed', TUESDAY)), mild);
  assert.equal(store.state.history.filter(r => r.cause === 'non-winter' && r.type === 'non-weather').length, 6);
});

test('a snow day the airport gauge did not register is still a snow day', async () => {
  // As on 2024-01-16: all six closed, 16 F, wind chill 3 F, gauge 0.00 (it does
  // not register snow), visibility under a mile, advisory only for the ridges.
  const store = memoryStore();
  const quiet = makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 0, 0, 0], windChill: [5, 4, 3, 4, 6], temperature: [17, 16, 16, 17, 18] }) });
  await logWeatherData({ now: new Date('2030-01-15T01:30:00Z'), store, sources: stagedSources({ inputs: quiet, statuses: allSchools(posted('open', MONDAY)), morning: null }) });

  const snowyMorning = { minTempF: 16, minWindChillF: 3, precipIn: 0, minVisibilityMi: 0.8 };
  const ridgeAdvisory = [makeAlert('Winter Weather Advisory', MONDAY, 22, 36, ['PAZ078'])];

  // With the ridge-zone advisory (it covers part of the county, so it counts for all of it)
  const withAdvisory = await logWeatherData({
    now: new Date('2030-01-15T15:17:00Z'), store,
    sources: stagedSources({ inputs: { ...quietTomorrow(), alerts: ridgeAdvisory }, statuses: allSchools(posted('closed', TUESDAY)), morning: snowyMorning })
  });
  assert.equal(withAdvisory.setAside.length, 0);
  assert.equal(store.state.history.filter(r => r.cause).length, 0);
  assert.equal(store.state.predictions.filter(e => e.date === TUESDAY && e.correct === false).length, 6);

  // And with no alert at all: the visibility alone says something was falling
  const noAlertStore = memoryStore();
  await logWeatherData({ now: new Date('2030-01-15T01:30:00Z'), store: noAlertStore, sources: stagedSources({ inputs: quiet, statuses: allSchools(posted('open', MONDAY)), morning: null }) });
  await run(noAlertStore, '2030-01-15T15:17:00Z', allSchools(posted('closed', TUESDAY)), snowyMorning);
  assert.equal(noAlertStore.state.history.filter(r => r.cause).length, 0);
  assert.equal(noAlertStore.state.predictions.filter(e => e.date === TUESDAY && e.correct === false).length, 6);
});

test('an unlisted day off on a clear, cold morning is set aside and reported', async () => {
  const store = memoryStore();
  const clearMorning = { minTempF: 19, minWindChillF: 11, precipIn: 0, minVisibilityMi: 10 };
  const result = await run(store, '2030-01-15T15:17:00Z', allSchools(posted('closed', TUESDAY)), clearMorning);

  assert.equal(store.state.history.filter(r => r.cause === 'non-winter' && r.type === 'non-weather').length, 6);
  assert.equal(result.setAside.length, 6);
  assert.deepEqual(result.setAside[0], { school: 'Indiana', status: 'closed' });
});

test('one district closing on a mild morning is a local problem, not a missed forecast', async () => {
  const store = memoryStore();
  const quiet = makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 0, 0, 0], windChill: [38, 38, 38, 38, 39], temperature: [40, 40, 40, 40, 41] }) });
  await logWeatherData({ now: new Date('2030-01-15T01:30:00Z'), store, sources: stagedSources({ inputs: quiet, statuses: allSchools(posted('open', MONDAY)), morning: null }) });

  const statuses = { ...allSchools(posted('open', MONDAY)), PMASD: posted('closed', TUESDAY) };
  const result = await run(store, '2030-01-15T15:17:00Z', statuses, { minTempF: 40, minWindChillF: 38, precipIn: 0, minVisibilityMi: 10 });

  const pennsManor = store.state.history.find(r => r.school === 'Penns Manor');
  assert.equal(pennsManor.cause, 'non-winter');
  assert.deepEqual(result.setAside, [{ school: 'Penns Manor', status: 'closed' }]);
  const forecast = store.state.predictions.find(e => e.school === 'Penns Manor' && e.date === TUESDAY);
  assert.equal(forecast.correct, null);
  assert.equal(forecast.excluded, 'Non-weather closure');
  // The other five are ordinary open days, called correctly
  assert.equal(store.state.predictions.filter(e => e.date === TUESDAY && e.correct === true).length, 5);

  // Had a second district been delayed too, both would count against the forecast
  const second = memoryStore();
  await logWeatherData({ now: new Date('2030-01-15T01:30:00Z'), store: second, sources: stagedSources({ inputs: quiet, statuses: allSchools(posted('open', MONDAY)), morning: null }) });
  await run(second, '2030-01-15T15:17:00Z', { ...statuses, USD: posted('2-hour delay', TUESDAY) }, { minTempF: 40, minWindChillF: 38, precipIn: 0, minVisibilityMi: 10 });
  assert.equal(second.state.predictions.filter(e => e.date === TUESDAY && e.correct === false).length, 2);
});

// ---------- forecasts are not replaced by guesses made without data ----------

test('with the alert feed down, the forecast on file is left alone', async () => {
  const store = memoryStore();
  await fileStormForecast(store);
  const before = JSON.stringify(store.state.predictions);

  // 1:17 AM: the grid answers, the alert feed does not
  const inputs = makeInputs({ grid: makeGrid(TUESDAY, { snow: [0, 1.5, 1.5, 0.5], windChill: [12, 11, 11, 12, 15], temperature: [22, 21, 21, 22, 24] }) });
  inputs.alertsAvailable = false;
  const result = await logWeatherData({
    now: new Date('2030-01-15T06:17:00Z'),
    store,
    sources: stagedSources({ inputs, statuses: allSchools(posted('open', MONDAY)), morning: null })
  });

  assert.equal(JSON.stringify(store.state.predictions), before);
  assert.ok(result.errors.some(e => e.type === 'alerts_unavailable'));
  // What is shown meanwhile still carries the advisory that was on file
  assert.ok(result.predictions.forecast.every(f => f.probability >= 50));

  // A morning with nothing on file yet still gets a forecast: one made
  // without alerts is better than none, and the next good run refreshes it
  const empty = memoryStore();
  const first = await logWeatherData({
    now: new Date('2030-01-15T06:17:00Z'),
    store: empty,
    sources: stagedSources({ inputs, statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(first.predictions.savedForTarget, 6);
  assert.ok(first.errors.some(e => e.type === 'alerts_unavailable'));
  assert.ok(empty.state.predictions.every(e => e.date === TUESDAY && e.features.alerts.length === 0));
});

test('with the weather grid down and the alerts unchanged, the forecast on file is left as it is', async () => {
  const store = memoryStore();
  await fileStormForecast(store);
  const before = JSON.stringify(store.state.predictions);

  // 1:17 AM: no grid, no worded forecast; the advisory is still in force
  const alerts = [makeAlert('Winter Weather Advisory', MONDAY, 22, 34)];
  const result = await logWeatherData({
    now: new Date('2030-01-15T06:17:00Z'),
    store,
    sources: stagedSources({ inputs: makeInputs({ alerts }), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(JSON.stringify(store.state.predictions), before);
  assert.equal(result.predictions.savedForTarget, 0);
  assert.ok(result.predictions.forecast.every(f => f.probability >= 50));
});

test('a warning issued while the weather grid is down is still filed', async () => {
  // Monday 4:17 PM: under an inch of snow in the forecast, no alert
  const store = memoryStore();
  const grid = makeGrid(TUESDAY, { snow: [0, 0.4, 0.4, 0], windChill: [22, 22, 22, 22, 23], temperature: [28, 28, 28, 28, 29] });
  await logWeatherData({ now: new Date('2030-01-14T21:17:00Z'), store, sources: stagedSources({ inputs: makeInputs({ grid }), statuses: allSchools(posted('open', MONDAY)), morning: null }) });
  const first = store.state.predictions.find(e => e.school === 'Indiana');
  assert.equal(first.predictedDisruption, false);

  // 7:17 PM: the grid cannot be reached, and a Winter Storm Warning is out
  const warning = [makeAlert('Winter Storm Warning', MONDAY, 23, 37)];
  const result = await logWeatherData({ now: new Date('2030-01-15T00:17:00Z'), store, sources: stagedSources({ inputs: makeInputs({ alerts: warning }), statuses: allSchools(posted('open', MONDAY)), morning: null }) });

  assert.equal(result.predictions.savedForTarget, 6);
  const entry = store.state.predictions.find(e => e.school === 'Indiana');
  assert.equal(entry.predictedDisruption, true);
  assert.deepEqual(entry.features.alerts, ['Winter Storm Warning@bus-time']);
  // The snow figures are the ones already on file, and the earlier forecast is kept in the history
  assert.equal(entry.features.source, 'on-file');
  assert.equal(entry.features.snowOvernightIn, first.features.snowOvernightIn);
  assert.deepEqual(entry.features.snowBlocks, first.features.snowBlocks);
  assert.deepEqual(entry.history, [{ madeAt: first.madeAt, probability: first.probability }]);
});

// Worded forecasts for Tuesday morning, as NWS words them
const hourlyTemps = () => ({
  periods: [5, 6, 7, 8].map(hour => ({
    startTime: new Date(easternToMs(TUESDAY, hour)).toISOString(),
    temperature: 30, windSpeed: '5 mph', shortForecast: 'Cloudy', probabilityOfPrecipitation: 10
  }))
});
const snowyNightForecast = () => ({
  periods: [{
    name: 'Monday Night', isDaytime: false,
    startTime: new Date(easternToMs(MONDAY, 18)).toISOString(),
    endTime: new Date(easternToMs(TUESDAY, 6)).toISOString(),
    detailedForecast: 'Snow. Low around 26. New snow accumulation of 5 to 8 inches possible.'
  }]
});

test('temperatures alone never replace a real forecast', async () => {
  // Monday 1:17 PM: six inches of snow on the way, filed from the grid
  const store = memoryStore();
  const grid = makeGrid(TUESDAY, { snow: [0, 3.5, 3, 0], windChill: [20, 20, 20, 20, 21], temperature: [26, 26, 26, 26, 27] });
  await logWeatherData({ now: new Date('2030-01-14T18:17:00Z'), store, sources: stagedSources({ inputs: makeInputs({ grid }), statuses: allSchools(posted('open', MONDAY)), morning: null }) });
  const before = JSON.stringify(store.state.predictions);
  assert.ok(store.state.predictions.every(e => e.predictedDisruption && e.features.source === 'grid'));

  // 4:17 PM: the grid and the 7-day forecast fail; only hourly temperatures answer
  const result = await logWeatherData({
    now: new Date('2030-01-14T21:17:00Z'), store,
    sources: stagedSources({ inputs: makeInputs({ hourlyForecast: hourlyTemps() }), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(JSON.stringify(store.state.predictions), before);
  assert.equal(result.predictions.savedForTarget, 0);
  assert.ok(result.predictions.forecast.every(f => f.probability >= 50)); // still the forecast on file
});

test('with nothing on file, a forecast that knows nothing about snow is not filed', async () => {
  const store = memoryStore();
  const temperaturesOnly = await logWeatherData({
    now: new Date('2030-01-14T21:17:00Z'), store,
    sources: stagedSources({ inputs: makeInputs({ hourlyForecast: hourlyTemps() }), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(temperaturesOnly.predictions.savedForTarget, 0);
  assert.equal(store.state.predictions.length, 0);

  // With the 7-day forecast as well, the worded forecast is a forecast
  const worded = await logWeatherData({
    now: new Date('2030-01-14T21:17:00Z'), store,
    sources: stagedSources({ inputs: makeInputs({ forecast: snowyNightForecast(), hourlyForecast: hourlyTemps() }), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(worded.predictions.savedForTarget, 6);
  assert.ok(store.state.predictions.every(e => e.features.source === 'text' && e.features.snowOvernightIn === 6.5));
});

test('when NWS moves the same snow to a different part of the night, the periods on file follow', async () => {
  const store = memoryStore();
  const base = { windChill: [22, 22, 22, 22, 23], temperature: [28, 28, 28, 28, 29] };
  const at = (iso, grid) => logWeatherData({ now: new Date(iso), store, sources: stagedSources({ inputs: makeInputs({ grid }), statuses: allSchools(posted('open', MONDAY)), morning: null }) });

  // Monday 4:17 PM: 2.4 in between 7 PM and 1 AM
  await at('2030-01-14T21:17:00Z', makeGrid(TUESDAY, { ...base, snow: [0, 2.4, 0, 0] }));
  const first = JSON.parse(JSON.stringify(store.state.predictions.find(e => e.school === 'Indiana')));

  // 10:17 PM: the same 2.4 in, now between 1 and 7 AM. Same total, same chance.
  const moved = await at('2030-01-15T03:17:00Z', makeGrid(TUESDAY, { ...base, snow: [0, 0, 2.4, 0] }));
  const second = store.state.predictions.find(e => e.school === 'Indiana');
  assert.equal(moved.predictions.savedForTarget, 6);
  assert.equal(second.probability, first.probability);
  assert.equal(second.madeAt, first.madeAt);                       // same forecast, not re-dated
  assert.notDeepEqual(second.features.snowBlocks, first.features.snowBlocks);

  // 5 AM: the grid now starts at 11 PM. The page adds the hours it has dropped
  // from the periods on file - and must find no snow there.
  const lateGrid = makeGrid(TUESDAY, { ...base, snow: [0, 0, 2.4, 0] });
  const elevenPm = easternToMs(MONDAY, 23);
  lateGrid.series.snowfallAmount = lateGrid.series.snowfallAmount
    .filter(block => block.end > elevenPm)
    .map(block => (block.start >= elevenPm ? block : { start: elevenPm, end: block.end, value: block.value * (block.end - elevenPm) / (block.end - block.start) }));
  const onFile = Object.fromEntries(['IASD', 'HCSD', 'MCASD', 'PMASD', 'PLSD', 'USD'].map(code => [code, second.features]));
  const page = predictAllDistricts(makeInputs({ grid: lateGrid }), { now: new Date('2030-01-15T10:00:00Z'), targetDate: TUESDAY, onFile });
  assert.equal(page.county.features.snowOvernightIn, 2.4);

  // A third run with nothing new writes nothing
  const before = JSON.stringify(store.state.predictions);
  const unchanged = await at('2030-01-15T06:17:00Z', lateGrid);
  assert.equal(unchanged.predictions.savedForTarget, 0);
  assert.equal(JSON.stringify(store.state.predictions), before);
});

test('an announcement is noted without re-dating the forecast', async () => {
  const store = memoryStore();
  await fileStormForecast(store);
  const madeAt = store.state.predictions[0].madeAt;

  // 10:17 PM: same forecast, but United has already posted a closure for Tuesday
  const alerts = [makeAlert('Winter Weather Advisory', MONDAY, 22, 34)];
  const grid = makeGrid(TUESDAY, { snow: [0, 1.5, 1.5, 0.5], windChill: [12, 11, 11, 12, 15], temperature: [22, 21, 21, 22, 24] });
  const stormInputs = () => makeInputs({ grid, alerts });
  await logWeatherData({
    now: new Date('2030-01-15T03:17:00Z'),
    store,
    sources: stagedSources({ inputs: stormInputs(), statuses: { ...allSchools(posted('open', TUESDAY)), USD: posted('closed', TUESDAY) }, morning: null })
  });
  const united = store.state.predictions.find(e => e.school === 'United' && e.date === TUESDAY);
  assert.equal(united.announcedBeforeForecast, 'closed');
  assert.equal(united.madeAt, madeAt);
  assert.equal(united.history, undefined);

  // SchoolCast unreachable on the next run: the note stays
  await logWeatherData({ now: new Date('2030-01-15T05:17:00Z'), store, sources: stagedSources({ inputs: stormInputs(), statuses: {}, morning: null }) });
  assert.equal(store.state.predictions.find(e => e.school === 'United' && e.date === TUESDAY).announcedBeforeForecast, 'closed');
});

// ---------- damaged files ----------

test('a log file that cannot be parsed stops the run instead of being overwritten', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  const broken = path.join(dir, 'predictionLog.json');
  fs.writeFileSync(broken, '[{"date": "2030-01-15"},\n<<<<<<< HEAD\n]');

  assert.throws(() => loadJson(broken), /predictionLog\.json is not valid JSON/);
  assert.deepEqual(loadJson(path.join(dir, 'missing.json')), []); // no file yet is simply an empty log

  let saved = false;
  const store = {
    ...memoryStore(),
    loadPredictionLog: () => loadJson(broken),
    savePredictionLog: () => { saved = true; },
    saveHistoricalData: () => { saved = true; }
  };
  const result = await run(store, '2030-01-15T12:17:00Z', allSchools(posted('open', MONDAY)));
  assert.equal(saved, false);
  assert.ok(result.errors.some(e => /not valid JSON/.test(e.message)));
  fs.rmSync(dir, { recursive: true });
});

// ---------- which entries reach the scorecard ----------

test('the scorecard counts live, verified, weather-relevant forecasts only', () => {
  const entry = (date, school, extra = {}) => ({
    date, school, delayProbability: 0, closureProbability: 0, predictedDisruption: false,
    actualStatus: 'open', correct: true, ...extra
  });
  const log = [
    // Rows a one-off script once generated from known outcomes: never counted
    entry('2026-01-20', 'Indiana', { source: 'backtest', predictedDisruption: true, actualStatus: 'closed' }),
    entry('2026-01-21', 'Indiana', { source: 'backtest', predictedDisruption: true, actualStatus: 'delay' }),
    // Previous model, ordinary days
    entry('2026-03-02', 'Indiana'),
    entry('2026-03-03', 'Indiana', { actualStatus: 'delay', correct: false }),
    entry('2026-04-21', 'Indiana', { predictedDisruption: true, delayProbability: 33, closureProbability: 62, correct: false }),
    // Good Friday closure, a late-August closure at 77 F, a Saturday, a summer weekday: none is a school-weather result
    entry('2026-04-03', 'Indiana', { actualStatus: 'closed', correct: false }),
    entry('2026-08-27', 'United', { actualStatus: 'closed', correct: false }),
    entry('2026-03-07', 'Indiana'),
    entry('2026-07-08', 'Indiana'),
    // Never resolved
    entry('2026-03-14', 'Indiana', { actualStatus: null, correct: null }),
    // Current model
    entry('2026-12-01', 'Indiana', { modelVersion: MODEL_VERSION, probability: 0 }),
    entry('2026-12-02', 'Indiana', { modelVersion: MODEL_VERSION, probability: 70, predictedDisruption: true, actualStatus: 'delay' }),
    entry('2026-12-03', 'Indiana', { modelVersion: MODEL_VERSION, probability: 0, actualStatus: 'closed', correct: null, excluded: 'Non-weather closure' }),
    // Still to come
    entry('2026-12-08', 'Indiana', { modelVersion: MODEL_VERSION, probability: 10, actualStatus: null, correct: null })
  ];
  const historicalData = [
    { school: 'United', date: '2026-08-27', status: 'closed', temperature: 77, snowfall: 0, type: 'unknown', feelsLike: 77 },
    { school: 'Indiana', date: '2026-03-03', status: 'delay', temperature: 36, snowfall: 0, type: 'unknown', feelsLike: 29 }
  ];

  assert.deepEqual(getScorableEntries(log, historicalData).map(e => e.date),
    ['2026-03-02', '2026-03-03', '2026-04-21', '2026-12-01', '2026-12-02']);

  const audit = getPredictionAccuracy({ log, historicalData, today: '2026-12-04' });
  assert.equal(audit.status, 'active');
  // The two models are kept apart, so the old one's record is never shown as the new one's
  assert.deepEqual(
    { scored: audit.previous.scored, caught: audit.previous.caught, missed: audit.previous.missed, falseAlarms: audit.previous.falseAlarms },
    { scored: 3, caught: 0, missed: 1, falseAlarms: 1 });
  assert.deepEqual(
    { scored: audit.current.scored, caught: audit.current.caught, missed: audit.current.missed, falseAlarms: audit.current.falseAlarms },
    { scored: 2, caught: 1, missed: 0, falseAlarms: 0 });
  assert.equal(audit.pendingCount, 1); // only the forecast still ahead; a stale unresolved Saturday is not "pending"
  // What was left out as unrelated to weather is reported, not hidden
  assert.equal(audit.current.setAside, 1);
  assert.deepEqual(audit.current.setAsideDates, ['2026-12-03']);
});

test('with nothing scored yet the audit says so', () => {
  const pending = [{ date: '2026-12-08', school: 'Indiana', probability: 10, predictedDisruption: false, modelVersion: MODEL_VERSION, actualStatus: null, correct: null }];
  assert.equal(getPredictionAccuracy({ log: pending, historicalData: [], today: '2026-12-04' }).status, 'collecting');
  assert.equal(getPredictionAccuracy({ log: [], historicalData: [], today: '2026-12-04' }).status, 'no-data');
});
