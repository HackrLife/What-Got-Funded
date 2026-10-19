// What Got Funded — extraction (the collector agent's data layer)
//
// POST /functions/v1/wgf-extract   (header: x-wgf-token)
//   { "mode": "plan", "size": 40 }
//     → excludes pending items with no funding keywords, returns the remaining pending item ids in chunks.
//   { "mode": "prompt", "ids": [..] }
//     → { system, user, ids }: the prompt n8n sends to Claude for one chunk.
//   { "mode": "save", "ids": [..], "text": "<Claude's reply>" }
//     → parses the reply, matches/creates companies, investors and founders, merges rounds that are the same
//       (same company and stage within 14 days), attaches every source, and marks each raw item.
//
// Rules follow docs/methodology.md: equity rounds of startups only; debt, grants, fund closes, IPOs, M&A,
// secondary sales and private equity are excluded with a reason. Nothing is guessed: unstated values stay null.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });

const FUNDING_RE = new RegExp(
  [
    "rais(e|es|ed|ing)", "funding", "fundrais", "series [a-h]\\b", "seed", "pre-seed", "round", "invest", "backed",
    "secures?", "bags?", "closes?", "\\$\\s?\\d", "€\\s?\\d", "£\\s?\\d", "\\d+(\\.\\d+)?\\s?(m|mn|million|bn|billion|crore|lakh)\\b",
    "資金調達", "億円", "シリーズ", "투자", "유치", "억원", "融资", "轮", "亿元", "万元", "finanzierung", "millionen",
    "levée", "lève", "ronda", "inversión", "financiación", "rodada", "aporte", "investimento", "finanziamento",
    "investering", "rahoitus", "kapitalrunde", "financiering", "инвестиц", "раунд", "pendanaan", "gọi vốn",
    "ระดมทุน", "निवेश", "फंडिंग", "تمويل", "جولة", "גיוס", "השקעה", "yatırım", "finansowanie", "investice",
  ].join("|"),
  "i",
);

