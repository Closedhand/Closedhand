// What the last reply in a conversation sent to the model and read with its
// tools, kept for a short while so the next message carries on from it. The
// conversation itself keeps only what was said, so a follow-up ("she replied,
// go ahead", "move it to 7:30", a notice that something arrived) used to
// start from the words alone: every id had to be found again, with a round of
// the model for each look, and the provider read the whole exchange afresh at
// full price. Carried on, the follow-up is the same request grown by one
// message: what was read is still there, and all of it comes from the
// provider's cache. Only for a few minutes (what was read goes stale, and the
// cache is gone by then anyway), only while it fits, and never across a
// restart: after any of those the next message starts from the conversation,
// as before.
const CARRY_MS = 10 * 60 * 1000;
const CARRY_MAX_CHARS = 300000; // about 75,000 tokens
const _lastTurns = new Map();
const turnKey = (userId, threadId) => `${userId}:${threadId || "main"}`;
function rememberTurn(userId, threadId, messages, reply, now = Date.now(), sent = null) {
  const key = turnKey(userId, threadId);
  if (!Array.isArray(messages) || !messages.length || !reply || JSON.stringify(messages).length > CARRY_MAX_CHARS) { _lastTurns.delete(key); return; }
  _lastTurns.set(key, { at: now, messages, reply: String(reply), system: sent ? sent.system : null, tools: sent ? sent.tools : null });
}
// The messages for a new turn that follows on: what the last turn sent, then
// its reply and everything in the conversation since, the new message last.
// Null when there is nothing to carry on from.
function carriedTurn(userId, threadId, conversation, now = Date.now()) {
  const key = turnKey(userId, threadId);
  const last = _lastTurns.get(key);
  if (!last) return null;
  if (now - last.at > CARRY_MS) { _lastTurns.delete(key); return null; }
  const list = Array.isArray(conversation) ? conversation : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === "assistant" && list[i].content === last.reply) { at = i; break; }
  }
  // Its reply is no longer in the conversation (cleared, condensed, another thread).
  if (at < 0) { _lastTurns.delete(key); return null; }
  return [...last.messages, ...list.slice(at)];
}
function forgetTurn(userId, threadId) { _lastTurns.delete(turnKey(userId, threadId)); }
// The same for a task that starts from this conversation (one set for a
// moment a few minutes on): the request as the chat last made it, system
// prompt and tools included, for the task to carry on from
// (lib/task-evidence.js carriedMessages). Null when there is nothing fresh.
function lastRequest(userId, threadId, conversation, now = Date.now()) {
  const messages = carriedTurn(userId, threadId, conversation, now);
  const last = messages && _lastTurns.get(turnKey(userId, threadId));
  return last && last.system && last.tools ? { system: last.system, tools: last.tools, messages } : null;
}

module.exports = { rememberTurn, carriedTurn, forgetTurn, lastRequest, CARRY_MS, CARRY_MAX_CHARS };
