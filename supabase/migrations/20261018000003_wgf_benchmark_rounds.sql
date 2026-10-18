-- Rounds from commercial databases (Crunchbase now, Tracxn later), used only to measure coverage.
-- Never published and never copied into wgf.rounds.
create table if not exists wgf.benchmark_rounds (
  id              bigint generated always as identity primary key,
  benchmark       text not null,                 -- 'crunchbase'
  external_id     text,                          -- benchmark's company id
  company         text not null,
  domain          text,
  country         text,
  investment_type text,
  amount_usd      numeric,
  lead_investors  text[] not null default '{}',
  announced_on    date,
  pulled_at       timestamptz not null default now(),
  matched_round_id bigint references wgf.rounds(id),
  unique (benchmark, company, announced_on, investment_type)
);
create index if not exists benchmark_rounds_date_idx on wgf.benchmark_rounds (announced_on);
alter table wgf.benchmark_rounds enable row level security;
