import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// What Got Funded — earliest-wire check retry. Re-runs the Google check for rounds still waiting (pending_check),
// for example when the 10pm search finished after the extract read its results. 11:30pm and 4:30am Sydney, or on demand.
// (Original header of the extract workflow follows.)
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

// The n8n server runs on New York time, so the trigger fires hourly at :30 and only 11:30pm and 4:30am in Sydney pass.
const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Every hour at :30', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 30 * * * *' }] } } },
});
const sydneyHours = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: '11:30pm or 4:30am in Sydney',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ [23, 4].includes($now.setZone('Australia/Sydney').hour) }}"), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });
// On demand from outside n8n: POST /webhook/wgf-wire-check with the x-wgf-token header
const hook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: { name: 'Run on request', parameters: { httpMethod: 'POST', path: 'wgf-wire-check', responseMode: 'onReceived', options: {} } },
});
const tokenOk = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: 'Token matches',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ $json.headers['x-wgf-token'] }}"), rightValue: TOKEN, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  },
});
const anyWaiting = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: 'Any rounds waiting',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ ($json.wire || []).length + ($json.need_domain || []).length }}"), rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and',
      },
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
  config: { name: 'Wait for search', parameters: { resume: 'timeInterval', amount: 25, unit: 'minutes' } },
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

export default workflow('wgf-wire-check', 'WGF — Wire check retry (11:30pm, 4:30am)')
  .add(schedule)
  .to(sydneyHours)
  .to(targets)
  .to(anyWaiting)
  .to(findDomains)
  .to(waitSearch)
  .to(getSearch)
  .to(matchDomains)
  .to(saveDomains)
  .add(runNow)
  .to(targets)
  .add(hook)
  .to(tokenOk)
  .to(targets);
