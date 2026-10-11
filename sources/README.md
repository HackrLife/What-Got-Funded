# Source registry

Every source used to find startup funding rounds. All feeds and pages were tested on **11 October 2026**.

## Files

### `sources.csv` — all 343 sources

| Column | Meaning |
|---|---|
| `region` | APAC, Europe, Americas, Africa, Middle East or Global |
| `market` | Country, or a regional grouping such as Pan-APAC or Pan-Europe |
| `source` | Outlet name |
| `homepage` | Outlet URL |
| `language` | Publication language(s) |
| `funding_focus` | `dedicated` (has a funding section or regular funding roundup) or `general` |
| `funding_section` | Funding section URL or the name of its regular roundup |
| `feed_url` | RSS feed URL, if one exists |
| `feed_status` | `verified` (fetched and returned recent items), `unverified` (exists but could not be fetched in testing), `not found` |
| `paywall` | `none`, `partial` or `hard` |
| `priority` | `1 – Ingest`: funding-focused with a usable feed. `2 – Ingest + keyword filter`: general feed filtered for funding stories. `3 – Scrape / manual`: no usable feed, a stale feed, or excluded by the source's terms. |
| `collection_method` | `rss`, `apify_scrape` or `manual_or_not_ingested` |
| `notes` | Cadence, coverage, staleness and why a source is or isn't ingested |
| `last_verified` | Date the source was last tested |

A few `unverified` feeds from major sources are set to priority 1 because feed directories show them live. They are tested first in the pipeline's first run.

### `n8n-feeds.csv` — the 203 feeds n8n polls
138 site feeds plus 65 Google News queries. Columns: `region`, `market`, `source`, `language`, `priority`, `feed_status`, `feed_url`.

### `google-news-queries.csv` — 65 local-language searches
Columns: `region`, `market`, `language`, `query`, `hl` (interface language), `gl` (country), `ceid` (edition), `feed_url`. Each feed is limited to the past 7 days with `when:7d`.

### `scraped-pages.csv` — 11 pages scraped with Apify
Columns: `source`, `market`, `page_url`, `apify_actor`, `settings`, `test_result`, `notes`, `last_tested`.

`test_result`: `good` (dated funding list with links), `usable` (funding items that need extra steps, such as opening roundup articles), `to test` (a better URL was identified but not yet tested), `broken` (page no longer exists).

### `newsletters.csv` — 7 deal newsletters
Newsletters whose deal lists are not available by RSS. Received in a dedicated inbox and parsed by n8n.

### `benchmarks.csv` — coverage checks
Commercial databases and regional reports used to check coverage and totals. Data from these is not published.
