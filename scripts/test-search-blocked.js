// A background task once got no results from nine web searches and spent its
// whole step allowance working round them, then sent the one line it wrote
// before its last tool call instead of the answer it had drafted. DuckDuckGo
// had been showing the connection a check for bots, which was read as an empty
// search. Now free search has more than one engine, a check rests that engine
// and the next one answers, and only when every engine is resting does search
// fail, saying so. A stopped task sends the last answer it wrote.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDuckDuckGo, parseDuckDuckGoLite, parseBrave, parseBing, browserGet, HEADERS, createFreeSearch, BotCheck } = require("../lib/web-search-fallback");
const { writtenAnswer } = require("../lib/task-outcome");

const ddgCheck = `<html><body><form id="challenge-form" class="anomaly-modal__form">
<p>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</p></form></body></html>`;
const ddgPage = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffares.example.org%2Fharbour-line&amp;rut=1">Harbour Line &amp; fares</a>
<a class="result__snippet" href="#">Singles from <b>4.20</b> each way&#32;&#0183; daily.</a></div>`;
const bravePage = `<div class="snippet" data-type="web" data-pos="1"><div class="result-content"><a href="https://ferries.example.net/kestrel-point" class="l1">
<div class="site-name-content"><div>Kestrel Ferries</div><cite class="snippet-url">ferries.example.net</cite></div>
<div class="title search-snippet-title line-clamp-1 svelte-x1" title="Kestrel Point crossings">Kestrel Point crossings</div></a>
<div class="generic-snippet"><div class="content desktop-default-regular svelte-x2"> Crossings every <strong>40 minutes</strong> from the harbour.</div></div></div></div>
<div class="snippet" data-type="web" data-pos="2"><a href="https://search.brave.com/goggles">Goggles</a><div class="title">Brave's own page</div></div>`;
const braveCheck = `<html><body><h1>Please verify you are human</h1><div id="captcha"></div></body></html>`;
const litePage = `<table><tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.harbour-line.example%2Ftimes&amp;rut=2" class='result-link'>Harbour Line timetable</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Boats leave every <b>half hour</b> from the quay.</td></tr></table>`;

const bingPage = `<ol id="b_results"><li class="b_algo" data-id iid=SERP.1><link rel="stylesheet" href="/rp/x.css"/><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=ab12&amp;ptn=3&amp;u=a1${Buffer.from("https://quay.example.org/kestrel-timetable").toString("base64url")}&amp;ntb=1" h="ID=SERP,1">Kestrel Point <strong>timetable</strong></a></h2><div class="b_caption"><p class="b_lineclamp2"><span class="news_dt">3 Oct 2026</span>&nbsp;&#0183;&#32;Boats every <strong>40 minutes</strong> from the quay.</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=kestrel">Images of Kestrel</a></h2></li></ol>`;
const bingCheck = `<html><body><div id="b_captcha"><p>One last step: please solve the challenge below to continue.</p></div></body></html>`;

test("each engine's results page reads into titles, links and snippets", () => {
  assert.deepEqual(parseBing(200, bingPage), [
    { title: "Kestrel Point timetable", url: "https://quay.example.org/kestrel-timetable", snippet: "Boats every 40 minutes from the quay." },
  ], "the address out of Bing's redirect, without its date, and none of Bing's own pages");
  assert.deepEqual(parseDuckDuckGo(200, ddgPage), [
    { title: "Harbour Line & fares", url: "https://fares.example.org/harbour-line", snippet: "Singles from 4.20 each way · daily." },
  ]);
  assert.deepEqual(parseBrave(200, bravePage), [
    { title: "Kestrel Point crossings", url: "https://ferries.example.net/kestrel-point", snippet: "Crossings every 40 minutes from the harbour." },
  ]);
  assert.deepEqual(parseDuckDuckGoLite(200, litePage), [
    { title: "Harbour Line timetable", url: "https://www.harbour-line.example/times", snippet: "Boats leave every half hour from the quay." },
  ]);
  assert.deepEqual(parseDuckDuckGo(200, "<html><body>No results.</body></html>"), []);
});

