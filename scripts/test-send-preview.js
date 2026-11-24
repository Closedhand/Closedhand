// Pressing Send in the sandbox computer's browser is asked about once, showing
// what goes. Shown a chase for a helpdesk thread, a person said yes; the job
// then put three zoomed-in pieces of their photo into the page, reworded the
// message and asked again with "I'm about to press Send", naming nothing.
// Now the question shows the message as the page holds it, every file with
// the pictures sent first, and what changed since the yes; the message they
// said yes to word for word, with nothing attached, goes without asking again.
// Invented people, sites and files.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// Results made inside the module's own context, compared as plain values.
const plain = (v) => JSON.parse(JSON.stringify(v));

const LEAD = "Here it is, unsent, for the Harbour Rail claim thread:";
const TITLE = "*Claim 55120 - replacement ticket*";
const BODY = ["The £40 refunded on 3 March covered the original ticket only.", "The replacement ticket cost £62 at the station, paid by Ana Ruiz.", "Please confirm the £62 is approved and when it will be paid."];
const DRAFT = [LEAD, TITLE, ...BODY, "Say send and I'll post it."].join("\n\n");
const CONTEXT = { type: "text", text: "[Closedhand context for this message, not written by the user]\nCurrent time: 10:02.\n[End of Closedhand context. The user's message follows.]" };
const isYes = (t) => /^(yes|ok|send it)\b/i.test(String(t).trim());