const STAGES = ["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d", "series_e", "series_f_plus", "growth", "strategic", "undisclosed"];
const SECTORS = [
  "AI & data", "Enterprise software", "Developer tools", "Cybersecurity", "Fintech", "Insurtech", "Healthtech", "Biotech & pharma",
  "Medtech & devices", "Climate & energy", "Mobility & EV", "Robotics & industrial", "Semiconductors & hardware", "Space & defence",
  "Consumer & retail", "Food & agriculture", "Real estate & construction", "Logistics & supply chain", "Education", "HR & work",
  "Media & entertainment", "Gaming", "Travel & hospitality", "Web3 & crypto", "Other",
];
const EXCLUDE_REASONS = ["not_funding", "debt", "grant", "fund_close", "ipo_or_public", "m_and_a", "secondary", "private_equity", "duplicate_listing", "rumour", "recap", "other"];
// Company names that are descriptions, not names ("an undisclosed AI startup")
const NON_LATIN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff\u0590-\u05ff\u0e00-\u0e7f]/;
const UNNAMED_COMPANY = /^(an? |the )?(undisclosed|unnamed|unidentified|stealth|anonymous)\b/i;
// Placeholders that are not investor names
const GENERIC_INVESTOR = /^(existing|new|other|undisclosed|unnamed|several|various|private|individual|angel|strategic|institutional|international|local|family)?\s*(investors?|backers?|angels?|shareholders?|funds?|vcs?|venture capital( firms?)?|family offices?|investment firms?)$|^(others?|undisclosed|n\/a)$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------- FX: ECB daily reference rates, plus fixed pegs ----------
let fxCache: Record<string, number> | null = null; // units of currency per 1 USD
async function usdRates(): Promise<Record<string, number>> {
  if (fxCache) return fxCache;
  const perEur: Record<string, number> = { EUR: 1 };
  try {
    const xml = await (await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml")).text();
    for (const m of xml.matchAll(/currency='([A-Z]{3})' rate='([\d.]+)'/g)) perEur[m[1]] = Number(m[2]);
  } catch { /* no rates: amounts in other currencies stay unconverted */ }
  const out: Record<string, number> = { USD: 1, AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845, JOD: 0.709 };
  if (perEur.USD) for (const [c, r] of Object.entries(perEur)) out[c] = r / perEur.USD;
  return (fxCache = out);
}

// ---------- prompt ----------
function buildPrompt(items: Record<string, unknown>[]) {
  const system = `You read startup and business news headlines with short snippets, in many languages, and extract startup funding rounds as JSON. You are precise and never guess.

Include only equity or venture rounds raised by startups or private growth companies: pre-seed, seed, angel, Series A onwards, growth equity, and strategic or corporate investments in startups.
Exclude, with a reason: not_funding (not about a raise), debt (loans, venture debt, credit facilities, bonds), grant (government or foundation grants, prizes), fund_close (an investor raising a fund), ipo_or_public (IPO, listing, post-IPO or public-company raise), m_and_a (acquisitions, mergers), secondary (share sales between investors), private_equity (buyouts, PE investment in mature companies), duplicate_listing (an index page or list with no specific deal), rumour (talks, "in discussions", "nearing close", "seeking", "plans to raise", or "reportedly" without a confirmed close), other.

Rules:
- Use only what the text states. If a value is not stated, use null (or [] for lists). Never invent a domain, founder, investor, amount or date.
- One output round per real round. If several items describe the same round, put all their ids in one round's item_ids.
- A roundup item that lists several deals may appear in several rounds.
- Every input id must appear in at least one round's item_ids or in excluded.
- amount: a number in full units of the stated currency (16.25亿元 → 1625000000 with CNY; 30億円 → 3000000000 with JPY; 50억원 → 5000000000 with KRW; Rs 36.5 crore → 365000000 with INR). If a bound is given ("more than $500M", "over €10M", "up to $4B"), set amount to that figure and copy the wording into amount_text. If only a range or vague size is given (数千万元, "eight figures", 亿元级), set amount null and copy the wording into amount_text.
- amount_usd_stated: the USD figure only if the text itself gives one (e.g. "KSh1.04 billion (US$8 million)" → 8000000).
- lead_investors and investors: named firms or people only. Never list placeholders such as "existing investors", "new investors", "undisclosed investors" or "angel investors"; leave them out.
- stage: one of ${STAGES.join(", ")}. Angel counts as seed. Pre-A or A+ count as series_a; B+ as series_b. Use undisclosed if no stage is stated.
- sector: one of ${SECTORS.map((s) => `"${s}"`).join(", ")}.
- company: the name in English or romanised form. company_native: the original-script name if different, else null.
- hq_country: English country name of the company's base, if stated or clear from the text (e.g. "Bengaluru-based"); else null.
- description: one sentence in English on what the product does, from the text. highlight: one sentence in English on what is distinctive or notable about the company or round, only if the text supports it; else null.
- announced_on: YYYY-MM-DD if the text dates the announcement; else null.

Reply with JSON only, no prose:
{"rounds":[{"item_ids":[1],"company":"","company_native":null,"domain":null,"hq_city":null,"hq_country":null,"sector":"","stage":"","amount":null,"currency":null,"amount_usd_stated":null,"amount_text":null,"lead_investors":[],"investors":[],"founders":[{"name":"","role":""}],"description":"","highlight":null,"announced_on":null}],"excluded":[{"id":2,"reason":"not_funding"}]}`;
  const lines = items.map((i) => JSON.stringify({
    id: Number(i.id), src: i.source, mkt: i.market,
    date: i.published_at ? new Date(i.published_at as string).toISOString().slice(0, 10) : undefined,
    t: i.title, s: String(i.content ?? "").replace(/\s+/g, " ").slice(0, 450) || undefined,
  }));
  return { system, user: `Items (one JSON object per line):\n${lines.join("\n")}` };
}

// ---------- full-article prompt (Apify crawler, one article per call) ----------
function buildArticlePrompt(item: Record<string, unknown>) {
  const meta = (item.meta ?? {}) as Record<string, unknown>;
  const system = `You read one full news article, in any language, and extract the startup funding rounds it reports as JSON, in English. You are precise and never guess.

Include only equity or venture rounds raised by startups or private growth companies: pre-seed, seed, angel, Series A onwards, growth equity, and strategic or corporate investments in startups.
If the article reports no such round, return it in excluded with one reason: not_funding, debt, grant, fund_close, ipo_or_public, m_and_a, secondary, private_equity, duplicate_listing, rumour (talks, "in discussions", "plans to raise", "reportedly" without a confirmed close), recap, other.

Only new announcements count:
- Extract a round only if the article reports it as recent news: announced on or within 7 days before the article's publish date.
- Do not extract rounds the article mentions as background or history ("raised in May", "last year", "earlier this month"), or rounds listed in periodic reports, rankings and data recaps (quarterly or monthly funding totals, "largest rounds of Q3", CB Insights or Crunchbase tallies). If nothing new remains, put the article in excluded with reason "recap".
- A weekly or daily deals roundup is fine: extract each deal it presents as just announced.

Rules:
- Use only what the article states, plus the links listed under "Links in the article". Never invent a domain, social profile, founder, investor, amount or date. Unstated values are null or [].
- One round per company. A roundup article may report several rounds; extract each.
- Translate everything into English. company must be in Latin script: the company's English name if the article or its links give one, otherwise a romanisation (pinyin for Chinese, Hepburn for Japanese, Revised Romanization for Korean). company_native is the original-script name if different, else null.
- domain: the company's own website, only if the article names it or a link in the article clearly points to it (match by name). Not the publisher, an investor or a social network.
- company_socials and founders' linkedin/x: only URLs from "Links in the article" that clearly belong to that company or person; else null.
- amount: a number in full units of the stated currency (16.25亿元 → 1625000000 CNY; 30億円 → 3000000000 JPY; 50억원 → 5000000000 KRW; Rs 36.5 crore → 365000000 INR). For bounds ("more than $500M") set the figure and copy the wording to amount_text. For vague sizes (数千万元, "eight figures") amount is null and the wording goes to amount_text.
- amount_usd_stated: the USD figure only if the article itself gives one.
- lead_investors and investors: named firms or people only, each listed once under its English name (no original-script duplicates, no repeated variants such as "Dragoneer" and "Dragoneer Investment Group"). Never placeholders such as "existing investors". Leads go only in lead_investors.
- stage: one of ${STAGES.join(", ")}. Angel counts as seed; Pre-A and A+ as series_a; B+ as series_b; undisclosed if not stated.
- sector: one of ${SECTORS.map((s) => `"${s}"`).join(", ")}.
- hq_city, hq_country: the company's base, in English, if stated or clear (e.g. "Bengaluru-based").
- description: one plain sentence on what the company does. unique: one sentence on what is distinctive about the company or this round, only if the article supports it, else null. summary: two or three sentences for a newsletter entry covering what the company does, the round and what the money is for, using only facts in the article.
- use_of_funds: what the money is for, if stated, else null.
- announced_on: YYYY-MM-DD of the announcement only if the article states it, else null.

Reply with JSON only:
{"rounds":[{"item_ids":[${Number(item.id)}],"company":"","company_native":null,"domain":null,"company_socials":{"linkedin":null,"x":null},"hq_city":null,"hq_country":null,"sector":"","stage":"","amount":null,"currency":null,"amount_usd_stated":null,"amount_text":null,"lead_investors":[],"investors":[],"founders":[{"name":"","role":"","linkedin":null,"x":null}],"description":"","unique":null,"use_of_funds":null,"summary":"","announced_on":null}],"excluded":[{"id":${Number(item.id)},"reason":"not_funding"}]}`;
  const links = [
    ...((meta.outbound as { domain: string; anchor: string }[]) ?? []).map((o) => `${o.domain} — "${o.anchor}"`),
    ...((meta.socials as string[]) ?? []),
  ];
  const user = [
    `Article id: ${Number(item.id)}`,
    `Source: ${item.source ?? meta.source ?? ""} (${item.market ?? meta.market ?? ""}), language: ${meta.page_language ?? meta.source_language ?? "unknown"}`,
    `Published: ${item.published_at ? new Date(item.published_at as string).toISOString().slice(0, 10) : "unknown"}`,
    `Headline: ${item.title ?? ""}`,
    `URL: ${item.url}`,
    "",
    String(item.content ?? "").slice(0, 9000),
    "",
    "Links in the article:",
    links.length ? links.join("\n") : "(none)",
  ].join("\n");
  return { system, user };
}

// ---------- ingest crawler output ----------
async function ingest(body: Record<string, unknown>) {
  const items = (Array.isArray(body.items) ? body.items : []) as Record<string, unknown>[];
  let inserted = 0;
  for (const a of items) {
    const url = str(a.url, 2000);
    if (!url || !a.text) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.published_on)) ? String(a.published_on) : String(a.target_date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const raw = Date.parse(String(a.published_raw ?? ""));
    const publishedAt = Number.isFinite(raw) && new Date(raw).toISOString().slice(0, 10) === day ? new Date(raw).toISOString() : `${day}T00:00:00Z`;
    const [src] = await sql`select id from wgf.sources where lower(source) = lower(${String(a.source ?? "")}) order by (market = ${String(a.market ?? "")}) desc limit 1`;
    const meta = {
      source: a.source, market: a.market, region: a.region, source_language: a.source_language, page_language: a.page_language,
      found_via: a.found_via, google_url: a.google_url, date_basis: a.date_basis, date_unknown: a.date_unknown, target_date: a.target_date,
      outbound: Array.isArray(a.outbound_links) ? a.outbound_links.slice(0, 25) : [], socials: Array.isArray(a.social_links) ? a.social_links.slice(0, 30) : [],
    };
    const r = await sql`insert into wgf.raw_items (source_id, channel, url, title, content, published_at, day, week, meta)
                        values (${src?.id ?? null}, 'article', ${url}, ${str(a.headline, 500)}, ${String(a.text).slice(0, 12000)}, ${publishedAt},
                                ${day}::date, wgf.week_of(${publishedAt}::timestamptz), ${sql.json(meta)})
                        on conflict (url) do nothing returning id`;
    inserted += r.length;
  }
  return { received: items.length, inserted };
}

