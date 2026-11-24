// lib/send-preview.js: what pressing Send in the sandbox computer's browser
// would send, read from the page itself before the person is asked, and
// whether they already said yes to exactly that.
//
// The question used to say only "I'm about to press Send", so it named nothing
// of what went. Shown a chase for a helpdesk thread, a person said yes; the job
// then put in three zoomed-in pieces it had cut from their photo days before,
// reworded the message, and asked again about a Send it did not describe.
// The question now shows the message as it stands in the page, every file
// attached (pictures sent with it), and what changed since their yes. When the
// message is word for word what they said yes to and nothing goes with it,
// they are not asked again.
const OUT = ".send-preview";

// Runs in each page: the message boxes with something written in them, and
// the files put into its file boxes. A picture comes back whole.
const READ_PAGE = `async () => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const boxes = [...document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')]
    .filter((el) => shown(el) && !(el.parentElement && el.parentElement.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')));
  const fields = boxes.map((el) => (el.isContentEditable ? el.innerText : el.value || "").trim()).filter(Boolean);
  const files = [];
  for (const input of document.querySelectorAll('input[type="file"]')) {
    for (const f of Array.from(input.files || []).slice(0, 10)) {
      const data = /^image\\//.test(f.type) && f.size <= 5000000 ? await new Promise((done) => {
        const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] || null); r.onerror = () => done(null); r.readAsDataURL(f);
      }) : null;
      files.push({ name: f.name, type: f.type, size: f.size, data });
    }
  }
  return { url: location.href, fields, files };
}`;

// Runs on the sandbox computer: asks every open web page in both browsers,
// without taking over a tab, and leaves what it found in the workspace, as a
// run's printed output is cut short.
const SCRIPT = `
const fs = require("fs"), path = require("path");
const OUT = path.join("/workspace", ${JSON.stringify(OUT)});
const ask = (page) => new Promise((done) => {
  let ws; const end = (v) => { clearTimeout(timer); try { ws.close(); } catch {} done(v); };
  const timer = setTimeout(() => end(null), 8000);
  try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch { return end(null); }
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "(" + ${JSON.stringify(READ_PAGE)} + ")()", awaitPromise: true, returnByValue: true } }));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) end(d.result && d.result.result ? d.result.result.value : null); };
  ws.onerror = () => end(null);
});
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const found = [];
  for (const [browser, port] of [["visible", 9222], ["headless", 9223]]) {
    let pages = [];
    try { pages = (await (await fetch("http://localhost:" + port + "/json")).json()).filter((p) => p.type === "page" && /^https?:/.test(p.url || "")).slice(0, 12); } catch { continue; }
    for (const got of await Promise.all(pages.map(ask))) if (got && (got.fields.length || got.files.length)) found.push({ browser, ...got });
  }
  let n = 0;
  for (const page of found) for (const file of page.files) {
    if (file.data) { file.saved = (++n) + "-" + path.basename(file.name).replace(/[^\\w.-]/g, "_"); fs.writeFileSync(path.join(OUT, file.saved), Buffer.from(file.data, "base64")); }
    delete file.data;
  }
  fs.writeFileSync(path.join(OUT, "what.json"), JSON.stringify(found));
  console.log("read " + found.length);
})();
`;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } };

// What a step adds itself on its way to Send: a batch that fills the box and
// presses Send in one go has nothing in the page yet.
function stepAdds(toolName, input) {
  if (toolName !== "sandbox_browse" || !input || typeof input !== "object") return { text: [], attachmentIds: [] };
  const steps = input.action === "batch" && Array.isArray(input.steps) ? input.steps : [input];
  const text = [], attachmentIds = [];
  for (const st of steps) {
    if (!st || typeof st !== "object") continue;
    if (st.action === "fill" && String(st.value || st.text || "").trim()) text.push(String(st.value || st.text).trim());
    if (st.action === "upload" && Array.isArray(st.attachment_ids)) attachmentIds.push(...st.attachment_ids);
  }
  return { text, attachmentIds };
}

