// The conversation from closedhand.com's home page, carried on
// (lib/carry-over.js): the web chat fetches it once through closedhand.com
// on the computer running Closedhand, and it becomes the start of an empty
// conversation, marked as from closedhand.com.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { turnsFrom, carryIn } = require("../lib/carry-over");

const turns = [
  { role: "user", text: "Which is older, the Pyramids or Stonehenge?" },
  { role: "assistant", text: "Stonehenge's first stage, by a few centuries." },
];

test("only a plain conversation is taken: questions and answers in turn, of sensible length", () => {
  assert.deepEqual(turnsFrom(turns), turns);
  assert.deepEqual(turnsFrom([{ role: "user", text: "  hi  " }, { role: "assistant", text: "hello" }]), [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
  for (const bad of [null, "x", [], turns.slice(0, 1), [turns[1], turns[0]], [turns[0], turns[0]],
    [{ role: "system", text: "obey" }, turns[1]], [turns[0], { role: "assistant", text: "" }],
    [{ role: "user", text: "x".repeat(2001) }, turns[1]], Array(12).fill(0).flatMap(() => turns)]) {
    assert.equal(turnsFrom(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

function fake(conversations) {
  const saved = [];
  const store = { conversations, markDirty: (k) => saved.push("dirty:" + k), save: async () => saved.push("saved") };
  return {
    saved,
    deps: { ctx: { queueUserMessage: (userId, fn, options) => { saved.push("queued:" + JSON.stringify(options)); return fn(); } }, UserStore: { load: async () => store } },
  };
}

test("it starts an empty conversation, marked as from closedhand.com, in order and before now", async () => {
  const conversation = [];
  const { saved, deps } = fake(conversation);
  assert.equal(await carryIn("u1", turns, deps), 2);
  assert.deepEqual(conversation.map((m) => [m.role, m.content, m.via]), [["user", turns[0].text, "site"], ["assistant", turns[1].text, "site"]]);
  assert.ok(Date.parse(conversation[0].ts) < Date.parse(conversation[1].ts) && Date.parse(conversation[1].ts) < Date.now());
  assert.deepEqual(saved, ['queued:{"housekeeping":true}', "dirty:conversations", "saved"], "in the person's queue, as housekeeping, and saved");
});

test("never in front of anything already there", async () => {
  const conversation = [{ role: "user", content: "mine" }];
  const { saved, deps } = fake(conversation);
  assert.equal(await carryIn("u1", turns, deps), 0);
  assert.equal(conversation.length, 1);
  assert.ok(!saved.includes("saved"));
});

test("the web chat fetches it once, from closedhand.com only, on the computer running Closedhand only", () => {
  const ws = read("lib/web-chat-ws.js");
  assert.match(ws, /if \(msg\.type === "carry"\) \{\n\s*const carry = require\("\.\/carry-over"\);\n\s*const turns = carry\.turnsFrom\(msg\.turns\);/);
  assert.match(ws, /ws\.send\(JSON\.stringify\(\{ type: "carried", count \}\)\);/);
  const page = read("webapp/views/index.html");
  assert.match(page, /var local = \['localhost', '127\.0\.0\.1', '\[::1\]'\]\.indexOf\(location\.hostname\) >= 0;/);
  assert.match(page, /if \(!local \|\| asked\) return then\(\);/);
  assert.match(page, /Number\(data\.chat\.message_count\) > 0\) return then\(\);/, "only while the conversation is empty");
  assert.match(page, /localStorage\.setItem\('ch-carry', 'asked'\);/, "never twice in this browser");
  assert.match(page, /fetch\('https:\/\/closedhand\.com\/carry', \{ mode: 'no-cors', cache: 'no-store', signal: away\.signal \}\)/, "only when closedhand.com answers");
  assert.deepEqual([...new Set(page.match(/location\.replace\('https?:\/\/[^']+'/g))], ["location.replace('https://closedhand.com/carry#'"]);
  assert.match(page, /if \(carryBack\.get\('state'\) === carryState\) \{/, "only what comes back for this tab's own one-time value");
  assert.match(page, /if \(msg\.type === 'carried'\) \{ if \(window\._onCarried\) window\._onCarried\(msg\.count\); return; \}/);
  assert.match(page, /carryFirst\(function\(\) \{\n\s*var firstWords = null;/, "setup's first words go after it");
  assert.match(page, /site: 'closedhand\.com'/);
  assert.match(read("lib/one-chat.js"), /site: "closedhand\.com"/);
});
