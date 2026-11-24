// The shape a Pinned Fact keeps (lib/facts-shape.js), wherever it is written.
// The writer names a note's heading and code guards it: a heading they have,
// named within it, goes under it; a treatment or an operation is under Health,
// never a heading of its own ("Health knee surgery"); a heading is a word or
// two; the name is the name alone. A note grown past its size is rewritten
// short, and the rewrite may never lose an address, a phone number or a
// reference number. Invented people and numbers only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
process.env.CTX_STRICT = "off";

test("the writer names a heading, and code guards it", () => {
  const { headingKey } = require("../lib/facts-shape");
  const have = ["profile-contact", "profile-health", "profile-name"];
  for (const [given, key, none] of [
    ["health-knee-surgery", "profile-health", "profile-health"], ["knee surgery", "profile-health", "profile-health"], ["allergies", "profile-health", "profile-health"],
    ["work contact", "profile-contact", "profile-work-contact"], ["profile-contact", "profile-contact", "profile-contact"],
    ["email", "profile-email", "profile-email"], ["languages", "profile-languages", "profile-languages"], ["Travel documents", "profile-travel-documents", "profile-travel-documents"],
    ["travel documents and visas", "profile-travel", "profile-travel"], ["name", "profile-name", "profile-name"], ["full name", "profile-full-name", "profile-full-name"],
  ]) {
    assert.equal(headingKey(given, have), key, `${given}, beside Contact and Health`);
    assert.equal(headingKey(given, []), none, `${given}, with nothing pinned`);
  }
  assert.equal(headingKey("", have), null);
});

test("a rewrite keeps every address, phone number and reference number, or the note stays as it was", async () => {
  const { lost } = require("../lib/facts-shape");
  const note = "Harbour Padel (Pty) Ltd is registered under number K2099701922. Support: support@harbourpadel.example. Mobile +44 7700 900123. In November 2026 a reply went about an $8,770 order.";
  assert.deepEqual(lost(note, "Harbour Padel Ltd. Support support@harbourpadel.example, mobile +44 7700 900123."), ["k2099701922"]);
  assert.deepEqual(lost(note, "Reg. K2099701922; support@harbourpadel.example; +447700900123."), [], "a one-off amount and a year may go");

  const replies = [];
  const llm = require.resolve("../lib/llm.js"), wire = require.resolve("../lib/model-wire.js"), shapeFile = require.resolve("../lib/facts-shape.js");
  const was = { llm: require.cache[llm], wire: require.cache[wire] };
  const asked = [];
  require.cache[llm] = { id: llm, filename: llm, loaded: true, exports: { getInternalClient: () => ({ model: "m", client: { messages: { create: async (p) => { asked.push(p.messages[0].content); return { text: replies.shift() }; } } } }) } };
  require.cache[wire] = { id: wire, filename: wire, loaded: true, exports: { responseText: (r) => r.text } };
  delete require.cache[shapeFile];
  try {
    const { rewriteNote, LASTING } = require("../lib/facts-shape");
    replies.push("Harbour Padel Ltd, padel equipment. Support: support@harbourpadel.example.", "Harbour Padel Ltd, padel equipment; South African entity reg. K2099701922. Support: support@harbourpadel.example; +44 7700 900123.");
    assert.equal(await rewriteNote("u", { name: "Sam", about: { subject: "Harbour Padel" }, note }), "Harbour Padel Ltd, padel equipment; South African entity reg. K2099701922. Support: support@harbourpadel.example; +44 7700 900123.");
    assert.match(asked[1], /Keep these exactly as written: k2099701922, \+447700900123\./, "asked once more, naming what it left out");
    assert.match(asked[0], /calendar entries and when they repeat/);
    assert.match(LASTING, /never its price, quotes or the steps along the way/);
    replies.push("Harbour Padel Ltd.", "Harbour Padel Ltd, padel.");
    assert.equal(await rewriteNote("u", { name: "Sam", about: { subject: "Harbour Padel" }, note }), null, "still lost: the note stays as it was");
  } finally {
    if (was.llm) require.cache[llm] = was.llm; else delete require.cache[llm];
    if (was.wire) require.cache[wire] = was.wire; else delete require.cache[wire];
    delete require.cache[shapeFile];
  }
});

test("every writer keeps the shape: chat's pin_fact, what came in, the setup scan", () => {
  const handlers = read("lib/tools/handlers.js");
  const pin = handlers.slice(handlers.indexOf('case "pin_fact": {'), handlers.indexOf('case "get_facts": {'));
  assert.match(pin, /const part = shape\.headingKey\(toolInput\.key, Object\.keys\(ctx\.store\.facts\)\.filter\(\(k\) => \/\^profile-\/\.test\(k\)\)\);\n\s*if \(!part\) return \{ error:/, "an About you note under its guarded heading"); 
  assert.match(pin, /if \(old && !old\.includes\(value\)\) value = `\$\{old\.replace\(\/\[\.!\?\]\?\$\/, "\."\)\} \$\{value\}`;/, "joining what is there");
  assert.match(pin, /if \(part !== key && part !== "profile-name"\) \{/, "the name is replaced, never joined");
  assert.match(pin, /if \(value\.length > shape\.NOTE_MAX\) \{/, "grown past its size, rewritten short");
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /a broad part of their life in a word or two \(profile-health, profile-contact, profile-languages\), never one thing within it, and a heading they have whenever the fact is what it names\. profile-name is the name alone\./);
  assert.match(defs, /what Closedhand can look up \(calendar entries and when they repeat, bookings, messages\) or what a project of theirs already holds/);
  const follow = read("lib/facts-follow.js");
  assert.match(follow, /const part = require\("\.\/facts-shape"\)\.headingKey\(held\.topic, Object\.keys\(facts\)\.filter\(\(k\) => \/\^profile-\/\.test\(k\)\)\);/);
  assert.match(follow, /a broad part of their life in a word or two \(health, contact, languages\), never one thing within it/);
  assert.match(follow, /String\(v\.value \?\? ""\)\.trim\(\) && k === held\.key\);/, "only the note under its own heading or subject is offered");
  assert.match(follow, /if \(!part \|\| part === "profile-name"\) continue;/, "what came in never sets their name");
  assert.match(follow, /if \(held\.value\.length > shape\.NOTE_MAX\) \{\n\s*const short = await \(deps\.rewrite \|\| shape\.rewriteNote\)/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /if \(cat === 'profile'\) rows\.sort\(function\(a, b\) \{ return \(a\.key === 'profile-name' \? 0 : 1\) - \(b\.key === 'profile-name' \? 0 : 1\) \|\| factLabel\(a\)\.localeCompare\(factLabel\(b\)\); \}\);/, "About you by heading, the name first");
  assert.match(dash, /var valPreview = n\.value \|\| '';/, "a note shows whole");
});
