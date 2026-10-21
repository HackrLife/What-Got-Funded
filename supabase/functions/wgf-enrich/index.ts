// What Got Funded — link finder (n8n section 2b)
//
// POST /functions/v1/wgf-enrich   (header: x-wgf-token)
//   { "mode": "targets", "days"?: 3 }
//     → { queries: [{ key, query }] } for live rounds announced in the last `days` days whose company website,
//        company LinkedIn/X or founder LinkedIn/X is missing and has not been searched in the last 30 days.
//   { "mode": "save", "items": [{ key, results: [{ url, title, description }] }] }
//     → picks the matching link from each Google result list, stores it, and logs every search.
//
// Only public profile URLs are stored; profiles are never fetched or scraped. A link is accepted only when the
// result's title carries the name (and, for people, the company); short or generic names need extra proof.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NON_LATIN = /[぀-ヿ㐀-鿿가-힯؀-ۿЀ-ӿ֐-׿฀-๿]/;
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["inc", "ltd", "llc", "the", "co", "corp", "gmbh", "sa", "ag", "bv", "limited", "company", "technology", "technologies", "tech",
  "group", "holdings", "solutions", "shanghai", "beijing", "shenzhen", "hangzhou", "nanjing", "guangzhou", "zhejiang", "keji", "co ltd"]);
const nameTokens = (s: string) => norm(s.replace(/\(.*?\)/g, " ")).split(" ").filter((t) => t.length > 1 && !STOP.has(t));
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const label = (domain: string | null) => (domain ? domain.replace(/^(www|app)\./, "").split(".")[0] : "");
const quoted = (s: string) => `"${s.replace(/"/g, "")}"`;

type Co = { id: number; name: string; domain: string | null; country: string | null; linkedin_url: string | null; x_url: string | null };

async function targets(body: Record<string, unknown>) {
  const days = Math.min(Math.max(Number(body.days) || 3, 1), 30);
  const cos = await sql`
    select distinct c.id, coalesce(c.name_en, c.name) as name, c.domain, c.hq_country as country, c.linkedin_url, c.x_url
    from wgf.rounds r join wgf.companies c on c.id = r.company_id
    where r.status = 'live' and r.announced_on >= current_date - ${days}::int
      and coalesce(c.name_en, c.name) !~* '(unnamed|undisclosed|stealth)'`;
  const people = await sql`
    select distinct p.id, coalesce(p.name_en, p.name) as name, p.linkedin_url, p.x_url, c.id as cid, coalesce(c.name_en, c.name) as company, c.domain
    from wgf.rounds r join wgf.companies c on c.id = r.company_id join wgf.company_people cp on cp.company_id = c.id join wgf.people p on p.id = cp.person_id
    where r.status = 'live' and r.announced_on >= current_date - ${days}::int`;
  const done = new Set((await sql`select key from wgf.link_searches where searched_at > now() - interval '30 days'`).map((r) => r.key as string));
  const q: { key: string; query: string }[] = [];
  const add = (key: string, query: string) => { if (!done.has(key) && !q.some((x) => x.key === key)) q.push({ key, query }); };
  for (const c of cos as unknown as Co[]) {
    if (NON_LATIN.test(c.name) || !nameTokens(c.name).length) continue;
    const country = c.country ?? "";
    if (!c.domain) add(`co:dom:${c.id}`, `${quoted(c.name)} ${country} startup official website`.replace(/\s+/g, " "));
    if (!c.linkedin_url) add(`co:li:${c.id}`, `site:linkedin.com/company ${quoted(c.name)}${c.domain ? ` OR ${quoted(c.domain)}` : ""}`);
    if (!c.x_url) add(`co:x:${c.id}`, `site:x.com ${quoted(c.name)}${c.domain ? ` ${c.domain}` : ` ${country}`}`.trim());
  }
  const seenPerson = new Set<string>();
  for (const p of people) {
    const name = String(p.name);
    if (NON_LATIN.test(name) || nameTokens(name).length < 2) continue;
    const k = `${norm(name)}|${p.cid}`;
    if (seenPerson.has(k)) continue;   // the same founder stored twice
    seenPerson.add(k);
    const company = NON_LATIN.test(String(p.company)) ? "" : String(p.company);
    if (!p.linkedin_url) add(`p:li:${p.id}:${p.cid}`, `site:linkedin.com/in ${quoted(name)} ${company ? quoted(company) : ""}`.trim());
    if (!p.x_url) add(`p:x:${p.id}:${p.cid}`, `site:x.com ${quoted(name)} ${company}`.trim());
  }
  return { days, count: q.length, queries: q.slice(0, 400) };
}

