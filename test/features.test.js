const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFeatures, compactFeatures, selectAlerts, getWindows, classifyAlert, parseSnowInches, parseIceInches } = require('../api/_lib/features');
const { makeGrid, makeAlert } = require('./helpers');

const TARGET = '2030-01-15'; // a Tuesday
const eveningBefore = new Date('2030-01-15T01:30:00Z'); // Monday 8:30 PM Eastern

test('snow is totalled for the overnight window, not the next two days', () => {
  // Blocks: 1-7 PM, 7 PM-1 AM, 1-7 AM, 7 AM-1 PM, 1-7 PM
  const grid = makeGrid(TARGET, { snow: [1.2, 2.0, 1.0, 0.6, 1.2] });
  const features = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: eveningBefore });

  // Overnight is 6 PM-8 AM: one hour of the first block, two full blocks, one hour of the fourth
  assert.equal(features.snowOvernightIn, 3.3);
  // School day is 8 AM-3 PM: five hours of the fourth block, two of the fifth
  assert.equal(features.snowSchoolDayIn, 0.9);
  assert.equal(features.source, 'grid');
});

test('wind chill is the minimum between 5 and 9 AM', () => {
  // Hourly from 4 AM: the 4 AM reading (-12) is before the window
  const grid = makeGrid(TARGET, { windChill: [-12, -8, -6, -3, 2, 10, 15], temperature: [5, 6, 7, 9, 12, 18, 22] });
  const features = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: eveningBefore });
  assert.equal(features.minWindChillF, -8);
  assert.equal(features.minTempF, 6);
});

test('the lead time counts down to the 5 AM decision', () => {
  const features = buildFeatures({ targetDate: TARGET, grid: makeGrid(TARGET, { windChill: [20, 20] }), alerts: [], now: eveningBefore });
  assert.equal(features.leadHours, 9); // 8:30 PM -> 5 AM, rounded
});

test('only winter products count: freeze, frost, wind, fog and flood alerts are ignored', () => {
  for (const event of ['Freeze Warning', 'Freeze Watch', 'Frost Advisory', 'Wind Advisory',
    'High Wind Warning', 'Dense Fog Advisory', 'Flood Watch', 'Special Weather Statement']) {
    assert.equal(classifyAlert(event), null, event);
  }
  for (const event of ['Winter Weather Advisory', 'Winter Storm Warning', 'Ice Storm Warning',
    'Cold Weather Advisory', 'Extreme Cold Warning', 'Wind Chill Advisory', 'Snow Squall Warning', 'Winter Storm Watch']) {
    assert.notEqual(classifyAlert(event), null, event);
  }
});

test('an alert counts by when the weather is in effect, not when the bulletin expires', () => {
  const windows = getWindows(TARGET);
  // In effect 10 PM Monday through 10 AM Tuesday (hours relative to Monday)
  const atBusTime = makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34);
  assert.equal(selectAlerts([atBusTime], windows)[0].timing, 'bus-time');
  assert.equal(selectAlerts([atBusTime], windows)[0].weight, 0.5);

  // Ends at 11 PM Monday: over before buses run
  const endedOvernight = makeAlert('Winter Weather Advisory', '2030-01-14', 12, 23);
  assert.equal(selectAlerts([endedOvernight], windows)[0].timing, 'overnight');
  assert.equal(selectAlerts([endedOvernight], windows)[0].weight, 0.25);

  // Starts at 11 AM Tuesday: an early-dismissal risk, not a morning one
  const startsMidday = makeAlert('Winter Weather Advisory', TARGET, 11, 23);
  assert.equal(selectAlerts([startsMidday], windows)[0].timing, 'school-day');

  // Ended Monday at noon, or starts Tuesday evening: not about this morning
  assert.deepEqual(selectAlerts([makeAlert('Winter Weather Advisory', '2030-01-14', 2, 12)], windows), []);
  assert.deepEqual(selectAlerts([makeAlert('Winter Weather Advisory', TARGET, 18, 30)], windows), []);
});

