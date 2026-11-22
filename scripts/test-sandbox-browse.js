// Closedhand browses the sandbox computer's Chrome through one lasting
// connection (sandbox-image/agent: POST /browse, browser_helper.py serve)
// instead of a new Python process and a fresh connection for every step, and
// reads a page as a numbered outline it acts on by number instead of guessing
// CSS selectors. Measured on the sandbox image: a step went from 0.85 to 2
// seconds to tens of milliseconds. Running code there has no daily cap.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("sandbox-image/agent/server.js");
const helper = read("sandbox-image/agent/browser_helper.py");

// The agent's queue, run against a stand-in Python process.
function agentQueue(answer) {
  const start = server.indexOf("let browseChild = null");
  const end = server.indexOf("// Started when a step first wants it", start);
  const spawned = [];
  const box = {
    console: { error() {} }, setTimeout, clearTimeout, JSON, Map, Promise, Error, Math, Date,
    PYTHON: "python3", SANDBOX_PROFILE: "", WORKSPACE: "/workspace", execEnv: () => ({}), truncate: (s) => s,
    spawn: (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.exitCode = null; child.killed = false;
      child.kill = () => { child.killed = true; child.emit("exit"); };
      child.stdin = { write: (line) => { const req = JSON.parse(line); answer(req, (result) => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: req.id, result }) + "\n"))); } };
      spawned.push({ cmd, args, child });
      return child;
    },
  };
  vm.runInNewContext(server.slice(start, end) + "\nthis.browseRequest = browseRequest;", box);
  return { browseRequest: box.browseRequest, spawned };
}

test("steps share one lasting process, run one at a time, and answers find their request", async () => {
  const order = [];
  const { browseRequest, spawned } = agentQueue((req, reply) => { order.push(req.step.action); setTimeout(() => reply({ did: req.step.action }), req.step.action === "outline" ? 30 : 1); });
  const [a, b] = await Promise.all([
    browseRequest({ op: "step", step: { action: "outline" } }, 1000),
    browseRequest({ op: "step", step: { action: "click", ref: 3 } }, 1000),
  ]);
  assert.deepEqual([a.did, b.did], ["outline", "click"]);
  assert.deepEqual(order, ["outline", "click"], "the second waits for the first");
  assert.equal(spawned.length, 1, "one process for both");
  assert.deepEqual([...spawned[0].args], ["-u", "-m", "browser_helper", "serve"]);
});

test("a step that hangs is stopped, and the next starts a fresh process", async () => {
  let hang = true;
  const { browseRequest, spawned } = agentQueue((req, reply) => { if (!hang) reply({ ok: true }); });
  await assert.rejects(browseRequest({ op: "step", step: { action: "click" } }, 50), /still running after 0 seconds and was stopped/);
  hang = false;
  assert.deepEqual(await browseRequest({ op: "step", step: { action: "outline" } }, 500), { ok: true });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].child.killed, true);
});

