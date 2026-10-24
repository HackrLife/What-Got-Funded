// What Got Funded — client script: home treemap and daily-table filters. No dependencies.
(function () {
  "use strict";
  var fmt = function (v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(v >= 1e10 ? 1 : 2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
    return "$" + Math.round(v);
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  // ---------- squarified treemap ----------
  function squarify(items, x, y, w, h) {
    var total = items.reduce(function (a, i) { return a + i.v; }, 0), out = [];
    if (!total || w <= 0 || h <= 0) return out;
    var rest = items.slice().sort(function (a, b) { return b.v - a.v; });
    var scale = (w * h) / total;
    while (rest.length) {
      var short = Math.min(w, h), row = [], best = Infinity;
      for (var j = 0; j < rest.length; j++) {
        var r = row.concat(rest[j]), s = r.reduce(function (a, i) { return a + i.v * scale; }, 0);
        var worst = Math.max.apply(null, r.map(function (i) { return Math.max((short * short * i.v * scale) / (s * s), (s * s) / (short * short * i.v * scale)); }));
        if (worst > best) break;
        best = worst; row = r;
      }
      rest = rest.slice(row.length);
      var sum = row.reduce(function (a, i) { return a + i.v * scale; }, 0), thick = sum / short, off = 0;
      row.forEach(function (it) {
        var len = (it.v * scale) / thick;
        out.push(w >= h ? { it: it, x: x, y: y + off, w: thick, h: len } : { it: it, x: x + off, y: y, w: len, h: thick });
        off += len;
      });
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    }
    return out;
  }

  function drawMap() {
    var map = document.getElementById("map"), src = document.getElementById("map-data");
    if (!map || !src) return;
    var data = JSON.parse(src.textContent), groups = data.groups.map(function (g) {
      return Object.assign({}, g, { v: g.kids.reduce(function (a, k) { return a + k.v; }, 0) });
    });
    map.innerHTML = "";
    var W = map.clientWidth, H = map.clientHeight, G = 6, g = 2;
    squarify(groups, 0, 0, W, H).forEach(function (c) {
      squarify(c.it.kids, c.x + G / 2, c.y + G / 2, c.w - G, c.h - G).forEach(function (t) {
        var el = document.createElement("a"), area = t.w * t.h;
        el.className = "t" + (c.it.dark ? " dark" : "") + (t.w < 74 || t.h < 56 ? " xs" : area < 30000 ? " sm" : "");
        el.href = "/day/" + data.day + "/?" + (t.it.name === "Country not stated" ? "c=unknown" : "country=" + encodeURIComponent(t.it.name));
        el.title = t.it.name + ": " + fmt(t.it.v) + ", " + t.it.n + " round" + (t.it.n > 1 ? "s" : "");
        el.style.left = ((t.x + g / 2) / W) * 100 + "%";
        el.style.top = ((t.y + g / 2) / H) * 100 + "%";
        el.style.width = ((t.w - g) / W) * 100 + "%";
        el.style.height = ((t.h - g) / H) * 100 + "%";
        el.style.background = c.it.c;
        el.innerHTML = '<div class="cn">' + esc(t.it.name) + '</div><div class="amt num">' + fmt(t.it.v) + '</div><div class="r">' + t.it.n + " round" + (t.it.n > 1 ? "s" : "") + "</div>";
        map.appendChild(el);
      });
    });
  }

  // ---------- daily table filters ----------
  function filters() {
    var aside = document.querySelector(".filters");
    if (!aside) return;
    var rows = Array.prototype.slice.call(document.querySelectorAll("table.rounds tbody tr"));
    var boxes = Array.prototype.slice.call(aside.querySelectorAll("input[type=checkbox]"));
    var min = document.getElementById("f-min"), q = document.getElementById("f-q");
    var bar = Array.prototype.slice.call(document.querySelectorAll("#bar a"));
    var showing = document.getElementById("showing"), none = document.getElementById("none"), chipClear = document.getElementById("chip-clear");
    var h = document.getElementById("day-h");

    function checked(name) {
      return boxes.filter(function (b) { return b.name === name && b.checked; }).map(function (b) { return b.value; });
    }
    function apply(push) {
      var sel = { c: checked("c"), country: checked("country"), stage: checked("stage"), sector: checked("sector") };
      var m = Number(min.value) || 0, text = q.value.trim().toLowerCase(), shown = 0, total = 0, perC = {};
      rows.forEach(function (tr) {
        var d = tr.dataset, ok =
          (!sel.c.length || sel.c.indexOf(d.c) >= 0) &&
          (!sel.country.length || sel.country.indexOf(d.country) >= 0) &&
          (!sel.stage.length || sel.stage.indexOf(d.stage) >= 0) &&
          (!sel.sector.length || sel.sector.indexOf(d.sector) >= 0) &&
          (!m || Number(d.usd) >= m) &&
          (!text || d.inv.indexOf(text) >= 0 || d.name.indexOf(text) >= 0);
        tr.hidden = !ok;
        if (ok) { shown++; total += Number(d.usd) || 0; perC[d.c] = true; }
      });
      bar.forEach(function (a) { a.classList.toggle("off", !perC[a.dataset.k]); });
      var any = sel.c.length || sel.country.length || sel.stage.length || sel.sector.length || m || text;
      showing.innerHTML = any ? "Showing <b>" + shown + " of " + rows.length + "</b>, " + (total ? fmt(total) : "no disclosed amount") : "Showing <b>all " + rows.length + " round" + (rows.length > 1 ? "s" : "") + "</b>";
      chipClear.hidden = !any;
      none.hidden = shown > 0;
      if (push !== false && window.history && history.replaceState) {
        var p = new URLSearchParams();
        ["c", "country", "stage", "sector"].forEach(function (k) { sel[k].forEach(function (v) { p.append(k, v); }); });
        if (m) p.set("min", m);
        if (text) p.set("q", text);
        var s = p.toString();
        history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
      }
    }
    function clear() {
      boxes.forEach(function (b) { b.checked = false; });
      min.value = "0"; q.value = ""; apply();
    }
    // initial state from the URL (links from the home page treemap and legend)
    var params = new URLSearchParams(location.search);
    boxes.forEach(function (b) { if (params.getAll(b.name).indexOf(b.value) >= 0) b.checked = true; });
    if (params.get("min")) min.value = params.get("min");
    if (params.get("q")) q.value = params.get("q");
    var extra = aside.querySelectorAll("[data-extra]"), more = document.getElementById("more-c");
    if (more) {
      Array.prototype.forEach.call(extra, function (b) { if (!b.checked) b.parentNode.hidden = true; });
      more.addEventListener("click", function () { Array.prototype.forEach.call(extra, function (b) { b.parentNode.hidden = false; }); more.hidden = true; });
    }
    aside.addEventListener("change", function () { apply(); });
    q.addEventListener("input", function () { apply(); });
    document.getElementById("f-clear").addEventListener("click", clear);
    chipClear.addEventListener("click", clear);
    bar.forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var cur = checked("c"), only = cur.length === 1 && cur[0] === a.dataset.k;
        boxes.forEach(function (b) { if (b.name === "c") b.checked = !only && b.value === a.dataset.k; });
        apply();
      });
    });
    apply(false);
  }

  function ready() {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawMap); else drawMap();
    var t;
    window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(drawMap, 150); });
    filters();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();

