// A connected service's job that takes a while (a video, say): Closedhand
// checks it in the background and carries on in the chat when it ends, and a
// file the service gives by link is sent as the file itself. Nothing here is
// any one service's: the stand-ins answer the way video, image and audio APIs
// commonly do. Invented values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const waits = require("../lib/tool-waits");
const { fetchFile } = require("../lib/file-from-link");

const answer = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });

test("whether a job is still going is read from the service's own answer, whatever its words", () => {
  const cases = [
    [{ id: "task-7", status: "PENDING" }, "going"], [{ id: "task-7", status: "RUNNING", progress: 0.4 }, "going"],
    [{ status: "THROTTLED" }, "going"], [{ status: "IN_QUEUE" }, "going"], [{ status: "IN_PROGRESS" }, "going"],
    [{ state: "dreaming" }, "going"], [{ status: "processing" }, "going"], [{ task: { status: "running" } }, "going"],
    [{ status: "SUCCEEDED", output: ["https://cdn.example.net/v/lighthouse.mp4"] }, "done"],
    [{ status: "COMPLETED" }, "done"], [{ state: "completed" }, "done"], [{ status: "succeeded" }, "done"],
    [{ status: "FAILED", failure: "Not enough credits" }, "failed"], [{ status: "cancelled" }, "failed"],
    ["Your video is still processing, check back soon.", "going"],
    ["Done. Download it here: https://cdn.example.net/v/lighthouse.mp4", "done"],
    ["Here is the finished track.", "done"],
  ];
  for (const [said, want] of cases) assert.equal(waits.stateOf(answer(said)), want, JSON.stringify(said));
  assert.equal(waits.stateOf({ isError: true, content: [{ type: "text", text: "boom" }] }), "failed");
  assert.equal(waits.stateOf({ content: [], structuredContent: { status: "queued" } }), "going");
});

// A Closedhand with one connected video service, its settings in memory.
function world({ destructive = false, connected = true } = {}) {
  const settings = {};
  const ended = [], calls = [];
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const deps = {
    now: () => clock,
    settings: async () => JSON.parse(JSON.stringify(settings)),
    keep: async (userId, list) => { if (list.length) settings.tool_waits = list; else delete settings.tool_waits; },
    userMcp: {
      connectionOf: (userId, tool) => (connected && /^kestrel_/.test(tool) ? { rowId: "row-1", tool: tool.replace(/^kestrel_/, ""), server: "Kestrel Video" } : null),
      needsMcpConfirmation: () => destructive,
    },
    finish: async (userId, wait, how, text) => { ended.push({ wait, how, text }); },
  };
  return { settings, ended, calls, deps, advance: (s) => { clock += s * 1000; } };
}

test("a wait is kept only for a connected service's tool that looks, for a chat to carry on in", async () => {
  const w = world();
  const made = await waits.add("u1", { tool: "kestrel_get_task", input: { taskId: "task-7" }, about: "a 5-second video of a lighthouse", every_seconds: 3, give_up_after_minutes: 90, chatId: "chat-1", platform: "whatsapp_linked" }, w.deps);
  assert.equal(made.every, 10, "no more often than every 10 seconds");
  assert.equal(Date.parse(made.until) - Date.parse(made.started), 60 * 60000, "an hour at most");
  assert.deepEqual(w.settings.tool_waits.map((x) => [x.tool, x.server, x.chatId, x.platform]), [["kestrel_get_task", "Kestrel Video", "chat-1", "whatsapp_linked"]]);
  await assert.rejects(waits.add("u1", { tool: "nobody_get", input: {}, about: "x", chatId: "c" }, w.deps), /no connected service has a tool called nobody_get/);
  await assert.rejects(waits.add("u1", { tool: "kestrel_get_task", input: {}, about: "x" }, w.deps), /no chat to carry on in/);
  const acting = world({ destructive: true });
  await assert.rejects(waits.add("u1", { tool: "kestrel_delete_task", input: {}, about: "x", chatId: "c" }, acting.deps), /only a tool that reports on a job can/);
});

test("checked in the background until it ends, then carried on in its chat; a wait added meanwhile is kept", async () => {
  const w = world();
  const said = [{ id: "task-7", status: "PENDING" }, { id: "task-7", status: "RUNNING" }, { id: "task-7", status: "SUCCEEDED", output: ["https://cdn.example.net/v/lighthouse.mp4"] }];
  w.deps.call = async (userId, rowId, tool, args) => {
    w.calls.push([rowId, tool, args]);
    // The person asks for another while this one is being checked.
    if (w.calls.length === 1) await waits.add("u1", { tool: "kestrel_get_task", input: { taskId: "task-8" }, about: "a second video", chatId: "chat-1" }, w.deps);
    return answer(args.taskId === "task-7" ? said.shift() : { id: args.taskId, status: "PENDING" });
  };
  await waits.add("u1", { tool: "kestrel_get_task", input: { taskId: "task-7" }, about: "a 5-second video of a lighthouse", chatId: "chat-1", platform: "web" }, w.deps);
  assert.equal(await waits.tick("u1", w.deps), 0, "not due yet");
  for (let i = 0; i < 3; i++) { w.advance(20); await waits.tick("u1", w.deps); }
  assert.deepEqual(w.calls[0], ["row-1", "get_task", { taskId: "task-7" }], "the service's own tool, with its arguments");
  assert.equal(w.ended.length, 1);
  assert.equal(w.ended[0].how, "done");
  assert.match(w.ended[0].text, /lighthouse\.mp4/);
  assert.deepEqual(w.settings.tool_waits.map((x) => x.input.taskId), ["task-8"], "the wait added during a check survives it");
});

