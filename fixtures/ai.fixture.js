// Drop-in replacement for `require('@playwright/test')` that adds AI self-healing locators.
//   const { test, expect } = require('../../fixtures/ai.fixture');
// Set AI_HEAL=false in .env to turn healing off without touching the tests.
const base = require('@playwright/test');
const { healingPage } = require('../ai-agent/healer/healing-page');

const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const heals = [];
    const wrapped = healingPage(page, { getTitle: () => testInfo.title, record: h => heals.push(h) });
    await use(wrapped);
    if (heals.length) {
      await testInfo.attach('ai-heal', { body: JSON.stringify(heals, null, 2), contentType: 'application/json' });
      testInfo.annotations.push({ type: 'ai-healed', description: `${heals.length} locator(s) healed - see heal report` });
    }
  }
});

module.exports = { test, expect: base.expect };
