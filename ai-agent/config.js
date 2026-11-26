// Central config for the AI agent. Everything comes from .env / environment variables.
const path = require('path');
const { loadEnv } = require('../utils/env');
loadEnv();

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const root = path.resolve(__dirname, '..');

module.exports = {
  root,
  dirs: {
    pages: path.join(root, 'pages'),
    tests: path.join(root, 'tests'),
    generatedTests: path.join(root, 'tests', 'ai-generated'),
    generatedPages: path.join(root, 'pages', 'ai-generated'),
    output: path.join(__dirname, 'output'),
    healData: path.join(__dirname, 'heal-data'),
    generated: path.join(root, 'tests', 'generated'),
    plans: path.join(__dirname, 'plans')
  },

  // Provider order = fallback order. First configured provider that answers wins.
  providers: (env.AI_PROVIDERS || 'groq,openrouter,ollama,anthropic')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  llmTimeoutMs: num(env.AI_LLM_TIMEOUT_MS, 90000),

  provider: {
    groq: {
      baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b'
    },
    openrouter: {
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      apiKey: 'ollama', // not checked by Ollama
      model: env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
    },
    anthropic: {
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'
    },
    openai: {
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || 'gpt-4o-mini'
    }
  },

  heal: {
    enabled: bool(env.AI_HEAL, true),
    // How long the ORIGINAL locator gets before we consider it broken.
    probeTimeoutMs: num(env.AI_HEAL_PROBE_TIMEOUT_MS, 8000),
    // Use the LLM only when the offline heuristic is not confident enough.
    useLLM: bool(env.AI_HEAL_USE_LLM, true),
    heuristicMinScore: num(env.AI_HEAL_MIN_SCORE, 0.82),
    heuristicMinMargin: num(env.AI_HEAL_MIN_MARGIN, 0.12),
    llmMinConfidence: num(env.AI_HEAL_LLM_MIN_CONFIDENCE, 0.6),
    // Rewrite the locator inside pages/ and tests/ automatically after a successful heal.
    autoPatch: bool(env.AI_HEAL_AUTOPATCH, false),
    maxElements: num(env.AI_HEAL_MAX_ELEMENTS, 400),
    candidatesForLLM: num(env.AI_HEAL_LLM_CANDIDATES, 25),
    // token savers: max AI calls per test run, and how long a "no match found" answer is remembered
    maxLLMCalls: num(env.AI_HEAL_MAX_LLM_CALLS, 3),
    missTtlMin: num(env.AI_HEAL_MISS_TTL_MIN, 60)
  },

  crawl: {
    maxPages: num(env.AI_CRAWL_MAX_PAGES, 10),
    headless: bool(env.AI_CRAWL_HEADLESS, true)
  },

  agent: {
    // true = ignore the saved plan and ask the AI again
    replan: bool(env.AI_AGENT_REPLAN, false),
    // false = never use the LLM for planning (offline rule-based filler only)
    useLLM: bool(env.AI_AGENT_USE_LLM, true),
    maxElements: num(env.AI_AGENT_MAX_ELEMENTS, 150)
  }
};
