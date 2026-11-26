// Offline planner: no LLM, no API key. Reads the page's controls and decides what to fill.
// Used automatically when no AI provider is configured (or the AI fails).
const DEFAULT_DATA = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test.user@example.com', phone: '9876543210',
  address: '12 Test Street, Chennai', zip: '600001', city: 'Chennai',
  username: 'testuser', password: 'Test@12345', company: 'TeleCMI',
  message: 'This is an automated test message.', url: 'https://example.com', number: '25', subject: 'Maths'
};

// first match wins - order matters (first/last name before generic "name", email before "name@...")
const RULES = [
  [/first\s*-?name|fname|given/i, d => d.firstName],
  [/last\s*-?name|lname|surname|family/i, d => d.lastName],
  [/e-?mail|@/i, d => d.email],
  [/mobile|phone|contact\s*(no|number)|\btel\b/i, d => d.phone],
  [/pass(word)?/i, d => d.password],
  [/user\s*-?name/i, d => d.username],
  [/zip|postal|pin\s*code/i, d => d.zip],
  [/address/i, d => d.address],
  [/\bcity\b/i, d => d.city],
  [/company|organi[sz]ation/i, d => d.company],
  [/full\s*-?name|\bname\b/i, d => d.fullName],
  [/message|comment|description|remarks?/i, d => d.message],
  [/website|url/i, d => d.url]
];
const SKIP = /date|birth|dob|react-select|search|captcha/i;

const key = e => [e.placeholder, e.label, e.ariaLabel, e.nameAttr, e.htmlId, e.title].filter(Boolean).join(' ');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (instruction, text) => !!text && new RegExp(`(^|[^a-z0-9])${escapeRe(text.trim())}([^a-z0-9]|$)`, 'i').test(instruction);

// "state NCR" / "state: NCR" / "state as NCR" -> "NCR"
function optionFor(instruction, name) {
  if (!name) return null;
  const m = instruction.match(new RegExp(`${escapeRe(name)}\\s*(?:as|=|:|is|to|-)?\\s*([A-Za-z][A-Za-z0-9 ]*?)(?=\\s*(?:,|;|\\.|\\band\\b|$))`, 'i'));
  return m ? m[1].trim() : null;
}


// ---- negative cases: "leave first name empty", "invalid email", "submit the empty form" ----
const NEGATIVE_RE = /\b(negative|invalid|empty|blank|without|leave|missing|should not|shouldn'?t|must not|reject|fail)/i;
const wordIn = (text, word) => new RegExp(String(word).trim().replace(/\s+/g, '\\s*'), 'i').test(text);
function invalidValueFor(k) {
  if (/e-?mail|@/i.test(k)) return 'invalid-email';
  if (/mobile|phone|\btel\b/i.test(k)) return '12345';
  if (/zip|postal|pin/i.test(k)) return 'abc';
  return '!!!';
}
function parseNegative(inst) {
  const empty = [], invalid = [];
  const wholeEmpty = /\b(empty|blank)\s+form\b|\bwithout\s+(filling|entering)\b|\bsubmit\s+(it\s+)?(empty|blank)\b/i.test(inst);
  for (const m of inst.matchAll(/\b(?:leave|keep)\s+(?:the\s+)?([a-z][a-z ]*?)\s+(?:field\s+)?(?:empty|blank)\b/gi)) empty.push(m[1].trim());
  for (const m of inst.matchAll(/\bwithout\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z ]*?)(?=\s*(?:,|\.|;|\band\b|\bthen\b|$))/gi)) empty.push(m[1].trim());
  for (const m of inst.matchAll(/\binvalid\s+([a-z][a-z-]*)/gi)) invalid.push(m[1].trim());
  return { wholeEmpty, empty, invalid };
}

