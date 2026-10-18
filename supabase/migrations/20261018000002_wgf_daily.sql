-- What Got Funded: move from a weekly to a daily cadence.
-- A daily edition (Sydney date) carries every round first found since the previous edition.
-- Weekly, monthly, quarterly and yearly reports are computed from the daily records.

-- Collection day for each raw item (UTC date of the run that collected it)
alter table wgf.raw_items add column if not exists day date;
update wgf.raw_items set day = (fetched_at at time zone 'utc')::date where day is null;
alter table wgf.raw_items alter column day set not null;
alter table wgf.raw_items alter column week drop not null;
create index if not exists raw_items_status_idx on wgf.raw_items (status, fetched_at);

-- The edition a round first appears in (Sydney date of the morning send)
alter table wgf.rounds add column if not exists edition date;
alter table wgf.rounds alter column week drop not null;
create index if not exists rounds_edition_idx on wgf.rounds (edition);
create index if not exists rounds_announced_idx on wgf.rounds (announced_on);

-- Source health per day instead of per week
alter table wgf.source_health add column if not exists day date;
update wgf.source_health set day = week where day is null;
alter table wgf.source_health alter column day set not null;
alter table wgf.source_health drop constraint if exists source_health_pkey;
alter table wgf.source_health alter column week drop not null;
alter table wgf.source_health add primary key (source_id, day);

-- Runs per day
alter table wgf.runs add column if not exists day date;
update wgf.runs set day = (started_at at time zone 'utc')::date where day is null;
alter table wgf.runs alter column week drop not null;

-- Checker reports per edition
alter table wgf.check_reports add column if not exists edition date;
alter table wgf.check_reports drop constraint if exists check_reports_pkey;
alter table wgf.check_reports alter column week drop not null;
alter table wgf.check_reports add column if not exists id bigint generated always as identity primary key;
create unique index if not exists check_reports_edition_idx on wgf.check_reports (edition);
