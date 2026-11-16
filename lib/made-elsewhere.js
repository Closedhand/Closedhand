// lib/made-elsewhere.js: once per service, after a picture or video made by
// a service the person connected reaches them, a line saying that service
// can see what they asked for, and, where Closedhand could make the picture
// itself, how to keep their requests private. Only pictures made on the
// computer running Closedhand, or with the subscription's model in the TEE,
// are seen by no other company.
//
// Noted where such a file is sent: a connected image service standing in for
// generate_image (lib/connection-jobs.js), a file a connected tool sent back
// (lib/user-mcp.js), and a picture or video send_file fetched by its link,
// put down to the connected service Closedhand last used. Said after the
// reply as a message of its own (lib/engine.js), or after a long job's
// (lib/tool-waits.js).

const LONG = "Made with {name}, which can see what you asked for. To make sure no other company sees your requests, switch off Image generation on {name} in Connections and Closedhand will make your pictures itself, privately.";
const SHORT = "Made with {name}, which can see what you asked for.";
const FRESH_MS = 10 * 60000;

const pending = new Map(); // userId -> { server, kind, at }
const lastUsed = new Map(); // userId -> { server, at }

function kindOf(mimeType) {
  const type = String(mimeType || "");
  return type.startsWith("video/") ? "video" : type.startsWith("image/") ? "picture" : null;
}
// A connected service Closedhand just called.
function used(userId, server) {
  if (userId && server) lastUsed.set(userId, { server, at: Date.now() });
}
// The one it last called within the hour, or null.
function lastService(userId) {
  const last = lastUsed.get(userId);
  return last && Date.now() - last.at < 60 * 60000 ? last.server : null;
}
// A picture or video from server reached the person.
function made(userId, server, kind) {
  if (userId && server && kind && !pending.has(userId)) pending.set(userId, { server, kind, at: Date.now() });
}

// The line to say now, or null; once said for a service, never again.
async function take(userId, settings, { store, deps = {} } = {}) {
  const got = pending.get(userId);
  pending.delete(userId);
  if (!got || Date.now() - got.at > FRESH_MS) return null;
  const told = Array.isArray(settings?.made_elsewhere_told) ? settings.made_elsewhere_told : [];
  if (told.includes(got.server)) return null;
  let text = SHORT;
  if (got.kind === "picture") {
    // The way to keep pictures private, only where it would work: the
    // service's own Image generation switch, and a private way to stand in.
    const privately = (deps.ready || require("./image-generation").ready)() || require("./included-ai").live(settings);
    const row = privately ? await (deps.connectionFor || require("./connection-jobs").connectionFor)(userId, "images").catch(() => null) : null;
    if (row?.name === got.server) text = LONG;
  }
  const list = [...told, got.server].slice(-50);
  await (deps.save ? deps.save(list) : require("./profile-settings").updateSettings(userId, { made_elsewhere_told: list }, { store }));
  return text.replace(/\{name\}/g, got.server);
}

module.exports = { kindOf, used, lastService, made, take, LONG, SHORT };
