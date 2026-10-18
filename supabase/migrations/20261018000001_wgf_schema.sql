-- What Got Funded: core schema (see docs/data-model.md)
-- Lives in its own `wgf` schema inside the HackrLife Apps project.
-- Not exposed through the REST API; edge functions reach it via SUPABASE_DB_URL.

create schema if not exists wgf;

-- Feeds and pages the pipeline polls (one row per feed / page / newsletter)
create table wgf.sources (
  id            bigint generated always as identity primary key,
  region        text not null,
  market        text not null,
  source        text not null,
  language      text,
  channel       text not null check (channel in ('rss','google_news','apify','newsletter')),
  priority      smallint,                 -- 1 funding-focused, 2 general (keyword filter)
  feed_status   text,
  url           text,                     -- feed URL, Google News RSS URL or page URL
  settings      jsonb not null default '{}'::jsonb,   -- e.g. {"wait":5000}
  active        boolean not null default true,
  notes         text,
  last_verified date,
  created_at    timestamptz not null default now(),
  unique (channel, url)
);

-- Everything collected, unchanged
create table wgf.raw_items (
  id               bigint generated always as identity primary key,
  source_id        bigint references wgf.sources(id),
  channel          text not null,
  url              text not null,
  title            text,
  content          text,
  published_at     timestamptz,
  fetched_at       timestamptz not null default now(),
  week             date not null,          -- reporting week start (Saturday, UTC)
  status           text not null default 'pending'
                   check (status in ('pending','extracted','excluded','error')),
  exclusion_reason text,
  run_id           uuid,
  unique (url)
);
create index raw_items_week_status_idx on wgf.raw_items (week, status);

create table wgf.companies (
  id            bigint generated always as identity primary key,
  name          text not null,
  name_en       text,
  domain        text unique,
  description   text,
  hq_city       text,
  hq_country    text,
  region        text,
  sector        text,
  subsector     text,
  founded_year  int,
  headcount     int,
  linkedin_url  text, x_url text, instagram_url text, youtube_url text, github_url text,
  careers_url   text,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table wgf.rounds (
  id            bigint generated always as identity primary key,
  company_id    bigint not null references wgf.companies(id),
  stage         text check (stage in ('pre_seed','seed','series_a','series_b','series_c','series_d',
                                      'series_e','series_f_plus','growth','strategic','undisclosed')),
  amount        numeric,
  currency      text,
  amount_usd    numeric,
  announced_on  date,
  week          date not null,
  is_late       boolean not null default false,
  confidence    text check (confidence in ('confirmed','reported','flagged')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index rounds_week_idx on wgf.rounds (week);

create table wgf.round_sources (
  round_id     bigint not null references wgf.rounds(id) on delete cascade,
  raw_item_id  bigint references wgf.raw_items(id),
  url          text not null,
  published_at timestamptz,
  primary key (round_id, url)
);

create table wgf.investors (
  id          bigint generated always as identity primary key,
  name        text not null,
  name_en     text,
  type        text check (type in ('vc','cvc','angel','accelerator','pe','government','other')),
  hq_country  text,
  website     text,
  aliases     text[] not null default '{}'
);

create table wgf.round_investors (
  round_id    bigint not null references wgf.rounds(id) on delete cascade,
  investor_id bigint not null references wgf.investors(id),
  is_lead     boolean not null default false,
  primary key (round_id, investor_id)
);

create table wgf.people (
  id           bigint generated always as identity primary key,
  name         text not null,
  name_en      text,
  linkedin_url text, x_url text, github_url text, website text
);

create table wgf.company_people (
  company_id bigint not null references wgf.companies(id) on delete cascade,
  person_id  bigint not null references wgf.people(id) on delete cascade,
  role       text not null default 'founder',
  primary key (company_id, person_id, role)
);

create table wgf.coverage_checks (
  week            date not null,
  benchmark       text not null,
  region          text not null,
  benchmark_total int, caught int, missed int, ours_only int,
  primary key (week, benchmark, region)
);

create table wgf.source_health (
  source_id      bigint not null references wgf.sources(id),
  week           date not null,
  run_id         uuid,
  items_fetched  int not null default 0,
  funding_items  int not null default 0,
  errors         text,
  status         text not null check (status in ('ok','empty','error')),
  checked_at     timestamptz not null default now(),
  primary key (source_id, week)
);

create table wgf.check_reports (
  week            date primary key,
  rounds_checked  int, issues_found int, issues_fixed int, issues_flagged int,
  publish_allowed boolean,
  report          jsonb,
  created_at      timestamptz not null default now()
);

-- One row per pipeline run
create table wgf.runs (
  id          uuid primary key default gen_random_uuid(),
  week        date not null,
  channel     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb
);

-- Pipeline settings (ingest token etc.); readable only by the service role
create table wgf.config (
  key   text primary key,
  value text not null
);

-- Reporting week: Saturday 00:00 to Friday 23:59 UTC
create or replace function wgf.week_of(ts timestamptz) returns date
language sql immutable as $$
  select ((ts at time zone 'utc')::date - ((extract(dow from (ts at time zone 'utc'))::int + 1) % 7))
$$;

-- Lock everything down: no anon/authenticated access; service role and edge functions only
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'wgf' loop
    execute format('alter table wgf.%I enable row level security', t.tablename);
  end loop;
end $$;
revoke all on schema wgf from anon, authenticated;
