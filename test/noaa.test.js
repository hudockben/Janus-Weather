const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAlertInForce, buildAlertTimeline, parseValidTime, calculateWindChill, getAlerts, getGridForecast, getObservedWindow
} = require('../api/_lib/noaa');

// Answer the NWS API locally. `routes` maps a URL fragment to a JSON body;
// every URL requested is recorded.
async function withNws(routes, run) {
  const realFetch = global.fetch;
  const requested = [];
  global.fetch = async url => {
    requested.push(String(url));
    const match = Object.keys(routes).find(fragment => String(url).includes(fragment));
    if (!match) return { ok: false, status: 404, statusText: 'not staged', json: async () => ({}) };
    return { ok: true, status: 200, statusText: 'OK', json: async () => routes[match] };
  };
  try {
    return await run(requested);
  } finally {
    global.fetch = realFetch;
  }
}

const POINT = {
  properties: {
    forecastGridData: 'https://api.weather.gov/gridpoints/PBZ/106,78',
    observationStations: 'https://api.weather.gov/gridpoints/PBZ/106,78/stations'
  }
};
const STATIONS = { features: [{ properties: { stationIdentifier: 'KIDI', name: 'Indiana County Airport' } }] };

// Shapes taken from the live api.weather.gov feed
const advisory = {
  status: 'Actual', messageType: 'Alert', response: 'Execute', event: 'Winter Weather Advisory',
  parameters: { VTEC: ['/O.NEW.KPBZ.WW.Y.0012.261202T0300Z-261202T1500Z/'] }
};

test('alerts in force are kept, including continuations and extensions', () => {
  assert.equal(isAlertInForce(advisory), true);
  for (const action of ['CON', 'EXT', 'EXA', 'EXB', 'COR', 'EXP']) {
    const update = { ...advisory, messageType: 'Update', parameters: { VTEC: [`/O.${action}.KPBZ.WW.Y.0012.261202T0300Z-261202T1500Z/`] } };
    assert.equal(isAlertInForce(update), true, action);
  }
  // Products without VTEC (and feeds that omit optional fields) are not dropped
  assert.equal(isAlertInForce({ event: 'Winter Weather Advisory' }), true);
  assert.equal(isAlertInForce({ ...advisory, parameters: {} }), true);
});

test('a cancellation notice left in the active feed is not an alert in force', () => {
  // NWS keeps "has been cancelled" listed until the original end time
  const cancelled = {
    status: 'Actual', messageType: 'Alert', response: 'AllClear', event: 'Winter Weather Advisory',
    headline: 'The Winter Weather Advisory has been cancelled.',
    parameters: { VTEC: ['/O.CAN.KILX.WW.Y.0021.000000T0000Z-261127T0000Z/'] }
  };
  assert.equal(isAlertInForce(cancelled), false);
  assert.equal(isAlertInForce({ ...cancelled, response: 'Avoid' }), false);          // VTEC alone says so
  assert.equal(isAlertInForce({ ...advisory, messageType: 'Cancel' }), false);
  // Upgraded to another product: the old one no longer stands
  assert.equal(isAlertInForce({ ...advisory, parameters: { VTEC: ['/O.UPG.KPBZ.WS.A.0003.261202T0300Z-261202T1500Z/'] } }), false);
});

test('test messages are ignored', () => {
  assert.equal(isAlertInForce({ status: 'Test', messageType: 'Alert', event: 'Test Message' }), false);
  assert.equal(isAlertInForce({ ...advisory, status: 'Exercise' }), false);
});

test('grid period strings', () => {
  assert.deepEqual(parseValidTime('2026-11-25T12:00:00+00:00/PT6H'), { start: Date.parse('2026-11-25T12:00:00Z'), end: Date.parse('2026-11-25T18:00:00Z') });
  assert.equal(parseValidTime('2026-11-25T12:00:00+00:00/P1DT6H').end, Date.parse('2026-11-26T18:00:00Z'));
  assert.equal(parseValidTime('2026-11-25T12:00:00+00:00/P7D').end, Date.parse('2026-12-02T12:00:00Z'));
});

test('wind chill follows the NWS chart', () => {
  assert.equal(calculateWindChill(0, 15), -19);
  assert.equal(calculateWindChill(27, 11), 17);
  assert.equal(calculateWindChill(55, 20), 55);   // not defined above 50 F
  assert.equal(calculateWindChill(20, 2), 20);    // or in calm air
  assert.equal(calculateWindChill(null, 5), null);
});

// ---------- what is asked of NWS, and how its answers are read ----------

