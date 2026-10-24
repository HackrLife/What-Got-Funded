// What Got Funded — publish feed for the site build
//
// GET /functions/v1/wgf-publish?days=120   (header: x-wgf-read-token)
//   → { generated_at, rounds: [...] } from wgf.site_export: live rounds only, with investors, named founders and sources.
// GET /functions/v1/wgf-publish?edition=YYYY-MM-DD   (no token)
//   → the same shape, only that day's rounds, and only for days listed in wgf.config 'released_editions'
//     (comma-separated). Those editions are already public on the site; this lets the newsletter build read them.
// Both responses also carry `jobs` (open roles at funded startups) and `hiring` (startups whose funding announcement says the
// money pays for hiring), for the jobs page.
// The read token is separate from the ingest token and can only read what the public site shows.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
// Open roles at funded startups (wgf-jobs), for the jobs page
async function jobs() {
  return await sql`
    select j.id, j.via, j.title, j.team, j.function, j.seniority, j.founding, j.remote, j.fractional, j.employment_type, j.location, j.posted_on::text as posted_on,
           j.url, j.key_role, j.score::float as score, j.company_id, coalesce(c.name_en, c.name) as company, c.domain, c.hq_country, c.linkedin_url,
           r.id as round_id, r.announced_on::text as announced_on, r.amount_usd::float as amount_usd, r.stage,
           (select rp.profile->>'use_of_funds' from wgf.round_profiles rp where rp.round_id = r.id limit 1) as use_of_funds
    from wgf.jobs j join wgf.companies c on c.id = j.company_id join wgf.rounds r on r.id = j.round_id
    where j.active and r.status = 'live' order by j.score desc nulls last limit 2000`;
}
// Hiring signal: rounds from the last 45 days whose announced use of funds includes hiring or team growth
async function hiring() {
  return await sql`
    select distinct on (c.id) c.id as company_id, coalesce(c.name_en, c.name) as company, c.domain, c.hq_country, c.linkedin_url, c.careers_url,
           r.id as round_id, r.announced_on::text as announced_on, r.amount_usd::float as amount_usd, r.stage,
           rp.profile->>'use_of_funds' as use_of_funds,
           (select s.url from wgf.round_sources s where s.round_id = r.id order by s.published_at nulls last limit 1) as source_url,
           (select count(*)::int from wgf.jobs j where j.company_id = c.id and j.active and j.key_role) as key_roles
    from wgf.rounds r join wgf.companies c on c.id = r.company_id join wgf.round_profiles rp on rp.round_id = r.id
    where r.status = 'live' and r.announced_on >= current_date - 45
      and rp.profile->>'use_of_funds' ~* '(hir(e|es|ing)|recruit|talent|headcount|workforce|team|staff|employees|engineers)'
      and coalesce(c.name_en, c.name) !~* '(unnamed|undisclosed|stealth)'
    order by c.id, r.announced_on desc limit 400`;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const edition = params.get("edition");
  if (edition) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(edition)) return json({ error: "edition must be YYYY-MM-DD" }, 400);
    const [rel] = await sql`select value from wgf.config where key = 'released_editions'`;
    const released = String(rel?.value ?? "").split(",").map((s) => s.trim());
    if (!released.includes(edition)) return json({ error: "edition not released" }, 404);
    const [row] = await sql`select wgf.site_export(${edition}::date) as data`;
    const data = row.data as { generated_at: string; rounds: { announced_on: string }[] };
    return json({ generated_at: data.generated_at, edition, rounds: (data.rounds || []).filter((r) => r.announced_on === edition), jobs: await jobs(), hiring: await hiring() });
  }
  const [cfg] = await sql`select value from wgf.config where key = 'read_token'`;
  if (!cfg || req.headers.get("x-wgf-read-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  const days = Math.min(Math.max(Number(params.get("days")) || 120, 1), 730);
  const [row] = await sql`select wgf.site_export((current_date - ${days}::int)::date) as data`;
  return json({ ...(row.data as Record<string, unknown>), jobs: await jobs(), hiring: await hiring() });
});
