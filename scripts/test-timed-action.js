// A step fixed in advance is made at its exact moment by code. "Order the cab
// in three minutes" set as a task woke an LLM at the moment, which acted a
// minute or more late; done at once it was early, and reported as on time.
// Fixed, the call is checked and put to the person now, and made on the
// second. And any one-off now keeps its exact moment, counted from when the
// person asked: a cron line only says the minute.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const timed = require("../lib/timed-action");

test("the moment is counted from when they asked, to the second", () => {
  const asked = Date.parse("2026-03-04T12:00:40Z"), now = asked + 15000;
  assert.equal(timed.moment({ in_minutes: 3 }, { now, askedAt: asked }).when.toISOString(), "2026-03-04T12:03:40.000Z");
  assert.equal(timed.moment({ in_minutes: 0.5 }, { now: asked + 5000, askedAt: asked }).when.toISOString(), "2026-03-04T12:01:10.000Z", "thirty seconds is thirty seconds");
  assert.equal(timed.moment({ in_minutes: 3 }, { now }).when.getTime(), now + 180000, "with no request to count from, from now");
  assert.equal(timed.moment({ in_minutes: 3 }, { now, askedAt: now - 3 * 3600000 }).when.getTime(), now + 180000, "a request hours old is not what 'in three minutes' meant");
  assert.match(timed.moment({ in_minutes: 1 }, { now: asked + 90000, askedAt: asked }).error, /already passed/, "one whose moment went by while they were deciding says so");
  assert.match(timed.moment({ in_minutes: 0 }, { now }).error, /between 0\.1 and 1440/);
  assert.equal(timed.moment({ run_at: "2026-03-04T15:00:00+01:00" }, { now }).when.toISOString(), "2026-03-04T14:00:00.000Z");
  assert.match(timed.moment({ run_at: "2026-03-01T15:00:00+01:00" }, { now }).error, /in the past/);
  assert.equal(timed.moment({}, { now }).when, null);
});

test("only a step that is safe to agree to ahead of time can be fixed", () => {
  const isConnected = (n) => n.startsWith("umcp_");
  assert.equal(timed.refusal({ tool_name: "umcp_office_cabs_order_ride", tool_input: { to: "Station" } }, { isConnected }), null);
  assert.equal(timed.refusal({ tool_name: "gmail_send", tool_input: {} }, { isConnected }), null);
  assert.equal(timed.refusal({ tool_name: "gcal_delete_event", tool_input: {} }, { isConnected }), null);
  for (const name of ["sandbox_browse", "api_request", "sandbox_gateway", "sandbox_exec", "add_schedule", "agent_start", "bridge_shell_run", "disconnect_service"]) {
    assert.match(timed.refusal({ tool_name: name, tool_input: {} }, { isConnected }), /cannot be fixed in advance/, name);
  }
  assert.match(timed.refusal({ tool_input: {} }, { isConnected }), /needs tool_name/);
  assert.match(timed.refusal({ tool_name: "gmail_send", tool_input: "x" }, { isConnected }), /as an object/);
  assert.equal(timed.wanted({ type: "tool_use", name: "add_schedule", input: { name: "Cab", action: { tool_name: "t", tool_input: {} } } }).tool_name, "t");
  assert.equal(timed.wanted({ type: "tool_use", name: "add_schedule", input: { name: "Call mum", prompt: "Remind me" } }), null);
  assert.equal(timed.wanted({ type: "tool_use", name: "gmail_send", input: { action: { tool_name: "t" } } }), null);
});

test("its card says it is for later, and the line after says what happened", () => {
  const card = timed.cardFor('Just to confirm:\n\nSend email (Gmail)\nTo: dana@harbour.test\n\nReply "yes" to confirm or "no" to cancel.', new Date("2026-03-04T09:00:00Z"), "Europe/London");
  assert.match(card, /^Set for Wed,? 4 Mar,? 09:00:00, not done now\.\n\nJust to confirm:/);
  assert.equal(timed.line({ name: "Order the cab" }, { ok: true }, Date.parse("2026-03-04T12:03:40Z"), "Europe/London"), "Done at 12:03: Order the cab.");
  assert.equal(timed.line({ name: "Order the cab" }, { ok: false, error: "You have an on-going ride." }, Date.parse("2026-03-04T12:03:40Z"), "Europe/London"), "I couldn't do this at 12:03: Order the cab. You have an on-going ride.");
});