test('alerts are requested for Indiana County\'s own zones', async () => {
  await withNws({ '/alerts/active': { features: [] } }, async requested => {
    await getAlerts();
    const url = requested.find(u => u.includes('/alerts/active'));
    const zones = new URL(url).searchParams.get('zone').split(',');
    for (const zone of ['PAZ077', 'PAZ078', 'PAC063']) assert.ok(zones.includes(zone), zone);
    // The zones the old query used for central Pennsylvania are gone
    assert.ok(!zones.includes('PAZ018') && !zones.includes('PAZ019'));
  });
});

test('an alert is read with the end of the weather, not the expiry of the bulletin', async () => {
  const feature = (event, ugc, extra = {}) => ({
    properties: {
      id: event, event, status: 'Actual', messageType: 'Alert', response: 'Execute',
      onset: '2026-12-01T22:00:00-05:00', ends: '2026-12-02T10:00:00-05:00', expires: '2026-12-02T04:00:00-05:00',
      areaDesc: ugc.includes('PAZ021') ? 'Allegheny' : 'Indiana', geocode: { UGC: ugc }, ...extra
    }
  });
  const feed = {
    features: [
      feature('Winter Storm Warning', ['PAZ021']),                       // Pittsburgh only
      feature('Winter Weather Advisory', ['PAZ077', 'PAZ078']),
      feature('Winter Storm Watch', ['PAZ077'], { response: 'AllClear' }), // cancelled, still listed
      feature('Snow Squall Warning', ['PAC063'], { ends: null })
    ]
  };
  await withNws({ '/alerts/active': feed }, async () => {
    const { alerts, count } = await getAlerts();
    assert.equal(count, 3);
    // Indiana County's alerts lead the list
    assert.deepEqual(alerts.map(a => a.event), ['Winter Weather Advisory', 'Snow Squall Warning', 'Winter Storm Warning']);
    assert.deepEqual(alerts.map(a => a.affectsIndianaCounty), [true, true, false]);
    assert.equal(alerts[0].ends, '2026-12-02T10:00:00-05:00');
    assert.equal(alerts[0].onset, '2026-12-01T22:00:00-05:00');
    assert.deepEqual(alerts[0].zones, ['PAZ077', 'PAZ078']);
    // With no end time given, the bulletin expiry is the best available
    assert.equal(alerts[1].ends, '2026-12-02T04:00:00-05:00');
  });
});

test('grid values are converted from metric', async () => {
  const at = (hour, duration, value) => ({ validTime: `2026-12-02T${String(hour).padStart(2, '0')}:00:00+00:00/${duration}`, value });
  const grid = {
    properties: {
      updateTime: '2026-12-01T23:00:00+00:00',
      snowfallAmount: { uom: 'wmoUnit:mm', values: [at(0, 'PT6H', 25.4), at(6, 'PT6H', 50.8), at(12, 'PT6H', null)] },
      iceAccumulation: { uom: 'wmoUnit:mm', values: [at(0, 'PT6H', 2.54)] },
      windChill: { uom: 'wmoUnit:degC', values: [at(10, 'PT1H', -20), at(11, 'PT2H', -10)] },
      apparentTemperature: { uom: 'wmoUnit:degC', values: [at(10, 'PT1H', -20)] },
      temperature: { uom: 'wmoUnit:degC', values: [at(10, 'PT1H', 0), at(11, 'PT1H', -5)] },
      windSpeed: { uom: 'wmoUnit:km_h-1', values: [at(10, 'PT1H', 16.0934)] },
      probabilityOfPrecipitation: { uom: 'wmoUnit:percent', values: [at(10, 'PT1H', 80)] },
      weather: { values: [at(10, 'PT2H', [{ coverage: 'likely', weather: 'snow', intensity: 'light' }, { coverage: null, weather: null }])] }
    }
  };
  await withNws({ '/points/': POINT, '/gridpoints/PBZ/106,78': grid }, async () => {
    const { series, updated } = await getGridForecast({ lat: 40.6215, lon: -79.1525 });
    assert.equal(updated, '2026-12-01T23:00:00+00:00');
    assert.deepEqual(series.snowfallAmount.map(p => p.value), [1, 2, null]);          // inches
    assert.equal(series.snowfallAmount[0].end - series.snowfallAmount[0].start, 6 * 3600 * 1000);
    assert.ok(Math.abs(series.iceAccumulation[0].value - 0.1) < 1e-9);
    assert.deepEqual(series.windChill.map(p => p.value), [-4, 14]);                    // deg F
    assert.deepEqual(series.temperature.map(p => p.value), [32, 23]);
    assert.ok(Math.abs(series.windSpeed[0].value - 10) < 0.001);                        // mph
    assert.deepEqual(series.weather[0].types, [{ coverage: 'likely', weather: 'snow', intensity: 'light' }]);
  });
});

