// The healing engine: given a broken locator, find the element the test meant and return a working locator.
// Order: cache (previous heal) -> offline heuristic matcher -> LLM (only if heuristic is unsure).
const cfg = require('../config');
const store = require('./heal-store');
const { collectElements, candidateLocators, buildLocator } = require('../crawler/dom-snapshot');
const { parseLocatorString, rank } = require('./matcher');
const { chat, extractJson, isConfigured } = require('../llm/client');

const SYSTEM = `You repair broken Playwright UI-test locators.
You get: the locator that no longer matches, the action the test performs, and a numbered list of elements currently on the page.
Pick the ONE element the test most likely meant (same purpose, even if its label/placeholder/text was renamed or moved).
Rules: the element must be able to perform the action (fill needs a text input, click needs something clickable, etc.).
If nothing on the page plausibly matches, answer with id null — never guess wildly.
Reply with JSON only: {"id": <number|null>, "confidence": <0..1>, "reason": "<one short sentence>"}`;

const brief = el => {
  const parts = [`#${el.id}`, el.tag + (el.type ? `[type=${el.type}]` : ''), el.role ? `role=${el.role}` : null];
  for (const k of ['text', 'placeholder', 'alt', 'title', 'ariaLabel', 'label', 'nameAttr', 'htmlId', 'testId']) if (el[k]) parts.push(`${k}="${el[k]}"`);
  return parts.filter(Boolean).join(' ');
};

async function askLLM({ original, action, pageUrl, testTitle, candidates }) {
  const user = `Test: ${testTitle || 'unknown'}\nPage: ${pageUrl}\nBroken locator: ${original}\nAction: ${action}\n\nElements on the page:\n${candidates.map(brief).join('\n')}`;
  const res = await chat({ system: SYSTEM, user, temperature: 0, maxTokens: 300 });
  const json = extractJson(res.text);
  if (!json) throw new Error(`Unparseable LLM reply: ${res.text.slice(0, 120)}`);
  return { id: json.id === null || json.id === undefined ? null : Number(json.id), confidence: Number(json.confidence ?? 0.7), reason: json.reason || '', provider: res.provider, model: res.model };
}

// Pick the most stable locator that resolves to exactly the chosen element.
async function stableLocatorFor(page, el) {
  for (const cand of candidateLocators(el)) {
    try {
      const ids = await buildLocator(page, cand).evaluateAll(nodes => nodes.map(n => n.getAttribute('data-ai-id')));
      if (ids.length === 1 && ids[0] === String(el.id)) return { ...cand, persistent: true };
    } catch { /* invalid selector for this candidate, try next */ }
  }
  return { kind: 'locator', args: [`[data-ai-id="${el.id}"]`], code: `locator('${el.css.replace(/'/g, "\\'")}')`, persistent: false };
}

let llmCalls = 0; // AI calls made by this worker; capped by AI_HEAL_MAX_LLM_CALLS

/**
 * @returns {Promise<null | {locator, healed, method, confidence, reason}>}
 */
async function heal(page, { original, action, testTitle }) {
  let urlPath = '/', demo = false;
  try { const u = new URL(page.url()); urlPath = u.pathname || '/'; demo = u.protocol === 'file:'; } catch { /* about:blank etc. */ }

  // 1) cache from a previous heal
  const cached = store.getCached(urlPath, original);
  if (cached) {
    const loc = page[cached.kind](...cached.args);
    if (await loc.count().catch(() => 0) >= 1) {
      return { locator: loc.first(), healed: cached, method: 'cache', confidence: 1, reason: 'reused earlier heal', fromCache: true };
    }
    store.dropCache(urlPath, original);
  }

  // 2) snapshot + offline heuristic
  const elements = await collectElements(page, { limit: cfg.heal.maxElements });
  const parsed = parseLocatorString(original);
  const ranked = rank(elements, parsed, action);
  const top = ranked[0], second = ranked[1];

  let chosen = null, method = '', confidence = 0, reason = '';
  if (top && top.score >= cfg.heal.heuristicMinScore && (!second || top.score - second.score >= cfg.heal.heuristicMinMargin)) {
    chosen = top.el; method = 'heuristic'; confidence = top.score;
    reason = `closest match on page (similarity ${(top.score * 100).toFixed(0)}%)`;
  }

  // 3) LLM when the heuristic was not sure
  let askedLLM = false;
  if (!chosen && cfg.heal.useLLM && cfg.providers.some(isConfigured) && llmCalls < cfg.heal.maxLLMCalls && !store.recentMiss(urlPath, original)) {
    askedLLM = true; llmCalls++;
    const pool = ranked.length
      ? ranked.slice(0, cfg.heal.candidatesForLLM).map(r => r.el)
      : elements.filter(e => e.visible).slice(0, cfg.heal.candidatesForLLM);
    try {
      const r = await askLLM({ original, action, pageUrl: page.url(), testTitle, candidates: pool });
      if (r.id !== null && r.confidence >= cfg.heal.llmMinConfidence) {
        const el = pool.find(e => e.id === r.id);
        if (el) { chosen = el; method = `llm:${r.provider}`; confidence = r.confidence; reason = r.reason; }
      }
    } catch (e) {
      // LLM unavailable: settle for a decent heuristic match rather than fail the test
      if (top && top.score >= 0.7) { chosen = top.el; method = 'heuristic'; confidence = top.score; reason = `LLM unavailable (${e.message.split('\n')[0].slice(0, 80)}); best offline match`; }
    }
  }
  if (!chosen) { if (askedLLM) store.saveMiss(urlPath, original); return null; }

  const healed = await stableLocatorFor(page, chosen);
  const locator = buildLocator(page, healed).first();
  const entry = {
    time: new Date().toISOString(), original,
    healed: { kind: healed.kind, args: healed.args, code: healed.code },
    persistent: healed.persistent && !demo, // only stable locators on the real app are patchable
    demo, method, confidence,
    reason: healed.persistent ? reason : `${reason} (no stable attribute found; review manually)`,
    action, test: testTitle, urlPath
  };
  store.saveHeal(entry);
  return { locator, healed: entry.healed, method, confidence, reason, entry };
}

module.exports = { heal, stableLocatorFor };
