const { test } = require('node:test');
const assert = require('node:assert/strict');
const sw = require('../lib/sleep-watch');
test('a clock jump longer than the gap reads as sleep; a slow step does not', () => {
  const t0 = Date.now();
  assert.equal(sw.tick(t0), 0);
  assert.equal(sw.tick(t0 + 5000), 0, 'a normal tick');
  assert.equal(sw.tick(t0 + 5000 + 20000), 0, 'a slow step under the gap');
  const gap = sw.tick(t0 + 25000 + 600000);
  assert.ok(gap >= 600000, 'ten minutes asleep');
});
test('whoever asked is told when the machine wakes, and how long it slept', () => {
  const told = [];
  const t0 = Date.now() + 3600000;
  sw.tick(t0);
  sw.onWake((gap) => told.push(gap));
  sw.tick(t0 + 5000);
  assert.deepEqual(told, [], 'a normal tick is no wake');
  sw.tick(t0 + 5000 + 480000);
  assert.deepEqual(told, [480000]);
});
test('a network failure is retried after short pauses, awake or not; a refusal is not', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 2) throw new Error('fetch failed'); return 'ok'; };
  assert.equal(await sw.retryNetwork(new Error('fetch failed'), flaky, { pauses: [1, 1] }), 'ok');
  assert.equal(calls, 2, 'stopped retrying once it worked');
  await assert.rejects(sw.retryNetwork(new Error('The model provider returned HTTP 400.'), flaky, { pauses: [1] }), /HTTP 400/);
  let tries = 0;
  await assert.rejects(sw.retryNetwork(new Error('fetch failed'), async () => { tries++; throw new Error('socket hang up'); }, { pauses: [1, 1] }), /socket hang up/);
  assert.equal(tries, 2, 'every pause gets one try, then it gives up');
});
