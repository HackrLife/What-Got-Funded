import { workflow, node, trigger, expr, ifElse, switchCase, sticky } from '@n8n/workflow-sdk';

// What Got Funded — the one daily n8n workflow, 9pm Sydney.
//   Agent 1, Scraper: starts the Apify crawler for yesterday-in-Sydney and waits for it.
//   Agent 2, Structurer: stores the articles and extracts each round as JSON (model call), then finds company websites
//            and reads them for socials and careers pages.
//   Agent 3, Verifier: Gemini Flash with Google Search checks every new round's first announcement date; rounds it cannot
//            settle (large, unclear, not found) get a second opinion from Claude Sonnet with web search.
//            Run-now setting "verifier_test" runs it in dry-run mode over the hand-checked gold set and scores it.
// Agents 4–6 (Curator, Article publisher, Newsletter publisher) still run in the nightly scheduled Claude task until the
// verifier scores at least 95% on the gold set.
// Run now: edit the "Run-now settings" box (target_date, run = full | verify_only | verifier_test), then execute.
// The x-wgf-token value lives only in n8n; this export uses a placeholder.
const FN = 'https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-extract';
const TOKEN = '__WGF_TOKEN__';
const MODEL = 'claude-haiku-5-5';
const ACTOR = 'https://api.apify.com/v2/acts/HackrLife~wgf-crawler';

const headers = { parameters: [{ name: 'x-wgf-token', value: TOKEN }] };
const lenient = { response: { response: { neverError: true, responseFormat: 'json' } } };
const apify = { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' };
const apifyCred = { httpBearerAuth: { id: 'U4EQeOM0Nov43zUK', name: 'Apify API' } };

// The n8n server runs on New York time. 9pm Sydney is 5am or 6am in New York depending on daylight saving,
// so the trigger fires at both and only 9pm in Sydney passes: two executions a day.
const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: '5am and 6am New York', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 5,6 * * *' }] } } },
});

const is9pm = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: '9pm in Sydney',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ $now.setZone('Australia/Sydney').hour }}"), rightValue: 21, operator: { type: 'number', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  },
});
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });

const setting = (id, name, value) => ({ id, name, value, type: 'string' });
const nightly = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Nightly settings',
    parameters: { mode: 'manual', includeOtherFields: false, assignments: { assignments: [setting('n-date', 'target_date', ''), setting('n-run', 'run', 'full')] } },
  },
});
// Edit these two values before a manual run. target_date: YYYY-MM-DD, empty = yesterday in Sydney.
// run: full (crawl + structure + verify), verify_only (verify rounds already stored), verifier_test (score on the gold set).
const runSettings = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Run-now settings',
    parameters: { mode: 'manual', includeOtherFields: false, assignments: { assignments: [setting('r-date', 'target_date', ''), setting('r-run', 'run', 'full')] } },
  },
});
const rule = (key) => ({
  outputKey: key,
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
    conditions: [{ leftValue: expr('{{ $json.run }}'), operator: { type: 'string', operation: 'equals' }, rightValue: key }],
    combinator: 'and',
  },
});
const route = switchCase({
  version: 3.2,
  config: { name: 'What to run', parameters: { rules: { values: [rule('full'), rule('verify_only'), rule('verifier_test')] } } },
});
const RUN = "$('What to run').first().json.run";

// ---------- Agent 1: Scraper ----------
const startCrawl = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Start crawl',
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    parameters: {
      method: 'POST', url: `${ACTOR}/runs?memory=2048&timeout=3300`, ...apify,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify(Object.assign({ mode: "articles" }, $json.target_date ? { targetDate: $json.target_date } : {})) }}'),
      options: { timeout: 60000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

const waitCrawl = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait for crawl', parameters: { resume: 'timeInterval', amount: 55, unit: 'minutes' } },
});

