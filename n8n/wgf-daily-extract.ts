import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// What Got Funded — daily extraction, 10pm Sydney (the crawl starts at 9pm in wgf-daily-crawl.ts).
// Loads the latest successful crawl, store articles in Supabase, extract each article with Claude Haiku (translation included),
//       then read the new companies' own websites (crawler companies mode) for socials, founder links and careers pages.
// The x-wgf-token value lives only in n8n; this export uses a placeholder.
const FN = 'https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-extract';
const TOKEN = '__WGF_TOKEN__';
const MODEL = 'claude-haiku-5-5';
const ACTOR = 'https://api.apify.com/v2/acts/HackrLife~wgf-crawler';

const headers = { parameters: [{ name: 'x-wgf-token', value: TOKEN }] };
const lenient = { response: { response: { neverError: true, responseFormat: 'json' } } };
const apify = { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' };
const apifyCred = { httpBearerAuth: { id: 'U4EQeOM0Nov43zUK', name: 'Apify API' } };

// The n8n server runs on New York time, so the trigger fires hourly and only 10pm in Sydney passes.
const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Every hour', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 * * * *' }] } } },
});

const is10pm = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: '10pm in Sydney',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ $now.setZone('Australia/Sydney').hour }}"), rightValue: 22, operator: { type: 'number', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  },
});
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });

const getArticles = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Load latest crawl',
    parameters: {
      method: 'GET', ...apify,
      url: `${ACTOR}/runs/last/dataset/items?status=SUCCEEDED&clean=true&format=json&limit=3000`,
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
      jsonBody: expr('{{ JSON.stringify({ queries: [...($json.need_domain || []).map(n => n.query), ...($json.wire || []).map(w => w.query)].join("\\n") || "What Got Funded", maxPagesPerQuery: 1, countryCode: "us", languageCode: "en", saveHtmlToKeyValueStore: false, includeIcons: false }) }}'),
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
const need = t.need_domain || [], wire = t.wire || [];
const byQuery = {};
for (const i of $input.all()) {
  const q = i.json.searchQuery && i.json.searchQuery.term;
  if (q) byQuery[q] = (i.json.organicResults || []).map(r => ({ url: r.url, title: r.title, description: r.description, date: r.date }));
}
return [{ json: {
  items: need.map(n => ({ id: n.id, name: n.name, results: byQuery[n.query] || [] })),
  wire: wire.map(w => ({ round_id: w.round_id, searched: w.query in byQuery, results: byQuery[w.query] || [] })),
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
      jsonBody: expr('{{ JSON.stringify({ mode: "company_domains", items: $json.items, wire: $json.wire }) }}'),
      options: { timeout: 120000, ...lenient },
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

export default workflow('wgf-daily-extract', 'WGF — Daily Extract (10pm)')
  .add(schedule)
  .to(is10pm)
  .to(getArticles)
  .to(chunkArticles)
  .to(ingest)
  .to(plan)
  .to(split)
  .to(buildPrompt)
  .to(claude)
  .to(saveRounds)
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
  .add(runNow)
  .to(getArticles);
