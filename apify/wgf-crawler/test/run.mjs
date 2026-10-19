// Offline checks for the parsers (no network)
import assert from "node:assert/strict";
import { parseFeed, parseArticle, listingLinks, parseCompanySite, urlDate } from "../src/text.js";
import { isFundingHeadline } from "../src/funding.js";

let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("rss + google news source", () => {
  const xml = `<rss><channel><item><title>Acme raises $12M Series A - TechCrunch</title><link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
  <pubDate>Sat, 18 Oct 2026 03:10:00 GMT</pubDate><description>&lt;a href="x"&gt;Acme&lt;/a&gt;</description><source url="https://techcrunch.com">TechCrunch</source></item></channel></rss>`;
  const [it] = parseFeed(xml);
  assert.equal(it.title, "Acme raises $12M Series A - TechCrunch");
  assert.equal(it.source_name, "TechCrunch");
  assert.equal(it.published_at, "2026-10-18T03:10:00.000Z");
});

t("atom", () => {
  const [it] = parseFeed(`<feed><entry><title>X lève 5 M€</title><link href="https://ex.fr/a"/><published>2026-10-18T09:00:00+02:00</published></entry></feed>`);
  assert.equal(it.link, "https://ex.fr/a");
});

t("article metadata date keeps publisher day", () => {
  const html = `<html lang="ja"><head><meta property="og:title" content="株式会社テスト、10億円の資金調達">
  <meta property="article:published_time" content="2026-10-18T08:30:00+09:00"><link rel="canonical" href="https://ex.jp/n/1"></head>
  <body><nav>menu</nav><article><p>${"株式会社テストはシリーズBラウンドで10億円を調達しました。".repeat(20)}</p>
  <p>Visit <a href="https://www.test-co.jp/">test-co</a> or <a href="https://www.linkedin.com/company/test-co?x=1">LinkedIn</a> and <a href="https://twitter.com/share">share</a></p></article></body></html>`;
  const a = parseArticle(html, "https://ex.jp/n/1");
  assert.equal(a.published_on, "2026-10-18");
  assert.equal(a.date_basis, "page_metadata");
  assert.equal(a.lang, "ja");
  assert.deepEqual(a.outbound.map((o) => o.domain), ["test-co.jp"]);
  assert.ok(a.socials.includes("https://www.linkedin.com/company/test-co"));
});

t("json-ld date and url date", () => {
  const a = parseArticle(`<script type="application/ld+json">{"datePublished":"2026-10-17T22:00:00Z"}</script><p>${"x".repeat(40)}</p>`, "https://e.com/a");
  assert.equal(a.published_on, "2026-10-17");
  assert.equal(urlDate("https://e.com/2026/10/18/acme-raises"), "2026-10-18");
  assert.equal(urlDate("https://36kr.com/p/20261018123456"), "2026-10-18");
  assert.equal(urlDate("https://e.com/about"), null);
});

t("listing links", () => {
  const html = `<a href="/news/acme-raises-12m-series-a-led-by-sequoia">Acme raises $12M Series A led by Sequoia</a><a href="/about">About us page link</a><a href="https://other.com/x-y-z-w">Other site story here</a>`;
  const l = listingLinks(html, "https://www.site.com/funding/");
  assert.equal(l.length, 1);
  assert.equal(l[0].url, "https://www.site.com/news/acme-raises-12m-series-a-led-by-sequoia");
});

t("company site", () => {
  const html = `<meta property="og:description" content="Acme builds robots"><a href="https://www.linkedin.com/company/acme/">in</a><a href="https://x.com/acmehq">x</a>
  <a href="https://twitter.com/intent/tweet">t</a><a href="/about-us">about</a><a href="/team">Team</a><a href="https://jobs.lever.co/acme">Jobs</a>
  <a href="https://www.linkedin.com/in/jane-doe/">Jane Doe, CEO</a><a href="https://www.youtube.com/watch?v=1">v</a><a href="https://www.youtube.com/@acme">yt</a>`;
  const s = parseCompanySite(html, "https://acme.com/");
  assert.equal(s.socials.linkedin, "https://www.linkedin.com/company/acme");
  assert.equal(s.socials.x, "https://x.com/acmehq");
  assert.equal(s.people[0].linkedin, "https://www.linkedin.com/in/jane-doe");
  assert.deepEqual(s.about_pages, ["https://acme.com/team"]);
  assert.equal(s.careers_url, "https://jobs.lever.co/acme");
  assert.equal(s.socials.youtube, "https://www.youtube.com/@acme");
});

t("funding headline filter", () => {
  for (const h of ["Acme raises $12M Series A", "某某科技完成数亿元B轮融资", "テスト社、10億円の資金調達", "토스, 500억원 투자 유치", "Startup lève 5 millions d'euros", "Acme raises $5M and acquires Beta"])
    assert.ok(isFundingHeadline(h), h);
  for (const h of ["Acme files to go public in IPO", "Big Co acquires Small Co", "Weather today"])
    assert.ok(!isFundingHeadline(h), h);
});

console.log(`${n} checks passed`);
