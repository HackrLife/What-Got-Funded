// What Got Funded — static site build. No dependencies: `node build.mjs` writes the whole site to dist/.
//
// Data: the wgf-publish function (live rounds only), using WGF_READ_TOKEN. Without the token the build
// falls back to data/snapshot.json for local previews, and fails if neither is available.
// "Today" is the Sydney calendar date. Days before today are published; today's rounds wait for tomorrow.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONTINENTS, continentOf, countryLabel } from "./src/regions.mjs";
import { editionModel, articleBody, editionCard, cleanFounders, cleanInvestors } from "./src/edition.mjs";
import { startupList, regionTiles, rankBars, chartCard, stackBars, byRegion, roundsCsv, firstSource as firstSourceOf } from "./src/units.mjs";
// Daily editions start with the 18 October 2026 issue. Headline overrides: data/editions.json { "YYYY-MM-DD": { "headline": "...", "dek": "..." } }
const EDITION_START = "2026-10-19";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "dist");
const SITE_URL = (process.env.SITE_URL || "https://whatgotfunded.com").replace(/\/$/, "");
const PUBLISH_URL = process.env.WGF_PUBLISH_URL || "https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-publish?days=150";
const BEEHIIV_FORM = process.env.BEEHIIV_FORM_ID || "25f5c9ba-9712-405b-8319-832a0415e181";
let SOURCES_LINE = "more than 300 news sources and local-language news searches";   // set from the source registry in main()

