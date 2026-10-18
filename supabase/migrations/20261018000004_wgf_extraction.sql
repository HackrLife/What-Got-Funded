-- Fields the extractor fills, and normalised keys for matching.

alter table wgf.rounds add column if not exists amount_text text;        -- as written when not a number, e.g. "数千万元"
alter table wgf.rounds add column if not exists highlight text;          -- one line: what makes the company different
alter table wgf.rounds add column if not exists headline text;           -- best source headline
alter table wgf.rounds add column if not exists source_count int not null default 0;

alter table wgf.companies add column if not exists name_key text;
alter table wgf.companies add column if not exists name_native text;
create index if not exists companies_name_key_idx on wgf.companies (name_key);

alter table wgf.investors add column if not exists name_key text;
create unique index if not exists investors_name_key_idx on wgf.investors (name_key);

alter table wgf.people add column if not exists name_key text;
alter table wgf.people add column if not exists verified_by text;        -- e.g. 'apollo'
create index if not exists people_name_key_idx on wgf.people (name_key);

-- Each raw item points at the round it produced (if any)
alter table wgf.raw_items add column if not exists round_id bigint references wgf.rounds(id);
alter table wgf.raw_items add column if not exists extracted_at timestamptz;

-- Name normaliser shared by matching: lower case, no punctuation, no legal suffixes.
create or replace function wgf.name_key(n text) returns text language sql immutable as $$
  select nullif(regexp_replace(
           regexp_replace(lower(coalesce(n, '')),
             '\m(inc|incorporated|ltd|limited|llc|plc|gmbh|ag|sa|sas|bv|pte|pty|co|corp|corporation|company|technologies|technology|tech|labs|lab|group|holdings|ai)\M\.?', '', 'g'),
           '[^[:alnum:]]+', '', 'g'), '')
$$;

-- Sydney date of the next 7am edition for a given moment
create or replace function wgf.next_edition(ts timestamptz) returns date language sql stable as $$
  select case when (ts at time zone 'Australia/Sydney')::time < '07:00'
              then (ts at time zone 'Australia/Sydney')::date
              else (ts at time zone 'Australia/Sydney')::date + 1 end
$$;
