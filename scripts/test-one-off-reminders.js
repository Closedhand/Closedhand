// A one-off reminder that did not run (Closedhand was not running at its
// time, or the run failed) stayed enabled. Cron has no year, so it sat in
// Upcoming on a day already gone and would have fired twelve months on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const oneOffs = require("../lib/one-off-reminders");

const row = (over = {}) => ({ user_id: "u1", name: "call-the-dentist", cron_expression: "40 22 16 10 *", timezone: "Asia/Ho_Chi_Minh",
  run_once: true, enabled: true, archived_at: null, created_at: "2026-10-16T14:25:00.000Z", ...over });

test("a one-off whose time passed since it was made is found, in its own zone", () => {
  const due = oneOffs.passedAt(row(), new Date("2026-11-16T12:00:00Z"));
  assert.equal(due.toISOString(), "2026-10-16T15:40:00.000Z", "22:40 in Ho Chi Minh City");
  assert.equal(oneOffs.passedAt(row(), new Date("2026-10-16T15:40:00Z")).toISOString(), "2026-10-16T15:40:00.000Z", "from its own minute on");
});

test("one still to come is left alone", () => {
  assert.equal(oneOffs.passedAt(row(), new Date("2026-10-16T15:39:59Z")), null, "a second before its time");
  // Made after this year's date: it was meant for next year's.
  assert.equal(oneOffs.passedAt(row({ created_at: "2026-10-20T09:00:00.000Z" }), new Date("2026-11-16T12:00:00Z")), null);
  assert.equal(oneOffs.passedAt(row({ created_at: "2026-10-20T09:00:00.000Z" }), new Date("2027-10-17T00:00:00Z")).toISOString(), "2027-10-16T15:40:00.000Z");
});

test("what repeats, what is already retired and what cannot be dated are left alone", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  assert.equal(oneOffs.passedAt(row({ run_once: false }), now), null, "made to come round every year");
  assert.equal(oneOffs.passedAt(row({ run_once: null, cron_expression: "0 9 * * 1" }), now), null, "every Monday");
  assert.equal(oneOffs.passedAt(row({ enabled: false }), now), null);
  assert.equal(oneOffs.passedAt(row({ archived_at: "2026-10-16T15:40:05.000Z" }), now), null);
  assert.equal(oneOffs.passedAt(row({ created_at: null }), now), null, "no telling whether its time came after it was made");
  // An older row that never said it was a one-off, but names one day of one month.
  assert.equal(oneOffs.passedAt(row({ run_once: null }), now).toISOString(), "2026-10-16T15:40:00.000Z");
});

test("the year turning and 29 February", () => {
  // 23:30 on 31 December in Auckland is still the morning of the 31st in UTC.
  const eve = row({ cron_expression: "30 23 31 12 *", timezone: "Pacific/Auckland", created_at: "2026-12-30T00:00:00.000Z" });
  assert.equal(oneOffs.passedAt(eve, new Date("2027-01-02T00:00:00Z")).toISOString(), "2026-12-31T10:30:00.000Z");
  // 00:10 on 1 January in Auckland is still 31 December in UTC.
  const newYear = row({ cron_expression: "10 0 1 1 *", timezone: "Pacific/Auckland", created_at: "2026-12-30T00:00:00.000Z" });
  assert.equal(oneOffs.passedAt(newYear, new Date("2026-12-31T11:30:00Z")).toISOString(), "2026-12-31T11:10:00.000Z");
  assert.equal(oneOffs.passedAt(newYear, new Date("2026-12-31T11:00:00Z")), null);
  const leap = row({ cron_expression: "0 9 29 2 *", timezone: "UTC", created_at: "2027-06-01T00:00:00.000Z" });
  assert.equal(oneOffs.passedAt(leap, new Date("2028-02-28T12:00:00Z")), null, "2027 has no 29 February, so its time has not come");
  assert.equal(oneOffs.passedAt(leap, new Date("2028-03-01T00:00:00Z")).toISOString(), "2028-02-29T09:00:00.000Z");
});