// ---------- data ----------
async function loadData() {
  if (process.env.WGF_LOCAL_DATA) return JSON.parse(fs.readFileSync(process.env.WGF_LOCAL_DATA, "utf8"));   // local previews
  const token = process.env.WGF_READ_TOKEN;
  if (token) {
    const res = await fetch(PUBLISH_URL, { headers: { "x-wgf-read-token": token } });
    if (!res.ok) throw new Error(`wgf-publish returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  const snap = path.join(ROOT, "data", "snapshot.json");
  if (fs.existsSync(snap)) {
    console.warn("WGF_READ_TOKEN not set: building from data/snapshot.json");
    return JSON.parse(fs.readFileSync(snap, "utf8"));
  }
  throw new Error("No data: set WGF_READ_TOKEN or add data/snapshot.json");
}

const sydneyDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(d);
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- formatting ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function usd(v) {
  if (v == null || !isFinite(v)) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
function compact(v) {
  if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return String(v);
}
const longDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(",", "");
const shortDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const dayMonth = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
const STAGE = { pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C", series_d: "Series D",
  series_e: "Series E", series_f_plus: "Series F+", growth: "Growth", strategic: "Strategic", undisclosed: "Not stated" };
const STAGE_ORDER = Object.keys(STAGE);
const contOf = (k) => CONTINENTS.find((c) => c.k === k);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
function slugify(s) {
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function sourceName(s) {
  if (s.source && !/google news/i.test(s.source)) return s.source;
  const m = /\s[-–|]\s([^-–|]{2,60})$/.exec(s.title || "");
  return m ? m[1].trim() : (s.source || hostOf(s.url));
}
function sourceTitle(s) { return (s.title || "").replace(/\s[-–|]\s[^-–|]{2,60}$/, "").trim() || s.url; }

function amountCell(r) {
  if (r.amount_usd) {
    const local = r.currency && r.currency !== "USD" ? (r.amount_text && r.amount_text.length <= 24 ? r.amount_text : `${r.currency} ${compact(r.amount)}`) : "";
    return `${usd(r.amount_usd)}${local ? `<small>${esc(local)}</small>` : ""}`;
  }
  return `<span class="na">Not disclosed</span>${r.amount_text && r.amount_text.length <= 40 ? `<small>${esc(r.amount_text)}</small>` : ""}`;
}

// ---------- page shell ----------
let CSS_HREF = "/assets/styles.css", JS_SRC = "/assets/app.js";
function shell({ title, desc, active = "", body, canonical, scripts = "" }) {
  const nav = [["/", "Today"], ["/editions/", "Editions"], ["/analysis/", "Analysis"], ["/investors/", "Investors"], ["/jobs/", "Jobs"], ["/about/", "About"]]
    .map(([h, t]) => `<a href="${h}"${active === t ? ' class="on" aria-current="page"' : ""}>${t}</a>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE_URL}${canonical}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE_URL}${canonical}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap">
<link rel="stylesheet" href="${CSS_HREF}">
</head><body>
<header class="top">
  <a class="brand" href="/"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>What Got Funded</a>
  <nav class="nav" aria-label="Main">${nav}</nav>
  <span class="spacer"></span>
  <a class="btn" href="/subscribe/">Subscribe free</a>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div><b>What Got Funded</b><p>Daily startup funding intelligence from public sources. Every round links to where it was reported.</p></div>
  <div><b>Read</b><a href="/">Today</a><a href="/editions/">Daily editions</a><a href="/analysis/">Analysis</a><a href="/investors/">Investors</a><a href="/jobs/">Jobs</a></div>
  <div><b>About</b><a href="/about/">About us and our sources</a><a href="/methodology/">Methodology</a><a href="/subscribe/">Subscribe</a><a href="mailto:dev@hackrlife.com?subject=Correction%20for%20What%20Got%20Funded">Request a correction</a></div>
</footer>
<script src="${JS_SRC}" defer></script>${scripts}
</body></html>`;
}

const subscribeForm = (cls = "bh") =>
  `<iframe src="https://subscribe-forms.beehiiv.com/${BEEHIIV_FORM}" class="${cls}" data-test-id="beehiiv-embed" frameborder="0" scrolling="no" title="Subscribe to What Got Funded by email"></iframe>`;
const BEEHIIV_SCRIPT = `\n<script async src="https://subscribe-forms.beehiiv.com/embed.js"></script>`;
const joinBand = () => `<section class="join" aria-labelledby="join-h">
  <div><h2 id="join-h">What got funded, in your inbox at 7am.</h2><p>Every round from the day before, the investors behind them, and where each one was reported. Free, every day.</p></div>
  <div>${subscribeForm()}<small>Sydney time. One email a day, unsubscribe in one click.</small></div>
</section>`;

// ---------- shared pieces ----------
function links(r) {
  const out = [];
  if (r.domain) out.push(`<a href="https://${esc(r.domain)}" rel="noopener" target="_blank" title="Website">web</a>`);
  if (r.linkedin_url) out.push(`<a href="${esc(r.linkedin_url)}" rel="noopener" target="_blank" title="LinkedIn">in</a>`);
  if (r.x_url) out.push(`<a href="${esc(r.x_url)}" rel="noopener" target="_blank" title="X">X</a>`);
  if (r.sources[0]) out.push(`<a href="${esc(r.sources[0].url)}" rel="noopener" target="_blank" title="${esc(sourceName(r.sources[0]))}">src</a>`);
  return `<div class="lk">${out.join("")}</div>`;
}
const whyOf = (r) => r.highlight || r.description || "";
const invLine = (r) => (r.leads.length ? r.leads.join(", ") : r.investors.slice(0, 3).join(", ")) || "";
const placeLine = (r) => [r.hq_city, r.country].filter(Boolean).join(", ");

function roundsTable(rows, { filters = false } = {}) {
  if (!rows.length) return `<p class="empty">No rounds.</p>`;
  const tr = rows.map((r) => {
    const attrs = filters ? ` data-c="${r.cont}" data-country="${esc(r.country || "")}" data-stage="${r.stage}" data-sector="${esc(r.sector || "Other")}" data-usd="${r.amount_usd || 0}" data-inv="${esc([...r.leads, ...r.investors].join(" | ").toLowerCase())}" data-name="${esc(r.company.toLowerCase())}"` : "";
    return `<tr${attrs}>
<td><a class="co" href="${r.href}">${esc(r.company)}</a>${r.company_native && r.company_native !== r.company ? `<div class="nat">${esc(r.company_native)}</div>` : ""}${r.domain ? `<div class="dom">${esc(r.domain)}</div>` : ""}</td>
<td class="where"><span class="dot c-${r.cont}"></span>${esc(r.country || "Not stated")}</td>
<td class="hide-s">${esc(r.sector || "Other")}</td>
<td class="hide-s">${STAGE[r.stage] || "Not stated"}</td>
<td class="r amt">${amountCell(r)}</td>
<td class="invc hide-s">${esc(invLine(r)) || '<span class="na">Not stated</span>'}</td>
<td class="why hide-s">${esc(whyOf(r))}</td>
<td class="hide-s">${links(r)}</td></tr>`;
  }).join("\n");
  return `<div class="tw"><table class="rounds"><thead><tr><th>Company</th><th>Where</th><th class="hide-s">Industry</th><th class="hide-s">Stage</th><th class="r">Amount</th><th class="hide-s">Lead investor</th><th class="hide-s">What makes it different</th><th class="hide-s">Links</th></tr></thead><tbody>${tr}</tbody></table></div>`;
}

function byContinent(rows) {
  return CONTINENTS.map((c) => {
    const rs = rows.filter((r) => r.cont === c.k);
    return { ...c, n: rs.length, v: sum(rs.map((r) => r.amount_usd || 0)), rows: rs };
  }).filter((c) => c.n);
}

function treemapData(rows) {
  return byContinent(rows).filter((c) => c.v > 0).map((c) => {
    const kids = new Map();
    for (const r of c.rows) {
      const k = r.country || "Country not stated";
      const e = kids.get(k) || { name: k, v: 0, n: 0 };
      e.v += r.amount_usd || 0; e.n++; kids.set(k, e);
    }
    return { k: c.k, name: c.name, c: c.color, dark: !!c.dark, kids: [...kids.values()].filter((x) => x.v > 0) };
  });
}

// ---------- pages ----------
const ICON_DL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 17v3h16v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function topCountries(rows, n = 8) {
  const m = new Map();
  for (const r of rows) { const k = r.country || "Not stated"; const e = m.get(k) || { label: k, v: 0, n: 0, color: contOf(r.cont).color, dot: true }; e.v += r.amount_usd || 0; e.n++; m.set(k, e); }
  return [...m.values()].sort((a, b) => b.v - a.v || b.n - a.n).slice(0, n);
}
function dayView(day, rows, { when, edition = false }) {
  const disclosed = rows.filter((r) => r.amount_usd), total = sum(disclosed.map((r) => r.amount_usd));
  const csv = `/data/${day}.csv`;
  return `<div class="wrap">
<section class="hero2">
  <p class="kick">${edition ? "Daily edition · " : ""}${esc(longDate(day))}</p>
  <h1>Every startup that raised money ${esc(when)}, in one place.</h1>
  <p class="lede">Found across ${SOURCES_LINE}, and checked against the first public report of each round.</p>
  <div class="acts">${edition ? `<a class="btn2 dark" href="/editions/${day}/">Read the full edition</a>` : ""}<a class="btn2" href="${csv}" download>${ICON_DL}Download the day as CSV</a></div>
  <div class="stats"><div><span class="sv">${usd(total) || "Undisclosed"}</span><span class="sl">raised</span></div><div><span class="sv">${rows.length}</span><span class="sl">${rows.length === 1 ? "startup" : "startups"}</span></div><div><span class="sv">${disclosed.length}/${rows.length}</span><span class="sl">disclosed an amount</span></div></div>
</section>
<section class="block"><h2>Where the money went</h2>${regionTiles(rows)}</section>
<section class="block"><h2>Top countries</h2>${rankBars(topCountries(rows))}</section>
${startupList(rows, { csv, day })}
</div>`;
}

function homePage(day, rows, prev, next, isYesterday, hasEdition = false) {
  const total = sum(rows.map((r) => r.amount_usd || 0));
  const body = dayView(day, rows, { when: isYesterday ? "yesterday" : `on ${weekday(day)} ${dayMonth(day)}`, edition: hasEdition }) + joinBand();
  return shell({ title: `What Got Funded: ${plural(rows.length, "startup")} raised ${usd(total) || ""} on ${dayMonth(day)}`, desc: `Every startup funding round announced on ${longDate(day)}, across all markets, with founders, investors and sources.`, active: "Today", body, canonical: "/", scripts: BEEHIIV_SCRIPT });
}

function dayPage(day, rows, prev, next, hasEdition = false) {
  const total = sum(rows.map((r) => r.amount_usd || 0));
  const nav = `<div class="wrap"><nav class="daynav2">${prev ? `<a href="/day/${prev}/">Previous day</a>` : "<span></span>"}${next ? `<a href="/day/${next}/">Next day</a>` : "<span></span>"}</nav></div>`;
  const body = dayView(day, rows, { when: `on ${weekday(day)} ${dayMonth(day)}`, edition: hasEdition }) + nav + joinBand();
  return shell({ title: `${longDate(day)}: ${plural(rows.length, "round")}, ${usd(total) || ""} | What Got Funded`, desc: `Every startup funding round announced on ${longDate(day)}, with founders, investors and sources.`, active: "Today", body, canonical: `/day/${day}/`, scripts: BEEHIIV_SCRIPT });
}

function companyPage(rs, all) {
  const r = rs[0], c = contOf(r.cont);
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const sim = all.filter((x) => x.company_id !== r.company_id && x.sector === r.sector && Math.abs((Date.parse(x.announced_on) - Date.parse(r.announced_on)) / 864e5) <= 7)
    .sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0)).slice(0, 5);
  const lead = r.leads.join(", ") || "Not stated";
  const others = r.investors.join(", ") || (r.leads.length ? "None named" : "Not stated");
  const facts = [placeLine(r) && `<span><span class="dot c-${r.cont}"></span><b>${esc(placeLine(r))}</b></span>`, r.sector && `<span>${esc(r.sector)}</span>`, r.domain && `<span>${esc(r.domain)}</span>`].filter(Boolean).join("");
  const linkBtns = [r.domain && `<a href="https://${esc(r.domain)}" rel="noopener" target="_blank">Website</a>`, r.linkedin_url && `<a href="${esc(r.linkedin_url)}" rel="noopener" target="_blank">LinkedIn</a>`, r.x_url && `<a href="${esc(r.x_url)}" rel="noopener" target="_blank">X</a>`].filter(Boolean).join("");
  const bigAmt = r.amount_usd ? `<div class="num">${usd(r.amount_usd)}</div>` : `<div class="num txt">${esc(r.amount_text && r.amount_text.length < 40 ? r.amount_text : "Amount not disclosed")}</div>`;
  const local = r.amount_usd && r.currency && r.currency !== "USD" ? ` (${esc(r.amount_text && r.amount_text.length <= 30 ? r.amount_text : `${r.currency} ${compact(r.amount)}`)})` : "";
  const sources = rs.flatMap((x) => x.sources).sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
  const body = `
<div class="crumb"><a href="/day/${r.announced_on}/">${longDate(r.announced_on)}</a> / ${esc(r.company)}</div>
<div class="chead">
  <div><h1>${esc(r.company)}</h1>${r.company_native && r.company_native !== r.company ? `<div class="native">${esc(r.company_native)}</div>` : ""}
    ${r.description ? `<p class="what">${esc(r.description)}</p>` : ""}
    <div class="facts">${facts || `<span><span class="dot c-unknown"></span>Location not stated</span>`}</div></div>
  ${linkBtns ? `<div class="links">${linkBtns}</div>` : ""}
</div>
<div class="round${c.dark ? " dark" : ""}" style="background:${c.color}">
  <div class="big">${bigAmt}<div>${STAGE[r.stage] === "Not stated" ? "Stage not stated" : STAGE[r.stage]}, ${dayMonth(r.announced_on)}${local}</div></div>
  <div class="rest">
    <div><small>Lead investor</small><b>${esc(lead)}</b></div>
    <div><small>Other investors</small><b>${esc(others)}</b></div>
    <div><small>Reported by</small><b>${plural(sources.length, "source")}</b></div>
  </div>
</div>
<div class="body">
  <div>
    <section class="prose"><h2>What makes it different</h2>
      ${r.highlight ? `<p>${esc(r.highlight)}</p>` : ""}${r.description && r.description !== r.highlight ? `<p>${esc(r.description)}</p>` : ""}
      ${!r.highlight && !r.description ? `<p>The announcement did not describe the product. We add a description once the company's site or a fuller report confirms it.</p>` : ""}
    </section>
    <section><h2>Founders</h2>
      ${r.founders.length ? `<div class="ppl">${r.founders.map((f) => `<div><span class="ph">${esc(initials(f.name))}</span><div><div class="nm">${esc(f.name)}</div><div class="rl">${esc(f.role || "Founder")}</div></div></div>`).join("")}</div>`
        : `<p class="prose">No founders were named in the reports of this round.</p>`}
    </section>
    <section><h2>Funding history</h2><div class="tl" style="--c:${c.color}">
      ${rs.map((x, i) => `<div${i === 0 ? ' class="now"' : ""}><div class="when">${longDate(x.announced_on)}</div><div class="what">${x.amount_usd ? `<span class="num">${usd(x.amount_usd)}</span> ` : ""}${STAGE[x.stage] === "Not stated" ? "Round" : STAGE[x.stage]}${x.leads.length ? `, led by ${esc(x.leads.join(", "))}` : ""}</div></div>`).join("")}
    </div></section>
    <section class="src"><h2>Where this round was reported</h2>
      ${sources.map((s) => `<a href="${esc(s.url)}" rel="noopener" target="_blank"><span>${esc(sourceName(s))}</span><span>${esc(sourceTitle(s))}</span><span>${s.published_at ? shortDate(String(s.published_at).slice(0, 10)) : ""}</span></a>`).join("")}
    </section>
  </div>
  <aside>
    ${r.careers_url ? `<div class="panel"><h3>Hiring now</h3><p>Open roles are listed on the company's careers page.</p><a class="more" href="${esc(r.careers_url)}" rel="noopener" target="_blank">Careers page</a></div>` : ""}
    <div class="panel"><h3>Similar rounds this week</h3>
      ${sim.length ? sim.map((x) => `<div class="sim"><a href="${x.href}">${esc(x.company)}</a><span class="num">${usd(x.amount_usd) || "–"}</span><small>${esc([STAGE[x.stage] !== "Not stated" ? STAGE[x.stage] : "", x.country, x.leads[0] && `led by ${x.leads[0]}`].filter(Boolean).join(", ") || shortDate(x.announced_on))}</small></div>`).join("")
        : `<p>No other ${esc(r.sector || "")} rounds within a week of this one.</p>`}
    </div>
    <div class="panel"><h3>Get every round by email</h3><p>Free, every morning at 7am Sydney time.</p><a class="more" href="/subscribe/">Subscribe</a></div>
  </aside>
</div>`;
  const amountText = r.amount_usd ? ` raised ${usd(r.amount_usd)}` : " raised funding";
  return shell({ title: `${r.company}${amountText} | What Got Funded`, desc: `${r.company}${amountText}${r.stage !== "undisclosed" ? ` (${STAGE[r.stage]})` : ""} on ${longDate(r.announced_on)}. ${whyOf(r)}`.trim(), active: "Today", body, canonical: r.href });
}

function analysisPage(rows, from, to) {
  const disclosed = rows.filter((r) => r.amount_usd), total = sum(disclosed.map((r) => r.amount_usd));
  const days = [...new Set(rows.map((r) => r.announced_on))].sort();
  const regs = byRegion(rows);
  const group = (key, rs = rows) => { const m = new Map(); for (const r of rs) { const k = key(r); if (k == null) continue; const e = m.get(k) || { k, n: 0, v: 0, amts: [] }; e.n++; e.v += r.amount_usd || 0; if (r.amount_usd) e.amts.push(r.amount_usd); m.set(k, e); } return [...m.values()]; };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const count = (v) => String(v);
  const stageList = group((r) => r.stage).sort((a, b) => STAGE_ORDER.indexOf(a.k) - STAGE_ORDER.indexOf(b.k));
  const sectors = group((r) => r.sector || "Not classified");
  const countries = group((r) => r.country || "Not stated");
  const cColor = (k) => { const r = rows.find((x) => (x.country || "Not stated") === k); return r ? contOf(r.cont).color : "var(--ink)"; };
  const STAGE_COLORS = { pre_seed: "#90caf9", seed: "#42a5f5", series_a: "#1e88e5", series_b: "#3949ab", series_c: "#5e35b1", series_d: "#8e24aa", series_e: "#ad1457", series_f_plus: "#c62828", growth: "#ef6c00", strategic: "#00897b", undisclosed: "#b0bec5" };
  const BANDS = [["Under $1M", 0, 1e6], ["$1M–5M", 1e6, 5e6], ["$5M–20M", 5e6, 2e7], ["$20M–50M", 2e7, 5e7], ["$50M–100M", 5e7, 1e8], ["$100M and above", 1e8, Infinity]];
  // investors
  const inv = new Map();
  for (const r of rows) {
    const leads = cleanInvestors(r.leads), others = cleanInvestors(r.investors).filter((n) => !leads.includes(n));
    for (const [name, lead] of [...leads.map((n) => [n, true]), ...others.map((n) => [n, false])]) {
      const e = inv.get(name) || { name, n: 0, led: 0, ledV: 0 }; e.n++; if (lead) { e.led++; e.ledV += r.amount_usd || 0; } inv.set(name, e);
    }
  }
  const invs = [...inv.values()];
  const sortedAmt = disclosed.map((r) => r.amount_usd).sort((a, b) => b - a);
  const top1 = sortedAmt[0] || 0, top5 = sum(sortedAmt.slice(0, 5));
  const lang = (r) => { const s = firstSourceOf(r); const l = s && s.language ? String(s.language).slice(0, 2).toLowerCase() : "en"; return l === "en" ? "English" : "Local language"; };
  const langs = group(lang);
  const donut = (parts) => {
    const t = sum(parts.map((p) => p.v)) || 1; let a = -Math.PI / 2;
    const arcs = parts.filter((p) => p.v).map((p) => { const a2 = a + (p.v / t) * Math.PI * 2; const large = a2 - a > Math.PI ? 1 : 0;
      const d = p.v === t ? `M60 10 A50 50 0 1 1 59.99 10 Z` : `M60 60 L${60 + 50 * Math.cos(a)} ${60 + 50 * Math.sin(a)} A50 50 0 ${large} 1 ${60 + 50 * Math.cos(a2)} ${60 + 50 * Math.sin(a2)} Z`; a = a2; return `<path d="${d}" fill="${p.color}"/>`; }).join("");
    return `<div class="donut"><svg viewBox="0 0 120 120">${arcs}<circle cx="60" cy="60" r="30" fill="#fff"/></svg><div class="legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)}: <b>${p.v}</b> (${pct(p.v / t)})</span>`).join("")}</div></div>`;
  };
  const coverage = [
    ["Company website", rows.filter((r) => r.domain).length], ["Named founders", rows.filter((r) => cleanFounders(r.founders).length).length],
    ["A founder's LinkedIn", rows.filter((r) => cleanFounders(r.founders).some((p) => p.linkedin_url)).length], ["Company LinkedIn", rows.filter((r) => r.linkedin_url).length],
    ["Lead investor named", rows.filter((r) => r.leads.length).length], ["Amount disclosed", disclosed.length]];
  const range = days.length > 1 ? `${dayMonth(days[0])} to ${dayMonth(days[days.length - 1])}` : dayMonth(days[0] || to);

  const cards = [
    chartCard("Capital by region", "Disclosed capital raised by startups in each region.", rankBars(regs.map((g) => ({ label: g.name, v: g.v, color: g.color, dot: true })))),
    chartCard("Rounds by region", "Number of rounds announced, disclosed or not.", rankBars(regs.map((g) => ({ label: g.name, v: g.n, color: g.color, dot: true })), { fmt: count })),
    chartCard("Top countries by capital", "Eight countries with the most disclosed capital.", rankBars(countries.filter((c) => c.v).sort((a, b) => b.v - a.v).slice(0, 8).map((c) => ({ label: c.k, v: c.v, color: cColor(c.k), dot: true })))),
    chartCard("Most active countries", "Countries ranked by number of rounds.", rankBars(countries.sort((a, b) => b.n - a.n || b.v - a.v).slice(0, 8).map((c) => ({ label: c.k, v: c.n, color: cColor(c.k), dot: true })), { fmt: count })),
    chartCard("Capital by stage", "Disclosed capital per funding stage.", rankBars(stageList.filter((s) => s.v).map((s) => ({ label: STAGE[s.k] || s.k, v: s.v, color: STAGE_COLORS[s.k] })))),
    chartCard("Rounds by stage", "How many rounds were at each stage.", rankBars(stageList.map((s) => ({ label: STAGE[s.k] || s.k, v: s.n, color: STAGE_COLORS[s.k] })), { fmt: count })),
    chartCard("Capital by industry", "Industries with the most disclosed capital.", rankBars(sectors.filter((s) => s.v).sort((a, b) => b.v - a.v).slice(0, 8).map((s) => ({ label: s.k, v: s.v, color: "#3d5afe" })))),
    chartCard("Most active industries", "Industries ranked by number of rounds.", rankBars(sectors.sort((a, b) => b.n - a.n || b.v - a.v).slice(0, 8).map((s) => ({ label: s.k, v: s.n, color: "#00897b" })), { fmt: count })),
    chartCard("Largest rounds", "The eight biggest disclosed rounds.", rankBars([...disclosed].sort((a, b) => b.amount_usd - a.amount_usd).slice(0, 8).map((r) => ({ label: r.company, v: r.amount_usd, color: contOf(r.cont).color, dot: true })))),
    chartCard("Round sizes", "Disclosed rounds grouped by size.", rankBars(BANDS.map(([label, lo, hi]) => ({ label, v: disclosed.filter((r) => r.amount_usd >= lo && r.amount_usd < hi).length, color: "#172033" })), { fmt: count })),
    chartCard("Median round by stage", "Typical disclosed round size at each stage.", rankBars(stageList.filter((s) => s.amts.length).map((s) => ({ label: `${STAGE[s.k] || s.k} (${s.amts.length})`, v: median(s.amts), color: STAGE_COLORS[s.k] })))),
    chartCard("How concentrated was the money", "Share of disclosed capital taken by the largest rounds.", `<div class="bignum">${total ? pct(top5 / total) : "–"}<small>of disclosed capital went to the five largest rounds. The single largest took ${total ? pct(top1 / total) : "–"}.</small></div>` +
      stackBars([{ label: "All capital", parts: [{ v: top1, color: "#172033", label: "Largest round" }, { v: top5 - top1, color: "#5c6bc0", label: "Next four" }, { v: total - top5, color: "#c5cae9", label: "Everything else" }] }],
        [{ label: "Largest round", color: "#172033" }, { label: "Next four", color: "#5c6bc0" }, { label: "Everything else", color: "#c5cae9" }])),
    chartCard("Disclosure by region", "Share of rounds in each region that stated an amount.", rankBars(regs.map((g) => ({ label: g.name, v: g.rows.filter((r) => r.amount_usd).length / g.n, color: g.color, dot: true, value: pct(g.rows.filter((r) => r.amount_usd).length / g.n) })), { max: 1 })),
    chartCard("Stage mix by region", "Rounds in each region, split by stage.", stackBars(regs.map((g) => ({ label: g.name, parts: STAGE_ORDER.map((k) => ({ v: g.rows.filter((r) => r.stage === k).length, color: STAGE_COLORS[k], label: STAGE[k] })) })),
      STAGE_ORDER.filter((k) => rows.some((r) => r.stage === k)).map((k) => ({ label: STAGE[k], color: STAGE_COLORS[k] })))),
    chartCard("Most active investors", "Investors named in the most rounds. Counts only named investors, so they are a floor.", rankBars(invs.sort((a, b) => b.n - a.n || b.ledV - a.ledV).slice(0, 8).map((i) => ({ label: i.name, v: i.n, color: "#172033" })), { fmt: count })),
    chartCard("Investors leading the most capital", "Disclosed size of the rounds each investor led.", rankBars(invs.filter((i) => i.ledV).sort((a, b) => b.ledV - a.ledV).slice(0, 8).map((i) => ({ label: i.name, v: i.ledV, color: "#ad1457" })))),
    chartCard("Where rounds were first reported", "Language of the first report we found for each round.", donut(langs.map((l) => ({ label: l.k, v: l.n, color: l.k === "English" ? "#172033" : "#00897b" })))),
    chartCard("What we know about each startup", "Share of startups for which each detail is public.", rankBars(coverage.map(([label, n]) => ({ label, v: n / (rows.length || 1), value: pct(n / (rows.length || 1)), color: "#3d5afe" })), { max: 1 })),
  ];
  if (days.length > 1) {
    const perDay = days.map((d) => ({ label: shortDate(d), v: sum(rows.filter((r) => r.announced_on === d).map((r) => r.amount_usd || 0)), color: "#172033" }));
    cards.unshift(chartCard("Capital day by day", "Disclosed capital per day of announcement.", rankBars(perDay), { wide: true }));
  }
  const body = `<div class="wrap">
<section class="hero2"><p class="kick">Analysis · ${esc(range)} ${to.slice(0, 4)}</p>
  <h1>Where the startup money went.</h1>
  <p class="lede">${plural(rows.length, "round")} and ${usd(total) || "undisclosed amounts"} in disclosed capital, broken down by region, country, stage, industry and investor. Totals count disclosed amounts only. Written analysis of each trend follows as the data builds.</p>
  <div class="stats"><div><span class="sv">${usd(total) || "–"}</span><span class="sl">disclosed capital</span></div><div><span class="sv">${rows.length}</span><span class="sl">rounds</span></div><div><span class="sv">${usd(median(disclosed.map((r) => r.amount_usd))) || "–"}</span><span class="sl">median disclosed round</span></div></div>
</section>
<section class="block"><h2>The numbers in ${cards.length} charts</h2><div class="cgrid">${cards.join("\n")}</div></section>
</div>${joinBand()}`;
  return shell({ title: `Startup funding analysis, ${range} | What Got Funded`, desc: `Startup funding by region, country, stage, industry and investor: ${plural(rows.length, "round")} and ${usd(total) || ""} disclosed.`, active: "Analysis", body, canonical: "/analysis/", scripts: BEEHIIV_SCRIPT });
}

