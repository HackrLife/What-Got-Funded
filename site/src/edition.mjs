import { startupUnit } from "./units.mjs";
// Daily edition: one model, rendered two ways.
//   - the full article on the site (every round of the day)
//   - the newsletter (Beehiiv): the same headline and four visuals, at most 20 startups, linking to the article
// The four core visuals are plain SVG so they render without JavaScript and can be turned into images for email.
// Editorial rules: docs/editorial-spec.md.

export const NEWSLETTER_MAX = 20;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
export function usd(v) {
  if (v == null || !isFinite(v) || v <= 0) return null;
  if (v >= 1e9) return `$${+(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)}B`;
  if (v >= 1e6) return `$${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
const usdWords = (v) => v >= 1e9 ? `$${+(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)} billion` : v >= 1e6 ? `$${+(v / 1e6).toFixed(1)} million` : usd(v);
const shortDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const longDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(",", "");
export const STAGE = { pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C", series_d: "Series D",
  series_e: "Series E", series_f_plus: "Series F+", growth: "Growth", strategic: "Strategic", undisclosed: "Stage not stated" };
const COUNTRY_SHORT = { "United States": "the US", "United Kingdom": "the UK", "United Arab Emirates": "the UAE", Netherlands: "the Netherlands", Philippines: "the Philippines" };

// Investor names: one entry per firm. Drops original-script duplicates when an English name is listed, and shorter variants of a longer name.
const NON_LATIN = /[぀-ヿ㐀-鿿가-힯؀-ۿ]/;
export function cleanInvestors(list) {
  let l = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  if (l.some((x) => !NON_LATIN.test(x))) l = l.filter((x) => !NON_LATIN.test(x));
  const key = (x) => x.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return l.filter((x) => !l.some((y) => y !== x && key(y).length > key(x).length && key(y).startsWith(key(x) + " ")))
    .filter((x, i, a) => a.findIndex((y) => key(y) === key(x)) === i);
}

// Founders: one entry per person. Original-script duplicates are dropped when a Latin-script name exists;
// the shortest complete role is kept and profile links are merged.
export function cleanFounders(list) {
  const people = (list || []).filter((p) => p && p.name);
  const hasLatin = people.some((p) => !NON_LATIN.test(p.name));
  const key = (n) => n.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
  const out = new Map();
  for (const p of people) {
    if (hasLatin && NON_LATIN.test(p.name)) continue;
    const k = key(p.name) || p.name;
    // near-duplicates such as "Simo Lachdi" / "Simo Lachidi"
    const match = [...out.keys()].find((x) => x === k || (Math.abs(x.length - k.length) <= 1 && [...x].filter((c, i) => c !== k[i]).length <= 2 && x.slice(0, 4) === k.slice(0, 4)));
    const role = p.role && !/[(;]\s*[^)]*$/.test(p.role) ? p.role : (p.role || "").replace(/\s*[(;].*$/, "");
    if (!match) { out.set(k, { ...p, role }); continue; }
    const e = out.get(match);
    if (role && (!e.role || role.length < e.role.length || /co-?founder/i.test(role) && !/co-?founder/i.test(e.role))) e.role = role;
    e.linkedin_url ||= p.linkedin_url; e.x_url ||= p.x_url;
  }
  return [...out.values()];
}
const VAGUE = /not (described|stated)|does not describe|no further detail/i;

// ---------- model ----------
export function editionModel(day, rows, { continents, override = {} } = {}) {
  const fixes = override.rounds || {};
  const rounds = rows.map((r) => {
    const fx = fixes[r.company] || fixes[String(r.id)] || {};
    r = { ...r, ...fx };
    const leads = cleanInvestors(r.leads || []);
    const investors = cleanInvestors(r.investors || []).filter((x) => !leads.includes(x));
    return { ...r, leads, investors, founders: cleanFounders(r.founders), description: VAGUE.test(r.description || "") ? null : r.description };
  }).sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0) || a.company.localeCompare(b.company));
  const disclosed = rounds.filter((r) => r.amount_usd);
  const total = sum(disclosed.map((r) => r.amount_usd));

  const byRegion = continents.map((c) => {
    const rs = rounds.filter((r) => r.cont === c.k);
    return { k: c.k, name: c.k === "unknown" ? "Region not stated" : c.name, color: c.color, n: rs.length, v: sum(rs.map((r) => r.amount_usd || 0)), rows: rs };
  }).filter((g) => g.n).sort((a, b) => (a.k === "unknown") - (b.k === "unknown") || b.v - a.v || b.n - a.n);

  const sectors = new Map();
  for (const r of rounds) { const k = r.sector || "Other"; const e = sectors.get(k) || { name: k, n: 0, v: 0 }; e.n++; e.v += r.amount_usd || 0; sectors.set(k, e); }
  let bySector = [...sectors.values()].map((e) => e.name === "Other" ? { ...e, name: "Not classified" } : e).sort((a, b) => b.v - a.v || b.n - a.n);
  if (bySector.length > 10) { const rest = bySector.slice(9); bySector = [...bySector.slice(0, 9), { name: `${rest.length} other industries`, n: sum(rest.map((e) => e.n)), v: sum(rest.map((e) => e.v)) }]; }

  const inv = new Map();
  for (const r of rounds) for (const [name, lead] of [...r.leads.map((x) => [x, true]), ...r.investors.map((x) => [x, false])]) {
    const e = inv.get(name) || { name, n: 0, leads: 0, v: 0, cos: [] };
    e.n++; if (lead) e.leads++; e.v += r.amount_usd || 0; e.cos.push(r.company); inv.set(name, e);
  }
    // Most active first, then leads, then round value; at most one single-deal investor per round so one syndicate cannot fill the chart.
  const ranked = [...inv.values()].sort((a, b) => b.n - a.n || b.leads - a.leads || b.v - a.v);
  const usedCo = new Set(), topInvestors = [];
  for (const i of ranked) { if (topInvestors.length >= 10) break; if (i.n === 1 && usedCo.has(i.cos[0])) continue; topInvestors.push(i); i.cos.forEach((c) => usedCo.add(c)); }

  const biggest = disclosed[0];
  const headline = override.headline || autoHeadline(day, { biggest, bySector, byRegion, topInvestors, total, rounds });
  const dek = override.dek || `${plural(rounds.length, "startup")} announced funding on ${longDay(day)}, raising ${usd(total) || "undisclosed amounts"} in disclosed capital. ${disclosed.length} of ${rounds.length} disclosed an amount.`;

  return { day, sectorCount: sectors.size, rounds, disclosed, total, byRegion, bySector, topInvestors, headline, dek, newsletter: pickNewsletter(rounds, byRegion) };
}

// Default story: the largest round, unless one sector or one investor clearly dominates the day.
function autoHeadline(day, { biggest, bySector, topInvestors, total }) {
  const d = shortDay(day);
  const inv = topInvestors[0];
  if (inv && inv.n >= 3) return `${d}: ${inv.name} backs ${inv.n} startups in one day`;
  const sec = bySector[0];
  if (sec && total && sec.v / total >= 0.6 && (!biggest || biggest.sector !== sec.name) && sec.n >= 3) return `${d}: ${sec.name} startups take most of the day's funding`;
  if (biggest) {
    const where = biggest.country ? ` from ${COUNTRY_SHORT[biggest.country] || biggest.country}` : "";
    return `${d}: ${biggest.company}${where} leads the day with ${usdWords(biggest.amount_usd)}`;
  }
  return `${d}: ${plural(bySector.reduce((a, s) => a + s.n, 0), "startup")} announce new funding`;
}

