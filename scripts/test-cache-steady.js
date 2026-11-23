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
      sent.push({ system: params.system.map((b) => b.text).join("\n"), tools: (params.tools || []).map((t) => t.name) });
      if (sent.length === 1) {
        onFirstCall();
        return { content: [{ type: "tool_use", id: "t1", name: "no_such_tool", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } };
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

async function reply(userId, said) {
  sent.length = 0;
  ctx.activeUserId = userId;
  ctx.activeUserStore = { profile: { display_name: "Sam", settings: { preferred_name: "Sam" }, timezone: "Europe/London" }, connections: {}, facts: {}, userRules: [], goals: [] };
  ctx.store = { conversations: { [userId]: [] }, facts: {}, userRules: [], goals: [] };
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
});

test("the system prompt is built with a reply's first call and kept to its end, though a fact is pinned midway", async () => {
  onFirstCall = () => { ctx.store.facts["family-partner"] = { value: "Sam's partner is Ana Fixture.", category: "person", subject: "Ana Fixture" }; };
  await reply("u-cache-b", "Remember that my partner is Ana Fixture, then tell me about the tomatoes");
  assert.ok(sent.length >= 2, "two calls in one reply");
  assert.equal(sent[1].system, sent[0].system, "the same system prompt on the next step");
});
