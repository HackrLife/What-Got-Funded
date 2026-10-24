// What Got Funded — jobs agent (n8n section 2c)
//
// POST /functions/v1/wgf-jobs   (header: x-wgf-token)
//   { "mode": "targets", "limit"?: 60 }
//     → companies that raised in the last 365 days and have no known job board, each with one web-search query that
//       looks for the company on the public job-board hosts. Each company is searched at most once every 30 days.
//   { "mode": "boards", "items": [{ "company_id": 1, "organic": [{ "link", "title", "snippet" }] }] }
//     → reads the board links in each company's search results, opens the board's public feed and keeps it only when
//       the board belongs to the company. Stores the board and its open roles.
//   { "mode": "feed_targets" }
//     → company domains for the Fantastic.jobs feed: { backfill: [...never sent], daily: [...sent before] }. Companies whose own
//       board we already read are left out (their roles are free from the board).
//   { "mode": "ingest", "source": "fantastic" | "wwr", "items": [...], "mark_domains"?: [...] }
//     → stores feed roles at funded companies. Fantastic.jobs rows match by company domain; We Work Remotely rows by exact
//       company name. Feed roles close on their valid-through date, or 45 days after posting.
//   { "mode": "run", "limit"?: 20 }
//     → refreshes the open roles of every known board once a day (plus boards linked from a company's careers page).
//
// Only each company's own public job feed is read: the same feed the company embeds on its careers page.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const UA = { "user-agent": "WhatGotFundedBot/1.0 (+https://whatgotfunded.com/about/)", accept: "application/json" };

type Job = { external_id: string; title: string; team?: string | null; location?: string | null; remote?: boolean; employment_type?: string | null; posted_on?: string | null; url: string; text?: string };
type Board = { source: string; slug: string; name?: string | null; jobs: Job[] };

async function getJson(url: string) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
const day = (v: unknown) => { if (!v) return null; const d = typeof v === "number" ? new Date(v) : new Date(String(v)); return isNaN(+d) ? null : d.toISOString().slice(0, 10); };
const strip = (h: unknown) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").slice(0, 4000);

const ATS: Record<string, (slug: string) => Promise<Board | null>> = {
  async greenhouse(slug) {
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!d?.jobs) return null;
    return { source: "greenhouse", slug, name: meta?.name ?? null, jobs: d.jobs.map((j: any) => ({ external_id: `gh-${j.id}`, title: j.title, team: j.departments?.[0]?.name ?? null,
      location: j.location?.name ?? null, posted_on: day(j.first_published ?? j.updated_at), url: j.absolute_url, text: strip(j.content) })) };
  },
  async lever(slug) {
    const d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!Array.isArray(d)) return null;
    return { source: "lever", slug, jobs: d.map((j: any) => ({ external_id: `lv-${j.id}`, title: j.text, team: j.categories?.team ?? null, location: j.categories?.location ?? null,
      remote: j.workplaceType === "remote", employment_type: j.categories?.commitment ?? null, posted_on: day(j.createdAt), url: j.hostedUrl, text: String(j.descriptionPlain ?? "").slice(0, 4000) })) };
  },
  async ashby(slug) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`);
    if (!d?.jobs) return null;
    return { source: "ashby", slug, jobs: d.jobs.filter((j: any) => j.isListed !== false).map((j: any) => ({ external_id: `ab-${j.id}`, title: j.title, team: j.team ?? j.department ?? null,
      location: j.location ?? null, remote: j.isRemote === true || j.workplaceType === "Remote", employment_type: j.employmentType ?? null, posted_on: day(j.publishedAt), url: j.jobUrl, text: String(j.descriptionPlain ?? "").slice(0, 4000) })) };
  },
  async workable(slug) {
    const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
    if (!d?.jobs) return null;
    return { source: "workable", slug, name: d.name ?? null, jobs: d.jobs.map((j: any) => ({ external_id: `wk-${j.shortcode}`, title: j.title, team: j.department ?? null,
      location: [j.city, j.country].filter(Boolean).join(", ") || null, remote: j.telecommuting === true, employment_type: j.employment_type ?? null, posted_on: day(j.published_on ?? j.created_at), url: j.url ?? j.shortlink })) };
  },
  async smartrecruiters(slug) {
    const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
    if (!d?.content) return null;
    return { source: "smartrecruiters", slug, name: d.content[0]?.company?.name ?? null, jobs: d.content.map((j: any) => ({ external_id: `sr-${j.id}`, title: j.name, team: j.department?.label ?? null,
      location: [j.location?.city, j.location?.country?.toUpperCase?.()].filter(Boolean).join(", ") || null, remote: j.location?.remote === true, employment_type: j.typeOfEmployment?.label ?? null,
      posted_on: day(j.releasedDate), url: `https://jobs.smartrecruiters.com/${slug}/${j.id}` })) };
  },
  async recruitee(slug) {
    const d = await getJson(`https://${slug}.recruitee.com/api/offers/`);
    if (!d?.offers) return null;
    return { source: "recruitee", slug, name: d.offers[0]?.company_name ?? null, jobs: d.offers.map((j: any) => ({ external_id: `rc-${j.id}`, title: j.title, team: j.department ?? null,
      location: j.location ?? null, remote: j.remote === true, employment_type: j.employment_type_code ?? null, posted_on: day(j.published_at ?? j.created_at), url: j.careers_url, text: strip(j.description) })) };
  },
  async personio(slug) {
    let x = "";
    try { const r = await fetch(`https://${slug}.jobs.personio.de/xml?language=en`, { headers: { "user-agent": UA["user-agent"] }, signal: AbortSignal.timeout(10000) }); if (!r.ok) return null; x = await r.text(); } catch { return null; }
    if (!/<workzag-jobs|<position>/i.test(x)) return null;
    const tag = (b: string, t: string) => { const m = new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, "i").exec(b); return m ? m[1].trim() : null; };
    const jobs = [...x.matchAll(/<position>([\s\S]*?)<\/position>/gi)].map((m) => {
      const b = m[1], id = tag(b, "id");
      return { external_id: `ps-${id}`, title: tag(b, "name") ?? "", team: tag(b, "department"), location: tag(b, "office"), employment_type: tag(b, "employmentType") ?? tag(b, "schedule"),
        posted_on: day(tag(b, "createdAt")), url: `https://${slug}.jobs.personio.de/job/${id}`, text: strip(tag(b, "value")) };
    }).filter((j) => j.external_id !== "ps-null");
    return { source: "personio", slug, jobs };
  },
};