test("a check for bots is never read as an empty search", () => {
  assert.throws(() => parseDuckDuckGo(202, ddgCheck), BotCheck);
  assert.throws(() => parseDuckDuckGo(200, ddgCheck), BotCheck);
  assert.throws(() => parseBrave(200, braveCheck), BotCheck);
  assert.throws(() => parseBrave(429, ""), BotCheck);
  assert.throws(() => parseDuckDuckGoLite(200, ddgCheck), BotCheck);
  assert.throws(() => parseDuckDuckGoLite(403, litePage), BotCheck);
  assert.throws(() => parseBing(200, bingCheck), BotCheck);
  assert.throws(() => parseBing(429, bingPage), BotCheck);
});

// A request that said it came from a program was shown checks, and Bing gave
// it results unrelated to the search: the engines are asked as an ordinary
// browser asks.
test("a results page is asked for as an ordinary browser asks for it", async () => {
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, init) => { sent = { url, headers: init.headers }; return { url, status: 200, text: async () => "<html></html>" }; };
  try {
    const got = await browserGet("https://www.bing.com/search?q=kestrel", HEADERS);
    assert.deepEqual(got, { statusCode: 200, body: "<html></html>" });
    assert.match(sent.headers["User-Agent"], /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+/);
    assert.doesNotMatch(JSON.stringify(sent.headers), /ClosedHand|compatible;/i, "nothing that says it is a program");
    assert.match(sent.headers.Accept, /^text\/html,application\/xhtml\+xml/);
    global.fetch = async () => ({ url: "http://127.0.0.1/admin", status: 200, text: async () => "" });
    await assert.rejects(browserGet("https://www.bing.com/search?q=kestrel", HEADERS), /private\/internal/, "an engine's redirect never leads to this computer's network");
  } finally { global.fetch = realFetch; }
});

// A stand-in for the web: each engine's next answer, and a clock to move.
// An engine a test does not mention is showing a check.
function world(answers) {
  const asked = [];
  let clock = 0;
  const get = async (url) => {
    const name = url.includes("lite.duckduckgo") ? "lite" : url.includes("duckduckgo") ? "ddg" : url.includes("bing.com") ? "bing" : "brave";
    asked.push(name);
    const list = answers[name] || [{ statusCode: 200, body: bingCheck }];
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const pass = (ms) => { clock += ms; };
  return { asked, get, now: () => clock, wait: async (ms) => pass(ms), pass };
}
const quiet = (fn) => async () => { const warn = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = warn; } };

test("a check rests that engine and the next one answers", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }, { statusCode: 200, body: ddgPage }], brave: [{ statusCode: 200, body: bravePage }, { statusCode: 200, body: bravePage }, { statusCode: 200, body: braveCheck }], lite: [{ statusCode: 202, body: ddgCheck }] });
  const search = createFreeSearch({ get: w.get, now: w.now, wait: w.wait });
  const first = await search("kestrel point ferry");
  assert.equal(first.source, "Brave");
  assert.deepEqual(w.asked, ["ddg", "brave"]);

  w.asked.length = 0;
  await search("harbour line fares");
  assert.deepEqual(w.asked, ["brave"], "DuckDuckGo is resting, and Brave answered last so goes first");

  w.pass(16 * 60000);
  w.asked.length = 0;
  const later = await search("harbour line fares");
  assert.deepEqual(w.asked, ["brave", "lite", "bing", "ddg"]);
  assert.equal(later.source, "DuckDuckGo", "after its rest DuckDuckGo answers again, now Brave, the Lite page and Bing are checking");
}));

test("rests grow while an engine keeps checking, and search fails only when every engine is resting", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }], brave: [{ statusCode: 200, body: braveCheck }], lite: [{ statusCode: 202, body: ddgCheck }] });
  const search = createFreeSearch({ get: w.get, now: w.now, wait: w.wait });
  await assert.rejects(search("harbour line"), /web search is unavailable.*searching again will not help/);
  w.asked.length = 0;
  await assert.rejects(search("harbour line"), /web search is unavailable/);
  assert.deepEqual(w.asked, [], "nothing is asked while all rest");
  w.pass(15 * 60000 + 1);
  await assert.rejects(search("harbour line"), /unavailable/);
  w.asked.length = 0;
  w.pass(15 * 60000 + 1);
  await assert.rejects(search("harbour line"), /unavailable/);
  assert.deepEqual(w.asked, [], "the second rest is twice as long");
}));

