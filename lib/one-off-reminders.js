// lib/one-off-reminders.js -- reminders and tasks meant to happen once.
//
// A one-off is retired when it runs (lib/scheduling.js). One that did not run,
// because Closedhand was not running at its time or the run failed, stayed
// enabled: it sat in Upcoming on a day already gone, and as cron has no year
// it would have fired on that date twelve months on. So when Closedhand
// starts, and after its computer wakes, a one-off whose time has passed since
// it was made is retired like one that ran.
const { zonedToUtc, DEFAULT_TZ } = require("./timezone");
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

// Retires every one-off whose time passed at or before `before`. `skip` holds
// the names running right now: one of those retires itself when it is done.
// Returns the names retired.
async function retirePassed(db, { before = new Date(), skip = new Set() } = {}) {
  const { data, error } = await db.from("schedules")
    .select("user_id, name, cron_expression, timezone, run_once, enabled, archived_at, created_at")
    .eq("enabled", true).is("archived_at", null);
  if (error) { console.error("[reminders] could not look for one-offs whose time has passed:", error.message); return []; }
  const gone = [];
  for (const row of data || []) {
    const due = passedAt(row, before);
    if (!due || skip.has(row.name)) continue;
    if (!(await retire(db, row.user_id, row.name))) continue;
    gone.push(row.name);
    console.log(`[reminders] the one-off ${peek(row.name)} was due ${due.toISOString()} and is still here; retired`);
  }
  return gone;
}

module.exports = { isDatedOneOff, isOneOff, lastDue, passedAt, retire, retirePassed };
