// WRITER AGENT: reads the page that is open, decides what to do from a plain-English instruction,
// does it (with the healer watching), and saves the result as a normal Playwright spec.
//
//   await aiAgent(page, 'Fill the form with realistic data, choose Male, tick Sports, submit', { save: true });
//
// Planning:  AI (Groq/OpenRouter/Ollama/Claude)  ->  falls back to the offline rule-based planner.
// Plans are cached in ai-agent/plans so the 2nd run needs no AI. Set AI_AGENT_REPLAN=true to redo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { collectElements } = require('../crawler/dom-snapshot');
const { stableLocatorFor } = require('../healer/healer');
const { chat, extractJson, isConfigured } = require('../llm/client');
const { heuristicPlan, NEGATIVE_RE } = require('./heuristic-plan');
const { emitSpec, cleanupSelectors, q } = require('./code-emitter');

const EXPECTS = new Set(['expectText', 'expectInvalid', 'expectGone', 'expectUrl']);
const ACTIONS = new Set(['fill', 'choose', 'select', 'dropdown', 'upload', 'press', 'click']);
const log = (...a) => console.log('[ai-agent]', ...a);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';

function currentTitle() {
  try { return require('@playwright/test').test.info().title; } catch { return null; }
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); // ad-heavy sites never go idle
}

// ---------------------------------------------------------------- planning
const SYSTEM = `You plan UI test steps for a web page. You get the page's controls as a numbered list and a plain-English instruction.
Reply with JSON ONLY: {"steps":[{"action":"...","id":<number>,"value":"...","option":"...","key":"...","description":"..."}]}

Actions:
- fill     {id, value}   text / email / phone / password / textarea fields
- choose   {id}          radio buttons and checkboxes (use the id of the radio/checkbox input)
- select   {id, value}   native <select> (value = visible option text)
- dropdown {id, option}  custom dropdown shown as a box with placeholder text like "Select State"; option = text to pick
- upload   {id}          file input
- press    {id, key}     e.g. Enter after typing in an autocomplete field
- click    {id}          buttons and links (the submit button goes LAST)

Rules:
1. Use ONLY ids from the list. Never invent ids.
2. Work top to bottom. A dependent dropdown (e.g. City) must come after the one it depends on (State).
3. Use the values given in the instruction. Where none are given, invent realistic test data.
4. Skip date pickers and read-only fields unless the instruction asks for them.
5. Autocomplete field: fill, then press Enter.
6. Do not add navigation or assertions; the agent adds those.
7. NEGATIVE cases: if the instruction asks for empty or invalid data, follow it literally. Omit the step for a field that must stay empty; use the invalid value for a field that must be invalid. The submit click still goes last.`;

const GENERIC = new Set(['div', 'span', 'p', 'li', 'td', 'th']);
function forPrompt(elements) {
  return elements.filter(e => {
    if (e.tag === 'label') return false;                      // inputs already carry their label
    if (GENERIC.has(e.tag)) return /^select\b/i.test(e.text || '') || e.role === 'combobox';
    return true;
  });
}
const line = e => '#' + e.id + ' ' + [e.tag + (e.type ? `[${e.type}]` : ''),
  ...['label', 'placeholder', 'text', 'ariaLabel', 'title', 'nameAttr', 'htmlId'].filter(k => e[k]).map(k => `${k}="${String(e[k]).slice(0, 50)}"`)].join(' ');

async function llmPlan(elements, instruction, url, data) {
  const user = `Page: ${url}\nInstruction: ${instruction}\n${data ? `Preferred data: ${JSON.stringify(data)}\n` : ''}\nControls:\n${forPrompt(elements).map(line).join('\n')}`;
  const res = await chat({ system: SYSTEM, user, temperature: 0.1, maxTokens: 3000 });
  const json = extractJson(res.text);
  if (!json || !Array.isArray(json.steps)) throw new Error('AI reply was not a valid plan');
  const ids = new Set(elements.map(e => e.id));
  const steps = json.steps.filter(s => s && ACTIONS.has(s.action) && ids.has(Number(s.id))).map(s => ({
    action: s.action,
    id: Number(s.id),
    value: s.action === 'press' ? (s.key || s.value || 'Enter') : (s.value ?? (s.action === 'upload' ? 'test-data/sample.png' : null)),
    option: s.option ?? null,
    description: s.description || s.action
  }));
  if (!steps.length) throw new Error('AI plan had no usable steps');
  return { steps, planner: `llm:${res.provider}` };
}

