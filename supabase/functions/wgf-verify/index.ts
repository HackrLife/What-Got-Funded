// What Got Funded — Verifier agent (n8n section 3)
//
// POST /functions/v1/wgf-verify   (header: x-wgf-token)
//   { "mode": "targets", "checker": "gemini" | "claude", "ids"?: [..], "dry_run"?: true, "gold"?: true, "model"?: "..." }
//        gold: test run over wgf.gold_rounds (always dry run; Claude gets only the rounds Gemini leaves open).
//     → { items: [{ round_id, day, model, url, body }] }: one ready-to-send model request per round.
//        gemini: every round still pending_check (or the given ids, for scoring against wgf.gold_rounds).
//        claude: second opinion for rounds Gemini could not settle (large, unclear or not found).
//   { "mode": "save", "round_id", "checker", "model", "day", "reply", "dry_run"? }
//     → stores the check in wgf.round_checks and, unless dry_run, sets the round's status.
//   { "mode": "score", "checker"?: "pipeline" | "gemini" | "claude", "model"?, "since"? }
//     → accuracy of the latest dry-run checks against the gold labels.
//
// "Funded date" means the first public announcement, in the publisher's local time. A day's edition lists only
// rounds first announced that day. Nothing is deleted: rounds that fail move to missed_window, not_venture or unverified.

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GEMINI_MODEL = "gemini-3.6-flash";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const BIG = 50_000_000;        // rounds this size always get a second opinion
const VERDICTS = ["ON_DAY", "EARLIER", "LATER", "NOT_A_ROUND", "NOT_FOUND"];
const STAGE: Record<string, string> = { pre_seed: "pre-seed", seed: "seed", series_a: "Series A", series_b: "Series B", series_c: "Series C",
  series_d: "Series D", series_e: "Series E", series_f_plus: "Series F or later", growth: "growth", strategic: "strategic", undisclosed: "stage not stated" };
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

type Round = {
  id: number; day: string; company: string; native: string | null; country: string | null; city: string | null; stage: string;
  amount_usd: number | null; amount_text: string | null; leads: string[]; investors: string[]; src_url: string | null; src_date: string | null;
};

async function loadRounds(ids: number[], useGoldDay: boolean): Promise<Round[]> {
  const rows = await sql`
    select r.id, coalesce(${useGoldDay}::boolean and g.claimed_day is not null, false) as gold,
           (case when ${useGoldDay}::boolean and g.claimed_day is not null then g.claimed_day else r.announced_on end)::text as day,
           coalesce(c.name_en, c.name) as company, c.name_native as native, c.hq_country as country, c.hq_city as city,
           r.stage, r.amount_usd, r.amount_text,
           coalesce((select array_agg(i.name) from wgf.round_investors ri join wgf.investors i on i.id = ri.investor_id where ri.round_id = r.id and ri.is_lead), '{}') as leads,
           coalesce((select array_agg(i.name) from wgf.round_investors ri join wgf.investors i on i.id = ri.investor_id where ri.round_id = r.id and not ri.is_lead), '{}') as investors,
           (select rs.url from wgf.round_sources rs where rs.round_id = r.id and rs.url not like '%news.google.com%' order by rs.published_at limit 1) as src_url,
           (select min(rs.published_at)::date::text from wgf.round_sources rs where rs.round_id = r.id) as src_date
    from wgf.rounds r join wgf.companies c on c.id = r.company_id
    left join wgf.gold_rounds g on g.round_id = r.id
    where r.id = any(${ids})`;
  return rows.map((r) => ({ ...r, id: Number(r.id), amount_usd: r.amount_usd ? Number(r.amount_usd) : null })) as unknown as Round[];
}

