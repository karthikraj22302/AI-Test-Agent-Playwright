// One chat() function, many providers, automatic fallback.
// groq / openrouter / ollama / openai all speak the OpenAI "chat/completions" dialect.
// anthropic uses its own /v1/messages API. Uses Node's built-in fetch (Node 18+).
const cfg = require('../config');

function isConfigured(name) {
  const p = cfg.provider[name];
  if (!p) return false;
  if (name === 'ollama') return true; // local, no key; availability is checked on call
  return !!p.apiKey;
}

async function post(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompatible(name, { system, user, temperature, maxTokens }) {
  const p = cfg.provider[name];
  const headers = { authorization: `Bearer ${p.apiKey}` };
  if (name === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/telecmi/playwright-ai-agent'; headers['X-Title'] = 'Playwright AI Agent'; }
  const data = await post(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, headers, {
    model: p.model,
    temperature,
    max_tokens: Math.max(maxTokens, 1024), // reasoning models spend tokens thinking first
    ...(/gpt-oss/.test(p.model) ? { reasoning_effort: "low" } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, cfg.llmTimeoutMs);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty response from ${name}: ${JSON.stringify(data).slice(0, 200)}`);
  return text;
}

async function callAnthropic({ system, user, temperature, maxTokens }) {
  const p = cfg.provider.anthropic;
  const data = await post(`${p.baseUrl.replace(/\/$/, '')}/v1/messages`, { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, {
    model: p.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }]
  }, cfg.llmTimeoutMs);
  const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error(`Empty response from anthropic: ${JSON.stringify(data).slice(0, 200)}`);
  return text;
}

/**
 * chat({ system, user, temperature?, maxTokens?, providers? }) -> { text, provider, model }
 * Tries each configured provider in order; moves on to the next on any error (rate limit, 5xx, offline...).
 */
async function chat({ system, user, temperature = 0.1, maxTokens = 4096, providers }) {
  const order = (providers || cfg.providers).filter(isConfigured);
  if (!order.length) {
    throw new Error('No LLM provider configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or run Ollama locally (see .env.example).');
  }
  const errors = [];
  for (const name of order) {
    try {
      const text = name === 'anthropic'
        ? await callAnthropic({ system, user, temperature, maxTokens })
        : await callOpenAICompatible(name, { system, user, temperature, maxTokens });
      return { text, provider: name, model: cfg.provider[name].model };
    } catch (e) {
      errors.push(`${name}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  }
  throw new Error(`All LLM providers failed:\n  - ${errors.join('\n  - ')}`);
}

// Pull a JSON object out of a model reply (handles ```json fences and chatter around it).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced && fenced[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
  }
  return null;
}

module.exports = { chat, extractJson, isConfigured };
