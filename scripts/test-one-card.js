// One card for a step: the changes in it that each wait for the person's yes
// go on the same card, numbered, and one yes does them all. Asked one by one,
// "clear my Friday" took six yeses, each with a round of the LLM between.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { together, body } = require("../lib/confirm-card");

const DELETE = 'Just to confirm:\n\nDelete Google Calendar event: Pottery class\nWhen: Fri 6 Mar, 18:00\n\nReply "yes" to confirm or "no" to cancel.';
const RUN = 'Just to confirm, I\'m about to run calendar_delete_event on office:\n\nevent_id: ev_81\n\nReply "yes" to confirm or "no" to cancel.';
const SEND = 'I\'m about to send a WhatsApp message. Reply "yes" to send it or "no" to skip.\n\nTo: Dana\n\nRunning ten minutes late';

test("a single change keeps its card word for word", () => {
  assert.equal(together([DELETE]), DELETE);
  assert.equal(together([]), "");
});

test("several changes go on one card, numbered, each without its own question", () => {
  const card = together([DELETE, RUN, SEND]);
  assert.match(card, /^Just to confirm, 3 things:\n\n1\. Delete Google Calendar event: Pottery class\nWhen: Fri 6 Mar, 18:00\n\n2\. Run calendar_delete_event on office:\n\nevent_id: ev_81\n\n3\. Send a WhatsApp message\.\n\nTo: Dana\n\nRunning ten minutes late\n\nReply "yes" to do all 3, or "no" to cancel them\.$/);
  assert.equal((card.match(/Reply "yes"/g) || []).length, 1, "one question for the card");
  assert.equal(body(SEND).includes('Reply "yes"'), false);
});

function loadConfirmation(pending, fail = null) {
  const ran = [], asked = [];
  const ctx = { pendingConfirmations: { u1: pending }, activePlatform: "web" };
  const deps = {
    "./context": ctx, "./storage": { saveStore() {} }, "./conversation": { getConversation: () => [] },
    "./tools/handlers": { handleInternalTool: async (name, input) => { ran.push(["own", name, input.event_id]); return { success: true }; } },
    "./mcp": { callMCPTool: async (name, input) => { ran.push(["mcp", name, input.event_id]); if (fail === input.event_id) throw new Error("the server said no"); return { content: [{ type: "text", text: "deleted " + input.event_id }] }; } },
    "./spend-guard": { ledgerUpdate: async () => {} }, "./messaging": { sendTyping() {} },
    "./confirmation-lifetime": require("../lib/confirmation-lifetime"),
    "./engine": { ask: async (...args) => { asked.push(args); return "Done."; } },
  };
  const context = { module: { exports: {} }, console: { log() {} }, Date, JSON, Array, require: (name) => { if (!(name in deps)) throw Error(name); return deps[name]; } };
  vm.runInNewContext(read("lib/confirmation.js"), context);
  return { ...context.module.exports, ctx, ran, asked };
}

const change = (id, toolName, isInternal) => ({ toolName, toolUseId: "tu-" + id, isInternal, toolInput: { event_id: id, _userId: "u1", _chatId: "c", _platform: "web" } });
const card = () => {
  const batch = [change("a", "umcp_office_calendar_delete_event", false), change("b", "umcp_office_calendar_delete_event", false), change("c", "gcal_delete_event", true)];
  return { askedAt: Date.now(), ...batch[0], batch, request: "Clear my Friday", turnContext: "CTX",
    messages: [{ role: "user", content: "Clear my Friday" }, { role: "assistant", content: [] }],
    otherToolResults: [{ type: "tool_result", tool_use_id: "tu-read", content: "{}" }] };
};

