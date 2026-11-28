// A WhatsApp reply keeps the message it answers, in every chat: "yes of
// course" in another chat said nothing about what was agreed once stored on
// its own, so Closedhand read the reply as covering something else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { quoteOf, replyLine } = require('../lib/whatsapp-quote');
const rules = require('../lib/project-rules');

const reply = (kind, quoted, extra = {}) => ({ [kind]: { text: 'Yes of course', caption: 'Yes of course', contextInfo: { quotedMessage: quoted, ...extra } } });

test('a reply in another chat reads with the message it answers', () => {
  const q = quoteOf(reply('extendedTextMessage', { conversation: 'Can Rowan bring the boxes round on Friday?' }, { participant: '447700900111@s.whatsapp.net' }));
  assert.deepEqual(q, { text: 'Can Rowan bring the boxes round on Friday?', who: null, from: '447700900111@s.whatsapp.net' });
  const line = replyLine(q, 'me');
  assert.equal(line, '[replying to a message from me: "Can Rowan bring the boxes round on Friday?"]');
  assert.equal(rules.splitReply(`${line}\nYes of course`).quoted, 'Can Rowan bring the boxes round on Friday?', 'stored in the shape every reply takes');
  assert.equal(replyLine(q, null), '[replying to an earlier message: "Can Rowan bring the boxes round on Friday?"]');
});

test('a picture or file with a caption carries its reply the same way', () => {
  for (const kind of ['imageMessage', 'videoMessage', 'documentMessage']) {
    assert.equal(quoteOf(reply(kind, { conversation: 'Which floor plan?' }))?.text, 'Which floor plan?', kind);
  }
  assert.equal(quoteOf({ conversation: 'no reply here' }), null);
  assert.equal(quoteOf(reply('extendedTextMessage', { imageMessage: {} })), null, 'a quote with no words to show');
});

test("Closedhand's own message is named as its own, without the stamp", () => {
  const q = quoteOf(reply('extendedTextMessage', { conversation: '✊ *Closedhand:* 📦 Van is booked' }));
  assert.equal(q.who, 'Closedhand');
  assert.equal(q.text, '📦 Van is booked');
  assert.equal(quoteOf(reply('extendedTextMessage', { conversation: 'Van is booked' }, { stanzaId: 'ABC1' }), new Set(['ABC1'])).who, 'Closedhand');
  assert.equal(quoteOf(reply('extendedTextMessage', { conversation: 'a "quote"] inside' })).text, 'a "quote" ] inside', 'cannot close the line early');
});

test('every chat stores its replies with the quote, named as that chat names people', () => {
  const linked = fs.readFileSync(path.join(__dirname, '../lib/platforms/whatsapp-linked.js'), 'utf8');
  const ingest = linked.slice(linked.indexOf('async function ingestMessages'), linked.indexOf('// --- The conversation, in the self-chat'));
  assert.match(ingest, /const quote = quoteOf\(inner, _sentIds\)/);
  assert.match(ingest, /isSelfJid\(by\) \? "me"/, 'the person is "me", as their own messages are');
  assert.match(ingest, /const text = quote \? `\$\{replyLine\(quote, writer\)\}\\n\$\{said\}` : said;/);
  assert.match(linked, /const quoted = media \? null : quoteOf\(unwrap\(msg\.message\), _sentIds\);/, 'the self-chat reads replies the same way');
  assert.ok(!/function extractQuoted/.test(linked), 'one reader of quotes');
});

