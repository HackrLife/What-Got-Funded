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
import { editionModel, articleBody, editionCard } from "./src/edition.mjs";
// Daily editions start with the 18 October 2026 issue. Headline overrides: data/editions.json { "YYYY-MM-DD": { "headline": "...", "dek": "..." } }
const EDITION_START = "2026-10-19";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "dist");
const SITE_URL = (process.env.SITE_URL || "https://whatgotfunded.com").replace(/\/$/, "");
const PUBLISH_URL = process.env.WGF_PUBLISH_URL || "https://cxtcwslqzrzjaulqcvvu.supabase.co/functions/v1/wgf-publish?days=150";
const BEEHIIV_FORM = process.env.BEEHIIV_FORM_ID || "25f5c9ba-9712-405b-8319-832a0415e181";
const SOURCES_LINE = "343 news sources and 76 local-language news searches across 74 markets";

// ---------- data ----------
async function loadData() {
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
function homePage(day, rows, prev, next, isYesterday, edCards = "") {
  const disclosed = rows.filter((r) => r.amount_usd);
  const total = sum(disclosed.map((r) => r.amount_usd));
  const when = isYesterday ? "Yesterday" : `On ${weekday(day)}`;
  const conts = byContinent(rows);
  const legend = conts.map((c) => `<a href="/day/${day}/?c=${c.k}" style="--c:${c.color}"><span class="n num">${c.v ? usd(c.v) : "–"}</span><small>${c.name}, ${plural(c.n, "round")}</small></a>`).join("");

  const biggest = [...disclosed].sort((a, b) => b.amount_usd - a.amount_usd)[0];
  const local = rows.filter((r) => r !== biggest && r.sources.some((s) => s.language && !/^en/i.test(s.language)))
    .sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0))[0];
  const most = rows.filter((r) => r !== biggest && r !== local).sort((a, b) => b.sources.length - a.sources.length || (b.amount_usd || 0) - (a.amount_usd || 0))[0];
  const card = (h, r, extra = "") => !r ? "" : `<div><h2>${h}</h2>
    <a class="co" href="${r.href}">${esc(r.company)}</a>
    <div class="meta"><span class="dot c-${r.cont}"></span>${esc([r.country || "Country not stated", r.sector].filter(Boolean).join(", "))}${r.amount_usd ? `, <span class="num">${usd(r.amount_usd)}</span>` : ""}${r.stage !== "undisclosed" ? ` ${STAGE[r.stage]}` : ""}</div>
    ${whyOf(r) ? `<p>${esc(whyOf(r))}${extra}</p>` : extra ? `<p>${extra.trim()}</p>` : ""}
    <a class="more" href="${r.href}">Read the round</a></div>`;
  const localLang = local && local.sources.find((s) => s.language && !/^en/i.test(s.language));
  const LANG = { ja: "Japanese", zh: "Chinese", ko: "Korean", de: "German", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch",
    sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish", pl: "Polish", tr: "Turkish", ar: "Arabic", he: "Hebrew", id: "Indonesian",
    vi: "Vietnamese", th: "Thai", hi: "Hindi", ru: "Russian", uk: "Ukrainian", cs: "Czech", ro: "Romanian", hu: "Hungarian", el: "Greek" };
  const langName = localLang ? LANG[String(localLang.language).slice(0, 2).toLowerCase()] : null;

  const top = [...rows].sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0)).slice(0, 10);
  const body = `
${edCards ? `<section class="edfeed" aria-label="Daily editions">${edCards}</section>` : ""}
<section class="hero">
  <div class="dayline"><span>${longDate(day)}, all markets</span><span class="daynav">${prev ? `<a href="/day/${prev}/">Previous day</a>` : '<span class="off">Previous day</span>'}<span>|</span><a href="/day/${day}/">Every round</a></span></div>
  <div class="lead">
    <h1 class="say">${when}, ${plural(rows.length, "startup")} raised ${usd(total) || "undisclosed amounts"}.</h1>
    <p class="sub">Every startup funding round, every day, found across ${SOURCES_LINE}. ${disclosed.length} of ${rows.length} rounds disclosed an amount.</p>
    <div class="legend">${legend}</div>
  </div>
  <div><div id="map" role="img" aria-label="Capital raised by country, grouped by continent"></div>
  <p class="note">Tile size is disclosed capital. Select a tile or a continent to see its rounds.</p></div>
</section>
<script type="application/json" id="map-data">${JSON.stringify({ day, groups: treemapData(rows) }).replace(/</g, "\\u003c")}</script>
<section class="three">
  ${card("Biggest round", biggest)}
  ${card("Found in local press", local, langName ? ` First reported in ${langName}.` : "")}
  ${card("Most reported", most, most ? ` Covered by ${plural(most.sources.length, "source")}.` : "")}
</section>
<section class="listing">
  <div class="head"><h2>The day's largest rounds</h2><a href="/day/${day}/">All ${plural(rows.length, "round")}</a></div>
  ${roundsTable(top)}
</section>
${joinBand()}`;
  return shell({ title: `What Got Funded: ${plural(rows.length, "startup")} raised ${usd(total) || ""} on ${dayMonth(day)}`, desc: `Every startup funding round announced on ${longDate(day)}, across all markets.`, active: "Today", body, canonical: "/", scripts: BEEHIIV_SCRIPT });
}

