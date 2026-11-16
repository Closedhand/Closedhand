// lib/one-chat.js: one conversation, whole wherever it is opened.
//
// Closedhand has one conversation with the person across every app, but each
// app showed only what passed through it: a question asked on WhatsApp was
// missing from the web chat, and an answer read in the web chat was missing
// from WhatsApp, so carrying on in another app meant carrying on half blind.
// After every turn, each app that can show it gets it:
// - the web chat, Closedhand's own, shows every message from every app, live,
//   with the app it came from;
// - WhatsApp linked to the person's own account gets the turn in their chat
//   with themselves: their words as theirs, the reply as its replies are,
//   silently (nothing they send themselves buzzes);
// - Telegram, where Closedhand is a bot, cannot show the person's words as theirs, and
//   copying private chats onto it is not wanted, so when they switch to it
//   mid-topic a short card shows where they left off (both sides, as a
//   quote), and the answer goes as a reply to their new message, so it is
//   plainly answering that.
// Pictures and files Closedhand sent in the turn go with it: a picture made
// in the web chat once reached WhatsApp only as the words "sent as
// ferrari_spider.jpg".
// Status lines ("Thinking…") and proactive messages stay where they went;
// the web chat shows proactive messages too.

const NAMES = { web: "the web chat", whatsapp_linked: "WhatsApp", telegram: "Telegram" };
const BOT_APPS = new Set(["telegram"]);
const CATCH_UP_WITHIN_MS = 3 * 3600 * 1000;

// What the person wrote, as they wrote it: a reply's quoted message and
// Closedhand's own notes are not their words.
function theirWords(text) {
  return require("./project-rules").splitReply(String(text || "")).rest.replace(/\s+/g, " ").trim();
}

// Where the person left off, when their last message was in another app not
// long ago and they now write in a bot app: their words and the start of the
// answer. Read before the turn adds this message. Null otherwise.
const short = (t) => (t.length > 120 ? t.slice(0, 120).replace(/\s+\S*$/, "") + "…" : t);
const plain = (t) => String(t || "").split(/\n|\[\[next\]\]/)[0].replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
function catchUp(conversation, via, { botName = "Closedhand", now = Date.now() } = {}) {
  if (!BOT_APPS.has(via)) return null;
  const list = conversation || [];
  let i = list.length - 1;
  while (i >= 0 && !(list[i] && list[i].role === "user" && typeof list[i].content === "string")) i--;
  const last = list[i];
  if (!last || !last.via || last.via === via || !NAMES[last.via]) return null;
  if (!last.ts || now - Date.parse(last.ts) > CATCH_UP_WITHIN_MS) return null;
  const you = theirWords(last.content);
  if (!you || /^\[[^\]]*\]$/.test(you)) return null;
  const answer = list.slice(i + 1).find((m) => m && m.role === "assistant" && typeof m.content === "string");
  return { from: NAMES[last.via], you: short(you), them: answer ? short(plain(answer.content)) : "", botName };
}

// The card as Telegram shows a quote.
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function catchUpMessage(card) {
  const lines = [`You: ${card.you}`, card.them && `${card.botName}: ${card.them}`].filter(Boolean);
  return { text: `Earlier, in ${card.from}:\n<blockquote>${lines.map(esc).join("\n")}</blockquote>`, html: true };
}

// Sent before the answer, in the app the person is now in. True when it went.
async function sendCatchUp(via, chatId, card) {
  await require("./context").bot.sendMessage(chatId, catchUpMessage(card).text, { parse_mode: "HTML" });
  return true;
}

// Every message the turn added carries the app it came from.
function tag(conversation, before, via) {
  let n = 0;
  for (const m of conversation || []) if (m && typeof m === "object" && !before.has(m) && !m.via) { m.via = via; n++; }
  return n;
}

// The pictures and files Closedhand sends during a turn (messaging.js), kept
// for the turn they belong to: { said, files }.
const turnFiles = new Map();
function noteFile(userId, said, file) {
  const turn = turnFiles.get(userId);
  if (turn && turn.said === said) turn.files.push(file);
  else turnFiles.set(userId, { said, files: [file] });
}

