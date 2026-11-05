// 台股止跌訊號：讀取 data/latest.json，分別繪製電腦版與手機版畫面。
// 所有來自資料檔的文字皆經過跳脫處理；外部連結僅允許 https。
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var DATA = null;
  var UI = { tab: "tw", lampDesk: null, lampMob: null, jpRange: "d", fxRange: "3m" };
  var STATES = { on: "亮燈（條件成立）", off: "未亮（條件未成立）", na: "資料不足" };

  /* ---------- 工具 ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function n(v) { var x = Number(v); return v == null || v === "" || !isFinite(x) ? null : x; }
  function fmt(v, d) { v = n(v); return v == null ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(v) { v = n(v); return v == null ? "—" : (v > 0 ? "+" : "") + (v * 100).toFixed(2) + "%"; }
  function sgn(v, d) { v = n(v); return v == null ? "—" : (v > 0 ? "+" : "") + fmt(v, d); }
  function cls(v) { v = n(v); return v > 0 ? "up" : v < 0 ? "down" : "muted"; }
  function md(s) { return s ? esc(String(s).slice(5)) : ""; }
  function time(iso) { if (!iso) return ""; var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); }
  function safeUrl(u) { try { var x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; } }
  function head(title, note) { return '<div class="h"><h2>' + esc(title) + "</h2>" + (note ? "<span>" + esc(note) + "</span>" : "") + "</div>"; }

  /* ---------- 圖表 ---------- */
  function kChart(tw, H) {
    var bars = tw.bars || [], m20 = tw.ma20 || [], m120 = tw.ma120 || [];
    if (!bars.length) return '<p class="empty">指數資料未取得。</p>';
    var W = 520, pl = 46, pr = 4, pt = 6, pb = 16, vals = [];
    H = H || 220;
    bars.forEach(function (b, i) { [b.h, b.l, b.c, m20[i], m120[i]].forEach(function (v) { if (n(v) != null) vals.push(n(v)); }); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = (hi - lo) || 1; lo -= sp * .03; hi += sp * .03;
    var step = (W - pl - pr) / bars.length, bw = Math.max(1.5, Math.min(7, step * .62));
    function X(i) { return pl + step * i + step / 2; } function Y(v) { return pt + (hi - v) / (hi - lo) * (H - pt - pb); }
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="加權指數 K 線，含月線與半年線">';
    for (var g = 0; g <= 3; g++) { var v = lo + (hi - lo) * g / 3, y = Y(v); s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="grid"/><text x="' + (pl - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" class="ax">' + fmt(v) + "</text>"; }
    bars.forEach(function (b, i) {
      var o = n(b.o), c = n(b.c), h = n(b.h), l = n(b.l); if (c == null) return;
      if (o == null) o = c; if (h == null) h = Math.max(o, c); if (l == null) l = Math.min(o, c);
      var k = c >= o ? "up" : "down", x = X(i), top = Y(Math.max(o, c)), bot = Y(Math.min(o, c));
      s += "<g><title>" + esc(b.date) + "　開 " + fmt(o, 2) + "　高 " + fmt(h, 2) + "　低 " + fmt(l, 2) + "　收 " + fmt(c, 2) + "</title>";
      s += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + Y(h).toFixed(1) + '" y2="' + Y(l).toFixed(1) + '" class="s-' + k + '"/>';
      s += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, bot - top).toFixed(1) + '" class="f-' + k + '"/></g>';
    });
    function pts(a) { return a.map(function (v, i) { v = n(v); return v == null ? null : X(i).toFixed(1) + "," + Y(v).toFixed(1); }).filter(Boolean).join(" "); }
    var p20 = pts(m20), p120 = pts(m120);
    if (p20) s += '<polyline points="' + p20 + '" class="l-ma20"/>';
    if (p120) s += '<polyline points="' + p120 + '" class="l-ma120"/>';
    s += '<text x="' + pl + '" y="' + (H - 3) + '" class="ax">' + md(bars[0].date) + '</text><text x="' + (W - pr) + '" y="' + (H - 3) + '" text-anchor="end" class="ax">' + md(bars[bars.length - 1].date) + "</text></svg>";
    return s + '<div class="legend"><span><i style="border-color:var(--up)"></i>上漲</span><span><i style="border-color:var(--down)"></i>下跌</span><span><i style="border-color:var(--ma20)"></i>月線（20 日）</span><span><i style="border-color:var(--ma120);border-top-style:dashed"></i>半年線（120 日）</span></div>';
  }

  // 折線圖：自動略過休市或缺值的點，縱軸依資料範圍自動放大
  function lineChart(points, opt) {
    opt = opt || {};
    var pts = (points || []).map(function (p) { return { d: p.date, t: p.t, v: n(p.v) }; }).filter(function (p) { return p.v != null && (opt.allowZero || p.v > 0); });
    if (pts.length < 2) return '<p class="empty">' + esc(opt.empty || "資料不足。") + "</p>";
    var W = opt.w || 440, H = opt.h || 170, pl = 52, pr = 6, pt = 8, pb = 20;
    var vs = pts.map(function (p) { return p.v; });
    if (n(opt.base) != null) vs.push(n(opt.base));
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), sp = (hi - lo) || Math.abs(hi) * .01 || 1; lo -= sp * .08; hi += sp * .08;
    function X(i) { return pl + 8 + (W - pl - pr - 16) * i / (pts.length - 1); } function Y(v) { return pt + (hi - v) / (hi - lo) * (H - pt - pb); }
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opt.label || "走勢圖") + '">';
    for (var g = 0; g <= 3; g++) { var v = lo + (hi - lo) * g / 3, y = Y(v); s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="grid"/><text x="' + (pl - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="ax">' + fmt(v, opt.dp || 0) + "</text>"; }
    if (n(opt.base) != null) { var by = Y(n(opt.base)); s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + by.toFixed(1) + '" y2="' + by.toFixed(1) + '" class="base"/><text x="' + (W - pr) + '" y="' + (by - 4).toFixed(1) + '" text-anchor="end" class="ax">' + esc(opt.baseLabel || "") + "</text>"; }
    var line = pts.map(function (p, i) { return X(i).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var c = opt.cls;
    if (!c) c = (n(opt.base) != null ? pts[pts.length - 1].v >= n(opt.base) : pts[pts.length - 1].v >= pts[0].v) ? "l-up" : "l-down";
    s += '<polyline points="' + line + '" class="' + c + '"/>';
    var lab = opt.xlab || function (p) { return p.t || (p.d ? String(p.d).slice(5) : ""); };
    if (pts.length <= 8) {
      // 資料點少（例如本週）：每一點都標示日期，並以圓點表示
      pts.forEach(function (p, i) {
        var x = X(i), anchor = i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle";
        s += '<circle cx="' + x.toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3" class="dot-' + (c === "l-down" ? "down" : c === "l-up" ? "up" : "acc") + '"><title>' + esc(lab(p)) + "　" + fmt(p.v, opt.dp || 2) + "</title></circle>";
        s += '<text x="' + x.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '" class="ax">' + esc(lab(p)) + "</text>";
      });
    } else {
      var mid = Math.floor((pts.length - 1) / 2);
      s += '<text x="' + pl + '" y="' + (H - 4) + '" class="ax">' + esc(lab(pts[0])) + '</text><text x="' + X(mid).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" class="ax">' + esc(lab(pts[mid])) + '</text><text x="' + (W - pr) + '" y="' + (H - 4) + '" text-anchor="end" class="ax">' + esc(lab(pts[pts.length - 1])) + "</text>";
    }
    return s + "</svg>";
  }

  // 期間切換按鈕
  function rangeSeg(name, opts, cur) {
    return '<div class="rseg" role="group" aria-label="期間">' + opts.map(function (o) {
      return '<button type="button" data-range="' + name + '" data-val="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  function headR(title, rightHtml) { return '<div class="h"><h2>' + esc(title) + "</h2>" + rightHtml + "</div>"; }
  function sinceDate(last, key) {
    var d = new Date(last + "T00:00:00Z");
    if (key === "w") { var wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); }
    else if (key === "1m") d.setUTCMonth(d.getUTCMonth() - 1);
    else if (key === "3m") d.setUTCMonth(d.getUTCMonth() - 3);
    else if (key === "6m") d.setUTCMonth(d.getUTCMonth() - 6);
    return d.toISOString().slice(0, 10);
  }
  function inRange(bars, key) {
    if (!bars || !bars.length) return [];
    var from = sinceDate(bars[bars.length - 1].date, key);
    return bars.filter(function (b) { return b.date >= from; });
  }

  function barChart(list) {
    if (!list || !list.length) return '<p class="empty">外資資料未取得。</p>';
    var W = 520, H = 130, pl = 46, pr = 4, pt = 6, pb = 16, mid = pt + (H - pt - pb) / 2;
    var max = Math.max.apply(null, [100].concat(list.map(function (x) { return Math.abs(n(x.value) || 0); })));
    var step = (W - pl - pr) / list.length;
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="外資每日買賣超，紅色為買超，綠色為賣超"><line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + mid + '" y2="' + mid + '" class="grid"/>';
    s += '<text x="' + (pl - 6) + '" y="' + (pt + 8) + '" text-anchor="end" class="ax">+' + fmt(max) + '</text><text x="' + (pl - 6) + '" y="' + (H - pb) + '" text-anchor="end" class="ax">-' + fmt(max) + "</text>";
    list.forEach(function (x, i) {
      var v = n(x.value) || 0, h = Math.abs(v) / max * (H - pt - pb) / 2, y = v >= 0 ? mid - h : mid;
      s += '<rect x="' + (pl + step * i + step * .18).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (step * .64).toFixed(1) + '" height="' + Math.max(1, h).toFixed(1) + '" class="' + (v >= 0 ? "f-up" : "f-down") + '"><title>' + esc(x.date) + "　" + sgn(v, 2) + " 億元</title></rect>";
    });
    return s + '<text x="' + pl + '" y="' + (H - 3) + '" class="ax">' + md(list[0].date) + '</text><text x="' + (W - pr) + '" y="' + (H - 3) + '" text-anchor="end" class="ax">' + md(list[list.length - 1].date) + "</text></svg>";
  }

  function spark(bars) {
    var cs = (bars || []).map(function (b) { return n(b.c); }).filter(function (v) { return v != null; });
    if (cs.length < 2) return "";
    var W = 96, H = 26, lo = Math.min.apply(null, cs), hi = Math.max.apply(null, cs), r = (hi - lo) || 1;
    var p = cs.map(function (c, i) { return (i / (cs.length - 1) * W).toFixed(1) + "," + (H - 2 - (c - lo) / r * (H - 4)).toFixed(1); }).join(" ");
    return '<svg viewBox="0 0 ' + W + " " + H + '" class="spark" aria-hidden="true"><polyline points="' + p + '" class="' + (cs[cs.length - 1] >= cs[0] ? "l-up" : "l-down") + '"/></svg>';
  }

  /* ---------- 區塊 ---------- */
  function lampsHtml(d, which) {
    var open = which === "desk" ? UI.lampDesk : UI.lampMob;
    var s = '<div class="lamps" role="group" aria-label="四項止跌訊號">';
    (d.signals || []).forEach(function (sg) {
      var st = STATES[sg.state] ? sg.state : "na";
      s += '<button type="button" class="lamp" data-lamp="' + esc(sg.key) + '" data-where="' + which + '" aria-expanded="' + (open === sg.key) + '"><span class="bulb ' + st + '" aria-hidden="true"></span><b>' + esc(sg.name) + "</b><small>" + esc(sg.text) + "</small></button>";
    });
    s += "</div>";
    var sel = (d.signals || []).filter(function (x) { return x.key === open; })[0];
    if (sel) s += '<div class="detail"><b>' + esc(sel.name) + "：" + esc(STATES[sel.state] || STATES.na) + "</b><p>目前：" + esc(sel.text) + "</p><p>" + esc(sel.rule || "資料不足時無法判斷。") + "</p></div>";
    var c = Math.max(0, Math.min(4, parseInt(d.count, 10) || 0));
    s += '<div class="verdict"><span class="big num">' + c + '<span class="muted" style="font-size:15px"> / 4</span></span><span class="mid">' + esc(d.verdict) + "</span></div>";
    return s;
  }

  function twStatsHtml(d) {
    var tw = d.tw; if (!tw) return '<p class="empty">指數資料未取得。</p>';
    var m20 = (tw.ma20 || [])[tw.ma20.length - 1], m120 = (tw.ma120 || [])[tw.ma120.length - 1], c = n(tw.last && tw.last.c), f = d.taifex;
    function rel(m) { m = n(m); return m && c ? (c >= m ? "高於 " : "低於 ") + Math.abs((c / m - 1) * 100).toFixed(1) + "%" : "資料不足"; }
    return '<div class="stat"><span class="big num">' + fmt(c, 2) + '</span><span class="chg ' + cls(tw.change) + '">' + pct(tw.change) + "</span></div>" +
      '<div class="kv"><div><b class="num">' + fmt(m20) + "</b><small>月線，收盤" + rel(m20) + '</small></div><div><b class="num">' + fmt(m120) + "</b><small>半年線，收盤" + rel(m120) + '</small></div><div><b class="num">' + (f ? fmt(f.last) : "—") + "</b><small>台指期日盤" + (f && c ? "，價差 " + sgn(n(f.last) - c, 0) : "") + "</small></div></div>";
  }

  function nightHtml(d) {
    var f = d.taifex;
    if (!f || !f.night) return "";
    return '<div class="night"><span class="muted">台指期夜盤（' + esc(f.night.date || "") + '，15:00 至次日 05:00）</span><b class="num">' + fmt(f.night.last) + '</b><span class="num ' + cls(f.night.change) + '">' + sgn(f.night.change) + "（" + pct(f.night.changePct) + '）</span><span class="muted num">成交 ' + fmt(f.night.volume) + " 口</span></div>";
  }

  function intradayHtml(it, name) {
    if (!it || !it.points || it.points.length < 2) return '<p class="empty">今日盤中走勢資料未取得。</p>';
    var last = it.points[it.points.length - 1].v, base = n(it.prevClose);
    var chg = base ? last / base - 1 : null;
    return '<p class="muted" style="margin:0 0 6px;font-size:12px">' + esc(it.date || "") + "　" + esc(name) + (it.live ? " 盤中（約每 10 分鐘更新）" : " 盤中") + "，虛線為前一交易日收盤" + (base ? " " + fmt(base, 2) : "") + (chg != null ? '，收盤 <span class="' + cls(chg) + '">' + pct(chg) + "</span>" : "") + "</p>" +
      lineChart(it.points.map(function (p) { return { t: p.t, v: p.v }; }), { h: 190, base: base, baseLabel: "前收", label: name + "今日走勢" });
  }

  function k3mHtml(d) {
    var tw = d.tw; if (!tw) return '<p class="empty">指數資料未取得。</p>';
    var c = n(tw.last && tw.last.c);
    return kChart(tw, 230) + (tw.peak ? '<p class="muted" style="font-size:12px;margin:6px 0 0">近 120 日收盤高點 ' + fmt(tw.peak.c, 2) + "（" + esc(tw.peak.date) + "），目前距高點 " + (c ? ((c / n(tw.peak.c) - 1) * 100).toFixed(1) + "%" : "—") + "</p>" : "");
  }

  function topTable(items, opt) {
    if (!items || !items.length) return '<p class="empty">資料未取得。</p>';
    var s = '<table class="t"><thead><tr><th>名稱</th><th>收盤</th><th>漲跌幅</th><th>' + esc(opt.valueLabel) + "</th></tr></thead><tbody>";
    items.forEach(function (x) {
      s += "<tr><td>" + esc(x.name) + "<small>" + esc(x.code || x.sym || "") + '</small></td><td class="num">' + fmt(x.close, 2) + '</td><td class="num ' + cls(x.changePct) + '">' + pct(x.changePct) + '</td><td class="num">' + (opt.value ? opt.value(x) : fmt(x.value, 1)) + "</td></tr>";
    });
    return s + "</tbody></table>";
  }

  function newsHtml(list, limit) {
    list = (list || []).slice(0, limit || 8);
    if (!list.length) return '<p class="empty">目前沒有新聞資料。</p>';
    return '<ul class="news">' + list.map(function (x) {
      var u = safeUrl(x.link); if (!u) return "";
      return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + "</a><small>來源：" + esc(x.source || "未標示") + (x.time ? "｜" + esc(time(x.time)) : "") + "</small></li>";
    }).join("") + "</ul>";
  }

  function usIndexTable(d) {
    if (!d.us || !d.us.length) return '<p class="empty">美股資料未取得。</p>';
    var s = '<table class="t"><thead><tr><th>指數</th><th>最新</th><th>漲跌</th><th>近一月</th></tr></thead><tbody>';
    d.us.forEach(function (u) {
      var pctMode = u.unit === "%";
      s += "<tr><td>" + esc(u.name) + '</td><td class="num">' + fmt(u.last, 2) + (pctMode ? "%" : "") + '</td><td class="num ' + cls(u.change) + '">' + (pctMode ? sgn(u.diff, 2) + " 點" : pct(u.change)) + "</td><td>" + spark(u.bars) + "</td></tr>";
    });
    return s + "</tbody></table>";
  }

  var JP_RANGES = [["d", "今日"], ["w", "本週"], ["1m", "1 個月"], ["3m", "3 個月"], ["6m", "半年"]];
  var FX_RANGES = [["1m", "1 個月"], ["3m", "3 個月"], ["6m", "半年"]];

  function jpIndexHtml(d) {
    var j = d.jp; if (!j) return '<p class="empty">日股資料未取得。</p>';
    var r = UI.jpRange, chart, jb0 = j.index.bars || [];
    var jchg = n(j.index.change);
    if (jchg == null && jb0.length > 1) jchg = n(jb0[jb0.length - 1].c) / n(jb0[jb0.length - 2].c) - 1;
    if (r === "d" && j.intraday && j.intraday.points && j.intraday.points.length > 1) chart = intradayHtml(j.intraday, "日經 225");
    else if (r === "d") {
      var wk = inRange(jb0, "w");
      chart = '<p class="muted" style="margin:0 0 6px;font-size:12px">日經今日盤中資料目前無法取得（來源限制），以下改顯示本週走勢。</p>' +
        lineChart(wk.map(function (x) { return { date: x.date, v: x.c }; }), { h: 190, label: "日經 225 本週走勢", empty: "此期間資料不足。" });
    }
    else {
      var b = inRange(j.index.bars || [], r);
      var chg = b.length > 1 ? n(b[b.length - 1].c) / n(b[0].c) - 1 : null;
      chart = '<p class="muted" style="margin:0 0 6px;font-size:12px">' + (b.length ? esc(b[0].date) + " 至 " + esc(b[b.length - 1].date) : "") + (chg != null ? '，區間漲跌 <span class="' + cls(chg) + '">' + pct(chg) + "</span>" : "") + "</p>" +
        lineChart(b.map(function (x) { return { date: x.date, v: x.c }; }), { h: 190, label: "日經 225 走勢", empty: "此期間資料不足。" });
    }
    return '<div class="stat"><span class="big num">' + fmt(j.index.last, 2) + '</span><span class="chg ' + cls(jchg) + '">' + pct(jchg) + '</span><span class="muted">日經 225｜' + md(j.index.date) + (j.src === "FRED" ? "（FRED，約延遲 1 個交易日）" : "") + "</span></div>" +
      '<div class="kv"><div><b class="num">' + fmt(j.usdjpy && j.usdjpy.last, 2) + '</b><small>美元兌日圓</small></div><div><b class="num ' + cls(j.usdjpy && j.usdjpy.change) + '">' + pct(j.usdjpy && j.usdjpy.change) + '</b><small>日圓匯率變動</small></div><div><b class="num">' + esc(j.src || "—") + "</b><small>資料來源</small></div></div>" + chart;
  }

  function fxMain(d, compact) {
    var f = d.fx; if (!f) return '<p class="empty">匯率資料未取得。</p>';
    var r = f.usdtwd, v = f.vol || {}, key = UI.fxRange;
    var rows = (r.bars || []).map(function (b, i) { return { date: b.date, c: b.c, vol: (v.series || [])[i] }; }).filter(function (b) { return n(b.c) > 0; });
    var sel = inRange(rows, key);
    var chg = sel.length > 1 ? n(sel[sel.length - 1].c) / n(sel[0].c) - 1 : null;
    var rate = '<div class="stat"><span class="big num">' + fmt(r.last, 3) + '</span><span class="chg ' + cls(r.change) + '">' + pct(r.change) + '</span></div><p class="muted" style="margin:4px 0 8px;font-size:12px">美元兌新台幣，數字變大代表新台幣貶值' + (chg != null ? '；區間變動 <span class="' + cls(chg) + '">' + pct(chg) + "</span>" : "") + "</p>" +
      lineChart(sel.map(function (b) { return { date: b.date, v: b.c }; }), { h: compact ? 180 : 200, dp: 2, label: "美元兌新台幣走勢", empty: "此期間資料不足。" });
    var vol = '<div class="stat"><span class="big num">' + fmt(v.current, 2) + '%</span><span class="muted">20 日年化波動度</span></div>' +
      '<div class="kv"><div><b class="num">' + fmt(v.avg, 2) + '%</b><small>一年平均</small></div><div><b class="num">' + fmt(v.max, 2) + '%</b><small>一年最高</small></div><div><b class="num">' + (n(v.rank) != null ? Math.round(v.rank * 100) + "%" : "—") + "</b><small>一年百分位</small></div></div>" +
      lineChart(sel.map(function (b) { return { date: b.date, v: b.vol }; }), { h: compact ? 150 : 160, dp: 1, cls: "l-acc", label: "新台幣匯率波動度走勢", empty: "此期間資料不足。" });
    return { rate: rate, vol: vol };
  }

  function fxOthers(d) {
    var o = d.fx && d.fx.others; if (!o || !o.length) return '<p class="empty">資料未取得。</p>';
    return '<table class="t"><thead><tr><th>匯率</th><th>最新</th><th>漲跌</th></tr></thead><tbody>' + o.map(function (x) {
      return "<tr><td>" + esc(x.name) + '</td><td class="num">' + fmt(x.last, 4) + '</td><td class="num ' + cls(x.change) + '">' + pct(x.change) + "</td></tr>";
    }).join("") + "</tbody></table>";
  }

  function usNote(d) {
    var f = (d.us || []).some(function (u) { return u.src === "FRED"; });
    return f ? "部分資料來自 FRED，可能延遲 1 個交易日" : "前一交易日收盤";
  }
  function fxNote(d) {
    var f = d.fx; if (!f) return "";
    return "資料日期 " + (f.usdtwd && f.usdtwd.date ? f.usdtwd.date.slice(5) : "—") + (f.src ? "｜" + f.src : "");
  }

  function legalHtml(d) {
    return '<div class="legal"><h2>重要聲明與風險警語</h2><ol>' +
      "<li>本網站所載資訊僅供一般參考，不構成任何投資建議、要約或招攬，亦不代表對任何金融商品之推薦。</li>" +
      "<li>投資一定有風險，股票、期貨及外匯投資有賺有賠，過去績效不代表未來表現。投資人應審慎評估自身財務狀況與風險承受能力，獨立判斷並自負盈虧。</li>" +
      "<li>融資、期貨及槓桿型 ETF 等槓桿交易，可能產生超過原始投入金額之損失，交易前請充分了解商品特性與風險。</li>" +
      "<li>「止跌訊號」係依固定規則計算之技術性參考指標，不保證市場走勢，不應作為唯一之投資決策依據。</li>" +
      "<li>本網站資料取自公開來源並經程式自動整理，可能有延遲、遺漏或錯誤；實際數據以各資料來源之官方公告為準。</li>" +
      "<li>新聞標題與連結之著作權屬原刊登媒體所有，本網站僅提供索引，內容以原始報導為準。</li>" +
      "<li>本網站與下列資料來源機構無任何關聯，亦未獲其授權或背書。使用本網站即表示您已閱讀並同意上述聲明。</li>" +
      '</ol><div class="src">資料來源：臺灣證券交易所、臺灣期貨交易所、Yahoo Finance、美國聯準會經濟資料庫（FRED）、Google 新聞。本網站資料為收盤後整理，並非即時報價。資料更新時間 ' + esc(time(d && d.updatedAt)) + "。</div></div>";
  }

  /* ---------- 電腦版 ---------- */
  function renderDesk(d) {
    var tt = d.twTop || {};
    var fx = fxMain(d, false);
    var h = "";
    h += '<div class="cols even">';
    h += "<section>" +
      '<div class="blk">' + head("指示訊號", "點選燈號查看說明") + lampsHtml(d, "desk") + "</div>" +
      '<div class="blk">' + head("加權指數｜今日走勢", (d.tw && d.tw.intraday ? d.tw.intraday.src : (d.tw && d.tw.src) || "")) + twStatsHtml(d) + intradayHtml(d.tw && d.tw.intraday, "加權指數") + nightHtml(d) + "</div>" +
      '<div class="blk">' + head("外資買賣超（億元）", "近 " + ((d.foreign || []).length) + " 個交易日") + barChart(d.foreign) + "</div>" +
      "</section>";
    h += "<section>" +
      '<div class="blk">' + head("加權指數｜近 3 個月", "K 線與均線" + (d.tw && d.tw.src ? "｜" + d.tw.src : "")) + k3mHtml(d) + "</div>" +
      '<div class="blk">' + head("今日成交前十", "依" + (tt.basis || "成交金額") + "排序") + topTable(tt.items, { valueLabel: tt.basis === "成交金額" ? "成交值（億）" : "成交量（張）", value: function (x) { return fmt(x.value, tt.basis === "成交金額" ? 1 : 0); } }) + "</div>" +
      '<div class="blk">' + head("台灣財經新聞") + newsHtml(d.news && d.news.tw, 5) + "</div>" +
      "</section></div>";
    h += '<hr class="dash">';
    h += '<div class="cols even"><section>' +
      '<div class="blk">' + head("美股", usNote(d)) + usIndexTable(d) + "</div>" +
      '<div class="blk">' + head("美股熱門股", "主要大型股中依成交金額排序") + topTable(d.usTop, { valueLabel: "成交額（億美元）", value: function (x) { return fmt(n(x.value) / 1e8, 1); } }) + "</div>" +
      '<div class="blk">' + head("美國財經新聞") + newsHtml(d.news && d.news.us, 4) + "</div>" +
      "</section><section>" +
      '<div class="blk">' + headR("日股", rangeSeg("jp", JP_RANGES, UI.jpRange)) + jpIndexHtml(d) + "</div>" +
      '<div class="blk">' + head("日股熱門股", "主要大型股中依成交金額排序") + topTable(d.jpTop, { valueLabel: "成交額（億日圓）", value: function (x) { return fmt(n(x.value) / 1e8, 0); } }) + "</div>" +
      '<div class="blk">' + head("日本財經新聞") + newsHtml(d.news && d.news.jp, 4) + "</div>" +
      "</section></div>";
    h += '<hr class="dash">';
    h += '<section>' + headR("匯率", '<span class="h-note">' + esc(fxNote(d)) + "</span>" + rangeSeg("fx", FX_RANGES, UI.fxRange)) + '<div class="fx-grid">' +
      "<div>" + head("新台幣兌美元") + (fx.rate || fx) + "</div>" +
      "<div>" + head("匯率波動度", "20 日年化歷史波動率") + (fx.vol || "") + "</div>" +
      "<div>" + head("其他主要匯率") + fxOthers(d) + '<div class="blk" style="margin-top:16px">' + head("匯率新聞") + newsHtml(d.news && d.news.fx, 3) + "</div></div>" +
      "</div></section>";
    h += '<hr class="solid">' + legalHtml(d);
    $("desk").innerHTML = h;
  }

  /* ---------- 手機版 ---------- */
  var TABS = [["tw", "台股"], ["us", "美股"], ["jp", "日股"], ["fx", "FX"]];
  function renderMob(d) {
    var h = '<nav class="tabs" role="tablist" aria-label="市場">' + TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (UI.tab === t[0]) + '">' + t[1] + "</button>";
    }).join("") + '</nav><div class="pane" role="tabpanel">';
    var tt = d.twTop || {};
    if (UI.tab === "tw") {
      h += '<div class="blk">' + head("止跌訊號", "點選燈號查看說明") + lampsHtml(d, "mob") + "</div>";
      h += '<div class="blk">' + head("加權指數｜今日走勢", d.asOf || "") + twStatsHtml(d) + intradayHtml(d.tw && d.tw.intraday, "加權指數") + nightHtml(d) + "</div>";
      h += '<div class="blk">' + head("加權指數｜近 3 個月", "K 線與均線") + k3mHtml(d) + "</div>";
      h += '<div class="blk">' + head("外資買賣超（億元）") + barChart(d.foreign) + "</div>";
      h += '<div class="blk">' + head("今日熱門股", "依" + (tt.basis || "成交金額") + "排序") + topTable(tt.items, { valueLabel: tt.basis === "成交金額" ? "成交值（億）" : "成交量（張）", value: function (x) { return fmt(x.value, tt.basis === "成交金額" ? 1 : 0); } }) + "</div>";
      h += '<div class="blk">' + head("新聞") + newsHtml(d.news && d.news.tw, 8) + "</div>";
    } else if (UI.tab === "us") {
      h += '<div class="blk">' + head("美股指數", usNote(d)) + usIndexTable(d) + "</div>";
      h += '<div class="blk">' + head("今日熱門股", "主要大型股中依成交金額排序") + topTable(d.usTop, { valueLabel: "成交額（億美元）", value: function (x) { return fmt(n(x.value) / 1e8, 1); } }) + "</div>";
      h += '<div class="blk">' + head("新聞") + newsHtml(d.news && d.news.us, 8) + "</div>";
    } else if (UI.tab === "jp") {
      h += '<div class="blk">' + head("日股指數") + rangeSeg("jp", JP_RANGES, UI.jpRange) + jpIndexHtml(d) + "</div>";
      h += '<div class="blk">' + head("今日熱門股", "主要大型股中依成交金額排序") + topTable(d.jpTop, { valueLabel: "成交額（億日圓）", value: function (x) { return fmt(n(x.value) / 1e8, 0); } }) + "</div>";
      h += '<div class="blk">' + head("新聞") + newsHtml(d.news && d.news.jp, 8) + "</div>";
    } else {
      var fx = fxMain(d, true);
      h += '<div class="blk">' + head("新台幣兌美元", fxNote(d)) + rangeSeg("fx", FX_RANGES, UI.fxRange) + (fx.rate || fx) + "</div>";
      h += '<div class="blk">' + head("匯率波動度", "20 日年化歷史波動率") + (fx.vol || "") + "</div>";
      h += '<div class="blk">' + head("其他主要匯率") + fxOthers(d) + "</div>";
      h += '<div class="blk">' + head("新聞") + newsHtml(d.news && d.news.fx, 8) + "</div>";
    }
    h += '</div><hr class="solid">' + legalHtml(d);
    $("mob").innerHTML = h;
  }

  function render() {
    if (!DATA) return;
    renderDesk(DATA); renderMob(DATA);
    $("stamp").textContent = "資料 " + (DATA.asOf ? DATA.asOf.slice(5).replace("-", "/") : "—") + "｜更新 " + time(DATA.updatedAt);
    var hours = (Date.now() - new Date(DATA.updatedAt).getTime()) / 36e5, w = $("warn");
    if (hours > 30) { w.textContent = "資料已超過 " + Math.floor(hours) + " 小時未更新，可能遇到假日或排程暫停。"; w.hidden = false; } else w.hidden = true;
    document.documentElement.style.setProperty("--bar-h", $("bar").offsetHeight + "px");
  }

  /* ---------- 互動 ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-lamp],[data-tab],[data-theme-set],[data-term],[data-close],[data-range]");
    if (!t) return;
    if (t.hasAttribute("data-range")) {
      var nm = t.getAttribute("data-range"), val = t.getAttribute("data-val");
      if (nm === "jp") UI.jpRange = val; else if (nm === "fx") UI.fxRange = val;
      store(nm + "Range", val); render();
      var b = document.querySelector('[data-range="' + nm + '"][data-val="' + val + '"]'); if (b) b.focus();
      return;
    }
    if (t.hasAttribute("data-lamp")) {
      var k = t.getAttribute("data-lamp"), where = t.getAttribute("data-where");
      if (where === "desk") UI.lampDesk = UI.lampDesk === k ? null : k; else UI.lampMob = UI.lampMob === k ? null : k;
      render();
      var again = document.querySelector('[data-lamp="' + k + '"][data-where="' + where + '"]'); if (again) again.focus();
    } else if (t.hasAttribute("data-tab")) {
      UI.tab = t.getAttribute("data-tab"); store("tab", UI.tab); render(); window.scrollTo(0, 0);
    } else if (t.hasAttribute("data-theme-set")) {
      setTheme(t.getAttribute("data-theme-set"));
    } else if (t.hasAttribute("data-term")) {
      openTerm(t.getAttribute("data-term"));
    } else if (t.hasAttribute("data-close")) {
      var dlg = t.closest("dialog"); if (dlg) dlg.close();
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (dlg) {
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  });
  $("btn-settings").addEventListener("click", function () { syncThemeButtons(); $("dlg-settings").showModal(); });
  $("btn-glossary").addEventListener("click", function () { $("dlg-settings").close(); $("dlg-glossary").showModal(); });
  $("btn-refresh").addEventListener("click", load);

  function store(k, v) { try { localStorage.setItem("tws-" + k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem("tws-" + k); } catch (e) { return null; } }
  function setTheme(t) {
    t = t === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    $("theme-color").setAttribute("content", t === "light" ? "#F3F4F6" : "#0C1117");
    store("theme", t); syncThemeButtons();
  }
  function syncThemeButtons() {
    var cur = document.documentElement.getAttribute("data-theme");
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-set]"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === cur)); });
  }

  /* ---------- 簡易股票說明 ---------- */
  var KSVG = '<svg viewBox="0 0 300 150" role="img" aria-label="紅 K 與綠 K 結構示意" style="max-width:300px;margin:4px 0 12px">' +
    '<line x1="50" y1="12" x2="50" y2="132" class="s-up" stroke-width="2"/><rect x="38" y="40" width="24" height="60" class="f-up"/>' +
    '<text x="72" y="16" class="ax" style="font-size:11px">最高價</text><text x="72" y="44" class="ax" style="font-size:11px">收盤價</text><text x="72" y="104" class="ax" style="font-size:11px">開盤價</text><text x="72" y="134" class="ax" style="font-size:11px">最低價</text>' +
    '<line x1="190" y1="12" x2="190" y2="132" class="s-down" stroke-width="2"/><rect x="178" y="40" width="24" height="60" class="f-down"/>' +
    '<text x="212" y="44" class="ax" style="font-size:11px">開盤價</text><text x="212" y="104" class="ax" style="font-size:11px">收盤價</text>' +
    '<text x="38" y="148" class="ax" style="font-size:11px">紅 K（上漲）</text><text x="178" y="148" class="ax" style="font-size:11px">綠 K（下跌）</text></svg>';
  var TERMS = [
    { k: "taiex", t: "加權指數", b: "<p>臺灣證券交易所編製的「發行量加權股價指數」（TAIEX），以上市公司市值加權計算，用來代表台股整體表現。市值越大的公司（例如台積電）對指數影響越大。</p>", s: "臺灣證券交易所（本站經由 Yahoo Finance 取得）" },
    { k: "kline", t: "K 線", b: KSVG + "<p>每根 K 線代表一個交易日的開盤、最高、最低、收盤四個價格。台灣慣例以紅色代表上漲（收盤高於開盤）、綠色代表下跌，與歐美相反。</p><p>粗的部分稱為實體，越長代表當日買方或賣方力道越明確。上下細線稱為影線：長上影線表示盤中上攻後遭賣壓壓回，長下影線表示盤中下探後有買盤承接。</p>", s: "臺灣證券交易所（本站經由 Yahoo Finance 取得）" },
    { k: "ma", t: "均線（月線、半年線）", b: "<p>均線是過去 N 個交易日收盤價的平均值連成的線，用來過濾每日波動、觀察趨勢。常見的有週線（5 日）、月線（20 日）、季線（60 日）、半年線（120 日）與年線（240 日）。</p><p>收盤站上均線，代表近期買進者平均處於獲利狀態；跌破則相反。短天期均線向上穿越長天期均線稱為黃金交叉，向下穿越稱為死亡交叉。均線屬落後指標，盤整時容易出現假訊號。</p>", s: "本站依加權指數收盤價自行計算" },
    { k: "foreign", t: "外資買賣超", b: "<p>外國機構投資人（含陸資）當日在台股的買進金額減去賣出金額。正數為買超，負數為賣超。外資持有台股市值比重高，其動向常被視為影響大盤的重要因素。</p>", s: "臺灣證券交易所「三大法人買賣金額統計表」" },
    { k: "margin", t: "融資餘額", b: "<p>投資人向券商借錢買股票的未償還總額，代表市場上的槓桿部位。股價大跌時，融資戶可能因擔保維持率不足而被強制賣出（俗稱斷頭），造成連鎖賣壓。融資餘額明顯減少，通常被視為籌碼趨於穩定。</p>", s: "臺灣證券交易所「信用交易統計」" },
    { k: "taifex", t: "台指期", b: "<p>以加權指數為標的的期貨契約（代號 TX），每點價值新台幣 200 元。期貨價格高於現貨稱為正價差，低於現貨稱為逆價差；逆價差擴大常被解讀為市場偏空。期貨為高槓桿商品，損失可能超過保證金。</p>", s: "臺灣期貨交易所「每日行情」" },
    { k: "top", t: "成交排行", b: "<p>台股依當日成交金額由高至低排序，代表市場資金最集中的個股與 ETF。美股與日股則是在主要大型股中，依最新交易日成交金額排序，並非全市場排行。</p>", s: "臺灣證券交易所；美股、日股為 Yahoo Finance" },
    { k: "fx", t: "新台幣匯率", b: "<p>本站顯示的是美元兌新台幣（USD/TWD），數字代表 1 美元可換多少新台幣。數字變大代表新台幣貶值，常與外資匯出資金同時發生；數字變小則代表新台幣升值。</p>", s: "Yahoo Finance" },
    { k: "vol", t: "匯率波動度", b: "<p>以最近 20 個交易日匯率每日變動幅度計算的標準差，再換算為年化百分比（歷史波動率）。數值越高代表匯率變動越劇烈。「一年百分位」表示目前數值在過去一年中的相對位置，例如 90% 代表比過去一年九成的時間都高。</p><p>此為本站自行計算之參考數值，並非官方發布的指數。</p>", s: "本站依 Yahoo Finance 匯率資料計算" },
    { k: "sox", t: "費城半導體指數", b: "<p>由美國主要半導體公司組成的股價指數（SOX），台積電 ADR 也是成分股之一。台股以電子與半導體為主，兩者走勢通常高度相關。</p>", s: "Yahoo Finance" },
    { k: "vix", t: "VIX 恐慌指數", b: "<p>由標普 500 指數選擇權價格推算的市場預期波動率。數值越高代表市場越恐慌，一般而言 20 以下屬平穩、30 以上屬高度不安。</p>", s: "Yahoo Finance" },
    { k: "tnx", t: "美國十年期公債殖利率", b: "<p>美國政府十年期公債的年化報酬率，是全球資金成本的重要參考。殖利率上升時，股票評價通常承壓，資金也較容易流向美元資產。</p>", s: "Yahoo Finance" },
    { k: "n225", t: "日經 225", b: "<p>由東京證券交易所 225 檔代表性股票組成的股價平均指數，是日本股市的主要指標。日圓匯率變動對日本出口企業與指數影響明顯。</p>", s: "Yahoo Finance" },
    { k: "signal", t: "四項止跌訊號", b: "<p>本站以四項條件觀察台股是否趨穩：外資賣超收斂、融資去化足夠、新台幣停止貶值、指數站回月線。成立 0 至 1 項為「繼續觀望」，2 項為「訊號初步出現」，3 項以上為「訊號較明確」。</p><p>此為固定規則的整理結果，無法預測未來走勢，僅供參考。</p>", s: "本站依臺灣證券交易所與 Yahoo Finance 資料計算" },
  ];
  $("terms").innerHTML = TERMS.map(function (x) { return '<button type="button" data-term="' + x.k + '">' + esc(x.t) + "</button>"; }).join("");
  function openTerm(k) {
    var x = TERMS.filter(function (t) { return t.k === k; })[0]; if (!x) return;
    $("dlg-term-t").textContent = x.t;
    $("term-body").innerHTML = x.b;
    $("term-src").textContent = "資料來源：" + x.s;
    var g = $("dlg-glossary"); if (g.open) g.close();
    $("dlg-term").showModal();
  }
  $("dlg-term").addEventListener("close", function () { if (!$("dlg-glossary").open) $("dlg-glossary").showModal(); });

  /* ---------- 載入 ---------- */
  function load() {
    $("btn-refresh").disabled = true;
    fetch("data/latest.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { DATA = d; render(); })
      .catch(function (e) {
        var msg = '<section style="padding:20px"><p>目前無法讀取資料（' + esc(e.message) + '）。若是第一次部署，請到 GitHub 的 Actions 頁面手動執行一次「更新市場資料」。</p></section>';
        $("desk").innerHTML = msg; $("mob").innerHTML = msg; $("stamp").textContent = "";
      })
      .then(function () { $("btn-refresh").disabled = false; });
  }

  setTheme(recall("theme") || "dark");
  var savedTab = recall("tab"); if (savedTab && /^(tw|us|jp|fx)$/.test(savedTab)) UI.tab = savedTab;
  var fr = recall("fxRange"); if (fr && /^(1m|3m|6m)$/.test(fr)) UI.fxRange = fr;
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") load(); });
  window.addEventListener("resize", function () { document.documentElement.style.setProperty("--bar-h", $("bar").offsetHeight + "px"); });
  load();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
})();