// A stand-in for the database: one table of rows, the calls the module makes.
function standIn(rows, { failOn = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, "schedules");
      const q = { filters: [], patch: null };
      const chain = {
        select() { return chain; },
        update(patch) { q.patch = patch; return chain; },
        eq(col, value) { q.filters.push((r) => r[col] === value); return chain; },
        is(col, value) { q.filters.push((r) => (r[col] ?? null) === value); return chain; },
        then(done, fail) {
          const hit = rows.filter((r) => q.filters.every((f) => f(r)));
          if (!q.patch) return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(done, fail);
          if (hit.some((r) => r.name === failOn)) return Promise.resolve({ data: null, error: { message: "the database said no" } }).then(done, fail);
          for (const r of hit) { Object.assign(r, q.patch); writes.push(r.name); }
          return Promise.resolve({ data: null, error: null }).then(done, fail);
        },
      };
      return chain;
    },
  };
}

test("at start, the one-offs whose time has passed are retired and the rest are untouched", async () => {
  const rows = [
    row(),
    row({ name: "water-the-ferns", cron_expression: "0 9 20 12 *", timezone: "Europe/Lisbon", created_at: "2026-11-01T00:00:00.000Z" }),
    row({ name: "weekly-shop", cron_expression: "0 10 * * 6", run_once: false }),
    row({ name: "renew-the-pass", cron_expression: "0 8 5 10 *", enabled: false, archived_at: "2026-10-05T01:00:07.000Z", created_at: "2026-10-03T00:00:00.000Z" }),
    row({ name: "someone-elses", user_id: "u2", cron_expression: "0 7 1 11 *", timezone: "UTC", created_at: "2026-10-30T00:00:00.000Z" }),
  ];
  const db = standIn(rows);
  const quiet = console.log; console.log = () => {};
  let gone;
  try { gone = await oneOffs.retirePassed(db, { before: new Date("2026-11-16T12:00:00Z") }); } finally { console.log = quiet; }
  assert.deepEqual(gone.sort(), ["call-the-dentist", "someone-elses"]);
  const dentist = rows[0];
  assert.equal(dentist.enabled, false);
  assert.match(dentist.archived_at, /^\d{4}-\d{2}-\d{2}T/, "archived, so it shows under Past and is never registered again");
  assert.equal(rows[1].enabled, true, "one still to come stays");
  assert.equal(rows[2].enabled, true, "one that repeats stays");
  assert.equal(rows[3].archived_at, "2026-10-05T01:00:07.000Z", "one already retired keeps the time it ran");
});

test("one that is running right now is left to retire itself, and a failed write is not reported as done", async () => {
  const quietLog = console.log, quietError = console.error; console.log = () => {}; console.error = () => {};
  try {
    const running = [row()];
    assert.deepEqual(await oneOffs.retirePassed(standIn(running), { before: new Date("2026-11-16T12:00:00Z"), skip: new Set(["call-the-dentist"]) }), []);
    assert.equal(running[0].enabled, true);
    const failing = [row()];
    assert.deepEqual(await oneOffs.retirePassed(standIn(failing, { failOn: "call-the-dentist" }), { before: new Date("2026-11-16T12:00:00Z") }), []);
    assert.equal(failing[0].enabled, true);
  } finally { console.log = quietLog; console.error = quietError; }
});

test("after waking, only what came due before the wake is retired", async () => {
  // Due a minute after the computer woke: its timer ran it, or will.
  const rows = [row({ cron_expression: "1 9 17 11 *", timezone: "UTC", created_at: "2026-11-16T00:00:00.000Z" })];
  const quiet = console.log; console.log = () => {};
  try {
    assert.deepEqual(await oneOffs.retirePassed(standIn(rows), { before: new Date("2026-11-17T09:00:00Z") }), []);
    assert.deepEqual(await oneOffs.retirePassed(standIn(rows), { before: new Date("2026-11-17T09:01:00Z") }), ["call-the-dentist"]);
  } finally { console.log = quiet; }
});

test("the scheduler retires them before it registers anything, and after a wake", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "scheduling.js"), "utf8");
  const start = src.slice(src.indexOf("function registerAllSchedules"));
  assert.ok(start.indexOf("retirePassedOneOffs()") > 0 && start.indexOf("retirePassedOneOffs()") < start.indexOf("UserStore.getActiveUsers()"), "retired first, so none is registered");
  assert.match(start.slice(0, start.indexOf("UserStore.getActiveUsers()")), /onWake\(/, "and again once the computer has woken");
  assert.match(src, /firing\.add\(schedule\.name\)[\s\S]+finally \{\s+firing\.delete\(schedule\.name\)/, "a run in progress is known, so it is not retired under itself");
});
