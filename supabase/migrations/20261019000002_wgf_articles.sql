-- Full articles from the Apify crawler (channel 'article') carry their links and date basis in meta.
alter table wgf.raw_items add column if not exists meta jsonb not null default '{}'::jsonb;
create index if not exists raw_items_channel_status_idx on wgf.raw_items (channel, status);
-- Company sites read by the crawler's companies mode
alter table wgf.companies add column if not exists facebook_url text;
alter table wgf.companies add column if not exists site_checked_at timestamptz;
-- When the domain search last ran for a company (so it is not repeated every night)
alter table wgf.companies add column if not exists domain_checked_at timestamptz;
