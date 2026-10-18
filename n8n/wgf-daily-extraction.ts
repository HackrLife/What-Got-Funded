import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// What Got Funded — daily extraction (5:45 Sydney, after collection).
// Raw items → Claude Haiku in chunks of 40 → structured rounds in Supabase (wgf-extract does all data work).
// The x-wgf-token value lives only in n8n; this export uses a placeholder.
const FN = 'https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-extract';
const TOKEN = '__WGF_TOKEN__';
const MODEL = 'claude-haiku-5-5';

const headers = { parameters: [{ name: 'x-wgf-token', value: TOKEN }] };
const lenient = { response: { response: { neverError: true, responseFormat: 'json' } } };

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Daily 5:45 Sydney', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 45 5 * * *' }] } } },
});
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });

const plan = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Plan chunks',
    parameters: {
      method: 'POST', url: FN, sendHeaders: true, headerParameters: headers,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "plan", "size": 40 }',
      options: { timeout: 120000, ...lenient },
    },
  },
});

const split = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'One item per chunk',
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
      jsonBody: expr(`{{ JSON.stringify({ model: "${MODEL}", max_tokens: 16000, output_config: { effort: "low" }, system: $json.system, messages: [{ role: "user", content: $json.user }] }) }}`),
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

const summary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarise',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const p = $('Plan chunks').first().json;
const saves = $input.all().map(i => i.json);
const sum = k => saves.reduce((a, s) => a + (s[k] || 0), 0);
const failed = saves.filter(s => s.error);
const usage = $('Extract with Claude').all().reduce((a, i) => ({ in: a.in + (i.json.usage?.input_tokens || 0), out: a.out + (i.json.usage?.output_tokens || 0) }), { in: 0, out: 0 });
return [{ json: {
  pending: p.pending, keyword_excluded: p.keyword_excluded, sent_to_claude: p.to_extract, chunks: saves.length,
  rounds_created: sum('rounds_created'), rounds_merged: sum('rounds_merged'), excluded_by_claude: sum('excluded'),
  not_returned: sum('not_returned'), failed_chunks: failed.length, errors: failed.map(f => f.error).slice(0, 5),
  input_tokens: usage.in, output_tokens: usage.out,
} }];`,
    },
  },
});

export default workflow('wgf-daily-extraction', 'WGF — Daily Extraction')
  .add(schedule)
  .to(plan)
  .to(split)
  .to(buildPrompt)
  .to(claude)
  .to(saveRounds)
  .to(summary)
  .add(runNow)
  .to(plan);
