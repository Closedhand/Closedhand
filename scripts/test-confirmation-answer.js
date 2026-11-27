const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load just confirmationAnswer from lib/confirmation.js (its requires pull in the whole bot).
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "confirmation.js"), "utf8");
const start = src.indexOf("const YES_CORE");
const end = src.indexOf("async function handleConfirmation");
const sandbox = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.confirmationAnswer = confirmationAnswer;", sandbox);
const answer = sandbox.confirmationAnswer;

test("a natural yes to a send confirmation counts as yes", () => {
  for (const reply of ["yes", "Yes.", "Yes, send it.", "yes please", "OK, go ahead!", "send it", "Do it", "yep", "y", "Sure"]) {
    assert.equal(answer(reply), "yes", reply);
  }
});

test("a natural no counts as no", () => {
  for (const reply of ["no", "No.", "No thanks", "don't send it", "Do not send it", "cancel", "never mind", "not now", "n"]) {
    assert.equal(answer(reply), "no", reply);
  }
});

test("anything more than a plain answer is not an answer", () => {
  for (const reply of ["yes but change the subject", "send it to Sam instead", "yes no", "what does it say?", "", "ok but first check the date please"]) {
    assert.equal(answer(reply), null, reply);
  }
});

test("only a bare always approves a place for good", () => {
  assert.equal(answer("always"), "always");
  assert.equal(answer("Always."), "always");
  assert.equal(answer("yes always"), "yes");
});

// A yes is written and answered for what it was to: a yes to letting a
// command reach a site was written "Yes, send it." and answered "Sending it
// now." when nothing was being sent.
test("a yes says what it was to", () => {
  const box = {};
  vm.runInNewContext(src.slice(start, end) + "\nthis.yesTo = yesTo;", box);
  assert.equal(box.yesTo({ toolName: "gmail_send" }, "yes"), "send it");
  assert.equal(box.yesTo({ toolName: "sandbox_exec", outbound: { host: "cdn.example.com" } }, "yes"), "let it reach cdn.example.com");
  assert.equal(box.yesTo({ toolName: "sandbox_exec", outbound: { host: "cdn.example.com" } }, "always"), "always trust cdn.example.com");
  assert.equal(box.yesTo({ toolName: "gcal_update_event" }, "yes"), "go ahead");
  assert.equal(box.yesTo({ toolName: "api_request", spend: { ledgerId: "l1" } }, "yes"), "pay for it");
  const agents = fs.readFileSync(path.join(__dirname, "..", "lib", "agents.js"), "utf8");
  assert.match(agents, /if \(what === "send it"\) return approved \? "Sending it now\." : "OK, I won't send it\.";/);
  assert.match(agents, /return approved \? "Doing it now\." : "OK, I won't do it\.";/);
});

// The card offers "always"; a person who said yes and then "always" means
// trust the site from now on. It came as a new message, and the chat asked
// what "always" meant.
test("'always' just after a yes to a site trusts it from now on", async () => {
  const approved = [], said = [];
  const box = { ctx: { recentOutboundYes: {}, activeUserStore: { userId: "u1" } }, Date,
    getConversation: () => ({ push: (...m) => said.push(...m) }), saveStore: () => {},
    require: (m) => (m === "./outbound-guard" ? { approveHost: async (store, host) => approved.push(host) } : {}) };
  vm.runInNewContext(src.slice(start, end) + "\nthis.alwaysAfterYes = alwaysAfterYes;", box);
  assert.equal(await box.alwaysAfterYes("u1", "always"), null, "nothing said yes to");
  box.ctx.recentOutboundYes.u1 = { host: "cdn.example.com", at: Date.now() };
  assert.equal(await box.alwaysAfterYes("u1", "always do that thing"), null, "only a plain always");
  const reply = await box.alwaysAfterYes("u1", "Always");
  assert.match(reply, /^OK, I'll trust cdn\.example\.com from now on/);
  assert.deepEqual(approved, ["cdn.example.com"]);
  assert.equal(await box.alwaysAfterYes("u1", "always"), null, "once");
  box.ctx.recentOutboundYes.u1 = { host: "old.example.com", at: Date.now() - 11 * 60 * 1000 };
  assert.equal(await box.alwaysAfterYes("u1", "always"), null, "not long after");
  const confirmation = src;
  assert.match(confirmation, /\} else if \(isYes && pending\.outbound && pending\.outbound\.host\) \{\n\s*ctx\.recentOutboundYes = ctx\.recentOutboundYes \|\| \{\};/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8"), /const trusted = await require\("\.\/confirmation"\)\.alwaysAfterYes\(userId, String\(userMessage\)\)/);
});
