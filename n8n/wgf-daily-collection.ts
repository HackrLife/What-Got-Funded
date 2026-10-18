import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// What Got Funded — daily collection (5:00 Sydney). Collects the last 48 hours; duplicates are skipped.
// The x-wgf-token value lives only in n8n; this export uses a placeholder.
const FN = 'https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-collect';
const TOKEN = '__WGF_TOKEN__';
const BATCHES = 8;

const headers = { parameters: [{ name: 'x-wgf-token', value: TOKEN }] };
const lenient = { response: { response: { neverError: true, responseFormat: 'json' } } };

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Daily 5:00 Sydney', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 5 * * *' }] } } },
});

const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });

const sync = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Sync source registry from GitHub',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "sync" }',
      options: { timeout: 120000, ...lenient },
    },
  },
});

const listGoogle = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Google News feeds',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "sources", "channels": ["google_news"] }',
      options: { timeout: 60000, ...lenient },
    },
  },
});

const splitGoogle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'One item per feed',
    parameters: { mode: 'runOnceForAllItems', jsCode: `return ($input.first().json.feeds || []).map(f => ({ json: f }));` },
  },
});

// Google News blocks some Supabase egress IPs, so n8n fetches these feeds itself.
const fetchGoogle = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Google News feed',
    parameters: {
      method: 'GET', url: expr('{{ $json.url }}'),
      options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1500 } },
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } },
    },
  },
});

const chunkGoogle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Chunk fetched feeds',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const src = $('One item per feed').all();
const rows = $input.all().map((r, i) => ({ source_id: src[i].json.id, status: r.json.statusCode, body: typeof r.json.body === 'string' ? r.json.body : (r.json.data || ''), error: r.json.error ? String(r.json.error.message || r.json.error) : undefined }));
const out = [];
for (let k = 0; k < rows.length; k += 8) out.push({ json: { prefetched: rows.slice(k, k + 8) } });
return out;`,
    },
  },
});

const storeGoogle = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Store Google News items',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channels: ["google_news"], skip_sync: true, prefetched: $json.prefetched }) }}'),
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, ...lenient },
    },
  },
});

const makeBatches = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Make feed batches',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `return Array.from({ length: ${BATCHES} }, (_, i) => ({ json: { batch: i, batches: ${BATCHES} } }));`,
    },
  },
});

const collect = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Collect RSS feeds',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channels: ["rss"], skip_sync: true, batch: $json.batch, batches: $json.batches }) }}'),
      options: { timeout: 300000, batching: { batch: { batchSize: 1, batchInterval: 15000 } }, ...lenient },
    },
  },
});

const APIFY_BATCHES = 20;
const makeApifyBatches = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Make scrape batches',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `return Array.from({ length: ${APIFY_BATCHES} }, (_, i) => ({ json: { batch: i, batches: ${APIFY_BATCHES} } }));`,
    },
  },
});

// ~170 pages in 20 batches of ~8, 40 s apart: stays under Apify's 32 concurrent runs and the edge time limit.
const scrape = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Scrape pages (Apify web-fetch)',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channels: ["apify"], skip_sync: true, batch: $json.batch, batches: $json.batches, concurrency: 8 }) }}'),
      options: { timeout: 300000, batching: { batch: { batchSize: 1, batchInterval: 40000 } }, ...lenient },
    },
  },
});

const report = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build run report',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const batches = [...$('Store Google News items').all(), ...$('Collect RSS feeds').all(), ...$('Scrape pages (Apify web-fetch)').all()].map(i => i.json);
const s = $('Sync source registry from GitHub').first().json;
const add = (into, from) => { for (const [k, g] of Object.entries(from || {})) { const t = (into[k] ??= { sources: 0, ok: 0, empty: 0, error: 0, items: 0 }); for (const f of Object.keys(t)) t[f] += g[f] || 0; } return into; };
const byChannel = {}, byRegion = {};
let newItems = 0, week = null; const failed = [];
for (const b of batches) {
  if (b.error || !b.by_channel) { failed.push(b.error || b.message || 'no response'); continue; }
  week = week || b.day; newItems += b.new_raw_items || 0;
  add(byChannel, b.by_channel); add(byRegion, b.by_region);
}
const errs = batches.flatMap(b => b.errors || []);
const row = (k, g) => '<tr><td>' + k + '</td><td>' + g.sources + '</td><td>' + g.ok + '</td><td>' + g.empty + '</td><td>' + g.error + '</td><td>' + g.items + '</td></tr>';
const table = (o) => '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th></th><th>Sources</th><th>OK</th><th>Empty</th><th>Error</th><th>Items</th></tr>' + Object.entries(o).map(([k, g]) => row(k, g)).join('') + '</table>';
const html = '<h2>What Got Funded: collection for ' + (week || '?') + '</h2>'
  + '<p>Registry sync: ' + (s.synced_sources ?? ('failed: ' + (s.error || '?'))) + ' sources. '
  + newItems + ' new items from feeds and scraped pages.</p>'
  + (failed.length ? '<p><b>' + failed.length + ' of ' + batches.length + ' batches failed:</b> ' + failed.join('; ') + '</p>' : '')
  + '<h3>By channel</h3>' + table(byChannel)
  + '<h3>By region</h3>' + table(byRegion)
  + '<h3>Source failures</h3><ul>' + (errs.map(e => '<li>' + e.source + ' (' + e.channel + '): ' + e.error + '</li>').join('') || '<li>None</li>') + '</ul>';
return [{ json: { subject: 'WGF daily collection ' + (week || '') + ': ' + newItems + ' items, ' + (errs.length + failed.length) + ' failures', html } }];`,
    },
  },
});

const email = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: 'Email run report',
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message', operation: 'send', sendTo: 'dev@hackrlife.com',
      subject: expr('{{ $json.subject }}'), emailType: 'html', message: expr('{{ $json.html }}'),
      options: { appendAttribution: false },
    },
    credentials: { gmailOAuth2: { id: 'b6vPW9ZRraa7jbf0', name: 'Gmail account' } },
  },
});

export default workflow('tpNTZVkWoiWgSI9n', 'WGF — Daily Collection')
  .add(schedule)
  .to(sync)
  .to(listGoogle)
  .to(splitGoogle)
  .to(fetchGoogle)
  .to(chunkGoogle)
  .to(storeGoogle)
  .to(makeBatches)
  .to(collect)
  .to(makeApifyBatches)
  .to(scrape)
  .to(report)
  .to(email)
  .add(runNow)
  .to(sync);
