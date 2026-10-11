# Methodology

How a funding announcement in a news source becomes a published round on whatgotfunded.com.

## 1. Reporting week

A reporting week runs from **Saturday 00:00 to Friday 23:59 UTC**. A round belongs to the week in which it was first publicly announced, using the earliest publication date among its sources. Rounds announced earlier but first reported this week are included and marked as late.

## 2. Collection

n8n runs collection every Saturday (Sydney time) and writes every item it receives to the `raw_items` table, unchanged, with the source and fetch time.

| Channel | Input | Notes |
|---|---|---|
| RSS | `sources/n8n-feeds.csv`, rows with `priority` 1 or 2 that are site feeds | Priority 1 feeds are funding-focused. Priority 2 feeds are general and pass through a keyword filter (`raises`, `funding`, `Series`, `seed`, and local-language equivalents) before extraction. |
| Google News | `sources/google-news-queries.csv` | Each query includes `when:7d`. Results link to the original publisher's article, which is what gets stored as the source. |
| Apify | `sources/scraped-pages.csv` | `apify/web-fetch`, Markdown output. Pages marked `wait=5000` are rendered in a browser for 5 seconds before capture. Roundup pages (KrASIA, Arab News) are followed one level to each roundup article. |
| Newsletters | `sources/newsletters.csv` | Received in a dedicated inbox and parsed by n8n into one raw item per deal line. |

Collection cost is small: scraping is about 40 to 100 page fetches a week at about US$0.0015 each.

## 3. Extraction

The collector agent reads each raw item and decides whether it describes an equity or venture funding round for a startup. If it does, the agent extracts:

- company name and domain
- amount and currency (and amount in USD at the announcement-date rate)
- stage: pre-seed, seed, Series A to Series F+, growth, strategic, or undisclosed
- announcement date
- lead and participating investors
- HQ city and country
- a one-sentence description of what the product does
- founders named in the announcement
- sector (from a fixed taxonomy)

**Excluded:** debt and venture debt, grants, fund closes by investors, IPOs and listings, M&A, and secondary sales. These are recorded in `raw_items` with the reason for exclusion, so the decision can be audited.

Non-English items are extracted in the original language. Company and investor names keep their original form, with an English or romanised form stored alongside (for example 前沿类脑 / Qianyan Leinao).

## 4. Matching and deduplication

The same round usually appears in several sources, and the same company in many weeks.

- **Companies** are matched on their website domain first, then on name and country. A new company record is created only when no match is found.
- **Investors** are matched against an alias list (for example "Sequoia India" and "Peak XV Partners"). Unknown investors are created as new records and reviewed by the checker.
- **Rounds** are the same round if they have the same company and stage, and announcement dates within 14 days of each other. All sources for a round are attached to one round record.

When sources disagree on a value (for example two different amounts), the company's own announcement wins, then the most specific source, and the disagreement is logged.

## 5. Enrichment

For each new company, the collector fills missing fields in this order, stopping when the field is filled:

1. The company's own website (HQ, description, social profile links, founders)
2. The original announcement
3. Apollo and Clay (headcount, HQ, industry)
4. Crunchbase, only for fields still missing, and only for checking

Social profile links are stored for the company (LinkedIn, X, Instagram, YouTube, GitHub) and its founders (LinkedIn, X, GitHub or personal site) when they are linked from the company's website or the announcement. Profiles are not scraped.

## 6. Coverage check

Each week the collector pulls the week's rounds from Crunchbase and Dealroom News and compares them with what our sources found:

- **Caught:** rounds in the benchmark that our sources also found
- **Missed:** rounds in the benchmark that our sources did not find. For each, the collector searches for a public source. If one exists, the round is added and the gap is logged against the market so the source list can be improved. If none exists, the round is not published.
- **Ours only:** rounds we found that the benchmark does not have

Coverage (caught ÷ benchmark total) is reported by region each week.

## 7. Checking

The checker agent runs after the collector and has not seen its reasoning. It checks:

- feeds that errored or returned nothing, and scrapes that came back empty or blocked
- rounds with no source URL, or whose source URL does not mention the company
- duplicate rounds and duplicate companies
- amounts that are implausible for the stage (for example a US$400M seed round) or that changed by more than 10x between sources
- dates outside the reporting week
- unknown investors and new companies with no domain

Problems it can resolve safely (for example a duplicate) are fixed and logged. Anything else is flagged. If more than 5% of the week's rounds are flagged, publishing is blocked until they are reviewed.

## 8. Publishing

The publisher agent computes the week's figures from the database:

- rounds and capital by region, market, stage and sector, ranked
- new seed, Series A, B and C rounds
- week-on-week change in deal count and capital, by region and sector
- most active investors of the week

It commits the week's data to this repository (Vercel deploys the site) and drafts the newsletter in Beehiiv for review before Sunday's send.

## 9. Source health

Each source's weekly result (items fetched, funding items found, errors) is stored. A feed that errors or returns nothing for two consecutive weeks is flagged for re-testing, and every source is re-verified quarterly.
