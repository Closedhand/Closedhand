// lib/mail-bounces.js: an automatic answer to mail Closedhand made is told
// straight away. A chase Closedhand wrote went to a ticket desk's no-reply
// address and was reported as sent; the answer saying nobody reads that
// address came three seconds later, and nobody was told. Run right after a
// sync that brought new mail (lib/mail-noticing.js), for the threads of
// drafts Closedhand made (lib/made.js) in the last two days: a bounce or a
// "this is a no-reply address" in one of them goes to the chat apps
// unprompted messages go to (lib/proactive.js), once (lib/told-items.js).
// Mail the person writes themselves is left alone: their mail app shows them
// its bounces.

const MADE_WITHIN_MS = 2 * 86400000;
// What an automatic answer says it is: the address is not read, or the mail
// did not arrive.
const SAYS_UNREAD = /\b(?:this is a |from a |an? )?no-?reply (?:address|email|inbox|mailbox)\b|\b(?:is|are) not (?:monitored|read)\b|\bdo not reply to this (?:email|message|address)\b|\bcannot (?:receive|accept) (?:replies|emails?|messages?)\b/i;
const SAYS_UNDELIVERED = /\bundeliverable\b|\bdelivery status notification\b|\bdelivery (?:has )?failed\b|\bmail delivery (?:failed|subsystem)\b|\breturned mail\b|\baddress (?:not found|couldn'?t be found)\b|\bmessage (?:was )?(?:not|wasn'?t|couldn'?t be) delivered\b/i;
const DAEMON = /mailer-daemon|postmaster@/i;

const plain = (s) => String(s || "").replace(/\s+/g, " ").trim();
const nameOf = (from) => plain(String(from || "").replace(/<[^>]*>/g, "").replace(/^"|"$/g, "")) || plain(from);
const addressOf = (to) => (String(to || "").match(/[^\s<>"',;]+@[^\s<>"',;]+/) || [plain(to)])[0];

// Whether an email is an automatic answer saying the mail was not read or not delivered.
function isAutomaticAnswer(email) {
  const d = email || {};
  const said = `${d.subject || ""} ${String(d.body || d.snippet || "").slice(0, 2000)}`;
  return DAEMON.test(d.from || "") || SAYS_UNDELIVERED.test(said) || SAYS_UNREAD.test(said);
}

// The message for the person, in the answer's own words.
function noticeText(answer, sent) {
  const d = answer || {};
  const quote = plain(require("./readable-text").readable(d.body || d.snippet || "")).slice(0, 300);
  const to = sent ? addressOf(sent.to) : null;
  return `Your email${to ? ` to ${to}` : ""} didn't get through. ${nameOf(d.from) || "The other side"} answered straight away${quote ? `: "${quote}${quote.length === 300 ? "…" : ""}"` : "."}`;
}

async function noticeBounces(userId, sinceMs, { db = null, deliver = null, now = Date.now() } = {}) {
  const supabase = db || require("./db").supabase;
  const { data: made } = await supabase.from("made_items").select("thread, made_at")
    .eq("user_id", userId).eq("kind", "draft").gte("made_at", new Date(now - MADE_WITHIN_MS).toISOString());
  const threads = new Set((made || []).map((m) => m.thread).filter(Boolean));
  if (!threads.size) return 0;
  const { data: fresh } = await supabase.from("data_cache").select("source, external_id, received_at, data")
    .eq("user_id", userId).eq("type", "email").gte("created_at", new Date(sinceMs).toISOString());
  const answers = (fresh || []).filter((r) => r.data && threads.has(r.data.threadId) && !(r.data.labels || []).includes("SENT") && isAutomaticAnswer(r.data));
  if (!answers.length) return 0;
  const toldItems = require("./told-items");
  const told = await toldItems.toldAlready(supabase, userId, answers);
  let said = 0;
  for (const a of answers) {
    if (told.has(toldItems.key(a.source, a.external_id))) continue;
    // The mail it answered: the newest sent in that thread before it.
    const { data: thread } = await supabase.from("data_cache").select("received_at, data")
      .eq("user_id", userId).eq("type", "email").eq("data->>threadId", a.data.threadId);
    const sent = (thread || []).filter((r) => (r.data?.labels || []).includes("SENT") && r.received_at <= a.received_at)
      .sort((x, y) => String(y.received_at).localeCompare(String(x.received_at)))[0]?.data || null;
    const text = noticeText(a.data, sent);
    const reached = await (deliver || defaultDeliver)(userId, text);
    if (!reached) continue;
    await toldItems.recordTold(supabase, userId, [a], "bounce");
    console.log(`[bounces] ${String(userId).slice(0, 8)}: told of an automatic answer to mail Closedhand made`);
    said++;
  }
  return said;
}

async function defaultDeliver(userId, text) {
  const { UserStore } = require("../user-store");
  const store = await UserStore.load(userId);
  const { data: links } = await require("./db").supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
  return require("./proactive").deliverUnprompted(userId, store, links || [], () => text);
}

module.exports = { noticeBounces, isAutomaticAnswer, noticeText };
