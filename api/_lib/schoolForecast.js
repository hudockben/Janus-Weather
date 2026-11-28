// Gathers everything the school prediction needs from NWS in one place, so the
// number shown on the site and the number written to the prediction log are
// always computed from the same inputs.

const { getCurrentConditions, getForecast, getHourlyForecast, getGridForecast, getAlerts } = require('./noaa');
const { predictAllDistricts, INDIANA_COUNTY_SCHOOLS } = require('./schoolDelay');

// Give up on a source after `ms` so one slow NWS endpoint cannot stall a page load.
function withDeadline(promise, ms) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response within ${ms} ms`)), ms);
      if (timer.unref) timer.unref();
    })
  ]);
}

// Fetch all inputs in parallel. A failed source comes back as null (and is
// listed in `errors`) rather than failing the whole forecast.
//
//   deadlineMs  optional cap on how long to wait for each source (the website
//               sets one; the logger waits out NWS retries instead)
async function fetchForecastInputs({ deadlineMs = 0 } = {}) {
  const errors = [];
  const attempt = (type, promise) => withDeadline(promise, deadlineMs).catch(error => {
    errors.push({ type, message: error.message });
    return null;
  });

  const [current, forecast, hourlyForecast, alertsData, ...gridList] = await Promise.all([
    attempt('weather_fetch', getCurrentConditions('indiana')),
    attempt('forecast_fetch', getForecast('indiana')),
    attempt('hourly_fetch', getHourlyForecast('indiana')),
    attempt('alerts_fetch', getAlerts()),
    ...INDIANA_COUNTY_SCHOOLS.map(school =>
      attempt(`grid_fetch_${school.code}`, getGridForecast({ lat: school.lat, lon: school.lon })))
  ]);

  const grids = {};
  INDIANA_COUNTY_SCHOOLS.forEach((school, i) => { grids[school.code] = gridList[i]; });

  return {
    current,
    forecast,
    hourlyForecast,
    alerts: alertsData ? alertsData.alerts : [],
    alertsAvailable: alertsData !== null,
    grids,
    errors
  };
}

// Fetch and predict in one call. Options are those of predictAllDistricts,
// plus deadlineMs.
async function getSchoolForecast({ deadlineMs, ...options } = {}) {
  const inputs = await fetchForecastInputs({ deadlineMs });
  return { inputs, ...predictAllDistricts(inputs, options) };
}

module.exports = {
  fetchForecastInputs,
  getSchoolForecast,
  withDeadline
};
