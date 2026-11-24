// Connect anything shows only what is about what is in its box. Changed, the
// box clears all the last attempt left under it (status, the key it asked
// for, choices, a scan's findings), and a reply to the last attempt that comes
// back later is let go. A link pasted over all of what was there starts at
// once, as into an empty box. Invented addresses only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dash = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");

function fn(name) {
  const at = dash.indexOf("function " + name + "(");
  assert.ok(at > 0, name);
  let depth = 0, i = dash.indexOf("{", at);
  for (; i < dash.length; i++) { if (dash[i] === "{") depth++; else if (dash[i] === "}" && --depth === 0) break; }
  return dash.slice(at, i + 1);
}

function harness() {
  const els = {
    "mcp-auth-status": { style: { display: "block" }, textContent: "This server asks for a key before it will connect." },
    "mcp-credentials": { style: { display: "block" } },
    "skill-warnings": { style: { display: "block" }, innerHTML: "<div>Warning</div>" },
  };
  const started = [];
  const box = {
    document: { getElementById: (id) => els[id] },
    setTimeout: (f) => f(),
    addMcpConnection: () => started.push("connect"),
    _mcpPending: { input: "https://mcp.example-notes.test/mcp" }, _pendingSkillUrl: null,
  };
  vm.runInNewContext([fn("mcpStatus"), "var _mcpAskedFor = '', _mcpAttempt = 0;", fn("mcpInputChanged"), fn("mcpPaste"), "this.changed = mcpInputChanged; this.paste = mcpPaste; this.state = () => ({ asked: _mcpAskedFor, attempt: _mcpAttempt });", "_mcpAskedFor = 'https://mcp.example-notes.test/mcp'; _mcpAttempt = 4;"].join("\n"), box);
  return { box, els, started };
}

test("the box changed, all the last attempt left under it goes", () => {
  const { box, els } = harness();
  box.changed({ value: "https://mcp.example-notes.test/mcp  " });
  assert.equal(els["mcp-credentials"].style.display, "block", "the same thing, only spaces added: nothing goes");
  box.changed({ value: "https://mcp.example-crm.test/v1" });
  assert.equal(els["mcp-auth-status"].style.display, "none");
  assert.equal(els["mcp-auth-status"].textContent, "");
  assert.equal(els["mcp-credentials"].style.display, "none");
  assert.deepEqual([els["skill-warnings"].style.display, els["skill-warnings"].innerHTML], ["none", ""]);
  assert.equal(box._mcpPending, null, "a key typed next is not sent for the old one");
  assert.deepEqual({ ...box.state() }, { asked: "", attempt: 5 }, "an answer to the old one, coming back later, is let go");
});

test("a link pasted over all of what was there starts at once, as into an empty box", () => {
  const link = (text) => ({ clipboardData: { getData: () => text } });
  const over = (value, start, end, text) => { const { box, started } = harness(); box.paste({ ...link(text), target: { value, selectionStart: start, selectionEnd: end } }); return started.length; };
  assert.equal(over("", 0, 0, "https://mcp.example-crm.test/v1"), 1, "into an empty box");
  assert.equal(over("https://mcp.example-notes.test/mcp", 0, 34, "https://mcp.example-crm.test/v1"), 1, "over all of it");
  assert.equal(over("npx some-server --key ", 22, 22, "https://mcp.example-crm.test/v1"), 0, "added to something still being written: waits for Connect");
  assert.equal(over("", 0, 0, "sk-example-key"), 0, "a key waits for Connect");
});

test("an answer is shown only for the attempt it answers", () => {
  assert.match(fn("connectMcp"), /var attempt = _mcpAttempt;[\s\S]*var data = await res\.json\(\);\n\s*\/\/ [^\n]*\n\s*if \(attempt !== _mcpAttempt\) return;/);
  assert.match(fn("installSkill"), /var attempt = _mcpAttempt;[\s\S]*var data = await res\.json\(\);\n\s*\/\/ [^\n]*\n\s*if \(attempt !== _mcpAttempt\) return;/);
  assert.match(fn("addMcpConnection"), /_mcpAskedFor = input; _mcpAttempt\+\+;\n\n\s*\/\/ A skill link goes to the skill installer/, "a new attempt, skills included");
  assert.match(dash, /oninput="mcpGrowInput\(this\); mcpInputChanged\(this\)"/);
});