function prompt(r: Round) {
  const amount = r.amount_text || (r.amount_usd ? `US$${Math.round(r.amount_usd).toLocaleString("en-US")}` : "not disclosed");
  const who = r.native && r.native !== r.company ? `${r.company} (${r.native})` : r.company;
  const inv = [r.leads.length ? `led by ${r.leads.slice(0, 4).join(", ")}` : "", r.investors.length ? `with ${r.investors.slice(0, 5).join(", ")}` : ""].filter(Boolean).join(" ");
  return `You verify one startup funding round for a daily newsletter. The edition for ${r.day} lists only rounds FIRST publicly announced on ${r.day}, in the publisher's local time.

Round to verify:
- Company: ${who}${r.city || r.country ? `, based in ${[r.city, r.country].filter(Boolean).join(", ")}` : ""}
- Amount: ${amount}; stage: ${STAGE[r.stage] ?? r.stage}${inv ? `; investors: ${inv}` : ""}
- Our source: ${r.src_url ?? "unknown"} (dated ${r.src_date ?? "unknown"})

Search the web. Search in English and, if the company is outside the English-speaking world, also in its local language with its local name. Find the EARLIEST public report of THIS round: a news article, press release, company or investor post. It is the same round if the amount or the investors match; a report of a different, earlier round of the same company does not count. Many sites re-post older deals days or weeks later with a new date, so look for the original.
Also decide whether this is an equity investment in a startup or private company. Debt, bonds, loans, grants, acquisitions, IPOs and investments into a fund are not.

Verdict:
- ON_DAY: the earliest report is dated ${r.day} in its publisher's local time (an Asia-Pacific announcement on the morning of ${r.day} counts as ${r.day} even if US sites date it ${addDays(r.day, -1)}).
- EARLIER: any report of this round exists before ${r.day}.
- LATER: the earliest report is after ${r.day}.
- NOT_A_ROUND: not an equity round in a startup or private company.
- NOT_FOUND: you could not find any report of this round.

Reply with JSON only, no other text:
{"verdict":"ON_DAY|EARLIER|LATER|NOT_A_ROUND|NOT_FOUND","earliest_date":"YYYY-MM-DD or null","earliest_url":"url or null","earliest_source":"publication name or null","is_equity_round":true,"confidence":0.0,"notes":"under 25 words"}`;
}

