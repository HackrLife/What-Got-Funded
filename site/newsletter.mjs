// Builds the daily newsletter (Beehiiv HTML contract) and the four chart images for an edition.
//   node newsletter.mjs 2026-10-18 [outDir]
// Charts are written to public/editions/<day>/ (served by the site and by GitHub raw) and rendered to PNG by render-charts.py.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTINENTS, continentOf, countryLabel } from "./src/regions.mjs";
import { editionModel, charts, startupFacts, usd, NEWSLETTER_MAX } from "./src/edition.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = (process.env.SITE_URL || "https://whatgotfunded.com").replace(/\/$/, "");
const IMG_BASE = process.env.WGF_IMG_BASE || "https://raw.githubusercontent.com/HackrLife/What-Got-Funded/main/site/public";
const day = process.argv[2];
const outDir = process.argv[3] || path.join(ROOT, "data", "newsletter");
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) { console.error("usage: node newsletter.mjs YYYY-MM-DD [outDir]"); process.exit(1); }

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const a = (href, text) => href ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text)}</a>` : "";
const slugify = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "snapshot.json"), "utf8"));
const rows = data.rounds.filter((r) => r.announced_on === day).map((r) => {
  const country = r.hq_country ? countryLabel(r.hq_country) : null;
  return { ...r, country, cont: continentOf(country), amount_usd: r.amount_usd ? Number(r.amount_usd) : null,
    leads: r.leads || [], investors: r.investors || [], founders: r.founders || [], sources: r.sources || [],
    href: `${SITE_URL}/company/${slugify(r.company) || "company"}-${r.company_id}/` };
});
if (!rows.length) { console.error("no rounds for " + day); process.exit(1); }
const overrides = fs.existsSync(path.join(ROOT, "data", "editions.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "editions.json"), "utf8")) : {};
const m = editionModel(day, rows, { continents: CONTINENTS, override: overrides[day] || {} });
const articleUrl = `${SITE_URL}/editions/${day}/`;

// charts: SVG into public/, PNG rendered separately
const imgDir = path.join(ROOT, "public", "editions", day);
fs.mkdirSync(imgDir, { recursive: true });
const c = charts(m);
for (const [k, svg] of Object.entries(c)) fs.writeFileSync(path.join(imgDir, `${k}.svg`), svg);

const img = (k, alt) => `<figure data-type="imageBlock" data-src="${IMG_BASE}/editions/${day}/${k}.png" data-alt="${esc(alt)}" data-align="center" data-width="100%" data-url="${articleUrl}"><figcaption></figcaption></figure>`;
const card = (inner) => `<div class="node-section" data-background-color="#ffffff" data-border-color="#d5dbe3" data-border-style="solid" data-border-width-top="1" data-border-width-right="1" data-border-width-bottom="1" data-border-width-left="1" data-padding-top="16" data-padding-right="18" data-padding-bottom="12" data-padding-left="18" data-margin-bottom="14">${inner}</div>`;

function startup(r) {
  const f = startupFacts(r);
  const founders = r.founders.map((p) => {
    const l = [a(p.linkedin_url, "LinkedIn"), a(p.x_url, "X")].filter(Boolean).join(" · ");
    return `${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ""}${l ? ` ${l}` : ""}`;
  }).join("; ");
  const co = [r.domain && a(`https://${r.domain}`, r.domain), a(r.linkedin_url, "LinkedIn"), a(r.x_url, "X"), a(r.careers_url, "Careers")].filter(Boolean).join(" · ");
  const lines = [
    `<p><strong>${esc(f.amount)}</strong>, ${esc(f.stage)} · ${esc(f.place || "HQ not stated")} · ${esc(r.sector || "Industry not stated")}</p>`,
    f.what ? `<p>${esc(f.what)}</p>` : "",
    f.unique ? `<p><em>What stands out:</em> ${esc(f.unique)}</p>` : "",
    r.leads.length ? `<p><strong>Led by:</strong> ${esc(r.leads.join(", "))}</p>` : "",
    r.investors.length ? `<p><strong>${r.leads.length ? "Also investing" : "Investors"}:</strong> ${esc(r.investors.join(", "))}</p>` : "",
    founders ? `<p><strong>Founders:</strong> ${founders}</p>` : "",
    co ? `<p><strong>Company:</strong> ${co}</p>` : "",
    r.sources[0] ? `<p>Source: ${a(r.sources[0].url, /^google news/i.test(r.sources[0].source || "") ? "Google News" : (r.sources[0].source || "article"))}</p>` : "",
  ].filter(Boolean).join("");
  return card(`<h3>${a(r.href, r.company)}</h3>${lines}`);
}

// group the newsletter picks by region, keeping the article's region order
const groups = m.byRegion.map((g) => ({ ...g, picks: m.newsletter.filter((r) => r.cont === g.k) })).filter((g) => g.picks.length);
const rest = m.rounds.length - m.newsletter.length;
const html = [
  `<p>${esc(m.dek)}</p>`,
  `<h2>The day in four charts</h2>`,
  img("total", `Total funding: ${usd(m.total)}`), img("region", "Funding by region"), img("investors", "Top investors"), img("industry", "Funding by industry"),
  `<h2>${m.newsletter.length} startups to know</h2>`,
  `<p>The largest rounds of the day, with every region represented.${rest > 0 ? ` The other ${rest} are in the full edition.` : ""}</p>`,
  ...groups.flatMap((g) => [`<h2>${esc(g.name)}</h2>`, ...g.picks.map(startup)]),
  `<div class="node-button"><a data-type="button" href="${articleUrl}" data-alignment="center" data-size="large" data-custom-background-color="#172033" data-custom-text-color="#ffffff">See all ${m.rounds.length} rounds</a></div>`,
  `<p>What Got Funded curates startup funding news from more than 300 sources and analyses it. Every round links to where it was reported. ${a("mailto:dev@hackrlife.com?subject=Correction", "Send a correction")}.</p>`,
].join("\n");

fs.mkdirSync(outDir, { recursive: true });
const meta = { day, title: m.headline, subtitle: m.dek, article_url: articleUrl, newsletter_count: m.newsletter.length, total_rounds: m.rounds.length,
  picks: m.newsletter.map((r) => r.company) };
fs.writeFileSync(path.join(outDir, `${day}.html`), html);
fs.writeFileSync(path.join(outDir, `${day}.json`), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2), `\n${html.length} chars`);
