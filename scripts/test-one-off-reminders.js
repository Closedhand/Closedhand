// A one-off reminder that did not run (Closedhand was not running at its
// time, or the run failed) stayed enabled. Cron has no year, so it sat in
// Upcoming on a day already gone and would have fired twelve months on. A
// reminder missed that way is now sent when Closedhand is back, late, under a
// line saying when it was due and why; a task, and one that had run, is retired.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "scheduling.js"), "utf8");
const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const quiet = () => ({ log() {}, error() {} });

test("the one-offs whose time has gone are told apart from the rest, and one running now is left alone", () => {
  const schedules = [
    { name: "call-the-dentist", cron: "40 22 16 10 *", timezone: "Asia/Ho_Chi_Minh", run_once: true, enabled: true, created_at: "2026-10-16T14:25:00.000Z" },
    { name: "water-the-ferns", cron: "0 9 20 12 *", timezone: "Europe/Lisbon", run_once: true, enabled: true, created_at: "2026-11-01T00:00:00.000Z" },
    { name: "weekly-shop", cron: "0 10 * * 6", timezone: "Europe/Lisbon", run_once: false, enabled: true, created_at: "2026-10-01T00:00:00.000Z" },
    { name: "book-the-taxi", cron: "0 7 1 11 *", timezone: "UTC", run_once: true, enabled: true, created_at: "2026-10-30T00:00:00.000Z" },
  ];
  const before = new Date("2026-11-16T12:00:00Z");
  assert.deepEqual(oneOffs.passed(schedules, { before }).map((m) => [m.schedule.name, m.due.toISOString()]),
    [["call-the-dentist", "2026-10-16T15:40:00.000Z"], ["book-the-taxi", "2026-11-01T07:00:00.000Z"]]);
  assert.deepEqual(oneOffs.passed(schedules, { before, skip: new Set(["call-the-dentist"]) }).map((m) => m.schedule.name), ["book-the-taxi"]);
  // After waking, only what came due before the wake.
  assert.deepEqual(oneOffs.passed(schedules, { before: new Date("2026-11-01T06:59:00Z") }).map((m) => m.schedule.name), ["call-the-dentist"]);
});

test("the line above a late reminder says when it was due, where the person set it, and why it is late", () => {
  const due = new Date("2026-10-16T15:40:00Z");
  assert.equal(oneOffs.lateLine(due, "Asia/Ho_Chi_Minh", "off"), "Due Friday 16 October at 22:40, while Closedhand wasn't running.");
  assert.equal(oneOffs.lateLine(due, "Asia/Ho_Chi_Minh", "asleep"), "Due Friday 16 October at 22:40, while the computer running Closedhand was asleep.");
  assert.equal(oneOffs.lateLine(due, "Europe/London", "off"), "Due Friday 16 October at 16:40, while Closedhand wasn't running.");
});

// The scheduler's own run, with the bot's other parts stood in.
function runner({ send = () => {}, reply = "Call the dentist on 020 7946 0000.", kind = "reminder", still = { enabled: true, archived_at: null } } = {}) {
  const seen = { sent: [], asked: [], kept: [], writes: [], started: [] };
  const table = () => {
    const q = { patch: null, select: () => q, update: (patch) => { q.patch = patch; return q; }, eq: () => q,
      maybeSingle: async () => ({ data: still, error: null }),
      then: (done) => { if (q.patch) seen.writes.push(q.patch); return Promise.resolve({ data: null, error: null }).then(done); } };
    return q;
  };
  const db = { from: () => table() };
  const parts = {
    "./timezone": require("../lib/timezone"),
    "./user-mutex": { acquireUserMutex: (id, fn) => fn() },
    "./db": { supabase: db },
    "../user-store": { supabase: db },
    "./messaging": { sendToPlatform: async (...args) => { send(args); seen.sent.push(args); } },
    "./conversation": { getConversation: () => seen.kept },
    "./agents": { startAgent: async (...args) => { seen.started.push(args); } },
  };
  const box = { console: quiet(), ctx: { cronJobs: {} }, firing: new Set(), oneOffs, peek: () => "(name)", Date, Promise, String, Set,
    UserStore: { load: async () => ({ profile: {} }) }, swapToCloudStore() {}, cleanupUserContext() {}, saveStore() {},
    runScheduledPrompt: async (prompt, userId, chatId, platform, opts) => { seen.asked.push({ prompt, opts }); return reply; },
    require: (name) => parts[name] };
  vm.runInNewContext(cut("const REMINDER_FRAME", "function registerAllSchedules() {") + "\nthis.fire = fire;", box);
  const schedule = { name: "call-the-dentist", cron: "40 22 16 10 *", prompt: "Remind them to call the dentist.", timezone: "Asia/Ho_Chi_Minh", run_once: true, enabled: true, kind,
    _userId: "u1", _chatId: "c1", _platform: "telegram" };
  return { seen, box, schedule, fire: (opts) => box.fire(schedule, opts) };
}

