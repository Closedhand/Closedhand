// One message in a chat app that follows a turn while Closedhand works on it,
// so the wait never looks stuck: what Closedhand is doing, then the reply's
// words as they are written, and at the end the reply itself, in the same
// bubble. A chat app shows a message whole or not at all, so the message is
// sent once and edited as things change, never faster than the app takes
// kindly. Linked WhatsApp uses it (lib/platforms/whatsapp-linked.js).
//
//   send(text) -> what was sent        edit(sent, text)        remove(sent)
//
// Words still being written end in an ellipsis, a step is in italics: neither
// reads as the finished reply, which takes their place unmarked.
const { shownSoFar } = require("./reply-as-written");

const MOST = 3500; // of a reply still being written; the finished one is the caller's to fit

function create({ send, edit, remove = null, thinkAfter = 2500, wordsFrom = 40, gap = 1300, now = Date.now }) {
  let sent = null, going = null, showing = "", timer = null, lastAt = 0;
  let step = "", words = "", waited = false, closed = false;
  const wanted = () => (words.length >= wordsFrom ? shownSoFar(words).slice(0, MOST) + " …" : step ? `_${step}…_` : waited ? "_Thinking…_" : "");

  function flush() {
    timer = null;
    if (closed || going) return;
    const text = wanted();
    if (!text || text === showing) return;
    showing = text;
    lastAt = now();
    going = (sent ? Promise.resolve(edit(sent, text)) : Promise.resolve(send(text)).then((s) => { sent = s || null; }))
      .catch(() => {})
      .finally(() => { going = null; if (!closed && wanted() !== showing) touch(); });
  }
  function touch() {
    if (closed || timer) return;
    timer = setTimeout(flush, Math.max(0, lastAt + gap - now()));
  }
  // Nothing to say for a while still gets a sign of life.
  const patience = setTimeout(() => { waited = true; touch(); }, thinkAfter);

  return {
    // What Closedhand has started doing ("Searching your email").
    step(description) { step = String(description || "").replace(/[\s.…]+$/, ""); waited = true; touch(); },
    // More of the reply's words, as written.
    words(text) { words += String(text || ""); touch(); },
    // What was written was not the reply: back to what Closedhand is doing.
    reset() { words = ""; touch(); },
    // The turn is over. With the reply's text, the message becomes it: true
    // when it did, false when the caller should send the reply itself (no
    // message was ever sent, or it could not be changed and was taken away).
    // With nothing, the message is taken away.
    async finish(text) {
      closed = true;
      clearTimeout(timer); clearTimeout(patience);
      if (going) await going;
      if (!sent) return false;
      if (text) {
        try { await edit(sent, text); return true; } catch (_) { /* taken away below */ }
      }
      if (remove) await Promise.resolve(remove(sent)).catch(() => {});
      return false;
    },
  };
}

module.exports = { create };
