// lib/platforms/web.js: messages from Closedhand to the web chat.
// What the person types arrives over the web chat's socket (lib/web-chat-ws.js).

const { supabase } = require("../db");

function setup() {
  // Messages left waiting by a bot that stopped are marked, not left pending
  supabase.from("web_messages")
    .update({ status: "error" })
    .eq("direction", "inbound")
    .in("status", ["pending", "processing"])
    .then(() => console.log("[Web] Cleaned up stale pending messages"))
    .catch(() => {});

}

// The one way a message reaches the web chat outside a reply (a background
// result, a reminder): saved, so it is still there after a reload, and shown
// at once on any open tab. Showing it live without saving it lost every
// result that arrived while the chat was open.
async function sendWebMessage(userId, text) {
  const { error } = await supabase.from("web_messages").insert({
    user_id: userId,
    direction: "outbound",
    content: text,
    status: "complete",
  });

  if (error) {
    console.error("[Web] Failed to send message:", error.message);
  }
  try {
    const { hasWebChatConnection, sendWebChatMessage } = require("../web-chat-ws");
    if (hasWebChatConnection(userId)) sendWebChatMessage(userId, text);
  } catch (e) {}
}

module.exports = { setup, sendWebMessage };
