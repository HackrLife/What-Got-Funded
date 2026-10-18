// What Got Funded — publish feed for the site build
//
// GET /functions/v1/wgf-publish?days=120   (header: x-wgf-read-token)
//   → { generated_at, rounds: [...] } from wgf.site_export: live rounds only, with investors, named founders and sources.
// The read token is separate from the ingest token and can only read what the public site shows.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });

Deno.serve(async (req) => {
  const [cfg] = await sql`select value from wgf.config where key = 'read_token'`;
  if (!cfg || req.headers.get("x-wgf-read-token") !== cfg.value) {
    return new Response(JSON.stringify({ error: "unauthorised" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 120, 1), 730);
  const [row] = await sql`select wgf.site_export((current_date - ${days}::int)::date) as data`;
  return new Response(JSON.stringify(row.data), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
