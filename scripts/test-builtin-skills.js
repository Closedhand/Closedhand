const { test } = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../lib/skills');
skills.loadAllSkills();
test('a skill for a service follows that service being connected', () => {
  const connected = new Set(['shopify']);
  const store = { isConnected: service => connected.has(service) };
  let prompt = skills.getSkillsForPrompt(store, 'shopify sales this week');
  assert.match(prompt, /--- SKILL: Check Shopify sales and stock ---/);
  connected.clear();
  assert.doesNotMatch(skills.getSkillsForPrompt(store, 'shopify sales this week'), /--- SKILL: Check Shopify sales and stock ---/);
});
test('browser Instagram instructions require no ads connection', () => {
  const prompt = skills.getSkillsForPrompt({ isConnected: () => false }, 'comment on my instagram post');
  assert.match(prompt, /--- SKILL: Comment on Instagram posts ---/);
  assert.match(prompt, /sandbox_browse/);
});