// ---------- company sites (crawler companies mode) ----------
async function companyTargets(body: Record<string, unknown>) {
  const days = Math.min(Number(body.days) || 3, 30);
  const rows = await sql`select distinct c.domain from wgf.companies c join wgf.rounds r on r.company_id = c.id
                         where c.domain is not null and c.site_checked_at is null and r.status = 'live'
                           and r.created_at > now() - make_interval(days => ${days})`;
  // Companies with no website yet: searched once on Google (Apify) to find it
  const missing = await sql`select distinct c.id, c.name, c.hq_country from wgf.companies c join wgf.rounds r on r.company_id = c.id
                            where c.domain is null and c.domain_checked_at is null and r.status = 'live'
                              and r.created_at > now() - make_interval(days => ${days}) limit 300`;
  return {
    domains: rows.map((r) => r.domain),
    need_domain: missing.map((m) => ({ id: Number(m.id), name: m.name, query: `${m.name} ${m.hq_country ?? ""} startup official website`.replace(/\s+/g, " ").trim() })),
  };
}

// Hosts that are never a company's own website
const NOT_OWN_SITE = /(^|\.)(linkedin|facebook|twitter|x|instagram|youtube|wikipedia|crunchbase|pitchbook|tracxn|dealroom|cbinsights|bloomberg|reuters|techcrunch|forbes|businesswire|prnewswire|globenewswire|medium|github|apple|google|play\.google|glassdoor|indeed|zoominfo|rocketreach|owler|craft|f6s|angel|wellfound|36kr|qcc|tianyancha|aiqicha|baike|zhihu|weibo|sina|sohu|163|qq|naver|daum|nikkei|prtimes|yahoo|msn|ycombinator|producthunt|g2|capterra|trustpilot|bbb|yelp|amazon|appadvice|similarweb|semrush|economictimes|inc42|yourstory|entrackr|vccircle|sifted|eu-startups|tech\.eu|finsmes|vcnewsnetwork|substack)\.[a-z.]+$/i;
const tokens = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
  .filter((t) => t.length > 2 && !["inc", "ltd", "llc", "the", "labs", "lab", "technologies", "technology", "tech", "group", "gmbh", "corp", "company", "co"].includes(t));