// A job-board link → [hiring system, board name]. Works for search-result links and careers-page links.
const BAD_SLUG = /^(embed|api|v1|jobs|job|careers|search|www|app|login|signin|en|de|fr)$/i;
function atsFromUrl(u: unknown): [string, string] | null {
  const url = String(u ?? "");
  const pats: [string, RegExp][] = [
    ["greenhouse", /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i],
    ["lever", /\/\/jobs\.lever\.co\/([\w.-]+)/i],
    ["ashby", /jobs\.ashbyhq\.com\/([\w.%-]+)/i],
    ["workable", /apply\.workable\.com\/([\w-]+)/i],
    ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i],
    ["recruitee", /\/\/([\w-]+)\.recruitee\.com/i],
    ["personio", /\/\/([\w-]+)\.jobs\.personio\.(?:de|com)/i],
  ];
  for (const [src, re] of pats) { const m = re.exec(url); if (m && !BAD_SLUG.test(m[1])) return [src, decodeURIComponent(m[1])]; }
  return null;
}
const compact = (s: unknown) => norm(s).replace(/ /g, "");
const cleanName = (n: string) => norm(n.replace(/\(.*?\)/g, "")).replace(/\b(inc|ltd|llc|limited|gmbh|pte|pty|corp|corporation|technologies|labs)\b/g, "").trim();

// The board belongs to this company: its name matches, or a posting names the company or its domain.
function owns(b: Board, c: { name: string; domain: string | null }) {
  const name = norm(c.name.replace(/\(.*?\)/g, "")), label = c.domain ? norm(c.domain.split(".")[0]) : "";
  if (b.name && (norm(b.name) === name || norm(b.name).startsWith(name + " ") || name.startsWith(norm(b.name) + " ") || (label && norm(b.name).replace(/ /g, "") === label.replace(/ /g, "")))) return true;
  if (!b.jobs.length) return false;
  const texts = b.jobs.slice(0, 5).map((j) => ` ${norm(`${j.text ?? ""} ${j.url}`)} `);
  const hits = texts.filter((t) => (name.length >= 4 && t.includes(` ${name} `)) || (label.length >= 4 && t.includes(label))).length;
  return hits >= Math.min(2, texts.length);
}

