// A reply asked for as it is written (lib/model-wire.js, options.onText): the
// answer's words are handed on as they arrive, and what request() returns is
// the same whole reply as when it is asked for in one piece, for every kind of
// provider. Each stand-in speaks its provider's documented stream.
// Run: node --test scripts/test-reply-as-written.js
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const wire = require("../lib/model-wire");

// What each stand-in says: words, a tool call, what it thought, as the scenario asks.
const WORDS = "The 14:05 from Fixture Halt is the one to take — it gets in at 15:40.\n\nShall I book it?";
const TOOL = { name: "find_trains", input: { from: "Fixture Halt", to: "Sample Junction", after: "14:00" } };
const cut = (text, n) => text.match(new RegExp(`[\\s\\S]{1,${n}}`, "g"));
const sse = (events) => events.map((e) => (e.event ? `event: ${e.event}\n` : "") + "data: " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data)) + "\n\n").join("");

function openai(body, scenario) {
  const tools = scenario.includes("tool"), think = scenario.includes("think"), details = scenario.includes("details");
  const text = (think ? "<think>working it out</think>\n\n" : "") + (tools && !scenario.includes("words") ? "" : WORDS);
  const call = { id: "call_7", type: "function", function: { name: TOOL.name, arguments: JSON.stringify(TOOL.input) } };
  const usage = { prompt_tokens: 40, completion_tokens: 21, total_tokens: 61, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 5 } };
  const whole = { id: "chatcmpl-9", model: body.model, choices: [{ index: 0, finish_reason: tools ? "tool_calls" : scenario.includes("long") ? "length" : "stop", message: { role: "assistant", content: text,
    ...(scenario.includes("reasoned") ? { reasoning_content: "First the timetable, then the fare." } : {}),
    ...(details ? { reasoning_details: [{ type: "reasoning.text", text: "Compare the two trains.", signature: "sig-1", format: "anthropic-claude-v1", index: 0 }, { type: "reasoning.encrypted", data: "b3BhcXVl", id: "rs_2", format: "openai-responses-v1", index: 1 }] } : {}),
    ...(tools ? { tool_calls: [call] } : {}) } }], usage };
  if (!body.stream) return { json: whole };
  const piece = (delta, finish = null) => ({ id: whole.id, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const events = [{ data: piece({ role: "assistant", content: "" }) }];
  if (scenario.includes("reasoned")) for (const part of cut("First the timetable, then the fare.", 9)) events.push({ data: piece({ reasoning_content: part }) });
  if (details) {
    for (const part of cut("Compare the two trains.", 8)) events.push({ data: piece({ reasoning_details: [{ type: "reasoning.text", text: part, format: "anthropic-claude-v1", index: 0 }] }) });
    events.push({ data: piece({ reasoning_details: [{ type: "reasoning.text", text: "", signature: "sig-1", format: "anthropic-claude-v1", index: 0 }] }) });
    events.push({ data: piece({ reasoning_details: [{ type: "reasoning.encrypted", data: "b3Bh", id: "rs_2", format: "openai-responses-v1", index: 1 }] }) });
    events.push({ data: piece({ reasoning_details: [{ type: "reasoning.encrypted", data: "cXVl", id: "rs_2", format: "openai-responses-v1", index: 1 }] }) });
  }
  for (const part of text ? cut(text, 5) : []) events.push({ data: piece({ content: part }) });
  if (tools) {
    events.push({ data: piece({ tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }) });
    for (const part of cut(call.function.arguments, 11)) events.push({ data: piece({ tool_calls: [{ index: 0, function: { arguments: part } }] }) });
  }
  if (!scenario.includes("cut")) events.push({ data: piece({}, whole.choices[0].finish_reason) }, { data: { id: whole.id, model: body.model, choices: [], usage } }, { data: "[DONE]" });
  return { stream: sse(events) };
}

function anthropic(body, scenario) {
  const tools = scenario.includes("tool");
  const content = [{ type: "thinking", thinking: "Two trains; the later one connects.", signature: "sig-A" }, { type: "text", text: WORDS },
    ...(tools ? [{ type: "tool_use", id: "toolu_7", name: TOOL.name, input: TOOL.input }, { type: "tool_use", id: "toolu_8", name: "no_arguments", input: {} }] : [])];
  const whole = { id: "msg_9", type: "message", role: "assistant", model: body.model, content, stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 40, cache_read_input_tokens: 8, cache_creation_input_tokens: 0, output_tokens: 21 } };
  if (!body.stream) return { json: whole };
  const ev = (type, more) => ({ event: type, data: { type, ...more } });
  const events = [ev("message_start", { message: { ...whole, content: [], stop_reason: null, usage: { input_tokens: 40, cache_read_input_tokens: 8, cache_creation_input_tokens: 0, output_tokens: 1 } } }), ev("ping", {})];
  content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push(ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }));
      for (const part of cut(block.thinking, 10)) events.push(ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: part } }));
      events.push(ev("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }));
    } else if (block.type === "text") {
      events.push(ev("content_block_start", { index, content_block: { type: "text", text: "" } }));
      for (const part of cut(block.text, 6)) events.push(ev("content_block_delta", { index, delta: { type: "text_delta", text: part } }));
    } else {
      events.push(ev("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
      for (const part of Object.keys(block.input).length ? cut(JSON.stringify(block.input), 12) : []) events.push(ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: part } }));
    }
    events.push(ev("content_block_stop", { index }));
  });
  if (scenario.includes("overloaded")) events.push(ev("error", { error: { type: "overloaded_error", message: "Overloaded" } }));
  else if (!scenario.includes("cut")) events.push(ev("message_delta", { delta: { stop_reason: whole.stop_reason, stop_sequence: null }, usage: { output_tokens: 21 } }), ev("message_stop", {}));
  return { stream: sse(events) };
}

