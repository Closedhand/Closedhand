// The home page's conversation, carried into Closedhand (public/ask.js keeps
// it in this browser for 7 days). The first time Closedhand's web chat opens
// on a computer, it passes through here with a one-time value of its own; this
// page hands the conversation back in the address after "#", which browsers
// never send anywhere, and forgets it here: a move, never a copy. It goes
// back only to the computer this browser is on (localhost), so a link from
// anyone else can never carry it off, and closedhand.com's server never sees
// it.
(function () {
  var KEY = 'ch-ask', KEPT = 7 * 24 * 3600 * 1000;
  var p;
  try { p = new URLSearchParams(location.hash.slice(1)); } catch (e) { p = new URLSearchParams(); }
  var state = /^[a-f0-9]{32}$/.test(p.get('state') || '') ? p.get('state') : null;
  var back = null;
  try {
    var u = new URL(p.get('back') || '');
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(u.hostname) >= 0 && !u.username && !u.password && u.pathname === '/') back = u.origin + '/';
  } catch (e) {}
  if (!state || !back) { document.getElementById('carry-line').textContent = 'Nothing to carry over here.'; return; }
  var out = { state: state };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    var turns = saved && Array.isArray(saved.turns) && Date.now() - saved.at < KEPT ? saved.turns.filter(function (t) {
      return t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text;
    }).map(function (t) { return { role: t.role, text: t.text }; }) : [];
    if (turns.length) out.carry = JSON.stringify(turns);
    localStorage.removeItem(KEY);
  } catch (e) {}
  location.replace(back + '#' + new URLSearchParams(out));
})();