test("requests to one engine are spaced out, and a repeated search is answered from memory", async () => {
  const w = world({ ddg: [{ statusCode: 200, body: ddgPage }], brave: [{ statusCode: 200, body: bravePage }] });
  const waited = [];
  const search = createFreeSearch({ get: w.get, now: w.now, wait: async (ms) => { waited.push(ms); w.pass(ms); } });
  await search("harbour line fares");
  await search("kestrel point");
  assert.deepEqual(waited, [2000], "the second request to DuckDuckGo waits out the gap");
  w.asked.length = 0;
  await search("Harbour line fares ");
  assert.deepEqual(w.asked, [], "the same search within ten minutes is not asked again");
  w.pass(10 * 60000);
  await search("harbour line fares");
  assert.deepEqual(w.asked, ["ddg"]);
});

test("an engine that is slow to answer is passed over", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 200, body: ddgCheck }], brave: [{ statusCode: 200, body: bravePage }], lite: [{ statusCode: 200, body: ddgCheck }] });
  const slow = async (url) => url.includes("brave") ? new Promise(() => {}) : w.get(url);
  await assert.rejects(createFreeSearch({ get: slow, now: w.now, wait: w.wait, answerWithinMs: 20 })("harbour"), /web search failed: Brave took too long/);
}));

test("an engine that cannot be reached is skipped, and its error is named if no engine answers", quiet(async () => {
  const w = world({ ddg: [new Error("Request timed out")], brave: [{ statusCode: 200, body: bravePage }] });
  assert.equal((await createFreeSearch({ get: w.get, now: w.now, wait: w.wait })("kestrel")).source, "Brave");
  const down = world({ ddg: [new Error("Request timed out")], brave: [new Error("Request timed out")], lite: [new Error("Request timed out")] });
  await assert.rejects(createFreeSearch({ get: down.get, now: down.now, wait: down.wait })("kestrel"), /web search failed: Request timed out/);
}));

