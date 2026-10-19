// What Got Funded — daily crawler (Apify Actor, no dependencies).
//
// mode "articles" (default, 9pm Sydney): read every mapped source, keep funding headlines, fetch each article
//   and output one dataset item per article with full text, publish date, outbound links and social links.
//   targetDate defaults to the previous UTC day, so a 9pm Sydney run (10:00 UTC) collects the day that just
//   ended worldwide. Articles published on the target day or the day after (late local coverage) are kept.
// mode "companies" (after extraction): for each company domain, read the homepage and about/team pages and output
//   company social profiles, people profile links and the careers page.
//
// Every dataset can be exported as CSV or JSON from the Apify console or API.
import { getInput, pushData, setValue, flushLocal, log } from "./platform.js";
import { get, allowed, pool, sleep } from "./http.js";
import { parseFeed, parseArticle, listingLinks, parseCompanySite, urlDate, toIso } from "./text.js";
import { resolveGoogleNews } from "./gnews.js";
import { isFundingHeadline } from "./funding.js";

const DEFAULT_REPO = "https://raw.githubusercontent.com/HackrLife/What-Got-Funded/main/sources";
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
async function loadCsv(repo, name) {
  const r = await get(`${repo}/${name}`, { accept: "text/csv,text/plain" });
  if (!r.ok) throw new Error(`could not load ${name}: ${r.status}`);
  return parseCsv(r.text);
}

// Simple per-host limiter so no single site gets more than `perHost` requests at a time
const hostSlots = new Map();
async function politely(url, fn, perHost = 2) {
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  while ((hostSlots.get(host) || 0) >= perHost) await sleep(150);
  hostSlots.set(host, (hostSlots.get(host) || 0) + 1);
  try { return await fn(); } finally { hostSlots.set(host, hostSlots.get(host) - 1); }
}