// ---------- classification ----------
const FUNC: [string, RegExp][] = [
  ["devrel", /developer relations|devrel|developer advocate|developer evangelist|community engineer/i],
  ["engineering", /engineer|developer|\bcto\b|architect|devops|\bsre\b|machine learning|\bml\b|data scien|software|firmware|technical lead|tech lead|research scientist|scientist/i],
  ["marketing", /marketing|\bgrowth\b|brand|content|\bseo\b|demand gen|communications|\bpr\b|social media|\bcmo\b|community/i],
  ["sales", /sales|account executive|\bae\b|business development|\bbdr\b|\bsdr\b|partnership|go-to-market|\bgtm\b|revenue|\bcro\b|commercial/i],
  ["finance", /finance|\bcfo\b|controller|accountant|accounting|fp&a|treasury/i],
  ["product", /product manager|product lead|head of product|\bcpo\b|product owner|vp,? product/i],
  ["design", /design|\bux\b|\bui\b/i],
  ["people", /recruit|talent|\bpeople\b|\bhr\b|human resources/i],
  ["customer", /customer success|customer support|support|solutions|implementation|onboarding/i],
  ["operations", /operations|chief of staff|\bcoo\b|bizops|strategy|general manager|country manager|managing director/i],
];
const funcOf = (t: string) => (FUNC.find(([, re]) => re.test(t)) ?? ["other"])[0];
function seniorityOf(t: string) {
  t = t.replace(/member of (the )?technical staff/ig, "");   // a title, not a level
  if (/\bchief of staff\b/i.test(t)) return "lead";
  if (/\b(chief|cto|cfo|coo|cmo|cpo|cro|ceo)\b/i.test(t)) return "c_level";
  if (/\b(vp|vice president|svp|evp)\b/i.test(t)) return "vp";
  if (/\bhead of\b|\bhead,|general manager|country manager|managing director/i.test(t)) return "head";
  if (/\bdirector\b/i.test(t)) return "director";
  if (/\b(lead|principal|staff|founding)\b/i.test(t)) return "lead";
  return "ic";
}
const RANK: Record<string, number> = { c_level: 5, vp: 4, head: 4, director: 3, lead: 2, ic: 0 };
const EARLY = new Set(["pre_seed", "seed", "series_a"]);
const isRemote = (j: Job) => j.remote === true || /remote|anywhere|distributed|work from home/i.test(`${j.location ?? ""} ${j.title}`);
const isFractional = (j: Job) => /part[- ]?time|contract|freelance|temporary|interim|fractional|consult/i.test(`${j.employment_type ?? ""} ${j.title}`) || /\b(fractional|interim|advisor)\b/i.test(j.title);
const JUNIOR = /\b(intern|internship|junior|graduate|trainee|apprentice|working student|werkstudent|praktikum|student)\b/i;

type StoreOpts = { close?: boolean; solo?: boolean; via?: string | null; expires?: (j: Job) => string | null };
async function storeBoard(c: Record<string, any>, b: Board, o: StoreOpts = {}) {
  const close = o.close !== false, solo = o.solo !== false;
  const jobs = b.jobs.filter((j) => j.title && j.url && !JUNIOR.test(j.title));
  const perFunc = new Map<string, number>();
  for (const j of jobs) { const f = funcOf(j.title); perFunc.set(f, (perFunc.get(f) ?? 0) + 1); }
  const seen: number[] = [];
  for (const j of jobs) {
    const fn = funcOf(j.title), sen = seniorityOf(j.title);
    const early = EARLY.has(String(c.stage));
    const founding = /\bfounding\b|\bfirst\b|#1\b/i.test(j.title) || (early && ((solo && perFunc.get(fn) === 1 && fn !== "other") || RANK[sen] >= 3));
    const remote = isRemote(j), fractional = isFractional(j);
    const key = founding || RANK[sen] >= 3 || (fractional && fn !== "other") || (remote && RANK[sen] >= 2);
    const posted = j.posted_on ?? null;
    const fresh = posted ? Math.max(0, 30 - (Date.now() - Date.parse(posted)) / 864e5) / 30 : 0.3;
    const score = (founding ? 3 : 0) + RANK[sen] + (remote ? 0.5 : 0) + (fractional ? 0.5 : 0) + fresh * 2 + Math.log10(Math.max(Number(c.amount_usd) || 1e6, 1e6)) - 6;
    const [row] = await sql`insert into wgf.jobs (company_id, round_id, source, external_id, title, team, function, seniority, founding, remote, fractional, employment_type, location, posted_on, url, key_role, score, active, last_seen_at, expires_on, via)
      values (${c.id}, ${c.round_id}, ${b.source}, ${j.external_id}, ${j.title.slice(0, 200)}, ${j.team ?? null}, ${fn}, ${sen}, ${founding}, ${remote}, ${fractional}, ${j.employment_type ?? null},
              ${j.location ? String(j.location).slice(0, 200) : null}, ${posted}, ${j.url}, ${key}, ${+score.toFixed(3)}, true, now(), ${o.expires ? o.expires(j) : null}, ${o.via ?? null})
      on conflict (source, external_id) do update set title = excluded.title, team = excluded.team, function = excluded.function, seniority = excluded.seniority, founding = excluded.founding,
        remote = excluded.remote, fractional = excluded.fractional, employment_type = excluded.employment_type, location = excluded.location, posted_on = coalesce(wgf.jobs.posted_on, excluded.posted_on),
        url = excluded.url, key_role = excluded.key_role, score = excluded.score, active = true, last_seen_at = now(), round_id = excluded.round_id,
        expires_on = excluded.expires_on, via = excluded.via
      returning id`;
    seen.push(Number(row.id));
  }
  // roles no longer on the board are closed (feeds close by date instead)
  if (close) await sql`update wgf.jobs set active = false where company_id = ${c.id} and source = ${b.source} and active and not (id = any(${seen}))`;
  return jobs.length;
}

