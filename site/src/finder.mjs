// What Got Funded: filters, selection and exports for the Today, day and Explore pages.
// Runs in the browser and reuses the server's card and CSV code (units.mjs), so a card or a CSV looks the same everywhere.
//   <div data-finder="bar">     Today and day pages: a filter bar over cards already on the page (rows in #wgf-rows)
//   <div data-finder="panel">   Explore: a filter panel; rows come from data-src and cards are drawn here
// Filters live in the URL, so any filtered view can be bookmarked or shared. Selections, saved lists and the
// LinkedIn note template are kept in this browser only.
import { startupCard, roundsCsv, STAGE, usd } from "./units.mjs";
import { CONTINENTS } from "./regions.mjs";
import { cleanFounders } from "./edition.mjs";

const SITE = "https://whatgotfunded.com";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep it in memory only */ } },
};
const regionName = (k) => (CONTINENTS.find((c) => c.k === k) || {}).name || "Not stated";
const STAGE_ORDER = ["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d", "series_e", "series_f_plus", "growth", "strategic", "undisclosed"];
const AMOUNTS = [["", "Any"], ["0.5", "$500K"], ["1", "$1M"], ["5", "$5M"], ["10", "$10M"], ["25", "$25M"], ["50", "$50M"], ["100", "$100M"], ["500", "$500M"]];
const DEFAULT_NOTE = "Hi {first_name}, congratulations on {company}'s {amount} {stage}. I'd love to connect and follow what you're building.";

// ---------- state <-> URL ----------
const LISTS = ["region", "country", "stage", "sector"];
function readState() {
  const p = new URLSearchParams(location.search), s = { q: p.get("q") || "", investor: p.get("investor") || "", city: p.get("city") || "",
    min: p.get("min") || "", max: p.get("max") || "", hiring: p.get("hiring") === "1", li: p.get("li") === "1", days: p.get("days") || "all",
    sort: p.get("sort") || "amount", list: p.get("list") || "" };
  for (const k of LISTS) s[k] = (p.get(k) || "").split(",").filter(Boolean);
  return s;
}
function writeState(s) {
  const p = new URLSearchParams();
  for (const k of ["q", "investor", "city", "min", "max", "list"]) if (s[k]) p.set(k, s[k]);
  for (const k of LISTS) if (s[k].length) p.set(k, s[k].join(","));
  if (s.hiring) p.set("hiring", "1");
  if (s.li) p.set("li", "1");
  if (s.days !== "all") p.set("days", s.days);
  if (s.sort !== "amount") p.set("sort", s.sort);
  const qs = p.toString();
  history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
}
const activeCount = (s) => LISTS.reduce((n, k) => n + s[k].length, 0) + ["q", "investor", "city", "min", "max", "list"].filter((k) => s[k]).length + (s.hiring ? 1 : 0) + (s.li ? 1 : 0) + (s.days !== "all" ? 1 : 0);

