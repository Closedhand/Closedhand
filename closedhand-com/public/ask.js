// The home page's question box: one short conversation with the uncensored
// LLM Closedhand provides, before downloading anything. Each question is
// encrypted here (ask-private.js) to the sealed hardware the LLM runs in, and
// the answer comes back encrypted to a key made here for that question, a
// few words at a time as it is written, so closedhand.com carries both and
// can read neither (lib/ask.js). The
// conversation lives in this page only: closing the page forgets it.
(function () {
  var box = document.getElementById('ask');
  if (!box) return;
  var P = window.AskPrivate;
  if (!P || !P.ready || !window.fetch) { box.hidden = true; return; }
  var byId = function (id) { return document.getElementById(id); };
  var thread = byId('askThread'), form = byId('askForm'), input = byId('askInput'), send = byId('askSend');
  var tries = byId('askTries'), slot = byId('askNextSlot'), next = null, note = byId('askNote');
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
  // The answer as it is written: the letters of each piece sharpen out of
  // noise as it arrives, and the whole is left as plain text once it has all
  // come.
  function writing(el) {
    el.style.whiteSpace = 'pre-wrap';
    var text = '', queue = [], word = null, running = false, whole = false;
    function step() {
      // More at once when more is waiting, so the letters keep up with the answer.
      for (var n = Math.max(1, Math.ceil(queue.length / 12)); n > 0 && queue.length; n--) queue.shift().classList.add('on');
      if (queue.length) return requestAnimationFrame(step);
      running = false;
      if (whole) setTimeout(function () { if (whole) el.textContent = text; }, 650);
    }
    return {
      add: function (piece) {
        // No emdashes in anything people read: a spaced hyphen, as Closedhand writes.
        piece = piece.replace(/\s*\u2014\s*/g, ' - ');
        if (/ $/.test(text)) piece = piece.replace(/^ +/, '');
        if (!text) piece = piece.replace(/^\s+/, '');
        if (!piece) return;
        text += piece;
        if (still) { el.textContent = text; return; }
        piece.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { el.appendChild(document.createTextNode(part)); word = null; return; }
          // A word that comes in two pieces stays one word, so it never breaks across lines.
          if (!word) { word = document.createElement('span'); word.className = 'ask-w'; el.appendChild(word); }
          Array.from(part).forEach(function (letter) {
            var ch = document.createElement('span'), real = document.createElement('span'), fuzz = document.createElement('span');
            ch.className = 'ask-ch'; real.className = 'ask-real'; fuzz.className = 'ask-noise';
            real.textContent = letter; fuzz.textContent = noise();
            ch.appendChild(real); ch.appendChild(fuzz); word.appendChild(ch); queue.push(ch);
          });
        });
        if (!running) { running = true; requestAnimationFrame(step); }
      },
      // All of it has come: returns the answer.
      end: function () {
        text = text.replace(/\s+$/, ''); whole = true;
        if (still) el.textContent = text; else if (!running) step();
        return text;
      },
      // Taken back: no answer came after all.
      stop: function () { whole = false; queue = []; }
    };
  }

  function went() { if (state.turns.length) fetch('/api/ask/went', { method: 'POST' }).catch(function () {}); }
  // Where a conversation leads: Closedhand itself. A computer has the
  // download just below, so the whole piece is the way there; a phone can
  // send its owner the link.
  var DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  function down() {
    var ways = byId('ways'), dl = byId('macAppLink');
    if (ways) ways.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    if (dl) dl.focus({ preventScroll: true });
    call();
  }
  function sendLink(e) {
    went();
    var here = 'https://closedhand.com/', b = e.currentTarget;
    if (navigator.share) return navigator.share({ title: 'Closedhand', url: here }).catch(function () {});
    if (navigator.clipboard) navigator.clipboard.writeText(here).then(function () { b.textContent = 'Link copied'; }, function () {});
  }
  function say(lead, words) {
    if (next) next.remove();
    next = document.createElement(handheld ? 'div' : 'button');
    next.className = 'ask-next';
    next.id = 'askNext';
    var line = document.createElement('span');
    line.className = 'ask-next-words';
    if (lead) { var strong = document.createElement('strong'); strong.textContent = lead; line.appendChild(strong); }
    line.appendChild(document.createTextNode(words));
    next.appendChild(line);
    if (handheld) {
      var go = document.createElement('button');
      go.type = 'button'; go.className = 'ask-next-go'; go.textContent = 'Send yourself the link';
      go.addEventListener('click', sendLink);
      next.appendChild(go);
    } else {
      next.type = 'button';
      next.insertAdjacentHTML('beforeend', '<span class="ask-next-go">' + DOWN + '</span>');
      next.addEventListener('click', down);
    }
    slot.appendChild(next);
  }
  function hush(yes) { if (next) next.hidden = yes; }
  var FREE = 'The first 14 days are free and need no card.';
  function after() {
    if (state.left === 0) return over(true);
    say('', handheld
      ? 'On a computer, Closedhand unlocks image generation, agentic actions and anything you connect.'
      : 'Download Closedhand below to unlock image generation, agentic actions and anything you connect.');
    if (state.left === 1) note.textContent = 'One question left here today.';
  }
  // asked: the questions ran out just now, as an answer came, so the piece
  // is brought into view with the download under it; a page that opens with
  // none left stays where it is.
  function over(asked) {
    box.classList.add('done');
    tries.hidden = true;
    var lead = state.of === 1 ? 'That’s your question here for today.' : 'That’s your ' + state.of + ' questions here for today.';
    say(lead, handheld ? 'Closedhand runs on a computer. Carry on there: ' + FREE.charAt(0).toLowerCase() + FREE.slice(1) : 'Download Closedhand below to carry on. ' + FREE);
    note.hidden = true;
    call();
    if (asked) next.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  }
  // The download card shows itself: a glow passes over it once, when the
  // questions run out and whenever the way to it is taken.
  function call() {
    var ways = byId('ways');
    if (!ways || still) return;
    ways.classList.remove('called');
    void ways.offsetWidth;
    ways.classList.add('called');
  }

  // The answer's events as they arrive (lib/ask.js): each piece is opened
  // here, in order, and given to hear; the last event says how it ended.
  function read(res, secret, hear) {
    var opened = Promise.resolve(), ended = null, rest = '';
    function take(some) {
      rest += some;
      for (var at; (at = rest.indexOf('\n\n')) >= 0;) {
        var line = rest.slice(0, at), event = null;
        rest = rest.slice(at + 2);
        if (line.indexOf('data: ') !== 0) continue;
        try { event = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (event.c) opened = opened.then(P.open.bind(null, event.c, secret)).then(hear);
        else ended = event;
      }
    }
    function finish() {
      return opened.then(function () {
        // Signed for by the sealed hardware only when whole: anything less is no answer.
        if (!ended || !ended.done) throw new Error('busy');
        state.left = ended.left;
      });
    }
    if (!res.body || !res.body.getReader || !window.TextDecoder) return res.text().then(take).then(finish);
    var reader = res.body.getReader(), decoder = new TextDecoder();
    return (function more() {
      return reader.read().then(function (got) {
        if (got.done) return finish();
        take(decoder.decode(got.value, { stream: true }));
        return more();
      });
    })().catch(function (e) { opened.catch(function () {}); throw e; });
  }
  function sent(turns, hear, again) {
    return hello().then(function () {
      // closedhand.com takes a conversation only so long (a day's questions and
      // their answers), and a page left open keeps its own for longer than
      // that: over a night, or while the site restarts. The latest of it goes,
      // starting at a question; without this every question after that was
      // turned away and the page could only say no answer came back.
      turns = turns.slice(-(Math.max(1, state.of) * 2 - 1));
      var mine = P.keys();
      return Promise.all(turns.map(function (t) { return P.seal(t.text, state.key); })).then(function (sealed) {
        return fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: state.key, client: mine.publicHex, messages: turns.map(function (t, i) { return { role: t.role, content: sealed[i] }; }) }) });
      }).then(function (res) {
        if (String(res.headers.get('Content-Type')).indexOf('text/event-stream') === 0) return read(res, mine.secret, hear);
        // No answer at all: said in JSON, with why.
        return res.json().then(function (body) {
          // The sealed hardware has a new key: encrypted again, once.
          if (res.status === 409 && body.key && !again) { state.key = body.key; return sent(turns, hear, true); }
          if (res.status === 429) throw Object.assign(new Error('limit'), { limit: true });
          throw new Error('busy');
        });
      });
    });
  }

  // On a phone the first screen ends with the box and its examples. What
  // comes next starts below the screen when only a sliver of it would show,
  // so nothing sits half cut off at the foot; once a question is asked the
  // page is the conversation's, and the room goes.
  function fold() {
    if (!handheld) return;
    box.style.marginBottom = '';
    if (state.turns.length || state.busy || box.hidden || !box.offsetHeight) return;
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, after = box.nextElementSibling;
    while (after && !after.offsetHeight) after = after.nextElementSibling;
    if (!after) return;
    var showing = window.innerHeight - (after.getBoundingClientRect().top + window.scrollY);
    if (showing > 0 && showing < 5 * rem) box.style.marginBottom = ((parseFloat(getComputedStyle(box).marginBottom) + showing) / rem) + 'rem';
  }
  fold();
  window.addEventListener('resize', fold);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fold, function () {});

  function ready() { send.disabled = state.busy || !input.value.trim(); }
  function fit() { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; }
  function ask(question) {
    question = String(question || '').trim();
    if (state.busy || !question) return;
    state.busy = true;
    fold();
    input.value = ''; fit(); ready();
    tries.hidden = true; hush(true);
    // A question that got no answer makes way for the next try.
    state.unanswered.forEach(function (el) { if (el.parentNode) thread.removeChild(el); });
    var mine = add('user'), theirs = add('bot');
    mine.textContent = question;
    wait(theirs);
    theirs.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' });
    var turns = state.turns.concat([{ role: 'user', text: question }]);
    // The answer takes the place of the waiting line at its first words, with
    // who is answering under it the first time.
    var out = null;
    function hear(piece) {
      if (!out) {
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
        out = writing(words);
      }
      out.add(piece);
    }
    sent(turns, hear).then(function () {
      if (!out) throw new Error('busy');
      state.turns = turns.concat([{ role: 'assistant', text: out.end() }]);
      state.told = true;
      after();
      // A long answer starts under its question, at the top of the screen.
      if (!box.classList.contains('done') && form.getBoundingClientRect().bottom > window.innerHeight) mine.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    }).catch(function (e) {
      clearInterval(theirs.churn);
      if (out) out.stop();
      if (e.limit) { thread.removeChild(mine); thread.removeChild(theirs); state.left = 0; return over(true); }
      state.unanswered = [mine, theirs];
      theirs.classList.add('failed');
      theirs.textContent = 'No answer came back just now. Try again in a minute.';
      if (!input.value) { input.value = question; fit(); }
      if (state.turns.length) hush(false);
    }).then(function () { state.busy = false; ready(); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
  input.addEventListener('input', function () { fit(); ready(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  // The questions to try drift past in one line: it holds them twice so the
  // drift comes round without a jump, the copies hidden from screen readers
  // and the keyboard, and any of them asks its question.
  var track = tries.querySelector('.ask-tries-track');
  if (track) Array.prototype.forEach.call(track.querySelectorAll('button'), function (b) {
    var copy = b.cloneNode(true); copy.setAttribute('aria-hidden', 'true'); copy.tabIndex = -1; track.appendChild(copy);
  });
  tries.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b && tries.contains(b)) ask(b.textContent);
  });
  // Going on to the download after asking is counted, and nothing else is.
  ['macAppLink', 'copyInstall'].forEach(function (id) { var el = byId(id); if (el) el.addEventListener('click', went); });
})();
