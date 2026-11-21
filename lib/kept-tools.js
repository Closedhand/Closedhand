// lib/kept-tools.js: the on-demand tools each conversation has loaded, in the
// order it loaded them, kept for its later turns and kept with its thread.
//
// The tool list sits right after the system prompt in what the provider
// reads, so a list that changes makes it read the whole conversation again at
// full price. The list was kept in memory only: after a restart every tool the
// conversation had been using was looked up again in the middle of a reply,
// and each one made the provider read the whole conversation again (on one
// person's 780-message chat, three times in the first half hour after a
// restart, about 118,000 tokens each). Kept with the thread, the list a
// conversation had is the list it has after a restart.
// Room for every tool of several connected servers: a list cut short comes
// back different after a restart, and the provider reads it all again.
const MAX_KEPT = 300;
const _kept = new Map(); // "user:thread" -> { set, saved: "a,b,c", read: Promise }
let _warned = false;
const keyOf = (userId, threadId) => `${userId}:${threadId || "main"}`;
const base = () => require("./db").supabase;

function entry(userId, threadId) {
  const key = keyOf(userId, threadId);
  if (!_kept.has(key)) _kept.set(key, { set: new Set(), saved: "", read: null });
  return _kept.get(key);
}

// The set itself, as the reply uses it.
function get(userId, threadId) {
  return entry(userId, threadId).set;
}

// Read back what the thread kept, once a process. Never fails a reply: a
// thread with nothing kept, or a database without the column yet, starts empty.
function ready(userId, threadId, db = base()) {
  const e = entry(userId, threadId);
  if (e.read) return e.read;
  e.read = (async () => {
    if (!threadId) return;
    try {
      const { data, error } = await db.from("conversation_threads").select("kept_tools").eq("id", threadId).eq("user_id", userId).maybeSingle();
      if (error) throw new Error(error.message);
      const names = Array.isArray(data?.kept_tools) ? data.kept_tools.filter((n) => typeof n === "string" && n) : [];
      // What this process loaded already goes after what was kept, in order.
      const now = [...e.set];
      e.set.clear();
      for (const n of [...names, ...now]) e.set.add(n);
      e.saved = names.join(",");
    } catch (err) {
      if (!_warned) { _warned = true; console.warn(`[kept-tools] could not read a thread's kept tools: ${err.message}`); }
    }
  })();
  return e.read;
}

// Written back when the reply has changed it.
async function save(userId, threadId, db = base()) {
  if (!threadId) return false;
  const e = entry(userId, threadId);
  const names = [...e.set].slice(-MAX_KEPT);
  const now = names.join(",");
  if (now === e.saved) return false;
  const { error } = await db.from("conversation_threads").update({ kept_tools: names }).eq("id", threadId).eq("user_id", userId);
  if (error) {
    if (!_warned) { _warned = true; console.warn(`[kept-tools] could not keep a thread's tools: ${error.message}`); }
    return false;
  }
  e.saved = now;
  return true;
}

module.exports = { get, ready, save, MAX_KEPT, _reset: () => { _kept.clear(); _warned = false; } };