// ---------- matching ----------
function prep(r, hiring) {
  r.founders = cleanFounders(r.founders || []);   // one entry per person, as on the cards
  const founders = (r.founders || []).map((f) => f.name);
  r._hay = norm([r.company, r.company_native, r.hq_city, r.country, r.sector, r.description, ...(r.leads || []), ...(r.investors || []), ...founders].join(" | "));
  r._inv = norm([...(r.leads || []), ...(r.investors || [])].join(" | "));
  r._city = norm(r.hq_city);
  r._hiring = hiring.has(r.company_id);
  r._li = (r.founders || []).some((f) => f.linkedin_url);
  r._cont = r.cont || "unknown";
  r._country = r.country || "Not stated";
  r._sector = r.sector || "Not stated";
  r._stage = r.stage || "undisclosed";
  return r;
}
function matcher(s, latest, listIds) {
  const q = norm(s.q).trim(), inv = norm(s.investor).trim(), city = norm(s.city).trim();
  const min = s.min ? Number(s.min) * 1e6 : null, max = s.max ? Number(s.max) * 1e6 : null;
  const from = s.days !== "all" && latest ? new Date(Date.parse(latest + "T12:00:00Z") - (Number(s.days) - 1) * 864e5).toISOString().slice(0, 10) : null;
  return (r) => (!q || q.split(/\s+/).every((w) => r._hay.includes(w)))
    && (!inv || r._inv.includes(inv)) && (!city || r._city.includes(city))
    && (!s.region.length || s.region.includes(r._cont)) && (!s.country.length || s.country.includes(r._country))
    && (!s.stage.length || s.stage.includes(r._stage)) && (!s.sector.length || s.sector.includes(r._sector))
    && (min == null || (r.amount_usd || 0) >= min) && (max == null || (r.amount_usd && r.amount_usd <= max))
    && (!s.hiring || r._hiring) && (!s.li || r._li) && (!from || r.announced_on >= from)
    && (!listIds || listIds.has(r.id));
}
function facets(rows) {
  const count = (f) => { const m = new Map(); for (const r of rows) m.set(f(r), (m.get(f(r)) || 0) + 1); return m; };
  const reg = count((r) => r._cont), ctry = count((r) => r._country), stg = count((r) => r._stage), sec = count((r) => r._sector);
  return {
    region: CONTINENTS.filter((c) => reg.get(c.k)).map((c) => ({ v: c.k, label: c.name, n: reg.get(c.k), color: c.color })),
    country: [...ctry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => ({ v, label: v, n })),
    stage: STAGE_ORDER.filter((k) => stg.get(k)).map((k) => ({ v: k, label: k === "undisclosed" ? "Not stated" : STAGE[k], n: stg.get(k) })),
    sector: [...sec.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => ({ v, label: v, n })),
  };
}

