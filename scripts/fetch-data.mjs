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
const toNum = x => { if (x == null) return null; const n = Number(String(x).replace(/,/g, "").trim()); return Number.isNaN(n) ? null : n; };
const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
// 錯誤訊息只保留前 120 字，避免把外部網站的回應內容寫進公開資料檔
const errText = e => String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 120);

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
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

async function yahoo(sym, range) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`);
  const res = j.chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  const map = {};
  (res.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || !Number.isFinite(q.close[i])) return;
    const date = new Date((t + off) * 1000).toISOString().slice(0, 10);
    map[date] = { date, o: round(q.open[i]), h: round(q.high[i]), l: round(q.low[i]), c: round(q.close[i], 4), v: q.volume ? q.volume[i] : null };
  });
  return Object.values(map).sort((a, b) => (a.date < b.date ? -1 : 1));
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
  let list = rows.filter(r => String(r[kContract] ?? "").trim() === "TX" && !String(r[kMonth] ?? "").includes("/"));
  const regular = list.filter(r => !kSession || /一般|regular|^0$/i.test(String(r[kSession])));
  if (regular.length) list = regular;
  list = list.filter(r => toNum(r[kLast]) != null).sort((a, b) => String(a[kMonth]).localeCompare(String(b[kMonth])));
  const r = list[0];
  if (!r) throw new Error("找不到台指期近月資料");
  const last = toNum(r[kLast]), chg = toNum(r[kChg]);
  let date = kDate ? String(r[kDate]) : null;
  if (date && /^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  return { contract: "TX", month: String(r[kMonth]).trim(), last, change: chg, changePct: chg != null && last ? chg / (last - chg) : null, volume: toNum(r[kVol]), date };
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

async function watchTop(list) {
  const out = [];
  for (const [sym, name] of list) {
    try {
      const q = await quoteSeries(sym, "5d");
      out.push({ sym, name, close: q.last.c, changePct: q.prev ? pctChg(q.last.c, q.prev.c) : null, value: q.last.v ? q.last.c * q.last.v : 0, date: q.last.date });
    } catch (e) { errors.push(`${name}：${errText(e)}`); }
    await sleep(150);
  }
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
async function fetchNews(cfg, region) {
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

/* ---------- 收集 ---------- */
const out = {
  updatedAt: new Date().toISOString(), asOf: null,
  tw: null, taifex: null, twTop: null, foreign: [], margin: null, marginPeak: null,
  us: [], usTop: [], jp: null, jpTop: [], fx: null, news: { tw: [], us: [], jp: [], fx: [] }, signals: [],
  config: { foreignCalm: CFG.FOREIGN_CALM, marginRatio: CFG.MARGIN_RATIO },
};

// 加權指數
try {
  const bars = await yahoo("^TWII", "1y");
  const ma20 = movingAvg(bars, 20), ma120 = movingAvg(bars, 120);
  const recent = bars.slice(-120);
  const peak = recent.reduce((a, b) => (b.c > a.c ? b : a), recent[0]);
  const n = bars.length;
  out.tw = { bars: bars.slice(-60).map(({ v, ...b }) => b), ma20: ma20.slice(-60), ma120: ma120.slice(-60), last: bars[n - 1], change: n > 1 ? pctChg(bars[n - 1].c, bars[n - 2].c) : null, peak };
  out.asOf = bars[n - 1].date;
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

// 美股
for (const it of CFG.US) {
  try {
    const q = await quoteSeries(it.sym, "3mo");
    out.us.push({ ...it, bars: q.bars.slice(-22).map(b => ({ date: b.date, c: b.c })), last: q.last.c, date: q.last.date,
      change: q.prev ? pctChg(q.last.c, q.prev.c) : null, diff: q.prev ? round(q.last.c - q.prev.c, 3) : null });
  } catch (e) { errors.push(it.name + "：" + errText(e)); out.us.push({ ...it, bars: [], last: null }); }
  await sleep(150);
}
out.usTop = await watchTop(CFG.US_WATCH);

// 日股
try {
  const n = await quoteSeries("^N225", "3mo");
  const usdjpy = await quoteSeries("JPY=X", "1mo");
  out.jp = {
    index: { name: "日經 225", last: n.last.c, date: n.last.date, change: n.prev ? pctChg(n.last.c, n.prev.c) : null, bars: n.bars.slice(-60).map(({ v, ...b }) => b) },
    usdjpy: { last: usdjpy.last.c, change: usdjpy.prev ? pctChg(usdjpy.last.c, usdjpy.prev.c) : null, bars: usdjpy.bars.map(b => ({ date: b.date, c: b.c })) },
  };
} catch (e) { errors.push("日股指數：" + errText(e)); }
out.jpTop = await watchTop(CFG.JP_WATCH);

// 匯率與波動度（20 日年化歷史波動率）
try {
  const bars = await yahoo("TWD=X", "1y");
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
    usdtwd: { last: bars.at(-1).c, date: bars.at(-1).date, change: bars.length > 1 ? pctChg(bars.at(-1).c, bars.at(-2).c) : null, bars: bars.slice(-120).map(b => ({ date: b.date, c: b.c })) },
    vol: { current: cur, avg: valid.length ? round(valid.reduce((a, b) => a + b, 0) / valid.length, 2) : null, max: valid.length ? Math.max(...valid) : null, rank: pctRank, series: vol.slice(-120) },
    others: [],
  };
  for (const [sym, name] of [["JPY=X", "美元兌日圓"], ["EURUSD=X", "歐元兌美元"], ["CNY=X", "美元兌人民幣"]]) {
    try { const q = await quoteSeries(sym, "5d"); out.fx.others.push({ name, last: q.last.c, change: q.prev ? pctChg(q.last.c, q.prev.c) : null }); }
    catch (e) { errors.push(name + "：" + errText(e)); }
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
