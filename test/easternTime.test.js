const test = require('node:test');
const assert = require('node:assert/strict');
const { easternParts, easternToMs, addDays, dayOfWeek, weekdayName } = require('../api/_lib/easternTime');

test('reads Eastern wall-clock time from a UTC instant', () => {
  // 12:30 UTC is 7:30 AM in winter (EST) and 8:30 AM in summer (EDT)
  assert.deepEqual(
    pick(easternParts('2026-01-15T12:30:00Z')), { dateStr: '2026-01-15', hour: 7, minute: 30, dow: 4 });
  assert.deepEqual(
    pick(easternParts('2026-07-15T12:30:00Z')), { dateStr: '2026-07-15', hour: 8, minute: 30, dow: 3 });
});

test('a late-evening run still belongs to the Eastern calendar day', () => {
  // 00:10 UTC on Nov 24 is 7:10 PM on Monday Nov 23 in Indiana, PA
  assert.deepEqual(
    pick(easternParts('2026-11-24T00:10:46Z')), { dateStr: '2026-11-23', hour: 19, minute: 10, dow: 1 });
});

test('midnight is hour 0, not 24', () => {
  assert.equal(easternParts('2026-01-15T05:00:00Z').hour, 0);
});

test('converts Eastern wall-clock time to an instant across daylight saving', () => {
  assert.equal(new Date(easternToMs('2026-01-15', 6)).toISOString(), '2026-01-15T11:00:00.000Z'); // EST
  assert.equal(new Date(easternToMs('2026-07-15', 6)).toISOString(), '2026-07-15T10:00:00.000Z'); // EDT
  // The mornings of the clock changes themselves
  assert.equal(new Date(easternToMs('2026-03-08', 6)).toISOString(), '2026-03-08T10:00:00.000Z');
  assert.equal(new Date(easternToMs('2026-11-01', 6)).toISOString(), '2026-11-01T11:00:00.000Z');
  assert.equal(new Date(easternToMs('2026-03-07', 18)).toISOString(), '2026-03-07T23:00:00.000Z');
});

test('calendar arithmetic', () => {
  assert.equal(addDays('2026-11-27', 3), '2026-11-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayOfWeek('2026-11-26'), 4);
  assert.equal(weekdayName('2026-11-30'), 'Monday');
});

function pick({ dateStr, hour, minute, dow }) {
  return { dateStr, hour, minute, dow };
}