test("a job that fails, runs past its time, or loses its service ends the wait and says why", async () => {
  const failing = world();
  failing.deps.call = async () => answer({ status: "FAILED", failure: "Not enough credits" });
  await waits.add("u1", { tool: "kestrel_get_task", input: { taskId: "t" }, about: "a video", chatId: "c" }, failing.deps);
  failing.advance(20); await waits.tick("u1", failing.deps);
  assert.equal(failing.ended[0].how, "failed");
  assert.match(failing.ended[0].text, /Not enough credits/);

  const slow = world();
  let asked = 0;
  slow.deps.call = async () => { asked++; if (asked === 2) throw new Error("socket hang up"); return answer({ status: "RUNNING" }); };
  await waits.add("u1", { tool: "kestrel_get_task", input: { taskId: "t" }, about: "a video", chatId: "c", give_up_after_minutes: 1 }, slow.deps);
  slow.advance(20); await waits.tick("u1", slow.deps);
  slow.advance(20); await waits.tick("u1", slow.deps);
  assert.equal(slow.ended.length, 0, "a check that fails is tried again");
  slow.advance(30); await waits.tick("u1", slow.deps);
  assert.equal(slow.ended[0].how, "late");
  assert.equal(slow.settings.tool_waits, undefined);
  assert.match(waits.promptFor(slow.ended[0].wait, "late", "RUNNING"), /hasn't finished after 1 minutes, so Closedhand has stopped checking: a video, with Kestrel Video/);

  const gone = world();
  await waits.add("u1", { tool: "kestrel_get_task", input: {}, about: "a video", chatId: "c" }, gone.deps);
  gone.deps.userMcp.connectionOf = () => null;
  gone.advance(20); await waits.tick("u1", gone.deps);
  assert.equal(gone.ended[0].how, "failed");
  assert.equal(gone.ended[0].text, "Kestrel Video isn't connected any more.");
});

// A fetch stand-in: each address answers as listed.
function fakeFetch(pages) {
  return async (url) => {
    const p = pages[url];
    if (!p) throw new Error("unexpected fetch " + url);
    const headers = new Map(Object.entries(p.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: p.status || 200, ok: (p.status || 200) < 300, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, arrayBuffer: async () => p.body || Buffer.alloc(0) };
  };
}

test("a file a service gives by link is fetched as the file, from public addresses only, never a page or too big", async () => {
  const video = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
  const got = await fetchFile("https://api.example.net/out/abc", { fetch: fakeFetch({
    "https://api.example.net/out/abc": { status: 302, headers: { location: "https://cdn.example.net/v/abc?sig=1" } },
    "https://cdn.example.net/v/abc?sig=1": { headers: { "content-type": "video/mp4", "content-disposition": 'attachment; filename="lighthouse.mp4"' }, body: video },
  }) });
  assert.equal(got.name, "lighthouse.mp4");
  assert.equal(got.mimeType, "video/mp4");
  assert.equal(got.buffer.length, video.length);
  const unnamed = await fetchFile("https://cdn.example.net/files/track-41.mp3", { fetch: fakeFetch({ "https://cdn.example.net/files/track-41.mp3": { headers: { "content-type": "application/octet-stream" }, body: Buffer.from("ID3....") } }) });
  assert.deepEqual([unnamed.name, unnamed.mimeType], ["track-41.mp3", "audio/mpeg"], "the kind from its name when the server doesn't say");
  await assert.rejects(fetchFile("https://example.net/watch", { fetch: fakeFetch({ "https://example.net/watch": { headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from("<html>") } }) }), /a web page, not a file/);
  await assert.rejects(fetchFile("https://cdn.example.net/big.mp4", { fetch: fakeFetch({ "https://cdn.example.net/big.mp4": { headers: { "content-type": "video/mp4", "content-length": String(80 * 1048576) } } }) }), /80 MB, more than a chat can take/);
  await assert.rejects(fetchFile("https://cdn.example.net/x", { fetch: fakeFetch({ "https://cdn.example.net/x": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } } }) }), /isn't a public one/);
  await assert.rejects(fetchFile("http://localhost:8080/file.mp4", { fetch: fakeFetch({}) }), /isn't a public one/);
});

test("the model's way in: wait_for_result, send_file by link, and a turn that carries on in the chat", () => {
  const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
  const wait = INTERNAL_TOOLS.find((t) => t.name === "wait_for_result");
  assert.deepEqual(wait.groups, ["connections"]);
  assert.deepEqual(wait.input_schema.required, ["tool", "input", "about"]);
  const send = INTERNAL_TOOLS.find((t) => t.name === "send_file");
  assert.ok(send.input_schema.properties.url, "send_file takes a link");
  assert.equal(send.input_schema.required, undefined, "an attachment id or a link");
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const file = await require\("\.\.\/file-from-link"\)\.fetchFile\(toolInput\.url\);\n\s+await sendDocument\(chatId, file\.buffer, file\.name, file\.mimeType\);/);
  assert.match(handlers, /const wait = await require\("\.\.\/tool-waits"\)\.add\(/);
  // The same check a page address gets, for the link it fetches.
  assert.match(read("lib/outbound-guard.js"), /toolName === "web_fetch" \|\| toolName === "watch_video" \|\| \(toolName === "send_file" && input\.url\)\) add\(input\.url/);
  assert.match(read("lib/scheduling.js"), /async function runScheduledPrompt\(prompt, userId, chatId = null, platform = null, \{ frame = null \} = \{\}\)/);
  assert.match(read("lib/tool-waits.js"), /require\("\.\/one-chat"\)\.keepFiles\(userId, marker, conversation, before\);/, "a file sent as it carries on stays with the conversation");
  assert.match(read("index.js"), /require\("\.\/lib\/tool-waits"\)\.start\(\);/);
});
