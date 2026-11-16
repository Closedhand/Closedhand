// lib/one-off-reminders.js -- reminders and tasks meant to happen once.
//
// A one-off is retired when it runs (lib/scheduling.js). One that did not run,
// because Closedhand was not running at its time or the run failed, stayed
// enabled: it sat in Upcoming on a day already gone, and as cron has no year
// it would have fired on that date twelve months on. So when Closedhand
// starts, and after its computer wakes, a reminder whose time has passed since
// it was made is sent then, late, under a line saying when it was due and why
// it is late (lib/scheduling.js); one that had run, and a task, is retired.
const { zonedToUtc, eventWhen, DEFAULT_TZ } = require("./timezone");
const { peek } = require("./log-text");

const two = (n) => String(n).padStart(2, "0");
const whole = (v) => /^\d+$/.test(v || "");

// A cron expression pinned to one day and one month describes a single date,
// because the year it was written for is the only one the author had in mind.
function isDatedOneOff(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return false;
  return whole(f[2]) && whole(f[3]);
}

// What it was made as; guessing only for a row made before that was recorded.
function isOneOff(row) {
  if (row.run_once === true) return true;
  if (row.run_once === false) return false;
  return isDatedOneOff(row.cron_expression ?? row.cron);
}

// The latest moment a cron line named, at or before `now`.
function lastDue(expr, tz, now) {
  const f = String(expr || "").trim().split(/\s+/);
  const zone = tz || DEFAULT_TZ;
  if (f.length === 5 && f.slice(0, 4).every(whole) && f[4] === "*") {
    const [minute, hour, day, month] = f.map(Number);
    for (const year of [now.getUTCFullYear() + 1, now.getUTCFullYear(), now.getUTCFullYear() - 1]) {
      // 29 February exists only in some years.
      if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) continue;
      const at = zonedToUtc(`${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:00`, zone);
      if (at.getTime() <= now.getTime()) return at;
    }
    return null;
  }
  try { return require("cron-parser").parseExpression(expr, { tz: zone, currentDate: now }).prev().toDate(); } catch (_) { return null; }
}

// When a one-off's time passed, or null while it is still to come (or the row
// repeats, is already retired, or does not say when it was made).
function passedAt(row, now = new Date()) {
  if (!row || row.enabled === false || row.archived_at || !isOneOff(row)) return null;
  const made = Date.parse(row.created_at);
  if (Number.isNaN(made)) return null;
  const due = lastDue(row.cron_expression ?? row.cron, row.timezone, now);
  return due && due.getTime() > made ? due : null;
}

// Archived, never deleted: the person can look back at it under Past, and an
// archived row is never registered again.
async function retire(db, userId, name, now = new Date()) {
  const { error } = await db.from("schedules").update({ enabled: false, archived_at: now.toISOString() })
    .eq("user_id", userId).eq("name", name);
  if (error) console.error(`[reminders] could not retire the one-off ${peek(name)}:`, error.message);
  return !error;
}

// The one-offs among `schedules` whose time passed at or before `before`,
// each with when it was due. `skip` holds the names running right now: one of
// those retires itself when it is done.
function passed(schedules, { before = new Date(), skip = new Set() } = {}) {
  const out = [];
  for (const schedule of schedules || []) {
    const due = passedAt(schedule, before);
    if (due && !skip.has(schedule.name)) out.push({ schedule, due });
  }
  return out;
}

// The line that heads a reminder sent late: when it was due and why it is
// late. Written here, not by the LLM, so it is always said.
const WHY = {
  off: "while Closedhand wasn't running",
  asleep: "while the computer running Closedhand was asleep",
};
function lateLine(due, tz, why) {
  return `Due ${eventWhen(new Date(due).toISOString(), tz || DEFAULT_TZ)}, ${WHY[why] || WHY.off}.`;
}

module.exports = { isDatedOneOff, isOneOff, lastDue, passedAt, passed, retire, lateLine };
