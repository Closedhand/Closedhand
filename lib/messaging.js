// lib/messaging.js — sending to the chat apps (Telegram, WhatsApp as a linked
// device, the web chat) and by email: text, files, places, status lines.

const ctx = require("./context");

// --- Cross-platform file sending ---

async function sendTelegramDocument(chatId, buffer, filename) {
  await ctx.bot.sendDocument(chatId, buffer, {}, { filename });
}

// Deliver a file into web chat over the WebSocket. Web had no case at all in
// sendDocument, so it fell through to the telegram default and tried to send a
// web user's UUID to the Telegram API. That failure is what the user saw as
// "Drive send hit a chat glitch" while asking for a file on the site the
// product actually lives on.
// A file too big to push through the chat's connection goes as a link the
// browser downloads, to a working copy kept a day (lib/file-expiry.js).
async function sendWebDocument(chatId, buffer, filename, mimeType) {
  try {
    const { sendToUser } = require("./web-chat-ws");
    const MAX_WS_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_WS_BYTES) {
      const { uploadFile, UserStore } = require("../user-store");
      const userId = ctx.activeUserId;
      const id = `att_link_${Date.now()}`;
      const storagePath = await uploadFile(userId, id, buffer, mimeType || "application/octet-stream");
      await (await UserStore.load(userId)).saveAttachment({ id, fileName: filename, description: "Sent in the web chat",
        mediaType: mimeType || "application/octet-stream", storagePath, sizeBytes: buffer.length, direction: "working" });
      sendToUser(chatId, { type: "file", filename, mediaType: mimeType || "application/octet-stream", size: buffer.length, url: `/api/files/${encodeURIComponent(id)}/download` });
      return;
    }
    sendToUser(chatId, {
      type: "file",
      filename,
      mediaType: mimeType || "application/octet-stream",
      size: buffer.length,
      base64: buffer.toString("base64"),
    });
  } catch (e) {
    const { sendWebMessage } = require("./platforms/web");
    return sendWebMessage(chatId, `Couldn't attach ${filename} here: ${e.message}`);
  }
}

async function sendDocument(chatId, buffer, filename, mimeType, opts) {
  return sendDocumentToPlatform(ctx.activePlatform || "telegram", chatId, buffer, filename, mimeType, opts);
}

function sendTyping(chatId) {
  // Only Telegram shows "typing": the web chat has its own, and email and WhatsApp have none to send.
  if (ctx.activePlatform !== "telegram" && ctx.activePlatform) return Promise.resolve();
  return ctx.bot.sendChatAction(chatId, "typing").catch(() => {});
}

// --- Status feedback functions ---

function reactToMessage(chatId, messageId, emoji) {
  try {
    if (ctx.activePlatform === "telegram") {
      ctx.bot.setMessageReaction(chatId, messageId, {
        reaction: [{ type: "emoji", emoji }],
      }).catch(() => {});
    }
  } catch (e) {}
}

function removeReaction(chatId, messageId) {
  try {
    if (ctx.activePlatform === "telegram") {
      return ctx.bot.setMessageReaction(chatId, messageId, { reaction: [] }).catch(() => {});
    }
  } catch (e) {}
  return Promise.resolve();
}

async function sendStatusMessage(chatId, text) {
  try {
    if (ctx.activePlatform === "web") {
      // A status is for someone watching. With no tab open there is no one,
      // and saving it made a passing "Searching…" a permanent message.
      const { hasWebChatConnection, sendToUser } = require("./web-chat-ws");
      if (!hasWebChatConnection(chatId)) return null;
      sendToUser(chatId, { type: "status", content: text });
      return { platform: "web", chatId };
    }

    if (ctx.activePlatform === "telegram") {
      const sent = await ctx.bot.sendMessage(chatId, text);
      return { platform: "telegram", chatId, messageId: sent.message_id };
    }
  } catch (e) {}
  return null;
}

function deleteStatusMessage(statusInfo) {
  if (!statusInfo) return Promise.resolve();
  try {
    if (statusInfo.platform === "telegram") {
      return ctx.bot.deleteMessage(statusInfo.chatId, statusInfo.messageId).catch(() => {});
    }
  } catch (e) {}
  return Promise.resolve();
}