function dayPage(day, rows, prev, next) {
  const disclosed = rows.filter((r) => r.amount_usd), total = sum(disclosed.map((r) => r.amount_usd));
  const sorted = [...rows].sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0) || a.company.localeCompare(b.company));
  const count = (key) => { const m = new Map(); for (const r of rows) { const v = key(r); m.set(v, (m.get(v) || 0) + 1); } return m; };
  const contC = count((r) => r.cont), countryC = count((r) => r.country || ""), stageC = count((r) => r.stage), sectorC = count((r) => r.sector || "Other");
  const box = (name, value, label, n, extra = "") => `<label><input type="checkbox" name="${name}" value="${esc(value)}"${extra}>${label}<span class="ct">${n}</span></label>`;
  const contBoxes = CONTINENTS.filter((c) => contC.get(c.k)).map((c) => box("c", c.k, `<span class="dot c-${c.k}"></span>${c.name}`, contC.get(c.k))).join("");
  const countries = [...countryC.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const countryBoxes = countries.map(([k, n], i) => box("country", k, esc(k), n, i >= 8 ? ' data-extra="1"' : "")).join("");
  const stageBoxes = STAGE_ORDER.filter((s) => stageC.get(s)).map((s) => box("stage", s, STAGE[s], stageC.get(s))).join("");
  const sectorBoxes = [...sectorC.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => box("sector", k, esc(k), n)).join("");
  const conts = byContinent(rows);
  const bar = conts.map((c) => `<a href="#" data-k="${c.k}" class="${c.dark ? "dark" : ""}" style="flex:${Math.max(c.v, total * 0.04) || 1};background:${c.color}" title="${c.name}"><b>${c.v ? usd(c.v) : "–"}</b><span>${c.name}</span></a>`).join("");
  const body = `
<div class="page">
  <aside class="filters" aria-label="Filters">
    <div class="hd">Filters <button type="button" id="f-clear">Clear</button></div>
    <div class="fg"><h3>Continent</h3>${contBoxes}</div>
    ${countries.length ? `<div class="fg"><h3>Market</h3>${countryBoxes}${countries.length > 8 ? '<button type="button" class="more-c" id="more-c">Show all markets</button>' : ""}</div>` : ""}
    <div class="fg"><h3>Stage</h3>${stageBoxes}</div>
    <div class="fg"><h3>Industry</h3>${sectorBoxes}</div>
    <div class="fg"><h3>Amount</h3><select id="f-min" aria-label="Minimum amount"><option value="0">Any amount</option><option value="1000000">$1M and above</option><option value="5000000">$5M and above</option><option value="20000000">$20M and above</option><option value="100000000">$100M and above</option></select></div>
    <div class="fg"><h3>Investor or company</h3><input type="search" id="f-q" placeholder="Search names" aria-label="Search investors or companies"></div>
  </aside>
  <div>
    <div class="dayhead">
      <div><div class="d">${longDate(day)}</div><h1 id="day-h" data-total="${rows.length}">${plural(rows.length, "round")}, ${usd(total) || "amounts not disclosed"}</h1></div>
      <div class="acts"><a class="btn ghost" ${prev ? `href="/day/${prev}/"` : 'aria-disabled="true"'}>Previous day</a><a class="btn ghost" ${next ? `href="/day/${next}/"` : 'aria-disabled="true"'}>Next day</a></div>
    </div>
    <div class="bar" id="bar">${bar}</div>
    <div class="chips"><span class="chip">Sorted by <b>amount</b></span><span class="chip" id="showing">Showing <b>all ${plural(rows.length, "round")}</b></span><button type="button" class="clear" id="chip-clear" hidden>Clear filters</button></div>
    ${roundsTable(sorted, { filters: true })}
    <p class="empty" id="none" hidden>No rounds match these filters.</p>
  </div>
</div>
${joinBand()}`;
  return shell({ title: `${longDate(day)}: ${plural(rows.length, "round")}, ${usd(total) || ""} | What Got Funded`, desc: `Every startup funding round announced on ${longDate(day)}, with investors, amounts and sources.`, active: "Today", body, canonical: `/day/${day}/`, scripts: BEEHIIV_SCRIPT });
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
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const conts = byContinent(rows);
  const byKey = (key) => { const m = new Map(); for (const r of rows) { const k = key(r); const e = m.get(k) || { k, n: 0, v: 0 }; e.n++; e.v += r.amount_usd || 0; m.set(k, e); } return [...m.values()]; };
  const stages = byKey((r) => r.stage).sort((a, b) => STAGE_ORDER.indexOf(a.k) - STAGE_ORDER.indexOf(b.k));
  const sectors = byKey((r) => r.sector || "Other").sort((a, b) => b.v - a.v).slice(0, 10);
  const markets = byKey((r) => r.country || "").filter((m) => m.k).sort((a, b) => b.v - a.v);
  const perDay = days.map((d) => { const rs = rows.filter((r) => r.announced_on === d); return { d, n: rs.length, v: sum(rs.map((r) => r.amount_usd || 0)) }; });
  const maxDay = Math.max(...perDay.map((p) => p.v), 1);
  const hbars = (items, label, color, max = Math.max(...items.map((i) => i.v), 1)) => items.map((i) => `<div class="hb"><span>${label(i)}</span><div class="track"><div class="fill" style="width:${(i.v / max) * 100}%;background:${color(i)}"></div></div><span class="num">${i.v ? usd(i.v) : "–"}</span></div>`).join("");
  const invMap = new Map();
  for (const r of rows) for (const [name, lead] of [...r.leads.map((n) => [n, true]), ...r.investors.map((n) => [n, false])]) {
    const e = invMap.get(name) || { name, n: 0, leads: 0, cos: [] }; e.n++; if (lead) e.leads++; e.cos.push(r); invMap.set(name, e);
  }
  const invs = [...invMap.values()].sort((a, b) => b.n - a.n || b.leads - a.leads).slice(0, 9);
  const top = [...rows].sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0)).slice(0, 20);
  const topMarket = markets[0];
  const range = from.slice(5, 7) === to.slice(5, 7) ? `${Number(from.slice(8))}–${dayMonth(to)}` : `${dayMonth(from)}–${dayMonth(to)}`;
  const body = `
<section class="intro">
  <div class="kind">Weekly data, ${range} ${to.slice(0, 4)}. Updated every morning.</div>
  <h1>Startups announced ${plural(rows.length, "round")} and ${usd(total) || "undisclosed amounts"} in disclosed capital in the last seven days.</h1>
  <p class="lede">Rounds announced between ${longDate(from)} and ${longDate(to)}, across all markets. ${disclosed.length} of ${rows.length} disclosed an amount; totals count disclosed amounts only.</p>
</section>
<div class="kpis">
  <div><span class="num">${usd(total) || "–"}</span><small>Disclosed capital</small></div>
  <div><span class="num">${rows.length}</span><small>Rounds</small></div>
  <div><span class="num">${usd(median(disclosed.map((r) => r.amount_usd))) || "–"}</span><small>Median disclosed round</small></div>
  <div><span class="num">${topMarket ? esc(topMarket.k) : "–"}</span><small>${topMarket ? `Largest market, ${usd(topMarket.v)}` : "Largest market"}</small></div>
</div>
<div class="charts">
  <div><h2>Capital by continent</h2><div class="cap">Disclosed capital. Rounds with no stated country are shown as not stated.</div>
    ${hbars(conts, (c) => `<span class="dot c-${c.k}"></span>${c.name}`, (c) => c.color)}</div>
  <div><h2>Day by day</h2><div class="cap">Disclosed capital per day of announcement.</div>
    <div class="cols">${perDay.map((p) => `<div style="height:${(p.v / maxDay) * 100}%" title="${longDate(p.d)}: ${plural(p.n, "round")}, ${usd(p.v) || "$0"}"><span>${p.n}</span></div>`).join("")}</div>
    <div class="cl">${perDay.map((p) => `<span>${shortDate(p.d)}</span>`).join("")}</div>
    <div class="cap" style="margin-top:10px">Numbers above each bar are round counts.</div></div>
  <div><h2>Capital by stage</h2><div class="cap">Disclosed capital per stage.</div>
    ${hbars(stages, (s) => `${STAGE[s.k]} <small>${s.n}</small>`, () => "var(--ink)")}</div>
  <div><h2>Capital by industry</h2><div class="cap">Ten largest industries by disclosed capital.</div>
    ${hbars(sectors, (s) => `${esc(s.k)} <small>${s.n}</small>`, () => "var(--apac)")}</div>
</div>
<section class="sec"><h2>The twenty largest rounds</h2>${roundsTable(top)}</section>
<section class="sec"><h2>Most active investors</h2><div class="cap">Named investors in this week's rounds. Many reports do not name investors, so counts are a floor.</div>
  <div class="inv">${invs.map((i) => `<div><span class="num">${i.n}</span><b>${esc(i.name)}</b><span>${i.cos.slice(0, 3).map((r) => `<a class="u" href="${r.href}">${esc(r.company)}</a>`).join(", ")}${i.leads ? `, ${plural(i.leads, "lead")}` : ""}</span></div>`).join("")}</div>
</section>
${joinBand()}`;
  return shell({ title: `Startup funding, ${range}: ${plural(rows.length, "round")} | What Got Funded`, desc: `Weekly startup funding data: ${plural(rows.length, "round")} and ${usd(total) || ""} disclosed, by continent, stage and industry.`, active: "Analysis", body, canonical: "/analysis/", scripts: BEEHIIV_SCRIPT });
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

