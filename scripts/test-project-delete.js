// A project is deleted from chat only on the person's yes: chat asks first,
// naming what goes and what stays, and the delete itself is turned back
// unless the call is the one their yes ran (lib/confirmation.js marks it),
// so a background task, or a call that claims a yes, deletes nothing. The
// web chat then leaves the deleted project's conversation. Invented names.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
process.env.CTX_STRICT = "off";

test("the delete runs only on the call their yes ran, then the web chat leaves it", async () => {
  const removed = [], pushed = [];
  const projects = { find: async () => ({ id: "p1", emoji: "🏠", name: "House move" }), remove: async (u, id) => { removed.push(id); return true; } };
  const orig = Module._load;
  Module._load = function (req, parent) {
    if (/(^|\/)projects$/.test(req) && parent && /tools[\\/]handlers\.js$/.test(parent.filename)) return projects;
    if (/web-chat-ws$/.test(req)) return { sendToUser: (u, m) => pushed.push(m) };
    return orig.apply(this, arguments);
  };
  try {
    const h = require("../lib/tools/handlers");
    const claimed = await h.handleInternalTool("project_update", { project: "🏠", delete: true, _yes: true, _userId: "u1" });
    assert.match(claimed.error, /needs the person's yes in chat first/, "a call that only says it was agreed to");
    assert.deepEqual(removed, []);
    const asked = { project: "🏠", delete: true, _userId: "u1" };
    h.saidYes(asked);
    const done = await h.handleInternalTool("project_update", asked);
    assert.equal(done.message, "Deleted 🏠 House move, its conversation and its Context Notes. Any files, Pinned Facts or routines created in it stay.");
    assert.deepEqual(removed, ["p1"]);
    assert.deepEqual(pushed, [{ type: "project_gone", id: "p1" }]);
    assert.equal(await h.projectDeleteQuestion("u1", { project: "🏠" }), "Just to confirm:\n\nDelete 🏠 House move, its conversation and its Context Notes? Any files, Pinned Facts or routines created in it stay.\n", "the question in the words the card and page use");
  } finally { Module._load = orig; }
});

test("chat always asks first, and a yes marks the call it runs", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(block\.name === "project_update" && block\.input\?\.delete === true\) needsConfirmation = true;/, "whatever the send setting");
  assert.match(engine, /\} else if \(block\.name === "project_update"\) \{\n\s*confirmSummary = await require\("\.\/tools\/handlers"\)\.projectDeleteQuestion\(userId, block\.input\);/);
  assert.match(read("lib/confirmation.js"), /if \(change\.isInternal\) saidYes\(change\.toolInput\);\n\s*try \{\n\s*result = change\.isInternal \? await handleInternalTool\(change\.toolName, change\.toolInput\)/);
  assert.match(read("lib/tools/definitions.js"), /delete: \{ type: "boolean", description: "true only when they ask to delete it: it goes with its conversation and Context Notes, once they say yes" \}/);
  assert.match(read("webapp/views/index.html"), /if \(msg\.type === 'project_gone'\) \{ if \(window\.projectGone\) window\.projectGone\(msg\.id\); return; \}/);
});
