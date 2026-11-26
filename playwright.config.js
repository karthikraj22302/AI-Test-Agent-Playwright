const { defineConfig } = require('@playwright/test');
const { loadEnv } = require('./utils/env');
loadEnv();

const isCI = !!process.env.CI;

module.exports = defineConfig({
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    {
      // your tests (run from VS Code or: npm run test:headed)
      name: 'web',
      testDir: './tests',
      testIgnore: [/generated\//, /heal-demo/, /agent-demo/],
      use: {
        headless: isCI,
        launchOptions: { slowMo: Number(process.env.SLOW_MO || 0) },
        baseURL: process.env.BASE_URL,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure'
      }
    },
    {
      // tests the writer agent saved for you - plain Playwright code, heal-protected, no AI needed to run
      name: 'generated',
      testDir: './tests/generated',
      use: { headless: isCI, screenshot: 'only-on-failure', trace: 'retain-on-failure' }
    },
    {
      // offline proofs (local pages): npm run demo  /  npm run agent:demo
      name: 'demo',
      testDir: './tests',
      testMatch: [/heal-demo/, /agent-demo/],
      use: { headless: true }
    }
  ]
});
