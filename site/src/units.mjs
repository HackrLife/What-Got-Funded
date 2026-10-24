// Shared page blocks: the startup content unit, region tiles, ranked bars, chart cards and the CSV export.
// Used by the home page, day pages, daily editions and the analysis page so every startup looks the same everywhere.
import { CONTINENTS } from "./regions.mjs";
import { cleanFounders, cleanInvestors } from "./edition.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sum = (a) => a.reduce((x, y) => x + y, 0);
export const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
export function usd(v) {
  if (v == null || !isFinite(v) || !v) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
export const STAGE = { pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C", series_d: "Series D",
  series_e: "Series E", series_f_plus: "Series F+", growth: "Growth", strategic: "Strategic", undisclosed: "Stage not stated" };
const shortDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const host = (u) => { try { return new URL(u).hostname.replace(/^(www|m|news|electronics)\./, ""); } catch { return ""; } };
const contOf = (k) => CONTINENTS.find((c) => c.k === k) || CONTINENTS[CONTINENTS.length - 1];
const regionName = (k) => (k === "unknown" ? "Not stated" : contOf(k).name);

export function sourceLabel(s) {
  if (!s) return "";
  if (s.source && !/google news/i.test(s.source) && !/\.[a-z]{2,}$/i.test(s.source)) return s.source;
  return host(s.url) || s.source || "source";
}
export function firstSource(r) {
  const real = (r.sources || []).filter((s) => s.url && !/news\.google\.com/.test(s.url));
  return [...(real.length ? real : r.sources || [])].sort((a, b) => String(a.published_at || "9").localeCompare(String(b.published_at || "9")))[0] || null;
}

// "What makes it different" is dropped when it only repeats the description.
function repeats(a, b) {
  const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  const A = words(a), B = words(b);
  if (!A.size) return true;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / A.size >= 0.6;
}

const ICON = {
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.3-3.6C8.9 5.5 8.4 6.7 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zM16.3 14a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z"/></svg>',
  li: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1-.02-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05C20.6 8.65 21 11.3 21 14.7V21h-4v-5.6c0-1.34-.03-3.06-1.87-3.06-1.87 0-2.16 1.46-2.16 2.96V21H9z"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.6zm-1.1 16.1h1.8L7.7 4.8H5.8z"/></svg>',
  ig: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM12 2c-2.7 0-3.1 0-4.1.06C4.8 2.2 2.2 4.8 2.06 7.9 2 8.9 2 9.3 2 12s0 3.1.06 4.1c.14 3.1 2.74 5.7 5.84 5.84 1 .06 1.4.06 4.1.06s3.1 0 4.1-.06c3.1-.14 5.7-2.74 5.84-5.84.06-1 .06-1.4.06-4.1s0-3.1-.06-4.1C21.8 4.8 19.2 2.2 16.1 2.06 15.1 2 14.7 2 12 2zm0 1.8c2.67 0 3 0 4.04.06 2.2.1 3.99 1.9 4.1 4.1.05 1.04.06 1.37.06 4.04s0 3-.06 4.04c-.1 2.2-1.9 3.99-4.1 4.1-1.04.05-1.37.06-4.04.06s-3 0-4.04-.06c-2.2-.1-3.99-1.9-4.1-4.1C3.81 15 3.8 14.67 3.8 12s0-3 .06-4.04c.1-2.2 1.9-3.99 4.1-4.1C9 3.81 9.33 3.8 12 3.8z"/></svg>',
  yt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.4-1.6.5-4.8.5-4.8s0-3.2-.5-4.8zM9.7 15.1V8.9L15.3 12z"/></svg>',
  gh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4a2 2 0 0 1 2 2v2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4V5a2 2 0 0 1 2-2zm0 4h4V5h-4z"/></svg>',
};
const icon = (kind, url, label) => url ? `<a class="ic" href="${esc(url)}" rel="noopener nofollow" target="_blank" title="${label}" aria-label="${label}">${ICON[kind]}</a>` : "";

// One startup, everything a reader needs, in the same order on every page.
export function startupUnit(r, { href = r.href, day = r.announced_on, heading = "h3" } = {}) {
  const c = contOf(r.cont);
  const founders = cleanFounders(r.founders || []).slice(0, 6);
  const leads = cleanInvestors(r.leads || []);
  const others = cleanInvestors(r.investors || []).filter((n) => !leads.includes(n));
  const amount = usd(r.amount_usd);
  const local = r.amount_usd && r.currency && r.currency !== "USD" && r.amount_text && r.amount_text.length <= 30 ? r.amount_text : "";
  const notDisclosed = !amount ? (r.amount_text && r.amount_text.length <= 40 && !/not|undisclosed|paylaşılmadı/i.test(r.amount_text) ? r.amount_text : "Undisclosed") : "";
  const place = [r.hq_city, r.country].filter(Boolean).join(", ") || "Not stated";
  const s0 = firstSource(r);
  const coLinks = [icon("web", r.domain && `https://${r.domain}`, "Website"), icon("li", r.linkedin_url, "Company LinkedIn"), icon("x", r.x_url, "Company X"),
    icon("ig", r.instagram_url, "Instagram"), icon("yt", r.youtube_url, "YouTube"), icon("gh", r.github_url, "GitHub"), icon("jobs", r.careers_url, "Careers")].join("");
  const fd = founders.length
    ? founders.map((p) => `<li><span class="pn">${esc(p.name)}</span>${p.role ? `<span class="pr">${esc(p.role)}</span>` : ""}<span class="pl">${icon("li", p.linkedin_url, `${p.name} on LinkedIn`)}${icon("x", p.x_url, `${p.name} on X`)}</span></li>`).join("")
    : `<li class="none">Not named in reports yet</li>`;
  const othersShown = others.slice(0, 10);
  const diff = r.highlight && !repeats(r.highlight, r.description) ? r.highlight : "";
  const native = r.company_native && r.company_native !== r.company ? `<span class="native">${esc(r.company_native)}</span>` : "";
  const name = href ? `<a href="${href}">${esc(r.company)}</a>` : esc(r.company);
  return `<article class="unit" id="r-${r.id}" data-c="${r.cont}" style="--c:${c.color}">
  <header class="u-h">
    <div class="who"><${heading}>${name}${native}</${heading}>
      <div class="dom">${r.domain ? `<a href="https://${esc(r.domain)}" rel="noopener nofollow" target="_blank">${esc(r.domain)}</a>` : `<span class="muted">Website not found yet</span>`}${coLinks ? `<span class="icons">${coLinks}</span>` : ""}</div></div>
    <div class="money"><div class="amt${amount ? "" : " na"}">${esc(amount || notDisclosed)}</div><div class="stg">${esc(STAGE[r.stage] || "Stage not stated")}${local ? ` · ${esc(local)}` : ""}</div></div>
  </header>
  ${r.description ? `<p class="what">${esc(r.description)}</p>` : ""}
  ${diff ? `<p class="diff"><b>What makes it different</b>${esc(diff)}</p>` : ""}
  <dl class="facts">
    <div><dt>Based in</dt><dd><i class="dot"></i>${esc(place)}</dd></div>
    <div><dt>Industry</dt><dd>${esc(r.sector || "Not stated")}</dd></div>
    <div><dt>Announced</dt><dd>${esc(shortDay(day))}${s0 ? ` · <a href="${esc(s0.url)}" rel="noopener nofollow" target="_blank">${esc(sourceLabel(s0))}</a>` : ""}</dd></div>
  </dl>
  <div class="people">
    <section><h4>Founders</h4><ul class="fl">${fd}</ul></section>
    <section><h4>Investors</h4>
      ${leads.length ? `<p><span class="tag">Led by</span>${esc(leads.join(", "))}</p>` : ""}
      ${othersShown.length ? `<p><span class="tag alt">With</span>${esc(othersShown.join(", "))}${others.length > othersShown.length ? ` and ${others.length - othersShown.length} more` : ""}</p>` : ""}
      ${!leads.length && !others.length ? `<p class="none">Not disclosed</p>` : ""}
    </section>
  </div>
  ${r.use_of_funds ? `<p class="use"><b>Use of funds</b>${esc(r.use_of_funds)}</p>` : ""}
</article>`;
}

// The compact card: the key facts at a glance. Clicking it opens the full unit in the side panel (app.js);
// the full unit travels inside the card as a <template>, so the panel needs no extra request.
const dayMonth = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export function startupCard(r, opts = {}) {
  const { href = r.href, day = r.announced_on } = opts;
  const c = contOf(r.cont);
  const founders = cleanFounders(r.founders || []);
  const leads = cleanInvestors(r.leads || []);
  const others = cleanInvestors(r.investors || []).filter((n) => !leads.includes(n));
  const amount = usd(r.amount_usd);
  const backers = leads.length ? leads : others;
  const backLabel = leads.length ? "Led by" : "Investors";
  const more = (list, n) => list.length > n ? ` +${list.length - n}` : "";
  const coLinks = [icon("web", r.domain && `https://${r.domain}`, "Website"), icon("li", r.linkedin_url, "Company LinkedIn"), icon("x", r.x_url, "Company X")].join("");
  const full = startupUnit(r, { ...opts, heading: "h2" }).replace(` id="r-${r.id}"`, "");
  return `<article class="card" id="r-${r.id}" data-c="${r.cont}" data-panel style="--c:${c.color}">
  <div class="c-top"><span class="c-where"><i class="dot"></i>${esc(r.country || "Not stated")}</span><span>${esc(dayMonth(day))}</span></div>
  <h3 class="c-name">${href ? `<a href="${href}">${esc(r.company)}</a>` : esc(r.company)}</h3>
  <div class="c-money"><b${amount ? "" : ' class="na"'}>${esc(amount || "Undisclosed")}</b><span>${esc(STAGE[r.stage] || "Stage not stated")}</span></div>
  ${r.description ? `<p class="c-what">${esc(r.description)}</p>` : ""}
  <dl class="c-facts">
    <div><dt>Industry</dt><dd>${esc(r.sector || "Not stated")}</dd></div>
    <div><dt>${backLabel}</dt><dd>${backers.length ? esc(backers[0]) + more(backers, 1) : "Not disclosed"}</dd></div>
    <div><dt>Founders</dt><dd>${founders.length ? esc(founders.slice(0, 2).map((f) => f.name).join(", ")) + more(founders, 2) : "Not named yet"}</dd></div>
  </dl>
  <div class="c-foot"><span class="icons">${coLinks}</span><button type="button" class="c-open">Details<span aria-hidden="true"> →</span></button></div>
  <template class="full">${full}</template>
</article>`;
}

// The list of startups with region chips, a CSV link and progressive loading (app.js reveals 12 at a time).
export function startupList(rows, { title = "Every startup", csv = null, day = null } = {}) {
  const sorted = [...rows].sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0) || a.company.localeCompare(b.company));
  const regs = CONTINENTS.map((c) => ({ ...c, n: rows.filter((r) => r.cont === c.k).length })).filter((c) => c.n);
  const chips = [`<button type="button" class="on" data-f="all">All ${rows.length}</button>`, ...regs.map((c) => `<button type="button" data-f="${c.k}" style="--c:${c.color}"><i class="dot"></i>${esc(regionName(c.k))} ${c.n}</button>`)].join("");
  return `<section class="block list" id="startups">
  <div class="h2row"><h2>${esc(title)}</h2>${csv ? `<a class="csv" href="${csv}" download>${ICON_DL}Download CSV</a>` : ""}</div>
  <div class="chips" role="toolbar" aria-label="Filter by region">${chips}</div>
  <div class="cards" data-page="12">
${sorted.map((r) => startupCard(r, { day: day || r.announced_on })).join("\n")}
  </div>
  <div class="more-wrap"><button type="button" class="more-btn" hidden>Show more startups</button></div>
</section>`;
}
const ICON_DL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 17v3h16v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function byRegion(rows) {
  return CONTINENTS.map((c) => {
    const rs = rows.filter((r) => r.cont === c.k);
    return { ...c, name: regionName(c.k), n: rs.length, v: sum(rs.map((r) => r.amount_usd || 0)), rows: rs };
  }).filter((g) => g.n).sort((a, b) => (a.k === "unknown") - (b.k === "unknown") || b.v - a.v || b.n - a.n);
}

