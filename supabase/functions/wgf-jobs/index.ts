// What Got Funded — jobs agent (n8n section 2c)
//
// POST /functions/v1/wgf-jobs   (header: x-wgf-token)
//   { "mode": "run", "limit"?: 12 }
//     → takes the next companies that raised in the last 365 days, finds their public hiring system (Greenhouse, Lever,
//       Ashby, Workable, SmartRecruiters, Recruitee) and stores their open roles with function, seniority and tags.
//       Hiring systems are looked up once a week per company; roles are refreshed once a day.
//
// Only each company's own public job feed is read: the same feed the company embeds on its careers page.
// A board is accepted only when its name, or its postings, name the company.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
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
};

// Slugs to try: an explicit ATS link on the careers page first, then the company's domain label and name.
function candidates(c: { name: string; domain: string | null; careers_url: string | null }) {
  const out: [string, string][] = [];
  const cu = String(c.careers_url ?? "");
  const m = /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i.exec(cu) ? ["greenhouse", /greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i.exec(cu)![1]]
    : /jobs\.lever\.co\/([\w-]+)/i.exec(cu) ? ["lever", /jobs\.lever\.co\/([\w-]+)/i.exec(cu)![1]]
    : /jobs\.ashbyhq\.com\/([\w.-]+)/i.exec(cu) ? ["ashby", /jobs\.ashbyhq\.com\/([\w.-]+)/i.exec(cu)![1]]
    : /apply\.workable\.com\/([\w-]+)/i.exec(cu) ? ["workable", /apply\.workable\.com\/([\w-]+)/i.exec(cu)![1]]
    : /jobs\.smartrecruiters\.com\/([\w-]+)/i.exec(cu) ? ["smartrecruiters", /jobs\.smartrecruiters\.com\/([\w-]+)/i.exec(cu)![1]]
    : /([\w-]+)\.recruitee\.com/i.exec(cu) ? ["recruitee", /([\w-]+)\.recruitee\.com/i.exec(cu)![1]] : null;
  if (m) out.push([m[0], m[1]]);
  const label = c.domain ? c.domain.replace(/^(www|app)\./, "").split(".")[0] : "";
  const words = norm(c.name.replace(/\(.*?\)/g, "")).split(" ").filter((w) => w && !["inc", "ltd", "llc", "the", "ai", "co"].includes(w) || /^ai$/.test(w) && false);
  const slugs = [...new Set([label, words.join(""), words.join("-"), norm(c.name).replace(/ /g, "")].filter((s) => s && s.length >= 3))];
  for (const s of slugs) for (const src of Object.keys(ATS)) out.push([src, s]);
  return out;
}

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

async function storeBoard(c: Record<string, any>, b: Board) {
  const jobs = b.jobs.filter((j) => j.title && j.url && !JUNIOR.test(j.title));
  const perFunc = new Map<string, number>();
  for (const j of jobs) { const f = funcOf(j.title); perFunc.set(f, (perFunc.get(f) ?? 0) + 1); }
  const seen: number[] = [];
  for (const j of jobs) {
    const fn = funcOf(j.title), sen = seniorityOf(j.title);
    const early = EARLY.has(String(c.stage));
    const founding = /\bfounding\b|\bfirst\b|#1\b/i.test(j.title) || (early && (perFunc.get(fn) === 1 && fn !== "other" || RANK[sen] >= 3));
    const remote = isRemote(j), fractional = isFractional(j);
    const key = founding || RANK[sen] >= 3 || (fractional && fn !== "other") || (remote && RANK[sen] >= 2);
    const posted = j.posted_on ?? null;
    const fresh = posted ? Math.max(0, 30 - (Date.now() - Date.parse(posted)) / 864e5) / 30 : 0.3;
    const score = (founding ? 3 : 0) + RANK[sen] + (remote ? 0.5 : 0) + (fractional ? 0.5 : 0) + fresh * 2 + Math.log10(Math.max(Number(c.amount_usd) || 1e6, 1e6)) - 6;
    const [row] = await sql`insert into wgf.jobs (company_id, round_id, source, external_id, title, team, function, seniority, founding, remote, fractional, employment_type, location, posted_on, url, key_role, score, active, last_seen_at)
      values (${c.id}, ${c.round_id}, ${b.source}, ${j.external_id}, ${j.title.slice(0, 200)}, ${j.team ?? null}, ${fn}, ${sen}, ${founding}, ${remote}, ${fractional}, ${j.employment_type ?? null},
              ${j.location ? String(j.location).slice(0, 200) : null}, ${posted}, ${j.url}, ${key}, ${+score.toFixed(3)}, true, now())
      on conflict (source, external_id) do update set title = excluded.title, team = excluded.team, function = excluded.function, seniority = excluded.seniority, founding = excluded.founding,
        remote = excluded.remote, fractional = excluded.fractional, employment_type = excluded.employment_type, location = excluded.location, posted_on = coalesce(wgf.jobs.posted_on, excluded.posted_on),
        url = excluded.url, key_role = excluded.key_role, score = excluded.score, active = true, last_seen_at = now(), round_id = excluded.round_id
      returning id`;
    seen.push(Number(row.id));
  }
  // roles no longer on the board are closed
  await sql`update wgf.jobs set active = false where company_id = ${c.id} and source = ${b.source} and active and not (id = any(${seen}))`;
  return jobs.length;
}

