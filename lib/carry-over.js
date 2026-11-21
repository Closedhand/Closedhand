// lib/carry-over.js: a conversation from closedhand.com's home page, carried on.
//
// Someone can ask the uncensored LLM Closedhand provides a few questions on
// closedhand.com before downloading anything. Their browser keeps that
// conversation; the first time this Closedhand's web chat opens on that
// computer, it fetches it once through closedhand.com/carry, which hands it
// straight back and forgets it (closedhand-com/public/carry.js), and sends
// it here over the web chat's socket. It becomes the start of the person's
// conversation, marked as from closedhand.com, so Closedhand carries on from
// it in every app. Only into an empty conversation: anything there already
// is the person's own, and a carried one never goes in front of it.

const MAX_TURNS = 10;
const MAX_CHARS = { user: 2000, assistant: 8000 };

// The turns as they came, or null unless they are a plain conversation:
// questions and answers in turn, starting with a question and ending with
// an answer, each of a sensible length.
function turnsFrom(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_TURNS || raw.length % 2) return null;
  const turns = [];
  for (const [i, t] of raw.entries()) {
    const role = i % 2 ? "assistant" : "user";
    if (!t || t.role !== role || typeof t.text !== "string") return null;
    const text = t.text.trim();
    if (!text || text.length > MAX_CHARS[role]) return null;
    turns.push({ role, text });
  }
  return turns;
}

// Puts the turns at the start of an empty conversation and saves it.
// Resolves to how many went in: 0 when the conversation already had
// something in it.
function carryIn(userId, turns, deps = {}) {
  const ctx = deps.ctx || require("./context");
  return new Promise((resolve, reject) => {
    ctx.queueUserMessage(userId, async () => {
      try {
        const { UserStore } = deps.UserStore ? deps : require("../user-store");
        const userStore = await UserStore.load(userId);
        const conversation = userStore.conversations;
        if (!Array.isArray(conversation) || conversation.length) return resolve(0);
        // A moment apart, in order, all before now.
        const start = Date.now() - turns.length * 1000;
        turns.forEach((t, i) => conversation.push({ role: t.role, content: t.text, ts: new Date(start + i * 1000).toISOString(), via: "site" }));
        userStore.markDirty("conversations");
        await userStore.save();
        console.log(`[carry-over] ${turns.length} turns from closedhand.com for ${String(userId).slice(0, 8)}`);
        resolve(turns.length);
      } catch (e) { reject(e); }
    }, { housekeeping: true });
  });
}

module.exports = { turnsFrom, carryIn, MAX_TURNS };
