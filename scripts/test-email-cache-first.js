// The synced copy is the mailbox. A search answers from it, "no match"
// included, whenever it covers the period asked; the provider is asked only
// for older mail, an unread check or a stopped sync, and even then only for
// the list of matches: messages already synced are read from the copy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const fn = (src, name) => { const s = src.indexOf(`async function ${name}`); return src.slice(s, src.indexOf("\n}\n", s) + 2); };

function fakeDb(rows) {
  return { from: () => { const q = { filters: [], select: () => q, eq: () => q, not: () => q, order: () => q, in: (k, ids) => { q.ids = ids; return q; },
    limit: async () => ({ data: rows }), then: (r) => r({ data: rows.filter((x) => !q.ids || q.ids.includes(x.external_id)) }) }; return q; } };
}
// Tables by name, for cacheCovers.
function tables(t) { return { from: (name) => ({ select: () => ({ eq: async () => ({ data: t[name] || [] }) }) }) }; }

test("the copy covers a period when every mailbox holds all of it, within the year kept", async () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const horizon = () => new Date(now - 365 * 86400000).toISOString();
  const covers = (t) => { const box = { supabase: tables(t), Date, require: () => ({ horizon }) }; vm.runInNewContext(fn(read("lib/services/data-sync.js"), "cacheCovers") + "\nthis.f = cacheCovers;", box); return box.f; };
  const two = { connections: [{ service: "google" }, { service: "google_extra_work" }, { service: "whatsapp_linked" }] };
  let f = covers({ ...two, mail_coverage: [{ source: "gmail", complete_since: "2026-08-01T00:00:00Z" }, { source: "gmail_work", complete_since: "2026-09-01T00:00:00Z" }] });
  assert.equal(await f("u", "2026-09-27T00:00:00Z"), true, "the last weeks are inside both");
  assert.equal(await f("u", "2026-08-15T00:00:00Z"), false, "one mailbox doesn't reach back that far");
  assert.equal(await f("u", "2025-01-01T00:00:00Z"), false, "past the year kept");
  f = covers({ ...two, mail_coverage: [{ source: "gmail", complete_since: "2026-08-01T00:00:00Z" }] });
  assert.equal(await f("u", "2026-09-27T00:00:00Z"), false, "a mailbox not yet read back covers nothing");
  // The old rule: the oldest cached email. One sent in 2020 made three weeks
  // of mail "cover" six years, and search said no match for mail that existed.
  assert.doesNotMatch(read("lib/services/data-sync.js"), /\.order\("received_at", \{ ascending: true \}\)\s*\.limit\(1\);\s*if \(error \|\| !data\?\.length\) return false;/);
});

test("a live search reads synced messages from the copy and fetches only the rest", async () => {
  const box = { ctx: { activeUserId: "u" }, console: { log() {} },
    supabase: fakeDb([{ external_id: "m1", source: "gmail", data: { subject: "Synced", body: "from the copy" } }]) };
  vm.runInNewContext(fn(read("lib/services/data-access.js"), "syncedCopies") + "\nthis.f = syncedCopies;", box);
  const got = await box.f(["m1", "m2"]);
  assert.equal(got.size, 1);
  assert.equal(got.get("m1").subject, "Synced");
  const src = read("lib/services/data-access.js");
  assert.equal((src.match(/synced\.has\(id\) \? Promise\.resolve\(synced\.get\(id\)\)/g) || []).length, 2, "both Gmail paths reuse the copy");
});