// ---------- startup lists: region chips and progressive loading (12 at a time, more on scroll) ----------
(function () {
  "use strict";
  document.querySelectorAll(".list").forEach(function (list) {
    var box = list.querySelector(".cards"); if (!box) return;
    var units = Array.prototype.slice.call(box.querySelectorAll(".card"));
    var page = Number(box.getAttribute("data-page")) || 12, shown = page, filter = "all";
    var btn = list.querySelector(".more-btn"), chips = Array.prototype.slice.call(list.querySelectorAll(".chips button"));
    function match(u) { return filter === "all" || u.getAttribute("data-c") === filter; }
    function render() {
      var n = 0, total = 0;
      units.forEach(function (u) {
        var ok = match(u); if (ok) total++;
        if (ok && n < shown) { u.removeAttribute("data-hide"); n++; } else u.setAttribute("data-hide", "");
      });
      if (btn) { btn.hidden = n >= total; btn.textContent = "Show more startups (" + (total - n) + " more)"; }
    }
    function more() { shown += page; render(); }
    if (btn) btn.addEventListener("click", more);
    if ("IntersectionObserver" in window && btn) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && !btn.hidden) more(); }); }, { rootMargin: "600px 0px" }).observe(btn);
    }
    function setFilter(f) {
      filter = f; shown = page;
      chips.forEach(function (c) { c.classList.toggle("on", c.getAttribute("data-f") === f); });
      render();
    }
    chips.forEach(function (c) { c.addEventListener("click", function () { setFilter(c.getAttribute("data-f")); }); });
    document.querySelectorAll(".tile[data-f]").forEach(function (t) {
      t.addEventListener("click", function () { setFilter(t.getAttribute("data-f")); });
    });
    // a link to a specific startup (#r-123) reveals everything so the anchor exists
    if (location.hash && /^#r-\d+$/.test(location.hash)) { shown = units.length; }
    render();
  });
})();

