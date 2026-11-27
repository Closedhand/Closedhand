// The one message that follows a turn in a chat app (lib/live-message.js), and
// what is shown of a reply still being written (lib/reply-as-written.js).
// Run: node --test scripts/test-live-message.js
const test = require("node:test");
const assert = require("node:assert/strict");
const live = require("../lib/live-message");
const written = require("../lib/reply-as-written");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A chat app: what it was sent and each change made to it.
function app({ slow = 0, refuseEdit = false } = {}) {
  const a = { sends: [], edits: [], removed: [], message: null };
  a.deps = {
    send: async (text) => { if (slow) await sleep(slow); a.sends.push(text); a.message = text; return { id: a.sends.length }; },
    edit: async (sent, text) => { if (refuseEdit) throw new Error("too late to edit"); if (slow) await sleep(slow); a.edits.push(text); a.message = text; },
    remove: async (sent) => { a.removed.push(sent.id); a.message = null; },
  };
  return a;
}

test("a quick reply gets no message of its own", async () => {
  const a = app(), m = live.create({ ...a.deps, thinkAfter: 60, gap: 10 });
  await sleep(20);
  assert.equal(await m.finish("Done: it is booked."), false, "the caller sends the reply");
  await sleep(80);
  assert.deepEqual([a.sends, a.edits], [[], []], "and nothing follows it");
});

test("a slow turn shows it is being thought about, then each thing Closedhand does, then the reply's words, and becomes the reply", async () => {
  const a = app(), m = live.create({ ...a.deps, thinkAfter: 30, gap: 15, wordsFrom: 12 });
  await sleep(50);
  assert.deepEqual(a.sends, ["_Thinking…_"]);
  m.step("Searching your email...");
  await sleep(40);
  assert.equal(a.message, "_Searching your email…_", "in the same message, changed");
  m.step("Reading a webpage");
  await sleep(40);
  assert.equal(a.message, "_Reading a webpage…_");
  m.words("The 14:05 ");
  await sleep(40);
  assert.equal(a.message, "_Reading a webpage…_", "a few words are not yet worth showing");
  m.words("from Fixture Halt — it gets in ");
  await sleep(40);
  assert.equal(a.message, "The 14:05 from Fixture Halt - it gets in …", "the reply so far, marked as unfinished, its dashes as the reply's will be");
  assert.equal(a.sends.length, 1, "one message throughout");
  assert.equal(await m.finish("The 14:05 from Fixture Halt gets in at 15:40."), true);
  assert.equal(a.message, "The 14:05 from Fixture Halt gets in at 15:40.");
  m.words(" and more"); m.step("Later");
  await sleep(40);
  assert.equal(a.message, "The 14:05 from Fixture Halt gets in at 15:40.", "nothing changes the reply once it is there");
});

test("words written on the way to doing something are taken back, and changes never come faster than the app takes kindly", async () => {
  const a = app(), m = live.create({ ...a.deps, thinkAfter: 1000, gap: 60, wordsFrom: 5 });
  m.step("Checking your calendar");
  await sleep(15);
  for (const part of ["Let me ", "look at ", "that ", "for you."]) { m.words(part); await sleep(8); }
  await sleep(90);
  assert.deepEqual(a.edits, ["Let me look at that for you. …"], "four pieces, one change");
  m.reset();
  await sleep(90);
  assert.equal(a.message, "_Checking your calendar…_");
  // A send still on its way is waited for, so the reply never lands under a late progress line.
  const slow = app({ slow: 50 }), s = live.create({ ...slow.deps, thinkAfter: 1000, gap: 5 });
  s.step("Searching your email");
  await sleep(10);
  assert.equal(await s.finish("Here it is."), true);
  assert.deepEqual([slow.sends, slow.edits], [["_Searching your email…_"], ["Here it is."]]);
});

test("a turn that ends with nothing to say, or a message that cannot be changed, leaves no progress line behind", async () => {
  const a = app(), m = live.create({ ...a.deps, thinkAfter: 10, gap: 5 });
  await sleep(40);
  assert.equal(await m.finish(null), false);
  assert.deepEqual([a.removed, a.message], [[1], null]);
  const b = app({ refuseEdit: true }), n = live.create({ ...b.deps, thinkAfter: 10, gap: 5 });
  await sleep(40);
  assert.equal(await n.finish("The reply."), false, "the caller sends the reply itself");
  assert.deepEqual(b.removed, [1]);
});