async function companyDomains(body: Record<string, unknown>) {
  const items = (Array.isArray(body.items) ? body.items : []) as { id: number; name: string; results: { url: string; title?: string }[] }[];
  let found = 0;
  for (const it of items) {
    const want = tokens(String(it.name ?? ""));
    let pick: string | null = null;
    for (const r of (it.results ?? []).slice(0, 6)) {
      const d = cleanDomain(r.url);
      if (!d || NOT_OWN_SITE.test(d)) continue;
      const label = d.split(".").slice(0, -1).join("").replace(/-/g, "");
      const compact = want.join("");
      // Accept the site when its name is the company name, give or take a short prefix or suffix (getx, xhq, xapp)
      const close = label === compact || ((label.startsWith(compact) || label.endsWith(compact)) && label.length - compact.length <= 6)
        || (compact.startsWith(label) && label.length >= 5 && compact.length - label.length <= 6);
      if (want.length && close) { pick = d; break; }
    }
    if (pick) {
      const [taken] = await sql`select id from wgf.companies where domain = ${pick} and id <> ${Number(it.id)}`;
      if (taken) pick = null;
    }
    await sql`update wgf.companies set domain = coalesce(domain, ${pick}), domain_checked_at = now() where id = ${Number(it.id)}`;
    if (pick) found++;
  }
  return { received: items.length, domains_found: found };
}

