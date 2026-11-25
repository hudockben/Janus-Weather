const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSchoolCast, findSchoolCastEntry, classifyStatusText, scoreDisruption, calculateDelayProbability,
  predictAllDistricts, isNonWeatherRecord
} = require('../api/_lib/schoolDelay');
const { makeGrid, makeAlert, makeInputs } = require('./helpers');

const TARGET = '2030-01-15'; // a Tuesday
const eveningBefore = new Date('2030-01-15T01:30:00Z'); // Monday 8:30 PM Eastern

// The SchoolCast page layout, trimmed to what the parser reads
function schoolCastPage(date, districts) {
  const blocks = Object.entries(districts).map(([name, value]) => {
    const [status, note] = Array.isArray(value) ? value : [value, ''];
    return `
      <div class="sc_entity" style="color:#555;background-color:a6cf8a;display:block;" >
        <p class="sc_entname">${name}</p>
        <p class="sc_entstatus">${status}</p>
        <div style="clear: both;"></div>
        ${note ? `<p class="sc_entmsg">${note}</p>` : ''}
      </div>`;
  }).join('\n');
  return `<html><body><div id="pageheader"><h4>Status for ${date}</h4></div>
    <div class="sc_content"><h2>Indiana County</h2>${blocks}<h3></h3></div>
    <div id="disclaimer"><p>Updates may be reported elsewhere. Offices closed on holidays.</p></div></body></html>`;
}

test('reads each district status and the date the page is for', () => {
  const page = schoolCastPage('Tuesday, December 1, 2026', {
    'Homer-Center': 'Open',
    'Indiana Area': '2 Hour Delay',
    'Marion Center Area': 'Open',
    'Penns Manor Area': 'Closed',
    'Purchase Line': 'Open',
    'United': 'Flexible Instruction Day'
  });
  const parsed = parseSchoolCast(page);

  assert.equal(parsed.statusDate, '2026-12-01');
  assert.equal(parsed.entries['indiana area'].status, '2-hour delay');
  assert.equal(parsed.entries['penns manor area'].status, 'closed');
  assert.equal(parsed.entries['united'].status, 'flexible instruction');
  assert.equal(parsed.entries['homer-center'].status, 'open');
  assert.equal(parsed.entries['purchase line'].status, 'open');
});

test('a note mentioning "closed" does not turn a delay into a closure', () => {
  const page = schoolCastPage('Tuesday, December 1, 2026', {
    'Indiana Area': ['2 Hour Delay', 'No AM kindergarten. District offices closed until 10.'],
    'Marion Center Area': 'Open'
  });
  const parsed = parseSchoolCast(page);
  assert.equal(parsed.entries['indiana area'].status, '2-hour delay');
  assert.match(parsed.entries['indiana area'].detail, /offices closed/);
});

test('one district closing never changes its neighbors', () => {
  const page = schoolCastPage('Tuesday, December 1, 2026', {
    'Purchase Line': 'Open',
    'River Valley': 'Closed',
    'United': 'Open',
    'Indiana County Technology Center': 'Closed'
  });
  const parsed = parseSchoolCast(page);
  assert.equal(parsed.entries['purchase line'].status, 'open');
  assert.equal(parsed.entries['united'].status, 'open');
  // The last district's note must not pick up the page footer
  assert.equal(parsed.entries['indiana county technology center'].detail, '');
});

test('a closure with a remote-learning note is a flexible instruction day', () => {
  const page = schoolCastPage('Tuesday, December 1, 2026', { 'United': ['Closed', 'Flexible Instruction Day #2'] });
  assert.equal(parseSchoolCast(page).entries['united'].status, 'flexible instruction');
});

test('districts are found by name, and a missing district is not assumed open', () => {
  const { entries } = parseSchoolCast(schoolCastPage('Tuesday, December 1, 2026', {
    'Homer-Center': 'Open',
    'Indiana Area': 'Closed',
    'Indiana County Technology Center': 'Open',
    'Marion Center Area': '2 Hour Delay',
    'United': 'Open'
  }));
  assert.equal(findSchoolCastEntry(entries, 'IASD').status, 'closed');        // not the Technology Center
  assert.equal(findSchoolCastEntry(entries, 'MCASD').status, '2-hour delay'); // "Marion Center Area"
  assert.equal(findSchoolCastEntry(entries, 'HCSD').status, 'open');
  assert.equal(findSchoolCastEntry(entries, 'USD').status, 'open');
  assert.equal(findSchoolCastEntry(entries, 'PLSD'), null);                   // not listed: unknown
});

