# GEN AI AGENT for Playwright (Writer Agent + Healer Agent)

An AI layer on top of Playwright (JavaScript) that **reads a web page, writes the test script for you, and automatically repairs broken locators**.
Positive and negative test cases are both supported. Free LLMs (Groq, OpenRouter, Ollama) work, and Claude/OpenAI are optional.

---

## 1. What this project does

| Agent | Job |
|---|---|
| **Writer agent** | You give a one-line instruction. It opens the page, reads the elements, makes a plan, performs the steps, verifies the result, and saves a normal Playwright spec in `tests/generated/`. |
| **Healer agent** | When a locator breaks (a button is renamed, an id changes), it finds the new element and continues the test, instead of failing. |

Both agents live in one folder: `ai-agent/`.

---

## 2. Technology used

| Item | Details |
|---|---|
| Language | JavaScript (Node.js, CommonJS modules) |
| Test framework | Playwright Test (`@playwright/test`) |
| Runtime | Node.js 18 or higher (built with Node 22) |
| LLM access | Plain HTTP calls with Node `fetch`; no extra AI libraries |
| LLM providers | Groq, OpenRouter, Ollama (free); Anthropic Claude, OpenAI (optional) |
| Editor | VS Code |
| OS | Ubuntu / Linux (also works on Windows and macOS) |

---

## 3. Methods and techniques used

**Writer agent pipeline**
1. **Observe**: take a snapshot of the page DOM. Each visible element gets a temporary `data-ai-id`.
2. **Plan**: the LLM returns a JSON list of steps. If no LLM is available, an offline rule-based planner (`heuristic-plan.js`) builds the plan.
3. **Resolve**: each element id is converted to a stable locator (role, label, placeholder, text, id, name).
4. **Execute**: the steps run with the healer active.
5. **Verify**: it reads the page for the success text (positive test) or for rejection evidence (negative test).
6. **Emit**: it writes a plain Playwright spec to `tests/generated/` that runs later with no AI.
7. **Cache**: the plan is saved in `ai-agent/plans/` before the run, so re-runs reuse it and cost no tokens.

**Healer agent**
- A JavaScript `Proxy` wraps `page` and its locators.
- It heals only actions (click, fill, check, select, and so on), never `expect` assertions, so real bugs are not hidden.
- It heals only when the locator finds 0 elements within the probe timeout (8 seconds by default).
- Order of attempts:
  1. **Cache** of earlier heals.
  2. **Offline similarity matcher** (score at least 0.82 and clear margin) with no tokens used.
  3. **LLM** (confidence at least 0.6) as the last resort.
- Results are saved to `ai-agent/heal-data/` (cache, suggestions, report).

**Negative testing**
- Triggered by `negative: true` or by words like "empty", "invalid", "without" in the instruction.
- A negative test passes only if the success text is not visible, the form shows errors (`:invalid` or `aria-invalid`), and the URL stays the same.
- If the site wrongly accepts bad data, the test fails.

**Token savers**
- Plan reuse (cached by instruction and page URL).
- Healer LLM call limit per run (`AI_HEAL_MAX_LLM_CALLS`).
- "Nothing found" results are remembered for 60 minutes.
- The offline matcher and planner run before any LLM call.

---

## 4. Folder structure

```
Playwright_AI_Agent_P+N_Project/
├── ai-agent/
│   ├── cli.js                 command line: ping, write, heal-report
│   ├── config.js              settings read from .env
│   ├── llm/client.js          LLM client with provider fallback
│   ├── crawler/dom-snapshot.js  reads page elements, builds locators
│   ├── writer/
│   │   ├── agent.js           main writer agent: aiAgent(page, instruction, opts)
│   │   ├── heuristic-plan.js  offline planner (no key needed)
│   │   └── code-emitter.js    writes the generated spec
│   ├── healer/
│   │   ├── healing-page.js    Proxy that wraps page and locators
│   │   ├── healer.js          heal logic: cache, matcher, LLM
│   │   ├── matcher.js         offline similarity matcher
│   │   ├── heal-store.js      cache, suggestions, report
│   │   └── apply-heals.js     patches your source files with healed locators
│   ├── plans/                 saved plans (token saver)
│   └── heal-data/             heal cache and reports
├── fixtures/ai.fixture.js     Playwright fixture that turns the healer on
├── tests/
│   ├── fill-form.spec.js      your tests (positive and negative)
│   └── generated/             specs written by the agent
├── utils/env.js               .env loader
├── test-data/                 files for upload tests
├── playwright.config.js
├── package.json
└── .env                       your keys (create this; never share it)
```

---

## 5. Installation (one time)

1. Install Node.js 18 or higher from nodejs.org. Check it with:
   ```bash
   node -v
   ```
2. Open the project folder in VS Code, then **Terminal → New Terminal**.
3. Install packages:
   ```bash
   npm install
   ```
4. Install the browser:
   ```bash
   npx playwright install chromium
   ```

---

## 6. Configuration (`.env`)

1. Copy the template:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set one AI provider. Example for Groq:
   ```
   AI_PROVIDERS=groq
   GROQ_API_KEY=paste_your_key_here
   GROQ_MODEL=openai/gpt-oss-120b
   ```
3. Put each setting on its own line, with no spaces around `=`.
4. Save the file.

**Keep your key private.** Put it only in `.env`. Never paste it in chat, email or Git. `.env` is already in `.gitignore`. If a key is ever exposed, revoke it and create a new one.

### How to get a free key

