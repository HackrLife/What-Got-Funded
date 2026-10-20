# What Got Funded: editorial spec

Every run follows this. It defines what gets published, where, and in what shape.

## Position

What Got Funded curates startup funding news and analyses it. Every round comes from a published news report and links to it. We are not a private database and do not run our own investigations. Coverage is as complete as our ~300 sources allow; some rounds will be missed.

## Daily pipeline (Sydney time)

| When | Step |
|---|---|
| 9pm | Apify crawler reads every mapped source for **yesterday in Sydney** (a run on the 10th collects the 9th, which has ended everywhere by then). |
| 10pm | Claude extracts rounds from each article (translated to English), merges duplicates, finds company websites, reads company sites for socials and careers pages. |
| 5am | Site rebuild with the new daily article; Beehiiv newsletter draft created. |
| 6–7am | Newsletter sent. |

A day's edition contains only rounds **first publicly announced on that day** ("Announced", never "Closed"). Recaps, re-posts of older rounds, background mentions, debt, grants, IPOs, M&A, fund closes and rumours are excluded.

## Date verification (every run)
"Funded date" means the **first public announcement date**, in the publisher's local time. Four checks, in order:
1. **Anchored extraction.** Each article is read with its publish date and the target day. Each round gets `temporal_phrase_exact`, `temporal_category` (FRESH_ANNOUNCEMENT, RECENT_SYNDICATION, HISTORICAL_REFERENCE, SEC_FILING_ONLY), `inferred_announcement_date` and `date_confidence_score`. HISTORICAL_REFERENCE is discarded; SEC_FILING_ONLY and confidence below 0.5 are held as `unverified`; a first announcement before the target day is `missed_window`.
2. **Source tiers.** Wires and primary press can establish a date. Re-publishers and aggregators (Dealroom News, TheSaaSNews, Startupresearcher, Fundz, ValueAddVC, Startuprise, AIWeekly and similar) can confirm a round but never create one on their own: rounds known only from them are `unverified`.
3. **Earliest-wire check.** Every new round waits as `pending_check` until one Google search (Apify Google Search Scraper, English results) looks for reports of the same round dated in the 90 days before its announcement day. The company must be in a result's title, with its amount or stage. One result with an absolute earlier date, or two sites with relative dates two or more days earlier, makes it `missed_window` (with `earliest_web_date` and `earliest_web_url`). Otherwise it goes `live`. Database pages and social posts are not evidence.
4. **90-day lookback.** A new article about a company with a compatible round (same or unstated stage, amount within 20%) in the last 90 days is added to that round as a source; the round keeps its first announcement date. The same round under two translated names is matched by original-script name, or by the same amount, stage and country within 3 days.

Each round on the site and in the email shows "Announced <date>" and its first source with that source's own date.

## Formats

### 1. Daily article (site): the main piece
- One article per day, shown on the site as a **content card**; clicking it opens the full article on one scrolling page.
- **Headline**: the date, then one short story line about the day's main story. Examples:
  - `19 Oct: Company X from Country Y leads the day with $Z million`
  - `9 Oct: Healthcare startups take the most funding`
  - `12 Oct: India raises more than all of Europe`
  - `15 Oct: Sequoia backs four startups in a day`

  The story is whichever is strongest in the day's data: a standout single round, a sector or region far ahead, or an investor in several deals. Short, factual, specific. The same headline is used on the card, the article and the email subject.
- **Four core visuals, every day, in this order:**
  1. Total funding: amount raised, number of rounds, how many disclosed an amount
  2. Funding by region (bar chart)
  3. Top investors (bar chart: number of rounds, lead rounds marked)
  4. Funding by industry (bar chart)
- **Then every startup funded that day**, grouped in sections (by region, subsections by country), each with: name, website, what it does, HQ, amount and stage, lead and other investors, founders (with LinkedIn and X links where known), what is unique, use of funds, source links.

### 2. Daily newsletter (Beehiiv): the condensed version
- Same headline as the article (subject line).
- Same four visuals (as images).
- **At most 20 startups**, with the same detail per startup. Selection: the largest disclosed rounds, with slots kept so every region with rounds that day is represented.
- Ends with "See all N rounds" linking to the full article on the site.

### 3. Weekly roundup, every Sunday
Covers the latest complete week (Saturday to Friday). Same structure: period + story headline, the four visuals for the week, the week's biggest rounds and trends. Site article + condensed newsletter.

### 4. Monthly roundup, 1st of each month
Covers the previous month, published the evening of the 1st once the last day is processed. Same structure, plus comparison with the month before.

### 5. Insights (analysis layer)
One **Insights** page with segment tabs: Countries, Investors, Industries, Funding flows (more can be added). Each segment has its own address (`/insights/countries/` etc.). Insight stories are cards (date, story headline, one chart) that open into full articles and accumulate as an archive over the years.

## Writing rules
- Plain, factual English. No hype, no rhetorical contrasts.
- Use only what sources state; unstated values stay blank.
- Amounts in US dollars (ECB reference rate), with the original currency shown where different.
- Founders: name, role and public profile links only. Never emails or phone numbers.

## Every daily run: checklist

1. **Data check before publishing** (the day's `live` rounds):
   - Drop recaps: a round whose sources are a roundup article ("AI startups secured $16B…") or whose source URL is dated to an earlier month is not the day's news. Set it `stale` (never delete).
   - Every round needs a country; fill it from the source when the article states it.
   - No vague "what it does" lines ("not described in the headline"); the edition hides them, fix the company description when the source says more.
   - Investor and founder names: one entry per firm or person. Translation variants go in `site/data/editions.json` under that day's `rounds` until fixed in the data.
2. **Headline**: auto-picked by `site/src/edition.mjs` (largest round, or a sector/investor story when one dominates). Override in `site/data/editions.json` → `{ "YYYY-MM-DD": { "headline": "...", "dek": "..." } }`.
3. **Site**: push to `main`; Vercel rebuilds. The edition appears at `/editions/YYYY-MM-DD/`, as the card on the home page and in `/editions/`.
4. **Newsletter**:
   - `cd site && node newsletter.mjs YYYY-MM-DD && python3 render-charts.py YYYY-MM-DD`, commit the PNGs, push.
   - Upload the four PNGs to Beehiiv (`save_image` from the raw GitHub URL at the commit SHA).
   - `save_post` as a **draft** with the edition headline as title and subject, `hide_from_feed: true`, email recipients = segment `seg_36f8c7f8-5c39-472a-a78e-61f7852370ca` ("What Got Funded — first readers") until the full list is opened.
   - At most 20 startups; every region with rounds keeps at least one slot; ends with "See all N rounds" to the article.
5. Sending stays a human action in Beehiiv.