function investorsPage(rows, from, to) {
  const m = new Map();
  for (const r of rows) for (const [name, lead] of [...r.leads.map((n) => [n, true]), ...r.investors.map((n) => [n, false])]) {
    const e = m.get(name) || { name, n: 0, leads: 0, v: 0, cos: [] }; e.n++; if (lead) e.leads++; e.v += r.amount_usd || 0; e.cos.push(r); m.set(name, e);
  }
  const list = [...m.values()].sort((a, b) => b.n - a.n || b.leads - a.leads || b.v - a.v).slice(0, 150);
  const tr = list.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td class="r amt">${i.n}</td><td class="r hide-s">${i.leads}</td><td class="r amt hide-s">${usd(i.v) || "–"}</td><td>${i.cos.sort((a, b) => b.announced_on.localeCompare(a.announced_on)).slice(0, 6).map((r) => `<a class="u" href="${r.href}">${esc(r.company)}</a>`).join(", ")}${i.cos.length > 6 ? `, and ${i.cos.length - 6} more` : ""}</td></tr>`).join("");
  const body = `
<section class="intro"><div class="kind">${longDate(from)} to ${longDate(to)}</div>
  <h1>Who backed the most startups in the last 30 days.</h1>
  <p class="lede">${m.size} investors named in ${plural(rows.length, "round")}. Counts include only investors named in public reports, so they are a floor, not a total.</p></section>
<section class="sec"><div class="tw"><table class="rounds"><thead><tr><th>Investor</th><th class="r">Rounds</th><th class="r hide-s">Led</th><th class="r hide-s">Capital in those rounds</th><th>Companies</th></tr></thead><tbody>${tr}</tbody></table></div></section>
${joinBand()}`;
  return shell({ title: "Most active startup investors, last 30 days | What Got Funded", desc: "Investors ranked by the number of startup rounds they joined in the last 30 days.", active: "Investors", body, canonical: "/investors/", scripts: BEEHIIV_SCRIPT });
}

// ---------- jobs: key roles at just-funded and hot startups ----------
const FN_LABEL = { engineering: "Engineering", marketing: "Marketing & growth", sales: "Sales & GTM", finance: "Finance", product: "Product", design: "Design",
  devrel: "Developer relations", operations: "Operations", people: "People", customer: "Customer success", other: "Other" };
const SEN_LABEL = { c_level: "C-level", vp: "VP", head: "Head of", director: "Director", lead: "Lead", ic: "" };
function jobsCsv(jobs) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ["company", "website", "raised_usd", "stage", "announced_on", "role", "function", "seniority", "founding", "remote", "fractional", "location", "posted_on", "apply_url"];
  return "﻿" + [cols.join(","), ...jobs.map((j) => [j.company, j.domain ? `https://${j.domain}` : "", j.amount_usd ? Math.round(j.amount_usd) : "", STAGE[j.stage] || "", j.announced_on,
    j.title, FN_LABEL[j.function] || "", SEN_LABEL[j.seniority] || "IC", j.founding ? "yes" : "", j.remote ? "yes" : "", j.fractional ? "yes" : "", j.location, j.posted_on, j.url].map(q).join(","))].join("\r\n") + "\r\n";
}
function jobsPage(allJobs, published, today, hrefOf, hiringAll = []) {
  const since = (d, n) => d && d >= addDays(today, -n);
  // only roles that matter: founding, leadership, remote or fractional, minus junior and generic roles (wgf-jobs sets key_role)
  const jobs = allJobs.filter((j) => j.key_role);
  const byCo = new Map();
  for (const j of jobs) { if (!byCo.has(j.company_id)) byCo.set(j.company_id, []); byCo.get(j.company_id).push(j); }
  const senior = (rs) => rs.filter((j) => ["c_level", "vp", "head", "director"].includes(j.seniority)).length;
  const groups = [...byCo.values()].map((rs) => {
    const j0 = rs[0];
    const fresh = since(j0.announced_on, 30);
    const hot = !fresh && (Number(j0.amount_usd) >= 2e7 || ["series_b", "series_c", "series_d", "series_e", "series_f_plus", "growth"].includes(j0.stage) || senior(rs) >= 5);
    // just funded: roles opened around or after the round
    const rows = fresh ? rs.filter((j) => !j.posted_on || j.posted_on >= addDays(j0.announced_on, -14)) : rs;
    return { j0, rows: rows.sort((a, b) => b.score - a.score), tab: fresh ? "fresh" : hot ? "hot" : null };
  }).filter((g) => g.tab && g.rows.length).sort((a, b) => (b.rows[0].score || 0) - (a.rows[0].score || 0));
  const all = groups.flatMap((g) => g.rows.map((j) => ({ ...j, tab: g.tab })));
  const keyToday = all.filter((j) => j.tab === "fresh").sort((a, b) => b.score - a.score).slice(0, 15);
  const tags = (j) => [j.founding && "Founding", SEN_LABEL[j.seniority], j.remote && "Remote", j.fractional && "Fractional"].filter(Boolean);
  const chip = (t) => `<span class="jtag t-${slugify(t)}">${esc(t)}</span>`;
  const roleRow = (j, withCo = false) => `<li class="role" data-fn="${j.function}" data-tags="${[j.founding && "founding", j.remote && "remote", j.fractional && "fractional"].filter(Boolean).join(" ")}" data-tab="${j.tab}">
    <div class="rt"><a class="rtitle" href="${esc(j.url)}" rel="noopener nofollow" target="_blank">${esc(j.title)}</a>${withCo ? `<span class="rco">at <a href="${hrefOf(j.company_id) || (j.domain ? `https://${j.domain}` : "#")}">${esc(j.company)}</a></span>` : ""}
      <div class="rmeta">${tags(j).map(chip).join("")}<span>${esc(FN_LABEL[j.function] || "")}</span>${j.location ? `<span>${esc(j.location)}</span>` : ""}${j.posted_on ? `<span>Posted ${esc(shortDate(j.posted_on))}</span>` : ""}${j.via ? `<span class="via">via ${esc(j.via)}</span>` : ""}</div></div>
    <a class="apply" href="${esc(j.url)}" rel="noopener nofollow" target="_blank">Apply</a></li>`;
  const coCard = (g) => {
    const j0 = g.j0, c = contOf(continentOf(j0.hq_country ? countryLabel(j0.hq_country) : null));
    const raised = [usd(j0.amount_usd), STAGE[j0.stage] && STAGE[j0.stage] !== "Not stated" ? STAGE[j0.stage] : "", `announced ${shortDate(j0.announced_on)}`].filter(Boolean).join(" · ");
    return `<article class="hco" data-tab="${g.tab}" style="--c:${c.color}">
  <header><div><h3><a href="${hrefOf(j0.company_id) || (j0.domain ? `https://${j0.domain}` : "#")}">${esc(j0.company)}</a></h3><div class="hraised">Raised ${esc(raised)}${j0.hq_country ? ` · ${esc(countryLabel(j0.hq_country))}` : ""}</div></div>
    <div class="hcount"><b>${g.rows.length}</b><span>key ${g.rows.length === 1 ? "role" : "roles"}</span></div></header>
  ${j0.use_of_funds ? `<p class="why"><b>Why they're hiring</b>${esc(j0.use_of_funds)}</p>` : ""}
  <ul class="roles">${g.rows.map((j) => roleRow(j)).join("")}</ul>
</article>`;
  };
  // Hiring signal: just-funded startups that said the money pays for hiring but have no key roles posted yet
  const shown = new Set(groups.map((g) => g.j0.company_id));
  const hiring = hiringAll.filter((h) => !shown.has(h.company_id) && since(h.announced_on, 45)).sort((a, b) => (b.announced_on || "").localeCompare(a.announced_on || "") || (b.amount_usd || 0) - (a.amount_usd || 0));
  const sigCard = (h) => {
    const c = contOf(continentOf(h.hq_country ? countryLabel(h.hq_country) : null));
    const raised = [usd(h.amount_usd), STAGE[h.stage] && STAGE[h.stage] !== "Not stated" ? STAGE[h.stage] : "", `announced ${shortDate(h.announced_on)}`].filter(Boolean).join(" · ");
    const site = h.careers_url || (h.domain ? `https://${h.domain}` : null);
    return `<article class="hco hsig" style="--c:${c.color}">
  <header><div><h3><a href="${hrefOf(h.company_id) || site || "#"}">${esc(h.company)}</a></h3><div class="hraised">Raised ${esc(raised)}${h.hq_country ? ` · ${esc(countryLabel(h.hq_country))}` : ""}</div></div></header>
  <p class="why"><b>What the money is for</b>${esc(h.use_of_funds)}</p>
  <div class="sigacts">${h.source_url ? `<a href="${esc(h.source_url)}" rel="noopener nofollow" target="_blank">Read the announcement</a>` : ""}${site ? `<a href="${esc(site)}" rel="noopener nofollow" target="_blank">${h.careers_url ? "Careers page" : "Company website"}</a>` : ""}${h.linkedin_url ? `<a href="${esc(h.linkedin_url)}" rel="noopener nofollow" target="_blank">LinkedIn</a>` : ""}</div>
</article>`;
  };
  const sigBlock = hiring.length ? `<section class="block" id="signals"><h2>Hiring, no roles posted yet</h2><p class="sub2">Startups funded in the last 45 days whose announcement says the money pays for hiring. Their roles are not on a public job board yet, so the way in is the company itself.</p><div class="hcos sigs">${hiring.map(sigCard).join("\n")}</div></section>` : "";
  const fnCounts = new Map(); for (const j of all) fnCounts.set(j.function, (fnCounts.get(j.function) || 0) + 1);
  const fnChips = [`<button type="button" class="on" data-fn="all">All functions</button>`, ...Object.keys(FN_LABEL).filter((k) => fnCounts.get(k)).map((k) => `<button type="button" data-fn="${k}">${FN_LABEL[k]} ${fnCounts.get(k)}</button>`)].join("");
  const nFresh = groups.filter((g) => g.tab === "fresh").length, nHot = groups.filter((g) => g.tab === "hot").length;
  const empty = `<div class="jempty"><h3>Roles are being collected</h3><p>Every night we collect the open roles of every startup that raised in the last year, from job boards, careers pages and remote job feeds, and keep only the roles that shape a company: founding hires, leaders, and remote or fractional roles.</p></div>`;
  const body = `<div class="wrap jobs2">
<section class="hero2"><p class="kick">Jobs</p>
  <h1>The first hires at startups that just raised.</h1>
  <p class="lede">Founding, leadership, remote and fractional roles at startups funded in the last 30 days, and at the year's hottest startups. Every role links straight to the company's own posting, and startups that raised to hire but have not posted roles yet are listed too.</p>
  <div class="stats"><div><span class="sv">${all.length}</span><span class="sl">key roles open</span></div><div><span class="sv">${nFresh}</span><span class="sl">just-funded startups hiring</span></div><div><span class="sv">${all.filter((j) => j.founding).length}</span><span class="sl">founding roles</span></div><div><span class="sv">${hiring.length}</span><span class="sl">hiring, no roles posted yet</span></div></div>
  <div class="acts"><a class="btn2" href="/data/jobs.csv" download>${ICON_DL}Download roles as CSV</a></div>
</section>
${all.length ? `
<section class="block"><h2>Key roles today</h2><p class="sub2">The founding and leadership roles that just-funded startups opened most recently.</p><ul class="roles keyroles">${keyToday.map((j) => roleRow(j, true)).join("")}</ul></section>
<section class="block jlist" id="board">
  <div class="tabs" role="tablist"><button type="button" class="on" data-tab="fresh">Just funded <small>${nFresh}</small></button><button type="button" data-tab="hot">Hot startups <small>${nHot}</small></button></div>
  <div class="chips fnchips">${fnChips}</div>
  <div class="toggles"><label><input type="checkbox" value="founding">Founding</label><label><input type="checkbox" value="remote">Remote</label><label><input type="checkbox" value="fractional">Fractional</label></div>
  <div class="hcos">${groups.map(coCard).join("\n")}</div>
  <p class="jnone" hidden>No roles match these filters.</p>
