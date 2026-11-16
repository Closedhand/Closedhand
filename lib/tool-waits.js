// lib/tool-waits.js: a connected service's job that takes a while, checked
// without holding up the chat.
//
// A video, a song, a long transcription or an export: the service starts it
// and gives back an id to check it by. Rather than call that check again and
// again while the person waits, the model hands it to wait_for_result
// (lib/tools/handlers.js). Closedhand then calls the check itself every so
// often, in the background, and once the job has finished, failed or run past
// its time, carries on in the chat it was asked in: the model gets what the
// service last said, tells the person, and sends any file it made (send_file
// with its link), kept with the conversation like a file sent in a reply.
// Nothing here knows any one service: whether a job is still going is read
// from the words of the service's own answer. Waits are kept in the settings,
// so a restart picks them up again.

const ctx = require("./context");

const KEY = "tool_waits";
const MOST = 10;
const TICK_MS = 10000;

// A service's word for where its job is.
const GOING = /^(pending|queued|in[_ -]?queue|in[_ -]?progress|running|processing|starting|started|throttled|waiting|generating|submitted|scheduled|dreaming|streaming|created|accepted)$/i;
const FAILED = /^(failed|failure|error|errored|cancell?ed|rejected|expired|timed[_ -]?out|aborted)$/i;
// In plain text, with no field for it.
const GOING_WORDS = /\b(pending|queued|in progress|in_progress|in_queue|still running|processing|throttled|generating)\b/i;
const DONE_WORDS = /\b(succeeded|completed?|finished|done|ready)\b/i;

// The text of a service's answer, and anything structured in it.
function textOf(result) {
  return require("./connection-jobs").textOf(result);
}

// "going", "failed" or "done", from the answer's own status field, else its
// words. An answer that says nothing of the kind counts as done, so the model
// reads it and decides, and can wait again.
function stateOf(result) {
  if (result?.isError) return "failed";
  const text = textOf(result);
  let tree = result?.structuredContent || null;
  if (!tree) { try { tree = JSON.parse(text); } catch { tree = null; } }
  const said = [];
  (function walk(v, depth) {
    if (!v || typeof v !== "object" || depth > 4) return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /^(status|state|phase|stage)$/i.test(k)) said.push(x.trim());
      else if (typeof x === "object") walk(x, depth + 1);
    }
  })(tree, 0);
  if (said.some((s) => FAILED.test(s))) return "failed";
  if (said.some((s) => GOING.test(s))) return "going";
  if (said.length) return "done";
  return GOING_WORDS.test(text) && !DONE_WORDS.test(text) ? "going" : "done";
}

async function settingsOf(userId, deps) {
  if (deps.settings) return deps.settings(userId);
  const { data, error } = await require("./db").supabase.from("profiles").select("settings").eq("id", userId).single();
  if (error) throw new Error(error.message);
  return data?.settings || {};
}
// Changes the waits as they are now, read afresh, so a wait added while a
// check was running is never written over.
async function update(userId, change, deps) {
  const list = change((await settingsOf(userId, deps))[KEY] || []);
  if (deps.keep) return deps.keep(userId, list);
  await require("./settings-patch").patchSettings(require("./db").supabase, userId, list.length ? { set: { [KEY]: list } } : { unset: [KEY] });
}

// A wait the model asked for. Returns the wait, or throws a sentence for it.
async function add(userId, { tool, input = {}, about, every_seconds = 20, give_up_after_minutes = 20, chatId, platform }, deps = {}) {
  const userMcp = deps.userMcp || require("./user-mcp");
  const at = userMcp.connectionOf(userId, tool);
  if (!at) throw new Error(`no connected service has a tool called ${tool}`);
  // Only a look at the job, never an action, is made again and again.
  if (userMcp.needsMcpConfirmation(userId, tool)) throw new Error(`${tool} changes something, so it can't be called again and again; only a tool that reports on a job can`);
  if (!chatId) throw new Error("there is no chat to carry on in");
  const now = (deps.now || Date.now)();
  const every = Math.min(300, Math.max(10, Number(every_seconds) || 20));
  const minutes = Math.min(60, Math.max(1, Number(give_up_after_minutes) || 20));
  const wait = {
    id: require("crypto").randomUUID(), tool, input: input && typeof input === "object" ? input : {},
    about: String(about || "the job").slice(0, 160), server: at.server,
    every, until: new Date(now + minutes * 60000).toISOString(), next: new Date(now + every * 1000).toISOString(),
    chatId: String(chatId), platform: platform || "web", started: new Date(now).toISOString(),
  };
  if (((await settingsOf(userId, deps))[KEY] || []).length >= MOST) throw new Error(`Closedhand is already waiting on ${MOST} jobs`);
  await update(userId, (list) => [...list, wait], deps);
  return wait;
}