test("one yes does every change on the card, in order, and the turn carries on with all their results", async () => {
  const c = loadConfirmation(card());
  assert.equal(await c.handleConfirmation("u1", "c", "yes"), "Done.");
  assert.deepEqual(c.ran, [["mcp", "umcp_office_calendar_delete_event", "a"], ["mcp", "umcp_office_calendar_delete_event", "b"], ["own", "gcal_delete_event", "c"]]);
  const opts = c.asked[0][5];
  assert.equal(opts.resume.messages.at(-1).content.map((b) => b.tool_use_id).join(" "), "tu-read tu-a tu-b tu-c");
  assert.equal(opts.resume.turnContext, "CTX");
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
});

test("one no declines them all and runs none", async () => {
  const c = loadConfirmation(card());
  await c.handleConfirmation("u1", "c", "no");
  assert.equal(c.ran.length, 0);
  const results = c.asked[0][5].resume.messages.at(-1).content.slice(1);
  assert.equal(results.length, 3);
  for (const r of results) assert.match(r.content, /"declined":true/);
});

test("one of several failing does not lose the others", async () => {
  const c = loadConfirmation(card(), "b");
  await c.handleConfirmation("u1", "c", "yes");
  assert.equal(c.ran.length, 3, "the one after the failure still runs");
  const results = c.asked[0][5].resume.messages.at(-1).content;
  assert.match(results[2].content, /the server said no/);
  assert.match(results[3].content, /"success":true/);
});

test("the chat collects a step's changes before it asks, and pauses whatever follows them", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const cardBatch = \[\];\n\s+for \(const asked of response\.content\) \{/);
  assert.match(engine, /cardBatch\.push\(\{ block, card: [^\n]*spendPlan, outboundPlan, projectNews \}\);[\s\S]{0,260}if \(alone\) break;\n\s+continue;/);
  assert.match(engine, /if \(needsConfirmation && alone && cardBatch\.length\) continue;/, "a payment or data leaving keeps a card of its own");
  assert.match(engine, /const alone = !!\(spendPlan \|\| outboundPlan \|\| browserSendAt \|\| block\.name === "delegate_email_thread"/);
  assert.ok(engine.indexOf("if (cardBatch.length) continue;\n\n") > 0 && engine.indexOf("if (cardBatch.length) continue;\n\n") < engine.indexOf("            if (isInternalTool(block.name)) {\n              toolsUsed.add(block.name);"), "nothing runs past a change that is waiting");
  assert.match(engine, /batch: cardBatch\.length > 1 \? cardBatch\.map\(held\) : null,/);
  assert.match(engine, /require\("\.\/confirm-card"\)\.together\(cardBatch\.map\(\(c\) => c\.card\)\)/);
});

test("a background job puts a step's connected-server actions on one card too, and one answer covers them", () => {
  const ask = (what) => `I'm about to run ${what} on office:\n\nevent_id: e1\n\nReply "yes" to go ahead or "no" to skip it.`;
  const card = together([ask("calendar_delete_event"), ask("calendar_delete_event"), ask("contacts_delete_contact")]);
  assert.match(card, /^Just to confirm, 3 things:\n\n1\. Run calendar_delete_event on office:\n\nevent_id: e1\n\n2\. Run calendar_delete_event/);
  assert.equal((card.match(/Reply "yes"/g) || []).length, 1);
  const agents = read("lib/agents.js");
  assert.match(agents, /if \(pendingSend\._plain && !sendAt\) \{ \(pendingSend\._with = pendingSend\._with \|\| \[\]\)\.push\(\{ block, question \}\); continue; \}/);
  assert.match(agents, /require\("\.\/confirm-card"\)\.together\(together\.map\(\(t\) => t\.question\)\)/);
  assert.match(agents, /batch: together \? together\.map\(\(t\) => \(\{ toolName: t\.block\.name, toolInput: t\.block\.input, toolUseId: t\.block\.id, isInternal: isInternalTool\(t\.block\.name\) \}\)\) : null,/);
  assert.match(agents, /if \(Array\.isArray\(pending\.batch\) && pending\.batch\.length\) \{[\s\S]{0,1200}return approved \? "Doing those now\." : "OK, I won't do those\.";/);
});