// The turn's files on its answer in the conversation ({ id, name, mime, size }
// each, and for a picture Closedhand made what it was made from and what it
// showed), so looking back shows them, as they showed when they came. Before
// after(), which takes them. True when the answer changed.
function keepFiles(userId, said, conversation, before) {
  const turn = turnFiles.get(userId);
  if (!turn || turn.said !== said) return false;
  const kept = turn.files.filter((f) => f.id).map((f) => ({ id: f.id, name: f.filename, mime: f.mimeType, size: f.buffer.length, ...(f.madeFrom ? { made_from: f.madeFrom } : {}), ...(f.shows ? { shows: f.shows } : {}) }));
  const answer = [...(conversation || [])].reverse().find((m) => m && !before.has(m) && m.role === "assistant" && typeof m.content === "string");
  if (!kept.length || !answer) return false;
  answer.files = [...(answer.files || []), ...kept];
  return true;
}

// The turn, to the apps that did not see it.
async function after({ userId, via, said, reply, fileData = null, project = null }) {
  const turn = turnFiles.get(userId);
  turnFiles.delete(userId);
  const files = turn && turn.said === said ? turn.files : [];
  const words = theirWords(said) || (fileData ? `(${/^image\//.test(fileData.mimeType || "") ? "a photo" : "a file"})` : "");
  const answer = typeof reply === "string" ? reply.trim() : "";
  if (!words && !answer && !files.length) return;
  if (via !== "web") toWeb(userId, [words && { role: "user", content: words, via }, answer && { role: "assistant", content: answer, via }].filter(Boolean), project, files);
  if (via !== "whatsapp_linked") await toWhatsApp(userId, { said: words, reply: answer, files }).catch((e) => console.warn(`[one-chat] WhatsApp not updated: ${e.message}`));
}

// Open web chat tabs, live; their history reads the same conversation.
const MAX_WEB_FILE = 8 * 1024 * 1024;
function toWeb(userId, messages, project = null, files = []) {
  try {
    const web = require("./web-chat-ws");
    if (!web.hasWebChatConnection(userId)) return;
    if (messages.length) web.sendToUser(userId, { type: "elsewhere", messages, project: project ? { id: project.id || null, emoji: project.emoji || null } : null });
    for (const f of files) if (f.buffer.length <= MAX_WEB_FILE) web.sendToUser(userId, { type: "file", filename: f.filename, mediaType: f.mimeType, size: f.buffer.length, base64: f.buffer.toString("base64") });
  } catch (_) { /* no web chat open */ }
}

// The person's own chat with themselves, when WhatsApp is linked to their account.
async function toWhatsApp(userId, { said, reply, files = [] }) {
  const wa = require("./platforms/whatsapp-linked");
  const self = wa.selfChat(userId);
  if (!self) return;
  if (said) await wa.mirrorPersonToSelf(said);
  if (reply) await wa.sendLinkedMessage(self, reply);
  for (const f of files) await wa.sendLinkedDocument(self, f.buffer, f.filename, f.mimeType, /^image\/(png|jpeg|gif|webp)$/.test(f.mimeType || ""));
}

// A message Closedhand sent on its own (Pulse, a finished task, a reminder):
// the web chat shows it too.
function sentElsewhere(userId, via, text) {
  if (!userId || via === "web" || !String(text || "").trim()) return;
  toWeb(userId, [{ role: "assistant", content: String(text).trim(), via }]);
}

// The model's copy of the conversation: each reply that sent files says so,
// with each file's id and, for a picture Closedhand made, what it was made
// from and what it showed, so the same person or thing can be shown again
// (repeated word for word, or given as a picture to work from). Without this
// the next turn knew nothing of a picture it had sent, and "her again" drew a
// stranger. The conversation keeps the reply as it was written.
function filesForModel(list) {
  return (list || []).map((m) => {
    if (!m || m.role !== "assistant" || typeof m.content !== "string" || !Array.isArray(m.files) || !m.files.length) return m;
    const each = m.files.map((f) => `${f.id}${f.made_from ? `, made from "${f.made_from}"` : ""}${f.shows ? `, which shows: ${f.shows}` : ""}`);
    return { ...m, content: `${m.content}\n\n[Sent with this reply: ${each.join("; ")}]` };
  });
}

module.exports = { filesForModel, after, tag, catchUp, catchUpMessage, sendCatchUp, sentElsewhere, noteFile, keepFiles, theirWords, NAMES, BOT_APPS };
