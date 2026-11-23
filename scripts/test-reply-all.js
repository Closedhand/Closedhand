// A reply copies everyone else on the email, as Reply all does, in every
// mailbox, unless Closedhand is asked to answer the sender alone or names its
// own Cc. A reply drafted to the sender alone left three people off a
// supplier's order thread, the chat had said one of them was copied, and the
// card before sending named no Cc. Invented people and addresses only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const handlers = read("lib/tools/handlers.js");
const fnSrc = (name) => {
  const a = handlers.search(new RegExp(`(async )?function ${name}\\(`));
  return handlers.slice(a, handlers.indexOf("\n}\n", a) + 2);
};
const othersOnMail = new Function(fnSrc("othersOnMail") + "\nreturn othersOnMail;")();
const replyCc = new Function("othersOnMail", fnSrc("replyCc") + "\nreturn replyCc;")(othersOnMail);
const gmailFrom = async () => { throw new Error("not used"); };
const sendHeadersFor = new Function("gmailFrom", "replyCc", fnSrc("sendHeadersFor") + "\nreturn sendHeadersFor;")(gmailFrom, replyCc);

const ORDER = [
  { name: "Subject", value: "Spring stock list" },
  { name: "From", value: "Rosa Fixture <rosa@shop.example>" },
  { name: "To", value: "Sam Example <sam@mine.example>, \"Lee, Dana\" <dana@shop.example>" },
  { name: "Cc", value: "kit@shop.example; Mo Sample <mo@shop.example>, sam@mine.example" },
  { name: "Message-ID", value: "<order-1@shop.example>" },
];
const gApi = async (method, url) => {
  if (url.endsWith("/settings/sendAs")) return { sendAs: [{ sendAsEmail: "sam@mine.example", isPrimary: true }, { sendAsEmail: "hello@mine.example", verificationStatus: "accepted" }] };
  if (url.includes("/messages/m-1?")) {
    assert.match(url, /metadataHeaders=To&metadataHeaders=Cc/, "the original's To and Cc are read");
    return { payload: { headers: ORDER } };
  }
  throw new Error(`unexpected ${method} ${url}`);
};
const line = (lines, n) => (lines.find((l) => l.startsWith(`${n}: `)) || "").slice(n.length + 2);

test("everyone else on the email, less the person and whoever the reply goes to, names and commas kept", () => {
  assert.equal(othersOnMail(["Sam Example <sam@mine.example>, \"Lee, Dana\" <dana@shop.example>", "kit@shop.example; Mo Sample <mo@shop.example>, SAM@mine.example"], "Rosa Fixture <rosa@shop.example>", ["sam@mine.example"]),
    "\"Lee, Dana\" <dana@shop.example>, kit@shop.example, Mo Sample <mo@shop.example>");
  assert.equal(othersOnMail(["rosa@shop.example", ""], "rosa@shop.example", []), "", "nobody else, nobody copied");
  assert.equal(othersOnMail(["a@x.example, a@x.example"], "", []), "a@x.example", "once each");
});

test("a Gmail reply copies everyone else on the email; asked to, the sender alone or its own Cc", async () => {
  const all = await sendHeadersFor("gmail_reply", { message_id: "m-1", thread_id: "t-1" }, gApi);
  assert.equal(line(all.headerLines, "To"), "Rosa Fixture <rosa@shop.example>");
  assert.equal(line(all.headerLines, "Cc"), "\"Lee, Dana\" <dana@shop.example>, kit@shop.example, Mo Sample <mo@shop.example>", "never the person's own address");
  const alone = await sendHeadersFor("gmail_reply", { message_id: "m-1", thread_id: "t-1", reply_all: false }, gApi);
  assert.equal(line(alone.headerLines, "Cc"), "");
  const chosen = await sendHeadersFor("gmail_reply", { message_id: "m-1", thread_id: "t-1", cc: "kit@shop.example" }, gApi);
  assert.equal(line(chosen.headerLines, "Cc"), "kit@shop.example");
  assert.match(fnSrc("createGmailDraft"), /return \{ draftId: draft\.id, messageId: draft\.message\?\.id, threadId: draft\.message\?\.threadId \|\| threadId \|\| null, to: header\("To"\), cc: header\("Cc"\) \};/, "and the draft says who it went to");
});

