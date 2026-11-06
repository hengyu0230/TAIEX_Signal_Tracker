// 由 GitHub Actions 定時執行：抓取證交所與 Yahoo Finance 資料，輸出 data/latest.json 供網頁讀取。
// 需求：Node.js 20 以上（內建 fetch）。本機測試：node scripts/fetch-data.mjs
import fs from "node:fs/promises";
import fssync from "node:fs";

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
      const j = await getJSON(u, 45000);
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

// Stooq：需要免費金鑰（存放在 GitHub Secrets 的 STOOQ_APIKEY），未設定時自動略過
const STOOQ_KEY = (process.env.STOOQ_APIKEY || "").trim();
const STOOQ_MAP = { "^GSPC": "^spx", "^IXIC": "^ndq", "^SOX": "^sox", "^N225": "^nkx", "^VIX": "^vix", "TSM": "tsm.us" };
const stooqSym = s => STOOQ_MAP[s] || (/\.T$/.test(s) ? s.replace(/\.T$/, ".jp") : s.toLowerCase() + ".us");
async function stooq(sym, days = 200) {
  if (!STOOQ_KEY) throw new Error("未設定金鑰");
  const d1 = ymd(addDays(tpeToday(), -days));
  const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(sym))}&d1=${d1}&i=d&apikey=${encodeURIComponent(STOOQ_KEY)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = (await r.text()).trim();
  if (!/^Date,/i.test(t)) throw new Error(/limit/i.test(t) ? "已達每日查詢上限" : "無資料");
  const bars = t.split(/\r?\n/).slice(1).map(l => { const c = l.split(","); return { date: c[0], o: toNum(c[1]), h: toNum(c[2]), l: toNum(c[3]), c: toNum(c[4]), v: toNum(c[5]) }; })
    .filter(b => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.c != null && b.c > 0);
  if (!bars.length) throw new Error("無資料");
  return bars;
}