test('the same advisory issued for several zones counts once', () => {
  const windows = getWindows(TARGET);
  const alerts = [
    makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34, ['PAZ077']),
    makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34, ['PAZ078']),
    makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34, ['PAZ077', 'PAZ078'])
  ];
  assert.equal(selectAlerts(alerts, windows).length, 1);
});

test('alerts for other counties never reach the prediction', () => {
  const windows = getWindows(TARGET);
  const allegheny = makeAlert('Winter Storm Warning', '2030-01-14', 22, 34, ['PAZ021']);
  assert.deepEqual(selectAlerts([allegheny], windows), []);
});

test('a district only sees alerts for its own zones', () => {
  const windows = getWindows(TARGET);
  const ridges = makeAlert('Winter Storm Warning', '2030-01-14', 22, 34, ['PAZ078']);
  const lowlands = makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34, ['PAZ077']);

  assert.deepEqual(selectAlerts([ridges, lowlands], windows, ['PAZ077']).map(a => a.event), ['Winter Weather Advisory']);
  assert.deepEqual(selectAlerts([ridges, lowlands], windows, ['PAZ078']).map(a => a.event), ['Winter Storm Warning']);
  // A district straddling both takes the stronger one
  assert.deepEqual(selectAlerts([ridges, lowlands], windows, ['PAZ077', 'PAZ078']).map(a => a.event), ['Winter Storm Warning']);
  // County-wide products (snow squalls) apply everywhere
  const squall = makeAlert('Snow Squall Warning', TARGET, 6, 7, ['PAC063']);
  assert.equal(selectAlerts([squall], windows, ['PAZ077']).length, 1);
});

test('a watch drops out once a warning or advisory covers the same morning', () => {
  const windows = getWindows(TARGET);
  const watch = makeAlert('Winter Storm Watch', '2030-01-14', 18, 40);
  const warning = makeAlert('Winter Storm Warning', '2030-01-14', 22, 34);
  assert.deepEqual(selectAlerts([watch], windows).map(a => a.event), ['Winter Storm Watch']);
  assert.deepEqual(selectAlerts([watch, warning], windows).map(a => a.event), ['Winter Storm Warning']);
});

test('snow and cold alerts are separate signals', () => {
  const windows = getWindows(TARGET);
  const alerts = [
    makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34),
    makeAlert('Cold Weather Advisory', '2030-01-14', 22, 36)
  ];
  assert.deepEqual(selectAlerts(alerts, windows).map(a => a.kind), ['storm', 'cold']);
});

test('snow amounts are read only from snow sentences', () => {
  assert.equal(parseSnowInches('New snow accumulation of 1 to 3 inches possible.'), 2);
  assert.equal(parseSnowInches('New snow accumulation of less than a half inch possible.'), 0.25);
  assert.equal(parseSnowInches('New snow accumulation of less than one inch possible.'), 0.5);
  assert.equal(parseSnowInches('New snow accumulation of around an inch possible.'), 1);
  assert.equal(parseSnowInches('Total daytime snow accumulation of 2 to 4 inches possible.'), 3);
  // Rain totals are not snow
  assert.equal(parseSnowInches('Rain. New rainfall amounts between 1 and 2 inches possible.'), 0);
  assert.equal(parseSnowInches('Little or no snow accumulation expected.'), 0);
  assert.equal(parseSnowInches('Snow showers likely. Wind chill values as low as -5.'), 0);
});

test('ice is not triggered by words that merely contain "ice"', () => {
  assert.equal(parseIceInches('Sunny and nice. Police advise caution.'), 0);
  assert.equal(parseIceInches('A chance of freezing rain before 9am.'), 0.05);
  assert.equal(parseIceInches('New ice accumulation of around a tenth of an inch possible.'), 0.1);
  assert.equal(parseIceInches('New ice accumulation of 0.1 to 0.3 of an inch possible.'), 0.2);
});