async function companySave(body: Record<string, unknown>) {
  const items = (Array.isArray(body.items) ? body.items : []) as Record<string, unknown>[];
  let updated = 0, people = 0;
  for (const s of items) {
    const domain = cleanDomain(s.domain);
    if (!domain) continue;
    const so = (s.company_socials ?? {}) as Record<string, string>;
    const [co] = await sql`update wgf.companies set
        linkedin_url = coalesce(linkedin_url, ${str(so.linkedin)}), x_url = coalesce(x_url, ${str(so.x)}),
        instagram_url = coalesce(instagram_url, ${str(so.instagram)}), youtube_url = coalesce(youtube_url, ${str(so.youtube)}),
        github_url = coalesce(github_url, ${str(so.github)}), facebook_url = coalesce(facebook_url, ${str(so.facebook)}),
        careers_url = coalesce(careers_url, ${str(s.careers_url)}),
        description = coalesce(description, ${str(s.site_description, 400)}),
        site_checked_at = now(), updated_at = now()
      where domain = ${domain} returning id`;
    if (!co) continue;
    updated++;
    // A LinkedIn profile on the company's own site is attached to a founder only when the link label contains their name
    const founders = await sql`select p.id, p.name from wgf.people p join wgf.company_people cp on cp.person_id = p.id
                               where cp.company_id = ${co.id} and p.linkedin_url is null`;
    for (const l of (Array.isArray(s.people_links) ? s.people_links : []) as { linkedin: string; label: string }[]) {
      const label = String(l.label ?? "").toLowerCase();
      const slug = String(l.linkedin ?? "").toLowerCase();
      const f = founders.find((p) => {
        const parts = String(p.name).toLowerCase().split(/\s+/).filter((x) => x.length > 1);
        return parts.length > 1 && parts.every((x) => label.includes(x) || slug.includes(x));
      });
      if (f) { await sql`update wgf.people set linkedin_url = ${l.linkedin}, verified_by = 'company_site' where id = ${f.id} and linkedin_url is null`; people++; }
    }
  }
  return { received: items.length, companies_updated: updated, founder_links: people };
}

// ---------- reply parsing ----------
function parseReply(text: string): { rounds: Record<string, unknown>[]; excluded: { id: number; reason: string }[] } {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON in reply");
  const obj = JSON.parse(text.slice(start, end + 1));
  if (obj.error && !obj.rounds && !obj.excluded) throw new Error(`extractor call failed: ${JSON.stringify(obj.error).slice(0, 300)}`);
  return { rounds: Array.isArray(obj.rounds) ? obj.rounds : [], excluded: Array.isArray(obj.excluded) ? obj.excluded : [] };
}

const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => str(typeof x === "string" ? x : (x as { name?: string })?.name, 200)).filter(Boolean) as string[])] : []);
const cleanDomain = (v: unknown) => {
  const s = str(v, 200);
  if (!s) return null;
  const d = s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
};

