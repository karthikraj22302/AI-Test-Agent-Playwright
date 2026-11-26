// YOUR TEST. Press "Run" on it in VS Code (or: npm run fill-form).
//
// What happens:
//  1. The browser opens the page.
//  2. The AI agent READS the page (every field, radio, dropdown, button).
//  3. It plans from the instruction below, fills the form, submits and checks the "thanks" message.
//  4. It SAVES the test code it wrote to  tests/generated/open-website-fill-form.spec.js
//  5. If a locator breaks later, the healer fixes it while the test runs.
// Change the instruction in plain English to make it do something different.
const { test } = require('../fixtures/ai.fixture');
const { aiAgent } = require('../ai-agent/writer/agent');

const URL = 'https://demoqa.com/automation-practice-form';
const SUCCESS = 'Thanks for submitting the form';

// ---------- POSITIVE ----------
test('Open website fill form', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page,
    'Fill the form with realistic data, choose Male, tick Sports and Music, state NCR, city Delhi, then submit',
    {
      data: { firstName: 'Karthik', lastName: 'Raj', email: 'karthik.test@example.com', phone: '9876543210' }
    });
});

// ---------- NEGATIVE ----------
test('Negative - submit empty form', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page, 'Submit the empty form without filling anything',
    { negative: true, expectNot: SUCCESS });
});

test('Negative - missing first name', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page, 'Fill the form with realistic data but leave first name empty, choose Male, then submit',
    { negative: true, expectNot: SUCCESS });
});