// Stooq 5 分鐘線（需要金鑰）：Stooq 時間為波蘭當地時間，轉換為交易所當地時間
function tzOffsetMin(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - utcMs) / 60000;
}
function warsawToTz(date, time, tz) {
  const naive = Date.parse(`${date}T${time.slice(0, 5)}:00Z`);
  const utc = naive - tzOffsetMin(naive, "Europe/Warsaw") * 60000;
  const local = new Date(utc + tzOffsetMin(utc, tz) * 60000).toISOString();
  return { date: local.slice(0, 10), t: local.slice(11, 16) };
}
async function stooqIntraday(sym, tz) {
  if (!STOOQ_KEY) throw new Error("未設定 Stooq 金鑰");
  const d1 = ymd(addDays(tpeToday(), -6));
  const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(sym))}&d1=${d1}&i=5&apikey=${encodeURIComponent(STOOQ_KEY)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = (await r.text()).trim();
  if (!/^Date,Time/i.test(t)) throw new Error(/limit/i.test(t) ? "已達每日查詢上限" : "無盤中資料");
  const pts = t.split(/\r?\n/).slice(1).map(l => { const c = l.split(","); const lt = warsawToTz(c[0], c[1], tz); return { date: lt.date, t: lt.t, v: toNum(c[5]) }; }).filter(p => p.v != null && p.v > 0);
  if (!pts.length) throw new Error("無盤中資料");
  const day = pts.at(-1).date;
  return { date: day, points: pts.filter(p => p.date === day).map(p => ({ t: p.t, v: p.v })) };
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

// 期交所：台指期近月（日盤與夜盤）
const TAIFEX = "https://openapi.taifex.com.tw";
let taifexSwagger = null;
async function taifexPaths() {
  if (!taifexSwagger) taifexSwagger = await getJSON(TAIFEX + "/swagger.json");
  const sw = taifexSwagger;
  return Object.keys(sw.paths || {}).map(p => (sw.basePath && !p.startsWith(sw.basePath) ? sw.basePath : "") + p);
}
function pickTX(rows, wantNight) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const keys = Object.keys(rows[0]);
  const key = (re, not) => keys.find(k => re.test(k) && !(not && not.test(k)));
  const kContract = key(/^contract$|契約/i) || key(/contract/i, /month|week|date/i);
  const kMonth = key(/month|月份/i);
  const kSession = key(/session|時段/i);
  const kLast = key(/^last$|^收盤價$|最後成交價/i) || key(/last|close|收盤/i, /date|day/i);
  const kChg = key(/^change$|^漲跌價$/i) || key(/change|漲跌/i, /%|percent/i);
  const kVol = key(/^volume$|成交量/i) || key(/volume/i);
  const kDate = key(/^date$|日期/i);
  const isNight = r => kSession && /盤後|after|夜|^1$/i.test(String(r[kSession]));
  let list = rows.filter(r => String(r[kContract] ?? "").trim() === "TX" && !String(r[kMonth] ?? "").includes("/"));
  if (wantNight === true) list = list.filter(isNight);
  else if (wantNight === false) list = list.filter(r => !isNight(r));
  list = list.filter(r => toNum(r[kLast]) != null).sort((a, b) => String(a[kMonth]).localeCompare(String(b[kMonth])));
  const r = list[0];
  if (!r) return null;
  const last = toNum(r[kLast]), chg = toNum(r[kChg]);
  let date = kDate ? String(r[kDate]) : null;
  if (date && /^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  return { contract: "TX", month: String(r[kMonth]).trim(), last, change: chg, changePct: chg != null && last ? chg / (last - chg) : null, volume: toNum(r[kVol]), date, hasSession: !!kSession };
}
// 期交所「每日行情下載」（盤後即時更新，含日盤與夜盤；開放資料 API 常延遲一天）
async function taifexCsv() {
  const end = tpeToday(), start = addDays(end, -10);
  const body = new URLSearchParams({ down_type: "1", commodity_id: "TX", commodity_id2: "", queryStartDate: start.replace(/-/g, "/"), queryEndDate: end.replace(/-/g, "/") });
  const r = await fetch("https://www.taifex.com.tw/cht/3/futDataDown", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let text = buf.toString("utf8");
  if (!text.includes("交易日期")) text = new TextDecoder("big5").decode(buf);
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const head = (lines[0] || "").split(",").map(x => x.trim());
  const ix = name => head.findIndex(h => h.includes(name));
  const iDate = ix("交易日期"), iCon = ix("契約"), iMon = ix("到期月份"), iLast = ix("收盤價"), iChg = ix("漲跌價"), iVol = ix("成交量"), iSes = ix("交易時段");
  if (iDate < 0 || iLast < 0) throw new Error("格式不符");
  const rows = lines.slice(1).map(l => l.split(",").map(x => x.trim())).filter(c => c[iCon] === "TX" && c[iMon] && !/[\/W]/i.test(c[iMon]) && toNum(c[iLast]) != null);
  function pick(night) {
    const list = rows.filter(c => (iSes >= 0 && /盤後/.test(c[iSes])) === night);
    if (!list.length) return null;
    const lastDate = list.map(c => c[iDate]).sort().at(-1);
    const r0 = list.filter(c => c[iDate] === lastDate).sort((a, b) => a[iMon].localeCompare(b[iMon]))[0];
    const last = toNum(r0[iLast]), chg = toNum(r0[iChg]);
    return { contract: "TX", month: r0[iMon], last, change: chg, changePct: chg != null && last ? chg / (last - chg) : null, volume: toNum(r0[iVol]), date: lastDate.replace(/\//g, "-") };
  }
  const day = pick(false);
  if (!day) throw new Error("無台指期資料");
  day.night = pick(true);
  return day;
}

async function fetchTaifexApi() {
  let rows = null;
  try { rows = await getJSON(TAIFEX + "/v1/DailyMarketReportFut"); } catch {}
  if (!Array.isArray(rows)) {
    const p = (await taifexPaths()).find(k => /DailyMarketReport.*Fut/i.test(k) && !/Spread|Flx|Block|AH|After|Night/i.test(k));
    if (!p) throw new Error("找不到期貨行情介面");
    rows = await getJSON(TAIFEX + p);
  }
  const day = pickTX(rows, false);
  if (!day) throw new Error("找不到台指期近月資料");
  let night = day.hasSession ? pickTX(rows, true) : null;
  if (!night) {
    try {
      const paths = (await taifexPaths()).filter(k => /Fut/i.test(k) && /AH|After|Night/i.test(k) && !/Spread|Flx|Block|Institution|Contracts/i.test(k));
      for (const p of paths) {
        try { night = pickTX(await getJSON(TAIFEX + p), null); } catch {}
        if (night) break;
      }
    } catch {}
  }
  delete day.hasSession;
  if (night) delete night.hasSession;
  day.night = night;
  return day;
}

// 兩個來源都試，日盤與夜盤各自採用日期較新的一份
async function fetchTaifex() {
  let a = null, b = null; const msgs = [];
  try { a = await taifexCsv(); } catch (e) { msgs.push("每日行情下載：" + errText(e)); }
  try { b = await fetchTaifexApi(); } catch (e) { msgs.push("開放資料：" + errText(e)); }
  if (!a && !b) throw new Error(msgs.join("；"));
  const newer = (x, y) => (!x ? y : !y ? x : (y.date || "") > (x.date || "") ? y : x);
  const day = { ...newer(a, b) };
  day.night = newer(a && a.night, b && b.night);
  // 期交所每日行情要到當日日盤收盤後才收錄前一晚的夜盤；05:00–15:00 之間改用即時行情補上剛結束的夜盤收盤
  try {
    const { date: today, hm } = tpeNow();
    if (hm >= "05:00" && hm < "15:00") {
      const q = await misTaifexQuote(1);
      const d = q.cdate && q.cdate <= today ? q.cdate : today;
      if (q.last && (!day.night || d > (day.night.date || ""))) {
        const chg = q.ref ? round(q.last - q.ref, 2) : null;
        day.night = { contract: "TX", month: (day.night && day.night.month) || day.month, last: q.last, change: chg, changePct: chg != null && q.ref ? chg / q.ref : null, volume: q.volume, date: d, src: "期交所即時行情" };
      }
    }
  } catch (e) { msgs.push("夜盤即時行情：" + errText(e)); }
  if (!day.night) errors.push("台指期夜盤：" + (msgs.join("；") || "找不到夜盤資料"));
  return day;
}

// 證交所：今日成交金額前 10（失敗時改用成交量前 20 名中的前 10）
async function fetchTwTop() {
  const rocToIso = s => { s = String(s || ""); return /^\d{7}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}-${s.slice(3, 5)}-${s.slice(5)}` : s || null; };
  try {
    const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    const list = rows.map(r => ({ code: String(r.Code || "").trim(), name: String(r.Name || "").trim(), close: toNum(r.ClosingPrice), change: toNum(r.Change), value: toNum(r.TradeValue) }))
      .filter(x => x.code && x.close && x.value);
    if (!list.length) throw new Error("清單為空");
    list.sort((a, b) => b.value - a.value);
    return { basis: "成交金額", date: rocToIso(rows[0] && rows[0].Date), items: list.slice(0, 10).map(x => ({ ...x, value: round(x.value / 1e8, 1), changePct: x.change != null ? x.change / (x.close - x.change) : null })) };
  } catch (e) {
    const d = ymd(tpeToday());
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX20?response=json&date=${d}`);
    const f = j.fields || [];
    const ix = name => f.findIndex(x => String(x).includes(name));
    const rows = (j.data || []).slice(0, 10).map(r => {
      const close = toNum(r[ix("收盤")]), diff = toNum(r[ix("漲跌價差")]);
      const neg = String(r[ix("漲跌(+/-)")] || "").includes("-");
      const change = diff == null ? null : neg ? -diff : diff;
      return { code: String(r[ix("代號")]).trim(), name: String(r[ix("名稱")]).trim(), close, change, value: round(toNum(r[ix("成交股數")]) / 1e3, 0), changePct: change != null && close ? change / (close - change) : null };
    });
    return { basis: "成交量（張）", date: tpeToday(), items: rows };
  }
}

async function watchTop(list, label) {
  const out = [], failed = [];
  for (const [sym, name] of list) {
    const q = CQ[sym];
    if (q) { out.push({ sym, name, src: "CNBC", close: q.last, changePct: q.changePct, value: q.volume ? q.last * q.volume : 0, date: q.date }); continue; }
    try {
      const tries = [];
      if (yFails < 3) tries.push(["Yahoo Finance", () => yahoo(sym, "5d")]);
      if (STOOQ_KEY) tries.push(["Stooq", () => stooq(sym, 15)]);
      if (!tries.length) throw new Error("無可用來源");
      const { v: bars, src } = await firstOk(name, tries);
      const n = bars.length, last = bars[n - 1], prev = n > 1 ? bars[n - 2] : null;
      out.push({ sym, name, src, close: last.c, changePct: prev ? pctChg(last.c, prev.c) : null, value: last.v ? last.c * last.v : 0, date: last.date });
    } catch (e) { failed.push(name); }
    await sleep(150);
  }
  if (failed.length) errors.push(`${label}：${failed.length === list.length ? "全部" : failed.join("、")}未取得${STOOQ_KEY ? "" : "（Yahoo 拒絕連線，且未設定 Stooq 金鑰）"}`);
  return out.sort((a, b) => b.value - a.value).slice(0, 10);
}

function decodeXml(s) {
  return String(s || "").replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, "").trim();
}

// Google 新聞 RSS：只保留標題、來源、時間與連結
async function fetchGoogleNews(cfg, region) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cfg.q)}&hl=${cfg.hl}&gl=${cfg.gl}&ceid=${encodeURIComponent(cfg.ceid)}`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const tag = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decodeXml(x[1]) : ""; };
    const src = m[1].match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    const source = src ? decodeXml(src[2]) : "";
    let title = tag("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const link = tag("link");
    const t = Date.parse(tag("pubDate"));
    return { region, title: title.slice(0, 160), source: source.slice(0, 60), link, time: Number.isFinite(t) ? new Date(t).toISOString() : null };
  }).filter(x => x.title && /^https:\/\//.test(x.link));
  items.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  return items.slice(0, CFG.NEWS_COUNT);
}

// Bing 新聞 RSS（Google 新聞失敗時的備援）
async function fetchBingNews(cfg, region) {
  const mkt = { "zh-TW": "zh-TW", "en-US": "en-US", ja: "ja-JP" }[cfg.hl] || "en-US";
  const r = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(cfg.q.replace(/ OR /g, " "))}&format=rss&mkt=${mkt}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const tag = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decodeXml(x[1]) : ""; };
    const t = Date.parse(tag("pubDate"));
    return { region, title: tag("title").slice(0, 160), source: (tag("News:Source") || "Bing 新聞").slice(0, 60), link: tag("link"), time: Number.isFinite(t) ? new Date(t).toISOString() : null };
  }).filter(x => x.title && /^https:\/\//.test(x.link));
  items.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  if (!items.length) throw new Error("無新聞");
  return items.slice(0, CFG.NEWS_COUNT);
}
// 媒體官方 RSS（Google 與 Bing 都失敗時使用）
const DIRECT_FEEDS = {
  tw: [["自由時報財經", "https://news.ltn.com.tw/rss/business.xml"], ["中央社財經", "https://feeds.feedburner.com/rsscna/finance"]],
  us: [["CNBC", "https://www.cnbc.com/id/10000664/device/rss/rss.html"], ["CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"]],
  jp: [["NHK", "https://www3.nhk.or.jp/rss/news/cat5.xml"]],
  fx: [["自由時報財經", "https://news.ltn.com.tw/rss/business.xml"], ["中央社財經", "https://feeds.feedburner.com/rsscna/finance"]],
};
async function fetchDirectNews(region) {
  const msgs = [];
  for (const [name, url] of DIRECT_FEEDS[region] || []) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      let items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map(m => {
        const tag = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decodeXml(x[1]) : ""; };
        const t = Date.parse(tag("pubDate") || tag("dc:date"));
        return { region, title: tag("title").slice(0, 160), source: name, link: tag("link"), time: Number.isFinite(t) ? new Date(t).toISOString() : null };
      }).filter(x => x.title && /^https:\/\//.test(x.link));
      if (region === "fx") { const f = items.filter(x => /匯|台幣|新臺幣|美元|央行/.test(x.title)); if (f.length) items = f; }
      items.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
      if (items.length) return items.slice(0, CFG.NEWS_COUNT);
      msgs.push(`${name} 無新聞`);
    } catch (e) { msgs.push(`${name} ${errText(e)}`); }
  }
  throw new Error(msgs.join("；") || "無可用來源");
}

async function fetchNews(cfg, region) {
  const { v } = await firstOk("新聞", [
    ["Google 新聞", async () => { const x = await fetchGoogleNews(cfg, region); if (!x.length) throw new Error("無新聞"); return x; }],
    ["Google 新聞（重試）", async () => { await sleep(3000); const x = await fetchGoogleNews(cfg, region); if (!x.length) throw new Error("無新聞"); return x; }],
    ["Bing 新聞", () => fetchBingNews(cfg, region)],
    ["媒體 RSS", () => fetchDirectNews(region)],
  ]);
  return v;
}

/* ---------- CNBC 報價（非官方介面，不需金鑰；只取當下報價，走勢由本工具自行累積） ---------- */
const CNBC_SYM = { "^GSPC": ".SPX", "^IXIC": ".IXIC", "^SOX": ".SOX", "^VIX": ".VIX", "^N225": ".N225", "TSM": "TSM" };
const cnbcSym = s => CNBC_SYM[s] || (/\.T$/.test(s) ? s.replace(/\.T$/, "-JP") : s);
const INTRA_SYMS = ["^GSPC", "^SOX", "^IXIC", "TSM", "^N225"];
function findQuotes(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach(x => findQuotes(x, out));
  else if (obj && typeof obj === "object") {
    if (typeof obj.symbol === "string" && obj.last != null) out.push(obj);
    else Object.values(obj).forEach(v => findQuotes(v, out));
  }
  return out;
}
function field(o, names) { for (const k of names) if (o[k] != null && o[k] !== "") return o[k]; return null; }
async function cnbcQuotes(syms) {
  const res = {}, msgs = [];
  const want = syms.map(s => [s, cnbcSym(s)]);
  for (let i = 0; i < want.length; i += 20) {
    const chunk = want.slice(i, i + 20), q = encodeURIComponent(chunk.map(x => x[1]).join("|"));
    const urls = [
      `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${q}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`,
      `https://quote.cnbc.com/quote-html-webservice/quote.htm?partnerId=2&requestMethod=quick&exthrs=1&noform=1&fund=1&output=json&symbols=${q}`,
    ];
    let quotes = [];
    for (const u of urls) {
      try { quotes = findQuotes(await getJSON(u, 20000)); if (quotes.length) break; msgs.push("回應中沒有報價"); }
      catch (e) { msgs.push(errText(e)); }
    }
    for (const [mine, theirs] of chunk) {
      const o = quotes.find(x => String(x.symbol).toUpperCase() === theirs.toUpperCase());
      if (!o) continue;
      const last = toNum(field(o, ["last", "last_price"]));
      if (last == null || last <= 0) continue;
      const lt = String(field(o, ["last_time", "lastTime", "last_timedate"]) || "");
      const m = lt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      const prevClose = toNum(field(o, ["previous_day_closing", "previousDayClosing", "prev_close"]));
      let chgPct = toNum(String(field(o, ["change_pct", "changePct", "change_percent"]) || "").replace("%", ""));
      chgPct = chgPct != null ? chgPct / 100 : (prevClose ? last / prevClose - 1 : null);
      res[mine] = { last, changePct: chgPct, change: toNum(field(o, ["change"])), prevClose, volume: toNum(field(o, ["volume"])),
        date: m ? m[1] : tpeToday(), t: m ? m[2] : null, name: field(o, ["name", "onAirName"]) };
    }
    await sleep(300);
  }
  if (!Object.keys(res).length) throw new Error(msgs.join("；") || "無報價");
  return res;
}
// 記錄每日收盤與盤中取樣，供走勢圖使用
function recordQuotes(qs) {
  let added = 0;
  cache.cq = cache.cq || {};
  for (const [sym, q] of Object.entries(qs)) {
    const e = cache.cq[sym] = cache.cq[sym] || { daily: {}, intra: {} };
    e.daily[q.date] = q.last;
    if (q.prevClose) e.prev = { ...(e.prev || {}), [q.date]: q.prevClose };
    if (q.t && INTRA_SYMS.includes(sym)) {
      const day = e.intra[q.date] = e.intra[q.date] || [];
      if (!day.some(p => p.t === q.t)) { day.push({ t: q.t, v: q.last }); added++; }
      day.sort((a, b) => (a.t < b.t ? -1 : 1));
    }
    for (const d of Object.keys(e.daily)) if (d < addDays(q.date, -200)) delete e.daily[d];
    for (const d of Object.keys(e.intra)) if (d < addDays(q.date, -4)) delete e.intra[d];
    for (const d of Object.keys(e.prev || {})) if (d < addDays(q.date, -10)) delete e.prev[d];
  }
  return added;
}
function cnbcBars(sym) {
  const e = cache.cq && cache.cq[sym]; if (!e) return [];
  return Object.keys(e.daily).sort().map(d => ({ date: d, c: e.daily[d] }));
}
function cnbcIntraday(sym) {
  const e = cache.cq && cache.cq[sym]; if (!e || !e.intra) return null;
  const d = Object.keys(e.intra).sort().at(-1);
  const pts = d ? e.intra[d] : [];
  if (!pts || pts.length < 2) return null;
  return { date: d, points: pts, prevClose: e.prev && e.prev[d] ? e.prev[d] : null, src: "CNBC（約每 15 分鐘取樣）", live: true };
}
// 若報價日期比歷史資料新，補上最新一筆
function withQuote(bars, q) {
  if (!q) return bars;
  const last = bars.at(-1);
  if (!last || q.date > last.date) return bars.concat([{ date: q.date, c: q.last }]);
  if (q.date === last.date) return bars.slice(0, -1).concat([{ ...last, c: q.last }]);
  return bars;
}

