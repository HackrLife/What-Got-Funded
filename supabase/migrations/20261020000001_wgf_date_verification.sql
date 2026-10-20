-- Date verification: a round is published only after its first public announcement is confirmed.
--   pending_check  extracted, waiting for the earliest-wire search
--   missed_window  an earlier public report of the same round exists, so it is not news for this day
alter table wgf.rounds drop constraint if exists rounds_status_check;
alter table wgf.rounds add constraint rounds_status_check
  check (status in ('live', 'stale', 'unnamed', 'rumour', 'duplicate', 'not_venture', 'unverified', 'superseded', 'pending_check', 'missed_window'));

alter table wgf.rounds
  add column if not exists temporal_category text,
  add column if not exists date_confidence numeric,
  add column if not exists wire_checked_at timestamptz,
  add column if not exists earliest_web_date date,
  add column if not exists earliest_web_url text;
