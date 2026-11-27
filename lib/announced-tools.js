// lib/announced-tools.js: tools loaded on demand are announced in the
// conversation, after the message that wanted them, instead of joining the
// tool list.
//
// The tool list is the very start of what the provider reads, so a tool
// added to it midway made the provider read the system prompt and the whole
// conversation again at full price: on Opus, 7 of 12 tools loaded over three
// days did, about $0.40 each. Announced (a system message of tool_addition
// blocks, which lib/model-wire.js sends as it is where the provider takes it
// and turns back into the tool list anywhere else), the list and all before
// it stay as they were and are read from cache.
//
// Each request records on its message in the conversation which tools it
// announced (toolsAdded), so a later reply built from the conversation puts
// the same announcement in the same place, and that is read from cache too.

const isAnnouncement = (m) => m?.role === "system" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_addition");

function announcement(defs) {
  return { role: "system", content: defs.map((d) => ({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: d.name, description: d.description, input_schema: d.input_schema } } })) };
}

function announcedNames(messages) {
  const names = new Set();
  for (const m of messages || []) {
    if (!isAnnouncement(m)) continue;
    for (const b of m.content) if (b?.type === "tool_addition" && b.tool?.definition?.name) names.add(b.tool.definition.name);
  }
  return names;
}

// The messages with each recorded announcement back after its message,
// unless the messages announce those tools already (a reply carried on, or
// resumed, keeps the ones it sent). A tool no longer there is left out.
function withAnnouncements(messages, defOf) {
  const shown = announcedNames(messages);
  const out = [];
  for (const m of messages || []) {
    out.push(m);
    if (m?.role !== "user" || !Array.isArray(m.toolsAdded)) continue;
    const defs = [];
    for (const name of m.toolsAdded) {
      if (shown.has(name)) continue;
      const def = defOf(name);
      if (def) { defs.push(def); shown.add(name); }
    }
    if (defs.length) out.push(announcement(defs));
  }
  return out;
}

// The loaded tools neither in the tool list nor announced yet, in the order loaded.
function unannounced(messages, loaded, tools, defOf) {
  const have = new Set((tools || []).map((t) => t.name));
  const shown = announcedNames(messages);
  const out = [];
  for (const name of loaded || []) {
    if (have.has(name) || shown.has(name)) continue;
    const def = defOf(name);
    if (def) { out.push(def); shown.add(name); }
  }
  return out;
}

// Noted on the request's message in the conversation, the newest of theirs.
function record(conversation, names) {
  const entry = (conversation || []).findLast((m) => m?.role === "user");
  if (!entry || !names.length) return;
  entry.toolsAdded = [...new Set([...(Array.isArray(entry.toolsAdded) ? entry.toolsAdded : []), ...names])];
}

module.exports = { isAnnouncement, announcement, announcedNames, withAnnouncements, unannounced, record };