test("a stopped task sends the answer it drafted, not the line beside its last tool call", () => {
  const messages = [
    { role: "user", content: "Harbour Line to Kestrel Point and back, cost and time?" },
    { role: "assistant", content: [{ type: "text", text: "Checking the fare table." }, { type: "tool_use", id: "t1", name: "web_fetch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Single 4.20" }] },
    { role: "assistant", content: [{ type: "text", text: "8.40 return, about 50 minutes each way." }] },
    { role: "user", content: "VERIFICATION (attempt 1/2): the return fare is not supported." },
    { role: "assistant", content: [{ type: "text", text: "I need to sort the fare evidence first." }, { type: "tool_use", id: "t2", name: "web_fetch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "Return 8.40" }] },
  ];
  assert.equal(writtenAnswer(messages).content[0].text, "8.40 return, about 50 minutes each way.");
  assert.equal(writtenAnswer(messages.slice(0, 3)), null, "with no answer drafted, the write-up from evidence takes over");
  assert.equal(writtenAnswer([{ role: "assistant", content: "Plain string answer." }]).content, "Plain string answer.");
});

test("a page that is really a check for bots is told apart from a page", () => {
  const { looksBlocked } = require("../lib/blocked-page");
  const cloudflare = `<html><head><title>Just a moment...</title></head><body><div>Checking your browser before accessing fares.example.org</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
  assert.equal(looksBlocked(cloudflare), true);
  assert.equal(looksBlocked("<html><body><p>Access Denied</p><p>Reference #18.2f</p></body></html>"), true);
  assert.equal(looksBlocked(`<html><body><h1>Sign in</h1><p>This form is protected by reCAPTCHA.</p></body></html>`), false, "a short page that only mentions a captcha is a page");
  const article = "<html><body><article>" + "Harbour Line timetables change in spring. ".repeat(60) + "Sites sometimes show a captcha or say just a moment... when busy.</article></body></html>";
  assert.equal(looksBlocked(article), false, "a long article that mentions checks is a page");
});

// DuckDuckGo's Lite page is a third chance: the main page had shown a
// Railway server a check minutes before both of its pages answered it.
test("when DuckDuckGo and Brave both check, the Lite page answers", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }], brave: [{ statusCode: 429, body: braveCheck }], lite: [{ statusCode: 200, body: litePage }] });
  const got = await createFreeSearch({ get: w.get, now: w.now, wait: w.wait })("harbour line times");
  assert.deepEqual(w.asked, ["ddg", "brave", "lite"]);
  assert.equal(got.source, "DuckDuckGo Lite");
  assert.equal(got.results[0].url, "https://www.harbour-line.example/times");
}));

// A Railway server once had DuckDuckGo, Brave and the Lite page all showing
// it checks at the same moment, and search had nowhere left to go.
test("when DuckDuckGo, Brave and the Lite page all check, Bing answers", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }], brave: [{ statusCode: 429, body: braveCheck }], lite: [{ statusCode: 202, body: ddgCheck }], bing: [{ statusCode: 200, body: bingPage }] });
  const got = await createFreeSearch({ get: w.get, now: w.now, wait: w.wait })("kestrel point timetable");
  assert.deepEqual(w.asked, ["ddg", "brave", "lite", "bing"]);
  assert.equal(got.source, "Bing");
  assert.equal(got.results[0].url, "https://quay.example.org/kestrel-timetable");
}));

// Photos rather than pages come from Wikimedia Commons: still photos only,
// each with a link at chat size to send, its page, credit and licence.
test("photos come from Wikimedia Commons, still photos only, with credit and licence", async () => {
  const { photoSearch } = require("../lib/web-search");
  const asked = [];
  const get = async (url, opts) => { asked.push({ url, ua: opts.headers["User-Agent"] }); return { ok: true, json: async () => ({ query: { pages: {
    "2": { index: 2, title: "File:Harbour at dawn.webm", imageinfo: [{ mime: "video/webm", url: "https://upload.example/v.webm" }] },
    "1": { index: 1, title: "File:Kestrel Point quay 1989.jpg", imageinfo: [{ mime: "image/jpeg", url: "https://upload.example/full.jpg", thumburl: "https://upload.example/1280px.jpg", descriptionurl: "https://commons.example/wiki/File:Kestrel_Point_quay_1989.jpg", extmetadata: { ImageDescription: { value: "<p>The quay <b>at dawn</b></p>" }, Artist: { value: "<a href='x'>R. Okafor</a>" }, LicenseShortName: { value: "CC BY-SA 4.0" }, DateTimeOriginal: { value: "1989-06-04" } } }] },
  } } }) }; };
  const photos = await photoSearch("kestrel point quay 1989", 3, { get });
  assert.deepEqual(photos, [{ title: "Kestrel Point quay 1989", image: "https://upload.example/1280px.jpg", page: "https://commons.example/wiki/File:Kestrel_Point_quay_1989.jpg", description: "The quay at dawn", date: "1989-06-04", credit: "R. Okafor", licence: "CC BY-SA 4.0" }]);
  assert.match(asked[0].url, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?.*gsrsearch=kestrel\+point\+quay\+1989.*gsrnamespace=6/);
  assert.equal(asked[0].ua, "Closedhand/1.0 (https://closedhand.com)", "Wikimedia asks every client to say who it is");
  const handlers = require("fs").readFileSync(require("path").join(__dirname, "../lib/tools/handlers.js"), "utf8");
  assert.match(handlers, /if \(toolInput\.photos\) \{\n\s+try \{\n\s+const photos = await require\("\.\.\/web-search"\)\.photoSearch\(toolInput\.query, toolInput\.count\);/);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "../lib/connection-jobs.js"), "utf8"), /if \(toolName === "web_search" && toolInput\?\.photos\) return null;/, "no search service stands in for photos");
});