test('falls back to the worded forecast when the grid is unavailable', () => {
  const forecast = {
    periods: [
      { name: 'Tonight', isDaytime: false, startTime: '2030-01-14T18:00:00-05:00', endTime: '2030-01-15T06:00:00-05:00',
        detailedForecast: 'Snow. Low around 22. New snow accumulation of 2 to 4 inches possible.' },
      { name: 'Tuesday', isDaytime: true, startTime: '2030-01-15T06:00:00-05:00', endTime: '2030-01-15T18:00:00-05:00',
        detailedForecast: 'Snow showers. High near 28. New snow accumulation of around an inch possible.' },
      { name: 'Tuesday Night', isDaytime: false, startTime: '2030-01-15T18:00:00-05:00', endTime: '2030-01-16T06:00:00-05:00',
        detailedForecast: 'Snow. New snow accumulation of 4 to 8 inches possible.' }
    ]
  };
  const hourlyForecast = {
    periods: [
      { startTime: '2030-01-15T06:00:00-05:00', temperature: 22, windSpeed: '10 to 15 mph', shortForecast: 'Snow Likely', probabilityOfPrecipitation: 70 },
      { startTime: '2030-01-15T07:00:00-05:00', temperature: 21, windSpeed: '10 mph', shortForecast: 'Snow', probabilityOfPrecipitation: 80 }
    ]
  };
  const features = buildFeatures({ targetDate: TARGET, grid: null, forecast, hourlyForecast, alerts: [], now: eveningBefore });

  assert.equal(features.source, 'text');
  assert.equal(features.snowOvernightIn, 3);   // tonight only, not Tuesday night's 4-8"
  assert.equal(features.snowSchoolDayIn, 1);
  assert.equal(features.minTempF, 21);
  assert.equal(features.minWindChillF, 9);     // 22F with a 15 mph wind
  assert.equal(features.commutePrecip, 'snow');
});

test('once the morning is underway, the thermometer outranks the forecast', () => {
  const grid = makeGrid(TARGET, { windChill: [12, 10, 9, 9, 11], temperature: [20, 19, 18, 18, 20] });
  const current = { temperature: { fahrenheit: 8 }, windSpeed: { mph: 15 } };

  const sixAm = new Date('2030-01-15T11:00:00Z');
  assert.equal(buildFeatures({ targetDate: TARGET, grid, alerts: [], current, now: sixAm }).minWindChillF, -9);

  // The evening before, tonight's reading says nothing about tomorrow morning
  assert.equal(buildFeatures({ targetDate: TARGET, grid, alerts: [], current, now: eveningBefore }).minWindChillF, 9);
});

test('snow that has already fallen is not forgotten on the morning of', () => {
  // Evening forecast: 3.3" overnight
  const eveningGrid = makeGrid(TARGET, { snow: [1.2, 2.0, 1.0, 0.6, 1.2], windChill: [12, 11, 10, 11], temperature: [20, 19, 18, 19] });
  const evening = buildFeatures({ targetDate: TARGET, grid: eveningGrid, alerts: [], now: eveningBefore });
  assert.equal(evening.snowOvernightIn, 3.3);

  // 6 AM: the grid now starts at 1 AM, so only 1.1" of the night is left in it
  const morningGrid = makeGrid(TARGET, { snow: [1.2, 2.0, 1.0, 0.6, 1.2], windChill: [12, 11, 10, 11], temperature: [20, 19, 18, 19] });
  morningGrid.series.snowfallAmount = morningGrid.series.snowfallAmount.slice(2);
  const sixAm = new Date('2030-01-15T11:00:00Z');

  const forgetful = buildFeatures({ targetDate: TARGET, grid: morningGrid, alerts: [], now: sixAm });
  assert.equal(forgetful.snowOvernightIn, 1.1);

  // With the evening forecast on file, the hours before 1 AM are filled back in
  const remembered = buildFeatures({ targetDate: TARGET, grid: morningGrid, alerts: [], now: sixAm, onFile: evening });
  assert.equal(remembered.snowOvernightIn, 3.3);

  // ...and it survives the trip through the log's compact form
  const fromLog = buildFeatures({ targetDate: TARGET, grid: morningGrid, alerts: [], now: sixAm, onFile: compactFeatures(evening) });
  assert.equal(fromLog.snowOvernightIn, 3.3);
});