const LATEST = () => sql`
  select distinct on (r.company_id) r.company_id, r.id as round_id, r.stage, r.amount_usd, r.announced_on
  from wgf.rounds r where r.status = 'live' and r.announced_on >= current_date - 365
  order by r.company_id, r.announced_on desc`;

// Companies to search for: no known board, not searched in the last 30 days. Newest rounds first.
async function targets(body: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 300);
  const hosts = ["jobs.ashbyhq.com", "boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "apply.workable.com", "jobs.smartrecruiters.com", "recruitee.com", "jobs.personio.de"];
  const rows = await sql`
    with latest as (${LATEST()})
    select c.id, coalesce(c.name_en, c.name) as name, c.domain from latest l join wgf.companies c on c.id = l.company_id
    left join wgf.company_ats a on a.company_id = c.id
    where coalesce(c.name_en, c.name) !~* '(unnamed|undisclosed|stealth)'
      and (a.company_id is null or (a.source is null and coalesce(a.searched_at, 'epoch') < now() - interval '30 days'))
    order by l.announced_on desc, l.amount_usd desc nulls last limit ${limit}`;
  const queries = rows.map((c) => {
    const name = String(c.name).replace(/\(.*?\)/g, "").replace(/"/g, "").trim();
    return { company_id: Number(c.id), name, q: `"${name}" (${hosts.map((h) => `site:${h}`).join(" OR ")})` };
  });
  return { count: queries.length, queries };
}

// Read board links from each company's search results; keep a board only when it belongs to the company.
async function boards(body: Record<string, unknown>) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  let found = 0, roles = 0, none = 0;
  const out: unknown[] = [];
  await Promise.all(items.map(async (it: any) => {
    const id = Number(it.company_id);
    const [c] = await sql`
      with latest as (${LATEST()})
      select c.id, coalesce(c.name_en, c.name) as name, c.domain, l.round_id, l.stage, l.amount_usd from wgf.companies c join latest l on l.company_id = c.id where c.id = ${id}`;
    if (!c) return;
    const name = cleanName(c.name), label = c.domain ? compact(String(c.domain).replace(/^(www|app)\./, "").split(".")[0]) : "";
    // candidate boards, in search-rank order, with whether the result's title names the company
    const seen = new Set<string>(), cands: { src: string; slug: string; titled: boolean }[] = [];
    for (const r of (Array.isArray(it.organic) ? it.organic : []).slice(0, 10)) {
      const a = atsFromUrl(r.link);
      if (!a || seen.has(a.join(":"))) continue;
      seen.add(a.join(":"));
      cands.push({ src: a[0], slug: a[1], titled: name.length >= 2 && ` ${norm(`${r.title} ${r.snippet ?? ""}`)} `.includes(` ${name} `) });
    }
    let hit: { b: Board; why: string } | null = null;
    for (const k of cands.slice(0, 4)) {
      const b = await ATS[k.src](k.slug);
      if (!b) continue;
      const slugMatch = [compact(name), label].filter((x) => x.length >= 3).some((x) => compact(k.slug) === x || (compact(k.slug).startsWith(x) && /^(hq|inc|ai|app|io|co|tech|labs|careers|jobs|global|group)$/.test(compact(k.slug).slice(x.length))));
      if (b.jobs.length && owns(b, c as never)) { hit = { b, why: "board names the company" }; break; }
      if (k.titled && slugMatch) { hit = { b, why: "search title and board name match" }; break; }
    }
    if (hit) {
      found++;
      roles += await storeBoard(c, hit.b);
      await sql`insert into wgf.company_ats (company_id, source, slug, checked_at, fetched_at, searched_at, found_via, note)
                values (${c.id}, ${hit.b.source}, ${hit.b.slug}, now(), now(), now(), 'search', ${hit.why})
                on conflict (company_id) do update set source = excluded.source, slug = excluded.slug, checked_at = now(), fetched_at = now(), searched_at = now(), found_via = 'search', note = excluded.note`;
      out.push({ company: c.name, board: `${hit.b.source}/${hit.b.slug}`, roles: hit.b.jobs.length, why: hit.why });
    } else {
      none++;
      await sql`insert into wgf.company_ats (company_id, source, slug, checked_at, searched_at, note) values (${c.id}, null, null, now(), now(), ${cands.length ? `rejected ${cands.map((k) => `${k.src}/${k.slug}`).join(", ")}` : "no board in search"})
                on conflict (company_id) do update set checked_at = now(), searched_at = now(), note = excluded.note where wgf.company_ats.source is null`;
    }
  }));
  return { searched: items.length, boards_found: found, roles, no_board: none, found: out };
}