// ---------- mode: articles ----------
async function crawlArticles(input) {
  const target = input.targetDate || addDays(new Date().toISOString().slice(0, 10), -1);
  const keepDays = new Set([target, addDays(target, 1)]);
  const windowStart = Date.parse(addDays(target, -1) + "T10:00:00Z");   // UTC+14 start of the target day, minus slack
  const repo = input.sourcesRepo || DEFAULT_REPO;
  const concurrency = input.concurrency || 12;
  const maxArticles = input.maxArticles || 2000;
  log(`target day ${target}`);

  const feeds = (await loadCsv(repo, "n8n-feeds.csv")).filter((f) => f.feed_url && f.feed_status !== "broken");
  const pages = (await loadCsv(repo, "scraped-pages.csv")).filter((p) => p.page_url && p.test_result !== "broken");
  log(`${feeds.length} feeds, ${pages.length} pages`);

  const health = [];
  const candidates = new Map();   // url -> candidate
  const addCandidate = (c) => { const k = c.url.split("#")[0]; if (!candidates.has(k)) candidates.set(k, c); };

  // 1. feeds (site RSS and Google News searches)
  await pool(feeds, concurrency, async (f) => {
    const r = await politely(f.feed_url, () => get(f.feed_url, { accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" }));
    if (!r.ok) { health.push({ source: f.source, kind: "feed", url: f.feed_url, ok: false, error: r.error || `HTTP ${r.status}` }); return; }
    const items = parseFeed(r.text);
    let kept = 0;
    for (const it of items) {
      const t = it.published_at ? Date.parse(it.published_at) : NaN;
      if (Number.isFinite(t) && t < windowStart) continue;           // older than the target day everywhere
      if (!isFundingHeadline(`${it.title} ${it.summary}`)) continue;
      const google = /news\.google\.com/.test(it.link);
      addCandidate({ url: it.link, title: it.title, feed_date: it.published_at, summary: it.summary, source: google ? (it.source_name || f.source) : f.source,
        found_via: google ? "google_news" : "rss", market: f.market, region: f.region, source_language: f.language, google_query: google ? f.source : null });
      kept++;
    }
    health.push({ source: f.source, kind: "feed", url: f.feed_url, ok: true, items: items.length, kept });
  });

  // 2. listing pages (funding sections and homepages without feeds)
  await pool(pages, concurrency, async (p) => {
    if (!(await allowed(p.page_url))) { health.push({ source: p.source, kind: "page", url: p.page_url, ok: false, error: "robots.txt disallows" }); return; }
    const r = await politely(p.page_url, () => get(p.page_url, { browserUa: true }));
    if (!r.ok) { health.push({ source: p.source, kind: "page", url: p.page_url, ok: false, error: r.error || `HTTP ${r.status}` }); return; }
    const links = listingLinks(r.text, r.url || p.page_url);
    let kept = 0;
    for (const l of links) {
      if (p.filter !== "none" && !isFundingHeadline(l.title)) continue;
      const d = urlDate(l.url);
      if (d && d < addDays(target, -1)) continue;                     // URL says it is older than the target day
      addCandidate({ url: l.url, title: l.title, feed_date: null, summary: "", source: p.source, found_via: "page", filtered: p.filter !== "none", market: p.market, region: null, source_language: null });
      if (++kept >= 60) break;
    }
    health.push({ source: p.source, kind: "page", url: p.page_url, ok: true, items: links.length, kept });
  });

  let list = [...candidates.values()].slice(0, maxArticles);
  log(`${list.length} funding candidates`);

  // 3. resolve Google News links to the publisher's article
  await pool(list.filter((c) => c.found_via === "google_news"), 6, async (c) => {
    const real = await resolveGoogleNews(c.url);
    if (real) { c.google_url = c.url; c.url = real; } else c.unresolved = true;
    await sleep(250);
  });
  log(`Google News links resolved; ${list.filter((c) => c.unresolved).length} could not be resolved`);
  const seen = new Set();
  list = list.filter((c) => !c.unresolved && !seen.has(c.url) && seen.add(c.url));

  // 4. fetch and parse each article
  let saved = 0, skippedDate = 0, failed = 0, blocked = 0, notFunding = 0;
  await pool(list, concurrency, async (c) => {
    if (!(await allowed(c.url))) { blocked++; return; }
    const r = await politely(c.url, () => get(c.url, { browserUa: true }));
    if (!r.ok || !/html/i.test(r.type)) { failed++; return; }
    const a = parseArticle(r.text, r.url || c.url);
    // The article's own date decides. Feed dates are only used when the page has none (not for Google News, which re-surfaces old articles).
    const published_on = a.published_on || (c.found_via === "rss" && c.feed_date ? c.feed_date.slice(0, 10) : null);
    const date_basis = a.published_on ? a.date_basis : published_on ? "feed" : null;
    if (published_on && !keepDays.has(published_on)) { skippedDate++; return; }
    // Unfiltered pages (homepages, general sections): keep only articles whose headline or opening reads as a raise
    if (c.found_via === "page" && !c.filtered && !isFundingHeadline(`${a.title || c.title} ${a.text.slice(0, 400)}`)) { notFunding++; return; }
    await pushData({
      target_date: target,
      url: a.canonical && /^https?:/.test(a.canonical) ? a.canonical : r.url || c.url,
      google_url: c.google_url || null,
      source: c.source, found_via: c.found_via, market: c.market, region: c.region,
      source_language: c.source_language, page_language: a.lang || null,
      headline: a.title || c.title,
      published_on, published_raw: a.published_raw, date_basis, date_unknown: !published_on,
      text: a.text,
      outbound_links: a.outbound,
      social_links: a.socials,
      fetched_at: new Date().toISOString(),
    });
    if (++saved % 50 === 0) log(`${saved} articles saved`);
  });

  const summary = { target_date: target, feeds: feeds.length, pages: pages.length, candidates: candidates.size, articles_saved: saved, skipped_other_dates: skippedDate, skipped_not_funding: notFunding, fetch_failed: failed, robots_blocked: blocked };
  log(JSON.stringify(summary));
  await setValue("SUMMARY", summary);
  await setValue("SOURCE_HEALTH", health);
}

// ---------- mode: companies ----------
async function crawlCompanies(input) {
  const domains = [...new Set((input.domains || []).map((d) => String(d).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]).filter(Boolean))];
  log(`${domains.length} company sites`);
  await pool(domains, input.concurrency || 10, async (domain) => {
    let home = null;
    for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
      if (!(await allowed(u))) continue;
      const r = await get(u, { browserUa: true, timeoutMs: 15000 });
      if (r.ok && /html/i.test(r.type)) { home = { r, u }; break; }
    }
    if (!home) { await pushData({ domain, ok: false }); return; }
    const site = parseCompanySite(home.r.text, home.r.url || home.u);
    const people = [...site.people];
    for (const p of site.about_pages.slice(0, 2)) {
      if (!(await allowed(p))) continue;
      const r = await get(p, { browserUa: true, timeoutMs: 15000 });
      if (r.ok) { const s = parseCompanySite(r.text, p); people.push(...s.people); for (const [k, v] of Object.entries(s.socials)) site.socials[k] ??= v; site.careers_url ??= s.careers_url; }
    }
    const uniq = [...new Map(people.map((p) => [p.linkedin, p])).values()];
    await pushData({ domain, ok: true, final_url: home.r.url, site_title: site.title, site_description: site.description,
      company_socials: site.socials, people_links: uniq.slice(0, 20), careers_url: site.careers_url, fetched_at: new Date().toISOString() });
  });
}

const input = await getInput();
const t0 = Date.now();
if ((input.mode || "articles") === "companies") await crawlCompanies(input); else await crawlArticles(input);
await flushLocal();
log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
