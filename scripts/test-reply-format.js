// Replies in the web chat show their formatting (bold, lists, headings, code)
// rather than raw asterisks and dashes, and nothing in a reply becomes markup.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
const start = page.indexOf("  function formatReply(text) {");
const end = page.indexOf("\n  }\n", start) + 4;
const box = {};
vm.runInNewContext(page.slice(start, end) + "\nthis.formatReply = formatReply;", box);
const { formatReply } = box;

test("bold, lists and line breaks render", () => {
  const reply = "**Friday 9 October, 14:20** Lisbon time.\n\n- QZ417, LIS → OPO\n- Ref KQ7P2X, seat 12A\n\nThree days from now.";
  assert.equal(formatReply(reply),
    "<strong>Friday 9 October, 14:20</strong> Lisbon time.<br><ul class=\"reply-list\"><li>QZ417, LIS → OPO</li><li>Ref KQ7P2X, seat 12A</li></ul>Three days from now.",
    "a list's own margins space it, so the blank lines around it go");
  assert.equal(formatReply("1. First\n2. Second"), "<ol class=\"reply-list\"><li>First</li><li>Second</li></ol>");
  assert.equal(formatReply("### Today\nNothing urgent"), "<strong class=\"reply-head\">Today</strong><br>Nothing urgent");
  assert.equal(formatReply("Run `docker compose up`"), "Run <code>docker compose up</code>");
  assert.equal(formatReply("It's *probably* fine (*not* certain)."), "It's <em>probably</em> fine (<em>not</em> certain).");
  assert.equal(formatReply("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24", "a lone asterisk is left alone");
});

test("a table shows as a table, not pipes", () => {
  const reply = "**Private rooms**\n\n| Hotel | Per night |\n|---|---:|\n| Random Alley | £9.14 |\n| **Bohemia** | £17.43 |\n\nMy pick: Bohemia.";
  assert.equal(formatReply(reply),
    "<strong>Private rooms</strong><br><div class=\"reply-table\"><table><thead><tr><th>Hotel</th><th>Per night</th></tr></thead>"
    + "<tbody><tr><td>Random Alley</td><td>£9.14</td></tr><tr><td><strong>Bohemia</strong></td><td>£17.43</td></tr></tbody></table></div>My pick: Bohemia.");
  assert.equal(formatReply("a | b | c"), "a | b | c", "pipes in a sentence are left alone");
  assert.equal(formatReply("| just one row |"), "| just one row |", "no rule line, no table");
  assert.doesNotMatch(formatReply("| <b>x</b> |\n|---|\n| y |"), /<b>/, "cells are escaped too");
});

test("nothing in a reply becomes markup of its own", () => {
  const out = formatReply("<img src=x onerror=alert(1)> **<b>hi</b>**\n- <script>x</script>");
  assert.doesNotMatch(out, /<img|<b>|<script/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<strong>&lt;b&gt;hi&lt;\/b&gt;<\/strong>/);
});

test("links go on their words; dashboard links open the dashboard panel", () => {
  const style = 'style="color:var(--accent);text-decoration:underline;text-underline-offset:0.1875rem"';
  assert.equal(formatReply("It's under [Agents](/dashboard#agents)."),
    `It's under <a href="#" onclick="event.preventDefault();openDashSlide('#agents')" ${style}>Agents</a>.`);
  assert.equal(formatReply("See [the **listing**](https://example.com/a?b=1&c=2)"),
    `See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener" ${style}>the <strong>listing</strong></a>`);
  assert.equal(formatReply("Open https://example.com/x or /dashboard#agents"),
    `Open <a href="https://example.com/x" target="_blank" rel="noopener" ${style}>https://example.com/x</a> or <a href="#" onclick="event.preventDefault();openDashSlide('#agents')" ${style}>Agents</a>`);
  assert.match(formatReply("[the plan](/page/4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07)"), /<a href="\/page\/4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07" data-page onclick="event\.preventDefault\(\);openPage\('\/page\/4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07'\)"/, "a page opens beside the chat");
  assert.match(formatReply("[the plan](https://amber-fox-42.closedhand.com/page/4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07)"), /data-page onclick="event\.preventDefault\(\);openPage\('\/page\/4f0c9a2e/, "from its full address too");
  assert.equal(formatReply("[chart](/canvas/abc)"), "[chart](/canvas/abc)", "there is no canvas");
  assert.equal(formatReply("[x](javascript:alert(1))"), "[x](javascript:alert(1))", "only web and ClosedHand addresses become links");
});

test("an address cannot break out of its link", () => {
  for (const reply of ['https://a.example/"onmouseover="alert(1)', '[x](https://a.example/"onmouseover="alert(1))']) {
    const out = formatReply(reply);
    assert.doesNotMatch(out, /"onmouseover/, reply);
    assert.match(out, /&quot;onmouseover=&quot;/);
  }
});

test("the chat page formats bot replies through it", () => {
  assert.match(page, /div\.innerHTML = formatReply\(text\);/);
});

test("message times stay current instead of saying just now for ever", () => {
  assert.match(page, /when\.setAttribute\('data-ts', ts\)/);
  assert.match(page, /querySelectorAll\('\.msg-time\[data-ts\]'\)[\s\S]{0,200}msgTime\(el\.getAttribute\('data-ts'\)\)/);
});

test("the web chat prompt puts dashboard links on words and names memory as the dashboard does", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.match(engine, /A link goes on its words, written \[words\]\(\/dashboard#section\)/);
  assert.doesNotMatch(engine, /Check it out here: \/dashboard|make them curious|want to explore it/, "no bare path, no pitch");
  assert.match(engine, /"Pinned Facts" and "Context Notes" \(past conversations, condensed\) in Context Brain, "projects" and their goals on the Projects tab, and "preferences" \(what save_rule stores\) in Settings\./);
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  for (const name of ["Pinned Facts", "Context Notes", "<h2>Preferences</h2>", ">Projects</button>"]) assert.ok(dashboard.includes(name), `the dashboard still says ${name}`);
});

test("a reopened conversation shows what was said, not Closedhand's bookkeeping", () => {
  const start = page.indexOf("  function shownInThread(messages) {");
  const box = {};
  vm.runInNewContext(page.slice(start, page.indexOf("\n  }\n", start) + 4) + "\nthis.f = shownInThread;", box);
  const shown = box.f([
    { role: "assistant", content: "Just to confirm: send email?" },
    { role: "user", content: "[User moved on, action cancelled]" },
    { role: "assistant", content: "OK, cancelled." },
    { role: "user", content: "no, just pin the address here" },
    { role: "assistant", content: [{ type: "tool_use" }] },
    { role: "assistant", content: "Harbour House, 14 Quay Street" },
    { role: "user", content: "[The question lapsed unanswered, action cancelled]" },
    { role: "assistant", content: "OK, cancelled." },
  ]);
  assert.deepEqual([...shown].map((m) => m.content), ["Just to confirm: send email?", "no, just pin the address here", "Harbour House, 14 Quay Street"]);
  assert.equal((page.match(/shownInThread\(conv\.messages\)\.forEach/g) || []).length, 1, "one way of opening a conversation, Chat or a project's");
  assert.doesNotMatch(page, /thread\.messages\.forEach/, "nothing draws a thread unfiltered");
});

test("coming back to the tab, or a connection coming back, shows what arrived meanwhile, from every app", () => {
  const prefix = page.match(/  var REPLY_PREFIX = .*;\n/)[0] + page.match(/  var UPLOAD_LABEL = .*;\n  function theirOwn\(m\) \{[\s\S]*?\n  \}\n/)[0];
  const start = page.indexOf("  function sameWords(t) {");
  const box = {};
  vm.runInNewContext(prefix + page.slice(start, page.indexOf("\n  }\n", page.indexOf("  function missedSince(stored, shown) {", start)) + 4) + "\nthis.f = missedSince;", box);
  const stored = [
    { role: "user", content: "find me a hotel" },
    { role: "assistant", content: "On it, back in about ten minutes." },
    { role: "user", content: "[replying to Closedhand's message: \"On it\"] make it near the station", via: "whatsapp_linked" },
    { role: "assistant", content: "Three good ones: …", via: "whatsapp_linked" },
    { role: "assistant", content: "Reminder: iCloud storage" },
  ];
  const f = (shown) => [...box.f(stored, shown)].map((m) => m.content);
  assert.deepEqual(f(["find me a hotel", "On it, back in about ten minutes."]), [stored[2].content, "Three good ones: …", "Reminder: iCloud storage"], "a WhatsApp turn comes in too, the person's words with it");
  assert.deepEqual(f(["On it, back in about ten minutes.", "make it near the station"]), ["Three good ones: …", "Reminder: iCloud storage"], "their words shown live without the quoted reply still count as shown");
  assert.deepEqual(f(["Three good ones: …", "Reminder: iCloud storage"]), [], "nothing new");
  assert.deepEqual(f([]), [], "an empty page has nothing to anchor on");
  // A picture sent to an LLM that cannot see is kept with what was read from
  // it, for the LLM; the person's own words beside it are what was shown. The
  // description once came back as a "missed" message of theirs.
  const picture = [
    { role: "user", content: "[User uploaded file: att_1. Based on the image provided, here is a detailed description: a blue notice box [i] reading £10,550.] does this look right?", said: "does this look right?", files: [{ id: "att_1", name: "shot.jpg", mime: "image/jpeg" }] },
    { role: "assistant", content: "No - it's about £4,040 too high." },
  ];
  assert.deepEqual([...box.f(picture, ["does this look right?"])].map((m) => m.content), ["No - it's about £4,040 too high."], "their message as typed counts as shown");
  const before = [{ role: "user", content: "[User uploaded file: att_2. A receipt for £12.] is this the right total?" }, { role: "assistant", content: "Yes." }];
  assert.deepEqual([...box.f(before, ["is this the right total?"])].map((m) => m.content), ["Yes."], "and an older one with only the label");
  assert.match(page, /addMessage\(theirOwn\(m\), 'user', files\.map\(function \(f\) \{ return \{ name: f\.name, type: f\.mime \|\| '', url: url\(f\) \}; \}\), m\.ts \|\| null, m\.via \|\| null\);/, "shown as their words with the picture, never the description");
  assert.match(page, /img\.src = f\.url \|\| 'data:' \+ f\.type \+ ';base64,' \+ f\.data;/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8"), /conversation\.push\(\{ role: "user", content: `\$\{uploadLabel\} \$\{caption\}`, said: caption, \.\.\.\(sent\.length \? \{ files: sent \} : \{\}\) \}\);/);
  assert.equal((page.match(/var REPLY_PREFIX = /g) || []).length, 1, "one reading of a quoted reply");
  assert.match(page, /div\._raw = raw;/, "each message keeps the text as sent");
  assert.match(page, /fetch\('\/api\/conversation' \+ \(projectId \? '\?project=' \+ encodeURIComponent\(projectId\) : ''\)\)[\s\S]{0,400}missedSince\(shownInThread\(conv\.messages\), shown\)/, "read from the conversation open here, Chat or a project's");
  assert.match(page, /if \(document\.visibilityState === 'visible' && isAuthenticated\) \{\n\s*connectChat\(\);\n\s*pollAgentStatus\(\);\n\s*catchUp\(\);/, "when the tab comes back");
  assert.match(page, /if \(_chatWasOpen\) catchUp\(\);\n\s*_chatWasOpen = true;/, "and when its connection comes back by itself");
});

test("the conversation uses the app's scale, set once, larger on touch screens", () => {
  const root = page.slice(page.indexOf("  :root {"), page.indexOf("  * { margin: 0; padding: 0; box-sizing: border-box; }"));
  for (const token of ["--chat-text: 1rem;", "--chat-input-min: 3rem;"]) assert.ok(root.includes(token), `touch default ${token}`);
  assert.match(root, /@media \(hover: hover\) and \(pointer: fine\) \{\n\s*:root \{\n\s*--chat-text: 0.9375rem;\n\s*--chat-text-sm: 0.8125rem;\n\s*--chat-meta: 0.6875rem;/, "computers get the dashboard's scale");
  assert.doesNotMatch(page, /font-size: 1.0625rem !important/, "no hero-sized messages");
  assert.doesNotMatch(page, /div\.style\.fontSize = '1rem'/, "no inline sizes overriding the scale");
  assert.match(page, /\.message \{\n\s*max-width: 85%;\n\s*padding: var\(--chat-pad\);\n\s*border-radius: 1.125rem;\n\s*font-size: var\(--chat-text\);/);
  assert.match(page, /\.docked-input \.input-textarea-wrap textarea \{\n\s*font-size: var\(--chat-text\);/);
  assert.match(page, /\.docked-input \.input-box-wrap:focus-within, \.docked-input \.input-box-wrap\.composing \{ transform: none; \}/, "the chat input does not zoom on focus");
  assert.match(page, /\.docked-input \.toolbar-btn \{ width: var\(--chat-control\); height: var\(--chat-control\);/);
  assert.match(page, /docked-input textarea \{[^}]*font-size: 1rem !important/, "phones keep 1rem in the input so the page does not zoom");
});

test("only a tab waiting for its own reply can call it stalled", () => {
  assert.match(page, /else if \(_awaitingReply\) armResponseWatchdog\(\);/);
  assert.match(page, /_awaitingReply = false; disarmResponseWatchdog\(\);/);
  assert.match(page, /_awaitingReply = true;\n\s*armResponseWatchdog\(\);/);
});

test("a line of dashes in a reply is a divider", () => {
  assert.equal(formatReply("Above\n---\nBelow"), 'Above<hr class="reply-rule">Below');
});
