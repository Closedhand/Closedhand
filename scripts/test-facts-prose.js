const { test } = require('node:test');
const assert = require('node:assert/strict');
const { factsProse } = require('../lib/facts-prose');
test('facts read as grouped sentences with the key as a handle, never as JSON', () => {
  const out = factsProse({
    'person-mei': { value: "Mei is Sam's girlfriend; she is a nurse", category: 'person', subject: 'Mei', source: 'chat' },
    'profile-name': { value: 'Sam', category: 'profile', subject: 'Sam', source: 'setup scan' },
    'profile-company': { value: 'Acme Goods (Shopify store operator)', category: 'profile', subject: 'Sam' },
    'boss-email': 'ann@acme.example',
    '_onboarded': { value: '2026-09-09' },
    'flight-XY646-2026-09-16': { value: '{"airline":"ExampleAir"}' },
    'pulse_last': { value: 'x' },
  });
  assert.doesNotMatch(out, /[{}"]/, 'no JSON punctuation');
  assert.doesNotMatch(out, /_onboarded|flight-|pulse/, 'internal rows stay out');
  const about = out.indexOf('About the user:'), people = out.indexOf('People in their life:'), other = out.indexOf('Other:');
  assert.ok(about > 0 && people > about && other > people, 'groups in a fixed order');
  assert.match(out, /- Name: Sam\. \(read from mail by the setup scan\) \[profile-name\]/);
  assert.match(out, /- Company: Acme Goods \(Shopify store operator\)\. \[profile-company\]/, 'profile facts are labelled by what they are');
  assert.match(out, /- Mei is Sam's girlfriend; she is a nurse\. \[person-mei\]/, 'a value that starts with its subject is not prefixed');
  assert.match(out, /- ann@acme\.example\. \[boss-email\]/, 'a plain string fact still shows');
  assert.equal(factsProse({ _x: 'y' }), '', 'nothing to say gives an empty string');
});

const read = (f) => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", f), "utf8");

// Pinned Facts follow everything the person has connected, not only what
// they tell Closedhand (lib/facts-follow.js): told a clinic their partner was
// expecting, Closedhand, which reads that chat, still had only what was said
// to it. Invented people and words only.
function followHarness(facts) {
  const ctx = require("../lib/context");
  ctx.store = { facts, profile: { settings: { preferred_name: "Robin" } } };
  const sPath = require.resolve("../lib/storage");
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: { saveStore() {} } };
  const mPath = require.resolve("../lib/facts-follow");
  delete require.cache[mPath];
  return { mod: require("../lib/facts-follow"), restore() { delete require.cache[sPath]; delete require.cache[mPath]; ctx.store = null; } };
}
const NOW = Date.parse("2026-12-01T09:00:00Z");
const words = [
  { n: 1, at: NOW - 3600000, where: "WhatsApp to Clinica Sorriso", own: true, text: "Sorry to move it at short notice, my wife Ana is pregnant and has had complications, so I need to stay home." },
  { n: 2, at: NOW - 1800000, where: "an email from Example Freight Payroll", own: false, text: "Your payslip for November 2026. Employee: Robin Fixture. Employer: Example Freight Ltd." },
];
const CURSOR = { at: new Date(NOW - 1800000).toISOString(), id: "m-2" };
const items = (list = words, cursor = CURSOR) => async () => ({ items: list, cursor });
// Fitting a finding to the notes it could join, as the LLM would when the
// note does not say it yet: the same note, the whole finding.
const keep = async (u, held) => ({ note: held.key, adds: held.adds });

test("what comes in from any connection becomes a Pinned Fact only on the item's own words, written through pin_fact", async () => {
  const facts = { "family-partner": { value: "Robin's wife is Ana Fixture.", category: "person", subject: "Ana Fixture", source: "chat" } };
  const { mod, restore } = followHarness(facts);
  try {
    let shown = null;
    const pinned = [];
    const judge = async (u, w, prose, name) => { shown = { w, prose, name }; return [
      { key: "[family-partner]", category: "person", subject: "Ana Fixture", adds: "She is expecting their first child.", replaces: "", n: 1, quote: "my wife Ana is pregnant" },
      { key: "work-employer", category: "business", subject: "Example Freight", adds: "Robin works for Example Freight Ltd.", replaces: "", n: 2, quote: "Employer: Example Freight Ltd." },
      { key: "work-boss", category: "person", subject: "Dana Fixture", adds: "Dana Fixture is Robin's manager.", replaces: "", n: 2, quote: "Dana is your manager" },
      { key: "_pulse_last", category: "topic", subject: "x", adds: "Something long enough here.", replaces: "", n: 1, quote: "my wife Ana is pregnant" },
    ]; };
    const r = await mod.review("u1", { fit: keep, now: NOW, items: items(), judge, confirm: async () => true, pin: async (f) => { pinned.push(f); } });
    assert.equal(shown.name, "Robin");
    assert.match(shown.prose, /\[family-partner\]/, "the facts it may rewrite, by key");
    assert.deepEqual(pinned.map((f) => f.key), ["family-partner", "work-employer"], "on the words of the item each names, the person's own or a record from whoever would know; once a note however many readings found it; a key of Closedhand's own is never written; words not in the item are never a fact");
    assert.deepEqual(mod.readRecord({ "_facts-follow": JSON.stringify({ v: 2, looked: "2026-11-30T00:00:00Z", since: "2026-11-30T00:00:00Z" }) }), { v: 3 }, "a look by older rules reads everything again");
    assert.equal(pinned[0].from, "your WhatsApp to Clinica Sorriso, Tue 1 Dec");
    assert.deepEqual([pinned[1].from, pinned[1].own], ["an email from Example Freight Payroll, Tue 1 Dec", false]);
    assert.match(shown.w.map((m) => m.where).join(" | "), /Clinica Sorriso \| an email from Example Freight Payroll/, "everything that came in, the person's words among it");
    assert.equal(pinned[0].value, "Robin's wife is Ana Fixture. She is expecting their first child.", "added to what the note said, nothing lost");
    assert.equal(r.read, 2);
    assert.deepEqual(mod.readRecord(facts).cursor, CURSOR, "the next look reads only what came after");
    // A second note about the same person goes into the one there is.
    const again = await mod.review("u1", { fit: keep, now: NOW + 7200000, items: items([{ ...words[0], n: 1, at: NOW + 3600000 }]), judge: async () => [{ key: "family-baby", category: "person", subject: "Ana Fixture (Ana), Robin's wife", adds: "Ana Fixture is expecting a baby.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual([again.pinned[0].key, again.pinned[0].subject], ["family-partner", "Ana Fixture"], "one note per subject, under its own name");
    const sum = await mod.review("u1", { fit: keep, now: NOW + 9000000, items: items([{ ...words[0], n: 1, at: NOW + 8000000 }]), judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "Ana Fixture is expecting a baby, due in 2027.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual(sum.pinned, [], "a year nobody wrote is not a fact");
    const dated = await mod.review("u1", { fit: keep, now: NOW + 11000000, items: items([{ ...words[0], n: 1, at: NOW + 10000000 }]), judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She was expecting their first child as of December 2026.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.equal(dated.pinned.length, 1, "the year they wrote it in is theirs");
    facts["family-partner"].value = "Robin's wife is Ana Fixture. She lives in Lisbon. She was expecting their first child as of December 2026.";
    const same = await mod.review("u1", { fit: keep, now: NOW + 13000000, items: items([{ ...words[0], n: 1, at: NOW + 12000000 }]), judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She was expecting their first child as of December 2026.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual(same.pinned, [], "a note with nothing new is left as it was");
    const moved = await mod.review("u1", { fit: keep, now: NOW + 15000000, items: items([{ ...words[0], n: 1, at: NOW + 14000000 }]), judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She lives in Porto.", replaces: "She lives in Lisbon.", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.equal(moved.pinned[0].value, "Robin's wife is Ana Fixture. She lives in Porto. She was expecting their first child as of December 2026.", "only the sentence their words make untrue is replaced");
    // Which note a fact goes in is code's to say. About the person
    // themselves: one note for each part of their life, whatever note the
    // LLM named; about anyone else, only a note about that same one.
    facts["health-procedure"] = { value: "Robin had a knee operation in 2025.", category: "person", subject: "Robin Fixture" };
    const routed = await mod.review("u1", { fit: keep, now: NOW + 17000000, pin: async () => {}, items: items([{ ...words[1], n: 1, at: NOW + 16000000, text: "Your payslip for November 2026. Employee: Robin Fixture, robin@freight.example. Employer: Example Freight Ltd." }]), confirm: async () => true, judge: async () => [
      { key: "[health-procedure]", category: "person", subject: "Robin Fixture", adds: "Robin's work email is robin@freight.example.", replaces: "", n: 1, quote: "robin@freight.example", topic: "Work contact" },
      { key: "[family-partner]", category: "business", subject: "Example Freight", adds: "Example Freight Ltd employs Robin.", replaces: "", n: 1, quote: "Employer: Example Freight Ltd.", topic: "" },
      { key: "profile-home", category: "profile", subject: "Robin", adds: "Robin lives at Harbour Row.", replaces: "", n: 1, quote: "Employer: Example Freight Ltd.", topic: "" },
    ] });
    assert.deepEqual(routed.pinned.map((f) => [f.key, f.category]), [["profile-contact", "profile"], ["business-example-freight", "business"]],
      "the work address under Contact, one of the fixed parts of About you, not the note on their health; the company in a note of its own, not the partner's; a fact about them with no part of life named is not filed");
    // A finding is fitted to what is pinned: said already, it is passed
    // over; partly said, only the rest is added; about the person, it joins
    // whichever of their notes it belongs to.
    facts["profile-email"] = { value: "Robin's email is robin@home.example.", category: "profile", subject: "Robin" };
    facts["health-knee"] = { value: "Robin had a knee operation in 2025.", category: "person", subject: "Robin" };
    const offered = [];
    const fitted = await mod.review("u1", { now: NOW + 21000000, pin: async () => {}, confirm: async () => true, items: items([{ ...words[0], n: 1, at: NOW + 20000000, text: "My numbers: robin@home.example, +44 7000 000000. And Ana's my wife, she's from Lisbon." }]),
      judge: async () => [
        { key: "family-partner", category: "person", subject: "Ana Fixture", adds: "Robin's wife is Ana Fixture.", replaces: "", n: 1, quote: "Ana's my wife" },
        { key: "profile-contact", category: "profile", subject: "Robin", adds: "Robin's email is robin@home.example and his phone number is +44 7000 000000.", replaces: "", n: 1, quote: "+44 7000 000000", topic: "contact" },
      ],
      fit: async (u, held, notes) => { offered.push([held.key, notes.map((x) => x.key)]); return held.key === "family-partner" ? { note: "family-partner", adds: "" } : { note: "profile-email", adds: "Robin's phone number is +44 7000 000000." }; } });
    assert.deepEqual(offered, [["family-partner", ["family-partner"]], ["profile-contact", ["profile-email"]]], "each finding beside the notes it could join: its subject's, or the person's own About you notes, never one filed among people under their name");
    assert.deepEqual(fitted.pinned.map((f) => [f.key, f.value]), [["profile-email", "Robin's email is robin@home.example. Robin's phone number is +44 7000 000000."]],
      "a finding the note already says is passed over; the rest joins the note it belongs in, not a second note beside it");
    // Anything but their own words is checked once more beside its item.
    const asked = [];
    const checked = await mod.review("u1", { fit: keep, now: NOW + 19000000, pin: async () => {}, items: items([{ ...words[1], n: 1, at: NOW + 18000000, text: "Dana Fixture will view the flat on Robin's behalf on Saturday." }, { ...words[0], n: 2, at: NOW + 18000001, text: "Ana and I are moving to Porto for good next spring." }]), judge: async () => [
      { key: "person-dana", category: "person", subject: "Dana Fixture", adds: "Dana Fixture views flats on Robin's behalf.", replaces: "", n: 1, quote: "will view the flat on Robin's behalf" },
      { key: "family-partner", category: "person", subject: "Ana Fixture", adds: "Ana and Robin are moving to Porto for good.", replaces: "", n: 2, quote: "moving to Porto for good" },
    ], confirm: async (u, held, item) => { asked.push([held.key, item.text]); return false; } });
    assert.deepEqual(checked.pinned.map((f) => f.key), ["family-partner"], "someone else's words turned down on the second check are not pinned; their own words need no second check");
    assert.deepEqual(asked, [["person-dana", "Dana Fixture will view the flat on Robin's behalf on Saturday."]], "the finding is checked beside its own item");
  } finally { restore(); }
});

test("facts follow at most once an hour, and are kept through pin_fact", async () => {
  const facts = {};
  const { mod, restore } = followHarness(facts);
  try {
    let read = 0;
    const deps = { items: async () => { read++; return { items: [], cursor: {} }; } };
    await mod.review("u1", deps);
    await mod.review("u1", deps);
    assert.equal(read, 1, "once an hour");
  } finally { restore(); }
  // What is new is read twice. Catching up on what was there before (full
  // shares, more behind them) reads each once, up to three a look, and asks
  // for the next look soon rather than in an hour.
  {
    const facts = {};
    const { mod, restore: undo } = followHarness(facts);
    try {
      const shares = [1, 2, 3, 4, 5].map((n) => ({ items: words, cursor: { at: new Date(NOW - (10 - n) * 60000).toISOString(), id: `s${n}` }, more: n < 5 }));
      const next = async (u, cursor) => shares.find((s) => !cursor.id || s.cursor.id > cursor.id);
      let judged = 0, soon = 0;
      const deps = { items: next, judge: async () => { judged++; return []; }, pin: async () => {}, fit: keep, confirm: async () => true, soon: () => { soon++; } };
      await mod.review("u1", { ...deps, now: NOW });
      assert.deepEqual([judged, soon, mod.readRecord(facts).cursor.id, mod.readRecord(facts).more], [3, 1, "s3", true], "three full shares, once each, and the next look soon");
      judged = 0;
      await mod.review("u1", { ...deps, now: NOW + 600000 });
      assert.deepEqual([judged, soon, mod.readRecord(facts).cursor.id, mod.readRecord(facts).more], [3, 1, "s5", false], "the last full share once, then what is new twice, and no early look after");
      // While catching up, the next look comes after minutes, not an hour.
      const at = (minutes, more) => { facts["_facts-follow"] = { value: JSON.stringify({ v: 3, looked: new Date(Date.now() - minutes * 60000).toISOString(), cursor: { at: "2026-12-01T00:00:00Z", id: "s1" }, more }) }; };
      let looked = 0;
      const count = { ...deps, items: async () => { looked++; return { items: [], cursor: {} }; } };
      at(9, true); await mod.review("u1", count);
      at(7, true); await mod.review("u1", count);
      at(30, false); await mod.review("u1", count);
      assert.equal(looked, 1, "after 9 minutes while catching up; not after 7, nor after 30 once caught up");
    } finally { undo(); }
  }
  const src = read("lib/facts-follow.js");
  assert.match(src, /require\("\.\/tools\/handlers"\)\.handleInternalTool\("pin_fact", \{ key: held\.key, value: held\.value, category: held\.category, subject: held\.subject, _userId: userId \}\);/, "one note per subject, as pin_fact keeps it");
  assert.match(src, /kept\.source = held\.own \? "own words" : "connected"; kept\.from = held\.from;/, "and says where it came from");
  assert.match(read("webapp/views/dashboard.html"), /note\.from \? 'Pinned by Closedhand from ' \+ note\.from/, "which the fact's panel names");
});

// Everything connected is read, a share at a time, from where the last look
// stopped: the whole store first, then what is new. Bulk mail, drafts,
// sign-in codes and the person's chats with Closedhand are passed over.
test("a look reads every connection's items in the order they reached Closedhand, and the next goes on from there", async () => {
  const rows = [
    { source: "gmail", type: "email", external_id: "e1", created_at: "2026-11-01T08:00:00.120Z", received_at: "2026-10-30T09:00:00.000Z", data: { from: "Payroll <pay@freight.example>", subject: "Your payslip", body: "Employer: Example Freight Ltd.", labels: ["INBOX"] } },
    { source: "gmail", type: "email", external_id: "e2", created_at: "2026-11-01T08:00:00.120Z", received_at: "2026-10-30T10:00:00.000Z", data: { from: "Deals <deals@shop.example>", subject: "50% off", body: "Big sale", labels: ["INBOX", "CATEGORY_PROMOTIONS"] } },
    { source: "gmail", type: "email", external_id: "e3", created_at: "2026-11-01T08:00:00.121Z", received_at: "2026-10-30T11:00:00.000Z", data: { to: "Ana <ana@home.example>", subject: "Dinner", body: "I'll be home by 7", labels: ["SENT"] } },
    { source: "whatsapp_linked", type: "message", external_id: "w1", created_at: "2026-11-01T08:00:01.000Z", received_at: "2026-10-31T12:00:00.000Z", data: { chat: "bot-chat", chat_name: "Closedhand", sender: "me", text: "remind me tomorrow" } },
    { source: "mcp:notes-1", type: "page", external_id: "p1", created_at: "2026-11-01T08:00:02.000Z", received_at: "2026-10-31T13:00:00.000Z", data: { title: "Allotment", content: "Plot 14 at Harbour Lane allotments, rented since 2019." } },
  ];
  const queries = [];
  const builder = (table) => {
    const f = { table, gte: null, lt: null, gt: null, eq: {} };
    const q = { select() { return q; }, eq(k, v) { f.eq[k] = v; return q; }, gte(k, v) { f.gte = v; return q; }, lt(k, v) { f.lt = v; return q; }, gt(k, v) { f.gt = v; return q; }, order() { return q; }, limit() { return q; },
      then(ok, bad) {
        queries.push(f);
        if (table === "chat_links") return Promise.resolve({ data: [{ platform_user_id: "bot-chat" }], error: null }).then(ok, bad);
        const t = (r) => Date.parse(r.created_at);
        const data = rows.filter((r) => (!f.gte || t(r) >= Date.parse(f.gte)) && (!f.lt || t(r) < Date.parse(f.lt)) && (!f.gt || r.external_id > f.gt));
        return Promise.resolve({ data, error: null }).then(ok, bad);
      } };
    return q;
  };
  const dbPath = require.resolve("../lib/db");
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: { from: builder } } };
  const mPath = require.resolve("../lib/facts-follow");
  delete require.cache[mPath];
  try {
    const { newItems } = require("../lib/facts-follow");
    const first = await newItems("u1", {});
    assert.deepEqual(first.items.map((m) => [m.where, m.own]), [["an email from Payroll", false], ["email to Ana", true], ["a page", false]],
      "mail, the person's own mail and any connection's items; not a promotion, nor their chat with Closedhand");
    assert.match(first.items[2].text, /Plot 14 at Harbour Lane allotments/);
    assert.deepEqual(first.cursor, { at: "2026-11-01T08:00:02.000Z", id: "p1" });
    assert.equal(first.more, false, "it reached the present");
    const next = await newItems("u1", first.cursor);
    assert.deepEqual(next.items, [], "the next look goes on after where this one stopped");
    // Two items that reached Closedhand in one millisecond: the look that
    // stopped between them goes on with the second.
    const between = await newItems("u1", { at: "2026-11-01T08:00:00.120Z", id: "e1" });
    assert.deepEqual(between.items.map((m) => m.where), ["email to Ana", "a page"]);
    // More than one share holds: the look stops when it is full, and says so.
    for (let i = 0; i < 60; i++) rows.push({ source: "mcp:notes-1", type: "page", external_id: `q${String(i).padStart(2, "0")}`, created_at: new Date(Date.parse("2026-11-02T08:00:00.000Z") + i * 1000).toISOString(), received_at: "2026-11-02T08:00:00.000Z", data: { title: "Allotment log", content: "Plot 14 watered and weeded. ".repeat(40) } });
    const full = await newItems("u1", first.cursor);
    assert.equal(full.more, true, "a full share, more behind it");
    assert.ok(full.items.length > 0 && full.items.length < 60);
    const rest = await newItems("u1", full.cursor);
    assert.equal(rest.more, false, "and the look that reaches the present says so");
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
    delete require.cache[mPath];
  }
});

// What the fit step keeps of the LLM's answer: the rest of a sentence reads
// as one, and an answer longer than the finding itself is not taken.
test("what a finding adds to a note reads as a sentence, and is never more than the finding", async () => {
  let answer = "";
  const stub = (rel, exports) => { const p = require.resolve(rel); const was = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return () => { if (was) require.cache[p] = was; else delete require.cache[p]; }; };
  const undo = [stub("../lib/llm", { getInternalClient: () => ({ model: "m", client: { messages: { create: async () => ({ answer }) } } }) }), stub("../lib/model-wire", { responseText: (r) => r.answer })];
  const mPath = require.resolve("../lib/facts-follow");
  delete require.cache[mPath];
  try {
    const { fit } = require("../lib/facts-follow");
    const held = { key: "family-mum", adds: "Robin's mother is Jill Fixture, and she keeps two allotment plots." };
    answer = '{"note": "[family-mum]", "adds": "she keeps two allotment plots"}';
    assert.deepEqual(await fit("u1", held, [{ key: "family-mum", value: "Robin's mother is Jill Fixture." }], "Robin"), { note: "family-mum", adds: "She keeps two allotment plots." });
    answer = '{"note": "family-mum", "adds": ""}';
    assert.equal((await fit("u1", held, [], "Robin")).adds, "", "said already");
    answer = JSON.stringify({ note: "family-mum", adds: "Robin's mother is Jill Fixture, who keeps two allotment plots and grows prize-winning leeks for the county show every year." });
    assert.equal((await fit("u1", held, [], "Robin")).adds, held.adds, "nothing made up on the way");
  } finally { undo.forEach((u) => u()); delete require.cache[mPath]; }
});

// Thinning Pinned Facts at 150: the LLM was handed every key in the store,
// tracked flights and sync markers too, and what it kept was rebuilt from four
// fields, so one pass emptied the dashboard's groups and About you.
test("thinning Pinned Facts never touches Closedhand's own records, and a fact that stays keeps all that is known about it", () => {
  const compact = require("../lib/facts-compact");
  const facts = {
    "_sync_gmail": JSON.stringify({ cursor: "abc" }),
    "flight-ZX101-2026-11-02": { value: JSON.stringify({ flightNumber: "ZX101" }), created: "2026-10-01T00:00:00Z" },
    "pulse-last": "2026-11-01",
    "old-style": "Likes window seats",
  };
  for (let i = 0; i < 30; i++) facts["fact-" + i] = { value: `Fact number ${i}, said at some length`, created: "2026-09-0" + (1 + (i % 9)) + "T00:00:00Z", lastAccessed: "2026-10-01T00:00:00Z", accessCount: i, category: i % 2 ? "person" : "preference", subject: "Mira", source: "chat", from: "whatsapp" };

  assert.equal(compact.pinned(facts).length, 31, "its own records are not counted");
  const shown = compact.listFor(facts);
  assert.equal(shown.length, 31);
  assert.ok(!shown.some((f) => /^(_sync|flight-|pulse)/.test(f.key)), "nor shown to the LLM");

  // The LLM keeps 25, shortens one, makes one up, tries to rewrite a flight and returns one value that is not words.
  const answer = { "flight-ZX101-2026-11-02": "cancelled", "made-up": "Something new", "old-style": "Likes window seats", "fact-1": { nested: true } };
  for (let i = 5; i < 30; i++) answer["fact-" + i] = i === 5 ? "Fact 5, shorter" : facts["fact-" + i].value;
  const out = compact.apply(facts, answer, "2026-11-16T00:00:00Z");
  assert.deepEqual(out.facts["_sync_gmail"], facts["_sync_gmail"]);
  assert.deepEqual(out.facts["flight-ZX101-2026-11-02"], facts["flight-ZX101-2026-11-02"], "a tracked flight is as it was");
  assert.equal(out.facts["pulse-last"], "2026-11-01");
  assert.ok(!("made-up" in out.facts), "a key it invented is nothing");
  assert.deepEqual(out.facts["fact-5"], { ...facts["fact-5"], value: "Fact 5, shorter" }, "shortened, with its category, subject and source");
  assert.deepEqual(out.facts["fact-6"], facts["fact-6"]);
  assert.deepEqual(out.facts["old-style"], { value: "Likes window seats", created: "2026-11-16T00:00:00Z", lastAccessed: "2026-11-16T00:00:00Z", accessCount: 0 });
  assert.deepEqual(out.dropped.sort(), ["fact-0", "fact-1", "fact-2", "fact-3", "fact-4"].sort(), "what goes is named, and a value that is not words is not kept");
  assert.equal(out.compressed, 1);
  assert.equal(out.kept, 25);

  assert.equal(compact.apply(facts, { "fact-1": "only this" }), null, "an answer that keeps too few is not believed");
  assert.equal(compact.apply(facts, null), null);
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /require\("\.\.\/facts-compact"\)\.pinned\(ctx\.store\.facts\)\.length/, "the 150 counts only Pinned Facts");
  assert.match(handlers, /const result = compact\.apply\(ctx\.store\.facts, compacted\);/);
});
