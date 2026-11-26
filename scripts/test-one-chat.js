// One conversation, whole wherever it is opened (lib/one-chat.js). Each app
// showed only what passed through it, so a question asked on WhatsApp was
// missing from the web chat and carrying on elsewhere meant carrying on half
// blind. Invented people and messages throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// The module reaches the web chat and WhatsApp as it sends, so the stand-ins
// stay in place until the test ends.
function load(stubs, t) {
  const full = require.resolve("../lib/one-chat");
  delete require.cache[full];
  const real = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = real; delete require.cache[full]; });
  return require(full);
}
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

test("switching to a bot app mid-topic shows where they left off, both sides, as a quote; not when they stay, or it was hours ago", () => {
  const { catchUp, catchUpMessage } = require("../lib/one-chat");
  const chat = (via, ts, content = "Can you find the Harbour Hall booking form?") => [
    { role: "user", content: "earlier", via: "telegram", ts: ago(30) },
    { role: "assistant", content: "Sure", via: "telegram", ts: ago(30) },
    { role: "user", content, via, ts },
    { role: "assistant", content: "**Found it**: it's attached to the venue's email from Tuesday.\n\nWant me to fill it in?", via, ts },
  ];
  const card = catchUp(chat("web", ago(1)), "telegram", { botName: "Pete" });
  assert.deepEqual(card, { from: "the web chat", you: "Can you find the Harbour Hall booking form?", them: "Found it: it's attached to the venue's email from Tuesday.", botName: "Pete" });
  assert.equal(catchUpMessage(card, "telegram").text, "Earlier, in the web chat:\n<blockquote>You: Can you find the Harbour Hall booking form?\nPete: Found it: it's attached to the venue's email from Tuesday.</blockquote>");
  assert.equal(catchUpMessage(card, "telegram").html, true);
  assert.equal(catchUp(chat("whatsapp_linked", ago(1)), "telegram").from, "WhatsApp");
  assert.equal(catchUp(chat("telegram", ago(1)), "telegram"), null, "same app: the chat shows it already");
  assert.equal(catchUp(chat("telegram", ago(1)), "web"), null, "the web chat shows everything, so never");
  assert.equal(catchUp(chat("telegram", ago(1)), "whatsapp_linked"), null, "nor WhatsApp linked to their account, which gets every turn");
  assert.equal(catchUp(chat("web", ago(4)), "telegram"), null, "hours later is a new start");
  assert.equal(catchUp([{ role: "user", content: "untagged", ts: ago(1) }], "telegram"), null, "older messages say no app");
  const quoted = catchUp(chat("web", ago(1), "[replying to Closedhand's message: \"Found two forms\"]\nthe second one"), "telegram");
  assert.equal(quoted.you, "the second one", "their words, not the message they replied to");
  assert.ok(catchUp(chat("web", ago(1), "word ".repeat(40)), "telegram").you.endsWith("…"));
  assert.match(catchUpMessage({ from: "the web chat", you: "a < b & c", them: "", botName: "Pete" }, "telegram").text, /You: a &lt; b &amp; c<\/blockquote>$/, "their words are text, never markup");
});