test('an unchanged forecast reads the same all night: late snow is not counted twice', () => {
  // 2.4" between 1 and 7 AM, nothing earlier. Blocks: 1-7 PM, 7 PM-1 AM, 1-7 AM, 7 AM-1 PM
  const full = makeGrid(TARGET, { snow: [0, 0, 2.4, 0], ice: [0, 0, 0.08, 0], windChill: [20, 20, 20, 20, 20], temperature: [26, 26, 26, 26, 26] });
  const evening = buildFeatures({ targetDate: TARGET, grid: full, alerts: [], now: eveningBefore });
  assert.equal(evening.snowOvernightIn, 2.4);
  assert.equal(evening.iceIn, 0.08);

  // Later in the night the grid has dropped its earliest periods. NWS shortens
  // the first remaining period and scales its amount.
  for (const [hour, keepFraction] of [[5, 2 / 6], [6.5, 0.5 / 6]]) {
    const trimmed = makeGrid(TARGET, { snow: [0, 0, 2.4, 0], ice: [0, 0, 0.08, 0], windChill: [20, 20, 20, 20, 20], temperature: [26, 26, 26, 26, 26] });
    for (const name of ['snowfallAmount', 'iceAccumulation']) {
      const [, , lateNight, morning] = trimmed.series[name];
      const cut = lateNight.end - keepFraction * (lateNight.end - lateNight.start);
      trimmed.series[name] = [{ start: cut, end: lateNight.end, value: lateNight.value * keepFraction }, morning];
    }
    const now = new Date(Date.parse('2030-01-15T05:00:00Z') + hour * 3600 * 1000);
    const later = buildFeatures({ targetDate: TARGET, grid: trimmed, alerts: [], now, onFile: compactFeatures(evening) });
    assert.equal(later.snowOvernightIn, 2.4, `at ${hour} AM`);
    assert.equal(later.iceIn, 0.08, `at ${hour} AM`);
  }
});

test('before the night begins, a newer forecast simply replaces the one on file', () => {
  const afternoon = new Date('2030-01-14T19:00:00Z'); // Monday 2 PM Eastern
  const stormy = makeGrid(TARGET, { snow: [0, 3, 3, 0], ice: [0, 0.1, 0.1, 0], windChill: [-15, -15, -15, -15], temperature: [0, 0, 0, 0] });
  const onFile = compactFeatures(buildFeatures({ targetDate: TARGET, grid: stormy, alerts: [], now: new Date('2030-01-14T15:00:00Z') }));
  assert.equal(onFile.snowOvernightIn, 6);

  const grid = makeGrid(TARGET, { snow: [0, 0.5, 0.5, 0], ice: [0, 0, 0, 0], windChill: [15, 14, 14, 16], temperature: [22, 21, 21, 23] });
  const features = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: afternoon, onFile });
  assert.equal(features.snowOvernightIn, 1);
  assert.equal(features.iceIn, 0);
  assert.equal(features.minWindChillF, 14);
});