</section>` : empty}
${sigBlock}
</div>${joinBand()}`;
  return shell({ title: "Founding and leadership roles at newly funded startups | What Got Funded", desc: "Founding, leadership, remote and fractional roles at startups that just raised, and the startups that raised to hire.", active: "Jobs", body, canonical: "/jobs/", scripts: BEEHIIV_SCRIPT });
}

function methodologyPage() {
  const body = `<div class="narrow prose">
<h1>Methodology</h1>
<p>How a funding announcement in a news source becomes a round on What Got Funded.</p>
<h2>Sources</h2>
<p>Every day we collect funding news from ${SOURCES_LINE}: RSS feeds from startup and business publications, local-language news searches, and funding pages read directly where a publication has no feed. Pages are only read where the site's robots.txt allows it, and paywalled content is never collected.</p>
<h2>What counts as a round</h2>
<p>Equity or venture rounds raised by startups and private growth companies: pre-seed, seed, angel, Series A onwards, growth equity, and strategic investments in startups.</p>
<p>Excluded, with the reason recorded: debt and venture debt, grants and prizes, funds raised by investors, IPOs and raises by public companies, acquisitions and mergers, secondary share sales, private equity buyouts, and rounds that are only reported as talks or plans.</p>
<h2>How each round is built</h2>
<ul><li>Each story is read by a language model instructed to use only what the source states. Values the source does not state stay empty and show as "not stated".</li>
<li>The same round reported by several sources is merged into one record: same company, compatible stage, announced within 14 days.</li>
<li>Amounts are converted to US dollars at the European Central Bank's daily reference rate. Totals count disclosed amounts only.</li>
<li>Rounds announced more than 30 days before we first saw them, and reports that do not name the company, are kept out of the daily figures.</li></ul>
<h2>Dates</h2>
<p>A round belongs to the day it was announced, in the source's own date. Each daily edition covers the previous day.</p>
<h2>Coverage</h2>
<p>We measure coverage against commercial databases privately and use the gaps to add sources. Their data is never published here.</p>
<h2>People</h2>
<p>Founders are listed by name and role only, as named in the announcement or on the company's own site. We do not publish email addresses or phone numbers.</p>
<h2>Corrections</h2>
<p>Every round links to where it was reported. If something is wrong, <a href="mailto:dev@hackrlife.com?subject=Correction%20for%20What%20Got%20Funded">send a correction</a> and it will be fixed in the next update.</p>
</div>`;
  return shell({ title: "Methodology | What Got Funded", desc: "How What Got Funded collects, checks and publishes startup funding rounds every day.", body, canonical: "/methodology/" });
}