export function regionTiles(rows) {
  const total = sum(rows.map((r) => r.amount_usd || 0)) || 1;
  return `<div class="tiles">${byRegion(rows).map((g) => `<a class="tile" href="#startups" data-f="${g.k}" style="--c:${g.color}">
  <span class="rn">${esc(g.name)}</span><span class="rv">${usd(g.v) || "Undisclosed"}</span>
  <span class="rc">${plural(g.n, "round")}${g.v ? ` · ${Math.round((g.v / total) * 100) || "<1"}% of capital` : ""}</span>
  <span class="track"><span style="width:${Math.max((g.v / total) * 100, 1).toFixed(1)}%"></span></span></a>`).join("")}</div>`;
}

// Ranked horizontal bars: [{label, v, n, color, value?}] → one row each. value overrides the formatted amount.
export function rankBars(items, { unit = "round", fmt = usd, max = null } = {}) {
  const m = max ?? Math.max(...items.map((i) => i.v), 1);
  return `<ul class="rbars">${items.map((i) => `<li style="--c:${i.color || "var(--ink)"}"><span class="cn">${i.dot ? '<i class="dot"></i>' : ""}${esc(i.label)}</span><span class="cb"><span style="width:${Math.max((i.v / m) * 100, i.v ? 1.2 : 0).toFixed(1)}%"></span></span><span class="cv">${i.value ?? (fmt(i.v) || "–")}</span>${i.n != null ? `<span class="cc">${plural(i.n, unit)}</span>` : ""}</li>`).join("")}</ul>`;
}