function gemini(streaming, scenario) {
  const tools = scenario.includes("tool");
  const parts = [{ text: "Weighing the two trains.", thought: true }, { text: WORDS, thoughtSignature: "sig-G" }, ...(tools ? [{ functionCall: { name: TOOL.name, args: TOOL.input }, thoughtSignature: "sig-F" }] : [])];
  const usageMetadata = { promptTokenCount: 40, candidatesTokenCount: 16, thoughtsTokenCount: 5, cachedContentTokenCount: 8 };
  if (!streaming) return { json: { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata } };
  const event = (ps, finishReason) => ({ data: { candidates: [{ content: { role: "model", parts: ps }, ...(finishReason ? { finishReason } : {}) }], usageMetadata } });
  const texts = cut(WORDS, 9);
  const events = [event([{ text: "Weighing the ", thought: true }]), event([{ text: "two trains.", thought: true }]),
    ...texts.slice(0, -1).map((t) => event([{ text: t }])), event([{ text: texts.at(-1), thoughtSignature: "sig-G" }]),
    ...(tools ? [event([parts[2]])] : [])];
  if (!scenario.includes("cut")) events.push(event([], "STOP"));
  return { stream: sse(events) };
}

const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), url = new URL(req.url, "http://localhost");
    const kind = url.pathname.split("/")[1], scenario = kind === "gm" ? decodeURIComponent(url.pathname.split("/models/")[1].split(":")[0]) : String(body.model);
    seen.push({ kind, scenario, body, url: req.url });
    if (scenario.includes("refuses") && (body.stream || /streamGenerateContent/.test(req.url))) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "stream is not supported here" } })); }
    const out = kind === "oa" ? openai(body, scenario) : kind === "an" ? anthropic(body, scenario) : gemini(/streamGenerateContent/.test(req.url), scenario);
    if (out.json) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(out.json)); }
    // In slices that fall anywhere, as a network delivers them.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const bytes = Buffer.from(out.stream);
    (function next(at) { if (at >= bytes.length) return res.end(); res.write(bytes.subarray(at, at + 37)); setImmediate(() => next(at + 37)); })(0);
  });
});
let base;
const ready = new Promise((r) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; r(); }));
test.after(() => server.close());

