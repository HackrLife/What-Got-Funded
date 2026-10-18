// What Got Funded — daily collection
//
// POST /functions/v1/wgf-collect   (header: x-wgf-token)
//   { "channels": ["rss","google_news","apify"], "window_hours": 48, "only_source_ids": [..] }
//   → syncs the source registry from GitHub, fetches every active feed/page, keeps items
//     published in the last `window_hours`, writes new ones to wgf.raw_items (duplicate URLs
//     are skipped) and one wgf.source_health row per source for today.
//
// POST /functions/v1/wgf-collect   { "mode": "sync" }  → only syncs the source registry from GitHub.
//   Collection calls accept { "batch": i, "batches": n, "skip_sync": true } to split sources by id
//   so no single call exceeds the edge runtime CPU limit.
//
// POST /functions/v1/wgf-collect   { "mode": "sources", "channels": ["google_news"] }  → active feeds to fetch elsewhere.
//   Collection also accepts { "prefetched": [{ "source_id", "status", "body", "error" }] }: feeds fetched by n8n
//   (Google News blocks some Supabase egress IPs), parsed and stored here.
//
// POST /functions/v1/wgf-collect   { "mode": "ingest", "channel": "newsletter", "items": [...] }
//   → inserts externally collected items (e.g. newsletter deal lines parsed by n8n).
//
// Daily cadence: runs every morning; the daily edition carries every round first found since the
// previous edition. `week` (Saturday start, UTC) is kept on each item for weekly reports.

import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4.4.1";
import { parse as parseCsv } from "jsr:@std/csv@1.0.3";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4 });
const REPO_RAW = "https://raw.githubusercontent.com/HackrLife/what-got-funded/main/sources";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const FEED_TIMEOUT_MS = 20_000;
const CONCURRENCY = 16;

// Priority-2 (general) feeds keep only items that look like funding news.
const FUNDING_RE = new RegExp(
  [
    "rais(e|es|ed|ing)", "funding", "fundrais", "series [a-h]\\b", "seed", "pre-seed", "round",
    "invest(s|ed|ment)", "backed", "venture", "\\$\\d", "€\\d", "£\\d", "\\d+\\s?(m|mn|million|bn|billion)\\b",
    // local-language equivalents
    "資金調達", "シリーズ", "투자", "유치", "融资", "轮", "finanzierung", "finanzierungsrunde",
    "levée de fonds", "lève", "ronda", "inversión", "financiación", "rodada", "investimento",
    "aporte", "finanziamento", "round di", "investering", "rahoitus", "kapitalrunde", "financiering",
    "инвестиц", "раунд", "pendanaan", "pendanaan", "gọi vốn", "ระดมทุน", "निवेश", "फंडिंग",
    "تمويل", "جولة", "גיוס", "השקעה", "yatırım", "finansowanie", "investice",
  ].join("|"),
  "i",
);

type Source = {
  id: number; region: string; market: string; source: string; language: string | null;
  channel: string; priority: number | null; url: string | null; settings: Record<string, unknown>;
};
type Item = { url: string; title: string | null; content: string | null; published_at: string | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

function weekStart(d: Date): Date {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const back = (u.getUTCDay() + 1) % 7; // Saturday → 0
  u.setUTCDate(u.getUTCDate() - back);
  return u;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Google News and some publishers rate-limit bursts; retry 429/503 with backoff.
async function fetchText(url: string, timeoutMs = FEED_TIMEOUT_MS): Promise<string> {
  for (const wait of [0, 3000, 8000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait + Math.random() * 1000));
    try {
      return await fetchOnce(url, timeoutMs);
    } catch (e) {
      if (!/HTTP (429|503)/.test(String((e as Error).message)) || wait === 8000) throw e;
    }
  }
  throw new Error("unreachable");
}

async function fetchOnce(url: string, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "accept-language": "en-US,en;q=0.9" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- source registry sync (GitHub CSV is the source of truth) ----------

async function syncSources() {
  const feeds = parseCsv(await fetchText(`${REPO_RAW}/n8n-feeds.csv`), { skipFirstRow: true }) as Record<string, string>[];
  const pages = parseCsv(await fetchText(`${REPO_RAW}/scraped-pages.csv`), { skipFirstRow: true }) as Record<string, string>[];
  const registry = parseCsv(await fetchText(`${REPO_RAW}/sources.csv`), { skipFirstRow: true }) as Record<string, string>[];
  const regionBySource = new Map(registry.map((r) => [r.source, r.region]));
  const regionByMarket = new Map(registry.map((r) => [r.market, r.region]));

  const rows: Record<string, unknown>[] = [];
  for (const f of feeds) {
    if (!f.feed_url) continue;
    rows.push({
      region: f.region, market: f.market, source: f.source, language: f.language || null,
      channel: f.feed_url.includes("news.google.com") ? "google_news" : "rss",
      priority: Number(f.priority) || null, feed_status: f.feed_status || null, url: f.feed_url,
      settings: {}, active: true, notes: null,
    });
  }
  for (const p of pages) {
    if (!p.page_url) continue;
    const settings: Record<string, unknown> = {};
    const m = /wait=(\d+)/.exec(p.settings || "");
    if (m) settings.wait = Number(m[1]);
    rows.push({
      region: regionBySource.get(p.source) ?? regionByMarket.get(p.market) ?? "Global",
      market: p.market, source: p.source, language: null, channel: "apify", priority: null,
      feed_status: p.test_result, url: p.page_url, settings,
      active: ["good", "usable", "to test"].includes(p.test_result), notes: p.notes || null,
    });
  }
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = `${r.channel}|${r.url}`; if (seen.has(k)) return false; seen.add(k); return true; });

  await sql`
    insert into wgf.sources ${sql(uniq, "region", "market", "source", "language", "channel", "priority", "feed_status", "url", "settings", "active", "notes")}
    on conflict (channel, url) do update set
      region = excluded.region, market = excluded.market, source = excluded.source,
      language = excluded.language, priority = excluded.priority, feed_status = excluded.feed_status,
      settings = excluded.settings, active = excluded.active, notes = excluded.notes`;

  // Feeds removed from the CSVs stop being polled (history is kept).
  const keys = uniq.map((r) => `${r.channel}|${r.url}`);
  await sql`update wgf.sources set active = false
            where channel in ('rss','google_news','apify') and (channel || '|' || url) <> all(${keys})`;
  return uniq.length;
}

