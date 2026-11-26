// Offline (no-LLM) matcher: parses the broken locator, scores every element on the page against it.
// Fast, free, and good enough for the common case (renamed label / placeholder / alt text, small typos).

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// 0..1 similarity: combines edit distance, token overlap and containment.
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = a.replace(/ /g, ''), sb = b.replace(/ /g, ''); // ignore spaces: 'Login' ~ 'Log in'
  const edit = Math.max(1 - lev(a, b) / Math.max(a.length, b.length), 1 - lev(sa, sb) / Math.max(sa.length, sb.length));
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const dice = (2 * inter) / (ta.size + tb.size);
  const contain = (a.includes(b) || b.includes(a)) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.9 + 0.1 : 0;
  return Math.max(edit, dice * 0.95, contain);
}

// Parse Playwright's locator.toString(): getByRole('button', { name: 'Login' }) / locator('xpath...').first()
function parseLocatorString(str) {
  const first = (str.match(/^(getBy\w+|locator)\(/) || [])[1] || 'locator';
  const strings = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(str))) strings.push((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
  const role = first === 'getByRole' ? strings[0] : undefined;
  const hints = first === 'locator'
    ? [...strings.join(' ').matchAll(/@?[\w-]+\s*=\s*['"]([^'"]+)['"]|text\(\)\s*=\s*['"]([^'"]+)['"]|contains\([^,]+,\s*['"]([^'"]+)['"]\)|#([\w-]+)|\.([\w-]+)/g)].map(x => x[1] || x[2] || x[3] || x[4] || x[5]).filter(Boolean)
    : strings.slice(first === 'getByRole' ? 1 : 0).filter(s => s !== 'true' && s !== 'false');
  return { kind: first, role, hints, raw: str };
}

const ACTION_FIT = {
  fill: el => ['input', 'textarea'].includes(el.tag) && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(el.type) || el.role === 'textbox',
  type: el => ['input', 'textarea'].includes(el.tag),
  pressSequentially: el => ['input', 'textarea'].includes(el.tag),
  clear: el => ['input', 'textarea'].includes(el.tag),
  selectOption: el => el.tag === 'select' || el.role === 'combobox' || el.role === 'listbox',
  setInputFiles: el => el.tag === 'input' && el.type === 'file',
  check: el => ['checkbox', 'radio', 'switch'].includes(el.role) || ['checkbox', 'radio'].includes(el.type),
  uncheck: el => ['checkbox', 'radio', 'switch'].includes(el.role) || ['checkbox', 'radio'].includes(el.type),
  inputValue: el => ['input', 'textarea', 'select'].includes(el.tag)
};

function scoreElement(el, parsed, action) {
  const fields = [el.text, el.placeholder, el.alt, el.title, el.ariaLabel, el.label, el.nameAttr, el.htmlId, el.testId].filter(Boolean);
  if (!fields.length || !parsed.hints.length) return 0;
  let best = 0;
  for (const h of parsed.hints) for (const f of fields) best = Math.max(best, similarity(h, f));
  let score = best;
  const fit = ACTION_FIT[action];
  if (fit && !fit(el)) score *= 0.35;                           // e.g. can't fill a <div>
  if (!fit && (action === 'click' || action === 'dblclick' || action === 'hover') && ['input', 'textarea'].includes(el.tag) && !['button', 'submit', 'checkbox', 'radio'].includes(el.type)) score *= 0.9;
  if (parsed.role && el.role) score *= parsed.role === el.role ? 1.04 : 0.8;
  if (parsed.kind === 'getByPlaceholder' && !el.placeholder) score *= 0.8;
  if (parsed.kind === 'getByAltText' && !el.alt) score *= 0.8;
  if (!el.visible && action !== 'setInputFiles') score *= 0.5;
  // generic wrappers that merely contain the text are weaker than the real control
  if (['div', 'span', 'p', 'li'].includes(el.tag) && !el.role) score *= 0.93;
  return Math.min(score, 1);
}

function rank(elements, parsed, action) {
  return elements
    .map(el => ({ el, score: scoreElement(el, parsed, action) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

module.exports = { parseLocatorString, rank, similarity, ACTION_FIT };