// One chart card for the analysis grid.
export function chartCard(title, caption, inner, { wide = false } = {}) {
  return `<article class="ccard${wide ? " wide" : ""}"><h3>${esc(title)}</h3>${caption ? `<p class="cap">${esc(caption)}</p>` : ""}<div class="cbody">${inner}</div></article>`;
}

// Stacked 100% bars: rows [{label, parts:[{k,v,color,label}]}]
export function stackBars(rows, legend) {
  return `<div class="stack">${rows.map((r) => {
    const t = sum(r.parts.map((p) => p.v)) || 1;
    return `<div class="srow"><span class="sl">${esc(r.label)}</span><span class="sbar">${r.parts.filter((p) => p.v).map((p) => `<span style="width:${((p.v / t) * 100).toFixed(1)}%;background:${p.color}" title="${esc(p.label)}: ${p.v}"></span>`).join("")}</span></div>`;
  }).join("")}</div>${legend ? `<div class="legend">${legend.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`).join("")}</div>` : ""}`;
}

// Free CSV export: one row per round.
export function roundsCsv(rows, siteUrl) {
  const cols = ["announced_on", "company", "company_local_name", "website", "company_linkedin", "company_x", "careers_page", "country", "city", "region", "industry",
    "stage", "amount_usd", "amount_as_reported", "lead_investors", "other_investors", "founders", "founder_links", "what_it_does", "what_makes_it_different",
    "use_of_funds", "first_reported_by", "first_report_url", "what_got_funded_page"];
  const q = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")];
  for (const r of [...rows].sort((a, b) => a.announced_on.localeCompare(b.announced_on) || (b.amount_usd || 0) - (a.amount_usd || 0))) {
    const f = cleanFounders(r.founders || []), s0 = firstSource(r);
    const leads = cleanInvestors(r.leads || []);
    lines.push([r.announced_on, r.company, r.company_native && r.company_native !== r.company ? r.company_native : "", r.domain ? `https://${r.domain}` : "",
      r.linkedin_url, r.x_url, r.careers_url, r.country, r.hq_city, regionName(r.cont), r.sector, STAGE[r.stage] || "", r.amount_usd ? Math.round(r.amount_usd) : "",
      r.amount_text, leads.join("; "), cleanInvestors(r.investors || []).filter((n) => !leads.includes(n)).join("; "),
      f.map((p) => p.role ? `${p.name} (${p.role})` : p.name).join("; "), f.flatMap((p) => [p.linkedin_url, p.x_url].filter(Boolean)).join(" "),
      r.description, r.highlight, r.use_of_funds, sourceLabel(s0), s0?.url, `${siteUrl}${r.href}`].map(q).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
