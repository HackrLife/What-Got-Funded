// What Got Funded — publish feed for the site build
//
// GET /functions/v1/wgf-publish?days=120   (header: x-wgf-read-token)
//   → { generated_at, rounds: [...] } from wgf.site_export: live rounds only, with investors, named founders and sources.
// GET /functions/v1/wgf-publish?edition=YYYY-MM-DD   (no token)
//   → the same shape, only that day's rounds, and only for days listed in wgf.config 'released_editions'
//     (comma-separated). Those editions are already public on the site; this lets the newsletter build read them.
// The read token is separate from the ingest token and can only read what the public site shows.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
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
    return json({ generated_at: data.generated_at, edition, rounds: (data.rounds || []).filter((r) => r.announced_on === edition) });
  }
  const [cfg] = await sql`select value from wgf.config where key = 'read_token'`;
  if (!cfg || req.headers.get("x-wgf-read-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  const days = Math.min(Math.max(Number(params.get("days")) || 120, 1), 730);
  const [row] = await sql`select wgf.site_export((current_date - ${days}::int)::date) as data`;
  return json(row.data);
});
