// Persistence for healing: a cache (so a healed locator is reused instantly next run)
// and a suggestions list (what the engineer reviews / what apply-heals patches into source).
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const cacheFile = path.join(cfg.dirs.healData, 'heal-cache.json');
const suggestionsFile = path.join(cfg.dirs.healData, 'heal-suggestions.json');
const reportFile = path.join(cfg.dirs.healData, 'heal-report.md');

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // atomic-ish write so parallel workers don't corrupt the file
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const keyFor = (urlPath, original) => `${urlPath}::${original}`;
const missFile = path.join(cfg.dirs.healData, 'heal-misses.json');

// remember "the AI found nothing for this locator" so re-running a failing test does not spend tokens again
function recentMiss(urlPath, original) {
  const t = read(missFile, {})[keyFor(urlPath, original)];
  return !!t && Date.now() - t < cfg.heal.missTtlMin * 60000;
}
function saveMiss(urlPath, original) {
  const m = read(missFile, {});
  m[keyFor(urlPath, original)] = Date.now();
  write(missFile, m);
}

function getCached(urlPath, original) {
  return read(cacheFile, {})[keyFor(urlPath, original)] || null;
}

function saveHeal(entry) {
  const cache = read(cacheFile, {});
  cache[keyFor(entry.urlPath, entry.original)] = { kind: entry.healed.kind, args: entry.healed.args, code: entry.healed.code, healedAt: entry.time };
  write(cacheFile, cache);

  const list = read(suggestionsFile, []);
  const dup = list.find(s => s.original === entry.original && s.healed.code === entry.healed.code && s.status === (entry.demo ? 'demo' : 'pending'));
  if (dup) { dup.count = (dup.count || 1) + 1; dup.lastSeen = entry.time; }
  else list.push({ ...entry, status: entry.demo ? 'demo' : 'pending', count: 1, lastSeen: entry.time });
  write(suggestionsFile, list);
  writeReport(list);
}

function dropCache(urlPath, original) {
  const cache = read(cacheFile, {});
  delete cache[keyFor(urlPath, original)];
  write(cacheFile, cache);
}

function loadSuggestions() { return read(suggestionsFile, []); }
function saveSuggestions(list) { write(suggestionsFile, list); writeReport(list); }

function writeReport(list) {
  const rows = list.map(s =>
    `| ${s.status} | \`${s.original}\` | \`${s.healed.code}\` | ${s.method}${s.confidence != null ? ` (${Math.round(s.confidence * 100)}%)` : ''} | ${s.test || ''} | ${s.urlPath} | ${(s.reason || '').replace(/\|/g, '/')} |`);
  const md = `# AI locator healing report\n\nGenerated ${new Date().toISOString()}\n\n` +
    `| Status | Broken locator | Healed locator | Method | Test | Page | Reason |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
    `Apply pending fixes to your page objects with \`npm run ai:heal:apply\`.\n`;
  fs.writeFileSync(reportFile, md);
}

module.exports = { recentMiss, saveMiss, getCached, saveHeal, dropCache, loadSuggestions, saveSuggestions, reportFile, suggestionsFile };