const TOOL_STATUS_MAP = [
  [/^search_cache/, "Searching your email"],
  [/^search_calendar/, "Checking your calendar"],
  [/^fetch_attachment/, "Downloading an attachment"],
  [/^(gmail_send_draft|outlook_send_draft|send_mail_draft)$/, "Sending the draft"],
  [/^gmail_send/, "Writing an email"],
  [/^whatsapp_send$/, "Sending a WhatsApp message"],
  [/^gmail_reply/, "Drafting a reply"],
  [/^gcal_create/, "Creating calendar event"],
  [/^gcal_delete/, "Removing calendar event"],
  [/^gcal_/, "Checking calendar"],
  [/^web_search/, "Searching the web"],
  [/^web_fetch/, "Reading a webpage"],
  [/^watch_video/, "Watching a video"],
  [/^maps_save_list/, "Saving places to Google Maps"],
  [/^weather_lookup/, "Checking weather"],
  [/^air_quality/, "Checking air quality"],
  [/^maps_/, "Looking up location"],
  [/^send_location/, "Sending location"],
  [/^tfl_/, "Checking transport"],
  [/^drive_/, "Searching your Drive"],
  [/^shopify_/, "Checking Shopify"],
  [/^meta_ads_/, "Checking Meta Ads"],
  [/^slack_/, "Checking Slack"],
  [/^pin_fact/, "Pinning a fact"],
  [/^get_facts/, "Checking Pinned Facts"],
  [/^bridge_calendar/, "Checking Mac Calendar"],
  [/^bridge_files/, "Accessing local files"],
  [/^bridge_shell/, "Running a command"],
  [/^bridge_browser/, "Checking browser"],
  [/^bridge_screenshot/, "Taking a screenshot"],
  [/^bridge_ax_/, "Reading app UI"],
  [/^bridge_input_/, "Interacting with screen"],
  [/^bridge_session_/, "Using terminal"],
  [/^list_connections/, "Checking connections"],
  [/^connect_service/, "Connecting a service"],
  [/^sandbox_/, "Using the sandbox computer"],
  [/^flight_/, "Checking flights"],
  [/^api_request/, "Querying a service"],
  [/^api_endpoints/, "Reading how a service works"],
  [/^pulse_/, "Running pulse check"],
];

const _statusCounts = {};
function toolStatusText(toolNames) {
  for (const name of toolNames) {
    for (const [pattern, text] of TOOL_STATUS_MAP) {
      if (pattern.test(name)) {
        _statusCounts[text] = (_statusCounts[text] || 0) + 1;
        // Don't repeat the same status text
        if (_statusCounts[text] > 1) return null;
        return text;
      }
    }
  }
  return null; // Don't show generic "Working on it" - it's not helpful
}
function resetToolStatus() { Object.keys(_statusCounts).forEach(k => delete _statusCounts[k]); }

// --- Cross-platform location pin sending ---

async function sendLocation(chatId, lat, lng, name, address) {
  switch (ctx.activePlatform) {
    case "telegram": {
      await ctx.bot.sendLocation(chatId, lat, lng);
      break;
    }
    case "whatsapp_linked": {
      const { sendLinkedLocation } = require("./platforms/whatsapp-linked");
      await sendLinkedLocation(chatId, lat, lng, name, address);
      break;
    }
    default: {
      // Anywhere else the caller sends the place as a link.
      throw new Error(`Unsupported platform for location: ${ctx.activePlatform}`);
    }
  }
}

function sendText(chatId, text) {
  if (ctx.activePlatform === "email") return require("./assistant-email").send(chatId, text);
  if (ctx.activePlatform === "whatsapp_linked") {
    const { sendLinkedMessage } = require("./platforms/whatsapp-linked");
    return sendLinkedMessage(chatId, text);
  }
  if (ctx.activePlatform === "web") {
    const { sendWebMessage } = require("./platforms/web");
    return sendWebMessage(chatId, text);
  }
  return ctx.bot.sendMessage(chatId, text);
}

// A picture shows as a picture wherever it is sent (a chart for an answer,
// a photo from the person's mail); anything else arrives as a file.
const PICTURE = /^image\/(png|jpeg|gif|webp)$/;

// A file sent during a chat turn goes with the turn to the other apps, and is
// kept, so the conversation shows it when looked back on (lib/one-chat.js).
// attachmentId: it is kept already.
async function sendDocumentToPlatform(platform, chatId, buffer, filename, mimeType, { attachmentId = null, madeFrom = null, shows = null } = {}) {
  const sent = await sendDocumentOnly(platform, chatId, buffer, filename, mimeType);
  const userId = ctx.activeUserId, said = ctx.currentAsk && userId && ctx.currentAsk[userId];
  if (said && Buffer.isBuffer(buffer)) {
    let id = attachmentId;
    if (!id) {
      try {
        const ext = (String(filename).match(/\.([a-z0-9]{1,8})$/i) || [, String(mimeType || "").split("/")[1] || "bin"])[1].toLowerCase();
        id = require("./attachments").saveAttachment(userId, { buffer, fileName: filename, mediaType: mimeType, ext, isImage: PICTURE.test(mimeType || ""), direction: "chat" }, `Sent in the chat: ${filename}`);
      } catch (e) { console.warn(`[messaging] ${filename} not kept for the conversation: ${e.message}`); }
    }
    require("./one-chat").noteFile(userId, said, { buffer, filename, mimeType, id, ...(madeFrom ? { madeFrom: String(madeFrom).slice(0, 1200) } : {}), ...(shows ? { shows: String(shows).slice(0, 800) } : {}) });
  }
  return sent;
}

