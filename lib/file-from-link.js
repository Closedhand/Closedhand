// lib/file-from-link.js: the file behind a link, for send_file.
//
// A connected service that makes something (a video, a recording, a PDF)
// often gives back a link to it rather than the file. send_file fetches it
// here so the person gets the file itself in their chat, kept with the
// conversation like any file Closedhand sends. Only a public address is
// fetched, every redirect checked (lib/ssrf.js); a web page is not a file;
// and nothing larger than a chat app takes is read past that size.

const MAX_FILE = 50 * 1024 * 1024;

const EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/flac": "flac", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "application/zip": "zip", "text/csv": "csv", "application/json": "json" };
const BY_EXT = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));

// The name the server gives the file, else the last part of its address
// when that looks like a file name, else one from its kind.
function nameOf(res, url, mimeType) {
  const said = String(res.headers?.get?.("content-disposition") || "");
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(said), plain = /filename="?([^";]+)"?/i.exec(said);
  let name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : "";
  if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { name = ""; } }
  name = name.replace(/[\/\\\0]/g, "").slice(0, 120);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `file.${EXT[mimeType] || "bin"}`;
  return name;
}

async function fetchFile(url, { fetch: get = fetch, maxBytes = MAX_FILE } = {}) {
  const res = await require("./ssrf").fetchPublic(url, { fetch: get, timeoutMs: 120000 });
  if (!res.ok) throw new Error(`the link answered HTTP ${res.status}`);
  let mimeType = String(res.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") throw new Error("that link is a web page, not a file");
  const length = Number(res.headers?.get?.("content-length") || 0);
  if (length > maxBytes) throw new Error(`the file is ${Math.round(length / 1048576)} MB, more than a chat can take`);
  const parts = [];
  let size = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("the file is more than a chat can take"); }
      parts.push(Buffer.from(value));
    }
  } else {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > maxBytes) throw new Error("the file is more than a chat can take");
    parts.push(whole);
  }
  const buffer = Buffer.concat(parts);
  if (!buffer.length) throw new Error("the link gave back nothing");
  const name = nameOf(res, url, mimeType);
  if (!mimeType || mimeType === "application/octet-stream" || mimeType === "binary/octet-stream") mimeType = BY_EXT[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  return { buffer, mimeType, name };
}

module.exports = { fetchFile, MAX_FILE };
