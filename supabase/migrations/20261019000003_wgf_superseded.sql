-- 'superseded': a round replaced by a later re-extraction of the same articles (kept for audit, never published)
alter table wgf.rounds drop constraint if exists rounds_status_check;
alter table wgf.rounds add constraint rounds_status_check
  check (status in ('live', 'stale', 'unnamed', 'rumour', 'duplicate', 'not_venture', 'unverified', 'superseded'));