// ---------- RSS / Atom ----------

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", processEntities: true });

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return txt((v as Record<string, unknown>)["#text"]);
  return null;
};
const strip = (s: string | null) =>
  s ? s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 20_000) : null;
const toDate = (s: string | null) => { if (!s) return null; const d = new Date(s); return isNaN(+d) ? null : d.toISOString(); };

function parseFeed(body: string): Item[] {
  const doc = xml.parse(body);
  const ch = doc?.rss?.channel ?? doc?.["rdf:RDF"];
  let entries: Record<string, unknown>[] = [];
  if (ch) entries = [].concat((ch.item ?? doc?.["rdf:RDF"]?.item ?? []) as never);
  else if (doc?.feed) entries = [].concat((doc.feed.entry ?? []) as never);
  else throw new Error("not an RSS/Atom feed");

  return entries.map((e) => {
    let link = txt(e.link);
    if (!link && e.link) {
      const links = [].concat(e.link as never) as Record<string, string>[];
      link = (links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0])?.["@href"] ?? null;
    }
    link = link ?? txt(e.guid);
    const src = e.source as Record<string, string> | undefined; // Google News publisher
    const desc = strip(txt(e["content:encoded"]) ?? txt(e.description) ?? txt(e.summary) ?? txt(e.content));
    return {
      url: (link ?? "").trim(),
      title: strip(txt(e.title)),
      content: src ? [desc, `Publisher: ${txt(src)} ${src["@url"] ?? ""}`].filter(Boolean).join("\n") : desc,
      published_at: toDate(txt(e.pubDate) ?? txt(e.published) ?? txt(e.updated) ?? txt(e["dc:date"])),
    };
  }).filter((i) => i.url.startsWith("http"));
}

// ---------- Apify ----------

