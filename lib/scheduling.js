// lib/scheduling.js — Cron scheduling engine

const cron = require("node-cron");
const ctx = require("./context");
const { getUserLLMClient } = require("./llm");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("./storage");
const { UserStore } = require("../user-store");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool, warmUserMcp } = require("./mcp");
const { getUserMcpToolDefs } = require("./user-mcp");
const spendGuard = require("./spend-guard");
const outboundGuard = require("./outbound-guard");
const sendGate = require("./send-gate");
// Lazy require to avoid circular dep (engine.js → confirmation.js → engine.js)
// These are only called at runtime, not at require time
function _getAllTools() { return require("./engine").getAllTools(); }
function _buildSystemPrompt() { const e = require("./engine"); return e.buildSystemPrompt() + e.buildVolatileSystemTail(); }

const { peek } = require("./log-text");
const oneOffs = require("./one-off-reminders");
const { isDatedOneOff } = oneOffs;
// The schedules running at this moment, by name.
const firing = new Set();

// The one-offs whose time came while Closedhand was not running (`why` "off")
// or its computer was asleep ("asleep"). A reminder that never ran is sent
// now, late, saying when it was due and why. One that had run is only
// retired; so is a task, which acts for the person and is not started at
// another time than the one they set.
async function catchUp(schedules, before, why) {
  const { supabase } = require("./db");
  for (const { schedule, due } of oneOffs.passed(schedules, { before, skip: firing })) {
    if (ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
    if (schedule.last_run || schedule.kind === "task") {
      if (await oneOffs.retire(supabase, schedule._userId, schedule.name)) console.log(`[reminders] the one-off ${peek(schedule.name)} was due ${due.toISOString()}; retired`);
      continue;
    }
    console.log(`[reminders] ${peek(schedule.name)} was due ${due.toISOString()}; sending it late`);
    await fire(schedule, { late: { due, why } });
  }
}
// A minute on: the chat apps are connected by then, and anything due at that
// very moment has started and is left alone.
function catchUpSoon(load, before, why) {
  const timer = setTimeout(() => Promise.resolve().then(load).then((schedules) => catchUp(schedules, before, why))
    .catch((e) => console.error("[reminders] catching up failed:", e.message)), 60000);
  if (timer.unref) timer.unref();
}

function registerSchedule(schedule) {
  if (!schedule.enabled) return;
  if (ctx.cronJobs[schedule.name]) {
    ctx.cronJobs[schedule.name].stop();
  }

  console.log(`Registering schedule: ${peek(schedule.name)} (${schedule.cron})`);

  // Fire in the timezone the schedule was created in (server runs UTC).
  // A schedule saved without one fires in the computer's own zone.
  const cronOpts = { timezone: schedule.timezone || require("./timezone").DEFAULT_TZ };
  ctx.cronJobs[schedule.name] = cron.schedule(schedule.cron, () => fire(schedule), cronOpts);
}

// What the model is told a reminder's turn is.
const REMINDER_FRAME = "[Scheduled task firing. Whatever you write as your final reply is delivered straight to the user's chat by the scheduler itself: never use a send tool or a raw API to reach them. If it is a reminder to go somewhere and you know the address, end with a map link on its own line: https://www.google.com/maps/search/?api=1&query= followed by the address, URL-encoded.]";
// And one sent late: when it was due and what time it is now, so what it was
// for is said as passed or as still to come, whichever is true by now.
function lateFrame(late, zone) {
  const { eventWhen } = require("./timezone");
  return REMINDER_FRAME.slice(0, -1) + ` This reminder is firing late. It was due ${eventWhen(late.due.toISOString(), zone)} and it is now ${eventWhen(new Date().toISOString(), zone)} (${zone}). Your reply goes out under a line that already says when it was due and why it is late, so do not say that again. Write it for now: what has passed is said as passed, and what is still to come as still to come.]`;
}

// Runs a schedule now. `late` ({ due, why }) when its time came while
// Closedhand was not running or its computer was asleep.
async function fire(schedule, { late = null } = {}) {
  console.log(`Schedule firing: ${peek(schedule.name)}`);
  const targetChatId = schedule._chatId;
  const targetUserId = schedule._userId;
  if (!targetChatId || !targetUserId) {
    console.error(`Schedule ${peek(schedule.name)}: missing chat/user ID, skipping`);
    return;
  }
  firing.add(schedule.name);
  try {
    // Under the user mutex: own context bubble + serialized against the
    // user's live chat so a firing schedule can't interleave with it.
    const { acquireUserMutex } = require("./user-mutex");
    await acquireUserMutex(targetUserId, async () => {
      const userStore = await UserStore.load(targetUserId);
      swapToCloudStore(userStore, targetUserId, targetChatId);
      // Reply where the schedule was set up. A schedule with no platform
      // recorded used to assume Telegram, which on an install without
      // Telegram meant a crash at delivery; fall back to the user's first
      // linked chat instead.
      // Reply where it was asked for. Only when that cannot be told (an old
      // row with no platform and a chat id that is not the web chat) fall
      // back to the user's delivery setting, the one Pulse and agent results
      // use, then to their first linked app.
      let deliverPlatform = schedule._platform;
      if (!deliverPlatform && targetChatId === targetUserId) deliverPlatform = "web";
      if (!deliverPlatform) {
        try {
          const ps = userStore?.profile?.settings?.pulse_settings || {};
          const preferred = ps.deliveryPlatforms || userStore?.profile?.settings?.deliveryPlatforms || [];
          const { data: links } = await require("./db").supabase.from("chat_links").select("platform").eq("user_id", targetUserId);
          const have = new Set((links || []).map((l) => l.platform));
          deliverPlatform = preferred.find((p) => have.has(p)) || (links && links[0] && links[0].platform) || (ctx.bot ? "telegram" : "web");
        } catch { deliverPlatform = ctx.bot ? "telegram" : "web"; }
      }
      try {
        // Cancelled from the dashboard since it was set: the row says so,
        // and this timer, which lives only in memory, stops here.
        const { data: still } = await require("./db").supabase.from("schedules").select("enabled, archived_at")
          .eq("user_id", targetUserId).eq("name", schedule.name).maybeSingle();
        if (still && (still.enabled === false || still.archived_at)) {
          if (ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
          console.log(`Schedule ${peek(schedule.name)}: cancelled, not run`);
          return;
        }
        // A task set for a time runs as a task: it shows under Tasks and
        // delivers its answer to this chat itself.
        if (schedule.kind === "task") {
          await require("./agents").startAgent(targetUserId, deliverPlatform, targetChatId, schedule.prompt, null);
          const once = schedule.run_once === true || (schedule.run_once == null && isDatedOneOff(schedule.cron));
          const { error: ranError } = await require("./db").supabase.from("schedules").update({ last_run: new Date().toISOString(), ...(once ? { enabled: false, archived_at: new Date().toISOString() } : {}) })
            .eq("user_id", targetUserId).eq("name", schedule.name);
          if (ranError) console.error(`Schedule ${peek(schedule.name)}: could not record that it started:`, ranError.message);
          if (once && ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
          console.log(`Schedule ${peek(schedule.name)}: started as a task`);
          return;
        }
        const zone = schedule.timezone || require("./timezone").DEFAULT_TZ;
        const lateLine = late ? oneOffs.lateLine(late.due, zone, late.why) : null;
        const response = await runScheduledPrompt(schedule.prompt, targetUserId, targetChatId, deliverPlatform, late ? { frame: lateFrame(late, zone) } : {});
        // Reply where the schedule was set up, not always on Telegram. The
        // header is a human label, not schedule.name: a message opening with
        // "[supplier-sample-colours-v2]" reads as machinery leaking (2026-08-13).
        const { sendToPlatform } = require("./messaging");
        await sendToPlatform(deliverPlatform, targetChatId, late ? `[Late reminder]\n\n${lateLine}\n\n${response}` : `[Reminder]\n\n${response}`);

        // Record what was sent, or the conversation has no trace of it and
        // the next thing the user says about this message meets an assistant
        // that does not know it sent anything.
        const { getConversation } = require("./conversation");
        getConversation(targetUserId).push({ role: "assistant", content: late ? `[Scheduled reminder "${schedule.name}" fired late. ${lateLine}] ${response}` : `[Scheduled reminder "${schedule.name}" fired] ${response}` });

        // Save any changes made during the scheduled task
        saveStore();

        // Record that it ran. Nothing wrote this before, so a schedule that
        // never fired and one that fired every day looked identical, and
        // there was no way to answer "did that actually happen".
        const { supabase } = require("../user-store");
        await supabase.from("schedules")
          .update({ last_run: new Date().toISOString() })
          .eq("user_id", targetUserId).eq("name", schedule.name);

        // A one-off written as cron is still cron, and cron has no year, so
        // "03:10 on 28 July" quietly means every 28 July for ever. If the
        // date is pinned to a single day and month, it was meant to happen
        // once, so retire it rather than leave it sitting in Upcoming
        // waiting to surprise someone in twelve months.
        // What it was created as, and only guessing for schedules made
        // before the flag existed. Guessing alone would delete a genuine
        // annual reminder after its first year.
        const oneOff = schedule.run_once === true
          || (schedule.run_once == null && isDatedOneOff(schedule.cron));
        if (oneOff) {
          // Archive rather than delete: the user should be able to look
          // back at what ran and when, especially since a schedule acts on
          // their behalf. Registration only loads enabled rows, so an
          // archived one can never fire again or come back on reboot.
          await supabase.from("schedules")
            .update({ enabled: false, archived_at: new Date().toISOString() })
            .eq("user_id", targetUserId).eq("name", schedule.name);
          if (ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
          console.log(`Schedule ${peek(schedule.name)}: one-off, archived after running`);
        }
      } finally {
        cleanupUserContext();
      }
    });
  } catch (error) {
    console.error(`Schedule error (${peek(schedule.name)}):`, error.message, "\n", String(error.stack || "").split("\n").slice(1, 5).join("\n"));
    // A late reminder whose chat app could not be reached is left as it was,
    // and tried again when Closedhand next starts or its computer next wakes.
    if (late && error.notSent) return;
    // Same delivery rule as the success path: the chat the schedule lives
    // in, not always Telegram, and a sentence rather than an internal tag.
    try {
      const { sendToPlatform } = require("./messaging");
      await sendToPlatform(schedule._platform || "telegram", targetChatId, `Your reminder "${schedule.name}" hit an error: ${error.message}`);
    } catch (_) {}
    // A one-off whose run failed is over: left enabled, it would be taken at
    // the next start for one that was never tried, and sent late as if
    // Closedhand had not been running.
    if (!late && oneOffs.isOneOff({ run_once: schedule.run_once, cron: schedule.cron })) {
      await oneOffs.retire(require("./db").supabase, targetUserId, schedule.name).catch(() => false);
      if (ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
    }
  } finally {
    firing.delete(schedule.name);
  }
}

function registerAllSchedules() {
  const everySchedule = () => UserStore.getActiveUsers().then((users) => users.flatMap((user) => user.schedules));
  // After the computer wakes, what came due while it slept did not run.
  require("./sleep-watch").onWake(() => { const woke = new Date(); catchUpSoon(everySchedule, woke, "asleep"); });
  UserStore.getActiveUsers().then((users) => {
    let schedCount = 0;
    const started = new Date();
    const missed = [];

    for (const user of users) {
      for (const schedule of user.schedules) {
        // A one-off whose time has gone is not registered: cron has no year,
        // so its timer would be for that date twelve months on.
        if (oneOffs.passedAt(schedule, started)) { missed.push(schedule); continue; }
        registerSchedule(schedule);
        schedCount++;
      }
    }
    if (missed.length) catchUpSoon(() => missed, started, "off");

    console.log(`Startup: registered ${schedCount} schedules across ${users.length} users.`);
  }).catch((err) => {
    console.error("Failed to load active users on startup:", err.message);
  });
}

// frame: what the model is told this turn is, in place of a reminder's (a
// connected service's job finishing, lib/tool-waits.js).
async function runScheduledPrompt(prompt, userId, chatId = null, platform = null, { frame = null } = {}) {
  return require("./task-model").withTaskRun({ userId, taskId: require("crypto").randomUUID(), kind: "reminder" }, () => runScheduledPromptLoop(prompt, userId, chatId, platform, frame));
}
async function runScheduledPromptLoop(prompt, userId, chatId = null, platform = null, frame = null) {
  // The framing matters: without it a task prompt like "Remind Sam
  // (WhatsApp) to ..." reads as an instruction to go and operate WhatsApp,
  // and the model burns its iterations on raw graph.facebook.com calls
  // instead of writing the reminder (2026-08-13).
  // A reminder to be somewhere ends with a map link, so the next step is one
  // tap from the message rather than a search.
  const messages = [{ role: "user", content: `${frame || REMINDER_FRAME}\n\n${prompt}` }];
  await warmUserMcp(userId);
  const tools = [..._getAllTools(), ...getUserMcpToolDefs(userId)];
  // On-demand tools (the sandbox browser among them) are listed by name in
  // the prompt and unlocked by get_tool_details; the chat engine adds the
  // unlocked schema to its next call, and this loop has to do the same or a
  // scheduled task can see a tool and never call it.
  const { INTERNAL_TOOLS } = require("./tools/definitions");
  const unlockTool = (name) => {
    if (tools.find((t) => t.name === name)) return;
    const def = INTERNAL_TOOLS.find((t) => t.name === name);
    if (def) tools.push({ name: def.name, description: def.description, input_schema: def.input_schema });
    else { const m = getUserMcpToolDefs(userId).find((t) => t.name === name); if (m) tools.push(m); }
  };
  const { client: llm, model: defaultModel } = getUserLLMClient(userId);

  let maxIterations = 10;
  while (maxIterations > 0) {
    maxIterations--;

    const apiParams = {
      model: defaultModel,
      max_tokens: 4096,
      system: _buildSystemPrompt(),
      messages: messages,
    };
    if (tools.length > 0) apiParams.tools = tools;

    const response = await require("./agent-context").createAgentResponse(llm, apiParams, ctx.activeUserStore?.profile?.settings?.llm_provider);

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let result;
          // A send, or a connected server's action, waits for the person's
          // yes as it would in the chat (lib/send-gate.js); mail goes only to
          // an address that came from somewhere (lib/recipient-guard.js).
          const madeUp = await require("./recipient-guard").check(userId, block.name, block.input, messages);
          const held = madeUp ? null : await sendGate.unattended(block.name, block.input, userId, ctx.activeUserStore);
          if (madeUp) result = { error: madeUp };
          else if (held) {
            result = held.refuse ? { error: held.refuse } : await spendGuard.holdForUser({ userId, platform, chatId, toolName: block.name,
              toolInput: held.isInternal ? { ...block.input, _userId: userId, _chatId: chatId, _platform: platform } : block.input,
              verdict: { card: held.card, ledgerId: null, what: "needs your yes first" }, source: "scheduled", label: "A scheduled task", extra: { isInternal: held.isInternal } });
          } else if (isInternalTool(block.name)) {
            // Same identity injection as every other tool-executing path
            // (engine, agents, automations). Without it search_cache ran with
            // userId=undefined here, every lookup failed, and the model
            // flailed until the iteration cap (2026-08-13).
            const schedInput = { ...block.input, _userId: userId, _chatId: chatId, _platform: platform };
            const schedIntent = spendGuard.spendIntent(block.name, schedInput);
            let outbound = null;
            if (schedIntent) {
              // Money: ask the user in chat and carry on; yes runs the held call.
              const page = block.name === "sandbox_browse" ? await spendGuard.readCheckout(userId, schedIntent.at, block.input) : spendGuard.lastPage(userId);
              const verdict = await spendGuard.assess({ userId, userStore: ctx.activeUserStore, toolName: block.name, source: "scheduled", intent: schedIntent, page });
              if (verdict.action === "refuse") result = { error: verdict.message };
              else if (verdict.action === "allow") {
                result = await handleInternalTool(block.name, schedInput);
                await spendGuard.ledgerUpdate(verdict.ledgerId, { status: result && result.error ? "failed" : "completed" });
              } else {
                result = await spendGuard.holdForUser({ userId, platform, chatId, toolName: block.name, toolInput: schedInput, verdict, source: "scheduled", label: "A scheduled task" });
              }
            } else if ((outbound = await outboundGuard.outboundCheck(block.name, schedInput, ctx.activeUserStore))) {
              const ob = outbound;
              result = await spendGuard.holdForUser({ userId, platform, chatId, toolName: block.name, toolInput: schedInput, verdict: { card: outboundGuard.card(ob), ledgerId: null }, source: "scheduled", label: "A scheduled task", extra: { outbound: { host: ob.host } } });
            } else {
              result = await handleInternalTool(block.name, schedInput);
            }
            if (result && result.error) console.log(`[tool-error] scheduled ${block.name}: ${String(result.error).substring(0, 200)}`);
            if (block.name === "get_tool_details" && result && !result.error && result.name) unlockTool(result.name);
          } else {
            console.log(`  [scheduled] Calling tool: ${block.name}`);
            result = await callMCPTool(block.name, block.input);
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result.content || result),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    let finalText = "";
    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    return finalText;
  }

  // Out of iterations mid-tool-chatter. What reaches the user must still be
  // the content of their reminder, never a status line about tool loops, so
  // ask for the wrap-up from what was already gathered, tools ignored.
  try {
    const wrap = "You are out of tool budget. Do not call any more tools. Write the final message for the user now from what you already have; if something could not be verified, say so briefly inside the message.";
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: wrap });
    else messages.push({ role: "user", content: wrap });
    const finalResp = await require("./agent-context").createAgentResponse(llm, {
      model: defaultModel, max_tokens: 4096, system: _buildSystemPrompt(), messages,
    }, ctx.activeUserStore?.profile?.settings?.llm_provider);
    let text = "";
    for (const block of finalResp.content) if (block.type === "text") text += block.text;
    if (text.trim()) return text.trim();
  } catch (e) {
    console.error(`Scheduled wrap-up call failed: ${e.message}`);
  }
  // Even the wrap-up failed: the task text itself is the least the user
  // should get, since for a reminder it IS the reminder.
  return `I had trouble putting this reminder together, so here it is as it was written:\n\n${prompt.substring(0, 600)}`;
}

module.exports = { registerSchedule, registerAllSchedules, runScheduledPrompt, isDatedOneOff };
