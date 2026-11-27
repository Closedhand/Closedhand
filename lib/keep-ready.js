// lib/keep-ready.js: keeps the main chat's conversation in Claude's cache
// for the rest of the day, so a message after a break of more than an hour
// reads it back for a couple of cents instead of storing it all again (about
// 80 cents on Opus for a conversation of 100,000 tokens).
//
// Anthropic keeps what it stored for an hour after it was last read. After a
// reply in the main chat on Claude, the start of the request the next message
// will send is noted. 55 minutes after the last use it is sent with a hidden
// message asking for a one-word answer, which nobody sees and the
// conversation never keeps: that reads it, and the hour starts again. Each
// costs about 2 cents on Opus and saves the 80 only if a message follows, so
// it stops at midnight in the person's time (the night's break is long), and
// as soon as a ping had to store much of what it sent: something changed (a
// fact pinned, a setting), so it would keep the wrong thing ready. The next
// reply notes it afresh. Timers live in memory; a restart drops them.

const EVERY_MS = 55 * 60 * 1000;
const ASK = "[Closedhand is keeping this conversation ready for the next message. Nothing to do: reply with OK.]";
const _ready = new Map(); // userId -> { request, client, zone, day, timer }

function dayIn(ms, zone) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (_) { return new Date(ms).toISOString().slice(0, 10); }
}

// After a reply: the request the next message would send, set out the same
// way with ASK as its message (lib/engine.js), and who sends it.
function note(userId, { client, backend, request, zone, now = Date.now() }) {
  stop(userId);
  if (backend !== "anthropic" || !/^claude-/.test(String(request?.model || "")) || !client) return false;
  const entry = { client, request, zone, day: dayIn(now, zone), timer: null };
  _ready.set(userId, entry);
  return schedule(userId, entry, now);
}

function schedule(userId, entry, now = Date.now()) {
  if (dayIn(now + EVERY_MS, entry.zone) !== entry.day) { _ready.delete(userId); return false; }
  entry.timer = setTimeout(() => { ping(userId, entry).catch(() => {}); }, EVERY_MS);
  if (entry.timer.unref) entry.timer.unref();
  return true;
}

async function ping(userId, entry) {
  if (_ready.get(userId) !== entry) return;
  let usage;
  try {
    const response = await entry.client.messages.create(entry.request);
    usage = response?.usage || {};
  } catch (e) {
    console.warn(`[keep-ready] stopped, the ping failed: ${e.message}`);
    stop(userId);
    return;
  }
  if (_ready.get(userId) !== entry) return;
  const read = usage.cache_read_input_tokens || 0, stored = usage.cache_creation_input_tokens || 0;
  if (stored > 0.25 * (read + stored)) {
    console.log(`[keep-ready] stopped: read ${read}, stored ${stored} (it changed since)`);
    stop(userId);
    return;
  }
  console.log(`[keep-ready] main chat kept ready: read ${read}, stored ${stored}`);
  schedule(userId, entry);
}

function stop(userId) {
  const entry = _ready.get(userId);
  if (entry?.timer) clearTimeout(entry.timer);
  _ready.delete(userId);
}

module.exports = { note, stop, ASK, EVERY_MS, _ping: (userId) => ping(userId, _ready.get(userId)), _has: (userId) => _ready.has(userId) };