test("Outlook and other mail copy the same people the same way", async () => {
  const outlookAddresses = (list) => (list || []).map((r) => r.emailAddress?.address).filter(Boolean).join(", ");
  const outlookReplyCc = new Function("replyCc", "outlookAddresses", "ownAddresses", fnSrc("outlookReplyCc") + "\nreturn outlookReplyCc;")(replyCc, outlookAddresses, async () => ["sam@mine.example"]);
  const msApi = async (method, url) => {
    assert.match(url, /\$select=from,toRecipients,ccRecipients/);
    return { from: { emailAddress: { address: "rosa@shop.example" } }, toRecipients: [{ emailAddress: { address: "sam@mine.example" } }, { emailAddress: { address: "dana@shop.example" } }], ccRecipients: [{ emailAddress: { address: "kit@shop.example" } }] };
  };
  assert.equal(await outlookReplyCc(msApi, { message_id: "o-1" }), "dana@shop.example, kit@shop.example");
  assert.equal(await outlookReplyCc(msApi, { message_id: "o-1", reply_all: false }), "");
  const create = fnSrc("createOutlookDraft");
  assert.match(create, /const replyCcList = input\.message_id \? await outlookReplyCc\(msApi, input\) : "";/);
  assert.match(create, /\.\.\.\(replyCcList \? \{ ccRecipients: outlookRecipients\(replyCcList\) \} : \{\}\),/, "set on the reply draft");
  assert.match(fnSrc("createImapDraft"), /cc = await replyCc\(input, \[orig\.to, orig\.cc\], to, \(\) => ownAddresses\("reply_to_mail"\)\);/);
  assert.match(handlers, /const cc = await replyCc\(toolInput, \[orig\.to, orig\.cc\], orig\.from, \(\) => ownAddresses\("reply_to_mail"\)\);/, "a reply sent straight away too");
  for (const tool of ["gmail_create_draft", "outlook_create_draft", "create_mail_draft"]) {
    const at = handlers.indexOf(`case "${tool}": {`);
    assert.match(handlers.slice(at, handlers.indexOf('\n    case "', at + 10)), /cc: (result|d|r)\.cc \|\| "nobody"/, `${tool} says who is copied`);
  }
  const defs = read("lib/tools/definitions.js");
  for (const tool of ["reply_to_mail", "create_mail_draft", "gmail_reply", "gmail_create_draft", "outlook_reply", "outlook_create_draft"]) {
    const at = defs.indexOf(`name: "${tool}",`);
    assert.match(defs.slice(at, defs.indexOf('    name: "', at + 10)), /reply_all: \{ type: "boolean", description: "A reply copies everyone else on the email, as Reply all does\. Set false to answer the sender alone\." \},/, tool);
  }
});

test("the question before sending names who is copied, a reply's included", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(block\.input\.to\) confirmSummary \+= `To: \$\{block\.input\.to\}\\n`;\n\s*if \(block\.input\.cc\) confirmSummary \+= `Cc: \$\{block\.input\.cc\}\\n`;/);
  assert.match(engine, /if \(needsConfirmation && \/\^\(gmail_reply\|outlook_reply\|reply_to_mail\)\$\/\.test\(block\.name\)\) \{\n\s*try \{ const r = await require\("\.\/tools\/handlers"\)\.replyRecipients\(block\.name, block\.input\); if \(r\.to\) block\.input\.to = r\.to; if \(r\.cc\) block\.input\.cc = r\.cc; \}/);
  assert.match(read("lib/send-gate.js"), /if \(i\.to\) lines\.push\(`To: \$\{i\.to\}`\);\n\s*if \(i\.cc\) lines\.push\(`Cc: \$\{i\.cc\}`\);/);
  assert.match(read("lib/agents.js"), /if \(d && !d\.error\) \{ if \(d\.to\) pendingSend\.input\.to = d\.to; if \(d\.cc\) pendingSend\.input\.cc = d\.cc; \}/);
});