// ---------- about: sources come from the registry in /sources ----------
function readCsv(file) {
  const text = fs.readFileSync(file, "utf8"); const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function aboutPage() {
  const file = path.join(ROOT, "..", "sources", "sources.csv");
  const all = fs.existsSync(file) ? readCsv(file) : [];
  const read = all.filter((s) => s.collection_method !== "manual_or_not_ingested" && s.homepage);
  const searches = fs.existsSync(path.join(ROOT, "..", "sources", "google-news-queries.csv")) ? readCsv(path.join(ROOT, "..", "sources", "google-news-queries.csv")).length : 0;
  const markets = new Set(read.map((s) => s.market)).size;
  const langs = new Set(read.flatMap((s) => s.language.split("/").map((l) => l.trim())).filter(Boolean));
  const NAMES = { Global: "Global", Americas: "Americas", Europe: "Europe", Africa: "Africa", "Middle East": "Middle East", APAC: "Asia-Pacific" };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const ORDER2 = ["Americas", "Europe", "Africa", "Middle East", "APAC", "Global"];
  const cards = ORDER2.map((r) => [r, read.filter((s) => s.region === r).sort((a, b) => a.market.localeCompare(b.market) || a.source.localeCompare(b.source))])
    .filter(([, l]) => l.length).map(([r, l]) => {
      const mk = new Set(l.map((s) => s.market)).size;
      const lg = new Set(l.flatMap((s) => s.language.split("/").map((x) => x.trim())).filter(Boolean)).size;
      return `<details class="regcard"><summary><span class="rname">${NAMES[r] || r}</span><span class="rnum" aria-label="${plural(l.length, "source")}">${l.length}<small>sources</small></span><span class="rmeta">${plural(mk, "market")} · ${plural(lg, "language")}</span><span class="rhint">See all sources</span></summary>
<table class="srct"><thead><tr><th>Source</th><th>Market</th><th class="hide-s">Language</th></tr></thead><tbody>
${l.map((s) => `<tr><td><a class="u" href="${esc(s.homepage)}" rel="nofollow noopener" target="_blank">${esc(s.source)}</a><small>${esc(host(s.homepage))}</small></td><td>${esc(s.market)}</td><td class="hide-s">${esc(s.language)}</td></tr>`).join("\n")}
</tbody></table></details>`;
    }).join("\n");

  const steps = [
    ["Scraper", "Collects the day's funding news from every source and local-language search, for the previous day in Sydney time.", "Apify", "#f9a825"],
    ["Structurer", "Reads each story in its own language and records the company, amount, stage, investors and founders in English.", "Claude Haiku", "#3d5afe"],
    ["Verifier", "Finds the first public report of each round and opens the page to confirm its real publish date.", "Gemini + Google Search, Claude Sonnet", "#00897b"],
    ["Curator", "Merges duplicates, removes old rounds and non-equity deals, and picks the stories that lead the day.", "Claude Sonnet", "#e53935"],
    ["Article publisher", "Builds the daily edition: the charts, every startup as a card, and the free CSV download.", "Vercel", "#8e24aa"],
    ["Newsletter publisher", "Prepares the morning email with the day's top 20 startups and a link to the full edition.", "Beehiiv", "#172033"],
  ];
  const pipe = `<div class="pipe" role="img" aria-label="The daily pipeline: six agents from scraping to newsletter">
  <div class="orch"><span class="pill">n8n</span><span>One workflow runs the six agents every night at <b>9pm Sydney time</b>. Every round, source and check is stored in <b>Supabase</b>.</span></div>
  <ol>${steps.map(([h, p, t, c], i) => `<li style="--c:${c}"><span class="n">STEP ${i + 1}</span><h3>${h}</h3><p>${p}</p><span class="tool">${t}</span></li>`).join("")}</ol>
  <div class="out"><b style="color:var(--ink)">What comes out:</b><span>Daily edition on the site</span><span>Newsletter at 7am</span><span>CSV of every round</span><span>Analysis</span></div>
</div>`;
  const block = (k, c, h, inner, wide = false) => `<section class="pblock${wide ? " wide" : ""}" style="--c:${c}"><span class="pk"><i></i>${k}</span><h3>${h}</h3>${inner}</section>`;
  const body = `<div class="wrap about2">
<section class="hero2"><p class="kick">About</p>
  <h1>We find every startup funding round and show where the money is going.</h1>
  <p class="lede">What Got Funded curates startup funding news from around the world, records each round in the same format, and analyses it by region, market, sector, stage and investor.</p>
  <p>We are not a private database and we do not run our own investigations. Every round on this site was reported publicly, and every entry links to the reports it came from.</p>
  <div class="kpis2"><div><b>${read.length}</b><span>news sources</span></div><div><b>${searches}</b><span>local-language searches</span></div><div><b>${markets}</b><span>markets</span></div><div><b>${langs.size}</b><span>languages</span></div></div>
</section>
<section class="block"><h2>How it works</h2><p class="sub2">Six agents run in one automated pipeline, every night.</p>${pipe}</section>
<section class="block"><h2>The process in detail</h2>
<div class="pblocks">
${block("1 · Collect", "#f9a825", "Where the data comes from", `<p>We follow ${read.length} sources in ${markets} markets and ${langs.size} languages, listed in full below, plus ${searches} local-language news searches that pick up funding stories from outlets we do not follow directly.</p><p>They include startup and technology publications, business newspapers, regional startup media, investor and accelerator news pages, and press-release wires. We read each source's public feed or funding section, only where the publisher's robots.txt allows it, and never collect paywalled content.</p>`)}
${block("2 · Structure", "#3d5afe", "How we process it", `<ul><li>Each funding story is read in full, whatever the language, and its details are recorded in English.</li><li>We take the company, what it does, where it is based, the amount and currency, the stage, the lead and other investors, and the founders, using only what the source states. Anything not stated stays blank.</li><li>Amounts in other currencies are converted to US dollars at the European Central Bank's reference rate on the day.</li><li>We add the company's official links (website, LinkedIn, X, careers page). The funding details come only from the news reports.</li></ul>`)}
${block("3 · Verify", "#00897b", "How we check the date", `<p>Many sites re-post older deals days or weeks later with a new date. A round belongs to the day it was first announced, in the publisher's local time, so every new round is checked before it is published.</p><ul><li>A search model finds the earliest public report of the round, in English and in the local language.</li><li>We then open that report ourselves and read its real publish date. The model's answer only counts if the page exists, names the company and carries that date.</li><li>Large or unclear rounds get a second, independent check. Rounds that cannot be confirmed are held back.</li></ul>`)}
${block("4 · Curate", "#e53935", "How we curate it", `<ul><li>The same round reported by several outlets becomes one entry, with every report listed as a source.</li><li>We include equity rounds raised by startups and private growth companies: pre-seed, seed, Series A onwards, growth and strategic investments.</li><li>We leave out debt, grants, funds raised by investors, IPOs, acquisitions, secondary sales, private equity buyouts, rumours and talks, old rounds reported again, and reports that do not name the company.</li></ul>`)}
${block("5 · Analyse", "#8e24aa", "How we analyse it", `<p>Once the day's rounds are curated, we analyse them: the total raised, the split by continent and market, the sectors and stages attracting money, the largest rounds and the most active investors.</p><p>The daily edition covers each day's rounds. The weekly, monthly and longer analyses look at how funding is shifting over time. Every day's data can be downloaded as a CSV, free.</p>`)}
${block("6 · Limits", "#9aa3b2", "What we may miss", `<p>Our coverage is only as complete as the news. Some rounds are never announced publicly, appear only on social media, or are reported only behind a paywall. Some details, such as the amount or the investors, are never disclosed and stay blank here.</p><p>If you know of a round we missed or got wrong, <a href="mailto:dev@hackrlife.com?subject=Missing%20or%20wrong%20round%20on%20What%20Got%20Funded">tell us</a> and we will add or fix it.</p>`)}
</div></section>
<section class="block"><h2>Our sources</h2><p class="sub2">Open a region to see every source we follow there.</p>
<div class="regcards">
${cards}
</div></section>
</div>`;
  return shell({ title: "About | What Got Funded", desc: `What Got Funded curates startup funding news from ${read.length} sources in ${markets} markets and analyses where the money is going.`, active: "About", body, canonical: "/about/" });
}

function subscribePage() {
  const body = `<section class="intro"><h1>Every startup funding round, in your inbox at 7am.</h1>
<p class="lede">Each morning: every round announced the day before, the total raised by continent and market, the investors behind them, and where each one was reported. Free.</p></section>
<section class="join" style="margin-top:40px"><div><h2>Subscribe free</h2><p>One email a day, Sydney time. Unsubscribe in one click.</p></div><div>${subscribeForm()}</div></section>`;
  return shell({ title: "Subscribe | What Got Funded", desc: "Get every startup funding round by email at 7am, free.", body, canonical: "/subscribe/", scripts: BEEHIIV_SCRIPT });
}

function notFoundPage() {
  return shell({ title: "Page not found | What Got Funded", desc: "Page not found.", body: `<div class="narrow"><h1>That page isn't here.</h1><p class="sub">It may have moved. <a class="u" href="/">Go to today's rounds</a>.</p></div>`, canonical: "/404" });
}

// ---------- build ----------
function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function main() {
  {
    const reg = path.join(ROOT, "..", "sources", "sources.csv"), q = path.join(ROOT, "..", "sources", "google-news-queries.csv");
    if (fs.existsSync(reg)) {
      const read = readCsv(reg).filter((s) => s.collection_method !== "manual_or_not_ingested" && s.homepage);
      const searches = fs.existsSync(q) ? readCsv(q).length : 0;
      SOURCES_LINE = `${read.length} news sources and ${searches} local-language news searches across ${new Set(read.map((s) => s.market)).size} markets`;
    }
  }
  const data = await loadData();
  // keep the feed for newsletter.mjs, which runs after the build (see vercel.json)
  if (process.env.WGF_SNAPSHOT_OUT) fs.writeFileSync(process.env.WGF_SNAPSHOT_OUT, JSON.stringify(data));
  const today = process.env.BUILD_TODAY || sydneyDate();
  const yesterday = addDays(today, -1);

  // normalise
  const usedSlugs = new Map();
  const rounds = (data.rounds || []).map((r) => {
    const country = r.hq_country ? countryLabel(r.hq_country) : null;
    return { ...r, country, cont: continentOf(country), amount_usd: r.amount_usd ? Number(r.amount_usd) : null, amount: r.amount ? Number(r.amount) : null,
      leads: r.leads || [], investors: r.investors || [], founders: r.founders || [], sources: r.sources || [] };
  });
  for (const r of rounds) {
    if (!usedSlugs.has(r.company_id)) usedSlugs.set(r.company_id, `${slugify(r.company) || "company"}-${r.company_id}`);
    r.href = `/company/${usedSlugs.get(r.company_id)}/`;
  }
  // data/editions.json "_published": only the editions that have been checked and released are on the site
  const editionCfg = fs.existsSync(path.join(ROOT, "data", "editions.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "editions.json"), "utf8")) : {};
  const released = Array.isArray(editionCfg._published) ? new Set(editionCfg._published) : null;
  const published = rounds.filter((r) => r.announced_on < today && (!released || released.has(r.announced_on)));
  const byDay = new Map();
  for (const r of published) { if (!byDay.has(r.announced_on)) byDay.set(r.announced_on, []); byDay.get(r.announced_on).push(r); }
  const days = [...byDay.keys()].sort();
  if (!days.length) throw new Error("No published rounds before " + today);

  fs.rmSync(OUT, { recursive: true, force: true });
  // assets with content hashes so browsers cache them safely
  const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const h = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
  CSS_HREF = `/assets/styles.${h(css)}.css`; JS_SRC = `/assets/app.${h(js)}.js`;
  write(CSS_HREF, css); write(JS_SRC, js);
  fs.cpSync(path.join(ROOT, "public"), OUT, { recursive: true });

  // home: yesterday if it has rounds, else the latest published day
  const homeDay = byDay.has(yesterday) ? yesterday : days[days.length - 1];
  const idx = (d) => days.indexOf(d);
  const prevOf = (d) => days[idx(d) - 1] || null, nextOf = (d) => days[idx(d) + 1] || null;
  const overrides = fs.existsSync(path.join(ROOT, "data", "editions.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "editions.json"), "utf8")) : {};
  const edDays = days.filter((d) => d >= EDITION_START);
  const editions = edDays.map((d) => editionModel(d, byDay.get(d), { continents: CONTINENTS, override: overrides[d] || {} }));
  editions.forEach((m, i) => write(`editions/${m.day}/index.html`, shell({ title: `${m.headline} | What Got Funded`, desc: m.dek, active: "Editions",
    body: articleBody(m, { prev: edDays[i - 1], next: edDays[i + 1] }) + joinBand(), canonical: `/editions/${m.day}/`, scripts: BEEHIIV_SCRIPT })));
  const cards = [...editions].reverse();
  write("editions/index.html", shell({ title: "Daily editions | What Got Funded", desc: "Every day's startup funding, as one story with the four charts and every round.", active: "Editions",
    body: `<div class="narrow"><h1>Daily editions</h1><p class="sub">One story a day: the day's total, funding by region, top investors, funding by industry, then every startup that announced a round.</p></div><section class="edfeed list">${cards.map(editionCard).join("")}</section>`, canonical: "/editions/" }));
  write("index.html", homePage(homeDay, byDay.get(homeDay), prevOf(homeDay), nextOf(homeDay), homeDay === yesterday, edDays.includes(homeDay)));
  for (const d of days) write(`day/${d}/index.html`, dayPage(d, byDay.get(d), prevOf(d), nextOf(d), edDays.includes(d)));
  // free CSV downloads: one per day and one for everything published
  for (const d of days) write(`data/${d}.csv`, roundsCsv(byDay.get(d), SITE_URL));
  write("data/all-rounds.csv", roundsCsv(published, SITE_URL));

  const byCo = new Map();
  for (const r of published) { if (!byCo.has(r.company_id)) byCo.set(r.company_id, []); byCo.get(r.company_id).push(r); }
  for (const rs of byCo.values()) {
    rs.sort((a, b) => b.announced_on.localeCompare(a.announced_on));
    write(`${rs[0].href.slice(1)}index.html`, companyPage(rs, published));
  }

  const weekFrom = addDays(homeDay, -6);
  const week = published.filter((r) => r.announced_on >= weekFrom && r.announced_on <= homeDay);
  write("analysis/index.html", analysisPage(week, weekFrom, homeDay));
  const monthFrom = addDays(homeDay, -29);
  write("investors/index.html", investorsPage(published.filter((r) => r.announced_on >= monthFrom), monthFrom, homeDay));
  {
    const hrefs = new Map(published.map((r) => [r.company_id, r.href]));
    write("jobs/index.html", jobsPage(data.jobs || [], published, today, (id) => hrefs.get(id), data.hiring || []));
    write("data/jobs.csv", jobsCsv((data.jobs || []).filter((j) => j.key_role)));
  }
  write("about/index.html", aboutPage());
  write("methodology/index.html", methodologyPage());
  write("subscribe/index.html", subscribePage());
  write("404.html", notFoundPage());

  const urls = ["/", "/editions/", ...edDays.map((d) => `/editions/${d}/`), "/analysis/", "/investors/", "/jobs/", "/about/", "/methodology/", "/subscribe/", ...days.map((d) => `/day/${d}/`), ...[...byCo.values()].map((rs) => rs[0].href)];
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE_URL}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  console.log(`Built ${urls.length} pages: home ${homeDay} (${byDay.get(homeDay).length} rounds), ${days.length} days, ${byCo.size} companies. Data generated ${data.generated_at}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
