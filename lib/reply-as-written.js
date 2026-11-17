// The reply's words as the LLM writes them (lib/model-wire.js, onText), for the
// chats that can show them while they come: the web chat, Telegram and linked
// WhatsApp each pass onStreamToken, and onStreamReset to take back what was
// shown. A turn is several requests to the LLM (one for each round of tool
// use, and now and then another try), and only the last one's words are the
// reply: what an earlier request wrote is taken back as tool use starts or
// the next request goes. What is shown this way is not yet the reply: the
// finished one, checked and set out (lib/engine.js), takes its place.
function create(opts) {
  if (typeof opts?.onStreamToken !== "function") return { options: () => ({}), reset() {} };
  let showing = false;
  const reset = () => {
    if (!showing) return;
    showing = false;
    try { if (opts.onStreamReset) opts.onStreamReset(); } catch (_) { /* the chat's own trouble */ }
  };
  return {
    // What to pass with one request to the LLM.
    options() {
      reset();
      return { onText(text) {
        // A reply never starts with space.
        const words = showing ? text : String(text || "").replace(/^\s+/, "");
        if (!words) return;
        showing = true;
        try { opts.onStreamToken(words); } catch (_) { /* the chat's own trouble */ }
      } };
    },
    reset,
  };
}

// What is shown of a reply still being written: no marks of Closedhand's own
// (a follow-on break shows as a paragraph, a tag it has only begun is held
// back) and no emdashes, as in the finished reply.
function shownSoFar(text) {
  return require("./plain-dashes").noEmDashes(String(text || "")
    .replace(/^[ \t]*\[\[next\]\][ \t]*$/gm, "")
    .replace(/\[\[[a-z]*\]?$/, "")
    .replace(/\n{3,}/g, "\n\n")).trimEnd();
}

module.exports = { create, shownSoFar };