const crawlDone = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Crawl finished',
    parameters: {
      method: 'GET', ...apify,
      url: expr("https://api.apify.com/v2/actor-runs/{{ $('Start crawl').first().json.data.id }}?waitForFinish=60"),
      options: { timeout: 90000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

// ---------- Agent 2: Structurer ----------
const getArticles = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Load crawl results',
    parameters: {
      method: 'GET', ...apify,
      url: expr("https://api.apify.com/v2/datasets/{{ $('Crawl finished').first().json.data.defaultDatasetId }}/items?clean=true&format=json&limit=3000"),
      options: { timeout: 120000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

const chunkArticles = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Chunks of 25',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const all = $input.all().map(i => i.json).filter(a => a && a.url);
const out = [];
for (let i = 0; i < all.length; i += 25) out.push({ json: { items: all.slice(i, i + 25) } });
return out.length ? out : [{ json: { items: [] } }];`,
    },
  },
});

const ingest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Store articles',
    retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ mode: "ingest", items: $json.items }) }}'),
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 500 } }, ...lenient },
    },
  },
});

const plan = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Plan articles',
    executeOnce: true,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "plan", "channel": "article" }',
      options: { timeout: 120000, ...lenient },
    },
  },
});

const split = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'One item per article',
    parameters: { mode: 'runOnceForAllItems', jsCode: `return ($input.first().json.chunks || []).map(c => ({ json: c }));` },
  },
});

const buildPrompt = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Build prompt',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ mode: "prompt", ids: $json.ids }) }}'),
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 300 } }, ...lenient },
    },
  },
});

const claude = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Extract with Claude',
    parameters: {
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi',
      sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr(`{{ JSON.stringify({ model: "${MODEL}", max_tokens: 8000, output_config: { effort: "low" }, system: $json.system, messages: [{ role: "user", content: $json.user }] }) }}`),
      options: { timeout: 180000, batching: { batch: { batchSize: 4, batchInterval: 2000 } }, ...lenient },
    },
    credentials: { anthropicApi: { id: 'Jxsbr4056cWcup7u', name: 'Anthropic account' } },
  },
});

const saveRounds = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save rounds',
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr(`{{ JSON.stringify({ mode: "save", ids: $('Build prompt').item.json.ids, text: (($json.content || []).find(b => b.type === 'text') || {}).text || JSON.stringify({ error: $json.error || ('no text block, stop_reason ' + $json.stop_reason) }) }) }}`),
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, ...lenient },
    },
  },
});

const targets = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Companies to check',
    executeOnce: true,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "company_targets", "days": 2 }',
      options: { timeout: 60000, ...lenient },
    },
  },
});

// Companies the articles gave no website for: one Google search each (Apify Google Search Scraper, about $0.0025 a search).
// Started in the background, then read after a wait, because a few hundred searches take longer than a synchronous call allows.
const findDomains = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Start website search',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: 'https://api.apify.com/v2/acts/apify~google-search-scraper/runs?timeout=1200', ...apify,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ queries: ($json.need_domain || []).map(n => n.query).join("\\n") || "What Got Funded", maxPagesPerQuery: 1, countryCode: "us", languageCode: "en", saveHtmlToKeyValueStore: false, includeIcons: false }) }}'),
      options: { timeout: 60000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

const waitSearch = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait for search', parameters: { resume: 'timeInterval', amount: 10, unit: 'minutes' } },
});

const getSearch = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Load search results',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET', ...apify,
      url: expr("https://api.apify.com/v2/datasets/{{ $('Start website search').first().json.data.defaultDatasetId }}/items?clean=true&format=json"),
      options: { timeout: 120000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

const matchDomains = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Match search results',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const t = $('Companies to check').first().json;
const need = t.need_domain || [];
const byQuery = {};
for (const i of $input.all()) {
  const q = i.json.searchQuery && i.json.searchQuery.term;
  if (q) byQuery[q] = (i.json.organicResults || []).map(r => ({ url: r.url, title: r.title, description: r.description, date: r.date }));
}
return [{ json: {
  items: need.map(n => ({ id: n.id, name: n.name, results: byQuery[n.query] || [] })),
} }];`,
    },
  },
});