test("the agent guards the endpoint and knows when Closedhand is browsing", () => {
  assert.match(server, /app\.use\("\/browse", auth\);/);
  assert.match(server, /function botBrowsing\(\) \{\n\s*return browseBusy > 0 \|\| Date\.now\(\) - lastBrowseAt < 20000;/);
  assert.match(server, /try \{ browseChild && browseChild\.kill\(\); \} catch \{\}/, "the helper goes when the agent goes");
});

test("the helper keeps its connection while serving and reads pages as a numbered outline", () => {
  assert.match(helper, /def _release\(pw, browser\):\n    """A one-off call disconnects; the serving process keeps the connection\."""\n    if _PERSIST:\n        return/);
  assert.equal((helper.match(/finally:\n        _release\(pw, browser\)/g) || []).length, 6, "every call keeps or drops the connection the same way");
  assert.match(helper, /el\.setAttribute\('data-ch-ref', String\(n\)\);/);
  assert.match(helper, /if \(k === 'password'\) \{ if \(el\.value\) line \+= ' \(filled\)'; \}/, "a password is never read back");
  assert.match(helper, /selector = '\[data-ch-ref="%d"\]' % int\(step\["ref"\]\)/, "a number names its element, and only a number");
  assert.match(helper, /page\.fill\(selector, ""\)\n[\s\S]{0,200}page\.type\(selector/, "a box is cleared before typing");
  assert.match(helper, /"hint": "Do not guess again\. Act on a \[number\] from this outline with ref\.",\n\s*"outline": _outline\(page\)/);
  assert.match(helper, /if __name__ == "__main__":\n    import sys\n    if sys\.argv\[1:\] == \["serve"\]:\n        serve\(\)/);
});

test("the bot sends every step but a card fill through the lasting connection, and the LLM is told to use numbers", () => {
  const handlers = read("lib/tools/handlers.js");
  const browse = handlers.slice(handlers.indexOf('case "sandbox_browse": {'), handlers.indexOf("// --- Background Agents ---"));
  assert.match(browse, /let answer = await sandboxBrowse\(userId, \{ \.\.\.body, engine \}, 60000\);/);
  assert.equal((browse.match(/sandboxExec\(/g) || []).length, 1, "only the card and address fills run as a one-off script");
  assert.match(browse, /code = wallet\.fillScript\(secret, [^\n]+\);[\s\S]*?code = wallet\.addressScript\(address, [^\n]+\);[\s\S]*?await sandboxExec\(userId, "python", code, 60000\);/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /enum: \["outline", "read_pages", "batch", "screenshot", "scrape_text", "extract_data", "click", "fill", "press", "wait_for", "eval_js", "upload", "download", "fill_card", "fill_address"\]/);
  assert.match(defs, /ref: \{\n\s*type: "number",\n\s*description: "For click, fill, press, wait_for and upload: the \[number\] of the element in the latest outline\./);
  assert.match(read("lib/sandbox.js"), /async function sandboxBrowse\(userId, body, timeoutMs = 60000\) \{/);
});

test("running code on the sandbox computer has no daily cap: it is part of the person's own computer", () => {
  const sandbox = read("lib/sandbox.js");
  assert.doesNotMatch(sandbox, /Daily execution limit|daily_exec/);
  assert.match(sandbox, /total_exec_count: \(sandbox\?\.total_exec_count \|\| 0\) \+ 1,\n\s*last_used_at: new Date\(\)\.toISOString\(\),/);
});

// A page Playwright never finished attaching to is listed with no address,
// and asking it anything never returns: looking through the visible
// browser's pages for Closedhand's tab asked it, and every step there stopped
// at its 60 seconds, so a sign-in page could not even be opened for the
// person. Only web and blank pages are asked.
test("finding Closedhand's tab asks only web and blank pages", () => {
  const { spawnSync } = require("node:child_process");
  const script = [
    "import sys; sys.path.insert(0, 'sandbox-image/agent')",
    "import browser_helper as h",
    "class Page:",
    "    def __init__(s, url, name=None): s.url, s.name = url, name",
    "    def evaluate(s, js):",
    "        if not s.url.startswith(('http', 'about:blank')): raise SystemExit('asked a page with no address: ' + repr(s.url))",
    "        return s.name",
    "    def bring_to_front(s): pass",
    "class Context:",
    "    pages = [Page(''), Page('chrome://top-chrome/'), Page('https://shop.example/', 'someone else'), Page('https://shop.example/claim', h.TAB_MARKER)]",
    "print(h._page(Context()).url)",
  ].join("\n");
  const out = spawnSync("python3", ["-c", script], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.equal(out.stdout.trim(), "https://shop.example/claim");
});

// A delay claim stopped at "upload your receipt" with the receipt in the
// person's mail: nothing could choose a file. upload puts their attachments
// into the page's file box, answering the file picker a button opens.
test("upload puts the person's attachments into the page's file box", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const STEP = \[[^\]]*"upload", "download"\];/);
  assert.match(handlers, /const \{ attachments, missing \} = await resolveOutgoingAttachments\(toolInput\.attachment_ids\);/);
  assert.match(handlers, /step\.files = attachments\.map\(\(a\) => \(\{ name: a\.fileName, mimeType: a\.mimeType, base64: a\.buffer\.toString\("base64"\) \}\)\);/);
  assert.match(handlers, /if \(bytes > UPLOAD_MAX_BYTES\)/);
  assert.match(handlers, /upload is a step of its own, not part of a batch/);
  assert.match(read("lib/browse-engine.js"), /const ACTS = new Set\(\["click", "fill", "press", "upload"\]\);/, "done where the person watches");
  assert.match(read("lib/tools/definitions.js"), /attachment_ids: \{\n\s*type: "array",\n\s*items: \{ type: "string" \},\n\s*description: "For upload: the person's files/);
  assert.match(helper, /with page\.expect_file_chooser\(timeout=8000\) as chooser:\n\s*target\.click\(timeout=timeout\)\n\s*chooser\.value\.set_files\(files\)/);
  assert.match(helper, /_CHANGES_PAGE = \("goto", "click", "press", "upload"\)/);
});

// A ticket behind an email's "View tickets" button was never an attachment,
// so Closedhand had none to upload, and drew one of its own, styled as the
// seller's booking confirmation, for a delay claim. A file a site gives is
// downloaded whole and kept as the person's; a file goes into a page only by
// upload, from their own files; and the rule says why.
test("a file a site gives is downloaded and kept, and only the person's own files go into a page", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /"eval_js", "upload", "download"\];/);
  assert.match(handlers, /if \(action === "download"\) \{ step\.link = browseUrl \|\| null; step\.url = null; \}/, "the file's link is fetched, not opened first");
  assert.match(handlers, /parsed\.attachment_id = require\("\.\.\/attachments"\)\.saveAttachment\(userId, \{ buffer, fileName: name, mediaType: f\.mimeType, ext,/);
  assert.match(handlers, /const f = parsed\.file;\n\s*delete parsed\.file;/, "its bytes never go to the LLM");
  // A file Closedhand made, or one a script sets into a page, is put to the
  // person first, never refused: a CV it wrote for them is theirs to upload.
  const gate = require("../lib/send-gate");
  const made = (id) => (id === "att_made" ? "booking_confirmation.png" : null);
  for (const s of ["const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;", "input.files = list", "new File([blob], 'receipt.jpg')"]) assert.ok(gate.PLANTS_FILE.test(s), s);
  for (const s of ["document.title", "[...document.querySelectorAll('a')].map(a => a.href)", "input.files.length === 0", "x.files == null"]) assert.ok(!gate.PLANTS_FILE.test(s), s);
  assert.deepEqual(gate.fileHandover("sandbox_browse", { action: "upload", ref: 41, attachment_ids: ["att_made"] }, made), { made: ["booking_confirmation.png"] });
  assert.equal(gate.fileHandover("sandbox_browse", { action: "upload", ref: 41, attachment_ids: ["att_theirs"] }, made), null, "their own file goes without a question");
  assert.deepEqual(gate.fileHandover("sandbox_browse", { action: "batch", steps: [{ action: "click", ref: 3 }, { action: "eval_js", script: "input.files = dt.files" }] }, made), { script: true });
  assert.equal(gate.fileHandover("sandbox_browse", { action: "eval_js", script: "document.title" }, made), null);
  assert.equal(gate.fileHandoverCard({ made: ["booking_confirmation.png"] }, "delayrepay.example"),
    'I\'m about to upload booking_confirmation.png on delayrepay.example. I made this file myself, so it is not a document anyone else issued.\n\nReply "yes" to upload or "no" to leave it.');
  assert.match(gate.fileHandoverCard({ script: true }, null), /^I'm about to put a file into the page with a script, rather than one of your own files\./);
  assert.doesNotMatch(handlers, /PLANTS_FILE|a\.direction === "chat"/, "nothing is refused in the tool itself");
  assert.match(read("lib/engine.js"), /const fileHandover = !needsConfirmation\n\s*\? require\("\.\/send-gate"\)\.fileHandover\(block\.name, block\.input, \(id\) => require\("\.\/attachments"\)\.madeName\(userId, id\)\) : null;\n\s*if \(fileHandover\) needsConfirmation = true;/, "asked in the chat, tick box or not");
  assert.match(read("lib/engine.js"), /\} else if \(fileHandover\) \{\n\s*confirmSummary = require\("\.\/send-gate"\)\.fileHandoverCard\(/);
  const agents = read("lib/agents.js");
  assert.match(agents, /if \(sendGate\.fileHandover\(block\.name, block\.input, \(id\) => require\("\.\/attachments"\)\.madeName\(userId, id\)\)\) return \{ error: HAND_BACK \};/, "a job nobody is watching hands it back");
  assert.match(agents, /: sendAt \? sendGate\.browserSendCard\(sendAt\) : handover \? sendGate\.fileHandoverCard\(handover, sendGate\.siteNow\(userId\)\) : null;/, "a job asks in the chat");
  assert.match(read("lib/send-gate.js"), /const handover = fileHandover\(toolName, input, \(id\) => require\("\.\/attachments"\)\.madeName\(userId, id\)\);\n\s*if \(handover\) return \{ card: fileHandoverCard\(handover, siteNow\(userId\)\), isInternal: true \};/, "and so do schedules and automations");
  assert.match(read("lib/attachments.js"), /return a && a\.direction === "chat" \? a\.fileName \|\| attachmentId : null;/);
  assert.match(read("lib/attachments.js"), /direction: att\.direction \|\| "in" \};/);
  assert.match(read("lib/attachments.js"), /direction: fileData\.direction \|\| "in",/);
  assert.match(helper, /if action == "download":/);
  assert.match(helper, /resp = context\.request\.get\(link, timeout=30000\)/, "a link to the file is fetched with the browser's own sign-ins");
  assert.match(helper, /with page\.expect_download\(timeout=20000\) as dl:/);
  assert.match(helper, /"hint": "The link opens a page, not a file\. Download with ref: the \[number\] of its download button or link\."/);
  assert.match(read("lib/agents.js"), /- A document someone else issued \(a ticket, receipt, invoice, statement, letter, ID\) is only ever the real one: an attachment, the file a link in their mail leads to \(sandbox_browse download, then upload\), or one the person sends you when asked\. Never make, draw, edit or piece one together, however true its details: handed to a company, a stand-in is a forgery\./);
  assert.match(read("lib/engine.js"), /never invent a fact, a figure, a detail or a document \(a ticket, receipt or letter someone else issued is only ever the one they sent\)/);
});