// ---------- exports ----------
function download(name, text) {
  const blob = new Blob(["﻿" + text.replace(/^﻿/, "")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const csvQ = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const first = (r) => { const s = (r.sources || []).filter((x) => x.url && !/news\.google\.com/.test(x.url)); return (s[0] || (r.sources || [])[0] || {}).url || ""; };
const fund = [["Funding stage", (r) => STAGE[r.stage] || ""], ["Last funding amount (USD)", (r) => (r.amount_usd ? Math.round(r.amount_usd) : "")],
  ["Last funding date", (r) => r.announced_on], ["Lead investors", (r) => (r.leads || []).join("; ")], ["Funding announcement", first], ["What Got Funded page", (r) => (r.href ? SITE + r.href : "")]];
const site = (r) => (r.domain ? `https://${r.domain}` : "");
// Each CRM's own import column names, so its import screen maps the columns without manual matching.
const CRM = {
  hubspot: { label: "HubSpot", cols: [["Company name", (r) => r.company], ["Company domain name", (r) => r.domain || ""], ["Industry", (r) => r.sector], ["Country/Region", (r) => r.country],
    ["City", (r) => r.hq_city], ["LinkedIn company page", (r) => r.linkedin_url], ["Description", (r) => r.description], ...fund] },
  salesforce: { label: "Salesforce", cols: [["Account Name", (r) => r.company], ["Website", site], ["Industry", (r) => r.sector], ["Billing Country", (r) => r.country],
    ["Billing City", (r) => r.hq_city], ["Description", (r) => r.description], ...fund] },
  pipedrive: { label: "Pipedrive", cols: [["Organization - Name", (r) => r.company], ["Organization - Website", site], ["Organization - Address", (r) => [r.hq_city, r.country].filter(Boolean).join(", ")],
    ["Organization - LinkedIn", (r) => r.linkedin_url], ["Organization - Industry", (r) => r.sector], ...fund] },
  attio: { label: "Attio", cols: [["Name", (r) => r.company], ["Domains", (r) => r.domain || ""], ["Description", (r) => r.description], ["LinkedIn", (r) => r.linkedin_url],
    ["Primary location", (r) => [r.hq_city, r.country].filter(Boolean).join(", ")], ["Categories", (r) => r.sector], ...fund] },
  zoho: { label: "Zoho CRM", cols: [["Account Name", (r) => r.company], ["Website", site], ["Industry", (r) => r.sector], ["Billing Country", (r) => r.country],
    ["Billing City", (r) => r.hq_city], ["Description", (r) => r.description], ...fund] },
};
const crmCsv = (rows, k) => [CRM[k].cols.map((c) => c[0]).join(","), ...rows.map((r) => CRM[k].cols.map((c) => csvQ(c[1](r))).join(","))].join("\r\n") + "\r\n";

function fillNote(tpl, f, r) {
  const amount = r.amount_usd ? usd(r.amount_usd) : "", stage = STAGE[r.stage] && r.stage !== "undisclosed" ? STAGE[r.stage] : "round";
  const v = { first_name: String(f.name || "").split(/\s+/)[0], name: f.name, role: f.role || "", company: r.company, amount, stage, lead: (r.leads || [])[0] || "",
    sector: r.sector || "", city: r.hq_city || "", country: r.country || "" };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)).replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").replace(/'s\s+round/, "'s round").trim();
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ } ta.remove(); return ok;
  }
}
function toast(html, ms = 6000) {
  let t = document.querySelector(".wtoast");
  if (!t) { t = document.createElement("div"); t.className = "wtoast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.innerHTML = html; t.classList.add("on");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms);
}
function noteEditor() {
  const d = document.createElement("dialog"); d.className = "wdlg";
  d.innerHTML = `<form method="dialog"><h3>Your LinkedIn note</h3><p>Used for every founder you copy a note for. Fill-ins: <code>{first_name}</code> <code>{company}</code> <code>{amount}</code> <code>{stage}</code> <code>{lead}</code> <code>{sector}</code> <code>{city}</code> <code>{country}</code>. LinkedIn notes are limited to 300 characters.</p>
    <textarea rows="5" maxlength="600"></textarea><div class="wdlg-a"><button type="button" class="reset">Reset</button><span class="len"></span><button value="cancel" class="btn2">Cancel</button><button value="save" class="btn2 dark">Save</button></div></form>`;
  document.body.appendChild(d);
  const ta = d.querySelector("textarea"), len = d.querySelector(".len");
  ta.value = store.get("wgf-note", DEFAULT_NOTE);
  const upd = () => { len.textContent = `${ta.value.length} characters`; }; upd();
  ta.addEventListener("input", upd);
  d.querySelector(".reset").addEventListener("click", () => { ta.value = DEFAULT_NOTE; upd(); });
  d.addEventListener("close", () => { if (d.returnValue === "save") { store.set("wgf-note", ta.value.trim() || DEFAULT_NOTE); toast("Note template saved in this browser."); } d.remove(); });
  d.showModal(); ta.focus();
}

// ---------- the finder ----------
async function start() {
  const root = document.querySelector("[data-finder]"); if (!root) return;
  const mode = root.getAttribute("data-finder");
  document.documentElement.classList.add("finder-on");
  let data;
  if (mode === "bar") data = JSON.parse(document.getElementById("wgf-rows").textContent);
  else {
    try { data = await (await fetch(root.getAttribute("data-src"))).json(); }
    catch { root.querySelector(".xcount").textContent = "Could not load the rounds. Reload the page to try again."; return; }
  }
  const hiring = new Set(data.hiring || []);
  const rows = data.rows.map((r) => prep(r, hiring));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const latest = rows.reduce((m, r) => (r.announced_on > m ? r.announced_on : m), "");
  const F = facets(rows);
  const s = readState();
  const sel = new Set((store.get(`wgf-sel:${location.pathname}`, []) || []).filter((id) => byId.has(id)));
  const pageSize = mode === "bar" ? 12 : 24;
  let shown = pageSize, matched = rows;

  // --- filter controls ---
  const opt = (k, o, type = "checkbox") => `<label class="fo"><input type="${type}" name="${k}" value="${esc(o.v)}"${s[k].includes(o.v) ? " checked" : ""}>${o.color ? `<i class="dot" style="background:${o.color}"></i>` : ""}<span>${esc(o.label)}</span><small>${o.n}</small></label>`;
  const optList = (k, list, cap = 0) => `<div class="fol${cap && list.length > cap ? " long" : ""}">${list.map((o) => opt(k, o)).join("")}</div>`;
  const amountSel = (k) => `<select name="${k}" aria-label="${k === "min" ? "Minimum" : "Maximum"} amount">${AMOUNTS.map(([v, l]) => `<option value="${v}"${s[k] === v ? " selected" : ""}>${k === "min" ? (v ? "From " + l : "Any min") : (v ? "Up to " + l : "Any max")}</option>`).join("")}</select>`;
  const groups = {
    region: () => optList("region", F.region),
    country: () => `${F.country.length > 8 ? `<input class="fsub" type="search" placeholder="Find a country" data-sub="country">` : ""}${optList("country", F.country, 8)}`,
    city: () => `<input class="fin" type="search" name="city" placeholder="City, e.g. Bengaluru" value="${esc(s.city)}">`,
    stage: () => optList("stage", F.stage),
    sector: () => `${F.sector.length > 8 ? `<input class="fsub" type="search" placeholder="Find a sector" data-sub="sector">` : ""}${optList("sector", F.sector, 8)}`,
    investor: () => `<input class="fin" type="search" name="investor" placeholder="Type an investor name" value="${esc(s.investor)}">`,
    amount: () => `<div class="frng">${amountSel("min")}${amountSel("max")}</div>`,
    signals: () => `<label class="fo"><input type="checkbox" name="hiring"${s.hiring ? " checked" : ""}><span>Hiring now</span><small>${rows.filter((r) => r._hiring).length}</small></label>
      <label class="fo"><input type="checkbox" name="li"${s.li ? " checked" : ""}><span>Founder on LinkedIn</span><small>${rows.filter((r) => r._li).length}</small></label>`,
    days: () => `<div class="fseg">${[["1", "Latest day"], ["7", "7 days"], ["30", "30 days"], ["all", "All"]].map(([v, l]) => `<label><input type="radio" name="days" value="${v}"${s.days === v ? " checked" : ""}><span>${l}</span></label>`).join("")}</div>`,
  };
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const search = `<label class="fsearch">${SEARCH_ICON}<input type="search" name="q" placeholder="Search company, investor, founder or city" value="${esc(s.q)}" aria-label="Search"></label>`;
  const dd = (key, label, inner, keys) => `<details class="fdd" data-dd="${key}" data-keys="${keys}"><summary><span>${label}</span><b class="fn"></b></summary><div class="fmenu">${inner}</div></details>`;
  let ctl;
  if (mode === "bar") {
    root.innerHTML = `<div class="fbar">${search}
      ${dd("region", "Region", groups.region(), "region")}${dd("country", "Country", groups.country(), "country")}${dd("stage", "Stage", groups.stage(), "stage")}
      ${dd("sector", "Sector", groups.sector(), "sector")}${dd("investor", "Investor", groups.investor(), "investor")}
      ${dd("more", "More filters", `<h5>City</h5>${groups.city()}<h5>Amount (USD)</h5>${groups.amount()}<h5>Signals</h5>${groups.signals()}`, "city,min,max,hiring,li")}</div>
      <div class="fact"></div>`;
    ctl = root;
  } else {
    const panel = root.querySelector(".fpanel");
    const g = (key, label, inner, open = true) => `<details class="fgrp" data-keys="${key}"${open ? " open" : ""}><summary>${label}<b class="fn"></b></summary>${inner}</details>`;
    panel.innerHTML = `<div class="ph"><b>Filters</b><button type="button" class="fclear">Clear all</button><button type="button" class="fclose" aria-label="Close filters">Done</button></div>
      ${search}${g("days", "Date", groups.days())}${g("region", "Region", groups.region())}${g("country", "Country", groups.country())}${g("city", "City", groups.city(), !!s.city)}
      ${g("stage", "Stage", groups.stage())}${g("min,max", "Amount (USD)", groups.amount())}${g("sector", "Sector", groups.sector())}${g("investor", "Investor", groups.investor())}
      ${g("hiring,li", "Signals", groups.signals())}`;
    ctl = panel;
    root.querySelector(".xtools").innerHTML = `<label class="fsort">Sort <select name="sort"><option value="amount"${s.sort === "amount" ? " selected" : ""}>Largest round</option><option value="date"${s.sort === "date" ? " selected" : ""}>Newest</option><option value="name"${s.sort === "name" ? " selected" : ""}>Company A–Z</option></select></label>
      <details class="fdd lists"><summary><span>My lists</span><b class="fn"></b></summary><div class="fmenu lmenu"></div></details>
      <button type="button" class="btn2 xdl">Download CSV</button>`;
    root.querySelector(".xfbtn").addEventListener("click", () => document.documentElement.classList.add("fsheet"));
    panel.querySelector(".fclose").addEventListener("click", () => document.documentElement.classList.remove("fsheet"));
    panel.querySelector(".fclear").addEventListener("click", () => clearAll());
    root.querySelector('select[name="sort"]').addEventListener("change", (e) => { s.sort = e.target.value; update(); });
    root.querySelector(".xdl").addEventListener("click", () => exportRows("csv"));
  }
  // in-menu finders for long lists
  ctl.querySelectorAll("[data-sub]").forEach((inp) => inp.addEventListener("input", () => {
    const w = norm(inp.value); inp.nextElementSibling.querySelectorAll(".fo").forEach((l) => { l.hidden = w && !norm(l.textContent).includes(w); });
  }));
  // close other dropdowns when one opens; close on outside click
  const dds = [...document.querySelectorAll(".fdd")];
  dds.forEach((d) => d.addEventListener("toggle", () => { if (d.open) dds.forEach((o) => { if (o !== d) o.open = false; }); }));
  document.addEventListener("click", (e) => { if (!e.target.closest(".fdd")) dds.forEach((d) => { d.open = false; }); });

  let typing;
  function onInput(e) {
    const t = e.target; if (!t.name) return;
    if (LISTS.includes(t.name)) s[t.name] = [...ctl.querySelectorAll(`input[name="${t.name}"]:checked`)].map((i) => i.value);
    else if (t.type === "checkbox") s[t.name] = t.checked;
    else if (t.name in s) s[t.name] = t.value;
    if (t.type === "search" || t.type === "text") { clearTimeout(typing); typing = setTimeout(update, 180); } else update();
  }
  ctl.addEventListener("input", onInput);
  ctl.addEventListener("change", (e) => { if (e.target.tagName === "SELECT") onInput(e); });

  function clearAll() {
    for (const k of LISTS) s[k] = [];
    Object.assign(s, { q: "", investor: "", city: "", min: "", max: "", hiring: false, li: false, days: "all", list: "" });
    ctl.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox") i.checked = false; else if (i.type === "radio") i.checked = i.value === "all"; else i.value = ""; });
    ctl.querySelectorAll("select").forEach((x) => { x.value = ""; });
    update();
  }

  // --- active filter chips ---
  function chips() {
    const out = [];
    const add = (label, undo) => out.push({ label, undo });
    if (s.q) add(`“${s.q}”`, () => { s.q = ""; setVal("q", ""); });
    if (s.days !== "all") add(s.days === "1" ? "Latest day" : `Last ${s.days} days`, () => { s.days = "all"; ctl.querySelector('input[name="days"][value="all"]').checked = true; });
    for (const k of LISTS) for (const v of s[k]) add(k === "region" ? regionName(v) : k === "stage" ? (v === "undisclosed" ? "Stage not stated" : STAGE[v]) : v, () => { s[k] = s[k].filter((x) => x !== v); const i = ctl.querySelector(`input[name="${k}"][value="${CSS.escape(v)}"]`); if (i) i.checked = false; });
    if (s.city) add(`City: ${s.city}`, () => { s.city = ""; setVal("city", ""); });
    if (s.investor) add(`Investor: ${s.investor}`, () => { s.investor = ""; setVal("investor", ""); });
    if (s.min) add(`From ${AMOUNTS.find((a) => a[0] === s.min)[1]}`, () => { s.min = ""; setVal("min", ""); });
    if (s.max) add(`Up to ${AMOUNTS.find((a) => a[0] === s.max)[1]}`, () => { s.max = ""; setVal("max", ""); });
    if (s.hiring) add("Hiring now", () => { s.hiring = false; setVal("hiring", false); });
    if (s.li) add("Founder on LinkedIn", () => { s.li = false; setVal("li", false); });
    if (s.list) add(`List: ${s.list}`, () => { s.list = ""; });
    return out;
  }
  function setVal(name, v) { ctl.querySelectorAll(`[name="${name}"]`).forEach((i) => { if (i.type === "checkbox") i.checked = v; else i.value = v; }); }
  const factEl = root.querySelector(".fact");

  // --- results ---
  const cardsEl = mode === "bar" ? root.closest(".list").querySelector(".cards") : root.querySelector("#xcards");
  const moreBtn = (mode === "bar" ? root.closest(".list") : root).querySelector(".more-btn");
  const domCards = mode === "bar" ? new Map([...cardsEl.querySelectorAll(".card")].map((c) => [Number(c.id.slice(2)), c])) : null;
  const order = mode === "bar" ? [...domCards.keys()] : null;   // server order: largest first
  function sorted(list) {
    if (mode === "bar") return list;
    const a = [...list];
    if (s.sort === "date") a.sort((x, y) => y.announced_on.localeCompare(x.announced_on) || (y.amount_usd || 0) - (x.amount_usd || 0));
    else if (s.sort === "name") a.sort((x, y) => x.company.localeCompare(y.company));
    else a.sort((x, y) => (y.amount_usd || 0) - (x.amount_usd || 0) || y.announced_on.localeCompare(x.announced_on));
    return a;
  }
  function draw() {
    if (mode === "bar") {
      const ok = new Set(matched.map((r) => r.id)); let n = 0;
      for (const id of order) { const c = domCards.get(id); if (ok.has(id) && n < shown) { c.removeAttribute("data-hide"); n++; } else c.setAttribute("data-hide", ""); }
      moreBtn.hidden = n >= ok.size; moreBtn.textContent = `Show more startups (${ok.size - n} more)`;
    } else {
      const have = cardsEl.children.length, want = Math.min(shown, matched.length);
      if (have > want || cardsEl.dataset.key !== key) { cardsEl.innerHTML = ""; cardsEl.dataset.key = key; }
      const from = cardsEl.children.length;
      if (want > from) cardsEl.insertAdjacentHTML("beforeend", matched.slice(from, want).map((r) => startupCard(r)).join(""));
      moreBtn.hidden = want >= matched.length; moreBtn.textContent = `Show more (${matched.length - want} more)`;
    }
    paintSel();
  }
  let key = "";
  function update() {
    const lists = store.get("wgf-lists", []);
    const L = s.list ? lists.find((l) => l.name === s.list) : null;
    matched = sorted(rows.filter(matcher(s, latest, L ? new Set(L.ids) : null)));
    key = JSON.stringify(s); shown = pageSize;
    writeState(s); draw();
    const cs = chips(), total = matched.reduce((t, r) => t + (r.amount_usd || 0), 0);
    factEl.innerHTML = `${cs.map((c, i) => `<button type="button" class="chipx" data-i="${i}">${esc(c.label)} <span aria-hidden="true">×</span></button>`).join("")}${cs.length ? `<button type="button" class="clr">Clear all</button>` : ""}
      <span class="cnt">${matched.length} of ${rows.length} startups${total ? ` · ${usd(total)} raised` : ""}</span>`;
    factEl.querySelectorAll(".chipx").forEach((b) => b.addEventListener("click", () => { cs[Number(b.dataset.i)].undo(); update(); }));
    factEl.querySelector(".clr")?.addEventListener("click", clearAll);
    if (mode !== "bar") root.querySelector(".xcount").textContent = `${matched.length} startups${total ? ` · ${usd(total)} raised` : ""}`;
    // the number of active choices on each dropdown or group
    document.querySelectorAll("[data-keys]").forEach((d) => {
      const n = d.getAttribute("data-keys").split(",").reduce((t, k) => t + (Array.isArray(s[k]) ? s[k].length : s[k] && s[k] !== "all" ? 1 : 0), 0);
      const b = d.querySelector(".fn"); if (b) b.textContent = n ? String(n) : "";
      d.classList.toggle("on", n > 0);
    });
    const fb = root.querySelector(".xfbtn"); if (fb) fb.textContent = activeCount(s) ? `Filters (${activeCount(s)})` : "Filters";
    if (mode !== "bar") renderLists();
  }
  moreBtn.addEventListener("click", () => { shown += pageSize; draw(); });
  if ("IntersectionObserver" in window) new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && !moreBtn.hidden) { shown += pageSize; draw(); } }), { rootMargin: "600px 0px" }).observe(moreBtn);

  // region tiles on Today filter the list
  document.querySelectorAll(".tile[data-f]").forEach((t) => t.addEventListener("click", (e) => {
    e.preventDefault(); s.region = [t.getAttribute("data-f")];
    ctl.querySelectorAll('input[name="region"]').forEach((i) => { i.checked = s.region.includes(i.value); });
    update(); root.closest(".list").scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  // --- selection ---
  const bar = document.createElement("div");
  bar.className = "selbar"; bar.hidden = true;
  bar.innerHTML = `<b class="sn"></b><button type="button" class="pri" data-a="csv">Download CSV</button>
    <details class="crm"><summary>CSV for CRM</summary><div class="fmenu up">${Object.entries(CRM).map(([k, c]) => `<button type="button" data-a="crm" data-k="${k}">${c.label}</button>`).join("")}<p>Opens in your CRM's company import. Companies only, matched by website.</p></div></details>
    <button type="button" data-a="notes">Copy LinkedIn notes</button><button type="button" class="ghost" data-a="tpl" title="Edit your note">Edit note</button>
    <button type="button" data-a="save">Save list</button><button type="button" class="x" data-a="clear" aria-label="Clear selection">Clear ×</button>`;
  document.body.appendChild(bar);
  function paintSel() {
    document.querySelectorAll(".card[id^='r-']").forEach((c) => {
      const on = sel.has(Number(c.id.slice(2))); c.classList.toggle("sel", on);
      const b = c.querySelector(".pick"); if (b) b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    bar.hidden = !sel.size; bar.querySelector(".sn").textContent = `${sel.size} selected`;
    document.body.classList.toggle("has-sel", sel.size > 0);
    store.set(`wgf-sel:${location.pathname}`, [...sel]);
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".card .pick"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const id = Number(b.closest(".card").id.slice(2)); if (sel.has(id)) sel.delete(id); else sel.add(id);
    paintSel();
  }, true);
  const picked = () => [...sel].map((id) => byId.get(id)).filter(Boolean);
  const stamp = () => new Date().toISOString().slice(0, 10);
  function exportRows(kind, k) {
    const list = sel.size ? picked() : matched;
    if (!list.length) { toast("Nothing to export. Clear some filters first."); return; }
    const what = sel.size ? "selected" : activeCount(s) ? "filtered" : "all";
    if (kind === "crm") download(`whatgotfunded-${k}-${what}-${stamp()}.csv`, crmCsv(list, k));
    else download(`whatgotfunded-${what}-${stamp()}.csv`, roundsCsv(list, SITE));
    toast(`Downloaded ${list.length} ${list.length === 1 ? "startup" : "startups"}. <a href="/subscribe/">Get every new round in your inbox, free</a>`);
  }
  bar.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const a = b.getAttribute("data-a");
    if (a === "csv") exportRows("csv");
    if (a === "crm") { exportRows("crm", b.getAttribute("data-k")); b.closest("details").open = false; }
    if (a === "clear") { sel.clear(); paintSel(); }
    if (a === "tpl") noteEditor();
    if (a === "notes") {
      const tpl = store.get("wgf-note", DEFAULT_NOTE), out = [];
      for (const r of picked()) for (const f of r.founders || []) if (f.linkedin_url) out.push(`${f.name}${f.role ? `, ${f.role}` : ""} at ${r.company}\n${f.linkedin_url}\n${fillNote(tpl, f, r)}`);
      if (!out.length) { toast("None of the selected startups has a founder LinkedIn profile yet."); return; }
      const ok = await copyText(out.join("\n\n"));
      toast(ok ? `Copied notes for ${out.length} ${out.length === 1 ? "founder" : "founders"}. Open each profile, choose Connect, then Add a note and paste. <button type="button" class="lnk" data-edit>Edit the note</button>` : "Copy failed. Your browser blocked the clipboard.");
    }
    if (a === "save") {
      const name = (prompt("Name this list", `${picked()[0]?.sector || "My"} startups ${stamp()}`) || "").trim();
      if (!name) return;
      const lists = store.get("wgf-lists", []).filter((l) => l.name !== name);
      lists.unshift({ name, ids: [...sel], at: new Date().toISOString() });
      store.set("wgf-lists", lists.slice(0, 50));
      toast(`Saved “${esc(name)}” in this browser. <a href="/explore/?list=${encodeURIComponent(name)}">Open it in Explore</a>`);
      if (mode !== "bar") renderLists();
    }
  });
  document.addEventListener("click", (e) => { if (e.target.closest("[data-edit]")) noteEditor(); });

  function renderLists() {
    const m = root.querySelector(".lmenu"); if (!m) return;
    const lists = store.get("wgf-lists", []);
    const d = m.closest("details"); d.querySelector(".fn").textContent = lists.length ? String(lists.length) : "";
    m.innerHTML = lists.length ? lists.map((l, i) => `<div class="li"><button type="button" data-l="${i}">${esc(l.name)} <small>${l.ids.filter((id) => byId.has(id)).length}</small></button><button type="button" class="del" data-del="${i}" aria-label="Delete ${esc(l.name)}">×</button></div>`).join("")
      : `<p>Tick startups, then choose Save list. Lists are kept in this browser.</p>`;
    m.querySelectorAll("[data-l]").forEach((b) => b.addEventListener("click", () => { s.list = lists[Number(b.dataset.l)].name; d.open = false; update(); }));
    m.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const l = lists[Number(b.dataset.del)]; if (!confirm(`Delete the list “${l.name}”?`)) return;
      store.set("wgf-lists", lists.filter((x) => x !== l)); if (s.list === l.name) s.list = ""; update();
    }));
  }

  // header CSV link on Today exports what is showing
  const hdrCsv = mode === "bar" ? root.closest(".list").querySelector(".h2row .csv") : null;
  if (hdrCsv) hdrCsv.addEventListener("click", (e) => { e.preventDefault(); exportRows("csv"); });

  // --- the side panel: per-founder "Copy note" next to each LinkedIn link ---
  document.addEventListener("wgf:panel", (e) => {
    const id = Number(String(e.detail.id).replace(/^r-/, "")), r = byId.get(id), body = e.detail.body; if (!r || !body) return;
    const tpl = store.get("wgf-note", DEFAULT_NOTE);
    body.querySelectorAll(".fl li").forEach((li) => {
      const name = li.querySelector(".pn")?.textContent.trim(), f = (r.founders || []).find((x) => x.name === name);
      if (!f || !f.linkedin_url) return;
      const b = document.createElement("button"); b.type = "button"; b.className = "cpnote"; b.textContent = "Copy note";
      b.addEventListener("click", async () => { const ok = await copyText(fillNote(store.get("wgf-note", tpl), f, r)); toast(ok ? `Note for ${esc(String(f.name).split(/\s+/)[0])} copied. Open LinkedIn, choose Connect, then Add a note and paste. <button type="button" class="lnk" data-edit>Edit the note</button>` : "Copy failed."); });
      li.appendChild(b);
    });
    const pick = document.createElement("button"); pick.type = "button"; pick.className = "btn2 ppick";
    const label = () => { pick.textContent = sel.has(id) ? "Selected ✓" : "Select for export"; };
    label(); pick.addEventListener("click", () => { if (sel.has(id)) sel.delete(id); else sel.add(id); label(); paintSel(); });
    body.prepend(pick);
  });

  update();
  // a shared link to one startup on Explore (#r-123): draw until its card exists, then open it
  if (mode !== "bar" && /^#r-\d+$/.test(location.hash)) {
    const id = Number(location.hash.slice(3)), at = matched.findIndex((r) => r.id === id);
    if (at >= 0) { shown = Math.max(shown, at + 1); draw(); const c = document.getElementById(`r-${id}`); if (c && window.WGF_openPanel) { c.scrollIntoView({ block: "center" }); window.WGF_openPanel(c); } }
  }
}
start();