test('returns null when the page has no district blocks', () => {
  assert.equal(parseSchoolCast('<html><body>Service unavailable</body></html>'), null);
  assert.equal(parseSchoolCast(null), null);
});

test('status labels', () => {
  assert.equal(classifyStatusText('Open'), 'open');
  assert.equal(classifyStatusText('Closed'), 'closed');
  assert.equal(classifyStatusText('Two-Hour Delay'), '2-hour delay');
  assert.equal(classifyStatusText('Delayed'), 'delayed');
  assert.equal(classifyStatusText('Early Dismissal'), 'early dismissal');
  assert.equal(classifyStatusText('Remote Learning Day'), 'flexible instruction');
  assert.equal(classifyStatusText('See website'), 'unknown');
});

const quiet = { targetDate: TARGET, snowOvernightIn: 0, snowSchoolDayIn: 0, iceIn: 0, minTempF: 30, minWindChillF: 25, commutePrecip: null, alerts: [] };
const alertFeature = (event, kind, level, weight, timing = 'bus-time') => ({ event, kind, level, weight, timing });

test('a quiet morning scores zero', () => {
  const result = scoreDisruption(quiet);
  assert.equal(result.probability, 0);
  assert.equal(result.predictedDisruption, false);
  assert.equal(result.status, 'minimal');
  assert.deepEqual(result.factors, []);
});

test('an advisory with an inch of snow is a likely delay', () => {
  const result = scoreDisruption({
    ...quiet, snowOvernightIn: 1, minTempF: 21, minWindChillF: 11, commutePrecip: 'snow',
    alerts: [alertFeature('Winter Weather Advisory', 'storm', 'advisory', 0.5)]
  });
  assert.equal(result.predictedDisruption, true);
  assert.ok(result.probability >= 55 && result.probability <= 75, `got ${result.probability}`);
  assert.ok(result.delayProbability > result.closureProbability);
});

test('a warning with heavy snow is a likely closure', () => {
  const result = scoreDisruption({
    ...quiet, snowOvernightIn: 9, minTempF: 18, minWindChillF: 5, commutePrecip: 'snow',
    alerts: [alertFeature('Winter Storm Warning', 'storm', 'warning', 0.75)]
  });
  assert.ok(result.probability >= 85);
  assert.ok(result.closureProbability > result.delayProbability);
  assert.equal(result.status, 'high');
});

test('factor impacts add up to the total, and the total never exceeds 95', () => {
  const result = scoreDisruption({
    ...quiet, snowOvernightIn: 12, snowSchoolDayIn: 6, iceIn: 0.3, minTempF: -5, minWindChillF: -25, commutePrecip: 'ice',
    alerts: [
      alertFeature('Blizzard Warning', 'storm', 'warning', 0.85),
      alertFeature('Extreme Cold Warning', 'cold', 'warning', 0.70)
    ]
  });
  assert.equal(result.probability, 95);
  assert.equal(result.factors.reduce((sum, f) => sum + f.impact, 0), 95);
  assert.equal(result.delayProbability + result.closureProbability, 95);
});

test('more snow never lowers the probability', () => {
  let last = -1;
  for (const snow of [0, 0.2, 0.5, 1, 2, 3, 5, 8, 14]) {
    const { probability } = scoreDisruption({ ...quiet, snowOvernightIn: snow });
    assert.ok(probability >= last, `${snow}" gave ${probability} after ${last}`);
    last = probability;
  }
});

test('a spring Freeze Warning does not raise the school prediction', () => {
  // The April 2026 false alarm: Freeze Warnings in several zones, 34 deg F
  const alerts = [
    makeAlert('Freeze Warning', '2030-04-22', 23, 33, ['PAZ077']),
    makeAlert('Freeze Warning', '2030-04-22', 23, 33, ['PAZ078']),
    makeAlert('Freeze Warning', '2030-04-22', 23, 33, ['PAZ021']),
    makeAlert('Freeze Watch', '2030-04-22', 23, 33, ['PAZ077', 'PAZ078'])
  ];
  const grid = makeGrid('2030-04-23', { snow: [0, 0, 0, 0], windChill: [30, 29, 29, 31, 35], temperature: [33, 32, 32, 34, 38] });
  const result = calculateDelayProbability(null, null, null, alerts, { grid, targetDate: '2030-04-23', now: new Date('2030-04-23T00:30:00Z') });
  assert.equal(result.probability, 0);
});

