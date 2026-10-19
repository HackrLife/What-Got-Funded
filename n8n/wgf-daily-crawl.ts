import { workflow, node, trigger } from '@n8n/workflow-sdk';

// What Got Funded — daily crawl, 9pm Sydney. Starts the Apify crawler over every mapped source for the previous UTC day.
// Extraction runs at 10pm (wgf-daily-extract.ts) on the latest successful crawl.
const ACTOR = 'https://api.apify.com/v2/acts/HackrLife~wgf-crawler';

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Daily 9pm Sydney', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 0 21 * * *' }] } } },
});
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run now' } });

const startCrawl = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Start crawl',
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    parameters: {
      method: 'POST', url: `${ACTOR}/runs?memory=2048&timeout=3300`,
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{ "mode": "articles" }',
      options: { timeout: 60000 },
    },
    credentials: { httpBearerAuth: { id: 'U4EQeOM0Nov43zUK', name: 'Apify API' } },
  },
});

export default workflow('wgf-daily-crawl', 'WGF — Daily Crawl (9pm)')
  .add(schedule)
  .to(startCrawl)
  .add(runNow)
  .to(startCrawl);