test('the station reading is the minimum over the window asked for, with the gauge total', async () => {
  const report = (time, tempC, windKmh, precipMm = null, visibilityM = 16090) => ({
    properties: {
      timestamp: time,
      temperature: { value: tempC },
      windSpeed: { value: windKmh },
      precipitationLastHour: { value: precipMm },
      visibility: { value: visibilityM }
    }
  });
  const observations = {
    features: [
      report('2026-12-02T13:55:00+00:00', -4, 20),        // 8:55 AM
      report('2026-12-02T11:55:00+00:00', -9, 24, 0.5),   // 6:55 AM: the low
      report('2026-12-02T11:35:00+00:00', -8, 20, 0.5),   // same clock hour: gauge total counted once
      report('2026-12-02T10:15:00+00:00', -6, null),      // 5:15 AM, calm reported as missing wind
      report('2026-12-02T04:55:00+00:00', -15, 30, 1.27, 1287), // 11:55 PM: before the window, but its precipitation and 0.8-mile visibility count
      report('2026-12-02T10:35:00+00:00', null, 10)       // no temperature: skipped
    ]
  };
  const start = Date.parse('2026-12-02T10:00:00Z');   // 5 AM Eastern
  const end = Date.parse('2026-12-02T14:00:00Z');     // 9 AM Eastern
  const evening = Date.parse('2026-12-01T23:00:00Z'); // 6 PM the evening before

  await withNws({ '/points/': POINT, '/stations/KIDI/observations': observations, '/stations': STATIONS }, async requested => {
    const morning = await getObservedWindow('indiana', start, end, { precipFromMs: evening });
    assert.equal(morning.count, 4);
    assert.equal(morning.minTempF, 16);          // -9 C, not the -15 C from before the window
    assert.equal(morning.minWindChillF, 1);      // 15.8 F in a 15 mph wind
    assert.equal(morning.precipIn, 0.07);        // 0.5 mm + 1.27 mm
    assert.equal(morning.minVisibilityMi, 0.8);  // the lowest since the evening before

    const url = new URL(requested.find(u => u.includes('/observations')));
    assert.equal(url.searchParams.get('start'), '2026-12-01T23:00:00.000Z');
    assert.equal(url.searchParams.get('end'), '2026-12-02T14:00:00.000Z');

    // Without the gauge option only the window itself is requested
    const plain = await getObservedWindow('indiana', start, end);
    assert.equal(plain.precipIn, undefined);
    assert.equal(plain.minVisibilityMi, undefined);
  });

  await withNws({ '/points/': POINT, '/stations/KIDI/observations': { features: [] }, '/stations': STATIONS }, async () => {
    assert.equal(await getObservedWindow('indiana', start, end), null);
  });
});

// ---------- when each alert was really in force ----------

// One message from the NWS alert feeds. `vtec` is "ACTION.PRODUCT.NUMBER begin-end"
// with times as yymmddThhmmZ (zeros = already under way).
let messageCount = 0;
function message(event, sent, vtec, zones, extra = {}) {
  const [action, product, number, times] = vtec.split(' ');
  return {
    properties: {
      id: `urn:test:${++messageCount}`,
      status: 'Actual', event, sent,
      messageType: action === 'NEW' ? 'Alert' : (action === 'CAN' || action === 'UPG' ? 'Cancel' : 'Update'),
      geocode: { UGC: zones },
      parameters: { VTEC: [`/O.${action}.KPBZ.${product}.${number}.${times}/`] },
      ...extra
    }
  };
}
const summary = timeline => timeline.map(t => `${t.zones[0]} ${t.event} ${t.onset.slice(5, 16)} to ${t.ends.slice(5, 16)}${t.cancelled ? ' cancelled' : ''}`);

test('an alert that ran its course is read from its last message', () => {
  // Advisory issued Monday afternoon for 10 PM - 7 AM EST, continued overnight, expired on time
  const timeline = buildAlertTimeline([
    message('Winter Weather Advisory', '2030-01-14T20:10:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077', 'PAZ078']),
    message('Winter Weather Advisory', '2030-01-15T08:20:00Z', 'CON WW.Y 0003 000000T0000Z-300115T1200Z', ['PAZ077', 'PAZ078']),
    message('Winter Weather Advisory', '2030-01-15T11:58:00Z', 'EXP WW.Y 0003 000000T0000Z-300115T1200Z', ['PAZ077', 'PAZ078'])
  ]);
  assert.deepEqual(summary(timeline), [
    'PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T12:00',
    'PAZ078 Winter Weather Advisory 01-15T03:00 to 01-15T12:00'
  ]);
});