// ---------- jobs board: tabs, function chips, founding/remote/fractional toggles ----------
(function () {
  "use strict";
  var board = document.getElementById("board"); if (!board) return;
  var tab = "fresh", fn = "all";
  var tabs = [].slice.call(board.querySelectorAll(".tabs button")), chips = [].slice.call(board.querySelectorAll(".fnchips button"));
  var toggles = [].slice.call(board.querySelectorAll(".toggles input")), cos = [].slice.call(board.querySelectorAll(".jcard"));
  var none = board.querySelector(".jnone");
  function render() {
    var want = toggles.filter(function (t) { return t.checked; }).map(function (t) { return t.value; }), shown = 0;
    cos.forEach(function (co) {
      var n = 0;
      if (co.getAttribute("data-tab") === tab) {
        [].slice.call(co.querySelectorAll(".role")).forEach(function (r) {
          var tags = (r.getAttribute("data-tags") || "").split(" ");
          var ok = (fn === "all" || r.getAttribute("data-fn") === fn) && want.every(function (w) { return tags.indexOf(w) >= 0; });
          r.hidden = !ok || n >= 3; if (ok) n++;   // the card shows the first three matching roles
        });
      }
      var more = co.querySelector(".c-more");
      if (more) { more.hidden = n <= 3; more.textContent = "+ " + (n - 3) + " more " + (n - 3 === 1 ? "role" : "roles"); }
      co.hidden = n === 0; shown += n;
    });
    if (none) none.hidden = shown > 0;
  }
  tabs.forEach(function (b) { b.addEventListener("click", function () { tab = b.getAttribute("data-tab"); tabs.forEach(function (x) { x.classList.toggle("on", x === b); }); render(); }); });
  chips.forEach(function (b) { b.addEventListener("click", function () { fn = b.getAttribute("data-fn"); chips.forEach(function (x) { x.classList.toggle("on", x === b); }); render(); }); });
  toggles.forEach(function (t) { t.addEventListener("change", render); });
  render();
})();

// ---------- detail panel: clicking a card slides in its full details from the left ----------
(function () {
  "use strict";
  var cards = document.querySelectorAll("[data-panel]"); if (!cards.length) return;
  var wrap = document.createElement("div");
  wrap.className = "pwrap"; wrap.hidden = true;
  wrap.innerHTML = '<div class="pshade"></div><aside class="panel" role="dialog" aria-modal="true" aria-label="Details" tabindex="-1">' +
    '<div class="pbar"><button type="button" class="pclose" aria-label="Close">&larr; Back</button><a class="pfullpage" href="#">Open full page</a></div><div class="pbody"></div></aside>';
  document.body.appendChild(wrap);
  var panel = wrap.querySelector(".panel"), body = wrap.querySelector(".pbody"), full = wrap.querySelector(".pfullpage");
  var last = null, openId = null;
  function open(card, push) {
    var t = card.querySelector("template.full"); if (!t) return;
    body.innerHTML = ""; body.appendChild(t.content.cloneNode(true));
    var link = card.querySelector(".c-name a");
    var href = link && link.getAttribute("href");
    full.hidden = !href || href === "#" || /^https?:/.test(href); if (!full.hidden) full.href = href;
    last = card; openId = card.id;
    wrap.hidden = false; document.documentElement.classList.add("pnl-open");
    requestAnimationFrame(function () { wrap.classList.add("on"); panel.focus(); });
    body.scrollTop = 0;
    if (push && history.pushState) history.pushState({ panel: card.id }, "", "#" + card.id);
  }
  function close(pop) {
    if (wrap.hidden) return;
    wrap.classList.remove("on"); document.documentElement.classList.remove("pnl-open");
    setTimeout(function () { wrap.hidden = true; body.innerHTML = ""; }, 220);
    if (!pop && history.state && history.state.panel) history.back();
    if (last) last.focus({ preventScroll: true });
    openId = null;
  }
  [].forEach.call(cards, function (card) {
    card.setAttribute("tabindex", "0");
    card.addEventListener("click", function (e) {
      var a = e.target.closest("a");
      if (a && (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey)) return;   // outside links and new-tab clicks behave normally
      e.preventDefault(); open(card, true);
    });
    card.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); open(card, true); } });
  });
  wrap.querySelector(".pshade").addEventListener("click", function () { close(false); });
  wrap.querySelector(".pclose").addEventListener("click", function () { close(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(false); });
  window.addEventListener("popstate", function () {
    var id = location.hash.slice(1), card = id && document.getElementById(id);
    if (card && card.hasAttribute("data-panel")) open(card, false); else close(true);
  });
  // a shared link to one startup (#r-123) opens its panel
  var id0 = location.hash.slice(1), c0 = id0 && document.getElementById(id0);
  if (c0 && c0.hasAttribute("data-panel")) { c0.scrollIntoView({ block: "center" }); open(c0, false); }
})();