async function run(body: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 20);
  // companies with a live round in the last 365 days; each needs a lookup (weekly) or a refresh (daily)
  const cos = await sql`
    with latest as (
      select distinct on (r.company_id) r.company_id, r.id as round_id, r.stage, r.amount_usd, r.announced_on
      from wgf.rounds r where r.status = 'live' and r.announced_on >= current_date - 365
      order by r.company_id, r.announced_on desc)
    select c.id, coalesce(c.name_en, c.name) as name, c.domain, c.careers_url, l.round_id, l.stage, l.amount_usd, l.announced_on, a.source, a.slug, a.checked_at, a.fetched_at
    from latest l join wgf.companies c on c.id = l.company_id left join wgf.company_ats a on a.company_id = c.id
    where coalesce(c.name_en, c.name) !~* '(unnamed|undisclosed|stealth)'
      and ((a.company_id is null) or (a.source is null and a.checked_at < now() - interval '7 days') or (a.source is not null and coalesce(a.fetched_at, 'epoch') < now() - interval '20 hours'))
    order by (a.company_id is null) desc, l.announced_on desc limit ${limit}`;
  let found = 0, roles = 0, none = 0;
  for (const c of cos) {
    let board: Board | null = null;
    if (c.source && c.slug) board = await ATS[c.source](c.slug);
    else {
      // an explicit careers-page link first, then every hiring system in parallel for each candidate slug
      const cands = candidates(c as never);
      const bySlug = new Map<string, string[]>();
      for (const [src, slug] of cands) bySlug.set(slug, [...(bySlug.get(slug) ?? []), src]);
      for (const [slug, srcs] of bySlug) {
        const boards = await Promise.all(srcs.map((src) => ATS[src](slug)));
        board = boards.find((b) => b && b.jobs.length && owns(b, c as never)) ?? null;
        if (board) break;
      }
    }
    if (board) {
      roles += await storeBoard(c, board); found++;
      await sql`insert into wgf.company_ats (company_id, source, slug, checked_at, fetched_at) values (${c.id}, ${board.source}, ${board.slug}, now(), now())
                on conflict (company_id) do update set source = excluded.source, slug = excluded.slug, checked_at = now(), fetched_at = now()`;
    } else {
      none++;
      if (c.source) await sql`update wgf.jobs set active = false where company_id = ${c.id} and active`;
      await sql`insert into wgf.company_ats (company_id, source, slug, checked_at) values (${c.id}, null, null, now())
                on conflict (company_id) do update set source = null, slug = null, checked_at = now()`;
    }
  }
  const [left] = await sql`
    with latest as (select distinct on (r.company_id) r.company_id from wgf.rounds r where r.status = 'live' and r.announced_on >= current_date - 365)
    select count(*)::int as n from latest l left join wgf.company_ats a on a.company_id = l.company_id
    where a.company_id is null or (a.source is null and a.checked_at < now() - interval '7 days') or (a.source is not null and coalesce(a.fetched_at, 'epoch') < now() - interval '20 hours')`;
  return { processed: cos.length, boards_found: found, roles, no_board: none, remaining: left.n };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "run") return json(await run(body));
    return json({ error: "mode must be run" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