async function sendDocumentOnly(platform, chatId, buffer, filename, mimeType) {
  const picture = PICTURE.test(mimeType || "");
  if (platform === "email") return require("./assistant-email").send(chatId, "", { filename, contentType: mimeType, content: buffer.toString("base64") });
  if (platform === "dashboard") return null; // Dashboard polls for results
  switch (platform) {
    case "telegram":
      if (picture) return ctx.bot.sendPhoto(chatId, buffer, {}, { filename, contentType: mimeType });
      return sendTelegramDocument(chatId, buffer, filename);
    case "whatsapp_linked": {
      const { sendLinkedDocument } = require("./platforms/whatsapp-linked");
      return sendLinkedDocument(chatId, buffer, filename, mimeType, picture);
    }
    case "web":
      return sendWebDocument(chatId, buffer, filename, mimeType);
    default:
      console.warn(`sendDocumentToPlatform: unknown platform "${platform}"`);
  }
}

// A message Closedhand sends on its own (Pulse, a finished task, a
// reminder) shows in the web chat too, which shows the whole conversation
// (lib/one-chat.js). A chat turn's reply is passed on when the turn ends.
async function sendToPlatform(platform, chatId, message) {
  const sent = await sendToPlatformOnly(platform, chatId, message);
  const userId = ctx.activeUserId;
  if (userId && !(ctx.currentAsk && ctx.currentAsk[userId])) {
    try { require("./one-chat").sentElsewhere(userId, platform, require("./stock-phrases").noStockPhrases(require("./plain-dashes").noEmDashes(message))); } catch (_) { /* the send itself went */ }
  }
  return sent;
}

async function sendToPlatformOnly(platform, chatId, message) {
  // As a reply is finished (engine.js): no emdashes or stock phrases, and in
  // a chat app a table goes as lines (lib/chat-tables.js).
  message = require("./chat-tables").flatten(require("./stock-phrases").noStockPhrases(require("./plain-dashes").noEmDashes(message)), platform);
  if (platform === "email") return require("./assistant-email").send(chatId, message);
  // A saved agent set to send its results by email: to the person's own inbox,
  // from their own account. The destination carries the agent's name as subject.
  if (platform === "own_email") return require("./own-email").sendToSelf(chatId, message);
  if (platform === "dashboard") return null; // Dashboard polls for results
  switch (platform) {
    case "telegram": {
      if (message.length > 4000) {
        const chunks = message.match(/.{1,4000}/gs);
        let lastResult;
        for (const chunk of chunks) lastResult = await ctx.bot.sendMessage(chatId, chunk);
        return lastResult?.message_id || null;
      }
      const tgResult = await ctx.bot.sendMessage(chatId, message);
      return tgResult?.message_id || null;
    }
    case "whatsapp_linked": {
      const { sendLinkedMessage } = require("./platforms/whatsapp-linked");
      return await sendLinkedMessage(chatId, message);
    }
    case "web": {
      const { sendWebMessage } = require("./platforms/web");
      await sendWebMessage(chatId, message);
      return null;
    }
    default:
      console.warn(`Pulse: unknown platform "${platform}"`);
      return null;
  }
}

async function pinMessage(platform, chatId, messageId) {
  try {
    if (platform !== "telegram") return { pinned: false };
    await ctx.bot.pinChatMessage(chatId, messageId, { disable_notification: true });
    return { pinned: true };
  } catch (e) {
    console.error(`pinMessage (${platform}):`, e.message);
    return { pinned: false, error: e.message };
  }
}

async function unpinMessage(platform, chatId, messageId) {
  try {
    if (platform !== "telegram") return { unpinned: false };
    await ctx.bot.unpinChatMessage(chatId, { message_id: messageId });
    return { unpinned: true };
  } catch (e) {
    console.error(`unpinMessage (${platform}):`, e.message);
    return { unpinned: false, error: e.message };
  }
}


module.exports = {
  sendTyping, sendText, sendToPlatform,
  sendDocument, sendDocumentToPlatform, sendLocation,
  reactToMessage, removeReaction, sendStatusMessage, deleteStatusMessage, toolStatusText, resetToolStatus,
  pinMessage, unpinMessage,
};
