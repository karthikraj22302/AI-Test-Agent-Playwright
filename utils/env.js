// Tiny .env loader (no dependency). Later lines win; inline "  # comments" are stripped.
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.resolve(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  const fromFile = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    fromFile[m[1]] = value;
  }
  for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v;
}
module.exports = { loadEnv };