// An edit, or a delete for everyone, comes as an update naming the message,
// not as a message: both went unread, so an edited message kept the words
// first sent ("COA" where it now said "COE") and a deleted one stayed.
test('a WhatsApp message edited or deleted for everyone after it was stored changes the stored copy', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/platforms/whatsapp-linked.js'), 'utf8');
  const take = (start) => { const at = src.indexOf(start); return src.slice(at, src.indexOf('\n}\n', at) + 3); };
  const saved = [];
  let stored = { external_id: 'wa-ABC', id: 'wa-ABC', chat: 'friend@s.whatsapp.net', sender: 'me', date: '2026-11-27T17:38:00.000Z',
    text: '[replying to a message from Sam: "which one?"]\nis it the COA?' };
  const vmRequire = (name) => {
    if (name === '@whiskeysockets/baileys') return { WAMessageStubType: { REVOKE: 1 } };
    if (name === '../services/data-sync') return { upsertCacheItems: async (u, s, t, items) => { saved.push({ s, t, items }); } };
    throw new Error(name);
  };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: stored ? { data: stored } : null, error: null }) };
  const box = { require: vmRequire, supabase: { from: () => query }, ingestMessages: async () => 1 };
  vm.runInNewContext(take('function unwrap(') + take('function extractText(') + take('async function changeStored(') + '\nthis.changeStored = changeStored;', box);
  const key = { remoteJid: 'friend@s.whatsapp.net', fromMe: true, id: 'ABC' };
  assert.equal(await box.changeStored('u1', key, { message: { editedMessage: { message: { conversation: 'is it the COE (certificate of eligibility)?' } } } }), true);
  const edited = saved.at(-1).items[0];
  assert.equal(edited.text, '[replying to a message from Sam: "which one?"]\nis it the COE (certificate of eligibility)?', 'the reply it was stays');
  assert.equal(edited.date, '2026-11-27T17:38:00.000Z', 'when it was sent stays');
  assert.equal(edited.edited, true);
  stored = { ...stored, file: { name: 'form.pdf' }, file_texts: [{ text: 'secret' }] };
  assert.equal(await box.changeStored('u1', key, { message: null, messageStubType: 1 }), true);
  const gone = saved.at(-1).items[0];
  assert.equal(gone.text, '[deleted for everyone by its sender]');
  assert.equal(gone.file, undefined); assert.equal(gone.file_texts, undefined);
  // Receipts and the like are not changes, and never read the database.
  assert.equal(await box.changeStored('u1', key, { status: 3 }), false);
  // A change it cannot follow says why, by its outline, never its words.
  await assert.rejects(box.changeStored('u1', key, { message: { pollUpdateMessage: { vote: 'x' } } }), /unknown change \(message; pollUpdateMessage\)/);
  await assert.rejects(box.changeStored('u1', key, { message: { editedMessage: { message: { stickerMessage: {} } } } }), /edit has no text \(stickerMessage\)/);
  assert.match(src, /sock\.ev\.on\("messages\.update"[\s\S]{0,200}_sentIds\.has\(key\?\.id\)[\s\S]{0,200}changeStored\(_ownerUserId, key, update\)/, 'Closedhand\'s own messages, edited as it writes, are left alone');
});

// An edit made in WhatsApp's own app comes sealed with the secret its message
// carried, which the library cannot open, so it went unread. Sealed here by
// hand (HKDF as two HMAC steps, independent of the code under test), it opens
// under whichever name WhatsApp gave the sender and the stored copy follows.
test('an edit sealed with its message\'s secret is opened and the stored copy follows it', async () => {
  const crypto = require('node:crypto');
  // The library is not installed for checks; its protobuf is stood in for by JSON.
  const proto = { Message: { encode: (m) => ({ finish: () => Buffer.from(JSON.stringify(m)) }), decode: (b) => JSON.parse(Buffer.from(b).toString()),
    SecretEncryptedMessage: { SecretEncType: { UNKNOWN: 0, EVENT_EDIT: 1, MESSAGE_EDIT: 2 } } } };
  const src = fs.readFileSync(path.join(__dirname, '../lib/platforms/whatsapp-linked.js'), 'utf8');
  const take = (start) => { const at = src.indexOf(start); return src.slice(at, src.indexOf('\n}\n', at) + 3); };
  const secret = crypto.randomBytes(32);
  const seal = (plain, id, who) => {
    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
    const key = crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(id + who + who + 'Message Edit'), Buffer.from([1])])).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return { encPayload: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]), encIv: iv };
  };
  const plain = proto.Message.encode({ editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'ORIG1', fromMe: true }, editedMessage: { conversation: 'pick up at six' } } } } }).finish();
  const changes = [];
  const box = {
    require: (name) => name === '@whiskeysockets/baileys' ? { proto } : require(path.join(__dirname, '../lib/platforms', name)),
    _sentIds: new Set(['MINE1']), _sock: { user: { id: '447700900222:51@s.whatsapp.net', lid: '99887766:51@lid' } }, _ownerUserId: 'u1',
    changeStored: async (u, key, update) => { changes.push({ u, key, update }); return true; },
    console: { log: () => {} }, Date, Buffer, Error, Number,
  };
  vm.runInNewContext(take('function unwrap(') + take('function bareJid(') + 'const _secrets = new Map();\nconst SECRET_KEEP_MS = 20 * 60 * 1000;\n'
    + take('function keepSecret(') + take('async function followSecretEdit(') + '\nthis.keepSecret = keepSecret; this.followSecretEdit = followSecretEdit;', box);
  const edit = (target, sealed) => [{ key: { remoteJid: 'friend@lid', fromMe: true, id: 'EDIT1' }, messageTimestamp: 1795000000 },
    { targetMessageKey: target, secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT, ...sealed }];
  box.keepSecret('ORIG1', secret, Date.now());
  await box.followSecretEdit(...edit({ id: 'ORIG1', fromMe: true, remoteJid: 'friend@lid' }, seal(plain, 'ORIG1', '99887766@lid')));
  assert.equal(changes.length, 1, 'opened under the private id');
  assert.equal(changes[0].key.id, 'ORIG1');
  assert.deepEqual(JSON.parse(JSON.stringify(changes[0].update.message.editedMessage.message)), { conversation: 'pick up at six' });
  box.keepSecret('ORIG2', secret, Date.now());
  const plain2 = proto.Message.encode({ conversation: 'six thirty' }).finish();
  await box.followSecretEdit(...edit({ id: 'ORIG2', fromMe: true }, seal(plain2, 'ORIG2', '447700900222@s.whatsapp.net')));
  assert.equal(changes.length, 2, 'and under the number, an edit sealed as bare content too');
  assert.equal(changes[1].key.remoteJid, 'friend@lid', 'the chat comes from the edit when the target does not name it');
  // Not kept (too old to edit, or sent before a restart), Closedhand's own, or the wrong secret: nothing changes.
  box.keepSecret('OLD1', secret, Date.now() - 21 * 60 * 1000);
  await box.followSecretEdit(...edit({ id: 'OLD1', fromMe: true }, seal(plain2, 'OLD1', '99887766@lid')));
  box.keepSecret('MINE1', secret, Date.now());
  await box.followSecretEdit(...edit({ id: 'MINE1', fromMe: true }, seal(plain2, 'MINE1', '99887766@lid')));
  box.keepSecret('ORIG3', crypto.randomBytes(32), Date.now());
  await box.followSecretEdit(...edit({ id: 'ORIG3', fromMe: true }, seal(plain2, 'ORIG3', '99887766@lid')));
  assert.equal(changes.length, 2);
  assert.match(src, /keepSecret\(msg\.key\.id, [^\n]*messageSecret/, 'every message\'s secret is kept as it arrives');
  assert.match(src, /if \(m\.secretEncryptedMessage\) \{ await followSecretEdit\(msg, m\.secretEncryptedMessage\); continue; \}/);
});

