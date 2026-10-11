# Data model

The database (Supabase, Postgres) is built around permanent records for companies, investors and people. Each new round attaches to these records, so the database accumulates each company's funding history and each investor's activity over time.

## Tables

### `sources`
One row per source in `sources/sources.csv`: name, homepage, region, market, language, feed URL, collection method, priority, status, last verified.

### `raw_items`
Everything collected, unchanged.

| Field | Description |
|---|---|
| `id` | |
| `source_id` | The source it came from |
| `channel` | `rss`, `google_news`, `apify`, `newsletter` |
| `url` | Article or page URL |
| `title`, `content` | As received |
| `published_at`, `fetched_at` | |
| `week` | Reporting week (Saturday date) |
| `status` | `pending`, `extracted`, `excluded`, `error` |
| `exclusion_reason` | For example `debt`, `fund_close`, `ipo`, `not_funding` |

### `companies`
| Field | Description |
|---|---|
| `id` | |
| `name`, `name_en` | Original name and English or romanised name |
| `domain` | Main matching key |
| `description` | One sentence on what the product does |
| `hq_city`, `hq_country`, `region` | |
| `sector`, `subsector` | From the fixed taxonomy |
| `founded_year`, `headcount` | Where available |
| `linkedin_url`, `x_url`, `instagram_url`, `youtube_url`, `github_url` | Social profile links |
| `careers_url` | For hiring signals (later) |
| `first_seen_at`, `updated_at` | |

### `rounds`
| Field | Description |
|---|---|
| `id` | |
| `company_id` | |
| `stage` | `pre_seed`, `seed`, `series_a` … `series_f_plus`, `growth`, `strategic`, `undisclosed` |
| `amount`, `currency`, `amount_usd` | |
| `announced_on` | Earliest public announcement date |
| `week` | Reporting week |
| `is_late` | Announced before the week but first reported in it |
| `confidence` | `confirmed` (company announcement), `reported` (press), `flagged` |
| `created_at`, `updated_at` | |

### `round_sources`
Every source a round was found in: `round_id`, `raw_item_id`, `url`, `published_at`. A round must have at least one row here to be published.

### `investors`
`id`, `name`, `name_en`, `type` (VC, CVC, angel, accelerator, PE, government, other), `hq_country`, `website`, `aliases` (array).

### `round_investors`
`round_id`, `investor_id`, `is_lead`.

### `people`
`id`, `name`, `name_en`, `linkedin_url`, `x_url`, `github_url`, `website`. Public professional information only.

### `company_people`
`company_id`, `person_id`, `role` (for example founder, CEO, CTO).

### `coverage_checks`
One row per week per benchmark per region: `week`, `benchmark` (`crunchbase`, `dealroom`), `region`, `benchmark_total`, `caught`, `missed`, `ours_only`.

### `source_health`
One row per source per week: `source_id`, `week`, `items_fetched`, `funding_items`, `errors`, `status`.

### `check_reports`
One row per weekly run from the checker agent: `week`, `rounds_checked`, `issues_found`, `issues_fixed`, `issues_flagged`, `publish_allowed`, `report` (JSON).

## Planned tables

Added when the hiring and partnership layers start:

- `jobs`: open roles from funded companies' job boards (Greenhouse, Lever, Ashby, Workable and careers pages), with title, function, location and first-seen date.
- `company_signals`: needs inferred from job posts and announcements (for example "hiring first sales team", "seeking ISV partners"), at company level only.
