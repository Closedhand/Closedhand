// A web chat message's record says what happened to it: complete once the
// turn answered it (or handed it to a background run), error only when the
// turn failed. It used to stay at processing, so the clean-up at every restart
// marked each answered message as an error.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ws = fs.readFileSync(path.join(__dirname, "../lib/web-chat-ws.js"), "utf8");

test("the message's status follows its turn", () => {
  assert.match(ws, /status: "processing",\n  \}\)\.select\("id"\)\.single\(\)/);
  assert.match(ws, /await userStore\.save\(\);\n\s*settle\("complete"\);/);
  assert.match(ws, /console\.error\("\[WebChat\] ask error:", err\.message\);\n\s*settle\("error"\);/);
});

test("the working star turns smoothly: no symbol a phone draws as an emoji, a calm pace, and a box that never moves the line", () => {
  const page = require("fs").readFileSync(require("path").join(__dirname, "../webapp/views/index.html"), "utf8");
  const chars = page.match(/var _spinnerChars = \[([^\]]+)\]/)[1].match(/\\u([0-9A-F]{4})/gi).map((u) => parseInt(u.slice(2), 16));
  // Symbols with an emoji form on phones (Unicode's Emoji list): never in the cycle.
  const EMOJI = [0x2733, 0x2734, 0x2747, 0x2728, 0x2721, 0x2B50, 0x274C, 0x2705, 0x2714, 0x2716];
  for (const c of chars) assert.ok(!EMOJI.includes(c), "U+" + c.toString(16).toUpperCase());
  assert.ok(Number(page.match(/var SPINNER_MS = (\d+);/)[1]) >= 100, "slow enough to read as turning");
  assert.doesNotMatch(page, /_spinnerChars\.length;[\s\S]{0,200}\}, 50\);/, "no 50 ms flicker left");
  assert.match(page, /\.tl-spinner \{\n    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;\n    width: 1rem; height: 1.125rem; overflow: hidden;/);
  assert.match(page, /prefers-reduced-motion: reduce\)'\)\.matches\) return;/, "still for anyone who asks for less motion");
});

// The steps' timeline: one thread through the middle of every dot and of the
// spinner (it sat a few pixels right of them), the same step done again as
// one line with how many, no small-capital DONE, a step gone wrong in red.
test("the timeline's line runs through every dot and the spinner, and repeated steps are one line", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const rem = (re) => Number(page.match(re)[1]);
  const pad = rem(/\.timeline \{\n\s*position: relative;\n\s*padding-left: ([\d.]+)rem;/);
  const line = rem(/\.timeline::before \{[^}]*left: calc\(([\d.]+)rem - 0\.5px\);/);
  const dot = page.match(/\.tl-dot \{\n\s*width: ([\d.]+)rem;[\s\S]*?margin-left: (-[\d.]+)rem;/);
  const spin = page.match(/\.tl-spinner \{[^}]*width: ([\d.]+)rem;[^}]*margin-left: (-[\d.]+)rem;/);
  assert.equal(pad + Number(dot[2]) + Number(dot[1]) / 2, line, "each dot's middle is on the line");
  assert.equal(pad + Number(spin[2]) + Number(spin[1]) / 2, line, "and the spinner's");
  assert.doesNotMatch(page, /tl-badge|'Done'<\/span>/, "no DONE badge");
  const start = page.indexOf("  function renderActivityFeed(events) {");
  const area = { innerHTML: "" };
  const box = { document: { getElementById: () => area }, window: { innerWidth: 1200 }, Date, Object, startSpinner() {}, _spinnerChars: ["*"], _spinnerIdx: 0, _spinnerInterval: null, clearInterval() {} };
  require("node:vm").runInNewContext(page.slice(start, page.indexOf("\n  }\n", page.indexOf("    area.innerHTML = html;", start)) + 4)
    + page.slice(page.indexOf("  function formatElapsed(ms) {"), page.indexOf("  function escapeHtml(str) {"))
    + page.slice(page.indexOf("  function escapeHtml(str) {"), page.indexOf("\n  }\n", page.indexOf("  function escapeHtml(str) {")) + 4) + "\nthis.render = renderActivityFeed;", box);
  const step = (n, description, success = true) => [{ type: "tool_start", toolName: "t" + n, timestamp: n, description }, { type: "tool_end", toolName: "t" + n, timestamp: n + 1, description, success, elapsed: 1000 }];
  box.render([...step(1, "Searching data"), ...step(2, "Searching data"), ...step(3, "Searching data"), ...step(4, "Reading web pages", false), { type: "thinking", timestamp: 9 }]);
  assert.equal((area.innerHTML.match(/class="tl-row"/g) || []).length, 2, "three of the same step are one line");
  assert.match(area.innerHTML, /Searching data <span class="tl-count">×3<\/span>/);
  assert.match(area.innerHTML, /<span class="tl-fail">Didn’t work<\/span>/);
});