test("what the LLM writes reaches the chat as written; what an earlier request wrote is taken back when tool use starts or another request goes", () => {
  const got = [];
  const w = written.create({ onStreamToken: (t) => got.push(t), onStreamReset: () => got.push("<taken back>") });
  const first = w.options();
  first.onText("\n\n"); first.onText("  I'll check "); first.onText("both cities.");
  w.reset(); w.reset();
  const second = w.options();
  second.onText("Lisbon is 21°C.");
  w.options();
  assert.deepEqual(got, ["I'll check ", "both cities.", "<taken back>", "Lisbon is 21°C.", "<taken back>"], "no leading space, each taking back said once");
  // A chat that shows nothing as it is written asks for nothing as it is written.
  assert.deepEqual(written.create({}).options(), {});
  // A listener that throws stops nothing.
  written.create({ onStreamToken: () => { throw new Error("tripped"); } }).options().onText("words");
  assert.equal(written.shownSoFar("First part.\n\n[[next]]\n\nSecond — part [[ne"), "First part.\n\nSecond - part");
});

test("every chat that shows a reply as it is written marks it as unfinished and can take it back", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  // The engine hands the words on for every request of a turn, and takes them back when tool use starts.
  const engine = read("lib/engine.js");
  assert.equal((engine.match(/llmClient\.messages\.create\((apiParams|roomier), written\.options\(\)\)/g) || []).length, 4);
  assert.match(engine, /if \(response\.stop_reason === "tool_use"\) \{\n\s+\/\/[^\n]+\n\s+written\.reset\(\);/);
  // The web chat: muted words with the brush mark breathing after them, still for those who ask for less motion.
  const page = read("webapp/views/index.html");
  assert.match(page, /\.message\.bot\.writing \.writing-words \{ opacity: 0\.68; \}/);
  assert.match(page, /\.writing-mark \{[^}]*mask: url\(\/brush-underline\.svg\)[^}]*animation: writingBreathe/);
  assert.match(page, /prefers-reduced-motion: reduce\) \{ \.writing-mark \{ animation: none;/);
  assert.match(page, /msg\.type === 'stream_reset'\) \{ if \(dropWriting\(\) && _awaitingReply\) showTyping\(\); \}/);
  assert.match(read("lib/web-chat-ws.js"), /onStreamReset\(\) \{\n\s+if \(streamStarted\) \{ streamStarted = false; toTurn\(userId, \{ type: "stream_reset" \}\); \}/);
  // Telegram and linked WhatsApp: one message that changes, ending in an ellipsis until it is the reply.
  assert.match(read("lib/platforms/telegram.js"), /shownSoFar\(streamBuffer\)\.slice\(0, 4000\) \+ " …"/);
  assert.match(read("lib/platforms/telegram.js"), /onStreamReset\(\) \{/);
  const linked = read("lib/platforms/whatsapp-linked.js");
  assert.match(linked, /onStreamToken\(text\) \{ live\.words\(text\); \},\n\s+onStreamReset\(\) \{ live\.reset\(\); \},/);
  assert.equal((linked.match(/atWork\(/g) || []).length, 5, "text, voice notes, documents and pictures all show the turn the same way");
  // A change to one of Closedhand's own messages is never read as the person's message.
  assert.match(linked, /if \(_sentIds\.has\(changedId\(msg\.message\)\)\) continue;/);
  assert.match(linked, /_sentIds\.add\(id\);\n  return remember\(await _sock\.sendMessage\(jid, \{ text, edit: ownKey\(jid, sentId\)/);
  // What a send gives back (the message's id) is what a change and a taking away take.
  assert.match(linked, /async function sendLinkedMessage\(chatId, message, messageId\) \{[\s\S]*?last = remember\(await _sock\.sendMessage/);
  assert.match(linked, /function remember\(out\) \{[\s\S]*?return out\?\.key\?\.id \|\| null;\n\}/);
  assert.match(linked, /send: \(text\) => sendLinkedMessage\(_selfJid, text\),\n    edit: \(sentId, text\) => editLinkedMessage\(sentId, text\),\n    remove: \(sentId\) => removeLinkedMessage\(sentId\),/);
});