async function scrapePage(s: Source, token: string): Promise<Item[]> {
  const input: Record<string, unknown> = { url: s.url, formats: ["markdown"] };
  if (s.settings?.wait) input.wait = s.settings.wait;
  const r = await fetch(
    `https://api.apify.com/v2/acts/apify~web-fetch/run-sync-get-dataset-items?timeout=120`,
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(input) },
  );
  if (!r.ok) throw new Error(`Apify HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json() as Record<string, unknown>[];
  const md = (rows?.[0]?.markdown as string) ?? "";
  if (md.trim().length < 200) throw new Error("empty or blocked page");
  return [{ url: s.url!, title: `${s.source} — page snapshot`, content: md.slice(0, 400_000), published_at: null }];
}

// ---------- main ----------

async function collect(body: Record<string, unknown>) {
  const channels = (body.channels as string[]) ?? ["rss", "google_news", "apify"];
  const now = new Date();
  const day = iso(now);
  const windowStart = new Date(+now - (Number(body.window_hours) || 48) * 3600_000);
  const windowEnd = new Date(+now + 3600_000); // tolerate feeds with slightly future timestamps

  const synced = body.skip_sync ? null : await syncSources();
  const [run] = await sql`insert into wgf.runs (day, week, channel) values (${day}, ${iso(weekStart(now))}, ${channels.join(",")}) returning id`;

  let sources = await sql<Source[]>`select id, region, market, source, language, channel, priority, url, settings
                                   from wgf.sources where active and channel = any(${channels}) and url is not null`;
  if (Array.isArray(body.only_source_ids)) sources = sources.filter((s) => (body.only_source_ids as number[]).includes(Number(s.id)));
  const pre = new Map((Array.isArray(body.prefetched) ? body.prefetched as Record<string, unknown>[] : [])
    .map((p) => [Number(p.source_id), p]));
  if (pre.size) sources = sources.filter((s) => pre.has(Number(s.id)));
  // Batching keeps each call under the edge runtime's CPU limit: { "batch": 0, "batches": 8 }.
  const batches = Number(body.batches) || 1;
  if (batches > 1) sources = sources.filter((s) => Number(s.id) % batches === Number(body.batch ?? 0));

  const apifyToken = Deno.env.get("APIFY_TOKEN");
  const results = await pool(sources, Number(body.concurrency) || CONCURRENCY, async (s) => {
    try {
      let items: Item[];
      if (s.channel === "apify") {
        if (!apifyToken) throw new Error("APIFY_TOKEN secret not set");
        items = await scrapePage(s, apifyToken);
        items = items.map((i) => ({ ...i, url: `${i.url}#wgf-day=${day}`, published_at: now.toISOString() }));
      } else if (pre.size) {
        const p = pre.get(Number(s.id))!;
        if (p.error || Number(p.status) >= 400) throw new Error(String(p.error ?? `HTTP ${p.status}`));
        items = parseFeed(String(p.body ?? ""));
      } else {
        items = parseFeed(await fetchText(s.url!));
      }
      const fetched = items.length;
      items = items.filter((i) => {
        if (s.channel === "apify") return true;
        if (!i.published_at) return false;
        const t = new Date(i.published_at);
        return t >= windowStart && t < windowEnd;
      });
      if (s.channel === "rss" && s.priority === 2) items = items.filter((i) => FUNDING_RE.test(`${i.title} ${i.content ?? ""}`.slice(0, 2000)));
      return { s, fetched, items, error: null as string | null };
    } catch (e) {
      return { s, fetched: 0, items: [] as Item[], error: String((e as Error).message ?? e).slice(0, 300) };
    }
  });

  const allRows = results.flatMap((r) => r.items.map((i) => ({
    source_id: r.s.id, channel: r.s.channel, url: i.url.slice(0, 2000), title: i.title, content: i.content,
    published_at: i.published_at,
    week: iso(weekStart(new Date(i.published_at ?? now))), day,
    run_id: run.id,
  })));
  let inserted = 0;
  for (let k = 0; k < allRows.length; k += 500) {
    const res = await sql`insert into wgf.raw_items ${sql(allRows.slice(k, k + 500), "source_id", "channel", "url", "title", "content", "published_at", "week", "day", "run_id")}
                          on conflict (url) do nothing returning id`;
    inserted += res.length;
  }

  const health = results.map((r) => ({
    source_id: r.s.id, day, run_id: run.id, items_fetched: r.fetched, funding_items: r.items.length,
    errors: r.error, status: r.error ? "error" : r.items.length ? "ok" : "empty",
  }));
  if (health.length) {
    await sql`insert into wgf.source_health ${sql(health, "source_id", "day", "run_id", "items_fetched", "funding_items", "errors", "status")}
              on conflict (source_id, day) do update set run_id = excluded.run_id, items_fetched = excluded.items_fetched,
                funding_items = excluded.funding_items, errors = excluded.errors, status = excluded.status, checked_at = now()`;
  }

  const by = (k: "channel" | "region") => {
    const m: Record<string, { sources: number; ok: number; empty: number; error: number; items: number }> = {};
    for (const r of results) {
      const g = (m[r.s[k]] ??= { sources: 0, ok: 0, empty: 0, error: 0, items: 0 });
      g.sources++; g.items += r.items.length; g[r.error ? "error" : r.items.length ? "ok" : "empty"]++;
    }
    return m;
  };
  const stats = {
    day, synced_sources: synced, sources_polled: results.length, new_raw_items: inserted,
    by_channel: by("channel"), by_region: by("region"),
    errors: results.filter((r) => r.error).map((r) => ({ id: r.s.id, source: r.s.source, channel: r.s.channel, error: r.error })),
  };
  await sql`update wgf.runs set finished_at = now(), stats = ${sql.json(stats)} where id = ${run.id}`;
  return { run_id: run.id, ...stats };
}

async function ingest(body: Record<string, unknown>) {
  const channel = String(body.channel ?? "newsletter");
  const items = (body.items as Record<string, unknown>[]) ?? [];
  const rows = items.filter((i) => typeof i.url === "string").map((i) => {
    const p = i.published_at ? new Date(String(i.published_at)) : new Date();
    return {
      source_id: (i.source_id as number) ?? null, channel, url: String(i.url).slice(0, 2000),
      title: (i.title as string) ?? null, content: (i.content as string) ?? null,
      published_at: p.toISOString(), week: iso(weekStart(p)), day: iso(new Date()), run_id: null,
    };
  });
  if (!rows.length) return { inserted: 0 };
  const res = await sql`insert into wgf.raw_items ${sql(rows, "source_id", "channel", "url", "title", "content", "published_at", "week", "day", "run_id")}
                        on conflict (url) do nothing returning id`;
  return { inserted: res.length, received: rows.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "sync") return json({ synced_sources: await syncSources() });
    if (body.mode === "sources") {
      const feeds = await sql`select id, source, url from wgf.sources
                              where active and channel = any(${(body.channels as string[]) ?? ["google_news"]}) and url is not null order by id`;
      return json({ feeds });
    }
    return json(body.mode === "ingest" ? await ingest(body) : await collect(body));
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
