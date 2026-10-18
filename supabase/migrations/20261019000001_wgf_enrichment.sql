-- Enrichment: each published round gets a verified profile built from its articles and the company's own site.
-- The profile JSON is kept as-is for audit; its fields are also written back into companies/rounds.

alter table wgf.rounds add column if not exists verified_at timestamptz;          -- set when enrichment confirmed the round
alter table wgf.rounds add column if not exists verify_note text;                 -- why a round was hidden or changed
alter table wgf.rounds add column if not exists summary text;                     -- 2-3 sentence newsletter entry
alter table wgf.rounds drop constraint if exists rounds_status_check;
alter table wgf.rounds add constraint rounds_status_check
  check (status in ('live', 'stale', 'unnamed', 'rumour', 'duplicate', 'not_venture', 'unverified'));

create table if not exists wgf.round_profiles (
  round_id     bigint primary key references wgf.rounds(id),
  profile      jsonb not null,          -- full JSON from the enrichment step (sources, notes, verdict)
  verdict      text not null,           -- valid_recent | stale_old_round | not_venture | duplicate | unverified
  method       text not null,           -- 'agent_research' (manual run) or 'pipeline' (daily wgf-enrich)
  created_at   timestamptz not null default now()
);
alter table wgf.round_profiles enable row level security;