// Daily refresh of known boards, plus boards linked from a company's careers page.
async function run(body: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 40);
  const due = () => sql`(a.source is not null and coalesce(a.fetched_at, 'epoch') < now() - interval '20 hours')
      or (a.source is null and c.careers_url ~* '(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.(de|com))' and coalesce(a.checked_at, 'epoch') < now() - interval '7 days')`;
  const cos = await sql`
    with latest as (${LATEST()})
    select c.id, coalesce(c.name_en, c.name) as name, c.domain, c.careers_url, l.round_id, l.stage, l.amount_usd, l.announced_on, a.source, a.slug
    from latest l join wgf.companies c on c.id = l.company_id left join wgf.company_ats a on a.company_id = c.id
    where ${due()} order by l.announced_on desc limit ${limit}`;
  await sql`update wgf.jobs set active = false where active and expires_on < current_date`;
  let refreshed = 0, roles = 0, failed = 0, added = 0;
  await Promise.all(cos.map(async (c) => {
    let src = c.source, slug = c.slug, fromCareers = false;
    if (!src) { const a = atsFromUrl(c.careers_url); if (!a) return; [src, slug] = a; fromCareers = true; }
    const b = await ATS[src](slug);
    if (!b) {
      failed++;   // feed unreachable today: keep the board and its roles, try again tomorrow
      if (fromCareers) await sql`insert into wgf.company_ats (company_id, checked_at, note) values (${c.id}, now(), 'careers link feed unreachable') on conflict (company_id) do update set checked_at = now()`;
      else await sql`update wgf.company_ats set fetched_at = now(), note = 'feed unreachable ' || current_date where company_id = ${c.id}`;
      return;
    }
    roles += await storeBoard(c, b);
    if (fromCareers) {
      added++;
      await sql`insert into wgf.company_ats (company_id, source, slug, checked_at, fetched_at, found_via) values (${c.id}, ${src}, ${slug}, now(), now(), 'careers_page')
                on conflict (company_id) do update set source = excluded.source, slug = excluded.slug, checked_at = now(), fetched_at = now(), found_via = 'careers_page'`;
    } else { refreshed++; await sql`update wgf.company_ats set fetched_at = now(), note = null where company_id = ${c.id}`; }
  }));
  const [left] = await sql`with latest as (${LATEST()}) select count(*)::int as n from latest l join wgf.companies c on c.id = l.company_id left join wgf.company_ats a on a.company_id = c.id where ${due()}`;
  return { processed: cos.length, refreshed, added_from_careers_page: added, feed_unreachable: failed, roles, remaining: left.n };
}


// ---------- feeds ----------
const bareDomain = (d: unknown) => String(d ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];