// What goes: { site, text, files: [{ name, mime, buffer|null }] }, or null
// when nothing could be read.
async function whatGoes(userId, toolName, input) {
  const adds = stepAdds(toolName, input);
  let pages = [];
  const sandbox = require("./sandbox");
  try {
    await sandbox.ensureSandbox(userId);
    const ran = await sandbox.sandboxExec(userId, "node", SCRIPT, 45000);
    if (ran && ran.exit_code === 0) {
      const what = await sandbox.sandboxFileDownload(userId, `${OUT}/what.json`);
      if (what && what.content) pages = JSON.parse(Buffer.from(what.content, "base64").toString("utf8"));
    }
  } catch (e) { console.error("[send-preview] could not read the page:", e.message); }
  // The page the job is on, when more than one has something in it.
  let last = null;
  try { last = hostOf(require("./spend-guard").lastPage(userId)?.url || ""); } catch { /* no page known */ }
  const page = pages.find((p) => last && hostOf(p.url) === last) || pages.sort((a, b) => (b.fields.length + b.files.length) - (a.fields.length + a.files.length))[0] || null;
  const files = [];
  for (const f of page ? page.files : []) {
    let buffer = null;
    if (f.saved) {
      try { const got = await sandbox.sandboxFileDownload(userId, `${OUT}/${f.saved}`); if (got && got.content) buffer = Buffer.from(got.content, "base64"); } catch { /* named, not shown */ }
    }
    files.push({ name: f.name, mime: f.type || "application/octet-stream", buffer });
  }
  if (pages.length) sandbox.sandboxFileDelete(userId, OUT).catch(() => {});
  for (const id of adds.attachmentIds) {
    const raw = await require("./attachments").loadAttachmentRaw(id).catch(() => null);
    if (raw) files.push({ name: raw.fileName, mime: raw.mimeType, buffer: /^image\//.test(raw.mimeType) ? raw.buffer : null });
  }
  const text = [...(page ? page.fields : []), ...adds.text].join("\n\n").trim();
  if (!text && !files.length) return null;
  return { site: page ? hostOf(page.url) : last, text, files };
}

// The words of a message, as the person read them: markdown marks, curly
// quotes and long dashes are how a chat shows text, not what it says.
const norm = (s) => String(s || "").replace(/[*_~`]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const sentences = (s) => String(s || "").split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const paragraphs = (s) => String(s || "").split(/\n\s*\n/).map(norm).filter(Boolean);

// A message's own words: the block Closedhand puts before the person's latest
// message (the time, what was recalled) is not something they said.
const OWN_CONTEXT = /^\[Closedhand context for this message/;
function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text" && !OWN_CONTEXT.test(b.text || "")).map((b) => b.text).join("\n") : "";
}

// The draft the person said yes to: what Closedhand wrote just before their
// latest message, when that message is a plain yes. Each part of a reply sent
// as follow-on messages ([[next]]) is a draft of its own.
function approvedDraft(messages, isYes = (t) => require("./confirmation").confirmationAnswer(t) === "yes") {
  const list = Array.isArray(messages) ? messages : [];
  let i = list.length - 1;
  while (i >= 0 && !(list[i]?.role === "user" && textOf(list[i]).trim())) i--;
  if (i < 0 || !isYes(textOf(list[i]))) return null;
  const said = [];
  for (let j = i - 1; j >= 0 && list[j]?.role !== "user"; j--) if (list[j]?.role === "assistant" && textOf(list[j]).trim()) said.unshift(textOf(list[j]));
  const parts = said.join("\n\n[[next]]\n\n").split(/^\s*\[\[next\]\]\s*$/m).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// Whether what goes is that draft word for word, and if not, what changed.
// The same: the page's paragraphs are the draft's own, in order, with only its
// lead-in before them and at most one short line after (the "say send").
function compare(parts, text) {
  if (!parts || !String(text || "").trim()) return null;
  const page = paragraphs(text);
  for (const part of parts) {
    const p = paragraphs(part);
    for (let start = 0; start + page.length <= p.length; start++) {
      if (!page.every((x, k) => p[start + k] === x)) continue;
      const after = p.slice(start + page.length);
      if (after.length === 0 || (after.length === 1 && after[0].length <= 160)) return { same: true };
    }
  }
  // Not the same: said against the part it shares the most sentences with.
  const mine = sentences(text);
  let best = null;
  for (const part of parts) {
    const theirs = sentences(part);
    const shared = mine.filter((s) => theirs.some((t) => norm(t) === norm(s))).length;
    if (shared && (!best || shared > best.shared)) best = { theirs, shared };
  }
  if (!best) return { same: false, added: [], removed: [] };
  const at = best.theirs.map((t, k) => (mine.some((s) => norm(s) === norm(t)) ? k : -1)).filter((k) => k >= 0);
  const span = best.theirs.slice(Math.min(...at), Math.max(...at) + 1);
  return {
    same: false,
    added: mine.filter((s) => !best.theirs.some((t) => norm(t) === norm(s))),
    removed: span.filter((t) => !mine.some((s) => norm(s) === norm(t))),
  };
}

// The question, whole: never cut short, since what is approved is all of what goes.
function card(shown, change, { picturesSent = false } = {}) {
  const where = shown.site ? `on ${shown.site}, on Closedhand's sandbox computer` : "on Closedhand's sandbox computer";
  const lines = [`I'm about to press Send ${where}. This is what goes:`, ""];
  lines.push(shown.text || "(no message, only the files below)");
  if (shown.files.length) {
    const names = shown.files.map((f) => f.name).join(", ");
    const pictured = picturesSent && shown.files.some((f) => f.buffer);
    lines.push("", `With ${shown.files.length === 1 ? "1 file" : `${shown.files.length} files`}${pictured ? ", shown above" : ""}: ${names}`);
  }
  if (change && !change.same && (change.added.length || change.removed.length)) {
    lines.push("", "Changed since you said yes to it:");
    for (const s of change.added) lines.push(`Now says: ${s}`);
    for (const s of change.removed) lines.push(`No longer says: ${s}`);
  }
  lines.push("", `Reply "yes" to send it or "no" to leave it unsent.`);
  return lines.join("\n");
}

// Sends the pictures that go with it to the chat, before the question.
async function sendPictures(platform, chatId, shown) {
  let sent = false;
  for (const f of shown?.files || []) {
    if (!f.buffer || !/^image\//.test(f.mime)) continue;
    try { await require("./messaging").sendDocumentOnly(platform, chatId, f.buffer, f.name, f.mime); sent = true; }
    catch (e) { console.error("[send-preview] picture not sent:", e.message); }
  }
  return sent;
}

// What a run does about a Send it is about to press in the sandbox browser:
// { go: true } when the person already said yes to exactly this, { refuse }
// when nothing in the page shows what a script would send, else { question,
// shown } to put to them.
const SHOW_FIRST = "Not pressed. The person sees what goes before Send is pressed, read from the page itself: put the message and any files into the page in one step, then press Send in a step of its own.";
async function decide(userId, toolName, input, messages) {
  const shown = await whatGoes(userId, toolName, input).catch((e) => { console.error("[send-preview] could not say what goes:", e.message); return null; });
  if (!shown) return toolName === "sandbox_exec" ? { refuse: SHOW_FIRST } : { question: null, shown: null };
  const change = compare(approvedDraft(messages), shown.text);
  if (change && change.same && !shown.files.length) return { go: true, shown };
  return { question: (picturesSent) => card(shown, change, { picturesSent }), shown };
}

module.exports = { whatGoes, approvedDraft, compare, card, sendPictures, decide, stepAdds, READ_PAGE, SCRIPT, SHOW_FIRST };
