// lib/web-search.js -- how the web_search tool searches the web.
//
// A search service the person connected, with its "Closedhand's search"
// switch on, goes before all of this (lib/connection-jobs.js takeOver, run
// before every tool). Then, in order: their LLM provider's own search, when
// the provider has one (lib/provider-search.js), as part of the LLM they
// chose; then free search (lib/web-search-fallback.js), which every
// Closedhand has and nobody pays for. A provider search that
// fails goes on to free search, so an outage or a spent balance never ends a
// search.

// The chat model's connection, when model settings name one. A "custom"
// connection at a known provider's address is that provider.
function chatConnection(settings) {
  let conn = null;
  try { conn = require("./model-policy").getRole(settings, "chat") || null; } catch (_) { return null; }
  // Chat run on the computer running Closedhand searches through the
  // provider it falls back to (webapp/run-here.js); the runner has no search.
  if (conn?.provider === "here") conn = conn.fallback || null;
  if (!conn) return null;
  const { BASES } = require("./model-policy");
  const base = String(conn.baseUrl || "").replace(/\/+$/, "");
  const provider = conn.provider === "custom" ? Object.keys(BASES).find((k) => BASES[k] === base) || "custom" : conn.provider;
  return { ...conn, provider, baseUrl: base || BASES[provider] || "" };
}

async function webSearch(query, count = 5, {
  settings = {},
  providerSearch = require("./provider-search"), freeSearch = require("./web-search-fallback").freeSearch,
} = {}) {
  count = Math.max(1, Math.min(Number(count) || 5, 10));
  const conn = chatConnection(settings);
  const adapter = conn ? providerSearch.forProvider(conn.provider) : null;
  if (adapter) {
    try {
      const found = await adapter.search({ ...conn, query, count });
      return { results: found.results, source: adapter.label, ...(found.summary ? { summary: found.summary } : {}), ...(adapter.citeSources ? { cite: true } : {}) };
    }
    catch (e) { console.warn(`[web-search] went on to free search: ${adapter.label}: ${e.message}`); }
  }
  const free = await freeSearch(query, count);
  return { results: free.results, source: free.source };
}

// Real photos of a subject (people, places, events, things) from Wikimedia
// Commons, rather than pages about it: free to share, with no key, and it
// answers a server as it answers anyone, where search engines may show one a
// check. Each still photo with a link to it at chat size, to send with
// send_file, its page, credit and licence. Asked for photos of a day in 1989
// with search refused, Closedhand spent minutes scraping news sites for them.
async function photoSearch(query, count = 5, { get = fetch } = {}) {
  count = Math.max(1, Math.min(Number(count) || 5, 10));
  const q = new URLSearchParams({ action: "query", format: "json", generator: "search", gsrsearch: String(query || ""), gsrnamespace: "6", gsrlimit: String(count * 3), prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: "1280" });
  const res = await get(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: { "User-Agent": "Closedhand/1.0 (https://closedhand.com)", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Wikimedia Commons answered HTTP ${res.status}`);
  const pages = Object.values((await res.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const plain = (v) => String(v || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const photos = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0], meta = info?.extmetadata || {};
    if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime)) continue;
    photos.push({
      title: String(p.title || "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
      image: info.thumburl || info.url, page: info.descriptionurl,
      description: plain(meta.ImageDescription?.value).slice(0, 240), date: plain(meta.DateTimeOriginal?.value).slice(0, 40),
      credit: plain(meta.Artist?.value).slice(0, 120), licence: plain(meta.LicenseShortName?.value),
    });
    if (photos.length >= count) break;
  }
  return photos;
}

module.exports = { webSearch, photoSearch };
