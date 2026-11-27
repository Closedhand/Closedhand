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

// A change a background task wants to make that the chat asks about first:
// anything but a read through a service's API or the sandbox gateway, a
// calendar event deleted or changed, a service disconnected, a thread handed
// over. A task once deleted a person's Gmail draft through the gateway
// without asking, as tasks paused only for sends, payments and new sites.
// The card says what in a line or two; null when nothing needs asking.
const CHANGES = new Set(["api_request", "sandbox_gateway", "outlook_cal_delete_event", "outlook_cal_update_event", "calendar_delete_event", "gcal_delete_event", "gcal_update_event", "caldav_delete_event", "caldav_update_event", "disconnect_service", "delegate_email_thread"]);
const SERVICE_NAMES = { google: "Google", microsoft: "Microsoft", shopify: "Shopify", slack: "Slack", notion: "Notion", github: "GitHub" };
const ASK = `\n\nReply "yes" to let it, or "no" to stop it.`;
function taskChangeCard(toolName, input = {}) {
  if (!CHANGES.has(toolName)) return null;
  if (toolName === "api_request" || toolName === "sandbox_gateway") {
    const method = String(input.method || "GET").toUpperCase();
    if (method === "GET") return null;
    const sent = typeof input.body === "object" ? JSON.stringify(input.body) : String(input.body || "");
    if (/graphql/i.test(input.url || "") && !/\bmutation\b/i.test(sent)) return null;
    let where = String(input.url || "");
    try { const u = new URL(where); where = u.host + u.pathname; } catch { /* shown as given */ }
    const verb = method === "DELETE" ? "delete something" : method === "POST" ? "create or change something" : "change something";
    const service = input.service && input.service !== "none" ? ` in your ${SERVICE_NAMES[input.service] || input.service} account` : "";
    return `Just to confirm: this task wants to ${verb}${service}:\n${method} ${where}${ASK}`;
  }
  const event = input.summary ? `, "${input.summary}"` : "";
  if (/delete_event$/.test(toolName)) return `Just to confirm: this task wants to delete a calendar event${event}.${ASK}`;
  if (/update_event$/.test(toolName)) return `Just to confirm: this task wants to change a calendar event${event}.${ASK}`;
  if (toolName === "disconnect_service") return `Just to confirm: this task wants to disconnect ${SERVICE_NAMES[input.service] || input.service || "a connection"}.${ASK}`;
  return `Just to confirm: this task wants to hand an email thread to ${input.to || input.delegate_to || "someone"}.${ASK}`;
}

module.exports = { together, body, taskChangeCard };