// ---------------------------------------------------------------- resolving ids -> stable locators
async function resolveSteps(page, elements, raw) {
  const byId = new Map(elements.map(e => [e.id, e]));
  const out = [];
  for (const s of raw) {
    const el = byId.get(s.id);
    if (!el) continue;
    let locator;
    if (s.action === 'choose') {
      const text = el.tag === 'label' ? el.text : el.label;
      if (text && (await page.getByText(text, { exact: true }).count()) === 1) {
        locator = { kind: 'getByText', args: [text, { exact: true }], code: `getByText(${q(text)}, { exact: true })` };
      } else if (el.htmlId && (await page.locator(`label[for="${el.htmlId}"]`).count()) === 1) {
        locator = { kind: 'locator', args: [`label[for="${el.htmlId}"]`], code: `locator(${q(`label[for="${el.htmlId}"]`)})` };
      } else {
        const l = await stableLocatorFor(page, el);
        locator = { kind: l.kind, args: l.args, code: l.code, force: true }; // hidden input: tick it directly
      }
    } else {
      const l = await stableLocatorFor(page, el);
      locator = { kind: l.kind, args: l.args, code: l.code };
    }
    out.push({ action: s.action, locator, value: s.value ?? null, option: s.option ?? null, description: s.description || s.action });
  }
  return out;
}

// ---------------------------------------------------------------- running
const mask = (s, v) => (/pass/i.test(s.locator.code) ? '***' : v);

async function execStep(page, s) {
  const loc = () => page[s.locator.kind](...s.locator.args);
  switch (s.action) {
    case 'fill': await loc().fill(String(s.value)); break;
    case 'press': await loc().press(s.value || 'Enter'); break;
    case 'click': await loc().click(); break;
    case 'choose': s.locator.force ? await loc().check({ force: true }) : await loc().click(); break;
    case 'select': s.value == null ? await loc().selectOption({ index: 1 }) : await loc().selectOption(String(s.value)); break;
    case 'upload': await loc().setInputFiles(s.value || 'test-data/sample.png'); break;
    case 'dropdown': {
      await loc().click({ force: true }); // custom dropdowns have an invisible layer over the label
      if (!s.option) { // no option named: take the first one offered, and remember it for the generated spec
        const options = page.locator('[id*="-option-"], [role="option"]').filter({ visible: true }); // only the menu that is open now
        await options.first().waitFor({ state: 'visible' });
        s.option = ((await options.allTextContents()).map(t => t.trim()).find(Boolean)) || null;
        if (!s.option) throw new Error(`no options appeared for ${s.locator.code}`);
      }
      await page.getByText(s.option, { exact: true }).last().click();
      break;
    }
    case 'expectText': await require('@playwright/test').expect(page.getByText(s.text).first()).toBeVisible(); break;
    case 'expectInvalid': await require('@playwright/test').expect(page.locator(s.selector)).not.toHaveCount(0); break;
    case 'expectGone': await require('@playwright/test').expect(page.getByText(s.text).first()).toBeHidden(); break; // absent OR hidden
    case 'expectUrl': await require('@playwright/test').expect(page).toHaveURL(s.url); break;
    default: throw new Error(`unknown step ${s.action}`);
  }
}

async function runPlan(page, steps) {
  const sels = cleanupSelectors(page.url());
  if (sels.length) await page.evaluate(ss => { for (const s of ss) document.querySelectorAll(s).forEach(e => e.remove()); }, sels);
  let n = 0;
  for (const s of steps) {
    n++;
    const shown = s.action === 'dropdown' ? (s.option || 'first option') : EXPECTS.has(s.action) ? (s.text || s.selector || s.url) : mask(s, s.value);
    log(`step ${n}/${steps.length}: ${s.action} ${s.locator ? s.locator.code : ''}${shown ? ` = ${shown}` : ''}`);
    await execStep(page, s);
  }
}

// After the final click, look for a "thanks / success" message and turn it into an assertion.
// Only an element's OWN short text counts (e.g. the popup title), never a whole container's text.
const RESULT_RE = '(thank|success|submitted|saved|created|registered|welcome|added)';
async function matchingTexts(page, src = RESULT_RE) {
  return page.evaluate(src => {
    const re = new RegExp(src, 'i');
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (!own || own.length > 90 || !re.test(own)) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') out.push(own);
    }
    return out;
  }, src).catch(() => []);
}
async function observeResult(page, beforeTexts) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const hit = (await matchingTexts(page)).find(t => !beforeTexts.has(t));
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  return null;
}


// NEGATIVE test: the page must REJECT the data. Fail loudly if it accepted it; otherwise record the evidence.
const ERROR_RE = '(required|invalid|error|must be|please (enter|select|provide|fill)|cannot be (empty|blank)|mandatory|not valid)';
const INVALID_SEL = 'input:invalid, select:invalid, textarea:invalid, [aria-invalid="true"]';
async function observeRejection(page, startUrl, before, beforeErr, opts) {
  const end = Date.now() + 3000;
  let accepted = null;
  while (Date.now() < end && !accepted) {
    accepted = (await matchingTexts(page)).find(t => !before.has(t)) || null;
    if (!accepted) await page.waitForTimeout(300);
  }
  if (accepted) throw new Error(`Negative test FAILED: the page showed "${accepted}" - it ACCEPTED the bad data (it should have been rejected).`);
  if (opts.expectNot && (await page.getByText(opts.expectNot).filter({ visible: true }).count()) > 0) {
    throw new Error(`Negative test FAILED: "${opts.expectNot}" is shown - the page accepted the bad data.`);
  }
  const checks = [];
  if (opts.expectNot) checks.push({ action: 'expectGone', text: opts.expectNot, description: `"${opts.expectNot}" is NOT shown` });
  const invalid = await page.locator(INVALID_SEL).count();
  if (invalid > 0) checks.push({ action: 'expectInvalid', selector: INVALID_SEL, description: `${invalid} field(s) rejected by the form` });
  for (const t of (await matchingTexts(page, ERROR_RE)).filter(x => !beforeErr.has(x)).slice(0, 3)) {
    checks.push({ action: 'expectText', text: t, description: `error message "${t}" is visible` });
  }
  checks.push({ action: 'expectUrl', url: startUrl, description: 'still on the same page' });
  if (checks.length === 1 && !opts.expectNot) log('! no field errors found on the page - add { expectNot: "<success text>" } to the test so the negative check is meaningful.');
  return checks;
}