// ---------- save ----------
async function save(ids: number[], text: string) {
  const { rounds, excluded } = parseReply(text);
  const fx = await usdRates();
  const items = await sql`select id, url, title, published_at, channel from wgf.raw_items where id = any(${ids})`;
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const touched = new Set<number>();
  let created = 0, merged = 0;

  for (const r of rounds) {
    const itemIds = (Array.isArray(r.item_ids) ? r.item_ids : []).map(Number).filter((i) => byId.has(i));
    const company = str(r.company, 200);
    if (!itemIds.length || !company) continue;
    const native = str(r.company_native, 200);
    const domain = cleanDomain(r.domain);
    const country = str(r.hq_country, 80);
    const stage = STAGES.includes(String(r.stage)) ? String(r.stage) : "undisclosed";
    const sector = SECTORS.includes(String(r.sector)) ? String(r.sector) : "Other";
    const currency = str(r.currency, 3)?.toUpperCase() ?? null;
    const amount = num(r.amount);
    const amountUsd = num(r.amount_usd_stated) ?? (amount && currency && fx[currency] ? Math.round(amount / fx[currency]) : null);
    const firstPub = itemIds.map((i) => byId.get(i)!.published_at).filter(Boolean).sort()[0] ?? new Date().toISOString();
    const announced = /^\d{4}-\d{2}-\d{2}$/.test(String(r.announced_on)) ? String(r.announced_on) : String(new Date(firstPub).toISOString()).slice(0, 10);

    let status = UNNAMED_COMPANY.test(company) ? "unnamed"
      : Date.parse(announced) < Date.parse(String(new Date(firstPub).toISOString()).slice(0, 10)) - 30 * 864e5 ? "stale" : "live";

    // company: domain first, then name (+ country when both known)
    let [co] = domain ? await sql`select id from wgf.companies where domain = ${domain}` : [];
    if (!co) {
      [co] = await sql`select id from wgf.companies
                       where (name_key = wgf.name_key(${company}) or (${native}::text is not null and name_key = wgf.name_key(${native})))
                         and (hq_country is null or ${country}::text is null or hq_country = ${country})
                       order by updated_at desc limit 1`;
    }
    const cs = (r.company_socials ?? {}) as Record<string, unknown>;
    const socialUrl = (v: unknown, host: RegExp) => { const u = str(v, 300); return u && host.test(u) ? u.split("?")[0] : null; };
    const coLinkedin = socialUrl(cs.linkedin, /^https?:\/\/([a-z]+\.)?linkedin\.com\/company\//i);
    const coX = socialUrl(cs.x, /^https?:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i);
    let repeat = false;
    if (co) {
      await sql`update wgf.companies set linkedin_url = coalesce(linkedin_url, ${coLinkedin}), x_url = coalesce(x_url, ${coX}) where id = ${co.id}`;
      // An old round of about the same size coming back as news is a resurfaced story
      if (amountUsd) {
        const [old] = await sql`select 1 from wgf.rounds where company_id = ${co.id} and amount_usd between ${amountUsd * 0.9} and ${amountUsd * 1.1}
                                 and coalesce(announced_on, created_at::date) < ${announced}::date - 30 limit 1`;
        repeat = Boolean(old);
      }
      // Replace an original-script company name with the English one when it arrives
      if (!NON_LATIN.test(company)) {
        const [cur] = await sql`select name from wgf.companies where id = ${co.id}`;
        if (cur && NON_LATIN.test(cur.name) && !/[A-Za-z]/.test(cur.name)) {
          await sql`update wgf.companies set name = ${company}, name_en = ${company}, name_native = coalesce(name_native, ${cur.name}) where id = ${co.id}`;
        }
      }
      await sql`update wgf.companies set
                  domain = coalesce(domain, ${domain}), name_native = coalesce(name_native, ${native}),
                  hq_city = coalesce(hq_city, ${str(r.hq_city, 100)}), hq_country = coalesce(hq_country, ${country}),
                  sector = coalesce(sector, ${sector}), description = coalesce(description, ${str(r.description)}),
                  updated_at = now()
                where id = ${co.id}`;
    } else {
      [co] = await sql`insert into wgf.companies (name, name_en, name_native, name_key, domain, description, hq_city, hq_country, sector, linkedin_url, x_url)
                       values (${company}, ${company}, ${native}, wgf.name_key(${company}), ${domain}, ${str(r.description)},
                               ${str(r.hq_city, 100)}, ${country}, ${sector}, ${coLinkedin}, ${coX})
                       returning id`;
    }

    if (repeat && status === "live") status = "stale";
    // round: same company, compatible stage, within 14 days
    let [rd] = await sql`select id from wgf.rounds
                         where company_id = ${co.id}
                           and (stage = ${stage} or stage = 'undisclosed' or ${stage} = 'undisclosed')
                           and abs(coalesce(announced_on, created_at::date) - ${announced}::date) <= 14
                         order by created_at desc limit 1`;
    if (rd) {
      merged++;
      await sql`update wgf.rounds set
                  stage = case when stage = 'undisclosed' then ${stage} else stage end,
                  amount = coalesce(amount, ${amount}), currency = coalesce(currency, ${currency}),
                  amount_usd = coalesce(amount_usd, ${amountUsd}), amount_text = coalesce(amount_text, ${str(r.amount_text, 120)}),
                  highlight = coalesce(highlight, ${str(r.highlight ?? r.unique)}), summary = coalesce(summary, ${str(r.summary, 1200)}),
                  announced_on = least(announced_on, ${announced}::date), updated_at = now()
                where id = ${rd.id}`;
    } else {
      created++;
      [rd] = await sql`insert into wgf.rounds (company_id, stage, amount, currency, amount_usd, amount_text, announced_on, week,
                                               confidence, highlight, summary, headline, edition, status)
                       values (${co.id}, ${stage}, ${amount}, ${currency}, ${amountUsd}, ${str(r.amount_text, 120)}, ${announced},
                               wgf.week_of(${announced}::date), 'reported', ${str(r.highlight ?? r.unique)}, ${str(r.summary, 1200)}, ${byId.get(itemIds[0])!.title},
                               least(wgf.next_edition(now()), (${firstPub}::timestamptz at time zone 'Australia/Sydney')::date + 1), ${status})
                       returning id`;
    }

    // investors
    const real = (v: unknown) => names(v).filter((n) => !GENERIC_INVESTOR.test(n));
    // "Dragoneer" and "Dragoneer Investment Group" in one list: keep the longer name only
    const dedupe = (list: string[]) => list.filter((n) => !list.some((m) => m.length > n.length && m.toLowerCase().startsWith(n.toLowerCase() + " ")));
    const leads = dedupe(real(r.lead_investors)), others = dedupe(real(r.investors)).filter((n) => !leads.some((l) => l === n || l.toLowerCase().startsWith(n.toLowerCase() + " ") || n.toLowerCase().startsWith(l.toLowerCase() + " ")));
    for (const [list, isLead] of [[leads, true], [others, false]] as const) {
      for (const name of list) {
        const [inv] = await sql`insert into wgf.investors (name, name_key) values (${name}, wgf.name_key(${name}))
                                on conflict (name_key) do update set name = wgf.investors.name returning id`;
        await sql`insert into wgf.round_investors (round_id, investor_id, is_lead) values (${rd.id}, ${inv.id}, ${isLead})
                  on conflict (round_id, investor_id) do update set is_lead = wgf.round_investors.is_lead or excluded.is_lead`;
      }
    }

    // founders named in the text
    for (const f of Array.isArray(r.founders) ? r.founders as Record<string, unknown>[] : []) {
      const name = str(f?.name, 120);
      if (!name) continue;
      let [p] = await sql`select p.id from wgf.people p join wgf.company_people cp on cp.person_id = p.id
                          where cp.company_id = ${co.id} and p.name_key = wgf.name_key(${name}) limit 1`;
      if (!p) [p] = await sql`insert into wgf.people (name, name_key) values (${name}, wgf.name_key(${name})) returning id`;
      await sql`insert into wgf.company_people (company_id, person_id, role) values (${co.id}, ${p.id}, ${str(f?.role, 60) ?? "founder"})
                on conflict do nothing`;
      const li = socialUrl(f?.linkedin, /^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i), x = socialUrl(f?.x, /^https?:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i);
      if (li || x) await sql`update wgf.people set linkedin_url = coalesce(linkedin_url, ${li}), x_url = coalesce(x_url, ${x}),
                                verified_by = coalesce(verified_by, 'article') where id = ${p.id}`;
    }

    // full profile for audit (article extraction only)
    if (itemIds.some((i) => byId.get(i)!.channel === "article")) {
      await sql`insert into wgf.round_profiles (round_id, profile, verdict, method)
                values (${rd.id}, ${sql.json({ ...r, source_urls: itemIds.map((i) => byId.get(i)!.url) })}, ${status === "live" ? "valid_recent" : status}, 'pipeline')
                on conflict (round_id) do update set profile = wgf.round_profiles.profile || jsonb_build_object('also', excluded.profile)`;
    }

    // sources
    for (const i of itemIds) {
      const it = byId.get(i)!;
      await sql`insert into wgf.round_sources (round_id, raw_item_id, url, published_at) values (${rd.id}, ${i}, ${it.url}, ${it.published_at})
                on conflict do nothing`;
      await sql`update wgf.raw_items set status = 'extracted', round_id = ${rd.id}, extracted_at = now() where id = ${i}`;
      touched.add(i);
    }
    await sql`update wgf.rounds set source_count = (select count(*) from wgf.round_sources where round_id = ${rd.id}) where id = ${rd.id}`;
  }

  for (const e of excluded) {
    const id = Number(e?.id);
    if (!byId.has(id) || touched.has(id)) continue;
    const reason = EXCLUDE_REASONS.includes(String(e.reason)) ? String(e.reason) : "other";
    await sql`update wgf.raw_items set status = 'excluded', exclusion_reason = ${reason}, extracted_at = now() where id = ${id} and status = 'pending'`;
    touched.add(id);
  }
  const missing = ids.filter((i) => !touched.has(i));
  if (missing.length) {
    await sql`update wgf.raw_items set status = 'error', exclusion_reason = 'not_returned_by_extractor', extracted_at = now()
              where id = any(${missing}) and status = 'pending'`;
  }
  return { items: ids.length, rounds_created: created, rounds_merged: merged, excluded: excluded.length, not_returned: missing.length };
}

// ---------- plan ----------
async function plan(body: Record<string, unknown>) {
  // channel "article": full crawler articles, one per chunk. Otherwise headline items from the older collector.
  const articles = body.channel === "article";
  if (articles) body.size = 1;
  const pending = articles
    ? await sql`select id, title, content from wgf.raw_items where status = 'pending' and channel = 'article' order by published_at nulls last, id`
    : await sql`select id, title, content from wgf.raw_items where status = 'pending' and channel <> 'article' order by published_at nulls last, id`;
  const drop: number[] = [], keep: number[] = [];
  for (const p of pending) (FUNDING_RE.test(`${p.title ?? ""} ${String(p.content ?? "").slice(0, 600)}`) ? keep : drop).push(Number(p.id));
  for (let k = 0; k < drop.length; k += 1000) {
    await sql`update wgf.raw_items set status = 'excluded', exclusion_reason = 'no_funding_keywords', extracted_at = now()
              where id = any(${drop.slice(k, k + 1000)})`;
  }
  const size = Number(body.size) || 40, maxChunks = Number(body.max_chunks) || 500;
  const chunks: number[][] = [];
  for (let k = 0; k < keep.length && chunks.length < maxChunks; k += size) chunks.push(keep.slice(k, k + size));
  return { pending: pending.length, keyword_excluded: drop.length, to_extract: keep.length, chunks: chunks.map((ids) => ({ ids })) };
}

async function prompt(ids: number[]) {
  const items = await sql`select r.id, r.url, r.title, r.content, r.published_at, r.channel, r.meta, s.source, s.market
                          from wgf.raw_items r left join wgf.sources s on s.id = r.source_id
                          where r.id = any(${ids}) and r.status = 'pending' order by r.id`;
  if (items.length === 1 && items[0].channel === "article") return { ids: [Number(items[0].id)], ...buildArticlePrompt(items[0]) };
  return { ids: items.map((i) => Number(i.id)), ...buildPrompt(items) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
    if (body.mode === "plan") return json(await plan(body));
    if (body.mode === "prompt") return json(await prompt(ids));
    if (body.mode === "save") return json(await save(ids, String(body.text ?? "")));
    if (body.mode === "ingest") return json(await ingest(body));
    if (body.mode === "company_targets") return json(await companyTargets(body));
    if (body.mode === "company_save") return json(await companySave(body));
    if (body.mode === "company_domains") return json(await companyDomains(body));
    return json({ error: "mode must be plan, prompt, save, ingest, company_targets, company_domains or company_save" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
