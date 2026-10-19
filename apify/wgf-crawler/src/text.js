// HTML and feed parsing without dependencies. Deliberately simple and tolerant: news pages are messy.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", euro: "€", pound: "£", yen: "¥" };
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
export const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// ---------- feeds (RSS 2.0 and Atom) ----------
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1]).trim() : "";
}
function attr(block, name, attribute) {
  const m = new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}
export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const link = tag(b, "link") || attr(b, "link", "href") || tag(b, "guid");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    items.push({
      title: stripTags(tag(b, "title")),
      link: link.trim(),
      published_at: date ? toIso(date) : null,
      summary: stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded")).slice(0, 600),
      source_name: stripTags(tag(b, "source")),
      source_url: attr(b, "source", "url"),
    });
  }
  return items;
}

export function toIso(s) {
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ---------- article pages ----------
function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*>`, "i");
    const m = re.exec(html);
    if (m) { const c = /content=["']([^"']*)["']/i.exec(m[0]); if (c && c[1].trim()) return decodeEntities(c[1]).trim(); }
  }
  return "";
}

// Local calendar date as written by the publisher (keeps the publisher's own day, not UTC)
export function localDate(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function jsonLdDates(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const d of m[1].matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) out.push(d[1]);
  }
  return out;
}

export function urlDate(url) {
  const s = String(url);
  let m = /\/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\/|-|$)/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /(?:\/|-|_)(20\d{2})(\d{2})(\d{2})(?:\d{0,8})(?:[/_.-]|$)/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Year and month from URLs like /2026/09/slug (no day). Used to drop old articles that pages re-date.
export function urlMonth(url) {
  const m = /\/(20\d{2})\/(0[1-9]|1[0-2])\/(?!\d{1,2}\/)/.exec(String(url));
  return m ? `${m[1]}-${m[2]}` : null;
}

const SOCIAL = /^(?:www\.)?(linkedin\.com|x\.com|twitter\.com|instagram\.com|facebook\.com|youtube\.com|github\.com|crunchbase\.com|t\.me|tiktok\.com)$/i;
const NOT_COMPANY = /(^|\.)(google|googleusercontent|gstatic|doubleclick|facebook|twitter|x|linkedin|instagram|youtube|youtu|tiktok|apple|wikipedia|wikimedia|amazonaws|cloudfront|wordpress|wp|gravatar|bit|t|ow|lnkd|feedburner|addtoany|sharethis|disqus|cdn|akamaized|jsdelivr|unpkg|cloudflare|gnews|prnewswire|businesswire|globenewswire|newswire|einpresswire|crunchbase|pitchbook|dealroom|tracxn|cbinsights|medium|substack|reddit|whatsapp|telegram|weibo|wechat|qq|baidu|line|naver|kakao|yahoo|bing|msn|archive|mailto|apple)\.[a-z.]+$/i;

export function parseArticle(html, pageUrl) {
  const base = (() => { try { return new URL(pageUrl); } catch { return null; } })();
  const lang = (/<html[^>]*\blang=["']?([a-zA-Z-]+)/i.exec(html) || [])[1] || meta(html, ["og:locale"]) || "";
  const title = meta(html, ["og:title", "twitter:title"]) || stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");
  const canonical = (/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html) || [])[1] || "";
  const publishedRaw = meta(html, ["article:published_time", "og:published_time", "datePublished", "pubdate", "publishdate", "date", "DC.date.issued", "sailthru.date", "parsely-pub-date"])
    || jsonLdDates(html)[0]
    || (/<time[^>]+datetime=["']([^"']+)["']/i.exec(html) || [])[1]
    || "";
  const published_on = localDate(publishedRaw) || urlDate(canonical || pageUrl);
  const date_basis = publishedRaw ? "page_metadata" : urlDate(canonical || pageUrl) ? "url" : null;

  // main text: prefer <article>, else all paragraphs; drop chrome
  let body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const art = /<article\b[\s\S]*?<\/article>/i.exec(body);
  const scope = art && stripTags(art[0]).length > 400 ? art[0] : body;
  const paras = [...scope.matchAll(/<(p|h2|h3|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => stripTags(m[2])).filter((t) => t.length > 30);
  let text = paras.join("\n");
  if (text.length < 300) text = stripTags(scope);

  // links: outbound company candidates and social profiles
  const outbound = new Map(), socials = new Set();
  for (const m of scope.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decodeEntities(m[1]), base || undefined); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (SOCIAL.test(host)) { socials.add(u.href.split("?")[0]); continue; }
    if (base && host === base.hostname.replace(/^www\./, "")) continue;
    if (NOT_COMPANY.test(host)) continue;
    const anchor = stripTags(m[2]).slice(0, 80);
    if (!outbound.has(host)) outbound.set(host, anchor);
  }
  return {
    title, lang: lang.toLowerCase().slice(0, 5), canonical, published_raw: publishedRaw || null, published_on, date_basis,
    text: text.slice(0, 9000),
    outbound: [...outbound.entries()].slice(0, 25).map(([domain, anchor]) => ({ domain, anchor })),
    socials: [...socials].slice(0, 30),
  };
}

// Same-site article links from a listing page
export function listingLinks(html, pageUrl) {
  const base = new URL(pageUrl), host = base.hostname.replace(/^www\./, ""), out = new Map();
  const clean = html.replace(/<(script|style|noscript|svg|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
  for (const m of clean.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    if (u.hostname.replace(/^www\./, "") !== host || !/^https?:$/.test(u.protocol)) continue;
    const text = stripTags(m[2]);
    if (text.length < 12) continue;
    const segs = u.pathname.split("/").filter(Boolean), last = segs[segs.length - 1] || "";
    const articleLike = last.length >= 20 || /\d{4,}/.test(u.pathname) || (last.match(/-/g) || []).length >= 3;
    if (!articleLike) continue;
    const key = u.origin + u.pathname;
    if (!out.has(key) || out.get(key).length < text.length) out.set(key, text);
  }
  return [...out.entries()].map(([url, title]) => ({ url, title }));
}

// Company website: socials, people links, careers page
export function parseCompanySite(html, pageUrl) {
  const base = new URL(pageUrl);
  const description = meta(html, ["og:description", "description", "twitter:description"]);
  const title = meta(html, ["og:site_name", "og:title"]) || stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");
  const socials = {}, people = [], pages = new Set();
  let careers = null;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    const host = u.hostname.replace(/^www\./, "").toLowerCase(), p = u.pathname.replace(/\/+$/, "");
    const text = stripTags(m[2]);
    if (host === "linkedin.com" && /^\/company\//.test(p)) socials.linkedin ??= `https://www.linkedin.com${p}`;
    else if (host === "linkedin.com" && /^\/in\//.test(p)) people.push({ linkedin: `https://www.linkedin.com${p}`, label: text.slice(0, 60) });
    else if ((host === "x.com" || host === "twitter.com") && /^\/[A-Za-z0-9_]{1,15}$/.test(p) && !/^\/(intent|share|home)$/i.test(p)) socials.x ??= `https://x.com${p}`;
    else if (host === "instagram.com" && /^\/[^/]+$/.test(p) && !/^\/(p|reel|explore|accounts)$/.test(p)) socials.instagram ??= `https://www.instagram.com${p}`;
    else if (host === "youtube.com" && /^\/(@[^/]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+)$/.test(p)) socials.youtube ??= `https://www.youtube.com${p}`;
    else if (host === "github.com" && /^\/[^/]+$/.test(p)) socials.github ??= `https://github.com${p}`;
    else if (host === "facebook.com" && /^\/[^/]+$/.test(p) && !/^\/(sharer|share|dialog|plugins|watch)(\.php)?$/.test(p)) socials.facebook ??= `https://www.facebook.com${p}`;
    if (host === base.hostname.replace(/^www\./, "") || host.endsWith("." + base.hostname.replace(/^www\./, ""))) {
      if (/(^|\/)(about|team|company|leadership|founders|our-team|who-we-are|people)(\/|$)/i.test(p)) pages.add(u.origin + u.pathname);
      if (!careers && /(^|\/)(careers|jobs|join-us|work-with-us)(\/|$)/i.test(p)) careers = u.origin + u.pathname;
    }
    if (!careers && /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|teamtailor\.com|personio\.)/.test(host)) careers = u.href;
  }
  return { title, description: description.slice(0, 400), socials, people: people.slice(0, 20), about_pages: [...pages].slice(0, 3), careers_url: careers };
}
