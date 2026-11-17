// The home page's question box: one short conversation with the uncensored
// LLM Closedhand provides, before downloading anything. Each question is
// encrypted here (ask-private.js) to the sealed hardware the LLM runs in, and
// the answer comes back encrypted to a key made here for that question, so
// closedhand.com carries both and can read neither (lib/ask.js). The
// conversation lives in this page only: closing the page forgets it.
(function () {
  var box = document.getElementById('ask');
  if (!box) return;
  var P = window.AskPrivate;
  if (!P || !P.ready || !window.fetch) { box.hidden = true; return; }
  var byId = function (id) { return document.getElementById(id); };
  var thread = byId('askThread'), form = byId('askForm'), input = byId('askInput'), send = byId('askSend');
  var tries = byId('askTries'), next = byId('askNext'), note = byId('askNote');
  var handheld = document.documentElement.classList.contains('handheld');
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var NOISE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var noise = function () { return NOISE[Math.floor(Math.random() * NOISE.length)]; };
  // A phone's box is too narrow for the whole invitation.
  if (handheld) input.placeholder = 'Ask what others refuse to answer';
  var state = { key: null, left: null, of: 5, name: '', turns: [], busy: false, told: false, unanswered: [] };

  // The sealed hardware's key, and how many questions are left here today.
  // Asked for as the page settles, so the connection is ready for the question.
  var greeting = null;
  function hello() {
    if (!greeting) {
      greeting = fetch('/api/ask').then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); }).then(function (r) {
        if (r.body.error === 'off') { box.hidden = true; throw new Error('off'); }
        if (!r.body.key) throw new Error('busy');
        state.key = r.body.key; state.left = r.body.left; state.of = r.body.of; state.name = r.body.name || '';
        if (state.left === 0 && !state.turns.length) over();
      });
      greeting.catch(function () { greeting = null; });
    }
    return greeting;
  }
  setTimeout(function () { hello().catch(function () {}); }, 600);

  function add(kind) {
    var li = document.createElement('li');
    li.className = 'ask-msg ' + kind;
    thread.appendChild(li);
    return li;
  }
  // A line of shifting noise while the answer is on its way.
  function wait(el) {
    if (still) { el.textContent = '…'; return; }
    var cells = [];
    [7, 4, 8, 5].forEach(function (length, n) {
      if (n) el.appendChild(document.createTextNode(' '));
      var w = document.createElement('span');
      w.className = 'ask-w';
      for (var i = 0; i < length; i++) {
        var ch = document.createElement('span'), real = document.createElement('span'), fuzz = document.createElement('span');
        ch.className = 'ask-ch'; real.className = 'ask-real'; fuzz.className = 'ask-noise';
        real.textContent = 'n'; fuzz.textContent = noise();
        ch.appendChild(real); ch.appendChild(fuzz); w.appendChild(ch); cells.push(fuzz);
      }
      el.appendChild(w);
    });
    el.churn = setInterval(function () { for (var i = 0; i < 6; i++) cells[Math.floor(Math.random() * cells.length)].textContent = noise(); }, 70);
  }
  // The answer, its letters sharpening out of noise in a wave, then left as
  // plain text.
  function show(el, text) {
    el.style.whiteSpace = 'pre-wrap';
    if (still) { el.textContent = text; return; }
    var cells = [];
    text.split(/(\s+)/).forEach(function (part) {
      if (!part) return;
      if (/^\s+$/.test(part)) { el.appendChild(document.createTextNode(part)); return; }
      var w = document.createElement('span');
      w.className = 'ask-w';
      Array.from(part).forEach(function (letter) {
        var ch = document.createElement('span'), real = document.createElement('span'), fuzz = document.createElement('span');
        ch.className = 'ask-ch'; real.className = 'ask-real'; fuzz.className = 'ask-noise';
        real.textContent = letter; fuzz.textContent = noise();
        ch.appendChild(real); ch.appendChild(fuzz); w.appendChild(ch); cells.push(ch);
      });
      el.appendChild(w);
    });
    var at = 0, each = Math.max(2, Math.ceil(cells.length / 130));
    (function step() {
      for (var i = 0; i < each && at < cells.length; i++, at++) cells[at].classList.add('on');
      if (at < cells.length) return requestAnimationFrame(step);
      setTimeout(function () { el.textContent = text; }, 650);
    })();
  }

  function link(words, act) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = words;
    b.addEventListener('click', act);
    return b;
  }
  function went() { if (state.turns.length) fetch('/api/ask/went', { method: 'POST' }).catch(function () {}); }
  // Where a conversation leads: Closedhand itself. A computer has the
  // download beside it; a phone can send its owner the link.
  function onward() {
    if (!handheld) {
      return link('Download Closedhand', function () {
        var ways = byId('ways'), dl = byId('macAppLink');
        if (ways) ways.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
        if (dl) dl.focus({ preventScroll: true });
      });
    }
    return link('Send yourself the link', function (e) {
      went();
      var here = 'https://closedhand.com/', b = e.currentTarget;
      if (navigator.share) return navigator.share({ title: 'Closedhand', url: here }).catch(function () {});
      if (navigator.clipboard) navigator.clipboard.writeText(here).then(function () { b.textContent = 'Link copied'; }, function () {});
    });
  }
  function say(lead, words) {
    next.textContent = '';
    if (lead) { var strong = document.createElement('strong'); strong.textContent = lead; next.appendChild(strong); }
    next.appendChild(document.createTextNode(words + ' '));
    next.appendChild(onward());
    next.hidden = false;
  }
  var FREE = 'The first 14 days are free and need no card.';
  function after() {
    if (state.left === 0) return over();
    say('', handheld
      ? 'That was the LLM on its own. On a computer, Closedhand can take actions agentically and work with everything you connect.'
      : 'That was the LLM on its own. On your computer, Closedhand can take actions agentically and work with everything you connect.');
    if (state.left === 1) note.textContent = 'One question left here today.';
  }
  function over() {
    box.classList.add('done');
    tries.hidden = true;
    var lead = state.of === 1 ? 'That’s your question here for today.' : 'That’s your ' + state.of + ' questions here for today.';
    say(lead, handheld ? 'Closedhand runs on a computer. Carry on there: ' + FREE.charAt(0).toLowerCase() + FREE.slice(1) : 'Carry on in Closedhand. ' + FREE);
    note.hidden = true;
  }

  function sent(turns, again) {
    return hello().then(function () {
      var mine = P.keys();
      return Promise.all(turns.map(function (t) { return P.seal(t.text, state.key); })).then(function (sealed) {
        return fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: state.key, client: mine.publicHex, messages: turns.map(function (t, i) { return { role: t.role, content: sealed[i] }; }) }) });
      }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); }).then(function (r) {
        // The sealed hardware has a new key: encrypted again, once.
        if (r.status === 409 && r.body.key && !again) { state.key = r.body.key; return sent(turns, true); }
        if (r.status === 429) throw Object.assign(new Error('limit'), { limit: true });
        if (r.status !== 200 || !r.body.content) throw new Error('busy');
        state.left = r.body.left;
        return P.open(r.body.content, mine.secret);
      });
    });
  }

  function ready() { send.disabled = state.busy || !input.value.trim(); }
  function fit() { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; }
  function ask(question) {
    question = String(question || '').trim();
    if (state.busy || !question) return;
    state.busy = true;
    input.value = ''; fit(); ready();
    tries.hidden = true; next.hidden = true;
    // A question that got no answer makes way for the next try.
    state.unanswered.forEach(function (el) { if (el.parentNode) thread.removeChild(el); });
    var mine = add('user'), theirs = add('bot');
    mine.textContent = question;
    wait(theirs);
    theirs.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' });
    var turns = state.turns.concat([{ role: 'user', text: question }]);
    sent(turns).then(function (answer) {
      answer = answer.trim();
      state.turns = turns.concat([{ role: 'assistant', text: answer }]);
      // Everything the answer brings arrives with it, so the page moves once:
      // its words (forming), who answered, the first time, and where this leads.
      clearInterval(theirs.churn);
      theirs.textContent = '';
      var words = document.createElement('span');
      theirs.appendChild(words);
      if (!state.told && state.name) {
        var by = document.createElement('span');
        by.className = 'ask-by';
        by.textContent = state.name + ', the uncensored LLM Closedhand provides';
        theirs.appendChild(by);
      }
      state.told = true;
      show(words, answer);
      after();
      // A long answer starts under its question, at the top of the screen.
      if (form.getBoundingClientRect().bottom > window.innerHeight) mine.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    }, function (e) {
      clearInterval(theirs.churn);
      if (e.limit) { thread.removeChild(mine); thread.removeChild(theirs); state.left = 0; return over(); }
      state.unanswered = [mine, theirs];
      theirs.classList.add('failed');
      theirs.textContent = 'No answer came back just now. Try again in a minute.';
      if (!input.value) { input.value = question; fit(); }
      if (state.turns.length) next.hidden = false;
    }).then(function () { state.busy = false; ready(); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
  input.addEventListener('input', function () { fit(); ready(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  Array.prototype.forEach.call(tries.querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { ask(b.textContent); });
  });
  // Going on to the download after asking is counted, and nothing else is.
  ['macAppLink', 'copyInstall'].forEach(function (id) { var el = byId(id); if (el) el.addEventListener('click', went); });
})();