const conns = () => ({
  oa: { backend: "custom", provider: "stand-in", baseUrl: base + "/oa", apiKey: "k" },
  an: { backend: "anthropic", provider: "stand-in", baseUrl: base + "/an", apiKey: "k" },
  gm: { backend: "gemini", provider: "stand-in", baseUrl: base + "/gm", apiKey: "k" },
});
const params = (model) => ({ model, max_tokens: 500, system: "You plan journeys.", messages: [{ role: "user", content: "Which train?" }],
  tools: [{ name: TOOL.name, description: "Finds trains", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, after: { type: "string" } } } }] });
// Ids Closedhand makes up itself differ between two replies; everything else must not.
const settled = (reply) => JSON.parse(JSON.stringify(reply, (k, v) => (k === "id" && /^toolu_[a-z0-9]{6,}$/.test(v) && v !== "toolu_7" && v !== "toolu_8" ? "toolu_made" : v)));
async function both(kind, model) {
  await ready;
  const heard = [];
  const written = await wire.request(conns()[kind], params(model), { onText: (t) => heard.push(t) });
  const whole = await wire.request(conns()[kind], params(model));
  return { heard, written, whole };
}

for (const [kind, name, models] of [["oa", "an OpenAI-compatible provider", ["plain", "tool", "words-tool", "reasoned", "details-tool", "long"]], ["an", "Anthropic", ["plain", "tool"]], ["gm", "Gemini", ["plain", "tool"]]]) {
  test(`${name}: the words arrive as written, and the reply is the same as when asked for whole`, async () => {
    for (const model of models) {
      const { heard, written, whole } = await both(kind, model);
      assert.deepEqual(settled(written), settled(whole), `${model}: the same reply either way`);
      const words = kind === "oa" && model.includes("tool") && !model.includes("words") ? "" : WORDS;
      assert.equal(heard.join(""), words, `${model}: every word handed on, in order, and nothing else`);
      if (words) assert.ok(heard.length > 3, `${model}: a few at a time`);
      if (model.includes("tool")) assert.deepEqual(written.content.find((b) => b.type === "tool_use").input, TOOL.input, `${model}: a tool's arguments put back together`);
    }
    const asked = seen.filter((s) => s.kind === kind);
    if (kind === "oa") assert.deepEqual(asked[0].body.stream_options, { include_usage: true }, "so the last piece says what the reply used");
    if (kind === "gm") assert.match(asked[0].url, /:streamGenerateContent\?alt=sse$/);
    assert.ok(asked.some((s) => !s.body.stream && !/streamGenerateContent/.test(s.url)), "asked for whole when nobody is listening");
  });
}

test("what a model thinks aloud between think tags is never handed on, wherever the tags fall", async () => {
  const { heard, written } = await both("oa", "think");
  assert.equal(heard.join("").trim(), WORDS);
  assert.doesNotMatch(heard.join(""), /think|working it out/);
  assert.equal(written.content.find((b) => b.type === "text").text, WORDS);
});

test("a reply that stops part way is no reply, for any provider", async () => {
  await ready;
  for (const kind of ["oa", "an", "gm"]) await assert.rejects(wire.request(conns()[kind], params("cut"), { onText: () => {} }), { code: "reply_cut_short" }, kind);
  await assert.rejects(wire.request(conns().an, params("overloaded"), { onText: () => {} }), { status: 529 });
});

test("a provider that will not write its reply out is asked for it whole, then and from then on; a listener that throws stops nothing", async () => {
  await ready;
  for (const kind of ["oa", "an", "gm"]) {
    seen.length = 0;
    const heard = [];
    const first = await wire.request(conns()[kind], params("refuses"), { onText: (t) => heard.push(t) });
    assert.equal(first.content.find((b) => b.type === "text").text, WORDS, kind);
    assert.deepEqual([seen.length, heard.length], [2, 0], `${kind}: once written out and refused, once whole`);
    await wire.request(conns()[kind], params("refuses"), { onText: (t) => heard.push(t) });
    assert.equal(seen.length, 3, `${kind}: not asked to write it out again`);
    const reply = await wire.request(conns()[kind], params("plain"), { onText: () => { throw new Error("the listener tripped"); } });
    assert.equal(reply.content.find((b) => b.type === "text").text, WORDS, kind);
  }
});
