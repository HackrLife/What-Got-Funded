-- Rounds are never deleted by the pipeline; ones that should not be published get a status instead.
--   live     published
--   stale    announced more than 30 days before we first saw it (archive pages, "related posts")
--   unnamed  company not named in the source ("an AI healthtech startup")
alter table wgf.rounds add column if not exists status text not null default 'live'
  check (status in ('live', 'stale', 'unnamed', 'rumour', 'duplicate'));
create index if not exists rounds_edition_status_idx on wgf.rounds (edition, status);

update wgf.rounds r set status = 'stale'
 where status = 'live'
   and announced_on < (select min(rs.published_at)::date from wgf.round_sources rs where rs.round_id = r.id) - 30;

update wgf.rounds r set status = 'unnamed'
  from wgf.companies c
 where c.id = r.company_id and r.status = 'live'
   and c.name ~* '^(an? |the )?(undisclosed|unnamed|unidentified|stealth|anonymous)\M';