test('a newer, milder forecast is never overridden by the colder one on file', () => {
  // On file from the evening: -11 F and freezing drizzle. Overnight update: -4 F, dry.
  const onFile = { snowOvernightIn: 0, iceIn: 0, minWindChillF: -11, minTempF: 6, commutePrecip: 'ice', alerts: [], snowBlocks: [], iceBlocks: [] };
  const grid = makeGrid(TARGET, { snow: [0, 0, 0, 0], ice: [0, 0, 0, 0], windChill: [-3, -4, -4, -2, 0], temperature: [10, 9, 9, 11, 13] });
  const sixAm = new Date('2030-01-15T11:00:00Z');
  const features = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: sixAm, onFile });
  assert.equal(features.minWindChillF, -4);
  assert.equal(features.minTempF, 9);
  assert.equal(features.commutePrecip, null);
});

test('with NWS unreachable overnight, the forecast on file still stands', () => {
  const onFile = { snowOvernightIn: 4.2, iceIn: 0.05, minWindChillF: 8, minTempF: 18, commutePrecip: 'snow' };
  const sixAm = new Date('2030-01-15T11:00:00Z');
  const features = buildFeatures({ targetDate: TARGET, grid: null, alerts: [], now: sixAm, onFile });
  assert.equal(features.snowOvernightIn, 4.2);
  assert.equal(features.iceIn, 0.05);
  assert.equal(features.minWindChillF, 8);
  assert.equal(features.commutePrecip, 'snow');
  assert.equal(features.source, 'on-file');
});

test('an alert that ran its course still counts; one that was cancelled does not', () => {
  // Winter Storm Warning from 4 PM Monday until 1 AM Tuesday
  const warning = makeAlert('Winter Storm Warning', '2030-01-14', 16, 25);
  const grid = makeGrid(TARGET, { snow: [0, 4, 0, 0], windChill: [22, 22, 22, 22], temperature: [28, 28, 28, 28] });

  const tenPm = new Date('2030-01-15T03:00:00Z');
  const evening = buildFeatures({ targetDate: TARGET, grid, alerts: [warning], now: tenPm });
  assert.deepEqual(evening.alerts.map(a => `${a.event}@${a.timing}`), ['Winter Storm Warning@overnight']);
  const onFile = compactFeatures(evening);
  assert.deepEqual(onFile.alertEnds, [warning.ends]);

  // 1:17 AM: NWS has dropped the warning from its feed because it ended at 1 AM
  const afterItEnded = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: new Date('2030-01-15T06:17:00Z'), onFile });
  assert.deepEqual(afterItEnded.alerts.map(a => `${a.event}@${a.timing}`), ['Winter Storm Warning@overnight']);
  assert.equal(afterItEnded.alerts[0].weight, evening.alerts[0].weight);

  // 11 PM: the warning is gone from the feed two hours before its end: cancelled
  const cancelled = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: new Date('2030-01-15T04:00:00Z'), onFile });
  assert.deepEqual(cancelled.alerts, []);

  // 11 PM, but the feed itself could not be read: keep what was known
  const feedDown = buildFeatures({ targetDate: TARGET, grid, alerts: [], alertsAvailable: false, now: new Date('2030-01-15T04:00:00Z'), onFile });
  assert.deepEqual(feedDown.alerts.map(a => a.event), ['Winter Storm Warning']);
  assert.equal(feedDown.alertsAvailable, false);
});

test('an advisory that expires at 7 AM still explains the morning at 7:05', () => {
  const advisory = makeAlert('Winter Weather Advisory', '2030-01-14', 22, 31); // 10 PM - 7 AM
  const grid = makeGrid(TARGET, { snow: [0, 1.2, 1.2, 0], windChill: [20, 20, 20, 20, 20], temperature: [26, 26, 26, 26, 26] });
  const onFile = compactFeatures(buildFeatures({ targetDate: TARGET, grid, alerts: [advisory], now: eveningBefore }));

  const sevenOhFive = new Date('2030-01-15T12:05:00Z');
  const features = buildFeatures({ targetDate: TARGET, grid, alerts: [], now: sevenOhFive, onFile });
  assert.deepEqual(features.alerts.map(a => `${a.event}@${a.timing}`), ['Winter Weather Advisory@bus-time']);
});