test("a reminder sent late goes out under its line, the LLM is told when it was due, and the conversation keeps both", async () => {
  const r = runner();
  await r.fire({ late: { due: new Date("2026-10-16T15:40:00Z"), why: "off" } });
  assert.deepEqual(r.seen.sent, [["telegram", "c1", "[Late reminder]\n\nDue Friday 16 October at 22:40, while Closedhand wasn't running.\n\nCall the dentist on 020 7946 0000."]]);
  assert.match(r.seen.asked[0].opts.frame, /This reminder is firing late\. It was due Friday 16 October at 22:40 and it is now /);
  assert.match(r.seen.asked[0].opts.frame, /delivered straight to the user's chat by the scheduler itself/, "and everything a reminder's turn is always told");
  assert.equal(r.seen.kept[0].content, '[Scheduled reminder "call-the-dentist" fired late. Due Friday 16 October at 22:40, while Closedhand wasn\'t running.] Call the dentist on 020 7946 0000.');
  assert.ok(r.seen.writes.some((w) => w.enabled === false && w.archived_at), "and it is retired, having run");
});

test("a reminder on time reads as it always did", async () => {
  const r = runner();
  await r.fire();
  assert.deepEqual(r.seen.sent, [["telegram", "c1", "[Reminder]\n\nCall the dentist on 020 7946 0000."]]);
  assert.equal(r.seen.asked[0].opts.frame, undefined, "the usual framing");
  assert.equal(r.seen.kept[0].content, '[Scheduled reminder "call-the-dentist" fired] Call the dentist on 020 7946 0000.');
});

test("a late reminder whose chat app cannot be reached is left for the next start or wake; a failed run on time is over", async () => {
  const offline = () => { throw Object.assign(new Error("WhatsApp (linked) is not connected"), { notSent: true }); };
  const late = runner({ send: offline });
  await late.fire({ late: { due: new Date("2026-10-16T15:40:00Z"), why: "asleep" } });
  assert.deepEqual(late.seen.writes, [], "nothing written: it is still to be sent");
  assert.equal(late.box.firing.size, 0);
  const onTime = runner({ send: offline });
  await onTime.fire();
  assert.ok(onTime.seen.writes.some((w) => w.enabled === false && w.archived_at), "retired, so it is not taken later for one that was never tried");
});

// Start and wake, with the run and the timers stood in.
function starter(schedules) {
  const seen = { registered: [], fired: [], retired: [], timers: [], wake: null };
  const db = { from: () => { const q = { update: () => q, eq: (col, v) => { if (col === "name") seen.retired.push(v); return q; }, then: (done) => Promise.resolve({ error: null }).then(done) }; return q; } };
  const box = { console: quiet(), ctx: { cronJobs: {} }, firing: new Set(), oneOffs, peek: () => "(name)", Date, Promise,
    UserStore: { getActiveUsers: async () => [{ schedules }] },
    registerSchedule: (s) => seen.registered.push(s.name),
    fire: async (s, opts) => { seen.fired.push([s.name, opts.late.why, opts.late.due.toISOString()]); },
    setTimeout: (fn, ms) => { seen.timers.push({ fn, ms }); return {}; },
    require: (name) => (name === "./sleep-watch" ? { onWake: (fn) => { seen.wake = fn; } } : name === "./db" ? { supabase: db } : null) };
  vm.runInNewContext(cut("// The one-offs whose time came while Closedhand was not running", "function registerSchedule(schedule) {")
    + cut("function registerAllSchedules() {", "// frame: what the model is told this turn is") + "\nthis.start = registerAllSchedules;", box);
  return { seen, box };
}
const year = new Date().getUTCFullYear();
const sample = () => [
  { name: "missed-reminder", cron: "0 9 2 1 *", timezone: "UTC", run_once: true, enabled: true, kind: "reminder", created_at: `${year - 1}-12-20T00:00:00.000Z`, last_run: null, _userId: "u1" },
  { name: "missed-task", cron: "0 9 2 1 *", timezone: "UTC", run_once: true, enabled: true, kind: "task", created_at: `${year - 1}-12-20T00:00:00.000Z`, last_run: null, _userId: "u1" },
  { name: "ran-but-not-retired", cron: "0 9 2 1 *", timezone: "UTC", run_once: true, enabled: true, kind: "reminder", created_at: `${year - 1}-12-20T00:00:00.000Z`, last_run: `${year}-01-02T09:00:05.000Z`, _userId: "u1" },
  { name: "every-week", cron: "0 10 * * 6", timezone: "UTC", run_once: false, enabled: true, kind: "reminder", created_at: `${year - 1}-12-20T00:00:00.000Z`, last_run: null, _userId: "u1" },
];
const settle = () => new Promise((r) => setImmediate(r));

test("at start a missed reminder is sent late a minute on and never registered; a task and one that ran are retired", async () => {
  const s = starter(sample());
  s.box.start();
  await settle();
  assert.deepEqual(s.seen.registered, ["every-week"], "a one-off whose time has gone gets no timer: it would be for next year");
  assert.equal(s.seen.timers.length, 1);
  assert.equal(s.seen.timers[0].ms, 60000, "once the chat apps are connected");
  assert.deepEqual(s.seen.fired, []);
  s.seen.timers[0].fn();
  await settle(); await settle();
  assert.deepEqual(s.seen.fired, [["missed-reminder", "off", `${year}-01-02T09:00:00.000Z`]]);
  assert.deepEqual(s.seen.retired.sort(), ["missed-task", "ran-but-not-retired"], "a task acts for the person, so it is not started at another time than the one they set");
});

test("after the computer wakes, what came due while it slept is sent late, and what is running is left alone", async () => {
  const all = sample();
  const s = starter(all.filter((x) => x.name === "every-week"));
  s.box.start();
  await settle();
  assert.equal(typeof s.seen.wake, "function", "the scheduler listens for the wake");
  s.seen.timers.length = 0;
  // Asleep over the reminder's time: by the wake, the rows are as they were.
  s.box.UserStore.getActiveUsers = async () => [{ schedules: all }];
  s.box.firing.add("missed-task");
  s.seen.wake();
  assert.equal(s.seen.timers[0].ms, 60000);
  s.seen.timers[0].fn();
  await settle(); await settle();
  assert.deepEqual(s.seen.fired.map((f) => [f[0], f[1]]), [["missed-reminder", "asleep"]]);
  assert.deepEqual(s.seen.retired, ["ran-but-not-retired"], "the one running now retires itself");
});
