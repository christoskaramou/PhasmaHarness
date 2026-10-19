'use strict';
const DAY = 24 * 60 * 60000;
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  return formatters.get(timeZone);
}

function parts(at, zone) {
  return Object.fromEntries(formatter(zone).formatToParts(at).filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function calendar(value) {
  if (!value || typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 80 ||
      !Array.isArray(value.days) || !value.days.length || value.days.length > 7 ||
      new Set(value.days).size !== value.days.length || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('Choose a local HH:MM time, timezone and weekdays (Sunday 0 through Saturday 6).');
  }
  try { formatter(value.timeZone).format(0); }
  catch { throw new Error('Choose a valid timezone, such as Europe/Athens.'); }
  return { time: value.time, timeZone: value.timeZone, days: [...value.days].sort() };
}

function instants(date, time, zone) {
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsets = new Set([-DAY, 0, DAY].map(delta => {
    const probe = target + delta, local = parts(probe, zone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - probe;
  }));
  return [...offsets].map(offset => target - offset).filter(at => {
    const local = parts(at, zone);
    return local.year === date.year && local.month === date.month && local.day === date.day &&
      local.hour === hour && local.minute === minute;
  }).sort((a, b) => a - b);
}

function next(after, schedule, lastKey = null) {
  if (!Number.isFinite(after)) throw new Error('The schedule clock is unavailable.');
  const value = calendar(schedule), local = parts(after, value.timeZone);
  const midnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let day = 0; day < 15; day++) {
    const date = new Date(midnight + day * DAY);
    if (!value.days.includes(date.getUTCDay())) continue;
    const ymd = date.toISOString().slice(0, 10), key = `${ymd}T${value.time}@${value.timeZone}`;
    if (key === lastKey) continue;
    const at = instants({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, value.time, value.timeZone)[0];
    if (at > after) return { at, key };
  }
  throw new Error('No valid scheduled time was found within the next two weeks.');
}

// One run at a local date and time; a time repeated by an autumn clock change runs at its first instant.
function once(value) {
  if (!value || typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 80) {
    throw new Error('Choose a local HH:MM time and a timezone.');
  }
  try { formatter(value.timeZone).format(0); }
  catch { throw new Error('Choose a valid timezone, such as Europe/Athens.'); }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value.date === 'string' ? value.date : '');
  const date = match && { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const real = date && new Date(Date.UTC(date.year, date.month - 1, date.day)).toISOString().slice(0, 10) === value.date;
  if (!real) throw new Error('Choose a real date as YYYY-MM-DD.');

  const at = instants(date, value.time, value.timeZone)[0];
  if (at === undefined) throw new Error('That local time does not exist on that date because the clock changes. Choose another time.');
  return { schedule: { date: value.date, time: value.time, timeZone: value.timeZone },
    next: { at, key: `once:${value.date}T${value.time}@${value.timeZone}` } };
}

module.exports = { calendar, next, once };
