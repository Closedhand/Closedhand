// Which of a connected server's tools load with a request's first model call
// (lib/engine.js uses it; kept apart so it can be tested by itself).
// The same for the tools of servers the person connected (MCP), which have
// no families written for them: a server's tool loads with the first model
// call when the request names what the tool works on, read from the tool's
// own name ("calendar", "event", "invoice"). The verbs every tool has (get,
// list, send, delete) say nothing about which one is meant, so they do not
// count. A few small servers load whole. Everything stays within a size, the
// best matches first, and whatever is left over is still a get_tool_details
// away. Each look-up that this saves was a whole model call, and, because the
// tool list sits ahead of the conversation, a re-read of the conversation at
// full price: ten look-ups a task on a server of a hundred tools.
const MCP_LOAD_CHARS = 24000; // about 6,000 tokens of tool definitions
// With a provider seen to read a repeated start from its cache, a long tool
// list costs next to nothing after its first reading, and a changing one
// costs the whole conversation each time it changes. So for those there is
// room for a server's tools whole: on a server of a hundred tools that took
// look-ups from 1.5 a task to 0.8, a fifth off the time and a sixth off the
// cost, with as many tasks done right.
const MCP_LOAD_CACHED_CHARS = 120000; // about 30,000 tokens
const TOOL_VERBS = new Set(["get", "list", "read", "search", "find", "fetch", "show", "view", "lookup", "query", "add", "create", "new", "make", "set", "put", "update", "edit", "change", "delete", "remove",
  "cancel", "send", "reply", "forward", "move", "copy", "save", "open", "close", "run", "all", "by", "to", "from", "for", "of", "in", "on", "and", "the", "with", "current", "user", "details", "info", "data", "item", "items", "umcp", "mcp", "tool", "id", "ids"]);
const singular = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
function likelyMcpTools(userMessage, conversation, defs, loaded = new Set(), maxChars = MCP_LOAD_CHARS, wholeUnder = maxChars / 2) {
  const size = (t) => JSON.stringify(t).length;
  const names = new Set();
  if (!defs || !defs.length) return names;
  if (defs.reduce((n, t) => n + size(t), 0) <= wholeUnder) { for (const t of defs) names.add(t.name); return names; }
  const text = String(userMessage || "");
  const lastReply = [...(conversation || [])].reverse().find(m => m && m.role === "assistant" && typeof m.content === "string");
  const answering = lastReply && text.trim().split(/\s+/).length <= 12 ? lastReply.content : "";
  const said = new Set((text + " " + answering).toLowerCase().match(/[a-z]{3,}/g)?.map(singular) || []);
  const scored = [];
  for (const t of defs) {
    const own = [...new Set(String(t.name).toLowerCase().split(/[^a-z]+/).map(singular))].filter(w => w.length >= 3 && !TOOL_VERBS.has(w));
    const hits = own.filter(w => said.has(w)).length;
    if (hits) scored.push({ t, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  // What the conversation has loaded already counts towards the size, so a
  // long one does not end up carrying a whole server message by message.
  let used = defs.filter(t => loaded.has(t.name)).reduce((n, t) => n + size(t), 0);
  for (const { t } of scored) {
    if (loaded.has(t.name)) continue;
    const n = size(t);
    if (used + n > maxChars) continue;
    used += n;
    names.add(t.name);
  }
  return names;
}

module.exports = { likelyMcpTools, MCP_LOAD_CHARS, MCP_LOAD_CACHED_CHARS };
