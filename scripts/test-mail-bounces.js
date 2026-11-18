// An automatic answer to mail Closedhand made is told straight away
// (lib/mail-bounces.js): a chase it wrote went to a ticket desk's no-reply
// address, was reported as sent, and the answer saying so went unseen.
// Invented people, addresses and ids.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bounces = require("../lib/mail-bounces");

const get = (r, k) => (k.startsWith("data->>") ? r.data?.[k.slice(7)] : r[k]);
function fakeDb(tables) {
  return {
    from: (t) => {
      const f = [];
      const c = {
        select: () => c,
        eq: (k, v) => (f.push((r) => get(r, k) === v), c),
        gte: (k, v) => (f.push((r) => String(get(r, k)) >= v), c),
        in: (k, vs) => (f.push((r) => vs.includes(String(get(r, k)))), c),
        upsert: (rows) => { tables[t] = [...(tables[t] || []), ...rows]; return Promise.resolve({ error: null }); },
        then: (ok, bad) => Promise.resolve({ data: (tables[t] || []).filter((r) => f.every((x) => x(r))), error: null }).then(ok, bad),
      };
      return c;
    },
  };
}

const NOW = Date.parse("2026-11-18T12:20:00Z");
const mail = (id, at, threadId, data) => ({ user_id: "u1", type: "email", source: "gmail", external_id: id, received_at: at, created_at: at, data: { threadId, ...data } });

test("an automatic answer is told apart from a reply a person wrote", () => {
  assert.equal(bounces.isAutomaticAnswer({ from: "Tickets <tickets+noreply@desk.example>", body: "Dear Customer, We're sorry, but this is a no-reply address. To contact us, please write us a helpdesk message." }), true);
  assert.equal(bounces.isAutomaticAnswer({ from: "Mail Delivery Subsystem <mailer-daemon@mail.example>", subject: "Delivery Status Notification (Failure)", body: "Address not found" }), true);
  assert.equal(bounces.isAutomaticAnswer({ from: "Robin Fixture <robin@desk.example>", body: "Thanks, we've received the receipts and will look at them this week." }), false);
});

test("an automatic answer in a thread Closedhand made a draft in is told once, in its own words", async () => {
  const tables = {
    made_items: [{ user_id: "u1", kind: "draft", thread: "t-9", made_at: "2026-11-18T12:07:00Z" }],
    data_cache: [
      mail("m-sent", "2026-11-18T12:14:05Z", "t-9", { labels: ["SENT"], from: "Sam Fixture <sam@example.com>", to: '"Desk" <tickets@desk.example>', subject: "Re: Booking 4471" }),
      mail("m-auto", "2026-11-18T12:14:08Z", "t-9", { labels: ["INBOX"], from: "Tickets <tickets+noreply@desk.example>", subject: "Re: Re: Booking 4471", body: "Dear Customer, We're sorry, but this is a no-reply address. To contact us, please write us a helpdesk message at https://desk.example/help. Thank you" }),
      // Not Closedhand's: the person's own mail bounced. Their mail app shows them.
      mail("m-own", "2026-11-18T12:15:00Z", "t-50", { labels: ["INBOX"], from: "Mail Delivery Subsystem <mailer-daemon@mail.example>", subject: "Delivery Status Notification (Failure)", body: "Address not found" }),
      // In the thread, but a person answering.
      mail("m-person", "2026-11-18T12:16:00Z", "t-9", { labels: ["INBOX"], from: "Robin Fixture <robin@desk.example>", body: "Got it, thanks." }),
    ],
    told_items: [],
  };
  const told = [];
  const run = () => bounces.noticeBounces("u1", Date.parse("2026-11-18T12:10:00Z"), { db: fakeDb(tables), now: NOW, deliver: async (u, text) => (told.push(text), true) });
  assert.equal(await run(), 1);
  assert.deepEqual(told, ['Your email to tickets@desk.example didn\'t get through. Tickets answered straight away: "Dear Customer, We\'re sorry, but this is a no-reply address. To contact us, please write us a helpdesk message at https://desk.example/help. Thank you"']);
  assert.deepEqual(tables.told_items.map((r) => [r.external_id, r.told_by]), [["m-auto", "bounce"]], "kept as told, so Pulse leaves it alone");
  assert.equal(await run(), 0, "told once");
  assert.equal(told.length, 1);
});

test("nothing is asked of the mail when Closedhand made no draft lately, and a send that reached nobody is tried again next time", async () => {
  const tables = { made_items: [], data_cache: [mail("m-x", "2026-11-18T12:14:08Z", "t-9", { from: "mailer-daemon@mail.example", body: "Address not found" })], told_items: [] };
  assert.equal(await bounces.noticeBounces("u1", 0, { db: fakeDb(tables), now: NOW, deliver: async () => true }), 0);
  tables.made_items.push({ user_id: "u1", kind: "draft", thread: "t-9", made_at: "2026-11-18T12:00:00Z" });
  assert.equal(await bounces.noticeBounces("u1", 0, { db: fakeDb(tables), now: NOW, deliver: async () => false }), 0, "no chat app reached");
  assert.equal(tables.told_items.length, 0, "so not kept as told");
});

test("it runs after every sync that brought mail", () => {
  const sync = fs.readFileSync(path.join(__dirname, "..", "lib", "services", "data-sync.js"), "utf8");
  assert.match(sync, /require\("\.\.\/mail-bounces"\)\.noticeBounces\(userId, startedAt - 30000\)/);
});
