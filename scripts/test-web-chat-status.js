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

// Only what is under the cursor scrolls: the empty page beside the conversation
// scrolls the conversation, while the chat box, the conversation and any other
// scroll area scroll alone (forwarding from them moved two things at once).
test("only what is under the cursor scrolls", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const start = page.indexOf("function scrollsByItself(el)");
  assert.ok(start > 0);
  const end = page.indexOf("}, { passive: true });", start);
  const code = page.slice(start, end);
  assert.match(code, /if \(scrollsByItself\(e\.target\)\) return;\n\s*\/\/[^\n]*\n\s*messagesEl\.scrollTop \+=/);
  // Run the check on stand-ins for the page's pieces.
  const body = { tagName: "BODY" };
  const messagesEl = { tagName: "DIV", parentElement: body, oy: "auto" };
  const dockedInput = { tagName: "DIV", parentElement: body, oy: "visible" };
  const textarea = { tagName: "TEXTAREA", parentElement: { tagName: "DIV", parentElement: dockedInput, oy: "visible" }, oy: "auto" };
  const sendButton = { tagName: "BUTTON", parentElement: dockedInput, oy: "visible" };
  const bubble = { tagName: "DIV", parentElement: messagesEl, oy: "visible" };
  const sidebarRow = { tagName: "A", parentElement: { tagName: "NAV", parentElement: body, oy: "auto" }, oy: "visible" };
  const margin = { tagName: "MAIN", parentElement: body, oy: "visible" };
  const document = { body };
  const getComputedStyle = (el) => ({ overflowY: el.oy });
  const scrollsByItself = new Function("messagesEl", "dockedInput", "document", "getComputedStyle", code.slice(0, code.indexOf("\n  document.addEventListener")) + "\nreturn scrollsByItself;")(messagesEl, dockedInput, document, getComputedStyle);
  for (const [name, el] of Object.entries({ textarea, sendButton, bubble, sidebarRow })) assert.equal(scrollsByItself(el), true, name + " scrolls alone");
  assert.equal(scrollsByItself(margin), false, "the empty page scrolls the conversation");
});

// Something long, like a pasted page, opens the chat box further; its grip
// sizes it by hand; sending gives it back its own size.
test("the chat box opens for something long and sizes by hand", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /<button class="input-grip" id="inputGrip" type="button" aria-label="Resize the message box"/);
  assert.match(page, /\.docked-input textarea\.roomy \{ max-height: 45vh !important; \}/);
  assert.match(page, /@media \(max-width: 899px\) \{ \.docked-input textarea\.roomy \{ max-height: 30vh !important; \} \}/);
  assert.match(page, /\.docked-input textarea\.sized \{ max-height: none !important; \}/);
  assert.match(page, /input\.classList\.toggle\('roomy', docked && full > cap \+ 1\);/, "opens further only past its usual height");
  assert.match(page, /function fitInput\(\) \{\n\s*if \(userHeight\) return;/, "a size set by hand stays while typing");
  assert.match(page, /return \{ min: parseFloat\(getComputedStyle\(input\)\.minHeight\) \|\| 40, max: Math\.round\(vh \* 0\.75\) \};/);
  assert.match(page, /input\.value = '';\n\s*resetInputSize\(\);/, "sending resets it");
  assert.match(page, /grip\.addEventListener\('dblclick'/);
  assert.match(page, /new ResizeObserver\(function \(\) \{ if \(_atEnd\) messagesEl\.scrollTop = messagesEl\.scrollHeight; update\(\); \}\)\.observe\(messagesEl\);/);
});