test("after the card, the answer goes as a reply to their new message", () => {
  assert.match(read("lib/platforms/telegram.js"), /if \(statusOpts\.opts\.caughtUp\) \{[\s\S]{0,800}i === 0 \? \{ reply_to_message_id: msg\.message_id, allow_sending_without_reply: true \} : undefined/);
  // A reply in parts quotes their message on its first part only.
  const sent = [];
  const bot = require("../lib/follow-on").splitTelegram({ sendMessage: async (id, text, o) => sent.push(o || null) });
  return bot.sendMessage(1, "First part.\n[[next]]\nSecond part.", { reply_to_message_id: 9, parse_mode: "HTML" }).then(() => {
    assert.deepEqual(sent, [{ reply_to_message_id: 9, parse_mode: "HTML" }, { parse_mode: "HTML" }]);
  });
});

test("a turn's messages carry the app; the other apps get the turn: the web chat live, WhatsApp in the person's own chat", async (t) => {
  const web = [], wa = [];
  const oneChat = load({
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async (x) => wa.push(["me", x]), sendLinkedMessage: async (jid, x) => wa.push(["closedhand", x]) },
  }, t);
  const before = { role: "user", content: "old" };
  const conv = [before, { role: "user", content: "new" }, { role: "assistant", content: "reply" }];
  assert.equal(oneChat.tag(conv, new Set([before]), "telegram"), 2);
  assert.equal(before.via, undefined, "what was there before keeps what it had");
  assert.deepEqual(conv.slice(1).map((m) => m.via), ["telegram", "telegram"]);

  await oneChat.after({ userId: "u1", via: "telegram", said: "Is the boiler service booked?", reply: "Yes, Tuesday 9:00." });
  assert.deepEqual(web.pop(), { type: "elsewhere", project: null, messages: [{ role: "user", content: "Is the boiler service booked?", via: "telegram" }, { role: "assistant", content: "Yes, Tuesday 9:00.", via: "telegram" }] });
  assert.deepEqual(wa.splice(0), [["me", "Is the boiler service booked?"], ["closedhand", "Yes, Tuesday 9:00."]], "their words as theirs, the reply as Closedhand's");

  await oneChat.after({ userId: "u1", via: "web", said: "And the gas check?", reply: "Booked for Friday." });
  assert.equal(web.length, 0, "a web turn is in the web chat already");
  assert.equal(wa.length, 2);
  wa.splice(0);
  await oneChat.after({ userId: "u1", via: "whatsapp_linked", said: "Thanks", reply: "Any time." });
  assert.equal(wa.length, 0, "a WhatsApp turn is in WhatsApp already");
  assert.equal(web.length, 1);
  await oneChat.after({ userId: "u1", via: "telegram", said: "", reply: "", fileData: { mimeType: "image/jpeg" } });
  assert.deepEqual(wa.splice(0), [["me", "(a photo)"]], "a photo on its own is said to be one");
  await oneChat.after({ userId: "u1", via: "telegram", said: "📦 any news?", reply: "📦 It left the depot.", project: { id: "p1", emoji: "📦" } });
  assert.deepEqual(web.pop().project, { id: "p1", emoji: "📦" }, "a project's turn goes to that project's conversation");
});

test("a message sent on its own shows in the web chat and their own WhatsApp chat, whichever it went to, a reply being written or not", async (t) => {
  const web = [], wa = [];
  const oneChat = load({
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async (x) => wa.push(["me", x]), sendLinkedMessage: async (jid, x) => wa.push(["closedhand", x]) },
  }, t);
  const tick = () => new Promise((r) => setImmediate(r));
  oneChat.sentElsewhere("u1", "web", "The draft to Priya Fixture is shorter now, still unsent.");
  await tick();
  assert.deepEqual(wa.splice(0), [["closedhand", "The draft to Priya Fixture is shorter now, still unsent."]], "the web chat's goes to WhatsApp");
  assert.equal(web.length, 0);
  oneChat.sentElsewhere("u1", "whatsapp_linked", "Your parcel left the depot.");
  await tick();
  assert.deepEqual(web.pop().messages, [{ role: "assistant", content: "Your parcel left the depot.", via: "whatsapp_linked" }], "and WhatsApp's to the web chat");
  assert.equal(wa.length, 0);

  // A turn's own sends wait for it; anything else's go as they are sent.
  let release, inside = null;
  const turn = oneChat.asTurn("u1", async () => { inside = oneChat.turnsOwn("u1"); await new Promise((r) => { release = r; }); });
  await tick();
  assert.equal(inside, true, "the turn's own");
  assert.equal(oneChat.turnsOwn("u1"), false, "a task finishing while the reply is written is not the turn's");
  release();
  await turn;
  let afterwards = null;
  await oneChat.asTurn("u1", async () => { setTimeout(() => { afterwards = oneChat.turnsOwn("u1"); }, 5); });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(afterwards, false, "work a turn set going that outlives it is not the turn's");
});

