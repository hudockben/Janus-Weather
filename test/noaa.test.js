const test = require('node:test');
const assert = require('node:assert/strict');
const { isAlertInForce, parseValidTime, calculateWindChill } = require('../api/_lib/noaa');

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