// ---------- matching ----------
type Result = { url: string; title?: string; description?: string };
const NOT_OWN_SITE = /(^|\.)(linkedin|facebook|twitter|x|instagram|youtube|wikipedia|crunchbase|pitchbook|tracxn|dealroom|cbinsights|bloomberg|reuters|techcrunch|forbes|businesswire|prnewswire|globenewswire|medium|github|apple|google|glassdoor|indeed|zoominfo|rocketreach|owler|craft|f6s|angel|wellfound|36kr|qcc|tianyancha|baike|zhihu|weibo|sina|sohu|163|qq|naver|daum|nikkei|prtimes|yahoo|msn|ycombinator|producthunt|g2|capterra|trustpilot|amazon|similarweb|economictimes|inc42|yourstory|entrackr|vccircle|sifted|eu-startups|finsmes|substack|tiktok|reddit|quora|bebee|apollo|leadiq|signalhire|clay|golden|growjo|getlatka)\.[a-z.]+$/i;

// Title holds every name token, in order-insensitive form. Short single-word names (Town, Trace, Ayan) need extra proof.
function nameIn(text: string, name: string) {
  const t = ` ${norm(text)} `;
  const toks = nameTokens(name);
  return toks.length > 0 && toks.every((x) => t.includes(` ${x} `) || t.includes(` ${x}`));
}
const shortName = (name: string) => { const t = nameTokens(name); return t.length === 1 && t[0].length <= 6; };

function pickCompanyProfile(kind: "li" | "x", c: Co, results: Result[]) {
  for (const r of results.slice(0, 8)) {
    const u = String(r.url ?? ""), h = host(u);
    let handle = "";
    if (kind === "li") {
      const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(u); if (!m || !/linkedin\.com$/.test(h)) continue; handle = m[1];
    } else {
      const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,15})\/?(?:[?#].*)?$/i.exec(u);
      if (!m || ["i", "home", "search", "hashtag", "intent", "share"].includes(m[1].toLowerCase())) continue; handle = m[1];
    }
    const title = String(r.title ?? ""), text = `${title} ${r.description ?? ""}`;
    const slugMatch = norm(handle).replace(/ /g, "") === nameTokens(c.name).join("") || (c.domain && norm(handle).replace(/ /g, "") === label(c.domain).replace(/-/g, ""));
    if (!nameIn(title, c.name) && !slugMatch) continue;
    // generic short names must also show the domain, or the slug must be the name and the country appear
    if (shortName(c.name)) {
      const proof = (c.domain && norm(text).includes(norm(label(c.domain)))) || (slugMatch && c.country && norm(text).includes(norm(c.country)));
      if (!proof && !(c.domain && slugMatch)) continue;
    }
    return kind === "li" ? `https://www.linkedin.com/company/${handle}` : `https://x.com/${handle}`;
  }
  return null;
}

function pickDomain(c: Co, results: Result[]) {
  const want = nameTokens(c.name), compact = want.join("");
  for (const r of results.slice(0, 6)) {
    const d = host(String(r.url ?? ""));
    if (!d || NOT_OWN_SITE.test(d)) continue;
    const l = d.split(".").slice(0, -1).join("").replace(/-/g, "");
    const close = l === compact || ((l.startsWith(compact) || l.endsWith(compact)) && l.length - compact.length <= 6)
      || (compact.startsWith(l) && l.length >= 5 && compact.length - l.length <= 6);
    if (compact && close) return d;
  }
  return null;
}

