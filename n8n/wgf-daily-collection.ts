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
    name: 'Collect feeds (RSS + Google News)',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channels: ["rss", "google_news"], skip_sync: true, batch: $json.batch, batches: $json.batches }) }}'),
      options: { timeout: 300000, batching: { batch: { batchSize: 1, batchInterval: 15000 } }, ...lenient },
    },
  },
});

const scrape = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Scrape pages (Apify web-fetch)',
    executeOnce: true,
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "channels": ["apify"], "skip_sync": true }',
      options: { timeout: 300000, ...lenient },
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
      jsCode: `const batches = $('Collect feeds (RSS + Google News)').all().map(i => i.json);
const p = $('Scrape pages (Apify web-fetch)').first().json;
const s = $('Sync source registry from GitHub').first().json;
const add = (into, from) => { for (const [k, g] of Object.entries(from || {})) { const t = (into[k] ??= { sources: 0, ok: 0, empty: 0, error: 0, items: 0 }); for (const f of Object.keys(t)) t[f] += g[f] || 0; } return into; };
const byChannel = {}, byRegion = {};
let newItems = 0, week = null; const failed = [];
for (const b of batches) {
  if (b.error || !b.by_channel) { failed.push(b.error || b.message || 'no response'); continue; }
  week = week || b.day; newItems += b.new_raw_items || 0;
  add(byChannel, b.by_channel); add(byRegion, b.by_region);
}
add(byChannel, p.by_channel);
const errs = [...batches.flatMap(b => b.errors || []), ...(p.errors || [])];
const row = (k, g) => '<tr><td>' + k + '</td><td>' + g.sources + '</td><td>' + g.ok + '</td><td>' + g.empty + '</td><td>' + g.error + '</td><td>' + g.items + '</td></tr>';
const table = (o) => '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th></th><th>Sources</th><th>OK</th><th>Empty</th><th>Error</th><th>Items</th></tr>' + Object.entries(o).map(([k, g]) => row(k, g)).join('') + '</table>';
const html = '<h2>What Got Funded: collection for ' + (week || '?') + '</h2>'
  + '<p>Registry sync: ' + (s.synced_sources ?? ('failed: ' + (s.error || '?'))) + ' sources. '
  + newItems + ' new items from feeds, ' + (p.new_raw_items ?? 0) + ' page snapshots.</p>'
  + (failed.length ? '<p><b>' + failed.length + ' of ' + batches.length + ' feed batches failed:</b> ' + failed.join('; ') + '</p>' : '')
  + '<h3>By channel</h3>' + table(byChannel)
  + '<h3>By region (feeds)</h3>' + table(byRegion)
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
  .to(makeBatches)
  .to(collect)
  .to(scrape)
  .to(report)
  .to(email)
  .add(runNow)
  .to(sync);