// Scrolled up to read, the conversation stays put; what arrives shows on the
// arrow: a turning ring while Closedhand works, New message when a reply
// lands. Their own message, opening a conversation and the arrow go to the end.
test("reading above the end is never jolted down; the arrow says what is new below", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /function scrollToBottom\(force, smooth\) \{\n\s*if \(force !== true && !_atEnd\) return;/);
  assert.match(page, /_atEnd = messagesEl\.scrollHeight - messagesEl\.scrollTop - messagesEl\.clientHeight < 64;/);
  assert.match(page, /scrollToBottom\(role === 'user' && ts === undefined\);/, "their own message, just sent");
  assert.match(page, /setTimeout\(function \(\) \{ scrollToBottom\(true\); \}, ms\);/, "opening a conversation");
  assert.match(page, /id="scrollLatest" type="button" aria-label="Go to the latest message"><span class="scroll-latest-text">New message<\/span>/);
  assert.match(page, /btn\.addEventListener\('click', function \(\) \{ scrollToBottom\(true, true\); \}\);/, "the arrow goes to the end");
  assert.match(page, /n\.classList\.contains\('message'\) && n\.classList\.contains\('bot'\) && !n\.classList\.contains\('writing'\)[^\n]*btn\.classList\.add\('fresh'\)/, "a reply landing while away");
  assert.match(page, /btn\.classList\.toggle\('working', away && !!messagesEl\.querySelector\('#typingIndicator\.visible, \.message\.bot\.writing, \.agent-live:not\(\.done\), #statusArea \.timeline'\)\);/);
  assert.match(page, /\.scroll-latest\.working:not\(\.fresh\)::before \{[^}]*animation: latestTurn/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{ \.scroll-latest, \.scroll-latest-text \{ transition: none; \}/);
});

// An inline handler runs in the page's global scope, so a function kept inside
// one of the page's closures is out of its reach: the arrow's click called one
// and did nothing. Every inline handler calls a function the page can reach.
test("every inline handler calls a function the page can reach", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const called = new Set([...page.matchAll(/\son[a-z]+="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));
  for (const name of called) {
    if (name === "if" || name === "open" || name === "event") continue;
    const reachable = new RegExp(`window\\.${name}\\s*=|^(async )?function ${name}\\b|^(var|let|const) ${name}\\b`, "m");
    assert.ok(scripts.some((s) => reachable.test(s)), `${name} is called from an inline handler but only defined inside a closure`);
  }
});

// A connection that looked open but had quietly died took the message and
// delivered nothing, and six minutes on the page said the request stalled.
// Each message now waits for the server's receipt and is sent again on a new
// connection without one; the server takes each one once.
test("a message is sent until the server has it, and taken once", () => {
  const ws = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "web-chat-ws.js"), "utf8");
  const box = { Map, Date };
  require("node:vm").runInNewContext(ws.slice(ws.indexOf("const recentlySent = new Map();"), ws.indexOf("\n}\n", ws.indexOf("function seenBefore(")) + 3) + "\nthis.seen = seenBefore;", box);
  assert.equal(box.seen("u1", "abc123def", 1000), false, "the first time it is taken");
  assert.equal(box.seen("u1", "abc123def", 2000), true, "sent again after a lost receipt: not answered twice");
  assert.equal(box.seen("u2", "abc123def", 2000), false, "per person");
  assert.equal(box.seen("u1", "abc123def", 1000 + 31 * 60 * 1000), false, "forgotten after half an hour");
  assert.match(ws, /ws\.send\(JSON\.stringify\(\{ type: "received", cid: msg\.cid \}\)\);\n\s*if \(seenBefore\(userId, msg\.cid\)\) return;/, "the receipt goes at once");
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /if \(msg\.type === 'received'\) \{ var got = _unreceived\[msg\.cid\]; if \(got\) \{ clearTimeout\(got\.timer\); delete _unreceived\[msg\.cid\]; \} return; \}/);
  assert.match(page, /if \(chatWs && chatWs\.readyState === 1 && chatWs\.bufferedAmount > 0\) \{ wait\(\); return; \}/, "a big file still going out is not a dead connection");
  assert.match(page, /var dead = chatWs;\n\s*chatWs = null;\n\s*if \(dead\) \{ dead\.onclose = null; dead\.onmessage = null; try \{ dead\.close\(\); \} catch \(e\) \{\} \}\n\s*connectChat\(\);/);
  assert.match(page, /if \(pm && pm\.type === 'chat' && pm\.cid\) sendChat\(pm\);/, "sent again on the new connection, still waiting for its receipt");
  assert.match(page, /\n\s*sendChat\(payload\);\n\s*_awaitingReply = true;/);
});
