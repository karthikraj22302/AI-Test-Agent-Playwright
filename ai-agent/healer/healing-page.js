// Wraps a Playwright Page so that locator ACTIONS (click, fill, ...) self-heal.
//
// Design decisions:
//  * Only actions heal. Assertions (expect(...).toBeVisible()) never heal - a missing expected
//    message is a real failure, healing it would hide bugs.
//  * The original locator gets `probeTimeoutMs` to work. If the element is simply absent (count()==0)
//    we heal. If it exists but the action failed for another reason (disabled, covered...) we rethrow.
//  * If no heal is found, the original action is retried with the normal timeout, so behaviour
//    for genuinely-slow pages is unchanged.
const cfg = require('../config');
const { heal } = require('./healer');

const FACTORIES = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId']);
const CHAIN = new Set(['first', 'last', 'nth', 'filter', 'locator', 'and', 'or', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId']);
// action -> index of the options argument (where `timeout` lives)
const ACTIONS = {
  click: 0, dblclick: 0, hover: 0, check: 0, uncheck: 0, tap: 0, focus: 0, blur: 0, clear: 0,
  fill: 1, press: 1, type: 1, pressSequentially: 1, selectOption: 1, setInputFiles: 1, setChecked: 1,
  textContent: 0, innerText: 0, inputValue: 0, getAttribute: 1
};

function isMissingElement(err) {
  const m = String(err && err.message);
  return /Timeout .*exceeded/i.test(m) || /waiting for/i.test(m) || /element\(s\) not found/i.test(m);
}

function withTimeout(args, optIdx, timeout) {
  const a = args.slice();
  while (a.length <= optIdx) a.push(undefined);
  if (a[optIdx] && typeof a[optIdx] === 'object' && !Array.isArray(a[optIdx])) {
    if (a[optIdx].timeout === undefined) a[optIdx] = { ...a[optIdx], timeout };
  } else if (a[optIdx] === undefined) {
    a[optIdx] = { timeout };
  } else return args; // unexpected shape, leave untouched
  return a;
}

function wrapLocator(locator, ctx) {
  return new Proxy(locator, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(ACTIONS, prop)) {
        return async (...args) => {
          if (!cfg.heal.enabled) return target[prop](...args);
          const optIdx = ACTIONS[prop];
          const userTimeout = args[optIdx] && typeof args[optIdx] === 'object' ? args[optIdx].timeout : undefined;
          const probe = userTimeout ?? Math.min(cfg.heal.probeTimeoutMs, 60000);
          try {
            return await target[prop](...withTimeout(args, optIdx, probe));
          } catch (err) {
            if (!isMissingElement(err)) throw err;
            const present = await target.count().catch(() => 0);
            if (present > 0) throw err; // exists, so this is not a locator problem
            const title = ctx.getTitle();
            const healed = await heal(ctx.page, { original: String(target), action: prop, testTitle: title }).catch(e => { console.warn(`[ai-heal] healing crashed: ${e.message}`); return null; });
            if (!healed) {
              // nothing better found: behave as before (full normal timeout), then fail normally
              return target[prop](...args);
            }
            console.log(`[ai-heal] ${String(target)}  ->  ${healed.healed.code}   (${healed.method}, ${Math.round(healed.confidence * 100)}%)`);
            ctx.record({ original: String(target), healed: healed.healed.code, method: healed.method, confidence: healed.confidence, reason: healed.reason });
            if (cfg.heal.autoPatch && healed.entry && healed.entry.persistent) {
              try { require('./apply-heals').applyOne(healed.entry); } catch (e) { console.warn(`[ai-heal] auto-patch failed: ${e.message}`); }
            }
            return healed.locator[prop](...args);
          }
        };
      }
      if (typeof prop === 'string' && CHAIN.has(prop)) {
        return (...args) => wrapLocator(target[prop](...unwrapArgs(args)), ctx);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' && prop !== 'constructor' ? v.bind(target) : v; // keep `constructor` intact: expect() identifies Locator/Page by it
    }
  });
}

// locators passed back into Playwright (e.g. locator.and(other)) must be the real objects
const unwrapArgs = args => args; // Proxies of Locator pass instanceof checks; Playwright reads only its own fields

function healingPage(page, { getTitle = () => '', record = () => {} } = {}) {
  const ctx = { page, getTitle, record };
  return new Proxy(page, {
    get(target, prop) {
      if (typeof prop === 'string' && FACTORIES.has(prop)) {
        return (...args) => wrapLocator(target[prop](...args), ctx);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' && prop !== 'constructor' ? v.bind(target) : v; // keep `constructor` intact: expect() identifies Locator/Page by it
    }
  });
}

module.exports = { healingPage, wrapLocator };