test("the scheduler waits for a one-off's exact second, and makes a fixed step ahead of its turn in the chat", () => {
  const scheduling = read("lib/scheduling.js");
  assert.match(scheduling, /const exact = schedule\.run_once !== false && schedule\.run_at \? Date\.parse\(schedule\.run_at\) - Date\.now\(\) : NaN;\n\s+if \(Number\.isFinite\(exact\) && exact > 0 && exact < EXACT_WITHIN_MS\) \{\n\s+const timer = setTimeout\(\(\) => fire\(schedule\), exact\);/);
  const made = scheduling.indexOf("fixedDone = { at, outcome };"), turn = scheduling.indexOf("await acquireUserMutex(targetUserId");
  assert.ok(made > 0 && made < turn, "made before it waits its turn behind a reply still being written");
  assert.match(scheduling, /if \(!late && schedule\.kind === "task" && schedule\.action\) \{/, "one whose moment was missed is asked about, like any task");
  assert.match(scheduling, /if \(!\(schedule\.action\.quiet === true && outcome\.ok\)\) await require\("\.\/messaging"\)\.sendToPlatform/, "a failure is always told");
  assert.match(read("migrations/093_schedule_exact_action.sql"), /ADD COLUMN IF NOT EXISTS run_at timestamptz;[\s\S]*ADD COLUMN IF NOT EXISTS action jsonb;/);
  const store = read("user-store.js");
  assert.match(store, /run_at: exact\.runAt \|\| null, action: exact\.action \|\| null/);
  assert.match(store, /kind, created_at, last_run, run_at, action"\)/);
});

test("the chat puts a fixed step through the step's own checks and card, and sets it instead of doing it", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const later = asked\.type === "tool_use" \? timedAction\.wanted\(asked\) : null;\n\s+const block = later \? \{ \.\.\.asked, name: String\(later\.tool_name \|\| ""\), input:/);
  assert.match(engine, /if \(block\.later && alone\) \{[\s\S]{0,400}cannot be fixed in advance/, "a payment or data leaving cannot be fixed ahead");
  assert.match(engine, /card: block\.later \? timedAction\.cardFor\(card, block\.at,/);
  assert.match(engine, /const call = c\.block\.later \|\| c\.block;/, "a yes sets it for its moment rather than doing it now");
  assert.match(engine, /if \(block\.later\) \{\n\s+toolsUsed\.add\("add_schedule"\);[\s\S]{0,300}handleInternalTool\("add_schedule", \{ \.\.\.block\.later\.input,/);
  assert.match(engine, /ctx\.requestAt = opts\.resume\?\.requestAt \|\| responseStartTime;/);
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /timedAction\.moment\(toolInput, \{ askedAt: ctx\.requestAt \|\| null \}\)/);
  assert.match(handlers, /It has NOT been done yet: say it is set for then, never that it is done\./);
  assert.match(read("lib/confirmation.js"), /ctx\.requestAt = pending\.requestAt \|\| null;/);
});

test("making the call: the same call the chat makes after a yes, and a failure is a failure", async () => {
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const calls = [];
  stub("../lib/tools/handlers", { isInternalTool: (n) => n === "gmail_send", handleInternalTool: async (n, i) => { calls.push(["own", n, i]); return { success: true }; } });
  stub("../lib/mcp", { callMCPTool: async (n, i) => { calls.push(["mcp", n, i]); return n.endsWith("fails") ? { error: "You have an on-going ride." } : { content: [{ type: "text", text: "BOOKED" }] }; } });
  const who = { userId: "u1", chatId: "c1", platform: "web" };
  assert.equal((await timed.run({ action: { tool_name: "umcp_office_cabs_order_ride", tool_input: { to: "Station" } } }, who)).ok, true);
  assert.deepEqual(calls[0], ["mcp", "umcp_office_cabs_order_ride", { to: "Station", _userId: "u1", _chatId: "c1", _platform: "web" }]);
  const failed = await timed.run({ action: { tool_name: "umcp_office_cabs_fails", tool_input: {} } }, who);
  assert.deepEqual([failed.ok, failed.error], [false, "You have an on-going ride."]);
  assert.equal((await timed.run({ action: { tool_name: "gmail_send", tool_input: { to: "dana@harbour.test" } } }, who)).ok, true);
  assert.equal(calls[2][0], "own");
});
