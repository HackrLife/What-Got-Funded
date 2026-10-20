-- Deterministic check of the page a verifier cites: its real publish date and whether it names the company.
alter table wgf.round_checks add column if not exists page_date date, add column if not exists page_ok boolean, add column if not exists page_note text;
-- Gold corrections after the independent audit of 21 Oct 2026
update wgf.gold_rounds set truth = 'EARLIER', truth_date = '2026-10-15' where round_id = 983;  -- WWD exclusive, 15 Oct
update wgf.gold_rounds set truth = 'EARLIER', truth_date = '2026-09-21' where round_id = 933;  -- 10100.com, 21 Sep