function load(fakes = {}) {
  const sent = [];
  const deps = {
    "./sandbox": fakes.sandbox || { ensureSandbox: async () => {}, sandboxExec: async () => ({ exit_code: 0 }), sandboxFileDownload: async () => null, sandboxFileDelete: async () => {} },
    "./spend-guard": { lastPage: () => ({ url: "https://help.harbour-rail.test/claims/55120" }) },
    "./attachments": { loadAttachmentRaw: async (id) => (id === "att_ticket" ? { buffer: Buffer.from("png"), fileName: "ticket.png", mimeType: "image/png" } : null) },
    "./confirmation": { confirmationAnswer: (t) => (isYes(t) ? "yes" : null) },
    "./messaging": { sendDocumentOnly: async (...args) => { sent.push(args.slice(0, 1).concat(args.slice(3))); } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(read("lib/send-preview.js"), { module: mod, exports: mod.exports, Buffer, URL, console: { error() {} }, require: (n) => { if (!(n in deps)) throw Error(n); return deps[n]; } });
  return { ...mod.exports, sent };
}

// A sandbox computer whose page holds this message and these files.
function pageHolding(text, files = []) {
  const what = [{ browser: "visible", url: "https://help.harbour-rail.test/claims/55120", fields: text ? [text] : [], files: files.map((f, i) => ({ name: f.name, type: f.type, size: 3, saved: f.picture ? `${i + 1}-${f.name}` : undefined })) }];
  return {
    ensureSandbox: async () => {}, sandboxExec: async () => ({ exit_code: 0 }), sandboxFileDelete: async () => {},
    sandboxFileDownload: async (_, p) => ({ content: Buffer.from(p.endsWith("what.json") ? JSON.stringify(what) : "jpg").toString("base64") }),
  };
}

const saidYes = (yes = "Yes") => [
  { role: "user", content: "Can I see it before it goes?" },
  { role: "assistant", content: [{ type: "text", text: DRAFT }] },
  { role: "user", content: [CONTEXT, { type: "text", text: yes }] },
];

test("the draft said yes to is the reply just before a plain yes, the context block not counted", () => {
  const p = load();
  assert.equal(p.approvedDraft(saidYes(), isYes).length, 1);
  assert.equal(p.approvedDraft(saidYes("Change the amount to £60"), isYes), null, "anything but a yes approves nothing");
  const split = [{ role: "assistant", content: `${DRAFT}\n\n[[next]]\n\nIf you meant the other claim, say so.` }, { role: "user", content: "yes" }];
  assert.equal(p.approvedDraft(split, isYes).length, 2, "each follow-on message is a part of its own");
});

test("the same words go without asking again; anything changed is named", () => {
  const p = load();
  const parts = p.approvedDraft(saidYes(), isYes);
  assert.deepEqual(plain(p.compare(parts, BODY.join("\n\n"))), { same: true });
  assert.deepEqual(plain(p.compare(parts, [TITLE, ...BODY].join("\n\n"))), { same: true }, "with its title");
  assert.equal(p.compare(parts, BODY.slice(0, 2).join("\n\n")).same, false, "a message cut short is not what was said yes to");
  const changed = p.compare(parts, ["Hi,", BODY[0], "The replacement ticket cost GBP 62 at the station.", BODY[2], "Thanks, Ana"].join("\n\n"));
  assert.equal(changed.same, false);
  assert.deepEqual(plain(changed.added), ["Hi,", "The replacement ticket cost GBP 62 at the station.", "Thanks, Ana"]);
  assert.deepEqual(plain(changed.removed), [BODY[1]]);
  assert.equal(p.compare(null, BODY.join("\n\n")), null, "no yes, nothing to compare");
});

test("the question shows the whole message, every file and what changed", () => {
  const p = load();
  const shown = { site: "help.harbour-rail.test", text: BODY.join("\n\n"), files: [{ name: "ticket.jpg", mime: "image/jpeg", buffer: Buffer.from("x") }, { name: "claim.pdf", mime: "application/pdf", buffer: null }] };
  const card = p.card(shown, { same: false, added: ["Thanks, Ana"], removed: [BODY[1]] }, { picturesSent: true });
  assert.ok(card.startsWith("I'm about to press Send on help.harbour-rail.test, on Closedhand's sandbox computer. This is what goes:\n\n" + BODY.join("\n\n")));
  assert.match(card, /\n\nWith 2 files, shown above: ticket\.jpg, claim\.pdf\n/);
  assert.match(card, /\n\nChanged since you said yes to it:\nNow says: Thanks, Ana\nNo longer says: The replacement ticket cost £62 at the station, paid by Ana Ruiz\.\n/);
  assert.ok(card.endsWith(`Reply "yes" to send it or "no" to leave it unsent.`));
  assert.doesNotMatch(p.card(shown, null, { picturesSent: false }), /shown above/, "said only when the pictures went");
});

test("a Send is decided from what the page holds", async () => {
  const yes = saidYes();
  let p = load({ sandbox: pageHolding(BODY.join("\n\n")) });
  assert.equal((await p.decide("u1", "sandbox_browse", { action: "click", ref: 4 }, yes)).go, true, "word for word, nothing attached: no second question");

  p = load({ sandbox: pageHolding(BODY.join("\n\n"), [{ name: "receipt-piece.jpg", type: "image/jpeg", picture: true }, { name: "notes.pdf", type: "application/pdf" }]) });
  const asked = await p.decide("u1", "sandbox_exec", { code: "click send" }, yes);
  assert.equal(asked.go, undefined, "files the person never saw: asked, showing them");
  assert.deepEqual(plain(asked.shown.files.map((f) => [f.name, !!f.buffer])), [["receipt-piece.jpg", true], ["notes.pdf", false]]);
  assert.equal(await p.sendPictures("whatsapp_linked", "chat-1", asked.shown), true);
  assert.deepEqual(plain(p.sent), [["whatsapp_linked", "receipt-piece.jpg", "image/jpeg"]], "only the picture is sent, before the question");
  assert.match(asked.question(true), /With 2 files, shown above: receipt-piece\.jpg, notes\.pdf/);

  p = load({ sandbox: pageHolding("") });
  assert.equal((await p.decide("u1", "sandbox_exec", { code: "type and click send" }, yes)).refuse, p.SHOW_FIRST, "a script that would send what the page does not show is sent back");
  assert.equal((await p.decide("u1", "sandbox_browse", { action: "click", text: "Send code" }, yes)).question, null, "a Send with nothing to show keeps the plain question");
  const batch = await p.decide("u1", "sandbox_browse", { action: "batch", steps: [{ action: "fill", ref: 3, value: "Running ten minutes late." }, { action: "upload", attachment_ids: ["att_ticket"] }, { action: "click", text: "Send" }] }, []);
  assert.equal(batch.shown.text, "Running ten minutes late.", "what the step itself writes in");
  assert.deepEqual(plain(batch.shown.files.map((f) => f.name)), ["ticket.png"]);
});

test("the page is read in place, in both browsers, and its files come back whole", () => {
  const p = load();
  new vm.Script(p.SCRIPT);
  new vm.Script(`(${p.READ_PAGE})`);
  assert.match(p.SCRIPT, /\[\["visible", 9222\], \["headless", 9223\]\]/);
  assert.doesNotMatch(p.SCRIPT, /Page\.navigate|createTarget|bringToFront/, "never moves or opens a tab");
  assert.match(p.READ_PAGE, /input\[type="file"\]/);
});

test("every Send in the sandbox browser goes through it, in chat, tasks and routines", () => {
  const agents = read("lib/agents.js"), engine = read("lib/engine.js"), gate = read("lib/send-gate.js");
  assert.match(agents, /const preview = sendAt === "sandbox" \? await require\("\.\/send-preview"\)\.decide\(userId, block\.name, block\.input, messages\) : null;/);
  assert.match(agents, /pendingPreview = preview && preview\.question \? preview : null;/, "kept off the saved step: its pictures are whole files");
  assert.match(agents, /if \(pendingPreview\) pendingSend\._spendCard = pendingPreview\.question\(await require\("\.\/send-preview"\)\.sendPictures\(platform, chatId, pendingPreview\.shown\)\);/);
  assert.match(engine, /const sendPreview = browserSendAt === "sandbox" \? await require\("\.\/send-preview"\)\.decide\(userId, block\.name, block\.input, conversation\) : null;/);
  assert.match(engine, /sendPreview\.question\(await require\("\.\/send-preview"\)\.sendPictures\(deliverPlatform, chatId, sendPreview\.shown\)\)/);
  assert.match(gate, /await require\("\.\/send-preview"\)\.decide\(userId, toolName, input, \[\]\)/);
});

test("a file sent that is not a picture is said as sent", async () => {
  const source = read("lib/tools/handlers.js");
  const body = source.slice(source.indexOf('    case "sandbox_file_download": {'), source.indexOf('    case "sandbox_upload": {'));
  const context = {
    Buffer, console: { error() {} }, ctx: { activeUserId: "u1", activeChatId: "c1" }, toolInput: { path: "claim.pdf" }, sendDocument: async () => {},
    require: (n) => ({ ensureSandbox: async () => {}, sandboxFileDownload: async () => ({ filename: "claim.pdf", mime_type: "application/pdf", content: "YQ==", size: 1 }) }),
  };
  const result = await vm.runInNewContext(`(async () => { switch ("sandbox_file_download") { ${body} } })()`, context);
  assert.deepEqual(plain(result), { success: true, message: "Sent claim.pdf (0.0KB) to the user" });
});