// What the model is told when it carries on, by how the wait ended.
function promptFor(wait, how, text) {
  const ended = how === "done" ? "has finished" : how === "failed" ? "has failed" : `hasn't finished after ${Math.round((Date.parse(wait.until) - Date.parse(wait.started)) / 60000)} minutes, so Closedhand has stopped checking`;
  return `The job you handed to wait_for_result ${ended}: ${wait.about}, with ${wait.server}. What ${wait.tool} last said:\n\n${String(text || "(nothing)").slice(0, 6000)}`;
}
const FRAME = "[A connected service's job you were waiting on has come to an end. Whatever you write as your final reply is delivered straight to the user's chat. If it made a file and gave a link to it, send them the file itself with send_file and its url before you reply; give the link only if that fails. If it failed or hasn't finished, say so plainly in a sentence or two, with the service's reason in plain words.]";

// Carries on in the chat the wait came from, as a reply would, under the
// person's mutex so it never interleaves with their own messages.
async function finish(userId, wait, how, text, deps = {}) {
  if (deps.finish) return deps.finish(userId, wait, how, text);
  const { acquireUserMutex } = require("./user-mutex");
  await acquireUserMutex(userId, async () => {
    const { UserStore } = require("../user-store");
    const { swapToCloudStore, saveStore } = require("./storage");
    const store = await UserStore.load(userId);
    swapToCloudStore(store, userId, wait.chatId);
    ctx.activePlatform = wait.platform;
    // Files sent while it carries on are kept on its message (one-chat.js).
    const marker = `[wait ${wait.id}]`;
    ctx.currentAsk[userId] = marker;
    try {
      const { getConversation } = require("./conversation");
      const conversation = getConversation(userId);
      const before = new Set(conversation);
      const reply = await require("./scheduling").runScheduledPrompt(promptFor(wait, how, text), userId, wait.chatId, wait.platform, { frame: FRAME });
      if (reply && reply.trim()) {
        await require("./messaging").sendToPlatform(wait.platform, wait.chatId, reply.trim());
        conversation.push({ role: "assistant", content: reply.trim() });
      }
      require("./one-chat").keepFiles(userId, marker, conversation, before);
      // Who can see what was asked for, once per service (lib/made-elsewhere.js).
      const elsewhere = await require("./made-elsewhere").take(userId, store.profile?.settings, { store }).catch(() => null);
      if (elsewhere) {
        await require("./messaging").sendToPlatform(wait.platform, wait.chatId, elsewhere);
        conversation.push({ role: "assistant", content: elsewhere });
      }
      saveStore();
    } finally {
      delete ctx.currentAsk[userId];
    }
  });
}

// One pass: each wait that is due is checked, and either waits again or ends.
let running = false;
async function tick(userId, deps = {}) {
  if (running) return 0;
  running = true;
  try {
    const now = (deps.now || Date.now)();
    const due = ((await settingsOf(userId, deps))[KEY] || []).filter((w) => Date.parse(w.next) <= now);
    let ended = 0;
    for (const wait of due) {
      let how, text = "";
      try {
        const userMcp = deps.userMcp || require("./user-mcp");
        // After a restart the connections are opened again first.
        let at = userMcp.connectionOf(userId, wait.tool);
        if (!at && userMcp.getUserMcpTools) { await userMcp.getUserMcpTools(userId).catch(() => {}); at = userMcp.connectionOf(userId, wait.tool); }
        if (!at) { how = "failed"; text = `${wait.server} isn't connected any more.`; }
        else {
          const result = await (deps.call || userMcp.callConnectionTool)(userId, at.rowId, at.tool, wait.input);
          how = stateOf(result);
          text = textOf(result);
        }
      } catch (e) {
        // A check that fails is tried again until the wait runs out.
        how = "going";
        text = `${wait.server} couldn't be asked: ${e.message}`;
      }
      if (how === "going" && now < Date.parse(wait.until)) {
        await update(userId, (list) => list.map((w) => (w.id === wait.id ? { ...w, next: new Date(now + w.every * 1000).toISOString() } : w)), deps);
        continue;
      }
      await update(userId, (list) => list.filter((w) => w.id !== wait.id), deps);
      ended++;
      await finish(userId, wait, how === "going" ? "late" : how, text, deps).catch((e) => console.error(`[tool-waits] couldn't carry on after ${wait.about}: ${e.message}`));
    }
    return ended;
  } finally {
    running = false;
  }
}

function start() {
  const run = () => tick(require("./admin").getAdminUserId()).catch((e) => console.error("[tool-waits] check:", e.message));
  setTimeout(run, 30000).unref?.();
  setInterval(run, TICK_MS).unref?.();
}

module.exports = { add, tick, stateOf, promptFor, start, KEY };