test('a cancelled alert ends when it was cancelled; one cancelled before it began never was', () => {
  const issued = message('Winter Weather Advisory', '2030-01-14T20:10:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077']);
  const cancelledAt4am = message('Winter Weather Advisory', '2030-01-15T09:00:00Z', 'CAN WW.Y 0003 000000T0000Z-300115T1200Z', ['PAZ077']);
  assert.deepEqual(summary(buildAlertTimeline([cancelledAt4am, issued])),
    ['PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T09:00 cancelled']);

  const cancelledAt9pm = message('Winter Weather Advisory', '2030-01-15T02:00:00Z', 'CAN WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077']);
  assert.deepEqual(buildAlertTimeline([issued, cancelledAt9pm]), []);
});

test('an alert extended or cut short carries its final times', () => {
  const issued = message('Winter Weather Advisory', '2030-01-14T20:10:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077']);
  const shortened = message('Winter Weather Advisory', '2030-01-15T07:00:00Z', 'EXT WW.Y 0003 000000T0000Z-300115T0900Z', ['PAZ077']);
  assert.deepEqual(summary(buildAlertTimeline([issued, shortened])), ['PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T09:00']);

  const extended = message('Winter Weather Advisory', '2030-01-15T07:00:00Z', 'EXT WW.Y 0003 000000T0000Z-300115T1500Z', ['PAZ077']);
  assert.deepEqual(summary(buildAlertTimeline([issued, extended])), ['PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T15:00']);
});

test('each zone follows its own messages: cancelled for one, upgraded for another', () => {
  // As NWS did on 25 Nov 2026 with a Wind Advisory: continued for PAZ077,
  // upgraded to a warning for PAZ078 before it began
  const timeline = buildAlertTimeline([
    message('Winter Weather Advisory', '2030-01-14T12:00:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077', 'PAZ078']),
    message('Winter Weather Advisory', '2030-01-14T18:00:00Z', 'CON WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077']),
    message('Winter Weather Advisory', '2030-01-14T18:00:00Z', 'UPG WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ078']),
    message('Winter Storm Warning', '2030-01-14T18:00:00Z', 'NEW WS.W 0001 300115T0300Z-300115T1500Z', ['PAZ078'])
  ]);
  assert.deepEqual(summary(timeline).sort(), [
    'PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T12:00',
    'PAZ078 Winter Storm Warning 01-15T03:00 to 01-15T15:00'
  ]);
});

test('test messages, other counties and repeats of the same message are left out of the timeline', () => {
  const real = message('Winter Weather Advisory', '2030-01-14T20:10:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T1200Z', ['PAZ077']);
  const timeline = buildAlertTimeline([
    real,
    real, // the same message arrives in both the history and the active feed
    message('Winter Storm Warning', '2030-01-14T20:10:00Z', 'NEW WS.W 0009 300115T0300Z-300115T1200Z', ['PAZ077'], { status: 'Test' }),
    message('Winter Storm Warning', '2030-01-14T20:10:00Z', 'NEW WS.W 0002 300115T0300Z-300115T1200Z', ['PAZ021'])
  ]);
  assert.deepEqual(summary(timeline), ['PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T12:00']);
});

test('with history, alerts come back with a timeline built from both feeds', async () => {
  const ended = message('Winter Weather Advisory', '2030-01-14T20:10:00Z', 'NEW WW.Y 0003 300115T0300Z-300115T0600Z', ['PAZ077']);
  const active = message('Cold Weather Advisory', '2030-01-15T08:00:00Z', 'NEW CW.Y 0001 300115T0900Z-300115T1500Z', ['PAZ077'], { onset: '2030-01-15T09:00:00Z', ends: '2030-01-15T15:00:00Z' });

  await withNws({ '/alerts/active': { features: [active] }, '/alerts?zone=': { features: [ended, active] } }, async requested => {
    const result = await getAlerts({ history: true, now: new Date('2030-01-15T10:00:00Z') });
    assert.deepEqual(result.alerts.map(a => a.event), ['Cold Weather Advisory']);
    assert.deepEqual(summary(result.timeline), [
      'PAZ077 Winter Weather Advisory 01-15T03:00 to 01-15T06:00',
      'PAZ077 Cold Weather Advisory 01-15T09:00 to 01-15T15:00'
    ]);
    // Indiana County's own codes, the last three days
    const historyUrl = requested.find(url => url.includes('/alerts?zone='));
    assert.match(historyUrl, /zone=PAZ077,PAZ078,PAC063&start=2030-01-12T10:00:00\.000Z/);
  });

  // History unreadable: the active alerts still come back, with no timeline
  await withNws({ '/alerts/active': { features: [active] } }, async () => {
    const result = await getAlerts({ history: true });
    assert.deepEqual(result.alerts.map(a => a.event), ['Cold Weather Advisory']);
    assert.equal(result.timeline, null);
  });

  // Not asked for: one request, no timeline
  await withNws({ '/alerts/active': { features: [active] } }, async requested => {
    const result = await getAlerts();
    assert.equal(result.timeline, null);
    assert.equal(requested.length, 1);
  });
});
