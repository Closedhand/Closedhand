// Replying to an earlier message picks its topic back up, in the one Chat:
// every chat app (and the web chat) puts the message replied to in front of
// the new one ("[replying to …: "…"]", lib/project-rules.js splitReply). When
// that message is still in the conversation the LLM reads, the quote is
// enough. When it has left it (condensed into a Context Note), the exchange
// around it comes back word for word from the archive every trimmed turn is
// kept in (lib/conversation.js _archiveTurns): the lead-up, the message and
// what followed, so the reply is read against what was actually said rather
// than a summary of it.
const BEFORE = 6, AFTER = 3, EACH_CHARS = 1200, MAX_CHARS = 6000;

// Compared without formatting: WhatsApp shows bold with one asterisk where
// the reply as kept has two, so a quote of a reply that opened in bold never
// matched it, and Closedhand saw only the quote.
const norm = (s) => String(s || "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const textOf = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ") : "";
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
// The archive's text keeps its formatting and line breaks, so it is searched
// by the quote's first words with anything between them; holds() decides.
const loosely = (key) => `%${key.split(" ").slice(0, 8).map((w) => w.replace(/[\\%_]/g, (c) => "\\" + c)).join("%")}%`;

// What a quote is found by: a chat app may cut a long quote short, so the
// start of it is what is sure. Null when too short to tell.
function quoteKey(quoted) {
  const key = norm(quoted).replace(/(\.\.\.|…)$/, "").slice(0, 80);
  return key.length < 12 ? null : key;
}
// A message holds the quoted one when its own words do: a message of the
// person's that quoted it too (a /bug sent as a reply to it) is not it, and
// counting it as the message still in view left the LLM with only the quote.
const ownWords = (m) => (m && m.role === "user" ? require("./project-rules").splitReply(textOf(m.content)).rest : textOf(m && m.content));
const holds = (m, key) => norm(ownWords(m)).includes(key);

// The turns around a quoted message in the archive, oldest first, or null:
// `before` turns ahead of it, it, and `after` turns after it. /bug uses it
// too (lib/bug-reports.js).
async function archived(userId, quoted, { before = BEFORE, after = AFTER, supabase } = {}) {
  const key = quoteKey(quoted);
  if (!key) return null;
  const db = supabase || require("../user-store").supabase;
  const { data: hits } = await db.from("data_cache").select("external_id, data")
    .eq("user_id", userId).eq("source", "conversation").ilike("data->>text", loosely(key)).limit(20);
  const hit = (hits || []).filter((h) => norm(h.data?.text).includes(key)).map((h) => ({ ...h, at: Number(String(h.external_id).match(/-(\d+)$/)?.[1]) }))
    .filter((h) => Number.isFinite(h.at)).sort((a, b) => b.at - a.at)[0];
  if (!hit) return null;
  const chat = hit.data?.chat || "no-thread";
  const ids = [];
  for (let n = Math.max(0, hit.at - before); n <= hit.at + after; n++) ids.push(`conv-${chat}-${n}`);
  const { data: rows } = await db.from("data_cache").select("external_id, data")
    .eq("user_id", userId).eq("source", "conversation").in("external_id", ids);
  const turns = (rows || []).map((r) => ({ at: Number(String(r.external_id).match(/-(\d+)$/)?.[1]), role: r.data?.sender === "Closedhand" ? "assistant" : "user", text: String(r.data?.text || "") }))
    .filter((t) => Number.isFinite(t.at) && t.text).sort((a, b) => a.at - b.at)
    .map((t) => ({ ...t, quoted: t.at === hit.at }));
  return turns.length ? turns : null;
}

// The turns around a quoted message in one of the person's project
// conversations, oldest first, with the project's name, or null. A reply in
// the main chat to a message from a project's conversation (a task's answer
// there, delivered to the same chat app) found nothing: the LLM saw only the
// quote, and not that the search behind that answer had failed.
async function inProject(userId, quoted, { before = BEFORE, after = AFTER, supabase } = {}) {
  const key = quoteKey(quoted);
  if (!key) return null;
  const db = supabase || require("../user-store").supabase;
  const { data: threads } = await db.from("conversation_threads").select("project_id, messages")
    .eq("user_id", userId).not("project_id", "is", null).order("updated_at", { ascending: false }).limit(50);
  for (const t of threads || []) {
    const list = Array.isArray(t.messages) ? t.messages : [];
    let at = -1;
    for (let i = list.length - 1; i >= 0 && at < 0; i--) if (holds(list[i], key)) at = i;
    if (at < 0) continue;
    const turns = list.slice(Math.max(0, at - before), at + after + 1)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: textOf(m.content), quoted: m === list[at] })).filter((x) => x.text);
    const { data: named } = await db.from("projects").select("name").eq("id", t.project_id).eq("user_id", userId).limit(1);
    return { turns, project: (named && named[0] && named[0].name) || null };
  }
  return null;
}

// The note for this turn, or null: nothing quoted, the quote still in view,
// or nothing in the archive or a project's conversation matches it.
async function noteFor(userId, text, { conversation, supabase } = {}) {
  const { quoted } = require("./project-rules").splitReply(String(text || ""));
  const key = quoteKey(quoted);
  if (!key) return null;
  // Whose message it is, as the reply says: only Closedhand's own messages
  // can be one of Closedhand's (a /bug the person sent about it quotes it at
  // its end, and was taken for it).
  const by = /^\s*\[replying to closedhand'?s message/i.test(String(text || "")) ? "assistant" : /^\s*\[replying to your own message/i.test(String(text || "")) ? "user" : null;
  const live = conversation || require("./conversation").getConversation(userId);
  if ((live || []).some((m) => (!by || (m && m.role === by)) && holds(m, key))) return null;
  let turns = await archived(userId, quoted, { supabase }), project = null;
  if (!turns) {
    // A lookup that fails leaves the reply as it was, never the turn broken.
    const found = await inProject(userId, quoted, { supabase }).catch(() => null);
    if (!found) return null;
    turns = found.turns; project = found.project || "one of their projects";
  }
  let body = "";
  for (const t of turns) {
    const line = `${t.role === "assistant" ? "You (Closedhand)" : "The user"}${t.quoted ? " (the message being replied to)" : ""}: ${t.text.length > EACH_CHARS ? t.text.slice(0, EACH_CHARS) + "…" : t.text}\n`;
    if (body.length + line.length > MAX_CHARS) break;
    body += line;
  }
  const from = project ? `a message from the conversation of their project "${project}", which this conversation does not hold` : "an earlier message that has left the conversation you can see";
  return `[The user is replying to ${from}. Here is the exchange it was in, word for word from the chat's history, so you can pick that topic up where it was:]\n${body}[End of that earlier exchange.]`;
}

module.exports = { noteFor, archived, inProject, quoteKey, holds };