function pickPerson(kind: "li" | "x", person: string, company: string, domain: string | null, results: Result[]) {
  for (const r of results.slice(0, 8)) {
    const u = String(r.url ?? ""), h = host(u);
    let url = "";
    if (kind === "li") {
      const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(u); if (!m || !/linkedin\.com$/.test(h)) continue; url = `https://www.linkedin.com/in/${m[1]}`;
    } else {
      const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,15})\/?(?:[?#].*)?$/i.exec(u); if (!m) continue; url = `https://x.com/${m[1]}`;
    }
    const title = String(r.title ?? ""), text = `${title} ${r.description ?? ""}`;
    if (!nameIn(title, person)) continue;
    const coOk = (company && nameIn(text, company)) || (domain && norm(text).includes(norm(label(domain))));
    if (!coOk) continue;
    return url;
  }
  return null;
}

async function save(body: Record<string, unknown>) {
  const items = (Array.isArray(body.items) ? body.items : []) as { key: string; query?: string; results: Result[] }[];
  const out = { received: items.length, websites: 0, company_linkedin: 0, company_x: 0, founder_linkedin: 0, founder_x: 0, skipped_empty: 0 };
  for (const it of items) {
    const key = String(it.key ?? ""), results = Array.isArray(it.results) ? it.results : [];
    if (!results.length) { out.skipped_empty++; continue; }   // the search did not run: try again next time
    const [kind, field, a, b] = key.split(":");
    let found: string | null = null;
    if (kind === "co") {
      const [c] = await sql`select id, coalesce(name_en, name) as name, domain, hq_country as country, linkedin_url, x_url from wgf.companies where id = ${Number(a)}`;
      if (!c) continue;
      if (field === "dom") {
        found = pickDomain(c as unknown as Co, results);
        if (found) {
          const [taken] = await sql`select id from wgf.companies where domain = ${found} and id <> ${c.id}`;
          if (taken) found = null;
        }
        if (found) { await sql`update wgf.companies set domain = coalesce(domain, ${found}), domain_checked_at = now(), updated_at = now() where id = ${c.id}`; out.websites++; }
      } else {
        found = pickCompanyProfile(field as "li" | "x", c as unknown as Co, results);
        if (found && field === "li") { await sql`update wgf.companies set linkedin_url = coalesce(linkedin_url, ${found}), updated_at = now() where id = ${c.id}`; out.company_linkedin++; }
        if (found && field === "x") { await sql`update wgf.companies set x_url = coalesce(x_url, ${found}), updated_at = now() where id = ${c.id}`; out.company_x++; }
      }
    } else if (kind === "p") {
      const [p] = await sql`select p.id, coalesce(p.name_en, p.name) as name, coalesce(c.name_en, c.name) as company, c.domain
                            from wgf.people p, wgf.companies c where p.id = ${Number(a)} and c.id = ${Number(b)}`;
      if (!p) continue;
      found = pickPerson(field as "li" | "x", p.name, p.company, p.domain, results);
      if (found) {
        // the same person may be stored more than once for this company: give every copy the link
        const ids = (await sql`select p2.id from wgf.people p2 join wgf.company_people cp on cp.person_id = p2.id
                               where cp.company_id = ${Number(b)} and lower(coalesce(p2.name_en, p2.name)) = lower(${p.name})`).map((r) => Number(r.id));
        if (field === "li") { await sql`update wgf.people set linkedin_url = coalesce(linkedin_url, ${found}), verified_by = coalesce(verified_by, 'search') where id = any(${ids})`; out.founder_linkedin++; }
        else { await sql`update wgf.people set x_url = coalesce(x_url, ${found}), verified_by = coalesce(verified_by, 'search') where id = any(${ids})`; out.founder_x++; }
      }
    }
    await sql`insert into wgf.link_searches (key, query, searched_at, found_url, candidates)
              values (${key}, ${String(it.query ?? "")}, now(), ${found}, ${sql.json(results.slice(0, 5).map((r) => ({ url: r.url, title: r.title })) as never)})
              on conflict (key) do update set searched_at = now(), found_url = excluded.found_url, candidates = excluded.candidates`;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "targets") return json(await targets(body));
    if (body.mode === "save") return json(await save(body));
    return json({ error: "mode must be targets or save" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