test("the turn's hook, proactive messages and the web chat page", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const card = oneChat\.catchUp\(conversation, platform, \{ botName: ctx\.activeUserStore\?\.profile\?\.settings\?\.bot_name \|\| "Closedhand" \}\);\n\s*if \(card && await oneChat\.sendCatchUp\(platform, chatId, card\)[\s\S]{0,140}opts\.caughtUp = true;/, "the card goes before the answer, in the app they are in");
  assert.match(engine, /oneChat\.after\(\{ userId, via: platform, said: userMessage, reply, fileData, project: project \? project\.project : null \}\)/);
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /if \(userId && !require\("\.\/one-chat"\)\.turnsOwn\(userId\)\) \{\n\s*try \{ require\("\.\/one-chat"\)\.sentElsewhere\(/, "a proactive message shows in the other app; a turn's own sends do not show twice");
  assert.match(engine, /const turn = \(\) => require\("\.\/one-chat"\)\.asTurn\(userId, run\);\n\s*ctx\.userQueues\[userId\] = ctx\.userQueues\[userId\]\.then\(turn, turn\);/, "each turn runs as itself");
  assert.match(engine, /if \(confirmResult\) \{[\s\S]{0,400}oneChat\.after\(\{ userId, via: platform, said: userMessage, reply: typeof confirmResult === "string" \? confirmResult : "" \}\)/, "a yes and what came of it reach the other apps too");
  assert.doesNotMatch(engine, /sendWebMessage\(info\.userId, text\)/, "the follow-up to a parked request goes by sendToPlatform, so it reaches both");
  const wa = read("lib/platforms/whatsapp-linked.js");
  assert.match(wa, /const id = require\("@whiskeysockets\/baileys"\)\.generateMessageIDV2\(_sock\.user\?\.id\);\n\s*_sentIds\.add\(id\);/, "a mirrored message is never answered, even if its echo comes first");
  assert.match(read("lib/pulse.js"), /via = via \|\| t\.platform;/);
  assert.match(read("lib/task-delivery.js"), /sentText = sent; sentVia = dest\.platform;/);
  const page = read("webapp/views/index.html");
  assert.match(page, /if \(msg\.type === 'elsewhere'\) \{ showElsewhere\(msg\); return; \}/);
  assert.match(page, /where\.textContent = 'on ' \+ VIA_NAMES\[via\];/);
  assert.match(page, /var firstOfVisit = !hasMessages && !_openProject;\n(\s*\/\/[^\n]*\n)*\s*if \(spoken === true && !hasMessages && window\.talkFirst && window\.talkFirst\(\)\) holdForAnswer\(\); else enterChatMode\(\);\n\s*if \(firstOfVisit\) loadEarlier\(\);/, "typing (or talking) from the opening screen carries the conversation on");
  assert.match(page, /addMessage\(theirOwn\(m\), 'user', [^\n]*, m\.ts \|\| null, m\.via \|\| null\);/, "history says which app too");
  assert.match(page, /addMessage\(m\.content, 'bot', null, m\.ts \|\| null, m\.via \|\| null\);/);
});

// A picture made in the web chat once reached WhatsApp only as the words
// "sent as ferrari_spider.jpg": the turn's pictures and files go with it.
test("the pictures and files Closedhand sent in a turn go with it to the other apps", async (t) => {
  const web = [], wa = [];
  const oneChat = load({
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async (x) => wa.push(["me", x]), sendLinkedMessage: async (jid, x) => wa.push(["closedhand", x]),
      sendLinkedDocument: async (jid, buffer, name, mime, picture) => wa.push(["file", name, mime, picture, buffer.toString()]) },
  }, t);
  oneChat.noteFile("u1", "draw a lighthouse", { buffer: Buffer.from("JPEG"), filename: "image.jpg", mimeType: "image/jpeg" });
  await oneChat.after({ userId: "u1", via: "web", said: "draw a lighthouse", reply: "Here it is." });
  assert.deepEqual(wa.splice(0), [["me", "draw a lighthouse"], ["closedhand", "Here it is."], ["file", "image.jpg", "image/jpeg", true, "JPEG"]], "the picture follows the reply, as a picture");

  oneChat.noteFile("u1", "the receipt?", { buffer: Buffer.from("%PDF"), filename: "receipt.pdf", mimeType: "application/pdf" });
  await oneChat.after({ userId: "u1", via: "whatsapp_linked", said: "the receipt?", reply: "Attached." });
  assert.equal(wa.length, 0);
  assert.equal(web[0].type, "elsewhere");
  assert.deepEqual(web[1], { type: "file", filename: "receipt.pdf", mediaType: "application/pdf", size: 4, base64: Buffer.from("%PDF").toString("base64") }, "and the web chat gets it too");

  oneChat.noteFile("u1", "an older turn", { buffer: Buffer.from("x"), filename: "old.png", mimeType: "image/png" });
  await oneChat.after({ userId: "u1", via: "web", said: "something else", reply: "Ok." });
  assert.deepEqual(wa.splice(0).map((m) => m[0]), ["me", "closedhand"], "a file from another turn never goes with this one");

  const messaging = read("lib/messaging.js");
  assert.match(messaging, /if \(!oneChat\.turnsOwn\(userId\)\) oneChat\.fileElsewhere\(userId, platform, \{ buffer, filename, mimeType \}\);\n\s*else if \(said\) oneChat\.noteFile\(userId, said, \{ buffer, filename, mimeType, id, \.\.\.\(madeFrom \? \{ madeFrom: String\(madeFrom\)\.slice\(0, 1200\) \} : \{\}\), \.\.\.\(shows \? \{ shows: String\(shows\)\.slice\(0, 800\) \} : \{\}\) \}\);/);
});

// A task started in the web chat sent its sales order there alone, and told
// WhatsApp it was "above"; never kept either, the PDF could not be added to
// the draft it was made for. A file sent outside a turn is kept and goes to
// the other app at once; a turn's own still goes with the turn.
test("a file sent outside a turn is kept and reaches the other app at once; a turn's own waits for the turn", async (t) => {
  const web = [], wa = [], kept = [];
  const stubs = {
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async () => {}, sendLinkedMessage: async () => {},
      sendLinkedDocument: async (jid, buffer, name) => wa.push([jid, name]) },
    "./attachments": { saveAttachment: (userId, f, description) => { kept.push([f.fileName, f.direction, description]); return "att_" + kept.length; } },
  };
  const oneChat = load(stubs, t);
  const full = require.resolve("../lib/messaging");
  delete require.cache[full];
  const real = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./one-chat") return oneChat;
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = real; delete require.cache[full]; });
  const messaging = require(full);
  const ctx = require("../lib/context");
  const was = { userId: ctx.activeUserId, ask: ctx.currentAsk };
  t.after(() => { ctx.activeUserId = was.userId; ctx.currentAsk = was.ask; });
  ctx.activeUserId = "u1"; ctx.currentAsk = { u1: "redo the order for Fixture Padel" };
  const tick = () => new Promise((r) => setImmediate(r));

  assert.equal(await messaging.sendDocumentToPlatform("web", "u1", Buffer.from("%PDF"), "Sales-Order-Fixture.pdf", "application/pdf"), "att_1", "the id it is kept under");
  await tick();
  assert.equal(web.filter((m) => m.type === "file").length, 1, "the web chat, where the task was started");
  assert.deepEqual(wa.splice(0), [["447700900001@s.whatsapp.net", "Sales-Order-Fixture.pdf"]], "and WhatsApp, at once");
  assert.deepEqual(kept.splice(0), [["Sales-Order-Fixture.pdf", "chat", "Sent in the chat: Sales-Order-Fixture.pdf"]], "kept, so it can be attached to a draft");

  web.length = 0;
  await oneChat.asTurn("u1", () => messaging.sendDocumentToPlatform("web", "u1", Buffer.from("JPEG"), "chart.png", "image/png"));
  await tick();
  assert.equal(wa.length, 0, "a turn's own file goes with the turn, not before it");
  await oneChat.after({ userId: "u1", via: "web", said: "redo the order for Fixture Padel", reply: "Here it is." });
  assert.deepEqual(wa.splice(0), [["447700900001@s.whatsapp.net", "chart.png"]]);
  assert.equal(kept.length, 1);
  // The task is told the id, to add it to an email or draft by attachment_ids.
  assert.match(read("lib/tools/handlers.js"), /const kept = await sendDocument\(ctx\.activeChatId, Buffer\.from\(file\.content, "base64"\), file\.filename, file\.mime_type\);\n[^\n]*\n\s*const sent = `Sent \$\{file\.filename\} \(\$\{\(file\.size \/ 1024\)\.toFixed\(1\)\}KB\) to the user\$\{kept \? `, kept as \$\{kept\}: add it to an email or draft with attachment_ids` : ""\}`;/);
});

