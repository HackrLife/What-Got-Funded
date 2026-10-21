-- Deterministic check of the page a verifier cites: its real publish date and whether it names the company.
alter table wgf.round_checks add column if not exists page_date date, add column if not exists page_ok boolean, add column if not exists page_note text;
-- Gold corrections after the independent audit of 21 Oct 2026
update wgf.gold_rounds set truth = 'EARLIER', truth_date = '2026-10-15' where round_id = 983;  -- WWD exclusive, 15 Oct
update wgf.gold_rounds set truth = 'EARLIER', truth_date = '2026-09-21' where round_id = 933;  -- 10100.com, 21 Sep
-- Audit of 21 Oct, second pass: pages confirmed by fetch
update wgf.gold_rounds set truth = 'ON_DAY', truth_date = '2026-10-18' where round_id = 165;  -- Taishan Finance (sdnews) 2026-10-18 10:07
update wgf.gold_rounds set truth = 'ON_DAY', truth_date = '2026-10-19' where round_id in (982, 978);  -- ifeng Anhui 10-19; DoNews 10-19 (2025 report was an earlier round)
