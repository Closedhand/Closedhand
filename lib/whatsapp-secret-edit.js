// An edit made in WhatsApp's own app comes sealed a second time, as a
// secretEncryptedMessage, with a key made from the secret the edited message
// carried. The library Closedhand links WhatsApp through cannot open it, so
// the edit went unread and the stored copy kept the words first sent. This
// opens it the way whatsmeow does (msgsecret.go, generateMsgSecretKey with
// "Message Edit"): HKDF-SHA256 of that secret over the message id, who sent
// it and who edited it, then AES-256-GCM, with nothing else authenticated.
const crypto = require("crypto");

function openEdit({ secret, id, sender, editor, payload, iv }) {
  const info = Buffer.from(String(id) + sender + editor + "Message Edit");
  const key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), info, 32));
  const data = Buffer.from(payload);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

// Only a message's own sender can edit it, but WhatsApp may name that person
// by number or by private id on either side, so each pairing is tried; only
// the right one opens (the seal fails on any other).
function openEditByAnyName({ secret, id, names, payload, iv }) {
  const tried = [...new Set((names || []).filter(Boolean))];
  for (const sender of tried) for (const editor of tried) {
    try { return openEdit({ secret, id, sender, editor, payload, iv }); } catch (_) { /* not this pairing */ }
  }
  return null;
}

module.exports = { openEdit, openEditByAnyName };
