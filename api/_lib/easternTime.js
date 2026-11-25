// Eastern-time helpers.
//
// The servers that run this code (Vercel, GitHub Actions) keep UTC clocks, but
// every school decision happens on Eastern wall-clock time. Reading hours or
// dates off a plain Date object there silently shifts "5 AM bus time" to
// midnight, so anything that asks "what hour/day is it?" goes through here.

const TIME_ZONE = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short'
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Eastern wall-clock fields for an instant (Date, epoch ms, or ISO string).
function easternParts(instant = new Date()) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(instant))) {
    parts[type] = value;
  }
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dow: WEEKDAY_INDEX[parts.weekday]
  };
}

function splitDate(dateStr) {
  return dateStr.split('-').map(Number);
}

// Calendar arithmetic on YYYY-MM-DD strings (no time zone involved).
function addDays(dateStr, days) {
  const [y, m, d] = splitDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 0 = Sunday ... 6 = Saturday
function dayOfWeek(dateStr) {
  const [y, m, d] = splitDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// How far Eastern wall-clock time is from UTC at a given instant (negative).
function easternOffsetMs(ms) {
  const p = easternParts(ms);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

// Epoch ms for an Eastern wall-clock time on a calendar date. Handles the
// EST/EDT switch: the second pass corrects the offset when the first guess
// lands on the other side of a daylight-saving change.
function easternToMs(dateStr, hour = 0, minute = 0) {
  const [y, m, d] = splitDate(dateStr);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const firstGuess = wall - easternOffsetMs(wall);
  return wall - easternOffsetMs(firstGuess);
}

// "Monday", "Tuesday", ...
function weekdayName(dateStr) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek(dateStr)];
}

module.exports = {
  TIME_ZONE,
  easternParts,
  easternToMs,
  addDays,
  dayOfWeek,
  weekdayName
};
