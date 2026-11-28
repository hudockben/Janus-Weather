// Builders for synthetic NWS data, so tests can stage a specific school morning.

const { easternToMs, addDays } = require('../api/_lib/easternTime');

const HOUR = 60 * 60 * 1000;

// A forecast grid for the morning of `targetDate`.
//   snow: inches per 6-hour block, starting 1 PM Eastern the day before
//   ice:  same blocks, inches of ice
//   windChill / temperature: one value per hour from 4 AM Eastern
function makeGrid(targetDate, { snow = [], ice = [], windChill = [], temperature = [], weather = [] } = {}) {
  const blockStart = easternToMs(addDays(targetDate, -1), 13);
  const sixHourly = values => values.map((value, i) => ({
    start: blockStart + i * 6 * HOUR,
    end: blockStart + (i + 1) * 6 * HOUR,
    value
  }));
  const hourlyFrom4am = values => values.map((value, i) => ({
    start: easternToMs(targetDate, 4) + i * HOUR,
    end: easternToMs(targetDate, 4) + (i + 1) * HOUR,
    value
  }));

  return {
    updated: new Date(blockStart).toISOString(),
    series: {
      snowfallAmount: sixHourly(snow),
      iceAccumulation: sixHourly(ice),
      windChill: hourlyFrom4am(windChill),
      apparentTemperature: hourlyFrom4am(windChill),
      temperature: hourlyFrom4am(temperature),
      windSpeed: [],
      probabilityOfPrecipitation: [],
      weather: weather.map(({ fromHour, toHour, types }) => ({
        start: easternToMs(targetDate, fromHour),
        end: easternToMs(targetDate, toHour),
        types
      }))
    }
  };
}

// An alert as getAlerts() returns it. Hours are Eastern, relative to `date`.
function makeAlert(event, date, fromHour, toHour, zones = ['PAZ077', 'PAZ078']) {
  return {
    event,
    onset: new Date(easternToMs(date, 0) + fromHour * HOUR).toISOString(),
    ends: new Date(easternToMs(date, 0) + toHour * HOUR).toISOString(),
    // NWS reissues bulletins long before the weather ends
    expires: new Date(easternToMs(date, 0) + (fromHour + 1) * HOUR).toISOString(),
    zones,
    affectsIndianaCounty: zones.some(z => ['PAZ077', 'PAZ078', 'PAC063'].includes(z))
  };
}

// Inputs for predictAllDistricts / the logger: every district gets `grid`.
function makeInputs({ grid = null, alerts = [], current = null, forecast = null, hourlyForecast = null } = {}) {
  const codes = ['IASD', 'HCSD', 'MCASD', 'PMASD', 'PLSD', 'USD'];
  return {
    current,
    forecast,
    hourlyForecast,
    alerts,
    alertsAvailable: true,
    grids: Object.fromEntries(codes.map(code => [code, grid])),
    errors: []
  };
}

module.exports = { makeGrid, makeAlert, makeInputs, HOUR };