/* ---------- 期交所即時行情（非官方介面）：台指期日盤、夜盤盤中取樣 ---------- */
function tpeNow() { const d = new Date(Date.now() + 8 * 3600e3).toISOString(); return { date: d.slice(0, 10), hm: d.slice(11, 16) }; }
// 依台灣時間判斷目前是日盤（0）或夜盤（1）；回傳交易時段開始的日期
function futSession() {
  const { date, hm } = tpeNow();
  if (hm >= "08:40" && hm <= "13:55") return { market: 0, key: "day", start: date };
  if (hm >= "14:55") return { market: 1, key: "night", start: date };
  if (hm <= "05:10") return { market: 1, key: "night", start: addDays(date, -1) };
  return null;
}
async function misTaifexQuote(market) {
  const r = await fetch("https://mis.taifex.com.tw/futures/api/getQuoteList", {
    method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ MarketType: String(market), SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "", RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || String(j.RtCode) !== "0") throw new Error("回應錯誤");
  const rows = ((j.RtData && j.RtData.QuoteList) || []).filter(x => /^TXF/.test(String(x.SymbolID || "")) && !String(x.SymbolID).includes("/") && toNum(x.CLastPrice) != null && toNum(x.CLastPrice) > 0);
  if (!rows.length) throw new Error("無台指期報價");
  // 近月合約通常成交量最大
  rows.sort((a, b) => (toNum(b.CTotalVolume) || 0) - (toNum(a.CTotalVolume) || 0));
  const x = rows[0];
  const tm = String(x.CTime || "").replace(/\D/g, "");
  const cd = String(x.CDate || "").replace(/\D/g, "");
  return { last: toNum(x.CLastPrice), ref: toNum(x.CRefPrice), t: tm.length >= 4 ? `${tm.slice(0, 2)}:${tm.slice(2, 4)}` : tpeNow().hm, volume: toNum(x.CTotalVolume), symbol: String(x.SymbolID),
    cdate: cd.length === 8 ? `${cd.slice(0, 4)}-${cd.slice(4, 6)}-${cd.slice(6)}` : null };
}
async function sampleFutures() {
  const ses = futSession();
  if (!ses) return null;
  const q = await misTaifexQuote(ses.market);
  cache.fut = cache.fut || {};
  const k = `${ses.key}:${ses.start}`;
  const e = cache.fut[k] = cache.fut[k] || { ref: q.ref, points: [], updated: null };
  const added = !e.points.some(p => p.t === q.t);
  if (added) e.points.push({ t: q.t, v: q.last });
  // 夜盤跨日：15:00 之後的時間排在 00:00–05:00 之前
  const order = t => (ses.key === "night" && t < "12:00" ? "1" : "0") + t;
  e.points.sort((a, b) => (order(a.t) < order(b.t) ? -1 : 1));
  if (q.ref) e.ref = q.ref;
  e.updated = new Date().toISOString();
  for (const kk of Object.keys(cache.fut)) if (kk.split(":")[1] < addDays(tpeToday(), -4)) delete cache.fut[kk];
  return { session: ses.key, start: ses.start, last: q.last, t: q.t, added };
}
// 取出最近一次的日盤與夜盤取樣（20 小時內有更新者）
function futLive(kind) {
  const list = Object.entries(cache.fut || {}).filter(([k, e]) => k.startsWith(kind + ":") && e.points.length > 1 && Date.now() - Date.parse(e.updated) < 20 * 3600e3);
  if (!list.length) return null;
  const [k, e] = list.sort((a, b) => (a[0] < b[0] ? 1 : -1))[0];
  return { start: k.split(":")[1], points: e.points, prevClose: e.ref, src: "期交所即時行情（約每 10–15 分鐘取樣）", live: true };
}

/* ---------- 盤中模式：台股、日股、美股的今日走勢取樣 ---------- */
if (process.argv.includes("--intraday")) {
  let latest = null, changed = 0;
  try { latest = JSON.parse(await fs.readFile(OUT_PATH, "utf8")); } catch {}
  // 台股（證交所即時行情）
  try {
    const p = await misIndexNow();
    cache.intra = cache.intra || {};
    for (const k of Object.keys(cache.intra)) if (k < addDays(p.date, -5)) delete cache.intra[k];
    const day = cache.intra[p.date] || { prevClose: p.prevClose, points: [] };
    if (!day.points.some(x => x.t === p.t)) { day.points.push({ t: p.t, v: p.v }); changed++; }
    day.points.sort((a, b) => (a.t < b.t ? -1 : 1));
    if (p.prevClose) day.prevClose = p.prevClose;
    cache.intra[p.date] = day;
    if (latest && latest.tw) {
      const cur = latest.tw.intraday;
      if (!(cur && cur.date === p.date && cur.src === "臺灣證券交易所") && day.points.length > 1) {
        latest.tw.intraday = { date: p.date, points: day.points, prevClose: day.prevClose, src: "臺灣證券交易所即時行情（約每 10 分鐘）", live: true };
      }
    }
    console.log(`台股盤中：${p.date} ${p.t} ${p.v}`);
  } catch (e) { console.log("台股盤中取樣失敗：" + errText(e)); }
  // 台指期（期交所即時行情）
  try {
    const f = await sampleFutures();
    if (f && f.added) changed++;
    if (f && f.added && latest && latest.taifex) {
      latest.taifex.liveDay = futLive("day");
      latest.taifex.liveNight = futLive("night");
    }
    console.log(f ? `台指期盤中：${f.session} ${f.t} ${f.last}` : "台指期：非交易時段");
  } catch (e) { console.log("台指期盤中取樣失敗：" + errText(e)); }
  // 美股與日經（CNBC）
  try {
    const qs = await cnbcQuotes(INTRA_SYMS);
    const added = recordQuotes(qs);
    changed += added;
    if (latest && added) {
      (latest.us || []).forEach(u => {
        const q = qs[u.sym]; if (!q) return;
        u.last = q.last; u.change = q.changePct; u.date = q.date; u.src = "CNBC";
        u.bars = withQuote(u.bars || [], q);
        const it = cnbcIntraday(u.sym); if (it) u.intraday = it;
      });
      if (latest.jp && qs["^N225"]) {
        const q = qs["^N225"], j = latest.jp;
        j.index.last = q.last; j.index.change = q.changePct; j.index.date = q.date; j.src = "CNBC";
        j.index.bars = withQuote(j.index.bars || [], q);
        const it = cnbcIntraday("^N225"); if (it) j.intraday = it;
      }
    }
    console.log("美日盤中：" + Object.keys(qs).join(", "));
  } catch (e) { console.log("美日盤中取樣失敗：" + errText(e)); }
  // 沒有新的取樣點（休市、排程延遲等）就不存檔，也就不會產生提交與網站發布
  if (!changed) { console.log("沒有新的盤中資料，本次不存檔"); process.exit(0); }
  if (latest) { latest.intradayAt = new Date().toISOString(); await fs.writeFile(OUT_PATH, JSON.stringify(latest)); }
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
  console.log(`新增 ${changed} 個盤中取樣點`);
  process.exit(0);
}

/* ---------- 收集 ---------- */
// 安全網：若中途發生未預期的錯誤，仍寫出已取得的資料
let outRef = null;
function emergencyWrite(err) {
  try {
    if (outRef) {
      outRef.errors = errors.concat(["程式中斷：" + errText(err)]);
      fssync.writeFileSync(OUT_PATH, JSON.stringify(outRef));
      fssync.writeFileSync(CACHE_PATH, JSON.stringify(cache));
    }
  } catch {}
  console.log("程式中斷：" + errText(err));
  process.exit(0);
}
process.on("uncaughtException", emergencyWrite);
process.on("unhandledRejection", emergencyWrite);
let prevOut = null;
try { prevOut = JSON.parse(await fs.readFile(OUT_PATH, "utf8")); } catch {}
const out = {
  version: "2026-11-07a",
  updatedAt: new Date().toISOString(), asOf: null,
  tw: null, taifex: null, twTop: null, foreign: [], margin: null, marginPeak: null,
  us: [], usTop: [], jp: null, jpTop: [], fx: null, news: { tw: [], us: [], jp: [], fx: [] }, signals: [],
  config: { foreignCalm: CFG.FOREIGN_CALM, marginRatio: CFG.MARGIN_RATIO },
};
outRef = out;

// 新聞優先抓取（台灣 → 美國 → 日本 → 匯率），避免後段步驟耗時影響
for (const k of ["tw", "us", "jp", "fx"]) {
  try { out.news[k] = await fetchNews(CFG.NEWS[k], k); } catch (e) { errors.push(`新聞（${k}）：${errText(e)}`); }
}

// CNBC 報價：一次取得美股、日股所需的報價
let CQ = {};
try {
  CQ = await cnbcQuotes([...new Set([...CFG.US.map(x => x.sym).filter(x => x !== "^TNX"), "^N225", ...CFG.US_WATCH.map(x => x[0]), ...CFG.JP_WATCH.map(x => x[0])])]);
  recordQuotes(CQ);
} catch (e) { errors.push("CNBC 報價：" + errText(e)); }

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

try {
  out.taifex = await fetchTaifex();
  // 累積每日夜盤收盤，畫出近期夜盤走勢
  cache.night = cache.night || {};
  if (out.taifex.night && out.taifex.night.date) cache.night[out.taifex.night.date] = out.taifex.night.last;
  if (out.taifex.date) { cache.dayFut = cache.dayFut || {}; cache.dayFut[out.taifex.date] = out.taifex.last; }
  for (const k of ["night", "dayFut"]) for (const d of Object.keys(cache[k] || {})) if (d < addDays(tpeToday(), -120)) delete cache[k][d];
  out.taifex.nightHist = Object.keys(cache.night).sort().slice(-60).map(d => ({ date: d, c: cache.night[d] }));
  out.taifex.dayHist = Object.keys(cache.dayFut || {}).sort().slice(-60).map(d => ({ date: d, c: cache.dayFut[d] }));
  try { await sampleFutures(); } catch (e) { errors.push("台指期盤中取樣：" + errText(e)); }
  out.taifex.liveDay = futLive("day");
  out.taifex.liveNight = futLive("night");
} catch (e) { errors.push("台指期：" + errText(e)); }
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
    const q = CQ[it.sym];
    const tries = [["Yahoo Finance", () => yahoo(it.sym, "6mo")]];
    if (US_FRED[it.sym]) tries.push(["FRED", () => fred(US_FRED[it.sym], 200)]);
    if (q) tries.push(["CNBC", async () => { const b = cnbcBars(it.sym); if (!b.length) throw new Error("無資料"); return b; }]);
    if (STOOQ_KEY && it.sym !== "^TNX") tries.push(["Stooq", () => stooq(it.sym, 200)]);
    let { v: bars, src } = await firstOk(it.name, tries);
    bars = withQuote(bars, q);
    const n = bars.length, last = bars[n - 1], prev = n > 1 ? bars[n - 2] : null;
    const item = { ...it, src: q && src !== "CNBC" ? src + "＋CNBC" : src, bars: bars.slice(-130).map(b => ({ date: b.date, c: b.c })), last: last.c, date: last.date,
      change: q && q.date === last.date && q.changePct != null ? q.changePct : (prev ? pctChg(last.c, prev.c) : null), diff: prev ? round(last.c - prev.c, 3) : null };
    if (INTRA_SYMS.includes(it.sym)) {
      try {
        const { v: intra, src: isrc } = await firstOk(it.name + "今日走勢", [
          ["CNBC 取樣", async () => { const x = cnbcIntraday(it.sym); if (!x) throw new Error("盤中取樣尚未累積"); return x; }],
          ["Yahoo Finance", () => yahooIntraday(it.sym)],
          ["Stooq", () => stooqIntraday(it.sym, "America/New_York")],
        ]);
        const pc = intra.prevClose || (bars.filter(b => b.date < intra.date).at(-1) || {}).c || null;
        item.intraday = { ...intra, src: intra.src || isrc, prevClose: pc };
      } catch (e) { errors.push(it.name + "今日走勢：" + errText(e)); }
    }
    out.us.push(item);
  } catch (e) { errors.push(it.name + "：" + errText(e)); out.us.push({ ...it, bars: [], last: null }); }
  await sleep(150);
}
out.usTop = await watchTop(CFG.US_WATCH, "美股重點股");

