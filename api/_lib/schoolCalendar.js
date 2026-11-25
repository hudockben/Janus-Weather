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

function loadNonWeatherClosures() {
  if (closuresCache === null) {
    try {
      closuresCache = JSON.parse(fs.readFileSync(NON_WEATHER_CLOSURES_PATH, 'utf8'));
    } catch (error) {
      closuresCache = [];
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

// Breaks that every district shares, so they don't have to be listed by hand.
function getFixedHoliday(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);

  if (month === 11) {
    // Thanksgiving is the fourth Thursday of November
    const firstDow = dayOfWeek(`${year}-11-01`);
    const thanksgiving = 1 + ((4 - firstDow + 7) % 7) + 21;
    if (day === thanksgiving) return 'Thanksgiving';
    if (day === thanksgiving + 1) return 'Thanksgiving break';
  }

  if ((month === 12 && day >= 24) || (month === 1 && day === 1)) return 'Winter break';

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
  for (let i = 0; i < 21 && !isSchoolDay(date); i++) {
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
