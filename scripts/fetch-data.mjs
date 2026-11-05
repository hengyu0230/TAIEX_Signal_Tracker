// 由 GitHub Actions 定時執行：抓取證交所與 Yahoo Finance 資料，輸出 data/latest.json 供網頁讀取。
// 需求：Node.js 20 以上（內建 fetch）。本機測試：node scripts/fetch-data.mjs
import fs from "node:fs/promises";

const CFG = {
  FOREIGN_CALM: 200,   // 外資每日賣超小於此值（億元）視為收斂
  MARGIN_RATIO: 0.8,   // 融資降幅需達指數跌幅的比例
  FOREIGN_DAYS: 20,
  MAX_FETCH: 40,       // 每次執行最多向證交所補抓的天數
  TWSE_DELAY_MS: 1500, // 證交所請求間隔，避免被限制
  US: [
    { sym: "^GSPC", name: "標普 500" },
    { sym: "^IXIC", name: "那斯達克" },
    { sym: "^SOX", name: "費城半導體" },
    { sym: "TSM", name: "台積電 ADR" },
    { sym: "^TNX", name: "美國十年期公債殖利率", unit: "%" },
    { sym: "^VIX", name: "VIX 恐慌指數" },
  ],
  // 美股、日股熱門股：在以下主要大型股中，依最新交易日成交金額排序取前 10
  US_WATCH: [
    ["NVDA", "輝達"], ["AAPL", "蘋果"], ["MSFT", "微軟"], ["AMZN", "亞馬遜"], ["GOOGL", "Alphabet"],
    ["META", "Meta"], ["TSLA", "特斯拉"], ["AVGO", "博通"], ["AMD", "超微"], ["TSM", "台積電 ADR"],
    ["NFLX", "網飛"], ["PLTR", "Palantir"], ["JPM", "摩根大通"], ["LLY", "禮來"], ["COST", "好市多"],
  ],
  JP_WATCH: [
    ["7203.T", "豐田汽車"], ["6758.T", "索尼集團"], ["9984.T", "軟銀集團"], ["8035.T", "東京威力科創"],
    ["6857.T", "愛德萬測試"], ["9983.T", "迅銷"], ["8306.T", "三菱日聯金融"], ["6861.T", "基恩斯"],
    ["7974.T", "任天堂"], ["4063.T", "信越化學"], ["6501.T", "日立製作所"], ["8058.T", "三菱商事"],
    ["7011.T", "三菱重工"], ["6098.T", "瑞可利"], ["4519.T", "中外製藥"],
  ],
  NEWS: {
    tw: { q: "台股 OR 加權指數 OR 外資", hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant" },
    us: { q: "stock market OR Wall Street OR S&P 500", hl: "en-US", gl: "US", ceid: "US:en" },
    jp: { q: "日経平均 OR 東証", hl: "ja", gl: "JP", ceid: "JP:ja" },
    fx: { q: "新台幣 匯率", hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant" },
  },
  NEWS_COUNT: 8,
};

const CACHE_PATH = "data/twse-cache.json";
const OUT_PATH = "data/latest.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const errors = [];
let budget = CFG.MAX_FETCH;

let cache = { f: {}, m: {} };
try { cache = Object.assign(cache, JSON.parse(await fs.readFile(CACHE_PATH, "utf8"))); } catch {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tpeToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const ymd = s => s.replace(/-/g, "");
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = s => [0, 6].includes(new Date(s + "T00:00:00Z").getUTCDay());
const toNum = x => { if (x == null) return null; const t = String(x).replace(/,/g, "").trim(); if (t === "" || t === "." || /^-+$/.test(t)) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
// 錯誤訊息只保留前 120 字，避免把外部網站的回應內容寫進公開資料檔
const errText = e => String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 120);

async function getJSON(url, timeoutMs = 20000, extraHeaders = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extraHeaders }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function allRows(obj, out = []) {
  if (Array.isArray(obj)) {
    if (obj.length && obj.every(c => typeof c === "string" || typeof c === "number")) out.push(obj);
    else obj.forEach(x => allRows(x, out));
  } else if (obj && typeof obj === "object") Object.values(obj).forEach(v => allRows(v, out));
  return out;
}

async function tryUrls(urls, parse) {
  let lastErr;
  for (const u of urls) {
    try {
      const j = await getJSON(u);
      if (j && j.stat && j.stat !== "OK") return { noData: true };
      return { value: parse(j) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const fetchForeign = date => tryUrls([
  `https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&dayDate=${ymd(date)}&type=day`,
  `https://www.twse.com.tw/fund/BFI82U?response=json&dayDate=${ymd(date)}&type=day`,
], j => {
  const row = allRows(j).find(r => typeof r[0] === "string" && r[0].trim().startsWith("外資及陸資"));
  if (!row) throw new Error("找不到外資欄位");
  return toNum(row[row.length - 1]) / 1e8; // 元 → 億元
});

const fetchMargin = date => tryUrls([
  `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${ymd(date)}&selectType=MS`,
  `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${ymd(date)}&selectType=MS`,
], j => {
  const row = allRows(j).find(r => typeof r[0] === "string" && r[0].includes("融資金額"));
  if (!row) throw new Error("找不到融資金額欄位");
  let v = toNum(row[5]);
  if (v == null) { const nums = row.slice(1).map(toNum).filter(x => x != null); v = nums.at(-1); }
  return v / 1e5; // 仟元 → 億元
});

async function getDay(kind, date, fn) {
  const store = cache[kind];
  if (Object.hasOwn(store, date)) return store[date];
  if (budget <= 0) return undefined;
  budget--;
  try {
    const r = await fn(date);
    await sleep(CFG.TWSE_DELAY_MS);
    if (r.noData) { if (date < tpeToday()) store[date] = null; return null; }
    store[date] = round(r.value, 2);
    if (store[date] == null) { delete store[date]; return undefined; }
    return store[date];
  } catch (e) {
    errors.push(`${kind === "f" ? "外資" : "融資"} ${date}：${errText(e)}`);
    return undefined;
  }
}

async function series(kind, fn, need) {
  const out = [];
  let d = tpeToday();
  for (let i = 0; i < 60 && out.length < need; i++, d = addDays(d, -1)) {
    if (isWeekend(d)) continue;
    const v = await getDay(kind, d, fn);
    if (v === undefined && budget <= 0) break;
    if (v != null) out.push({ date: d, value: v });
  }
  return out.reverse();
}

// Yahoo Finance：先用一般方式，被拒時改用 cookie + crumb 驗證方式；連續失敗則暫停使用
let yAuth = null, yFails = 0;
async function yahooAuth() {
  if (yAuth !== null) return yAuth;
  yAuth = false;
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(";")[0]).join("; ");
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie }, signal: AbortSignal.timeout(15000) });
    const crumb = (await r2.text()).trim();
    if (r2.ok && crumb && crumb.length < 40 && !crumb.includes("<")) yAuth = { cookie, crumb };
  } catch {}
  return yAuth;
}
async function yahoo(sym, range, interval = "1d") {
  if (yFails >= 3) throw new Error("暫時無法連線");
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
  let j;
  try { j = await getJSON("https://query1.finance.yahoo.com" + path); }
  catch (e1) {
    const a = await yahooAuth();
    if (!a) { yFails++; throw e1; }
    const r = await fetch("https://query2.finance.yahoo.com" + path + "&crumb=" + encodeURIComponent(a.crumb), { headers: { "User-Agent": UA, Cookie: a.cookie, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { yFails++; throw new Error(`Yahoo HTTP ${r.status}`); }
    j = await r.json();
  }
  yFails = 0;
  const res = j.chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  const map = {};
  (res.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || !Number.isFinite(q.close[i])) return;
    const iso = new Date((t + off) * 1000).toISOString();
    const date = iso.slice(0, 10), key = interval === "1d" ? date : iso.slice(0, 16);
    map[key] = { date, t: iso.slice(11, 16), o: round(q.open[i]), h: round(q.high[i]), l: round(q.low[i]), c: round(q.close[i], 4), v: q.volume ? q.volume[i] : null };
  });
  const arr = Object.values(map).sort((a, b) => ((a.date + a.t) < (b.date + b.t) ? -1 : 1));
  if (interval === "1d") arr.forEach(b => delete b.t);
  return arr;
}

// 盤中走勢：Yahoo 5 分鐘線，只保留最後一個交易日
async function yahooIntraday(sym) {
  const pts = await yahoo(sym, "1d", "5m");
  if (!pts.length) throw new Error("無盤中資料");
  const day = pts.at(-1).date;
  return { date: day, points: pts.filter(p => p.date === day).map(p => ({ t: p.t, v: p.c })) };
}

// 證交所：每 5 秒指數統計，取加權指數並整理為每分鐘一點（資料量大，給較長的等待時間）
async function twseIntraday(date) {
  const d = ymd(date);
  const urls = [
    `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX?date=${d}&response=json`,
    `https://www.twse.com.tw/exchangeReport/MI_5MINS_INDEX?response=json&date=${d}`,
    `https://www.twse.com.tw/indicesReport/MI_5MINS_INDEX?response=json&date=${d}`,
  ];
  const msgs = [];
  for (const u of urls) {
    try {
      const j = await getJSON(u, 60000);
      if (j && j.stat && j.stat !== "OK") { msgs.push(String(j.stat).slice(0, 40)); continue; }
      const tables = [];
      if (Array.isArray(j.data)) tables.push({ fields: j.fields || [], data: j.data });
      (j.tables || []).forEach(t => { if (Array.isArray(t.data)) tables.push({ fields: t.fields || [], data: t.data }); });
      const tbl = tables.find(t => t.data.some(r => /^\d{2}:\d{2}/.test(String(r[0]).trim())));
      if (!tbl) { msgs.push("找不到時間欄位"); continue; }
      let ci = tbl.fields.findIndex(f => String(f).includes("發行量加權股價指數"));
      if (ci < 0) ci = tbl.fields.findIndex(f => String(f).includes("加權"));
      if (ci < 0) ci = 1;
      const byMin = {};
      tbl.data.forEach(r => {
        const t = String(r[0] || "").trim();
        if (!/^\d{2}:\d{2}(:\d{2})?$/.test(t)) return;
        const v = toNum(r[ci]); if (v == null || v <= 0) return;
        byMin[t.slice(0, 5)] = v;
      });
      const points = Object.keys(byMin).sort().map(t => ({ t, v: byMin[t] }));
      if (points.length >= 10) return { date, points };
      msgs.push("盤中資料不足");
    } catch (e) { msgs.push(errText(e)); }
    await sleep(1000);
  }
  throw new Error(msgs.join("；"));
}

// 證交所即時行情（基本市況報導）：盤中每次排程取一個點，累積成當日走勢
async function misIndexNow() {
  let cookie = "";
  try {
    const r0 = await fetch("https://mis.twse.com.tw/stock/index.jsp", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    cookie = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map(c => c.split(";")[0]).join("; ");
  } catch {}
  const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0&_=${Date.now()}`, 15000, cookie ? { Cookie: cookie, Referer: "https://mis.twse.com.tw/stock/index.jsp" } : {});
  const m = j && j.msgArray && j.msgArray[0];
  if (!m) throw new Error("即時行情無資料");
  const v = toNum(m.z), d = String(m.d || "");
  if (v == null || !/^\d{8}$/.test(d)) throw new Error("即時行情格式不符");
  return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, t: String(m.t || "").slice(0, 5), v, prevClose: toNum(m.y) };
}

// 美國聯準會經濟資料庫（FRED）：官方公開資料，不需金鑰；作為 Yahoo 無法使用時的備援
async function fred(id, days = 400) {
  const from = addDays(tpeToday(), -days);
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
  const lines = (await r.text()).trim().split(/\r?\n/).slice(1);
  const bars = lines.map(l => { const [d, v] = l.split(","); return { date: d, c: toNum(v) }; }).filter(b => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.c != null && b.c > 0);
  if (!bars.length) throw new Error("FRED 無資料");
  return bars;
}

// 證交所：加權指數每日開高低收（每月一次請求，過去月份存入快取）
async function twseIndexMonth(ym) {
  const urls = [
    `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym}01&response=json`,
    `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date=${ym}01`,
  ];
  let lastErr;
  for (const u of urls) {
    try {
      const j = await getJSON(u);
      if (j && j.stat && j.stat !== "OK") return [];
      return allRows(j).filter(r => /^\d{2,3}\/\d{2}\/\d{2}$/.test(String(r[0]).trim()) && r.length >= 5).map(r => {
        const [y, mo, d] = String(r[0]).trim().split("/");
        return { date: `${Number(y) + 1911}-${mo}-${d}`, o: toNum(r[1]), h: toNum(r[2]), l: toNum(r[3]), c: toNum(r[4]) };
      }).filter(b => b.c != null);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function twseIndexHistory(months = 10) {
  cache.idx = cache.idx || {};
  const today = tpeToday(), curYm = today.slice(0, 7).replace("-", "");
  let bars = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.slice(0, 7) + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - i);
    const ym = d.toISOString().slice(0, 7).replace("-", "");
    let rows = ym !== curYm ? cache.idx[ym] : null;
    if (!rows) {
      rows = await twseIndexMonth(ym);
      await sleep(CFG.TWSE_DELAY_MS);
      if (ym !== curYm && rows.length) cache.idx[ym] = rows;
    }
    bars = bars.concat(rows);
  }
  for (const k of Object.keys(cache.idx)) if (k < addDays(today, -400).slice(0, 7).replace("-", "")) delete cache.idx[k];
  if (bars.length < 25) throw new Error("證交所指數資料不足");
  return bars;
}

// 期交所：每日外匯參考匯率（取最新一筆美元兌新台幣，補足 FRED 的延遲）
async function taifexFxLatest() {
  const BASE = "https://openapi.taifex.com.tw";
  let rows = null;
  try { rows = await getJSON(BASE + "/v1/DailyForeignExchangeRates"); } catch {}
  if (!Array.isArray(rows)) {
    const sw = await getJSON(BASE + "/swagger.json");
    const p = Object.keys(sw.paths || {}).find(k => /ForeignExchange/i.test(k));
    if (!p) throw new Error("找不到匯率介面");
    const bp = sw.basePath && !p.startsWith(sw.basePath) ? sw.basePath : "";
    rows = await getJSON(BASE + bp + p);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error("匯率資料為空");
  const keys = Object.keys(rows[0]);
  const kUsd = keys.find(k => /USD.{0,3}NTD|美元.{0,3}新台幣/i.test(k));
  const kDate = keys.find(k => /date|日期/i.test(k));
  if (!kUsd) throw new Error("找不到美元兌新台幣欄位");
  return rows.map(r => {
    let d = String(r[kDate] || ""); if (/^\d{8}$/.test(d)) d = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`; else d = d.replace(/\//g, "-");
    return { date: d, c: toNum(r[kUsd]) };
  }).filter(b => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.c != null && b.c > 0);
}
function mergeBars(a, b) { const m = {}; a.concat(b).forEach(x => { m[x.date] = x; }); return Object.values(m).sort((x, y) => (x.date < y.date ? -1 : 1)); }

// 依序嘗試多個來源，回傳第一個成功的結果與來源名稱
async function firstOk(label, tries) {
  const msgs = [];
  for (const [src, fn] of tries) {
    try { const v = await fn(); return { v, src }; } catch (e) { msgs.push(`${src}：${errText(e)}`); }
  }
  throw new Error(msgs.join("；"));
}

const movingAvg = (bars, n) => bars.map((_, i) => (i < n - 1 ? null : round(bars.slice(i - n + 1, i + 1).reduce((s, b) => s + b.c, 0) / n)));


/* ---------- 其他資料來源 ---------- */
const pctChg = (a, b) => (a != null && b ? a / b - 1 : null);

async function quoteSeries(sym, range = "3mo") {
  const bars = await yahoo(sym, range);
  const n = bars.length;
  if (!n) throw new Error("無資料");
  return { bars, last: bars[n - 1], prev: n > 1 ? bars[n - 2] : null };
}

// 期交所：台指期近月（一般交易時段）
async function fetchTaifex() {
  const BASE = "https://openapi.taifex.com.tw";
  let rows = null;
  try { rows = await getJSON(BASE + "/v1/DailyMarketReportFut"); } catch {}
  if (!Array.isArray(rows)) {
    const sw = await getJSON(BASE + "/swagger.json");
    const p = Object.keys(sw.paths || {}).find(k => /DailyMarketReport.*Fut/i.test(k) && !/Spread|Flx|Block/i.test(k));
    if (!p) throw new Error("找不到期貨行情介面");
    const bp = sw.basePath && !p.startsWith(sw.basePath) ? sw.basePath : "";
    rows = await getJSON(BASE + bp + p);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error("期貨資料為空");
  const keys = Object.keys(rows[0]);
  const key = (re, not) => keys.find(k => re.test(k) && !(not && not.test(k)));
  const kContract = key(/^contract$|契約/i) || key(/contract/i, /month|week|date/i);
  const kMonth = key(/month|月份/i);
  const kSession = key(/session|時段/i);
  const kLast = key(/^last$|^收盤價$|最後成交價/i) || key(/last|close|收盤/i, /date|day/i);
  const kChg = key(/^change$|^漲跌價$/i) || key(/change|漲跌/i, /%|percent/i);
  const kVol = key(/^volume$|成交量/i) || key(/volume/i);
  const kDate = key(/^date$|日期/i);
  const all = rows.filter(r => String(r[kContract] ?? "").trim() === "TX" && !String(r[kMonth] ?? "").includes("/"));
  const isNight = r => kSession && /盤後|after|夜|^1$/i.test(String(r[kSession]));
  function pick(list) {
    list = list.filter(r => toNum(r[kLast]) != null).sort((a, b) => String(a[kMonth]).localeCompare(String(b[kMonth])));
    const r = list[0];
    if (!r) return null;
    const last = toNum(r[kLast]), chg = toNum(r[kChg]);
    let date = kDate ? String(r[kDate]) : null;
    if (date && /^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    return { contract: "TX", month: String(r[kMonth]).trim(), last, change: chg, changePct: chg != null && last ? chg / (last - chg) : null, volume: toNum(r[kVol]), date };
  }
  const day = pick(all.filter(r => !isNight(r)));
  if (!day) throw new Error("找不到台指期近月資料");
  // 夜盤（盤後交易時段 15:00 至次日 05:00），期交所於收盤後公布
  day.night = kSession ? pick(all.filter(isNight)) : null;
  return day;
}

/* ---------- 盤中模式：只更新加權指數今日走勢 ---------- */
if (process.argv.includes("--intraday")) {
  try {
    const p = await misIndexNow();
    cache.intra = cache.intra || {};
    for (const k of Object.keys(cache.intra)) if (k < addDays(p.date, -5)) delete cache.intra[k];
    const day = cache.intra[p.date] || { prevClose: p.prevClose, points: [] };
    if (!day.points.some(x => x.t === p.t)) day.points.push({ t: p.t, v: p.v });
    day.points.sort((a, b) => (a.t < b.t ? -1 : 1));
    if (p.prevClose) day.prevClose = p.prevClose;
    cache.intra[p.date] = day;
    let latest = null;
    try { latest = JSON.parse(await fs.readFile(OUT_PATH, "utf8")); } catch {}
    if (latest && latest.tw) {
      const cur = latest.tw.intraday;
      // 已有證交所完整盤後資料時不覆蓋
      if (!(cur && cur.date === p.date && cur.src === "臺灣證券交易所")) {
        latest.tw.intraday = { date: p.date, points: day.points, prevClose: day.prevClose, src: "臺灣證券交易所即時行情（約每 10 分鐘）", live: true };
        latest.intradayAt = new Date().toISOString();
        await fs.writeFile(OUT_PATH, JSON.stringify(latest));
      }
    }
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
    console.log(`盤中更新：${p.date} ${p.t} ${p.v}`);
  } catch (e) { console.log("盤中更新失敗：" + errText(e)); }
  process.exit(0);
}

/* ---------- 收集 ---------- */
const out = {
  updatedAt: new Date().toISOString(), asOf: null,
  tw: null, taifex: null, twTop: null, foreign: [], margin: null, marginPeak: null,
  us: [], usTop: [], jp: null, jpTop: [], fx: null, news: { tw: [], us: [], jp: [], fx: [] }, signals: [],
  config: { foreignCalm: CFG.FOREIGN_CALM, marginRatio: CFG.MARGIN_RATIO },
};

// 加權指數（優先使用證交所官方資料）
try {
  const { v: bars, src } = await firstOk("加權指數", [
    ["臺灣證券交易所", () => twseIndexHistory(10)],
    ["Yahoo Finance", () => yahoo("^TWII", "1y")],
  ]);
  const ma20 = movingAvg(bars, 20), ma120 = movingAvg(bars, 120);
  const recent = bars.slice(-120);
  const peak = recent.reduce((a, b) => (b.c > a.c ? b : a), recent[0]);
  const n = bars.length;
  out.tw = { src, bars: bars.slice(-60).map(({ v, ...b }) => b), ma20: ma20.slice(-60), ma120: ma120.slice(-60), last: bars[n - 1], change: n > 1 ? pctChg(bars[n - 1].c, bars[n - 2].c) : null, peak };
  out.asOf = bars[n - 1].date;
  try {
    const { v: intra, src: isrc } = await firstOk("加權指數盤中", [
      ["臺灣證券交易所", () => twseIntraday(out.asOf)],
      ["Yahoo Finance", () => yahooIntraday("^TWII")],
      ["臺灣證券交易所即時行情", async () => {
        const day = cache.intra && cache.intra[out.asOf];
        if (!day || day.points.length < 2) throw new Error("無盤中取樣資料");
        return { date: out.asOf, points: day.points };
      }],
    ]);
    out.tw.intraday = { ...intra, src: isrc, prevClose: n > 1 ? bars[n - 2].c : null };
  } catch (e) { errors.push("加權指數今日走勢：" + errText(e)); }
} catch (e) { errors.push("加權指數：" + errText(e)); }

try { out.taifex = await fetchTaifex(); } catch (e) { errors.push("台指期：" + errText(e)); }
try { out.twTop = await fetchTwTop(); } catch (e) { errors.push("台股成交排行：" + errText(e)); }

// 融資與外資（證交所）
const m = await series("m", fetchMargin, 1);
out.margin = m.at(-1) || null;
if (out.tw) {
  const pv = await getDay("m", out.tw.peak.date, fetchMargin);
  if (pv != null) out.marginPeak = { date: out.tw.peak.date, value: pv };
}
out.foreign = await series("f", fetchForeign, CFG.FOREIGN_DAYS);

// 美股（Yahoo 無法使用時，指數改用 FRED；費城半導體與台積電 ADR 無備援）
const US_FRED = { "^GSPC": "SP500", "^IXIC": "NASDAQCOM", "^TNX": "DGS10", "^VIX": "VIXCLS" };
for (const it of CFG.US) {
  try {
    const tries = [["Yahoo Finance", () => yahoo(it.sym, "3mo")]];
    if (US_FRED[it.sym]) tries.push(["FRED", () => fred(US_FRED[it.sym], 120)]);
    const { v: bars, src } = await firstOk(it.name, tries);
    const n = bars.length, last = bars[n - 1], prev = n > 1 ? bars[n - 2] : null;
    out.us.push({ ...it, src, bars: bars.slice(-22).map(b => ({ date: b.date, c: b.c })), last: last.c, date: last.date,
      change: prev ? pctChg(last.c, prev.c) : null, diff: prev ? round(last.c - prev.c, 3) : null });
  } catch (e) { errors.push(it.name + "：" + errText(e)); out.us.push({ ...it, bars: [], last: null }); }
  await sleep(150);
}
out.usTop = yFails >= 3 ? [] : await watchTop(CFG.US_WATCH);
if (yFails >= 3) errors.push("美股熱門股：Yahoo Finance 暫時無法連線");

// 日股
try {
  const { v: nb, src } = await firstOk("日經 225", [["Yahoo Finance", () => yahoo("^N225", "6mo")], ["FRED", () => fred("NIKKEI225", 200)]]);
  const { v: jb } = await firstOk("美元兌日圓", [["Yahoo Finance", () => yahoo("JPY=X", "1mo")], ["FRED", () => fred("DEXJPUS", 60)]]);
  const n = nb.length, k = jb.length;
  out.jp = {
    src,
    index: { name: "日經 225", last: nb[n - 1].c, date: nb[n - 1].date, change: n > 1 ? pctChg(nb[n - 1].c, nb[n - 2].c) : null, bars: nb.slice(-130).map(b => ({ date: b.date, c: b.c })) },
    usdjpy: { last: jb[k - 1].c, change: k > 1 ? pctChg(jb[k - 1].c, jb[k - 2].c) : null, bars: jb.slice(-22).map(b => ({ date: b.date, c: b.c })) },
  };
  try {
    const it = await yahooIntraday("^N225");
    const prev = nb.filter(b => b.date < it.date).at(-1);
    out.jp.intraday = { ...it, src: "Yahoo Finance", prevClose: prev ? prev.c : null };
  } catch (e) { errors.push("日經 225 今日走勢：" + errText(e)); }
} catch (e) { errors.push("日股指數：" + errText(e)); }
out.jpTop = yFails >= 3 ? [] : await watchTop(CFG.JP_WATCH);
if (yFails >= 3) errors.push("日股熱門股：Yahoo Finance 暫時無法連線");

// 匯率與波動度（20 日年化歷史波動率）
try {
  const { v: raw, src } = await firstOk("美元兌新台幣", [
    ["Yahoo Finance", () => yahoo("TWD=X", "1y")],
    ["FRED＋臺灣期貨交易所", async () => {
      const hist = await fred("DEXTAUS", 400);
      let latest = [];
      try { latest = await taifexFxLatest(); } catch (e) { errors.push("期交所匯率：" + errText(e)); }
      return mergeBars(hist, latest);
    }],
  ]);
  const bars = raw.filter(b => b.c != null && b.c > 0).map(b => ({ date: b.date, c: b.c }));
  const rets = bars.map((b, i) => (i ? Math.log(b.c / bars[i - 1].c) : null));
  const vol = bars.map((_, i) => {
    if (i < 20) return null;
    const w = rets.slice(i - 19, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1));
    return round(sd * Math.sqrt(252) * 100, 2);
  });
  const valid = vol.filter(v => v != null);
  const cur = vol.at(-1);
  const pctRank = cur != null && valid.length ? valid.filter(v => v <= cur).length / valid.length : null;
  out.fx = {
    src,
    usdtwd: { last: bars.at(-1).c, date: bars.at(-1).date, change: bars.length > 1 ? pctChg(bars.at(-1).c, bars.at(-2).c) : null, bars: bars.slice(-130) },
    vol: { current: cur, avg: valid.length ? round(valid.reduce((a, b) => a + b, 0) / valid.length, 2) : null, max: valid.length ? Math.max(...valid) : null, rank: pctRank, series: vol.slice(-130) },
    others: [],
  };
  for (const [sym, name, fid, inv] of [["JPY=X", "美元兌日圓", "DEXJPUS"], ["EURUSD=X", "歐元兌美元", "DEXUSEU"], ["CNY=X", "美元兌人民幣", "DEXCHUS"]]) {
    try {
      const { v: b, src: s2 } = await firstOk(name, [["Yahoo Finance", () => yahoo(sym, "5d")], ["FRED", () => fred(fid, 30)]]);
      const n = b.length;
      out.fx.others.push({ name, src: s2, date: b[n - 1].date, last: b[n - 1].c, change: n > 1 ? pctChg(b[n - 1].c, b[n - 2].c) : null });
    } catch (e) { errors.push(name + "：" + errText(e)); }
  }
} catch (e) { errors.push("匯率：" + errText(e)); }

// 新聞（台灣 → 美國 → 日本 → 匯率）
for (const k of ["tw", "us", "jp", "fx"]) {
  try { out.news[k] = await fetchNews(CFG.NEWS[k], k); } catch (e) { errors.push(`新聞（${k}）：${errText(e)}`); }
}

/* ---------- 判斷四項條件 ---------- */
const S = [];
const fmtInt = n => (n > 0 ? "+" : "") + Math.round(n).toLocaleString("en-US");
const f3 = out.foreign.slice(-3);
const fxBars = out.fx ? out.fx.usdtwd.bars : [];
if (f3.length < 3) S.push({ key: "foreign", name: "外資收斂", state: "na", text: "外資資料不足 3 日" });
else {
  const sum = f3.reduce((a, b) => a + b.value, 0);
  const calm = f3.every(x => x.value > -CFG.FOREIGN_CALM);
  S.push({ key: "foreign", name: "外資收斂", state: sum > 0 || calm ? "on" : "off", text: `近 3 日合計 ${fmtInt(sum)} 億元`,
    rule: `近 3 日外資合計轉為買超，或每日賣超皆小於 ${CFG.FOREIGN_CALM} 億元時亮燈。代表外資撤出的力道減弱。` });
}
if (!out.tw || !out.margin || !out.marginPeak) S.push({ key: "margin", name: "融資去化", state: "na", text: "融資資料不足" });
else {
  const iDrop = (out.tw.peak.c - out.tw.last.c) / out.tw.peak.c;
  const mDrop = (out.marginPeak.value - out.margin.value) / out.marginPeak.value;
  S.push({ key: "margin", name: "融資去化", state: iDrop > 0 && mDrop >= CFG.MARGIN_RATIO * iDrop ? "on" : "off",
    text: `指數自高點跌 ${(iDrop * 100).toFixed(1)}%，融資減 ${(mDrop * 100).toFixed(1)}%`,
    rule: `融資餘額自指數高點以來的降幅，達指數跌幅的 ${CFG.MARGIN_RATIO} 倍以上時亮燈。代表槓桿籌碼已明顯減少，斷頭賣壓降低。` });
}
if (fxBars.length < 4) S.push({ key: "fx", name: "台幣止貶", state: "na", text: "匯率資料不足" });
else {
  const cur = fxBars.at(-1).c, prev = fxBars.at(-4).c;
  S.push({ key: "fx", name: "台幣止貶", state: cur <= prev ? "on" : "off", text: `美元兌新台幣 ${prev.toFixed(3)} → ${cur.toFixed(3)}`,
    rule: "最新匯率未高於 3 個交易日前時亮燈。代表新台幣停止貶值，外資匯出壓力趨緩。" });
}
if (!out.tw || out.tw.ma20.at(-1) == null) S.push({ key: "ma", name: "站回月線", state: "na", text: "指數資料不足" });
else {
  const ma = out.tw.ma20.at(-1);
  S.push({ key: "ma", name: "站回月線", state: out.tw.last.c > ma ? "on" : "off", text: `收盤 ${Math.round(out.tw.last.c).toLocaleString("en-US")}，月線 ${Math.round(ma).toLocaleString("en-US")}`,
    rule: "加權指數收盤高於 20 日均線時亮燈。代表短期走勢由弱轉強。" });
}
out.signals = S;
out.count = S.filter(s => s.state === "on").length;
out.verdict = out.count <= 1 ? "繼續觀望" : out.count === 2 ? "訊號初步出現" : "訊號較明確";
out.errors = errors;

const cutoff = addDays(tpeToday(), -200);
for (const k of ["f", "m"]) for (const d of Object.keys(cache[k])) if (d < cutoff && d !== out.marginPeak?.date) delete cache[k][d];

await fs.mkdir("data", { recursive: true });
await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
await fs.writeFile(OUT_PATH, JSON.stringify(out));
console.log(`完成：${out.asOf}，${out.count}/4，錯誤 ${errors.length} 筆`);
errors.forEach(e => console.log(" - " + e));