// Looking back, a picture Closedhand sent was gone: only the words of the
// reply were kept. The files a turn sends are kept and named on its answer,
// and the web chat draws them above it again.
test("the files a turn sent are named on its answer, so looking back shows them", (t) => {
  const oneChat = load({}, t);
  const before = new Set([{ role: "user", content: "earlier" }]);
  const conv = [...before, { role: "user", content: "draw a lighthouse" }, { role: "assistant", content: "Here it is." }];
  oneChat.noteFile("u1", "draw a lighthouse", { buffer: Buffer.from("JPEG"), filename: "image.jpg", mimeType: "image/jpeg", id: "att_1" });
  assert.equal(oneChat.keepFiles("u1", "something else", conv, before), false, "another turn's files never");
  assert.equal(oneChat.keepFiles("u1", "draw a lighthouse", conv, before), true);
  assert.deepEqual(conv[2].files, [{ id: "att_1", name: "image.jpg", mime: "image/jpeg", size: 4 }]);
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /id = require\("\.\/attachments"\)\.saveAttachment\(userId, \{ buffer, fileName: filename, mediaType: mimeType, ext, isImage: PICTURE\.test\(mimeType \|\| ""\), direction: "chat" \}, `Sent in the chat: \$\{filename\}`\);/, "kept as it is sent");
  assert.match(read("lib/engine.js"), /if \(oneChat\.keepFiles\(userId, userMessage, require\("\.\/conversation"\)\.getConversation\(userId\), before\)\) ctx\.activeUserStore\?\.markDirty\?\.\("conversations"\);/);
  const page = read("webapp/views/index.html");
  assert.match(page, /var url = function \(f\) \{ return '\/api\/files\/' \+ encodeURIComponent\(f\.id\) \+ '\/download'; \};/);
  assert.match(page, /files\.forEach\(function \(f\) \{ addFileMessage\(\{ filename: f\.name, mediaType: f\.mime, size: f\.size, url: url\(f\) \}\); \}\);/);
  assert.match(page, /if \(conv && conv\.messages\) shownInThread\(conv\.messages\)\.forEach\(showStored\);/);
  assert.match(page, /earlier\.forEach\(showStored\);/);
});

