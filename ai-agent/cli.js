#!/usr/bin/env node
// node ai-agent/cli.js ping | heal-report | write <url> "<instruction>" [--headless] [--replan]
const fs = require('fs');
const cfg = require('./config');
const cmd = process.argv[2];
(async () => {
  if (cmd === 'ping') {
    const { chat, isConfigured } = require('./llm/client');
    for (const name of cfg.providers) {
      if (!isConfigured(name)) { console.log(`- ${name}: not configured (no API key)`); continue; }
      try {
        const r = await chat({ system: 'Reply with the single word OK.', user: 'ping', maxTokens: 10, providers: [name] });
        console.log(`- ${name}: OK  (${r.model})`);
      } catch (e) { console.log(`- ${name}: FAILED  ${e.message.replace(/\s+/g, ' ').slice(0, 250)}`); }
    }
  } else if (cmd === 'heal-report') {
    const store = require('./healer/heal-store');
    if (!store.loadSuggestions().length) return console.log('No heals recorded yet.');
    console.log(fs.readFileSync(store.reportFile, 'utf8'));
  } else if (cmd === 'write') {
    // Open a page, let the agent read it and do the instruction, save the spec. No test file needed.
    const args = process.argv.slice(3);
    const flags = args.filter(a => a.startsWith('--'));
    const [url, ...rest] = args.filter(a => !a.startsWith('--'));
    const instruction = rest.join(' ');
    if (!url || !instruction) { console.log('Usage: npm run agent:write -- <url> "<what to do in plain English>"'); process.exit(1); }
    const { chromium } = require('@playwright/test');
    const { healingPage } = require('./healer/healing-page');
    const { aiAgent } = require('./writer/agent');
    const browser = await chromium.launch({ headless: flags.includes('--headless') });
    const page = healingPage(await browser.newPage());
    try {
      await page.goto(url);
      const title = instruction.split(/\s+/).slice(0, 6).join(' ');
      const r = await aiAgent(page, instruction, { title, replan: flags.includes('--replan') || undefined });
      console.log(`\nDone. Run it any time with:  npx playwright test ${r.specFile} --project=generated --headed`);
      await page.waitForTimeout(2000);
    } finally { await browser.close(); }
  } else {
    console.log('Usage: npm run ai:ping | ai:heal:report | ai:heal:apply | agent:write -- <url> "<instruction>"');
  }
})();
