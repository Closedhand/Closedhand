// The person's own rules ("no emojis", "always copy in my accountant"), as
// every prompt says them: the chat's and a background agent's. A rule holds
// wherever Closedhand acts for the person, so both read them from here; a
// background agent once had their Pinned Facts and none of their rules.
function rulesBlock(rules) {
  const list = (rules || []).map((r) => (r && typeof r === "object" ? r.rule : r)).filter(Boolean);
  if (!list.length) return "";
  return "YOUR RULES (set by this user, follow these always):\n" + list.map((r) => "- " + r).join("\n") + "\n";
}

module.exports = { rulesBlock };