async function feedTargets() {
  const rows = await sql`
    with latest as (${LATEST()})
    select distinct on (d) lower(regexp_replace(c.domain, '^www\.', '')) as d, a.feed_at
    from latest l join wgf.companies c on c.id = l.company_id left join wgf.company_ats a on a.company_id = c.id
    where c.domain is not null and c.domain <> '' and a.source is null
    order by d, l.announced_on desc`;
  const backfill = rows.filter((r) => !r.feed_at).map((r) => r.d).slice(0, 1000);
  const daily = rows.filter((r) => r.feed_at).map((r) => r.d).slice(0, 1000);
  return { backfill, daily, count: backfill.length + daily.length };
}

const addDaysIso = (d: string | null, n: number) => { const t = d ? Date.parse(d) : Date.now(); return new Date((isNaN(t) ? Date.now() : t) + n * 864e5).toISOString().slice(0, 10); };

async function ingest(body: Record<string, unknown>) {
  const src = String(body.source);
  const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
  const cos = await sql`
    with latest as (${LATEST()})
    select c.id, coalesce(c.name_en, c.name) as name, c.domain, l.round_id, l.stage, l.amount_usd
    from latest l join wgf.companies c on c.id = l.company_id`;
  const byDomain = new Map<string, any>(), byName = new Map<string, any[]>();
  for (const c of cos) {
    if (c.domain) byDomain.set(bareDomain(c.domain), c);
    const k = cleanName(c.name); if (k) byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  const groups = new Map<number, { c: any; jobs: Job[] }>();
  let unmatched = 0;
  for (const it of items as any[]) {
    let c: any = null, job: Job | null = null;
    if (src === "fantastic") {
      c = byDomain.get(bareDomain(it.domain_derived)) ?? byDomain.get(bareDomain(it.organization_url));
      const et = (Array.isArray(it.ai_employment_type) ? it.ai_employment_type : []).map((x: string) => x.replace(/_/g, " ").toLowerCase()).join(", ");
      job = { external_id: `fj-${it.id}`, title: String(it.title ?? ""), location: (it.locations_derived ?? [])[0] ?? null,
        remote: /remote/i.test(String(it.ai_work_arrangement ?? "")), employment_type: et || null, posted_on: day(it.date_posted),
        url: String(it.url ?? ""), text: String(it.description_text ?? "").slice(0, 4000) };
      (job as any).valid = day(it.date_valid_through);
    } else if (src === "wwr") {
      const k = cleanName(it.company);
      const hits = k.length >= 5 ? byName.get(k) ?? [] : [];
      c = hits.length === 1 ? hits[0] : null;   // exact, unique name only
      job = { external_id: `ww-${String(it.link ?? "").split("/").pop()}`, title: String(it.title ?? ""), location: it.region ? `Remote · ${it.region}` : "Remote",
        remote: true, employment_type: it.type ?? null, posted_on: day(it.pubDate), url: String(it.link ?? "") };
    }
    if (!c || !job || !job.title || !job.url) { unmatched++; continue; }
    const g = groups.get(Number(c.id)) ?? { c, jobs: [] };
    g.jobs.push(job); groups.set(Number(c.id), g);
  }
  let roles = 0;
  for (const { c, jobs } of groups.values()) {
    roles += await storeBoard(c, { source: src, slug: "", jobs }, {
      close: false, solo: false, via: src === "wwr" ? "We Work Remotely" : null,
      expires: (j) => (j as any).valid && (j as any).valid >= addDaysIso(null, 0) ? (j as any).valid : addDaysIso(j.posted_on ?? null, 45),
    });
  }
  const marks = Array.isArray(body.mark_domains) ? body.mark_domains.map(bareDomain).filter(Boolean) : [];
  if (marks.length) {
    const ids = cos.filter((c) => c.domain && marks.includes(bareDomain(c.domain))).map((c) => Number(c.id));
    if (ids.length) await sql`insert into wgf.company_ats (company_id, feed_at) select unnest(${ids}::bigint[]), now()
      on conflict (company_id) do update set feed_at = coalesce(wgf.company_ats.feed_at, now())`;
  }
  return { received: items.length, companies: groups.size, roles, unmatched, marked: marks.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "targets") return json(await targets(body));
    if (body.mode === "boards") return json(await boards(body));
    if (body.mode === "run") return json(await run(body));
    if (body.mode === "feed_targets") return json(await feedTargets());
    if (body.mode === "ingest") return json(await ingest(body));
    return json({ error: "mode must be targets, boards, run, feed_targets or ingest" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
