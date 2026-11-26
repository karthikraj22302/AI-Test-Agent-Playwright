// Compact, token-friendly snapshot of the page's interactive/visible elements.
// Shared by the crawler (to teach the test generator) and the healer (to find a replacement locator).
// Each element is tagged with data-ai-id so it can be targeted afterwards.

/* runs inside the browser */
function pageCollector({ limit, includeHidden }) {
  const IMPLICIT = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', table: 'table', li: 'listitem', tr: 'row', td: 'cell', th: 'columnheader' };
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', file: 'file', hidden: null };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); return t in INPUT_ROLE ? INPUT_ROLE[t] : 'textbox'; }
    return IMPLICIT[tag] || null;
  };
  const labelOf = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.textContent); }
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    return '';
  };
  const ownText = el => clean(Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '));
  const cssPath = el => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(`${s}#${CSS.escape(n.id)}`); break; }
      const sib = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };

  const selector = 'a,button,input,select,textarea,label,img[alt],[role],[onclick],[data-testid],[tabindex],h1,h2,h3,h4,summary,[class*=btn],[class*=button],li,td,th,p,span,div';
  const all = Array.from(document.querySelectorAll(selector));
  const out = [];
  let id = 0;
  for (const el of all) {
    if (out.length >= limit) break;
    const tag = el.tagName.toLowerCase();
    const isGeneric = ['p', 'span', 'div', 'li', 'td', 'th'].includes(tag);
    const text = clean(el.innerText || el.textContent || '').slice(0, 80);
    const own = ownText(el).slice(0, 80);
    const isFileInput = tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file';
    const isChoice = tag === 'input' && ['radio', 'checkbox'].includes((el.getAttribute('type') || '').toLowerCase());
    const vis = visible(el);
    // custom-styled radios/checkboxes/file inputs are visually hidden but still real controls
    if (!vis && !isFileInput && !isChoice) continue;
    // generic containers only count when they carry their own short text (leaf-ish)
    const hasSignal = el.getAttribute('role') || el.getAttribute('onclick') || el.getAttribute('data-testid') || el.getAttribute('tabindex') !== null || /btn|button/i.test(el.className?.toString?.() || '');
    if (isGeneric && !hasSignal && (!own || own.length > 60)) continue;
    if (tag === 'label' && !text) continue;
    el.setAttribute('data-ai-id', String(id));
    out.push({
      id: id++,
      tag,
      role: roleOf(el),
      type: el.getAttribute('type') || undefined,
      text: isGeneric ? (own || text) : text,
      placeholder: el.getAttribute('placeholder') || undefined,
      alt: el.getAttribute('alt') || undefined,
      title: el.getAttribute('title') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      label: labelOf(el) || undefined,
      forId: tag === 'label' ? el.getAttribute('for') || undefined : undefined,
      nameAttr: el.getAttribute('name') || undefined,
      htmlId: el.id || undefined,
      testId: el.getAttribute('data-testid') || undefined,
      href: tag === 'a' ? el.getAttribute('href') || undefined : undefined,
      css: cssPath(el),
      visible: vis
    });
  }
  return out;
}

async function collectElements(page, { limit = 400, includeHidden = true } = {}) {
  // Clear stale ids first so ids are always unique per snapshot.
  await page.evaluate(() => document.querySelectorAll('[data-ai-id]').forEach(e => e.removeAttribute('data-ai-id'))).catch(() => {});
  return page.evaluate(pageCollector, { limit, includeHidden });
}

// ---- Selector builder: turns an element description into the most stable Playwright locator ----
// Returns structured candidates {kind,args,code} in order of preference; callers verify uniqueness with count().
const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function candidateLocators(el) {
  const c = [];
  const add = (kind, args) => c.push({ kind, args, code: `${kind}(${args.map(a => typeof a === 'string' ? q(a) : renderObj(a)).join(', ')})` });
  if (el.testId) add('getByTestId', [el.testId]);
  const name = el.ariaLabel || el.label || el.title || el.text;
  if (el.role && el.role !== 'img' && el.role !== 'file' && name && ['button', 'link', 'checkbox', 'radio', 'combobox', 'textbox', 'heading', 'tab', 'menuitem', 'option', 'switch'].includes(el.role)) {
    if (!(el.role === 'textbox' && el.placeholder)) add('getByRole', [el.role, { name }]);
  }
  if (el.placeholder) add('getByPlaceholder', [el.placeholder]);
  if (el.label) add('getByLabel', [el.label]);
  if (el.alt) add('getByAltText', [el.alt]);
  if (el.title && !el.text) add('getByTitle', [el.title]);
  if (el.text && el.text.length <= 60 && !['input', 'textarea', 'select'].includes(el.tag)) add('getByText', [el.text]);
  if (el.htmlId) add('locator', [`#${el.htmlId}`]);
  if (el.nameAttr) add('locator', [`${el.tag}[name="${el.nameAttr}"]`]);
  if (el.css) add('locator', [el.css]);
  return c;
}

function renderObj(o) {
  return `{ ${Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : JSON.stringify(v)}`).join(', ')} }`;
}

// Build a real Playwright Locator from a structured candidate.
function buildLocator(page, cand) {
  return page[cand.kind](...cand.args);
}

module.exports = { collectElements, candidateLocators, buildLocator, renderObj };
