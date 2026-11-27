// Within one reply the tools and the system prompt stay as its first call
// sent them, so each later step reads the conversation from the provider's
// cache. A tool list that grew midway (the provider's first read from cache
// since a restart widened the room for connected tools) and a system prompt
// that changed midway (a project started, a fact pinned) each sent the whole
// conversation again at full price. Runs the real ask() for an invented
// person, with no network and no database, and an LLM that asks for one tool
// and then answers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

process.env.CTX_STRICT = "off";
function stub(name) {
  const fn = function () { return stub(name + "()"); };
  return new Proxy(fn, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "__esModule") return false;
      if (key === Symbol.iterator) return function* () {};
      return stub(name + "." + String(key));
    },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
}
const root = path.join(__dirname, "..");
const llmFile = path.join(root, "lib/llm.js"), storageFile = path.join(root, "lib/storage.js"), mcpFile = path.join(root, "lib/user-mcp.js");
// A connected notes server of 40 tools, too big to load whole with the first
// call (about 45,000 characters), small enough to load whole once the
// provider is known to cache.
const NOTES = Array.from({ length: 40 }, (_, i) => ({ name: `notes_garden_${String.fromCharCode(97 + (i % 26))}${i}`, description: "Garden notes. " + "Keeps what was planted where. ".repeat(33), input_schema: { type: "object", properties: {} } }));
const sent = [];
let onFirstCall = () => {};
let firstUse = { name: "no_such_tool", input: {} };
const resolve = Module._resolveFilename;
const load = Module._load;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return resolve.call(this, request, parent, ...rest); }
  catch (e) { if (!request.startsWith(".") && !request.startsWith("/")) return "STUB:" + request; throw e; }
};
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (String(resolved).startsWith("STUB:")) return stub(request);
  if (resolved === storageFile) return { ...load.apply(this, arguments), saveStore: () => {} };
  if (resolved === mcpFile) return { ...load.apply(this, arguments), getUserMcpToolDefs: () => NOTES };
  if (resolved === llmFile) {
    const create = async (params) => {
      // The tools it can use: the list, then those announced in the conversation (lib/announced-tools.js).
      const list = (params.tools || []).map((t) => t.name);
      sent.push({ system: params.system.map((b) => b.text).join("\n"), list, tools: [...list, ...require("../lib/announced-tools").announcedNames(params.messages)], messages: params.messages });
      if (sent.length === 1) {
        onFirstCall();
        return { content: [{ type: "tool_use", id: "t1", ...firstUse }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } };
      }
      return { content: [{ type: "text", text: "Your tomatoes are in bed 3." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } };
    };
    return { ...load.apply(this, arguments), resolveUserModel: () => "test-model", getUserLLMClient: () => ({ client: { messages: { create } }, provider: "anthropic" }) };
  }
  return load.apply(this, arguments);
};
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
const ctx = require("../lib/context");
const engine = require("../lib/engine");
Object.assign(console, quiet);

async function reply(userId, said, keepConversation = false) {
  sent.length = 0;
  ctx.activeUserId = userId;
  ctx.activeUserStore = { profile: { display_name: "Sam", settings: { preferred_name: "Sam" }, timezone: "Europe/London" }, connections: {}, facts: {}, userRules: [], goals: [] };
  if (!keepConversation) ctx.store = { conversations: { [userId]: [] }, facts: {}, userRules: [], goals: [] };
  ctx.activePlatform = "web";
  console.log = console.warn = console.error = () => {};
  try { return await engine.ask(userId, said); }
  finally { Object.assign(console, quiet); }
}

test("connected tools are chosen with a reply's first call and kept to its end, though the provider is seen caching midway", async () => {
  onFirstCall = () => {};
  await reply("u-cache-a", "What did I plant in the garden? Check my garden notes");
  assert.ok(sent.length >= 2, "two calls in one reply");
  assert.ok(sent[0].tools.some((n) => n.startsWith("notes_garden_")), "the notes tools the message is about load with the first call");
  assert.deepEqual(sent[1].tools, sent[0].tools, "the same tools on the next step");
  assert.ok(!sent[0].list.some((n) => n.startsWith("notes_garden_")), "announced, not added to the list");
  assert.deepEqual(sent[1].list, sent[0].list, "the list itself never changes");
});

test("the system prompt is built with a reply's first call and kept to its end, though a fact is pinned midway", async () => {
  onFirstCall = () => { ctx.store.facts["family-partner"] = { value: "Sam's partner is Ana Fixture.", category: "person", subject: "Ana Fixture" }; };
  await reply("u-cache-b", "Remember that my partner is Ana Fixture, then tell me about the tomatoes");
  assert.ok(sent.length >= 2, "two calls in one reply");
  assert.equal(sent[1].system, sent[0].system, "the same system prompt on the next step");
});

test("a tool looked up midway is announced after the results, the list unchanged, and a later reply puts it in the same place", async () => {
  onFirstCall = () => {};
  firstUse = { name: "get_tool_details", input: { tool_name: "notes_garden_n39" } };
  try {
    await reply("u-cache-c", "Is it going to rain later?");
    assert.ok(sent.length >= 2, "two calls in one reply");
    assert.ok(!sent[0].tools.includes("notes_garden_n39"), "not loaded before it was looked up");
    assert.deepEqual(sent[1].list, sent[0].list, "the list stays as it was");
    const last = sent[1].messages.at(-1);
    assert.equal(last.role, "system", "announced last, after the results");
    assert.deepEqual(last.content.map((b) => b.tool.definition.name), ["notes_garden_n39"]);
    assert.ok(sent[1].messages.at(-2).content.some((b) => b.type === "tool_result"));
    const conversation = ctx.store.conversations["u-cache-c"];
    assert.ok(conversation[0].toolsAdded.includes("notes_garden_n39"), "noted on the request's message");
    // The next reply starts from the conversation: announced right after that message.
    engine.forgetTurn("u-cache-c", ctx.activeThreadId);
    firstUse = { name: "no_such_tool", input: {} };
    await reply("u-cache-c", "And tomorrow?", true);
    const roles = sent[0].messages.map((m) => m.role);
    assert.deepEqual(roles.slice(0, 3), ["user", "system", "assistant"]);
    assert.ok(sent[0].messages[1].content.some((b) => b.tool.definition.name === "notes_garden_n39"));
    assert.deepEqual(sent[0].list, sent[1].list);
  } finally {
    firstUse = { name: "no_such_tool", input: {} };
  }
});
