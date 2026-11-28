const test = require('node:test');
const assert = require('node:assert/strict');
const {
  logWeatherData, loadJson, readTodayStatus, classifyCause, resolvePredictions, saveForecast, tally, MODEL_VERSION
} = require('../api/_lib/weatherLogger');
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

function stagedSources({ inputs, statuses, morning }) {
  return {
    fetchForecastInputs: async () => inputs,
    getSchoolStatuses: async () => statuses,
    getObservedWindow: async () => morning
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

test('a delay or closure on a page whose date cannot be read is not taken as today\'s', () => {
  const undatedClosure = readTodayStatus(posted('closed', null), TUESDAY, 8);
  assert.match(undatedClosure.skip, /date could not be read/);
  assert.equal(undatedClosure.problem, true);
  // "Open" needs no date: nothing posted is nothing posted
  assert.deepEqual(readTodayStatus(posted('open', null), TUESDAY, 8), { status: 'open' });
});

test('statuses are not read before districts have posted, or from unreliable sources', () => {
  assert.match(readTodayStatus(posted('open', TUESDAY), TUESDAY, 4).skip, /Too early/);
  assert.match(readTodayStatus({ status: 'closed', source: 'Local Radio' }, TUESDAY, 8).skip, /No reliable status source/);
  assert.match(readTodayStatus(undefined, TUESDAY, 8).skip, /No reliable status source/);
  assert.match(readTodayStatus(posted('unknown', TUESDAY, { raw: 'See website' }), TUESDAY, 8).skip, /Unknown status "See website"/);
});

// ---------- weather or not ----------

test('a closure is set aside as non-weather only on outside facts', () => {
  const morning = { temperature: 39, feelsLike: 35, alerts: [] };

  assert.equal(classifyCause('open', morning), null);
  // Too warm for winter weather, whatever else is going on
  assert.equal(classifyCause('closed', { ...morning, temperature: 77, feelsLike: 77 }), 'non-winter');

  // All six districts closed, no alert, above freezing: a day off
  assert.equal(classifyCause('closed', morning, true), 'non-winter');
  assert.equal(classifyCause('flexible instruction day', morning, true), 'non-winter');
  // ...but not at or below freezing, and not under a winter alert
  assert.equal(classifyCause('closed', { ...morning, temperature: 30 }, true), null);
  assert.equal(classifyCause('closed', { ...morning, alerts: ['Winter Weather Advisory'] }, true), null);

  // Below freezing it takes more: a dry gauge since the evening before and no bitter cold
  const coldAndDry = { temperature: 19, feelsLike: 12, precipIn: 0, alerts: [] };
  assert.equal(classifyCause('closed', coldAndDry, true), 'non-winter');             // e.g. an unlisted holiday in January
  assert.equal(classifyCause('closed', { ...coldAndDry, precipIn: 0.04 }, true), null);   // something fell
  assert.equal(classifyCause('closed', { ...coldAndDry, feelsLike: -12 }, true), null);   // bitter cold
  assert.equal(classifyCause('closed', { ...coldAndDry, precipIn: null }, true), null);   // gauge unknown: assume weather
  assert.equal(classifyCause('closed', coldAndDry, false), null);                         // not county-wide

  // One district closing on its own stays a weather outcome the model must answer for
  assert.equal(classifyCause('closed', morning, false), null);
  assert.equal(classifyCause('delay', morning, false), null);
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

  saveForecast(log, stormForecast(TUESDAY, new Date('2030-01-15T15:00:00Z')), {}, new Date('2030-01-15T15:00:00Z'));
  assert.deepEqual(log.find(e => e.school === 'Indiana'), scored);
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
});

test('with the weather grid down, a forecast built from nothing is not filed', async () => {
  const store = memoryStore();
  await fileStormForecast(store);
  const before = JSON.stringify(store.state.predictions);

  // 4:17 PM Monday would be before the storm night; use 1:17 AM with every forecast source gone
  const result = await logWeatherData({
    now: new Date('2030-01-15T06:17:00Z'),
    store,
    sources: stagedSources({ inputs: makeInputs(), statuses: allSchools(posted('open', MONDAY)), morning: null })
  });
  assert.equal(JSON.stringify(store.state.predictions), before);
  assert.equal(result.predictions.savedForTarget, 0);
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
