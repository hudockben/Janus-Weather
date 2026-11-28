const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFixedHoliday, getNonSchoolReason, isSchoolDay, getTargetSchoolDay, isWinterSeason, loadNonWeatherClosures
} = require('../api/_lib/schoolCalendar');

test('Thanksgiving is the fourth Thursday of November, plus the Friday', () => {
  assert.equal(getFixedHoliday('2026-11-26'), 'Thanksgiving');
  assert.equal(getFixedHoliday('2026-11-27'), 'Thanksgiving break');
  assert.equal(getFixedHoliday('2026-11-25'), null);
  assert.equal(getFixedHoliday('2027-11-25'), 'Thanksgiving');
  assert.equal(getFixedHoliday('2028-11-23'), 'Thanksgiving');
});

test('winter break runs Dec 24 through Jan 1', () => {
  assert.equal(getFixedHoliday('2026-12-23'), null);
  assert.equal(getFixedHoliday('2026-12-24'), 'Winter break');
  assert.equal(getFixedHoliday('2027-01-01'), 'Winter break');
  assert.equal(getFixedHoliday('2027-01-04'), null);
});

test('holidays every district shares are built in', () => {
  // Easter moves: 2026-04-05, 2027-03-28, 2030-04-21
  assert.equal(getFixedHoliday('2026-04-03'), 'Good Friday');
  assert.equal(getFixedHoliday('2026-04-06'), 'Easter Monday');
  assert.equal(getFixedHoliday('2027-03-26'), 'Good Friday');
  assert.equal(getFixedHoliday('2027-03-29'), 'Easter Monday');
  assert.equal(getFixedHoliday('2030-04-19'), 'Good Friday');
  assert.equal(getFixedHoliday('2027-03-25'), null);

  assert.equal(getFixedHoliday('2026-05-25'), 'Memorial Day');
  assert.equal(getFixedHoliday('2027-05-31'), 'Memorial Day');
  assert.equal(getFixedHoliday('2027-05-24'), null);
  assert.equal(getFixedHoliday('2026-09-07'), 'Labor Day');
  assert.equal(getFixedHoliday('2027-09-06'), 'Labor Day');
  assert.equal(getFixedHoliday('2027-09-13'), null);
});

test('mid-June to mid-August is summer break', () => {
  assert.equal(getFixedHoliday('2027-06-14'), null);
  assert.equal(getFixedHoliday('2027-06-15'), 'Summer break');
  assert.equal(getFixedHoliday('2027-07-20'), 'Summer break');
  assert.equal(getFixedHoliday('2027-08-15'), 'Summer break');
  assert.equal(getFixedHoliday('2027-08-16'), null);
  // A forecast made the last evening before the break looks to mid-August
  assert.equal(getTargetSchoolDay(new Date('2027-06-14T23:00:00Z')), '2027-08-16');
});

test('days that vary by district are not assumed', () => {
  assert.equal(getFixedHoliday('2027-01-18'), null); // MLK Day
  assert.equal(getFixedHoliday('2027-02-15'), null); // Presidents' Day
});

test('the shipped calendar file is well formed', () => {
  const closures = loadNonWeatherClosures();
  assert.ok(Array.isArray(closures) && closures.length > 0);
  for (const entry of closures) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.schools === 'all' || typeof entry.schools === 'string' || Array.isArray(entry.schools));
    assert.equal(typeof entry.reason, 'string');
  }
});

test('weekends and listed closures are not school days', () => {
  assert.equal(getNonSchoolReason('2026-11-28'), 'Weekend');
  assert.equal(isSchoolDay('2026-12-01'), true);
  // Listed in nonWeatherClosures.json
  assert.equal(getNonSchoolReason('2026-04-03'), 'Good Friday');
  // A single district's in-service day only applies to that district
  assert.equal(getNonSchoolReason('2026-02-09', 'Indiana'), 'Teacher inservice day');
  assert.equal(getNonSchoolReason('2026-02-09', 'United'), null);
  assert.equal(getNonSchoolReason('2026-02-09'), null);
});

test('the forecast targets the next school morning', () => {
  // Tuesday 9 PM -> Wednesday
  assert.equal(getTargetSchoolDay(new Date('2026-12-02T02:00:00Z')), '2026-12-02');
  // Wednesday 6 AM -> still this morning
  assert.equal(getTargetSchoolDay(new Date('2026-12-02T11:00:00Z')), '2026-12-02');
  // Wednesday noon -> Thursday
  assert.equal(getTargetSchoolDay(new Date('2026-12-02T17:00:00Z')), '2026-12-03');
});

test('Friday afternoon forecasts Monday, not Saturday', () => {
  assert.equal(getTargetSchoolDay(new Date('2026-12-04T20:00:00Z')), '2026-12-07');
  // Sunday evening -> Monday
  assert.equal(getTargetSchoolDay(new Date('2026-12-07T01:00:00Z')), '2026-12-07');
});

test('breaks are skipped: the day before Thanksgiving forecasts the following Monday', () => {
  assert.equal(getTargetSchoolDay(new Date('2026-11-25T22:00:00Z')), '2026-11-30');
});

test('the rollover hour is configurable for the logger', () => {
  const sevenThirtyAm = new Date('2026-12-02T12:30:00Z');
  assert.equal(getTargetSchoolDay(sevenThirtyAm), '2026-12-02');
  assert.equal(getTargetSchoolDay(sevenThirtyAm, { cutoffHour: 3 }), '2026-12-03');
});

test('winter season is November through March', () => {
  assert.equal(isWinterSeason('2026-11-01'), true);
  assert.equal(isWinterSeason('2027-03-31'), true);
  assert.equal(isWinterSeason('2026-10-31'), false);
  assert.equal(isWinterSeason('2027-04-01'), false);
});
