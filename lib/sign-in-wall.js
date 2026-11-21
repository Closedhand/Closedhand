// A sign-in page in the sandbox browser means the person has to sign in there
// themselves, once: the browser keeps them signed in for later tasks. Left to
// work that out, an agent emailed the restaurant instead, told the person the
// browser was "signed into a different account" when nobody was signed in,
// and went reading the browser's cookie file. The tool's own result now says
// what to do at the moment it lands on the page, with the link to where the
// person signs in.
const { dashboardBase } = require("./config");

const SIGN_IN_HOST = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|login\.yahoo\.com)$/i;
const SIGN_IN_PATH = /\/(sign[-_]?in|log[-_]?in|signin|login|sso|oauth2?)(\/|\?|$|#)/i;
const SIGN_IN_TITLE = /\b(sign in|log in|login)\b/i;

function isSignInPage(page) {
  if (!page || !page.url) return false;
  let u;
  try { u = new URL(String(page.url)); } catch { return false; }
  return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_PATH.test(u.pathname) || SIGN_IN_TITLE.test(String(page.title || ""));
}

function siteOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// The page put in front of the person, in the sandbox computer's visible
// browser, where they sign in: true only when the browser says it is there.
// A job once told them "it's open on the page" when it was not, and they
// looked and found nothing.
async function openForPerson(userId, url, browse = (body) => require("./sandbox").sandboxBrowse(userId, body, 20000)) {
  if (!/^https?:\/\//i.test(String(url || ""))) return false;
  try {
    const answer = await browse({ op: "step", engine: "visible", step: { action: "goto", url: String(url) } });
    return !!(answer && !answer.error && answer.result && typeof answer.result === "object" && !answer.result.error);
  } catch { return false; }
}

async function computersLink() {
  try { const base = await dashboardBase(); return base ? `${base}/#computers` : null; } catch { return null; /* no public address */ }
}

async function signInNote(page, { opened = true } = {}) {
  const site = siteOf(page.url);
  const link = await computersLink();
  const where = link ? `${link} (the Computers tab of the web chat)` : "the Computers tab of the web chat";
  const open = opened ? "The page is open there now." : `The page could not be opened there, so give them its address to open in that browser first: ${page.url}`;
  return `This is a sign-in page${site ? ` (${site})` : ""}: the site needs the person signed in. Ask them to sign in to it themselves in Closedhand's sandbox computer, at ${where}; it stays signed in for later tasks. ${open} Then carry on from where you are. Offer this before any other way round it. Never type their details, and never look for another way past the sign-in (other addresses, a direct request, the browser's own files).`;
}

// A job running in the background stops on a sign-in page and asks in the chat
// it came from (lib/agents.js), with the page already open in the sandbox
// computer's browser; a reply that says it is done carries the job on.
async function signInQuestion(site, { url = null, opened = true } = {}) {
  const link = await computersLink();
  const where = link ? `on Closedhand's sandbox computer: ${link}` : "on Closedhand's sandbox computer, on the Computers tab of the web chat";
  const open = opened ? "It's open on the page" : `I couldn't open the page there myself, so open ${url || site || "it"} in that browser first`;
  return `${site || "This site"} needs you signed in before I can carry on. Sign in ${where}. ${open}, and it stays signed in for next time. Reply done when you have, and I'll pick up where I left off.`;
}

// Told the page is not there ("it isn't open", "I can't see it"): it is opened
// again, and the job goes on waiting. What is said back, by whether it opened.
async function reopenedReply(opened, url) {
  const link = await computersLink();
  const tab = link ? `the Computers tab (${link})` : "the Computers tab of the web chat";
  return opened ? `Sorry, it wasn't there. It's open now on ${tab}. Reply done once you've signed in.`
    : `I couldn't open it there myself. Open ${url || "the site"} in the browser on ${tab}, sign in, and reply done.`;
}

// "done", "signed in", "I've logged in now": carry on. "no", "skip", "can't":
// go on without. "not yet", "one sec": keep waiting. "it isn't open", "I
// can't see it": the page is not in front of them, so it is opened again
// (a reply like that was taken for moving on, and the job was dropped).
const WAIT = /\b(not yet|wait|hold on|hang on|one (sec|second|moment|min|minute)|in a (sec|second|bit|minute)|still|later)\b/i;
const DONE = /\b(done|signed|logged|finished|ready|yes|yep|yeah|ok|okay|sure|go)\b/i;
const NOT = /\b(no|nope|nah|skip|can'?t|cannot|won'?t|don'?t|not|never|stop|cancel)\b/i;
// A longer reply carries the job on when it says plainly that they have
// signed in ("I'm signed in on it. Do I need to stay on the screen?"): read
// by the short words alone, it was taken for moving on and the job was lost.
const SAYS_SIGNED_IN = /\b(?:i'?m|i am|i'?ve|i have|we'?re|it'?s|all|now|just|got)\s+(?:now\s+|just\s+|all\s+)?(?:signed|logged)\s+(?:in|on)\b|\b(?:signed|logged) in (?:now|on it|there|fine)\b/i;
const SAYS_NOT_SIGNED_IN = /\b(?:can'?t|cannot|couldn'?t|won'?t|not|haven'?t|hasn'?t|didn'?t|isn'?t)\s+(?:yet\s+|be\s+|been\s+|able to\s+)?(?:sign|log)(?:ged)?\s*(?:in|on)\b/i;
// The page is not there: "it's not open", "you don't have it open", "there's
// no Lumo page", "I can't see it", "it's blank", "it's on a different page".
const SAYS_MISSING = new RegExp([
  "\\b(?:isn'?t|is not|wasn'?t|was not|it'?s not|its not|not)\\s+(?:\\w+\\s+){0,3}?(?:open|opened|there|showing|up|loaded|on (?:the|my) screen)\\b",
  "\\b(?:don'?t|doesn'?t|do not|does not|didn'?t|did not|haven'?t|hasn'?t|have not|has not)\\s+(?:\\w+\\s+){0,2}?(?:have|has|open|opened|see|show|showing)\\s+(?:\\w+\\s+){0,3}?(?:open|there|up|anything|it|the page|any page)\\b",
  "\\bthere'?s no\\s+(?:\\w+\\s+){0,3}?(?:page|tab|window|site)\\b",
  "\\bno\\s+(?:\\w+\\s+){0,2}?(?:page|tab|window)\\s+(?:is\\s+)?(?:open|there|showing)\\b",
  "\\b(?:can'?t|cannot|couldn'?t)\\s+(?:see|find)\\b",
  "\\b(?:blank|empty)\\b",
  "\\b(?:wrong|different|another)\\s+(?:page|site|tab)\\b",
].join("|"), "i");
function signInAnswer(text) {
  const t = String(text || "").replace(/[’]/g, "'").trim();
  if (!t) return null;
  if (SAYS_MISSING.test(t) && !SAYS_SIGNED_IN.test(t) && !SAYS_NOT_SIGNED_IN.test(t)) return "missing";
  if (t.split(/\s+/).length > 8) return SAYS_SIGNED_IN.test(t) && !SAYS_NOT_SIGNED_IN.test(t) ? "done" : null;
  if (WAIT.test(t)) return "wait";
  if (NOT.test(t)) return "no";
  if (DONE.test(t)) return "done";
  return null;
}

module.exports = { isSignInPage, signInNote, siteOf, signInQuestion, signInAnswer, openForPerson, reopenedReply };
