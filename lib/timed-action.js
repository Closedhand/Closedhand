// A step fixed in advance and made at an exact moment. "Order the cab in
// three minutes" or "send this at 9:00 sharp" is one tool call that is fully
// known now. Set as a task, it woke an LLM at the moment, which then looked
// its tools up, asked for a yes and acted a minute or more late. Fixed, the
// call is checked and put to the person now, like any other change, and at
// its moment code makes it, on the second, with nothing left to decide.
//
// Only steps that are safe to agree to ahead of time: a tool of a server the
// person connected, a mail or message send, a calendar change. Paying, data
// going somewhere new and anything driven through a browser are judged on
// what the page shows at the time, so they stay a task for that moment.

const FIXABLE = new Set(["send_mail", "reply_to_mail", "gmail_send", "gmail_reply", "outlook_send", "outlook_reply", "whatsapp_send",
  "gmail_send_draft", "outlook_send_draft", "send_mail_draft",
  "gcal_create_event", "gcal_update_event", "gcal_delete_event", "outlook_cal_create_event", "outlook_cal_update_event", "outlook_cal_delete_event",
  "caldav_create_event", "caldav_update_event", "caldav_delete_event", "calendar_delete_event"]);

// The fixed step a call to add_schedule carries, if it carries one.
function wanted(block) {
  const action = block && block.type === "tool_use" && block.name === "add_schedule" && block.input ? block.input.action : null;
  return action && typeof action === "object" && !Array.isArray(action) ? action : null;
}

// Why this step cannot be fixed in advance, or null when it can.
function refusal(action, { isConnected = () => false } = {}) {
  const name = action && action.tool_name;
  if (!name || typeof name !== "string") return "action needs tool_name: the tool to call at that moment.";
  if (action.tool_input != null && (typeof action.tool_input !== "object" || Array.isArray(action.tool_input))) return "action.tool_input must be the tool's arguments, as an object.";
  if (isConnected(name) || FIXABLE.has(name)) return null;
  return `${name} cannot be fixed in advance. Only a connected server's tool, a mail or message send, or a calendar change can. For anything else leave action out and set a task for that moment, with a prompt saying what to do.`;
}

// The exact moment a one-off is for: so many minutes from when the person
// asked (not from when the tool happened to run), or the moment they named.
function moment(input, { now = Date.now(), askedAt = null } = {}) {
  if (input.in_minutes !== undefined) {
    const mins = Number(input.in_minutes);
    if (!Number.isFinite(mins) || mins < 0.1 || mins > 1440) return { error: "in_minutes must be between 0.1 and 1440." };
    const from = askedAt && now - askedAt >= 0 && now - askedAt < 30 * 60000 ? askedAt : now;
    const when = new Date(from + Math.round(mins * 60000));
    if (when.getTime() <= now) return { error: `That moment has already passed (${when.toISOString()}; now is ${new Date(now).toISOString()}). Say so, and ask whether to do it now.` };
    return { when };
  }
  if (input.run_at) {
    const when = new Date(String(input.run_at));
    if (isNaN(when.getTime())) return { error: "run_at must be ISO 8601 with a UTC offset, e.g. 2026-09-12T15:00:00+09:00." };
    if (when.getTime() < now - 60000) return { error: `run_at is in the past (${when.toISOString()}). Now is ${new Date(now).toISOString()}.` };
    return { when };
  }
  return { when: null };
}

function clock(date, zone) {
  try { return new Date(date).toLocaleString("en-GB", { timeZone: zone || undefined, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (_) { return new Date(date).toISOString(); }
}

// The card for the step, saying it is for later.
function cardFor(card, when, zone) {
  return `Set for ${clock(when, zone)}, not done now.\n\n${card}`;
}

// Makes the call. The same call the chat makes after a yes.
async function run(schedule, { userId, chatId, platform }) {
  const { tool_name: name, tool_input: given } = schedule.action || {};
  const input = { ...(given || {}), _userId: userId, _chatId: chatId, _platform: platform };
  try {
    const { isInternalTool, handleInternalTool } = require("./tools/handlers");
    const result = isInternalTool(name) ? await handleInternalTool(name, input) : await require("./mcp").callMCPTool(name, input);
    const failed = !result || result.error || result.isError;
    return { ok: !failed, result, error: failed ? String((result && (result.error || (result.isError && JSON.stringify(result.content)))) || "nothing came back").slice(0, 300) : null };
  } catch (e) {
    return { ok: false, result: null, error: String(e.message || e).slice(0, 300) };
  }
}

// What the person is told once it has been made, in one line.
function line(schedule, outcome, at, zone) {
  const what = String(schedule.name || "what you set").trim();
  const time = new Date(at).toLocaleTimeString("en-GB", { timeZone: zone || undefined, hour: "2-digit", minute: "2-digit" });
  return outcome.ok ? `Done at ${time}: ${what}.` : `I couldn't do this at ${time}: ${what}. ${outcome.error}`;
}

module.exports = { FIXABLE, wanted, refusal, moment, clock, cardFor, run, line };
