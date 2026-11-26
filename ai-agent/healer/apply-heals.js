// Writes healed locators into pages/ and tests/ (a .bak copy is kept next to each changed file).
// Run via `npm run ai:heal:apply`, or automatically when AI_HEAL_AUTOPATCH=true.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const store = require('./heal-store');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SKIP = new Set(['node_modules', 'ai-generated', '.git']);

function sourceFiles() {
  const out = [];
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts)$/.test(e.name) && !/\.bak$/.test(e.name)) out.push(p);
    }
  };
  walk(cfg.dirs.pages); walk(cfg.dirs.tests);
  return out;
}

// Build a regex that matches the broken locator however it was quoted/spaced in the source.
// Playwright prints e.g.  getByRole('button', { name: 'Login' })  but the source may use "Login" or `Login`.
function sourcePattern(original) {
  const m = original.match(/^(getBy\w+|locator)\(([\s\S]*)\)$/);
  if (!m) return null;
  const [, kind, inner] = m;
  const strRe = /'((?:[^'\\]|\\.)*)'/g;
  let out = '', last = 0, mm;
  const loose = t => esc(t).replace(/\s+/g, '\\s*');
  while ((mm = strRe.exec(inner))) {
    out += loose(inner.slice(last, mm.index));
    const raw = mm[1].replace(/\\(.)/g, '$1');                       // un-escape \' etc.
    const body = esc(raw).replace(/(['"`])/g, '\\\\?$1');          // quotes inside may or may not be escaped in source
    out += `(?:'|"|\`)${body}(?:'|"|\`)`;
    last = strRe.lastIndex;
  }
  out += loose(inner.slice(last));
  return new RegExp(`\\b${kind}\\(\\s*${out}\\s*\\)`, 'g');
}

function applyOne(entry) {
  const re = sourcePattern(entry.original.replace(/\.(first|last|nth\([^)]*\))$/, ''));
  if (!re) return { patched: [] };
  const replacement = entry.healed.code;
  const patched = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    re.lastIndex = 0;
    if (!re.test(src)) continue;
    re.lastIndex = 0;
    const next = src.replace(re, replacement);
    if (next !== src) {
      if (!fs.existsSync(`${file}.bak`)) fs.writeFileSync(`${file}.bak`, src);
      fs.writeFileSync(file, next);
      patched.push(path.relative(cfg.root, file));
    }
  }
  return { patched };
}

function applyAll() {
  const list = store.loadSuggestions();
  let n = 0;
  for (const s of list) {
    if (s.status !== 'pending' || !s.persistent) continue;
    const { patched } = applyOne(s);
    if (patched.length) {
      s.status = 'applied'; s.patchedFiles = patched; n++;
      console.log(`patched ${patched.join(', ')}:\n   ${s.original}\n-> ${s.healed.code}`);
    } else {
      console.log(`could not find in source (edit manually): ${s.original}  ->  ${s.healed.code}`);
    }
  }
  store.saveSuggestions(list);
  console.log(`\n${n} locator(s) patched. Originals saved as *.bak next to each changed file.`);
}

if (require.main === module) applyAll();
module.exports = { applyOne, applyAll, sourcePattern };