// ---------------------------------------------------------------- plan cache + spec file
const planFile = key => path.join(cfg.dirs.plans, `${key}.json`);
function loadPlan(key) { try { return JSON.parse(fs.readFileSync(planFile(key), 'utf8')); } catch { return null; } }
function savePlan(key, plan) { fs.mkdirSync(cfg.dirs.plans, { recursive: true }); fs.writeFileSync(planFile(key), JSON.stringify(plan, null, 2)); }

function writeSpec({ title, instruction, url, steps }) {
  fs.mkdirSync(cfg.dirs.generated, { recursive: true });
  let file = path.join(cfg.dirs.generated, `${slug(title)}.spec.js`);
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith('// AI-GENERATED')) {
    file = file.replace(/\.spec\.js$/, `-${Date.now()}.spec.js`); // never overwrite a hand-written file
  }
  fs.writeFileSync(file, emitSpec({ title, instruction, url, steps }));
  return path.relative(cfg.root, file);
}

// ---------------------------------------------------------------- public API
/**
 * @param page         Playwright page (use the one from fixtures/ai.fixture so healing is on)
 * @param instruction  plain English, e.g. 'Fill the form with realistic data and submit'
 * @param opts         { title, save=true, data, replan, expect }
 *                     data   = values to prefer, e.g. { firstName: 'Karthik', email: 'k@x.com' }
 *                     expect = text that must be visible at the end (otherwise the agent looks for a success message)
 */
async function aiAgent(page, instruction, opts = {}) {
  const url = page.url();
  const title = opts.title || currentTitle() || 'ai-agent-test';
  const u = new URL(url);
  const key = crypto.createHash('sha1').update(`${instruction}|${u.origin}${u.pathname}`).digest('hex').slice(0, 12);
  const replan = opts.replan ?? cfg.agent.replan;

  let plan = replan ? null : loadPlan(key);
  if (plan) {
    log(`reusing saved plan (${plan.steps.length} steps, made by ${plan.planner}${plan.verified === false ? ', not verified yet' : ''}) - NO AI call. Set AI_AGENT_REPLAN=true to plan again.`);
  } else {
    await settle(page);
    log(`reading the page: ${url}`);
    const elements = await collectElements(page, { limit: cfg.agent.maxElements });
    log(`found ${elements.length} controls`);

    let planned = null;
    if (cfg.agent.useLLM && cfg.providers.some(isConfigured)) {
      try { planned = await llmPlan(elements, instruction, url, opts.data); }
      catch (e) { log(`AI planning failed (${e.message.split('\n')[0].slice(0, 120)}) - using offline planner`); }
    }
    if (!planned) planned = { steps: heuristicPlan(elements, instruction, opts.data), planner: 'offline' };
    log(`plan by ${planned.planner}: ${planned.steps.length} steps`);

    const steps = await resolveSteps(page, elements, planned.steps);
    if (!steps.length) throw new Error('The agent could not find anything to do on this page. Check the URL and the instruction.');
    plan = { instruction, url, planner: planned.planner, createdAt: new Date().toISOString(), verified: false, steps };
    savePlan(key, plan); // saved BEFORE running: a failed run must not cost another AI call
  }

  const before = new Set(await matchingTexts(page));
  const beforeErr = new Set(await matchingTexts(page, ERROR_RE));
  await runPlan(page, plan.steps);

  if (plan.verified === false) { // first time this plan ran to the end: add the result checks and mark it good
    const negative = opts.negative ?? NEGATIVE_RE.test(instruction);
    let checks = [];
    if (negative) {
      checks = await observeRejection(page, url, before, beforeErr, opts);
    } else {
      const last = plan.steps[plan.steps.length - 1];
      const expectText = opts.expect || (last.action === 'click' ? await observeResult(page, before) : null);
      if (expectText) checks = [{ action: 'expectText', text: expectText, description: `"${expectText}" is visible` }];
    }
    for (const s of checks) {
      log(`verify${negative ? ' (negative)' : ''}: ${s.description}`);
      await execStep(page, s);
      plan.steps.push(s);
    }
    plan.verified = true;
    savePlan(key, plan);
  }

  let specFile = null;
  if (opts.save !== false) {
    specFile = writeSpec({ title, instruction, url: plan.url || url, steps: plan.steps });
    log(`saved test code -> ${specFile}`);
  }
  return { plan, specFile };
}

module.exports = { aiAgent };
