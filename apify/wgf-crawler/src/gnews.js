// Google News RSS links (news.google.com/rss/articles/<id>) hide the publisher URL.
// Resolve them through Google News' own batchexecute endpoint, the same call its web page makes.
import { get } from "./http.js";

export async function resolveGoogleNews(url) {
  const id = (/\/articles\/([^?]+)/.exec(url) || [])[1];
  if (!id) return null;
  // Older ids embed the URL directly in base64
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const m = /https?:\/\/[^\s\x00-\x1f"]+/.exec(raw);
    if (m && !/^https?:\/\/news\.google/.test(m[0])) return m[0].replace(/[\x80-\xff].*$/, "");
  } catch { /* fall through */ }

  const page = await get(`https://news.google.com/articles/${id}`, { timeoutMs: 15000, browserUa: true });
  const sig = (/data-n-a-sg="([^"]+)"/.exec(page.text) || [])[1];
  const ts = (/data-n-a-ts="([^"]+)"/.exec(page.text) || [])[1];
  if (!sig || !ts) return null;
  const req = ["Fbv4je", `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`];
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[req]]));
  try {
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": "Mozilla/5.0" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const chunk = text.split("\n\n")[1];
    if (!chunk) return null;
    const outer = JSON.parse(chunk);
    const inner = JSON.parse(outer[0][2]);
    return typeof inner[1] === "string" ? inner[1] : null;
  } catch { return null; }
}