// A picture Closedhand made keeps what it was made from and what it showed,
// and the model's copy of the conversation names them on the reply that sent
// it, so "her again" can be drawn the same: the next turn knew nothing of a
// picture it had sent and drew a stranger. The conversation stays as written.
test("the model reads what earlier replies sent, so the same person can be shown again", (t) => {
  const oneChat = load({}, t);
  const before = new Set();
  const reply = { role: "assistant", content: "Here she is." };
  const conv = [{ role: "user", content: "a woman reading in a cafe" }, reply];
  oneChat.noteFile("u1", "a woman reading in a cafe", { buffer: Buffer.from("JPEG"), filename: "image.jpg", mimeType: "image/jpeg", id: "att_7", madeFrom: "a woman with short silver hair and round glasses, reading in a cafe", shows: "A woman with short grey hair and glasses reads a book at a cafe table." });
  oneChat.keepFiles("u1", "a woman reading in a cafe", conv, before);
  assert.deepEqual(reply.files, [{ id: "att_7", name: "image.jpg", mime: "image/jpeg", size: 4, made_from: "a woman with short silver hair and round glasses, reading in a cafe", shows: "A woman with short grey hair and glasses reads a book at a cafe table." }]);
  const forModel = oneChat.filesForModel([...conv, { role: "user", content: "now her on a beach" }]);
  assert.equal(forModel[1].content, 'Here she is.\n\n[Sent with this reply: att_7, made from "a woman with short silver hair and round glasses, reading in a cafe", which shows: A woman with short grey hair and glasses reads a book at a cafe table.]');
  assert.equal(reply.content, "Here she is.", "the conversation keeps the reply as written");
  assert.equal(forModel[0], conv[0]);
  assert.match(read("lib/engine.js"), /const placeContext = \(list\) => withTurnContext\(withFiles\(list\), turnContext\) \|\| withFiles\(list\);/);
  // The check before a picture is sent reads them too.
  const im = require("../lib/image-generation");
  assert.match(im.askedFrom([...conv, { role: "user", content: "now her on a beach" }]), /Closedhand said: Here she is\.\n\n\[Sent with this reply: att_7, made from "a woman with short silver hair/);
});


// The person talks to Closedhand in WhatsApp, Telegram or the web chat, and
// nowhere else. Slack and the like are connections Closedhand works in, not
// places it is talked to. Half-built handlers for four more chat apps once sat
// beside these, each with its own way to send, sign in and set up.
test("the chat apps are Telegram, WhatsApp as a linked device and the web chat, and no other", () => {
  const fs = require("node:fs"), path = require("node:path");
  const root = path.join(__dirname, "..");
  assert.deepEqual(fs.readdirSync(path.join(root, "lib", "platforms")).sort(), ["telegram.js", "web.js", "whatsapp-linked.js"]);
  const server = read("webapp/server.js");
  const supported = server.slice(server.indexOf("const SUPPORTED_PLATFORMS = {"), server.indexOf("};", server.indexOf("const SUPPORTED_PLATFORMS = {")));
  assert.deepEqual([...supported.matchAll(/^  (\w+): \{/gm)].map((m) => m[1]), ["telegram", "whatsapp"], "the two cards the dashboard draws");
  const messaging = read("lib/messaging.js");
  const sender = messaging.slice(messaging.indexOf("async function sendToPlatformOnly("), messaging.indexOf("async function pinMessage("));
  assert.deepEqual([...sender.matchAll(/case "(\w+)":/g)].map((m) => m[1]), ["telegram", "whatsapp_linked", "web"]);
  assert.deepEqual([...require("../lib/one-chat").BOT_APPS], ["telegram"], "the one app where Closedhand is a bot");
  for (const f of ["index.js", "lib/messaging.js", "lib/context.js", "webapp/server.js", "webapp/views/dashboard.html", "webapp/views/index.html"]) {
    assert.doesNotMatch(read(f), /DISCORD_BOT_TOKEN|discordClient|sendLinePush|LINE_CHANNEL|liff|SLACK_BOT_TOKEN|WHATSAPP_ACCESS_TOKEN|chat-apps/i, f);
  }
  assert.equal(JSON.parse(read("package.json")).dependencies["discord.js"], undefined);
});
