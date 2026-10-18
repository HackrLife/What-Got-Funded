# wgf-crawler — What Got Funded daily crawler

Apify Actor with no npm dependencies (Node 22, built-in fetch). It runs every day at 9pm Sydney.

## What it does

**Mode `articles` (daily, 9pm Sydney):**

1. Loads `sources/n8n-feeds.csv` (214 feeds, including 76 Google News searches) and `sources/scraped-pages.csv` (167 listing pages) from this repo.
2. Keeps headlines that look like funding news, using multilingual keywords (English, Chinese, Japanese, Korean, French, Spanish, Portuguese, German, Italian, Nordic, Dutch, Russian, Indonesian, Vietnamese, Thai, Hindi, Arabic, Hebrew, Turkish, Polish and more).
3. Resolves Google News links to the publisher's own URL.
4. Checks robots.txt for every site. Skips sites that disallow crawling.
5. Fetches each article and reads its publish date from the page metadata, not from the feed or the scrape time. Keeps only articles published on the target day, or the day after for late local coverage.
6. Writes one dataset item per article with these fields: headline, full text (up to 9,000 characters), published date and how that date was found, source, market, language, outbound company links and social links.

Two key-value records are written as well:

- `SUMMARY`: the counts for the run.
- `SOURCE_HEALTH`: which feeds and pages worked.

**Mode `companies` (after extraction):**

- Input: a list of company domains.
- For each domain it reads the homepage plus up to two about or team pages.
- It returns:
  - the company's LinkedIn, X, Instagram, YouTube, GitHub and Facebook links
  - people's LinkedIn profile links found on the site
  - the careers page

It stores links only. It never scrapes LinkedIn or X themselves, and it never collects emails or phone numbers.

**Export:** every run's dataset can be exported as CSV, JSON or Excel. Use the run's Storage tab in the console, or the API: `GET /v2/datasets/{id}/items?format=csv`.

## Input

| field | default | |
|---|---|---|
| mode | articles | `articles` or `companies` |
| targetDate | previous UTC day | day the rounds were announced |
| sourcesRepo | this repo's `sources/` raw URL | where the CSVs live |
| domains | — | companies mode |
| maxArticles | 800 | |
| concurrency | 12 | at most 2 requests at a time per site |

## Tests

`npm test` runs offline parser checks.