test("no match inside the copy's period is the answer, not a reason to go live", () => {
  const sync = read("lib/services/data-sync.js");
  assert.match(sync, /return \{ results: \[\], cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers\(userId, since\), source: "data_cache_hybrid" \};/);
  assert.doesNotMatch(sync, /report a miss so the caller falls to\n\s*\/\/ live search/);
  const access = read("lib/services/data-access.js");
  assert.match(access, /if \(cached && cached\.fresh && !cached\.covers && cached\.results\.length > 0\) fromCopy = cached\.results;\n\s*else if \(cached && cached\.fresh && \(cached\.results\.length > 0 \|\| cached\.covers\)\) \{/);
  assert.match(access, /if \(fromCopy\.length\) \{\n\s*allResults\.unshift\(\.\.\.fromCopy\);/, "matches from a copy that doesn't hold the period join the mailbox's");
  assert.match(sync, /return \{ results: ordered, cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers\(userId, since\), source: "data_cache_hybrid" \};/);
  assert.match(access, /so this is the answer, not a gap/);
});

// Every search loaded the 500 newest emails whole, attachments' text
// included, to learn one thing from them: when the copy was last synced.
test("a search reads one timestamp for freshness, and whole emails only when it wants the newest", async () => {
  const reads = [];
  const mail = [{ external_id: "m1", source: "gmail", synced_at: new Date().toISOString(), data: { subject: "Invoice 4471" } }];
  const db = { from: (table) => {
    const read = { table, cols: null, limit: null };
    const q = { select: (cols) => { read.cols = cols; reads.push(read); return q; }, eq: () => q, order: () => q, in: () => q,
      limit: (n) => { read.limit = n; return q; }, then: (done) => done({ data: mail, error: null }) };
    return q;
  } };
  const run = async (query) => {
    reads.length = 0;
    const box = { supabase: db, Date, Math, Map, Set, console: { log() {}, error() {} }, peek: (x) => x, cacheCovers: async () => true,
      require: () => ({ search: async () => ({ results: [{ id: "m1" }] }) }) };
    vm.runInNewContext(fn(read("lib/services/data-sync.js"), "queryCacheEmails") + "\nthis.f = queryCacheEmails;", box);
    return box.f("u", query, 7);
  };
  const specific = await run("invoice 4471");
  assert.equal(specific.source, "data_cache_hybrid");
  assert.equal(specific.results[0].subject, "Invoice 4471");
  assert.deepEqual(reads.map((r) => [r.cols, r.limit]), [["synced_at", 1], ["external_id, source, data", null]], "one timestamp, then only the matches");
  const generic = await run("recent");
  assert.equal(generic.source, "data_cache");
  assert.equal(generic.results[0].subject, "Invoice 4471");
  assert.deepEqual(reads.map((r) => [r.cols, r.limit]), [["synced_at", 1], ["source, data", 500]], "the newest mail, without the columns nothing reads");
  assert.doesNotMatch(read("lib/services/data-sync.js"), /from\("data_cache"\)\s*\.select\("\*"\)/, "no read of the synced copy takes every column");
});

// Asked for the last 3 days, mail search ranked all of a person's mail and kept
// the best 30 of each arm: a draft saved minutes earlier, holding every word
// searched for, came 68th by words and 63rd by meaning and was never seen.
// The stretch asked for is ranked by itself and comes first. Invented mail.
test("a stretch of time asked for is ranked by itself and comes first, then the best of everything", async () => {
  const src = read("lib/services/usi.js");
  const now = Date.now(), day = 86400000;
  const mail = [
    { id: "old-1", at: now - 40 * day, words: 0.9, meaning: 0.9 },
    { id: "old-2", at: now - 30 * day, words: 0.8, meaning: 0.8 },
    { id: "new-1", at: now - 1 * day, words: 0.2, meaning: 0.5 },
  ];
  const calls = [];
  let embeds = 0;
  const supabase = { rpc: async (name, args) => {
    calls.push({ name, since: args.filter_since || null });
    const inside = mail.filter((m) => !args.filter_since || m.at >= Date.parse(args.filter_since));
    if (name === "search_data_cache_lexical") return { data: [...inside].sort((a, b) => b.words - a.words).map((m) => ({ external_id: m.id, source: "gmail", type: "email", data: { subject: m.id, body: "" } })) };
    return { data: [...inside].sort((a, b) => b.meaning - a.meaning).map((m) => ({ service: "email", item_type: "email", external_id: m.id, content: m.id, source_metadata: {}, similarity: m.meaning })) };
  } };
  const box = { supabase, console: { log() {} }, RRF_K: 60, MEDIA_MATCH: 0.5, _lexUnavailableReported: false,
    lexicalTokens: (q) => q.split(" "), matchWindow: () => "", embedWithinBudget: async () => { embeds++; return [1]; },
    require: (n) => n === "../people" ? { load: async () => ({ expand: () => [] }) } : n === "../otp-guard" ? { redactRecall: (r) => r } : assert.fail(`unexpected ${n}`) };
  const plain = (name) => { const s = src.indexOf(`async function ${name}(`); return src.slice(s, src.indexOf("\n}\n", s) + 2); };
  vm.runInNewContext(plain("lexicalSearch") + plain("search") + plain("fuseArms") + "\nthis.search = search;", box);
  const ids = (r) => Array.from(r.results, (x) => x.id);

  assert.deepEqual(ids(await box.search("u", "proforma freight", { cacheType: "email", service: "email" })), ["old-1", "old-2", "new-1"], "with no stretch asked, all of it by relevance, as before");
  assert.deepEqual(Array.from(calls, (c) => c.since), [null, null]);

  calls.length = 0; embeds = 0;
  const since = new Date(now - 3 * day).toISOString();
  assert.deepEqual(ids(await box.search("u", "proforma freight", { cacheType: "email", service: "email", since })), ["new-1", "old-1", "old-2"], "the last 3 days first, then the rest");
  assert.equal(embeds, 1, "the query is embedded once for both rankings");
  assert.deepEqual(calls.map((c) => `${c.name} ${c.since ? "stretch" : "all"}`).sort(),
    ["search_data_cache_lexical all", "search_data_cache_lexical stretch", "search_data_vectors all", "search_data_vectors stretch"]);

  mail.pop();
  assert.deepEqual(ids(await box.search("u", "proforma freight", { cacheType: "email", service: "email", since })), ["old-1", "old-2"], "nothing in the stretch: the best of everything");

  // Only days the LLM asked for are a stretch: the default 7 is not, so a
  // search for an old email asked with no days still finds it first.
  assert.match(read("lib/tools/handlers.js"), /days: toolInput\.days \|\| 7,\n\s*\/\/ [^\n]*\n\s*window: !!toolInput\.days,/);
  assert.match(read("lib/services/data-access.js"), /queryCacheEmails\(userId, query, days, \{ window \}\)/);
  assert.match(read("lib/services/data-sync.js"), /search\(userId, query, \{ cacheType: "email", service: "email", maxResults: 30, \.\.\.\(window \? \{ since \} : \{\}\) \}\)/);
  const sql = read("migrations/096_search_window.sql");
  assert.match(sql, /AND \(filter_since IS NULL OR dc\.received_at >= filter_since\)/, "the word search filters inside its query");
  assert.match(sql, /IF filter_since IS NULL THEN[\s\S]+ORDER BY sv\.embedding <=> query_embedding[\s\S]+AND dc\.received_at >= filter_since[\s\S]+LIMIT 2000/, "the meaning search measures the stretch's own items");
});
