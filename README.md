# Janus Forecast Model

Weather for Indiana County, PA, with a delay/closure forecast for the next school
morning in six districts.

## How the school forecast works

For each district the model looks at one specific school morning and reads three
things from the National Weather Service:

- **Alerts for the district's own forecast zone** that are in effect when buses
  run. Indiana County is two zones: `PAZ077` (Indiana) and `PAZ078` (Higher
  Elevations of Indiana, the southeast ridges). Only winter products count
  (Winter Weather Advisory, Winter Storm Warning, Ice Storm Warning, cold
  advisories and warnings, snow squalls). Freeze and frost notices are
  growing-season products and are ignored.
- **The numeric forecast grid** for the district: inches of snow from 6 PM the
  evening before to 8 AM, ice accumulation, and the lowest wind chill between
  5 and 9 AM. The worded forecast is only a fallback.
- **What is falling at bus time** (snow, freezing rain).

Each factor carries the chance of a disruption if it were the only thing going
on, and factors combine as independent chances. The weights are in
`api/_lib/features.js` (alerts) and `api/_lib/schoolDelay.js` (snow, ice, cold).
They are provisional until a full winter of results is in the prediction log.

## Keeping score

`.github/workflows/daily-weather-log.yml` runs `scripts/daily-weather-log.js`
every three hours. Each run records the day's actual school statuses, scores the
forecast that was on file, and saves the forecast for the next school day.
Results land in `api/_lib/historicalData.json` and `api/_lib/predictionLog.json`.

A day's record only moves toward "more disrupted". If a later run sees a delay
posted after the first read, a delay turned into a closure, or an early
dismissal, the record and the score follow. A delay that is later cleared from
SchoolCast stays a delay.

The workflow only runs on the repository's default branch, and the live site
deploys from `main`. They must be the same branch, or the site never sees what
the logger records.

The site's self-audit reports disruptions **caught**, disruptions **missed**, and
**false alarms**. Schools are open on most days, so plain "percent correct" looks
excellent even for a forecast that never predicts anything.

## Maintenance

- **Days off**: add in-service days, MLK Day, Presidents' Day, the rest of
  spring break and other non-weather closures to
  `api/_lib/nonWeatherClosures.json` (`"schools": "all"` or a list of district
  names). Built in: Thanksgiving and the Friday after, Dec 24 - Jan 1, Good
  Friday, Easter Monday, Memorial Day, Labor Day, and June 15 - Aug 15. Days off
  are neither forecast nor scored, and their closures stay out of the weather
  history. A day added later is removed from the scorecard retroactively.
- **Tests**: `npm test`
- **Backtest**: `node scripts/backtest.js` replays the current model against
  archived NWS alerts and airport observations. Run it before and after changing
  a weight.