function jobsPage(recent) {
  const body = `
<section class="intro"><h1>Jobs at startups that just raised.</h1>
  <p class="lede">Open roles at companies funded in the last 90 days, each linking to the company's own careers page. Listings start with the next update; until then, here are the companies that raised most recently.</p></section>
<section class="sec"><h2>Raised in the last seven days</h2>${roundsTable(recent.slice(0, 25))}</section>
${joinBand()}`;
  return shell({ title: "Jobs at newly funded startups | What Got Funded", desc: "Open roles at startups that raised funding in the last 90 days.", active: "Jobs", body, canonical: "/jobs/", scripts: BEEHIIV_SCRIPT });
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

  const body = `<div class="narrow prose">
<h1>About What Got Funded</h1>
<p class="lede">What Got Funded curates startup funding news and analyses it. We collect funding rounds reported by news sources around the world, record each one in the same format, and analyse where the money is going by region, market, sector, stage and investor.</p>
<p>We are not a private database and we do not run our own investigations. Every round on this site was reported publicly by a news source, and every entry links to the reports it came from.</p>

<h2>Where the data comes from</h2>
<p>We follow ${read.length} sources in ${markets} markets and ${langs.size} languages, listed in full below, plus ${searches} local-language news searches that pick up funding stories from outlets we do not follow directly. They include startup and technology publications, business newspapers, regional startup media, investor and accelerator news pages, and press-release wires.</p>
<p>We read each source's public feed or funding section, only where the publisher's robots.txt allows it. We never collect paywalled content.</p>

<h2>How we process it</h2>
<ul>
<li>Each funding story is read in full, whatever the language, and its details are recorded in English.</li>
<li>From each story we take the company, what it does, where it is based, the amount and currency, the stage, the lead and other investors, and the founders, using only what the source states. Anything the source does not state is left blank.</li>
<li>Amounts in other currencies are converted to US dollars at the European Central Bank's reference rate on the day.</li>
<li>We add the company's official links (website, LinkedIn, X and careers page) so readers can find the company. The funding details themselves come only from the news reports.</li>
</ul>

<h2>How we curate it</h2>
<ul>
<li>The same round reported by several outlets becomes one entry, with every report listed as a source.</li>
<li>We include equity rounds raised by startups and private growth companies: pre-seed, seed, Series A onwards, growth and strategic investments.</li>
<li>We leave out debt, grants, funds raised by investors, IPOs, acquisitions, secondary sales, private equity buyouts, rumours and talks, old rounds reported again, and reports that do not name the company.</li>
<li>Each round sits on the day it was announced.</li>
</ul>

<h2>How we analyse it</h2>
<p>Once the day's rounds are curated, we analyse them: the total raised, the split by continent and market, the sectors and stages attracting money, the largest rounds and the most active investors. The daily edition covers each day's rounds; the weekly, monthly and longer analyses look at how funding is shifting over time.</p>

<h2>What we may miss</h2>
<p>Because we curate from news sources, our coverage is only as complete as the news. We capture as much as our sources report, and we will still miss some rounds. Some are never announced publicly. Some appear only on social media or in a press release no outlet picks up. Some are reported only behind a paywall. Some details, such as the amount or the investors, are never disclosed and stay blank here. A round can also appear a day or two late when the first coverage comes from a source we read later.</p>
<p>If you know of a round we missed or got wrong, <a href="mailto:dev@hackrlife.com?subject=Missing%20or%20wrong%20round%20on%20What%20Got%20Funded">tell us</a> and we will add or fix it.</p>

<h2>Our sources</h2>
<p>Open a region to see every source we follow there.</p>
</div>
<div class="regcards">
${cards}
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
  write("index.html", homePage(homeDay, byDay.get(homeDay), prevOf(homeDay), nextOf(homeDay), homeDay === yesterday, cards.slice(0, 1).map(editionCard).join("")));
  for (const d of days) write(`day/${d}/index.html`, dayPage(d, byDay.get(d), prevOf(d), nextOf(d)));

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
  write("jobs/index.html", jobsPage([...week].sort((a, b) => b.announced_on.localeCompare(a.announced_on) || (b.amount_usd || 0) - (a.amount_usd || 0))));
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