// Newsletter: up to 20. Largest disclosed rounds first, but every region with rounds keeps at least one slot (two if it has them).
function pickNewsletter(rounds, byRegion) {
  const picked = new Set();
  for (const g of byRegion.filter((x) => x.k !== "unknown")) for (const r of g.rows.slice(0, Math.min(2, g.rows.length))) picked.add(r);
  for (const r of rounds) { if (picked.size >= NEWSLETTER_MAX) break; picked.add(r); }
  const list = [...picked].slice(0, NEWSLETTER_MAX);
  return rounds.filter((r) => list.includes(r));
}

// ---------- charts (SVG) ----------
const INK = "#172033", MUTED = "#5b6678", LINE = "#d5dbe3", BAR = "#3d5afe";
function hbar({ title, sub, items, w = 720 }) {
  // items: [{ label, value, valueLabel, note, color }]
  const pad = 24, rowH = 34, top = 64, labelW = 210, valW = 210;
  const h = top + items.length * rowH + pad;
  const max = Math.max(...items.map((i) => i.value), 1);
  const barW = w - pad * 2 - labelW - valW;
  const rows = items.map((it, i) => {
    const y = top + i * rowH;
    const bw = Math.max(2, (it.value / max) * barW);
    return `<text x="${pad}" y="${y + 21}" font-size="15" fill="${INK}">${esc(it.label.length > 28 ? it.label.slice(0, 27) + "…" : it.label)}</text>
<rect x="${pad + labelW}" y="${y + 7}" width="${bw.toFixed(1)}" height="20" rx="3" fill="${it.color || BAR}"/>
<text x="${pad + labelW + bw + 8}" y="${y + 22}" font-size="14" font-weight="700" fill="${INK}">${esc(it.valueLabel)}</text>
${it.note ? `<text x="${w - pad}" y="${y + 22}" font-size="13" fill="${MUTED}" text-anchor="end">${esc(it.note)}</text>` : ""}`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" font-family="Archivo, Helvetica, Arial, sans-serif" style="max-width:100%;height:auto">
<rect width="${w}" height="${h}" fill="#fff"/>
<text x="${pad}" y="30" font-size="19" font-weight="700" fill="${INK}">${esc(title)}</text>
${sub ? `<text x="${pad}" y="50" font-size="13" fill="${MUTED}">${esc(sub)}</text>` : ""}
<line x1="${pad}" x2="${w - pad}" y1="${top - 4}" y2="${top - 4}" stroke="${LINE}"/>
${rows}
</svg>`;
}

export function charts(m) {
  const w = 720;
  const largest = m.disclosed[0];
  const totalSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 200" width="${w}" height="200" role="img" aria-label="Total funding" font-family="Archivo, Helvetica, Arial, sans-serif" style="max-width:100%;height:auto">
<rect width="${w}" height="200" fill="#fff"/>
<text x="24" y="30" font-size="19" font-weight="700" fill="${INK}">Total funding</text>
<text x="24" y="50" font-size="13" fill="${MUTED}">Disclosed amounts, in US dollars</text>
<text x="24" y="120" font-size="64" font-weight="800" fill="${INK}">${esc(usd(m.total) || "–")}</text>
<text x="24" y="160" font-size="16" fill="${MUTED}">${esc(`${plural(m.rounds.length, "round")}, ${m.disclosed.length} with a disclosed amount`)}</text>
<line x1="400" x2="400" y1="70" y2="170" stroke="${LINE}"/>
<text x="424" y="92" font-size="13" fill="${MUTED}">Largest round</text>
<text x="424" y="118" font-size="20" font-weight="700" fill="${INK}">${esc(largest ? (largest.company.length > 22 ? largest.company.slice(0, 21) + "…" : largest.company) : "–")}</text>
<text x="424" y="140" font-size="15" fill="${INK}">${esc(largest ? usd(largest.amount_usd) : "")}</text>
<text x="424" y="170" font-size="13" fill="${MUTED}">${esc(`${m.byRegion.length} regions, ${m.sectorCount} industries`)}</text>
</svg>`;
  const region = hbar({ title: "Funding by region", sub: "Disclosed capital, number of rounds on the right", w,
    items: m.byRegion.map((g) => ({ label: g.name, value: g.v || 0.0001, valueLabel: usd(g.v) || "Not disclosed", note: plural(g.n, "round"), color: g.color })) });
  // Ranked by number of rounds, then by the value of the rounds they joined. Bars show the value of those rounds.
  const investors = hbar({ title: "Top investors", sub: "Ranked by rounds backed today, then by round value; bars show the value of rounds joined", w,
    items: m.topInvestors.map((i) => ({ label: i.name, value: i.v || 0.0001, valueLabel: usd(i.v) || "Not disclosed",
      note: `${plural(i.n, "round")}${i.leads ? `, ${i.leads === i.n ? "led" : i.leads + " led"}` : ""}`, color: "#172033" })) });
  const industry = hbar({ title: "Funding by industry", sub: "Disclosed capital, number of rounds on the right", w,
    items: m.bySector.map((s) => ({ label: s.name, value: s.v || 0.0001, valueLabel: usd(s.v) || "Not disclosed", note: plural(s.n, "round"), color: "#00897b" })) });
  return { total: totalSvg, region, investors, industry };
}

// ---------- per-startup block (shared by article and newsletter) ----------
export function startupFacts(r) {
  const amount = r.amount_usd ? usd(r.amount_usd) + (r.currency && r.currency !== "USD" && r.amount_text && r.amount_text.length <= 30 ? ` (${r.amount_text})` : "") : (r.amount_text && r.amount_text.length <= 40 ? r.amount_text : "Amount not disclosed");
  const place = [r.hq_city, r.country].filter(Boolean).join(", ");
  return { amount, stage: STAGE[r.stage] || "Stage not stated", place, what: r.description || "", story: r.summary || "", unique: r.highlight || "", use: r.use_of_funds || "" };
}

// ---------- article (site) ----------
const lk = (href, text) => href ? `<a href="${esc(href)}" rel="noopener" target="_blank">${esc(text)}</a>` : "";
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const srcName = (s) => /^google news/i.test(s.source || "") ? "Google News" : (s.source || host(s.url));

// The earliest source, with its own date: the dateline readers can check
export function firstSource(r) {
  const s = [...(r.sources || [])].filter((x) => x.url).sort((a, b) => String(a.published_at || "9").localeCompare(String(b.published_at || "9")))[0];
  if (!s) return "";
  const d = s.published_at ? ` (${shortDay(String(s.published_at).slice(0, 10))})` : "";
  return `${lk(s.url, srcName(s))}${esc(d)}`;
}

export function startupBlock(r, { level = "h4", companyHref = null } = {}) {
  const f = startupFacts(r);
  const founders = (r.founders || []).map((p) => {
    const ls = [lk(p.linkedin_url, "LinkedIn"), lk(p.x_url, "X")].filter(Boolean).join(" · ");
    return `<li><b>${esc(p.name)}</b>${p.role ? `, ${esc(p.role)}` : ""}${ls ? ` <span class="pl">${ls}</span>` : ""}</li>`;
  }).join("");
  const co = [r.domain && lk(`https://${r.domain}`, r.domain), lk(r.linkedin_url, "LinkedIn"), lk(r.x_url, "X"), lk(r.instagram_url, "Instagram"),
    lk(r.youtube_url, "YouTube"), lk(r.github_url, "GitHub"), lk(r.careers_url, "Careers")].filter(Boolean).join(" · ");
  const seenSrc = new Set();
  const srcs = (r.sources || []).filter((s) => !seenSrc.has(srcName(s)) && seenSrc.add(srcName(s))).map((s) => lk(s.url, srcName(s))).join(" · ");
  const dl = [
    ["Raised", `<b class="num">${esc(f.amount)}</b>, ${esc(f.stage)}`],
    ["Headquarters", esc(f.place || "Not stated")],
    ["Industry", esc(r.sector || "Not stated")],
    r.leads.length ? ["Led by", esc(r.leads.join(", "))] : null,
    r.investors.length ? [r.leads.length ? "Also investing" : "Investors", esc(r.investors.join(", "))] : null,
    f.use ? ["Use of funds", esc(f.use)] : null,
    co ? ["Company", co] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  return `<article class="su" id="r-${r.id}">
  <div class="su-top"><${level}>${companyHref ? `<a href="${companyHref}">${esc(r.company)}</a>` : esc(r.company)}</${level}><span class="chip"><b class="num">${esc(f.amount)}</b> ${esc(f.stage)}</span></div>
  ${f.what ? `<p class="what">${esc(f.what)}</p>` : ""}
  ${f.unique ? `<p class="uq"><b>What stands out:</b> ${esc(f.unique)}</p>` : ""}
  <dl>${dl}</dl>
  ${founders ? `<div class="fd"><b>Founders</b><ul>${founders}</ul></div>` : ""}
  ${f.story ? `<details class="story"><summary>The story</summary><p>${esc(f.story)}</p></details>` : ""}
  ${firstSource(r) ? `<p class="srcs">Announced ${esc(shortDay(r.announced_on))}. First reported by ${firstSource(r)}${(r.sources || []).length > 1 ? `. Also: ${srcs.split(" · ").slice(1).join(" · ")}` : ""}</p>` : ""}
</article>`;
}

export function articleBody(m, { prev, next, countryLabel = (x) => x } = {}) {
  const c = charts(m);
  const toc = m.byRegion.map((g) => `<a href="#reg-${g.k}" style="--c:${g.color}">${esc(g.name)} <small>${g.n}</small></a>`).join("");
  const sections = m.byRegion.map((g) => {
    const byCountry = new Map();
    for (const r of g.rows) { const k = r.country || "Country not stated"; if (!byCountry.has(k)) byCountry.set(k, []); byCountry.get(k).push(r); }
    const subs = [...byCountry.entries()].sort((a, b) => sum(b[1].map((r) => r.amount_usd || 0)) - sum(a[1].map((r) => r.amount_usd || 0)) || b[1].length - a[1].length)
      .map(([country, rs]) => `<section class="ctry"><h3>${esc(country)} <small>${plural(rs.length, "round")}${sum(rs.map((r) => r.amount_usd || 0)) ? `, ${usd(sum(rs.map((r) => r.amount_usd || 0)))}` : ""}</small></h3>
<div class="units all">${rs.map((r) => startupUnit(r, { heading: "h4" })).join("\n")}</div></section>`).join("\n");
    return `<section class="reg" id="reg-${g.k}" style="--c:${g.color}"><h2>${esc(g.name)} <small>${plural(g.n, "round")}${g.v ? `, ${usd(g.v)}` : ""}</small></h2>\n${subs}</section>`;
  }).join("\n");
  return `<article class="ed">
<header class="ed-h">
  <p class="kick">Daily edition · ${esc(longDay(m.day))}</p>
  <h1>${esc(m.headline)}</h1>
  <p class="dek">${esc(m.dek)}</p>
</header>
<section class="viz" aria-label="The day in four charts">
  <figure>${c.total}</figure>
  <figure>${c.region}</figure>
  <figure>${c.investors}</figure>
  <figure>${c.industry}</figure>
</section>
<nav class="ed-toc" aria-label="Regions">${toc}</nav>
${sections}
<nav class="ed-nav">${prev ? `<a href="/editions/${prev}/">Previous edition</a>` : "<span></span>"}<a href="/data/${m.day}.csv" download>Download all ${m.rounds.length} as CSV</a>${next ? `<a href="/editions/${next}/">Next edition</a>` : "<span></span>"}</nav>
</article>`;
}

export function editionCard(m) {
  return `<a class="edcard" href="/editions/${m.day}/">
  <span class="kick">Daily edition · ${esc(longDay(m.day))}</span>
  <b>${esc(m.headline)}</b>
  <span class="dek">${esc(m.dek)}</span>
  <span class="stats"><span><b class="num">${esc(usd(m.total) || "–")}</b> raised</span><span><b class="num">${m.rounds.length}</b> startups</span><span><b class="num">${m.byRegion.length}</b> regions</span></span>
  <span class="more">Read the edition</span>
</a>`;
}