// 日股
try {
  const { v: nb, src } = await firstOk("日經 225", [["Yahoo Finance", () => yahoo("^N225", "6mo")], ["Stooq", () => stooq("^N225", 200)], ["FRED", () => fred("NIKKEI225", 200)]]);
  const nq = CQ["^N225"];
  let nb2 = withQuote(nb.map(b => ({ date: b.date, c: b.c })), nq);
  const { v: jb } = await firstOk("美元兌日圓", [["Yahoo Finance", () => yahoo("JPY=X", "1mo")], ["FRED", () => fred("DEXJPUS", 60)]]);
  const n = nb2.length, k = jb.length;
  out.jp = {
    src: nq ? src + "＋CNBC" : src,
    index: { name: "日經 225", last: nb2[n - 1].c, date: nb2[n - 1].date, change: nq && nq.date === nb2[n - 1].date && nq.changePct != null ? nq.changePct : (n > 1 ? pctChg(nb2[n - 1].c, nb2[n - 2].c) : null), bars: nb2.slice(-130) },
    usdjpy: { last: jb[k - 1].c, change: k > 1 ? pctChg(jb[k - 1].c, jb[k - 2].c) : null, bars: jb.slice(-22).map(b => ({ date: b.date, c: b.c })) },
  };
  try {
    const { v: it, src: isrc } = await firstOk("日經 225 今日走勢", [
      ["CNBC 取樣", async () => { const x = cnbcIntraday("^N225"); if (!x) throw new Error("盤中取樣尚未累積"); return x; }],
      ["Yahoo Finance", () => yahooIntraday("^N225")],
      ["Stooq", () => stooqIntraday("^N225", "Asia/Tokyo")],
    ]);
    const prev = nb2.filter(b => b.date < it.date).at(-1);
    out.jp.intraday = { ...it, src: it.src || isrc, prevClose: it.prevClose || (prev ? prev.c : null) };
  } catch (e) { errors.push("日經 225 今日走勢：" + errText(e)); }
} catch (e) { errors.push("日股指數：" + errText(e)); }
out.jpTop = await watchTop(CFG.JP_WATCH, "日股熱門股");

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



/* ---------- 本次未取得的項目，沿用上次成功的結果 ---------- */
const stale = [];
if (prevOut) {
  const empty = v => v == null || (Array.isArray(v) && !v.length) || (v.items && !v.items.length);
  for (const [k, label] of [["taifex", "台指期"], ["twTop", "台股成交排行"], ["usTop", "美股重點股"], ["jpTop", "日股熱門股"], ["jp", "日股"], ["fx", "匯率"]]) {
    if (empty(out[k]) && !empty(prevOut[k])) { out[k] = prevOut[k]; stale.push(label); }
  }
  if (out.taifex && !out.taifex.night && prevOut.taifex && prevOut.taifex.night) out.taifex.night = prevOut.taifex.night;
  for (const k of ["tw", "us", "jp", "fx"]) {
    if (empty(out.news[k]) && prevOut.news && !empty(prevOut.news[k])) { out.news[k] = prevOut.news[k]; stale.push(`新聞（${k}）`); }
  }
  (out.us || []).forEach((u, i) => {
    const p = (prevOut.us || []).find(x => x.sym === u.sym);
    if (u.last == null && p && p.last != null) { out.us[i] = p; stale.push(u.name); }
  });
}
out.stale = stale;

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
