// One card for a step. When a step holds several changes that each wait for
// the person's yes (six events to delete, a message to each of three people),
// they go on one card, numbered, and one yes does them all: asked one by one,
// "clear my Friday" took six yeses, and each of them cost a round with the
// LLM. A single change keeps its card word for word.

// Any card's own "Reply yes or no" sentence, wherever it stands in it.
const REPLY = /[ \t]*Reply "yes" to [^\n]*?"no" to [^\n.]*\.[ \t]*/g;

// What a card says it would do, without its opening and its question.
function body(card) {
  const said = String(card || "").replace(REPLY, "").replace(/^\s*Just to confirm[,:]\s*/, "")
    .replace(/^I'm about to (\p{L})/u, (_, c) => c.toUpperCase()).replace(/\n{3,}/g, "\n\n").trim();
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : said;
}

function together(cards) {
  const list = (cards || []).filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  const n = list.length;
  return `Just to confirm, ${n} things:\n\n${list.map((c, i) => `${i + 1}. ${body(c)}`).join("\n\n")}\n\nReply "yes" to do all ${n}, or "no" to cancel them.`;
}

module.exports = { together, body };