const saveDomains = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save websites',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ mode: "company_domains", items: $json.items }) }}'),
      options: { timeout: 300000, ...lenient },
    },
  },
});

const recheck = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Sites to read',
    executeOnce: true,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "company_targets", "days": 2 }',
      options: { timeout: 60000, ...lenient },
    },
  },
});

const hasDomains = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: 'Any domains',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ ($json.domains || []).length }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and',
      },
    },
  },
});

const readSites = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Read company sites',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: `${ACTOR}/run-sync-get-dataset-items?memory=1024&timeout=290&clean=true`, ...apify,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ mode: "companies", domains: $json.domains }) }}'),
      options: { timeout: 300000, response: { response: { responseFormat: 'json' } } },
    },
    credentials: apifyCred,
  },
});

const collectSites = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Collect site results',
    parameters: { mode: 'runOnceForAllItems', jsCode: `return [{ json: { items: $input.all().map(i => i.json).filter(s => s && s.domain) } }];` },
  },
});

const saveSites = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save company sites',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ mode: "company_save", items: $json.items }) }}'),
      options: { timeout: 120000, ...lenient },
    },
  },
});

// ---------- Agent 3: Verifier ----------
const VERIFY = 'https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-verify';
const verifyCall = (name, body, extra = {}) => node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name, executeOnce: true, ...extra,
    parameters: {
      method: 'POST', url: VERIFY, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr(body),
      options: { timeout: 120000, ...lenient },
    },
  },
});
const splitCode = (name) => node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name,
    parameters: { mode: 'runOnceForAllItems', jsCode: `const items = $input.first().json.items || [];
return items.length ? items.map(i => ({ json: i })) : [{ json: { none: true } }];` },
  },
});
const anyRounds = (name) => ifElse({
  version: 2.2,
  config: {
    name,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.round_id }}'), operator: { type: 'number', operation: 'exists', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

const geminiTargets = verifyCall('Rounds to verify',
  `{{ JSON.stringify(${RUN} === "verifier_test" ? { mode: "targets", checker: "gemini", gold: true } : { mode: "targets", checker: "gemini" }) }}`);
const geminiSplit = splitCode('One Gemini request per round');
const anyGemini = anyRounds('Any rounds to verify');
const gemini = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Gemini + Google Search',
    parameters: {
      method: 'POST', url: expr('{{ $json.url }}'),
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.body) }}'),
      options: { timeout: 120000, batching: { batch: { batchSize: 4, batchInterval: 2000 } }, ...lenient },
    },
    credentials: { httpHeaderAuth: { id: 'EEJ8SC9KxO1weHL3', name: 'Header Auth account 2' } },
  },
});
const saveGemini = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save Gemini verdict',
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: {
      method: 'POST', url: VERIFY, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr(`{{ JSON.stringify((r => ({ mode: "save", checker: "gemini", round_id: r.round_id, day: r.day, model: r.model, dry_run: r.dry_run,
        reply: $json.candidates ? { candidates: [{ content: $json.candidates[0].content }] } : JSON.stringify($json.error || $json) }))($('One Gemini request per round').item.json)) }}`),
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 200 } }, ...lenient },
    },
  },
});

const claudeTargets = verifyCall('Second opinions',
  `{{ JSON.stringify(${RUN} === "verifier_test" ? { mode: "targets", checker: "claude", gold: true } : { mode: "targets", checker: "claude" }) }}`);
