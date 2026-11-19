// An LLM provider that never answers is asked once more; one still writing
// when the time runs out is not. Twice in a hundred runs a call got nothing
// back for three minutes and the turn ended with "I couldn't get an answer in
// time", everything it had done so far thrown away. The transport tells the
// two apart (nothing at all arrived, against words arriving), and the chat
// asks again only for the first.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const wire = require("../lib/model-wire");

const open = new Set();
const server = http.createServer((req, res) => {
  open.add(res);
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url.startsWith("/never")) return;                      // accepts the request, says nothing
    if (req.url.startsWith("/headers")) return res.writeHead(200, { "Content-Type": "application/json" }), res.flushHeaders();
    res.writeHead(200, { "Content-Type": "text/event-stream" });   // starts writing, then goes quiet
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
  });
});
let base;
const ready = new Promise((r) => server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + server.address().port; r(); }));
test.after(() => { for (const res of open) res.destroy(); server.close(); });
const conn = (kind) => ({ backend: "custom", provider: "stand-in", baseUrl: base + "/" + kind, apiKey: "k" });
const params = { model: "m", max_tokens: 50, messages: [{ role: "user", content: "Hello" }] };
const failure = (promise) => promise.then(() => assert.fail("it should not have answered"), (e) => e);

test("nothing at all by the limit is a stall, whether the reply was to be written out or sent whole", async () => {
  await ready;
  const writtenOut = await failure(wire.request(conn("never"), params, { onText() {}, limitMs: 150 }));
  assert.equal(writtenOut.stalled, true);
  assert.equal(writtenOut.code, "MODEL_STALLED");
  assert.match(writtenOut.message, /timeout/, "and reads as running out of time if asking again fails too");
  const whole = await failure(wire.request(conn("never"), params, { limitMs: 150 }));
  assert.equal(whole.stalled, true);
});

test("a reply that had started is not a stall: its words were arriving when the time ran out", async () => {
  await ready;
  const heard = [];
  const cut = await failure(wire.request(conn("writes"), params, { onText: (t) => heard.push(t), limitMs: 200 }));
  assert.notEqual(cut.stalled, true);
  assert.deepEqual(heard, ["Hel"]);
  const whole = await failure(wire.request(conn("headers"), params, { limitMs: 200 }));
  assert.notEqual(whole.stalled, true, "a whole reply counts from the provider's first line of response");
});

test("a caller's own signal is never a stall", async () => {
  await ready;
  const stopped = await failure(wire.request(conn("never"), params, { signal: AbortSignal.timeout(100) }));
  assert.notEqual(stopped.stalled, true);
});

test("the chat asks once more when the LLM never answered, and only then", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.match(engine, /if \(llmErrFirst\?\.stalled\) \{[\s\S]{0,200}response = await timing\.time\("model again", withinLimit\(\)\); llmErr = null;/);
  assert.match(engine, /const ranOut = llmErr && \/timeout\|timed out\/i\.test/, "a reply that ran out of time while being written is still not sent again");
  assert.match(engine, /190_000/, "the chat waits a little past the transport's limit, so the transport's account arrives");
});