test('an advisory for Indiana County alone is enough to forecast a disruption', () => {
  // The March 3, 2026 miss: advisory for Indiana only, nothing for Pittsburgh
  const alerts = [makeAlert('Winter Weather Advisory', '2030-01-14', 22, 34, ['PAZ077', 'PAZ078'])];
  const grid = makeGrid(TARGET, { snow: [0, 0.3, 0.4, 0], ice: [0, 0.01, 0.03, 0], windChill: [24, 23, 23, 24, 26], temperature: [30, 29, 29, 30, 32] });
  const result = calculateDelayProbability(null, null, null, alerts, { grid, targetDate: TARGET, now: eveningBefore });
  assert.equal(result.predictedDisruption, true);
  assert.match(result.factors[0].factor, /Winter Weather Advisory/);
});

test('districts on the ridges are scored against their own warning', () => {
  // Feb 2026 pattern: warning for the higher elevations, advisory elsewhere
  const alerts = [
    makeAlert('Winter Storm Warning', '2030-01-14', 22, 40, ['PAZ078']),
    makeAlert('Winter Weather Advisory', '2030-01-14', 22, 40, ['PAZ077'])
  ];
  const grid = makeGrid(TARGET, { snow: [0, 1, 1, 0.5], windChill: [15, 14, 14, 15, 18], temperature: [22, 21, 21, 22, 24] });
  const { districts, county } = predictAllDistricts(makeInputs({ grid, alerts }), { now: eveningBefore, targetDate: TARGET });
  const byCode = Object.fromEntries(districts.map(d => [d.school.code, d]));

  assert.ok(byCode.USD.probability > byCode.IASD.probability);
  assert.equal(byCode.PMASD.probability, byCode.USD.probability); // straddles both zones
  assert.equal(byCode.HCSD.probability, byCode.IASD.probability);
  assert.ok(byCode.USD.closureProbability > byCode.IASD.closureProbability);
  // The county figure sits between the two groups
  assert.ok(county.probability > byCode.IASD.probability && county.probability < byCode.USD.probability);
  assert.equal(county.delayProbability + county.closureProbability, county.probability);
  // ...and is explained as the county seat's factors plus a line for the ridges
  assert.equal(county.factors.reduce((sum, f) => sum + f.impact, 0), county.probability);
  const last = county.factors[county.factors.length - 1];
  assert.match(last.factor, /^Higher risk in Penns Manor, United \(Winter Storm Warning/);
});

test('no data is reported as no data, not as a quiet day', () => {
  const inputs = { ...makeInputs(), alertsAvailable: false };
  assert.equal(predictAllDistricts(inputs, { now: eveningBefore, targetDate: TARGET }).noData, true);
  assert.equal(predictAllDistricts(makeInputs(), { now: eveningBefore, targetDate: TARGET }).noData, false);
});

test('closures that are not about winter weather are kept out of the history', () => {
  const record = (overrides) => ({ school: 'Indiana', date: '2026-01-20', status: 'closed', temperature: 20, snowfall: 3, type: 'snow', feelsLike: 10, ...overrides });
  assert.equal(isNonWeatherRecord(record()), false);
  assert.equal(isNonWeatherRecord(record({ temperature: 77, snowfall: 0 })), true);           // late-August closure
  assert.equal(isNonWeatherRecord(record({ date: '2026-04-03', temperature: 39 })), true);    // Good Friday
  assert.equal(isNonWeatherRecord(record({ date: '2026-02-09' })), true);                     // Indiana in-service day
  assert.equal(isNonWeatherRecord(record({ date: '2026-02-09', school: 'United' })), false);
  assert.equal(isNonWeatherRecord(record({ cause: 'non-winter' })), true);
  assert.equal(isNonWeatherRecord(record({ status: 'open', temperature: 60 })), false);       // open days are always fine
});
