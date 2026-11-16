// lib/facts-compact.js: what stays when Pinned Facts are thinned.
//
// At 150 Pinned Facts the person's LLM is asked which to keep, shorten or
// drop (lib/tools/handlers.js _compactFacts). Only what the person would call
// a fact is counted and shown to it: tracked flights, sync markers and Pulse
// state live in the same store, counted toward the 150 and were handed over to
// be rewritten or dropped. A fact that stays keeps everything known about it
// (its category, who it is about, where it came from); only its words may
// change. They were rebuilt from four fields, so one pass emptied the
// dashboard's groups and About you.
const { isInternal } = require("./facts-prose");

const pinned = (facts) => Object.keys(facts || {}).filter((key) => !isInternal(key));

// What the LLM is shown.
function listFor(facts) {
  return pinned(facts).map((key) => {
    const fact = facts[key];
    return fact && typeof fact === "object" && fact.value !== undefined
      ? { key, value: fact.value, created: fact.created, lastAccessed: fact.lastAccessed, accessCount: fact.accessCount || 0 }
      : { key, value: fact, created: "unknown", lastAccessed: "unknown", accessCount: 0 };
  });
}

// The store after its answer, { key: the words to keep }, or null when the
// answer keeps too few to be believed. A key it made up, or a value that is
// not words, counts for nothing.
function apply(facts, answer, now = new Date().toISOString()) {
  const mine = pinned(facts);
  const stays = new Set(Object.keys(answer || {}).filter((key) => mine.includes(key) && typeof answer[key] === "string" && answer[key].trim()));
  if (stays.size < 20) return null;
  const next = {};
  let compressed = 0;
  for (const key of Object.keys(facts)) {
    const old = facts[key];
    if (isInternal(key)) { next[key] = old; continue; }
    if (!stays.has(key)) continue;
    if (old && typeof old === "object" && old.value !== undefined) {
      if (answer[key] !== old.value) compressed++;
      next[key] = { ...old, value: answer[key] };
    } else next[key] = { value: answer[key], created: now, lastAccessed: now, accessCount: 0 };
  }
  return { facts: next, dropped: mine.filter((key) => !stays.has(key)), compressed, kept: stays.size - compressed };
}

module.exports = { pinned, listFor, apply };
