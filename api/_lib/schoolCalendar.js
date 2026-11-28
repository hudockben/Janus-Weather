// School calendar: which days count as school days.
//
// The forecast only means something on a day when school would normally be in
// session. Without this, the model "predicts" Saturdays that are never checked,
// never predicts Mondays, and holiday closures get recorded as weather closures.

const fs = require('fs');
const path = require('path');
const { easternParts, addDays, dayOfWeek } = require('./easternTime');

const NON_WEATHER_CLOSURES_PATH = path.join(__dirname, 'nonWeatherClosures.json');

// District-specific days off (in-service days, spring break, holidays that
// vary by district) live in nonWeatherClosures.json.
let closuresCache = null;

// A missing file means no listed days off. A file that is there but cannot be
// parsed is an error: quietly treating it as empty would switch off every
// listed day off and let holidays be recorded as school days.
function loadNonWeatherClosures() {
  if (closuresCache === null) {
    let text = null;
    try {
      text = fs.readFileSync(NON_WEATHER_CLOSURES_PATH, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (text === null) {
      closuresCache = [];
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`nonWeatherClosures.json is not valid JSON (${error.message}). Fix the file; no days off can be read until then.`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error('nonWeatherClosures.json must be a list of { date, schools, reason } entries.');
      }
      closuresCache = parsed;
    }
  }
  return closuresCache;
}

// A listed non-weather closure for this date. With no school name, only
// entries that apply to every district ("all") match.
function getNonWeatherClosure(dateStr, schoolName) {
  return loadNonWeatherClosures().find(c => {
    if (c.date !== dateStr) return false;
    if (c.schools === 'all') return true;
    if (!schoolName) return false;
    if (Array.isArray(c.schools)) return c.schools.includes(schoolName);
    return c.schools === schoolName;
  });
}

// Easter Sunday for a year, as [month, day] (Gregorian computus).
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

// Days off that every district shares, so they don't have to be listed by
// hand. Anything that varies by district (in-service days, MLK Day and
// Presidents' Day, which some districts keep as snow make-up days, the rest of
// spring break) belongs in nonWeatherClosures.json.
function getFixedHoliday(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const pad = value => String(value).padStart(2, '0');

  if (month === 11) {
    // Thanksgiving is the fourth Thursday of November
    const firstDow = dayOfWeek(`${year}-11-01`);
    const thanksgiving = 1 + ((4 - firstDow + 7) % 7) + 21;
    if (day === thanksgiving) return 'Thanksgiving';
    if (day === thanksgiving + 1) return 'Thanksgiving break';
  }

  if ((month === 12 && day >= 24) || (month === 1 && day === 1)) return 'Winter break';

  const [easterMonth, easterDay] = easterSunday(year);
  const easter = `${year}-${pad(easterMonth)}-${pad(easterDay)}`;
  if (dateStr === addDays(easter, -2)) return 'Good Friday';
  if (dateStr === addDays(easter, 1)) return 'Easter Monday';

  // Memorial Day: last Monday of May. Labor Day: first Monday of September.
  if (month === 5 && day >= 25 && dayOfWeek(dateStr) === 1) return 'Memorial Day';
  if (month === 9 && day <= 7 && dayOfWeek(dateStr) === 1) return 'Labor Day';

  // No district is in session between mid-June and mid-August
  if ((month === 6 && day >= 15) || month === 7 || (month === 8 && day <= 15)) return 'Summer break';

  return null;
}

// Why this date is not a school day, or null if it is one.
function getNonSchoolReason(dateStr, schoolName) {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return 'Weekend';

  const holiday = getFixedHoliday(dateStr);
  if (holiday) return holiday;

  const closure = getNonWeatherClosure(dateStr, schoolName);
  if (closure) return closure.reason || 'Non-weather closure';

  return null;
}

function isSchoolDay(dateStr, schoolName) {
  return getNonSchoolReason(dateStr, schoolName) === null;
}

// The school morning a forecast made at `now` is about.
//
// Until `cutoffHour` Eastern on a school day the question is still "what about
// this morning?"; after that it rolls to the next school day, skipping weekends
// and breaks (so Friday afternoon forecasts Monday, not Saturday).
function getTargetSchoolDay(now = new Date(), { cutoffHour = 9 } = {}) {
  const eastern = easternParts(now);
  let date = eastern.hour < cutoffHour ? eastern.dateStr : addDays(eastern.dateStr, 1);
  // (bounded, but long enough to step over summer break)
  for (let i = 0; i < 120 && !isSchoolDay(date); i++) {
    date = addDays(date, 1);
  }
  return date;
}

// Winter-weather season (Nov-Mar): when open days are logged as a baseline and
// when forecast calibration is measured.
function isWinterSeason(dateStr) {
  const month = Number(dateStr.split('-')[1]);
  return month >= 11 || month <= 3;
}

module.exports = {
  loadNonWeatherClosures,
  getNonWeatherClosure,
  getFixedHoliday,
  getNonSchoolReason,
  isSchoolDay,
  getTargetSchoolDay,
  isWinterSeason
};