async function targets(body: Record<string, unknown>) {
  const checker = body.checker === "claude" ? "claude" : "gemini";
  const gold = body.gold === true;
  const dry = body.dry_run === true || gold;
  let ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
  if (!ids.length && gold) {
    // test run against the hand-checked rounds: Gemini checks all of them; Claude only those Gemini's rules leave open
    if (checker === "gemini") ids = (await sql`select round_id from wgf.gold_rounds order by round_id`).map((r) => Number(r.round_id));
    else {
      const rows = await sql`
        select distinct on (k.round_id) k.round_id, k.verdict, k.earliest_date::text as earliest, k.confidence, k.is_equity_round, k.page_ok, k.day::text as day, r.amount_usd
        from wgf.round_checks k join wgf.gold_rounds g on g.round_id = k.round_id join wgf.rounds r on r.id = k.round_id
        where k.dry_run and k.checker = 'gemini' and k.created_at > now() - interval '1 day'
        order by k.round_id, k.created_at desc`;
      ids = rows.filter((k) => !decide("gemini", checkOf(k), Number(k.amount_usd ?? 0), k.day, null).status).map((k) => Number(k.round_id));
    }
  } else if (!ids.length) {
    const rows = checker === "gemini"
      ? await sql`select r.id from wgf.rounds r where r.status = 'pending_check' and r.created_at > now() - interval '4 days'
                    and not exists (select 1 from wgf.round_checks k where k.round_id = r.id and k.checker = 'gemini' and not k.dry_run and k.verdict <> 'ERROR')
                  order by r.amount_usd desc nulls last limit 200`
      : await sql`select r.id from wgf.rounds r where r.status = 'pending_check' and r.created_at > now() - interval '4 days'
                    and exists (select 1 from wgf.round_checks k where k.round_id = r.id and k.checker = 'gemini' and not k.dry_run and k.verdict <> 'ERROR')
                    and not exists (select 1 from wgf.round_checks k where k.round_id = r.id and k.checker = 'claude' and not k.dry_run and k.verdict <> 'ERROR')
                  order by r.amount_usd desc nulls last limit 60`;
    ids = rows.map((r) => Number(r.id));
  }
  const rounds = ids.length ? await loadRounds(ids, dry) : [];
  const model = String(body.model || (checker === "gemini" ? GEMINI_MODEL : CLAUDE_MODEL));
  return {
    checker, model, dry_run: dry, count: rounds.length,
    items: rounds.map((r) => checker === "gemini"
      ? { round_id: r.id, day: r.day, model, dry_run: dry,
          url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          body: { contents: [{ role: "user", parts: [{ text: prompt(r) }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } } }
      : { round_id: r.id, day: r.day, model, dry_run: dry,
          url: "https://api.anthropic.com/v1/messages",
          body: { model, max_tokens: 2500, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
                  messages: [{ role: "user", content: prompt(r) }] } }),
  };
}

type Check = { verdict: string; earliest: string | null; conf: number; notEquity: boolean; pageOk: boolean };
const checkOf = (k: Record<string, any>): Check => ({
  verdict: String(k.verdict), earliest: k.earliest ?? null, conf: k.confidence == null ? 0 : Number(k.confidence),
  notEquity: k.verdict === "NOT_A_ROUND" || k.is_equity_round === false, pageOk: k.page_ok === true,
});

// The one decision rule, used for live runs and for scoring. status null = undecided (Gemini: wait for Claude).
function decide(checker: string, c: Check, amount: number, day: string, geminiVerdict: string | null): { status: string | null; newDay: string | null } {
  const big = amount >= BIG;
  if (checker === "gemini") {
    // Gemini's dates are only trusted when the page it cites really carries that date and names the company
    if (c.notEquity && c.conf >= 0.7) return { status: "not_venture", newDay: null };
    if (!c.pageOk) return { status: null, newDay: null };
    if (c.verdict === "EARLIER" && c.earliest && c.earliest < day && c.conf >= 0.6) return { status: "missed_window", newDay: null };
    if (c.verdict === "LATER" && c.earliest && c.earliest > day && c.conf >= 0.7 && !big) return { status: "live", newDay: c.earliest };
    if (c.verdict === "ON_DAY" && c.conf >= 0.75 && !big) return { status: "live", newDay: null };
    return { status: null, newDay: null };
  }
  if (c.notEquity) return { status: "not_venture", newDay: null };
  if (c.verdict === "EARLIER" && c.earliest && c.earliest < day && c.conf >= 0.6) return { status: "missed_window", newDay: null };
  if (c.verdict === "LATER" && c.earliest && c.earliest > day) return { status: "live", newDay: c.earliest };
  if (c.verdict === "ON_DAY" && (!geminiVerdict || geminiVerdict === "ON_DAY" || geminiVerdict === "NOT_FOUND")) return { status: "live", newDay: null };
  return { status: "unverified", newDay: null };   // the two checkers disagree: held for a human look
}

// The model's final text, from a Gemini or Anthropic response (or plain text)
function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  const r = reply as Record<string, any>;
  if (r?.candidates) return (r.candidates[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  if (Array.isArray(r?.content)) { const t = r.content.filter((b: any) => b.type === "text"); return t.length ? t[t.length - 1].text : ""; }
  return JSON.stringify(reply ?? "");
}
function parseVerdict(text: string) {
  const m = text.match(/\{[\s\S]*\}/g);
  for (const cand of (m ?? []).reverse()) {
    try {
      const o = JSON.parse(cand);
      if (VERDICTS.includes(String(o.verdict))) return o;
    } catch { /* try the next block */ }
  }
  return null;
}
const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));

// Open the page a checker cites and read its real publish date, without trusting the model.
// ok = the page loads, names the company, and its date equals the date the checker claimed.
async function pageCheck(url: string | null, claimed: string | null, names: string[]) {
  if (!url || !/^https?:\/\//.test(url)) return { ok: false, date: null as string | null, note: "no url" };
  if (/instagram\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|vertexaisearch/.test(url)) return { ok: false, date: null, note: "social or redirect url" };
  let html = "";
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; WhatGotFundedBot/1.0; +https://whatgotfunded.com)", "accept-language": "en,zh;q=0.8" } });
    if (!res.ok) return { ok: false, date: null, note: `http ${res.status}` };
    html = (await res.text()).slice(0, 600_000);
  } catch (e) { return { ok: false, date: null, note: "unreachable" }; }
  const found: string[] = [];
  const meta = /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|og:release_date|datePublished|pubdate|publishdate|publish-date|PubDate|publication_date|date|sailthru\.date|parsely-pub-date)["'][^>]*>/gi;
  for (const m of html.match(meta) ?? []) { const c = m.match(/content=["']([^"']+)["']/i); if (c) found.push(c[1]); }
  for (const m of html.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) found.push(m[1]);
  for (const m of html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)) found.push(m[1]);
  let date: string | null = null;
  for (const f of found) { const m = f.match(/(\d{4})-?(\d{2})-?(\d{2})/); if (m) { date = `${m[1]}-${m[2]}-${m[3]}`; break; } }
  if (!date) {   // dates in the URL path: /2026/10/18/, t20261018_, 202610181079555
    const m = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//) ?? url.match(/(20\d{2})(\d{2})(\d{2})(?:\d|_|\/|\.)/) ?? null;
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) date = `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (!date) {   // visible text dates, e.g. 2026-10-18 or 2026年10月18日
    const m = html.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  const text = html.toLowerCase();
  // full name, or its distinctive first word (4+ letters, not "the") for names the page may shorten
  const keys = names.filter(Boolean).flatMap((n) => { const l = n.toLowerCase().replace(/^the\s+/, ""); const w = l.split(/\s+/)[0]; return w.length >= 4 && w !== l ? [l, w] : [l]; });
  const named = keys.some((k) => text.includes(k));
  if (!named) return { ok: false, date, note: "page does not name the company" };
  if (!date) return { ok: false, date, note: "no date on page" };
  return { ok: date === claimed, date, note: date === claimed ? "date confirmed" : `page dated ${date}` };
}

async function save(body: Record<string, unknown>) {
  const roundId = Number(body.round_id), checker = String(body.checker ?? "gemini"), dry = body.dry_run === true;
  const [r] = await sql`select r.id, r.status, r.announced_on::text as announced, r.amount_usd, c.name as company, c.name_native as native, c.name_en as company_en
                        from wgf.rounds r join wgf.companies c on c.id = r.company_id where r.id = ${roundId}`;
  if (!r) return { error: "no such round" };
  const day = isDate(body.day) ? String(body.day) : r.announced;
  const text = replyText(body.reply);
  const v = parseVerdict(text);
  const verdict = v ? String(v.verdict) : "ERROR";
  const earliest = v && isDate(v.earliest_date) ? String(v.earliest_date) : null;
  const conf = v && typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : null;
  const page = ["ON_DAY", "EARLIER", "LATER"].includes(verdict)
    ? await pageCheck(v?.earliest_url ?? null, earliest, [r.company, r.native, r.company_en])
    : { ok: null, date: null, note: null };
  await sql`insert into wgf.round_checks (round_id, checker, model, day, verdict, earliest_date, earliest_url, is_equity_round, confidence, notes, dry_run, raw, page_date, page_ok, page_note)
            values (${roundId}, ${checker}, ${String(body.model ?? "")}, ${day}, ${verdict}, ${earliest}, ${v?.earliest_url ?? null},
                    ${typeof v?.is_equity_round === "boolean" ? v.is_equity_round : null}, ${conf}, ${v?.notes ? String(v.notes).slice(0, 300) : null}, ${dry},
                    ${sql.json({ text: text.slice(0, 4000) })}, ${isDate(page.date) ? page.date : null}, ${page.ok}, ${page.note})`;
  if (dry || r.status !== "pending_check" || verdict === "ERROR") return { round_id: roundId, verdict, status: r.status };

  let geminiVerdict: string | null = null;
  if (checker !== "gemini") {
    const [g] = await sql`select verdict from wgf.round_checks where round_id = ${roundId} and checker = 'gemini' and not dry_run order by created_at desc limit 1`;
    geminiVerdict = g?.verdict ?? null;
  }
  const { status, newDay } = decide(checker, checkOf({ verdict, earliest, confidence: conf, is_equity_round: v?.is_equity_round, page_ok: page.ok }), Number(r.amount_usd ?? 0), day, geminiVerdict);
  if (status) {
    await sql`update wgf.rounds set status = ${status}, wire_checked_at = now(),
                announced_on = coalesce(${newDay}::date, announced_on), week = case when ${newDay}::date is null then week else wgf.week_of(${newDay}::date) end,
                earliest_web_date = case when ${status} = 'missed_window' then ${earliest}::date else earliest_web_date end,
                earliest_web_url = case when ${status} = 'missed_window' then ${v?.earliest_url ?? null} else earliest_web_url end
              where id = ${roundId} and status = 'pending_check'`;
  }
  return { round_id: roundId, verdict, confidence: conf, status: status ?? "pending_check", moved_to: newDay };
}

// Accuracy against the gold labels, from the latest dry-run checks (last day unless "since").
//   checker "gemini" or "claude": that checker's raw verdicts.
//   checker "pipeline": the full rule (Gemini, then Claude where Gemini is unsure), judged by what would appear in the claimed day's edition.
async function score(body: Record<string, unknown>) {
  const checker = String(body.checker ?? "pipeline");
  const since = body.since ?? null;
  const latest = (who: string, model = who === checker ? (body.model ?? null) : null) => sql`
    select distinct on (k.round_id) k.round_id, k.verdict, k.earliest_date::text as earliest, k.confidence, k.is_equity_round, k.page_ok, k.model
    from wgf.round_checks k where k.dry_run and k.checker = ${who}
      and (${model}::text is null or k.model = ${model}::text)
      and k.created_at > coalesce(${since}::timestamptz, now() - interval '1 day')
    order by k.round_id, k.created_at desc`;
  const gold = await sql`select g.round_id, g.claimed_day::text as day, g.truth, g.truth_date::text as truth_date, r.amount_usd
                         from wgf.gold_rounds g join wgf.rounds r on r.id = g.round_id`;
  if (checker !== "pipeline") {
    const by = new Map((await latest(checker)).map((k) => [Number(k.round_id), k]));
    const conf: Record<string, number> = {};
    let n = 0, exact = 0, pub = 0, pubRight = 0, good = 0;
    for (const g of gold) {
      const k = by.get(Number(g.round_id)); if (!k) continue;
      n++; conf[`${g.truth} -> ${k.verdict}`] = (conf[`${g.truth} -> ${k.verdict}`] ?? 0) + 1;
      if (k.verdict === g.truth) exact++;
      if (g.truth === "ON_DAY") good++;
      if (k.verdict === "ON_DAY") { pub++; if (g.truth === "ON_DAY") pubRight++; }
    }
    return { checker, checked: n, exact_match: exact, precision_of_published: pub ? +(pubRight / pub).toFixed(3) : null,
             recall_of_good_rounds: good ? +(pubRight / good).toFixed(3) : null, confusion: conf };
  }
  const gem = new Map((await latest("gemini")).map((k) => [Number(k.round_id), k]));
  const cla = new Map((await latest("claude")).map((k) => [Number(k.round_id), k]));
  let n = 0, pub = 0, pubRight = 0, good = 0, moved = 0, movedRight = 0, open = 0, byClaude = 0;
  const wrong: unknown[] = [];
  const outcome: Record<string, number> = {};
  for (const g of gold) {
    const gk = gem.get(Number(g.round_id)); if (!gk) continue;
    n++;
    const amount = Number(g.amount_usd ?? 0);
    let d = decide("gemini", checkOf(gk), amount, g.day, null);
    if (!d.status) {
      const ck = cla.get(Number(g.round_id));
      if (ck) { d = decide("claude", checkOf(ck), amount, g.day, gk.verdict); byClaude++; } else open++;
    }
    const label = d.status ? (d.newDay ? `live ${d.newDay}` : d.status === "live" ? "live on day" : d.status) : "waiting for Claude";
    outcome[`${g.truth} -> ${label.startsWith("live 20") ? "moved to later day" : label}`] = (outcome[`${g.truth} -> ${label.startsWith("live 20") ? "moved to later day" : label}`] ?? 0) + 1;
    if (g.truth === "ON_DAY") good++;
    if (d.status === "live" && !d.newDay) {
      pub++;
      if (g.truth === "ON_DAY") pubRight++; else wrong.push({ round_id: g.round_id, truth: g.truth, gemini: gk.verdict, claude: cla.get(Number(g.round_id))?.verdict ?? null });
    }
    if (d.status === "live" && d.newDay) { moved++; if (g.truth === "LATER" && d.newDay === g.truth_date) movedRight++; else wrong.push({ round_id: g.round_id, truth: g.truth, moved_to: d.newDay }); }
  }
  return { checker: "pipeline", checked: n, sent_to_claude: byClaude, still_open: open,
           precision_of_published: pub ? +(pubRight / pub).toFixed(3) : null, published: pub,
           recall_of_good_rounds: good ? +(pubRight / good).toFixed(3) : null,
           moved_to_later_day: moved, moved_correctly: movedRight, outcome, wrong };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const [cfg] = await sql`select value from wgf.config where key = 'ingest_token'`;
  if (!cfg || req.headers.get("x-wgf-token") !== cfg.value) return json({ error: "unauthorised" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "targets") return json(await targets(body));
    if (body.mode === "save") return json(await save(body));
    if (body.mode === "score") return json(await score(body));
    return json({ error: "mode must be targets, save or score" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