// A message sent from the person's phone comes wrapped for their other devices
// with its secret on the wrapper, which the library drops, so no edit to it
// could be opened. The secret is copied inside as the message is opened.
test('a message sent from the phone keeps its secret once unwrapped', async () => {
  const proto = { Message: { encode: (m) => ({ finish: () => Buffer.from(JSON.stringify(m)) }), decode: (b) => JSON.parse(Buffer.from(b).toString()) } };
  const unpadRandomMax16 = (b) => { const t = new Uint8Array(b); if (!t.length || t[t.length - 1] > t.length) throw new Error('bad pad'); return t.subarray(0, t.length - t[t.length - 1]); };
  const src = fs.readFileSync(path.join(__dirname, '../lib/platforms/whatsapp-linked.js'), 'utf8');
  const take = (start) => { const at = src.indexOf(start); return src.slice(at, src.indexOf('\n}\n', at) + 3); };
  const box = { require: (name) => { if (name === '@whiskeysockets/baileys') return { proto, unpadRandomMax16 }; throw new Error(name); }, Buffer };
  vm.runInNewContext(take('function secretInside(') + '\nthis.secretInside = secretInside;', box);
  const padded = (m) => Buffer.concat([Buffer.from(JSON.stringify(m)), Buffer.from([3, 3, 3])]);
  const open = (m) => box.secretInside(async (args) => { assert.equal(args.jid, 'friend@lid', 'the library\'s own call is passed through'); return padded(m); })({ jid: 'friend@lid' });
  const wrapped = { deviceSentMessage: { destinationJid: 'friend@lid', message: { conversation: 'pick up at six' } }, messageContextInfo: { messageSecret: 'S1' } };
  const out = await open(wrapped);
  const seen = proto.Message.decode(unpadRandomMax16(out));
  assert.equal(seen.deviceSentMessage.message.messageContextInfo.messageSecret, 'S1', 'the secret is inside, where the library looks');
  assert.equal(seen.deviceSentMessage.message.conversation, 'pick up at six');
  // Anything else passes through as it came.
  for (const m of [{ conversation: 'from someone else', messageContextInfo: { messageSecret: 'S2' } },
    { ...wrapped, deviceSentMessage: { message: { conversation: 'x', messageContextInfo: { messageSecret: 'S3' } } } },
    { deviceSentMessage: { message: { conversation: 'no secret' } } }]) {
    assert.deepEqual(await open(m), padded(m));
  }
  assert.deepEqual(await box.secretInside(async () => Buffer.from([9]))(), Buffer.from([9]), 'what cannot be read is left alone');
  assert.match(src, /repo\.decryptMessage = secretInside\(repo\.decryptMessage\.bind\(repo\)\)/, 'every message opened goes through it');
});