// A refresh comes back to where you were: the address keeps Chat, a project's
// conversation, Computers or File Search, and the dashboard at its tab, and
// the page opens it again on load before it starts writing the address.
test("a refresh comes back to the same conversation, tab and dashboard", () => {
  const fs = require("node:fs"), path = require("node:path");
  const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const dash = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  assert.match(page, /: b\.contains\('chat-active'\) \? \(_placeProject \? '#project\/' \+ _placeProject : '#chat'\) : '';/);
  assert.match(page, /_placeProject = projectId \|\| null;\n\s*rememberPlace\(\);/, "opening a conversation keeps it");
  assert.match(page, /function rememberPlace\(\) \{\n\s*if \(!_placeReady\) return;/, "nothing is written before the page has come back");
  assert.match(page, /return hash === '#chat' \? function \(\) \{ window\.openConversation\(null\); \} : m \? function \(\) \{ window\.openConversation\(m\[1\]\); \} : null;/);
  assert.match(page, /window\.addEventListener\('hashchange', function \(\) \{\n\s*if \(!_placeReady \|\| !isAuthenticated\) return;/, "the address changed by hand opens that place");
  assert.match(page, /\.then\(function\(conv\) \{\n\s*if \(mine !== _opening\) return;/, "only the latest conversation opened shows");
  assert.match(page, /dash = '\?dash=' \+ encodeURIComponent\(overlay\.classList\.contains\('account'\) \? '#account' : _dashTab \? '#' \+ _dashTab : '1'\);/);
  assert.match(dash, /window\.parent\.postMessage\(\{ type: 'dash-place', tab: tabName \}, location\.origin\)/, "the dashboard tells its tab");
  // The dashboard reopens from ?dash= as it does after a redirect, keeping the conversation after "#".
  assert.match(page, /\.replace\(\/\[\?&\]\$\/, ""\) \+ window\.location\.hash;/);
  assert.match(page, /var m = window\.location\.search\.match\(\/\[\?&\]dash=\(\[\^&\]\*\)\/\);/);
});

// One connection at a time: two calls close together each made one, both
// stayed open, and every reply showed twice.
test("the web chat keeps one connection, so nothing shows twice", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /if \(_connectingSince && Date\.now\(\) - _connectingSince < 10000\) return;\n\s*_connectingSince = Date\.now\(\);/);
  assert.match(page, /var ws = chatWs = new WebSocket\(chatUrl\.href\);/);
  assert.match(page, /ws\.onmessage = function\(event\) \{\n\s*if \(ws !== chatWs\) \{ try \{ ws\.close\(\); \} catch \(e\) \{\} return; \}/);
  assert.match(page, /ws\.onclose = function\(\) \{\n\s*if \(ws !== chatWs\) return;/);
  assert.doesNotMatch(page, /chatWs\.on(message|open|close) = function/);
});

// A turn's messages carry the conversation they belong to; a tab showing
// another conversation leaves them be (they showed in the open conversation,
// whichever it was).
test("a turn shows only in the conversation it belongs to", () => {
  const fs = require("node:fs"), path = require("node:path");
  const ws = fs.readFileSync(path.join(__dirname, "..", "lib", "web-chat-ws.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const turn = ws.slice(ws.indexOf("async function handleChatMessage("), ws.indexOf("// Send a message to all connected tabs"));
  assert.match(turn, /const toTurn = \(uid, data\) => sendToUser\(uid, \{ \.\.\.data, project: where \}\);/);
  assert.match(turn, /where = p\.id \|\| where;\n\s*sendToUser\(userId, \{ type: "in_project"/, "moving into a project moves the turn");
  assert.doesNotMatch(turn, /sendToUser\(userId, \{ type: "(typing|status|stream_start|stream_token|stream_reset|stream_end|message)"/, "every part of the turn is tagged");
  assert.match(page, /if \('project' in msg && \/\^\(typing\|status\|activity\|stream_start\|stream_token\|stream_reset\|stream_end\|message\)\$\/\.test\(msg\.type\) && \(msg\.project \|\| null\) !== \(_placeProject \|\| null\)\) \{/);
});

// The line saying the newer message comes first is saved before that message
// is, and after a reload it stood above it: it shows after the message.
test("'I'll answer your latest message first' shows after the message it answers", () => {
  const fs = require("node:fs"), path = require("node:path");
  const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.match(engine, /conversation\.push\(\{ role: "assistant", content: busyLine, busy: true \}\);/);
  const start = page.indexOf("function shownInThread(messages)");
  const end = page.indexOf("\n  }\n", start) + 4;
  const shownInThread = new Function(page.slice(start, end) + "\nreturn shownInThread;")();
  const line = "I'll answer your latest message first, then come back to the one before it.";
  const got = shownInThread([
    { role: "user", content: "first" },
    { role: "assistant", content: line, busy: true },
    { role: "user", content: "second" },
    { role: "assistant", content: "answer to second" },
    { role: "user", content: "third" },
    { role: "assistant", content: line },
    { role: "user", content: "fourth" },
  ]).map((m) => m.content);
  assert.deepEqual(got, ["first", "second", line, "answer to second", "third", "fourth", line]);
});

// The live line of work still running stays last: what arrives meanwhile
// goes above it, so it never reads as the finished result.
test("a running live line stays at the bottom of the conversation", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /function endOfThread\(\) \{ return messagesEl\.querySelector\('\.agent-live:not\(\.done\)'\) \|\| typingEl; \}/);
  const before = [...page.matchAll(/messagesEl\.insertBefore\((\w+), (\w+)(?:\(\))?\)/g)].map((m) => m[1] + "->" + m[2]);
  assert.deepEqual(before.filter((x) => x.endsWith("->typingEl")), ["line->typingEl"], "only the live line itself goes at the very end");
  assert.ok(before.filter((x) => x.endsWith("->endOfThread")).length >= 3, "messages, files and words being written go above it");
  assert.match(page, /var wasWriting = dropWriting\(\), lastBefore = endOfThread\(\)\.previousElementSibling;/);
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
