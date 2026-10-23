-- Job boards are now found by one web search per company (Serper) instead of guessing board names.
alter table wgf.company_ats add column if not exists searched_at timestamptz;   -- last board search for this company
alter table wgf.company_ats add column if not exists found_via text;            -- search | careers_page
alter table wgf.company_ats alter column checked_at drop not null;
