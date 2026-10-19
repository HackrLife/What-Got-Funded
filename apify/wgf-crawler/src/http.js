// Polite fetching: timeouts, retries on 429/503, robots.txt per origin, limited concurrency.
export const UA = "Mozilla/5.0 (compatible; WhatGotFundedBot/1.0; +https://whatgotfunded.com/methodology/)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export async function get(url, { timeoutMs = 20000, retries = 1, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", browserUa = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: "follow", signal: ctrl.signal,
        headers: { "user-agent": browserUa ? BROWSER_UA : UA, accept, "accept-language": "en,*;q=0.5" },
      });
      if ((res.status === 429 || res.status === 503) && attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      const type = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, url: res.url, type, text: decode(buf, type) };
    } catch (e) {
      if (attempt < retries) { await sleep(1500); continue; }
      return { ok: false, status: 0, url, type: "", text: "", error: String(e.name === "AbortError" ? "timeout" : e.message || e) };
    } finally { clearTimeout(timer); }
  }
}

// Honour the declared charset (many Chinese, Japanese and Korean sites are not UTF-8)
function decode(buf, type) {
  let cs = (/charset=([\w-]+)/i.exec(type) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1")) || [])[1];
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- robots.txt ----------
const robots = new Map();
export async function allowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!robots.has(u.origin)) {
    robots.set(u.origin, (async () => {
      const r = await get(`${u.origin}/robots.txt`, { timeoutMs: 8000, retries: 0, accept: "text/plain" });
      if (!r.ok || !/text\/plain/i.test(r.type)) return [];
      const rules = [];
      let applies = false, seenAgent = false;
      for (const raw of r.text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        const m = /^(user-agent|disallow|allow)\s*:\s*(.*)$/i.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === "user-agent") { if (seenAgent) { applies = false; seenAgent = false; } applies = applies || v === "*" || /whatgotfunded/i.test(v); }
        else { seenAgent = true; if (applies && v) rules.push({ allow: k === "allow", path: v }); }
      }
      return rules;
    })());
  }
  const rules = await robots.get(u.origin), p = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(p) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

// ---------- concurrency ----------
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e) }; if (!pool.logged) { pool.logged = 0; } if (pool.logged++ < 5) console.error("task error:", String(e).slice(0, 300)); } }
  });
  await Promise.all(workers);
  return out;
}