const claudeSplit = splitCode('One Claude request per round');
const anyClaude = anyRounds('Any second opinions');
const claudeCheck = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Claude + web search',
    parameters: {
      method: 'POST', url: expr('{{ $json.url }}'),
      authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi',
      sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.body) }}'),
      options: { timeout: 300000, batching: { batch: { batchSize: 2, batchInterval: 5000 } }, ...lenient },
    },
    credentials: { anthropicApi: { id: 'Jxsbr4056cWcup7u', name: 'Anthropic account' } },
  },
});
const saveClaude = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save Claude verdict',
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: {
      method: 'POST', url: VERIFY, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr(`{{ JSON.stringify((r => ({ mode: "save", checker: "claude", round_id: r.round_id, day: r.day, model: r.model, dry_run: r.dry_run,
        reply: Array.isArray($json.content) ? { content: $json.content.filter(b => b.type === "text") } : JSON.stringify($json.error || $json) }))($('One Claude request per round').item.json)) }}`),
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 200 } }, ...lenient },
    },
  },
});
const verified = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Verifier done', parameters: { mode: 'runOnceForAllItems', jsCode: `return [{ json: { checked: $input.all().filter(i => i.json.round_id).length } }];` } },
});
const isTest = ifElse({
  version: 2.2,
  config: {
    name: 'Test run?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr(`{{ ${RUN} }}`), operator: { type: 'string', operation: 'equals' }, rightValue: 'verifier_test' }],
        combinator: 'and',
      },
    },
  },
});
const scorePipeline = verifyCall('Score: whole verifier', '{{ JSON.stringify({ mode: "score", checker: "pipeline" }) }}');
const scoreGemini = verifyCall('Score: Gemini alone', '{{ JSON.stringify({ mode: "score", checker: "gemini" }) }}');

sticky(`## Agent 1 · Scraper
Apify crawler over ~300 sources for yesterday in Sydney (or the Run-now target_date).`, [startCrawl, waitCrawl, crawlDone], { color: 4 });
sticky(`## Agent 2 · Structurer
Stores articles, extracts each round as JSON (Claude Haiku), finds and reads company websites.`,
  [getArticles, chunkArticles, ingest, plan, split, buildPrompt, claude, saveRounds, targets, findDomains, waitSearch, getSearch, matchDomains, saveDomains, recheck, hasDomains, readSites, collectSites, saveSites], { color: 5 });
sticky(`## Agent 3 · Verifier
Gemini Flash + Google Search checks each round was first announced on the day. Big or unclear rounds get a Claude Sonnet second opinion. Test mode scores it on the hand-checked gold set.`,
  [geminiTargets, geminiSplit, anyGemini, gemini, saveGemini, claudeTargets, claudeSplit, anyClaude, claudeCheck, saveClaude, verified, isTest, scorePipeline, scoreGemini], { color: 6 });
sticky(`## Settings
Run now: edit "Run-now settings" (target_date, run = full | verify_only | verifier_test). The 9pm Sydney run always does a full run for yesterday.`, [runNow, runSettings, schedule, is9pm, nightly, route], { color: 7 });

export default workflow('wgf-daily', 'WGF — Daily pipeline (9pm)')
  .add(runNow)
  .to(runSettings)
  .to(route
    .onCase('full', startCrawl)
    .onCase('verify_only', geminiTargets)
    .onCase('verifier_test', geminiTargets))
  .add(schedule)
  .to(is9pm)
  .to(nightly)
  .to(route)
  .add(startCrawl)
  .to(waitCrawl)
  .to(crawlDone)
  .to(getArticles)
  .to(chunkArticles)
  .to(ingest)
  .to(plan)
  .to(split)
  .to(buildPrompt)
  .to(claude)
  .to(saveRounds)
  .to(geminiTargets)
  .add(saveRounds)
  .to(targets)
  .to(findDomains)
  .to(waitSearch)
  .to(getSearch)
  .to(matchDomains)
  .to(saveDomains)
  .to(recheck)
  .to(hasDomains)
  .to(readSites)
  .to(collectSites)
  .to(saveSites)
  .add(geminiTargets)
  .to(geminiSplit)
  .to(anyGemini
    .onTrue(gemini.to(saveGemini.to(claudeTargets)))
    .onFalse(claudeTargets))
  .add(claudeTargets)
  .to(claudeSplit)
  .to(anyClaude
    .onTrue(claudeCheck.to(saveClaude.to(verified)))
    .onFalse(verified))
  .add(verified)
  .to(isTest.onTrue(scorePipeline.to(scoreGemini)));