function heuristicPlan(elements, instruction = '', userData = {}) {
  const data = { ...DEFAULT_DATA, ...userData };
  const steps = [];
  const done = new Set();
  const inst = String(instruction);
  const neg = parseNegative(inst);

  for (const e of elements) {
    if (neg.wholeEmpty) break; // 'submit the empty form': fill nothing
    if (!e.visible && !['radio', 'checkbox', 'file'].includes(e.type)) continue;

    // text-like inputs
    if ((e.tag === 'input' && !['radio', 'checkbox', 'file', 'submit', 'button', 'reset', 'hidden', 'image', 'date'].includes(e.type)) || e.tag === 'textarea') {
      const k = key(e);
      if (SKIP.test(k)) continue;
      if (/subjects/i.test(k)) { // autocomplete box: type a subject, press Enter to pick the suggestion
        steps.push({ action: 'fill', id: e.id, value: optionFor(inst, 'subjects?') || data.subject || 'Maths', description: 'fill subject' });
        steps.push({ action: 'press', id: e.id, value: 'Enter', description: 'pick suggestion' });
        continue;
      }
      const rule = RULES.find(([re]) => re.test(k));
      let value = rule ? rule[1](data) : null;
      if (!value && e.type === 'number') value = data.number;
      if (!value && e.type === 'url') value = data.url;
      if (!value) continue; // unknown field: leave it empty rather than guess
      if (neg.empty.some(w => wordIn(k, w))) continue;                     // "leave first name empty"
      if (e.type === 'email') value = data.email;
      if (neg.invalid.some(w => wordIn(k, w))) value = invalidValueFor(k); // "invalid email"
      steps.push({ action: 'fill', id: e.id, value, description: `fill ${k || e.tag}` });
      continue;
    }

    // radio groups: pick the option mentioned in the instruction, else the first
    if (e.tag === 'input' && e.type === 'radio') {
      if (done.has(`r:${e.nameAttr}`)) continue;
      const group = elements.filter(x => x.type === 'radio' && x.nameAttr === e.nameAttr);
      if (neg.empty.some(w => wordIn(`${e.nameAttr} ${group.map(x => x.label).join(' ')}`, w))) { done.add(`r:${e.nameAttr}`); continue; }
      const pick = group.find(x => mentions(inst, x.label)) || group[0];
      done.add(`r:${e.nameAttr}`);
      steps.push({ action: 'choose', id: pick.id, description: `choose ${pick.label || 'option'}` });
      continue;
    }

    // checkboxes: only those the instruction mentions
    if (e.tag === 'input' && e.type === 'checkbox') {
      if (mentions(inst, e.label)) steps.push({ action: 'choose', id: e.id, description: `tick ${e.label}` });
      continue;
    }

    // native <select>
    if (e.tag === 'select') {
      const name = e.label || e.ariaLabel || e.nameAttr || '';
      steps.push({ action: 'select', id: e.id, value: optionFor(inst, name), description: `select ${name}` });
      continue;
    }

    // custom dropdowns show a placeholder like "Select State"
    if (['div', 'span'].includes(e.tag) && /^select\b/i.test(e.text || '') && e.text.length < 40) {
      const name = e.text.replace(/^select\s*/i, '');
      steps.push({ action: 'dropdown', id: e.id, option: optionFor(inst, name), description: `open ${e.text}` });
      continue;
    }

    // file upload only when asked for
    if (e.tag === 'input' && e.type === 'file') {
      if (/upload|picture|photo|image|file|attach/i.test(inst)) steps.push({ action: 'upload', id: e.id, value: 'test-data/sample.png', description: 'upload sample file' });
      continue;
    }
  }

  // submit: the last button that looks like a submit
  const submits = elements.filter(e => e.visible && ((e.tag === 'button' && (e.type === 'submit' || /^(submit|save|register|sign\s*up|send|create|add|continue|next)\b/i.test(e.text || ''))) || (e.tag === 'input' && e.type === 'submit')));
  const submit = submits[submits.length - 1];
  if (submit && !/\b(don'?t|do not|without)\s+submit/i.test(inst)) steps.push({ action: 'click', id: submit.id, description: `click ${submit.text || 'submit'}` });
  return steps;
}

module.exports = { heuristicPlan, DEFAULT_DATA, NEGATIVE_RE, parseNegative };