| Provider | Where | Notes |
|---|---|---|
| Groq | console.groq.com → API Keys | Free and fast. Recommended. |
| OpenRouter | openrouter.ai → Keys | Use models whose names end in `:free`. |
| Ollama | ollama.com | Runs on your own machine, no key. Run `ollama pull qwen2.5-coder:7b`. |
| Claude | console.anthropic.com | Paid. Optional. |

You need only **one** provider. With no key at all, set `AI_AGENT_USE_LLM=false` and `AI_HEAL_USE_LLM=false`. The offline planner and matcher still work.

### Main settings

| Setting | Meaning |
|---|---|
| `AI_PROVIDERS` | Order to try providers, for example `groq,openrouter` |
| `AI_HEAL` | `true` turns auto-healing on |
| `AI_HEAL_USE_LLM` | `false` makes healing offline only |
| `AI_HEAL_AUTOPATCH` | `true` rewrites your source file with the healed locator (a `.bak` backup is kept) |
| `AI_AGENT_USE_LLM` | `false` makes the writer use the offline planner only |
| `AI_AGENT_REPLAN` | `true` ignores the saved plan and plans again |
| `AI_HEAL_MAX_LLM_CALLS` | Maximum healer AI calls per run (default 3) |

---

## 7. Check the AI connection

```bash
npm run ai:ping
```

Expected: `groq: OK`. "not configured" means the key is missing from `.env`. A failed Ollama line is fine if you don't use Ollama.

---

## 8. How to write a test with the agent

Create or edit `tests/fill-form.spec.js`:

```javascript
const { test } = require('../fixtures/ai.fixture');
const { aiAgent } = require('../ai-agent/writer/agent');

const URL = 'https://demoqa.com/automation-practice-form';
const SUCCESS = 'Thanks for submitting the form';

// POSITIVE
test('Open website fill form', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page,
    'Fill the form with realistic data, choose Male, tick Sports and Music, state NCR, city Delhi, then submit',
    { data: { firstName: 'Karthik', lastName: 'Raj', email: 'karthik.test@example.com', phone: '9876543210' } });
});

// NEGATIVE
test('Negative - submit empty form', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page, 'Submit the empty form without filling anything',
    { negative: true, expectNot: SUCCESS });
});

test('Negative - missing first name', async ({ page }) => {
  await page.goto(URL);
  await aiAgent(page, 'Fill the form with realistic data but leave first name empty, choose Male, then submit',
    { negative: true, expectNot: SUCCESS });
});
```

Each `test(...)` block must be separate, not nested inside another.

### `aiAgent` options

| Option | Meaning |
|---|---|
| `data` | Values you want used. Anything not listed is invented. |
| `negative` | `true` means the form must reject the input |
| `expectNot` | Text that must not appear (for example the success message) |
| `expect` | Text that must appear after submit |
| `title` | Name for the saved spec |
| `replan` | `true` forces a new plan |
| `save` | `false` skips saving a spec |

---

## 9. How to run

| Goal | Command |
|---|---|
| Run all tests, browser visible | `npx playwright test tests/fill-form.spec.js --project=web --headed` |
| Run one test | `npx playwright test tests/fill-form.spec.js --project=web --headed -g "missing first name"` |
| Run without opening a browser | `npx playwright test tests/fill-form.spec.js --project=web` |
| Run the saved specs (no AI, no tokens) | `npm run run:generated` |
| Write a spec from the terminal | `node ai-agent/cli.js write <url> "<instruction>" --headless` |
| Force a new plan | `node ai-agent/cli.js write <url> "<instruction>" --replan` |
| Check the AI connection | `npm run ai:ping` |
| View the heal report | `npm run ai:heal:report` |
| Apply healed locators to source | `npm run ai:heal:apply` |
| Open the test report | `npm run report` |

To watch the run slowly, set `SLOW_MO=500` in `.env`.

---

## 10. Typical workflow

1. Write your test in `tests/fill-form.spec.js`.
2. Run it once. The agent plans, fills the form, verifies, and saves a spec to `tests/generated/`.
3. Run it again. The saved plan is reused and no tokens are spent.
4. For regression, run `npm run run:generated`. These are plain Playwright specs.
5. If a locator breaks, the healer repairs it during the run. Review `npm run ai:heal:report`, then run `npm run ai:heal:apply` if you want the fix written into your source.

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module '@playwright/test'` | Run `npm install` |
| `groq: not configured` | `.env` is missing or the key is empty. Check `GROQ_API_KEY=` in `.env`. |
| `model_not_found` | Set `GROQ_MODEL=openai/gpt-oss-120b` |
| Test fails and costs tokens each run | Plans are saved before the run. Re-run without `--replan`. Lower `AI_HEAL_MAX_LLM_CALLS`. |
| State or City dropdown "intercepts pointer events" | Already handled with a forced click. Re-generate with `--replan`. |
| Browser does not open | Add `--headed`. On servers or CI use headless. |
| Ollama FAILED | Ollama is not running. Set `AI_PROVIDERS=groq` to skip it. |
| Negative test fails | The site accepted the bad data, which may be a real bug. Check the screenshot in the report. |

---

## 12. Limits

- Vague instructions ("fill properly") give less exact results. Be specific about the fields and values.
- The agent cannot know your business rules unless you say them (use `expect` and `expectNot`).
- Pages behind a login need credentials in `.env`.
- Generated code should be reviewed before it goes into a regression suite.

---

## 13. Security notes

- Keep keys only in `.env`.
- Revoke and replace any key that was ever pasted in chat or committed.
- Page text is sent to the LLM provider you choose. Use Ollama (local) for sensitive pages.
