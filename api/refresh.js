// api/refresh.js — scheduled generator (Vercel Cron).
//
// Runs on a schedule, generates each "standing" section with Claude + web search,
// and upserts the result into the Supabase ci_cache table (one row per section,
// overwritten each run). The public site then reads those rows instantly via
// /api/cache, so page loads make NO Anthropic calls.
//
// Cost model: this function makes the expensive searched calls a few times a day,
// regardless of traffic. The live Q&A and on-demand ticker charts stay live.
//
// Protected by CRON_SECRET: Vercel Cron automatically sends it; manual triggers
// must pass ?key=<CRON_SECRET>.

export const config = { maxDuration: 300 };

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// COST DIAL. Search results are ~80% of the API bill: each search drags roughly
// 18k input tokens into context. Without max_uses the model searches until it
// decides it's done (measured: 4-7 per section). Lower = cheaper, less grounded.
// Raise to 4-5 if sections start returning thin or stale-sounding content.
const MAX_SEARCHES = 3;

const WEB_TOOL = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];

const SENT_SCHEMA =
  '{"overall":{"score":<int 0-100>,"label":"<2-3 words>","summary":"<<=20 words>"},' +
  '"categories":[{"name":"Medical","score":<int>,"label":"<1-2 words>","note":"<<=14 words>",' +
  '"headline":"<short real headline>","source":"<outlet>"}],"asOf":"<Month Year>"}';

async function callClaude(body) {
  const r = await fetch(ANTHROPIC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, ...body }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status);
  return r.json();
}

function parseText(data) {
  const c = Array.isArray(data && data.content) ? data.content : [];
  return c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
}

function extractJSON(text) {
  if (!text) return null;
  const s = text.indexOf("{");
  if (s === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

async function pullJSON(sysBase, userText, validate) {
  for (const strict of [false, true]) {
    const sys = sysBase + (strict
      ? " Return ONLY minified JSON on one line, no prose, no code fences, no trailing text."
      : " Respond with ONLY a JSON object, no markdown, no commentary.");
    try {
      const resp = await callClaude({ system: sys, tools: WEB_TOOL, messages: [{ role: "user", content: userText }] });
      const j = extractJSON(parseText(resp));
      if (j && validate(j)) return j;
    } catch { /* try next */ }
  }
  return null;
}

/* ---------- section generators (prompts mirror the app) ---------- */
async function genSentiment() {
  const base =
    "You are a cannabis-sector sentiment analyst writing for investors. Search the web for the most recent news (prioritize the last ~14 days) across five categories in this order: Medical, Recreational, Markets, Regulation, Social. Score each 0-100 (0 = very bearish, 50 = neutral/mixed, 100 = very bullish). Schema: " +
    SENT_SCHEMA + " Include all five categories, one short real headline each. Keep every field tight.";
  const j = await pullJSON(base, "Current cannabis sector sentiment snapshot.", (v) => v && v.overall);
  if (j) return j;
  try {
    const resp = await callClaude({
      system: "You are a cannabis-sector sentiment analyst. Using your best up-to-date knowledge, score five categories (Medical, Recreational, Markets, Regulation, Social) 0-100. Schema: " +
        SENT_SCHEMA + " Return ONLY minified JSON, no prose.",
      messages: [{ role: "user", content: "Current cannabis sector sentiment snapshot." }],
    });
    const k = extractJSON(parseText(resp));
    if (k && k.overall) return k;
  } catch { /* ignore */ }
  return null;
}

// Market section, rebuilt. Twelve Data prices and ranks the pool (data);
// Claude only explains WHY the surfaced movers are moving and names the next
// catalyst (judgment). Claude no longer invents prices or picks tickers, which
// removes a redundant, error-prone searched call — the prices it used to
// generate were overwritten by Twelve Data anyway.
async function genMarket() {
  const pool = await buildPricedPool();

  // Fallback: if Twelve Data is unreachable, fall back to the old model-driven
  // path so the section still renders rather than disappearing.
  if (!pool || !pool.movers.length) {
    const base =
      "You are a cannabis-equities analyst. Search the web for today's most active cannabis-sector stocks " +
      "(U.S. MSOs like GTBIF, CURLF, TCNNF, CRLBF; ETFs like MSOS; Canadian LPs like TLRY, CGC, ACB). " +
      'Schema: {"tickers":[{"symbol":"<T>","name":"<short name>","price":<num>,"changePct":<num>,"driver":"<<=8 words>"}],' +
      '"index":{"symbol":"MSOS","name":"<ETF name>","price":<num>,"changePct":<num>},' +
      '"catalyst":{"label":"<next catalyst, <=6 words>","date":"<YYYY-MM-DD>"},"asOf":"<Month D, Year>"}. ' +
      "Return exactly 6 tickers, biggest movers first.";
    return pullJSON(base, "Today's trending cannabis stocks and next catalyst.",
      (v) => v && Array.isArray(v.tickers) && v.tickers.length);
  }

  // Ask Claude ONLY for the driver blurbs (keyed by symbol) and the catalyst.
  // Prices/ranking are already decided. This is a small, cheap generation.
  const list = pool.movers.map((m) => m.symbol + " (" + m.name + ", " + (m.changePct >= 0 ? "+" : "") + Number(m.changePct).toFixed(1) + "%)").join("; ");
  const annPrompt =
    "You are a cannabis-equities analyst. These are today's top-moving cannabis stocks with their real % change: " +
    list + ". Search the web for the reason each is moving today, and identify the next known sector catalyst. " +
    'Return ONLY JSON: {"drivers":{"<SYMBOL>":"<why it moved, <=8 words>"},' +
    '"catalyst":{"label":"<next sector catalyst, <=6 words>","date":"<YYYY-MM-DD>"}}. ' +
    "A driver for every symbol listed. No prices, no extra keys.";

  const ann = await pullJSON(annPrompt, "Why today's cannabis movers are moving, and the next catalyst.",
    (v) => v && v.drivers && typeof v.drivers === "object");

  const drivers = (ann && ann.drivers) || {};
  const tickers = pool.movers.map((m) => ({
    ...m,
    driver: drivers[m.symbol] || "",
  }));

  return {
    tickers,
    index: pool.index || null,
    catalyst: (ann && ann.catalyst) || null,
    priced: pool.priced,           // full ranked pool → powers on-demand lookup cache
    asOf: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    pricesAsOf: new Date().toISOString(),
  };
}

async function genMedia() {
  const base =
    "You are a cannabis-sector media monitor for investors. Search the web for the very latest. " +
    'Schema: {"news":[{"title":"<headline>","source":"<outlet>","url":"<article link>","tag":"<bull|bear|neutral, likely impact on sector sentiment>"}],"videos":[{"title":"<video title>","channel":"<channel>","url":"<full youtube watch url>"}],"social":[{"platform":"<X|Reddit|StockTwits|YouTube>","note":"<<=16 words takeaway>","stance":"<bull|bear|mixed>"}]}. ' +
    "Include 8 news items (last ~7 days, real links, most important first), 4 recent YouTube videos with real watch URLs, and 4 social-pulse items. Keep everything tight and real.";
  return pullJSON(base, "Latest cannabis-sector news, videos, and social chatter.", (v) => v && (v.news || v.videos || v.social));
}

async function genDashboard() {
  const base =
    "You are the editor of a cannabis-sector investor terminal writing a fast morning snapshot. Search the web for the latest (prioritize the last ~7 days). " +
    'Schema: {"sentiment":{"score":<int 0-100>,"label":"<2-3 words>"},' +
    '"headlines":[{"title":"<headline>","source":"<outlet>","url":"<link>","tag":"<bull|bear|neutral>"}],' +
    '"catalysts":[{"label":"<event, <=8 words>","date":"<YYYY-MM-DD>"}],' +
    '"desks":{"markets":"<<=14 word read>","policy":"<<=14 word read>","healthcare":"<<=14 word read>","catalysts":"<<=14 word read>"},' +
    '"asOf":"<Month D, Year>"}. ' +
    "Give 5 headlines (most important first, real links), 4 near-term catalysts (soonest first), and one tight current read per desk.";
  return pullJSON(base, "Today's cannabis investor snapshot.", (v) => v && v.sentiment);
}

async function genHealthcare() {
  const base =
    "You are a cannabinoid healthcare and biotech analyst for investors. Search the web for the latest in medical cannabis and cannabinoid therapeutics, clinical trials, FDA actions, approvals, published research, and cannabinoid drug pipelines. Prioritize the last ~30 days. " +
    'Schema: {"overview":{"summary":"<<=28 words>","tone":"<bull|bear|mixed>"},' +
    '"developments":[{"title":"<headline>","org":"<company or institution>","stage":"<e.g. Phase II, FDA, Preclinical, Approval, Study>","note":"<<=16 words>","url":"<link>","tag":"<bull|bear|neutral>"}],' +
    '"pipeline":[{"compound":"<name>","indication":"<condition>","phase":"<phase or status>","sponsor":"<company>"}],"asOf":"<Month Year>"}. ' +
    "Include 6 recent developments (most important first, real links) and 5 notable cannabinoid pipeline programs.";
  return pullJSON(base, "Latest cannabinoid healthcare developments and drug pipeline.", (v) => v && (v.developments || v.overview));
}

async function genCatalysts() {
  const base =
    "You are a cannabis-sector catalyst analyst for investors. Search the web for upcoming and very recent market-moving events: federal rescheduling / DEA actions, SAFE Banking votes, state adult-use launches, major earnings, M&A, uplistings, and court rulings. " +
    'Schema: {"catalysts":[{"label":"<event, <=10 words>","date":"<YYYY-MM-DD>","category":"<policy|regulatory|earnings|market|state|legal>","impact":"<high|medium|low>","note":"<<=18 words>","tickers":["<TICKER>"]}],"asOf":"<Month D, Year>"}. ' +
    "Include 8-10 catalysts, soonest first, mixing dated near-term events with known upcoming milestones. Use real dates where known.";
  return pullJSON(base, "Upcoming cannabis-sector catalysts and key dates.", (v) => v && Array.isArray(v.catalysts) && v.catalysts.length);
}

async function genBriefing(kind) {
  const daily = kind === "daily";
  const base =
    "You are the lead writer of Canna Index's investor newsletter. Search the web for the most recent developments, then write the " +
    (daily
      ? "DAILY MORNING BRIEF, a fast pre-market read on the cannabis sector covering roughly the last 24-48 hours."
      : "WEEKLY SECTOR SUMMARY, a wider synthesis of the cannabis sector over the past week.") +
    " Cover equities/markets, policy & regulation, healthcare/cannabinoid developments, capital-markets activity, and forward catalysts. " +
    'Schema: {"headline":"<punchy <=10 word headline>","dateline":"<Month D, Year>","summary":"<<=32 word stand-first>",' +
    '"sections":[{"title":"<e.g. Markets>","bullets":["<<=24 word insight>"]}],' +
    '"catalystsAhead":[{"label":"<event>","date":"<YYYY-MM-DD>"}],"bottomLine":"<<=28 word takeaway>"}. ' +
    "Use 4-5 sections, 2-3 tight specific bullets each. Be concrete and real.";
  return pullJSON(base, (daily ? "Today's" : "This week's") + " cannabis investor briefing.", (v) => v && Array.isArray(v.sections) && v.sections.length);
}

async function genDeskBrief(sent, mkt, med) {
  if (!sent) return null;
  const ctx = JSON.stringify({
    sentiment: sent.overall ? { score: sent.overall.score, label: sent.overall.label, summary: sent.overall.summary } : null,
    categories: (sent.categories || []).map((c) => c.name + ":" + c.score).join(", "),
    index: (mkt && mkt.index) || null,
    catalyst: (mkt && mkt.catalyst) || null,
    movers: ((mkt && mkt.tickers) || []).slice(0, 5).map((t) => t.symbol + " " + (Number(t.changePct) || 0).toFixed(1) + "% (" + (t.driver || "") + ")").join("; "),
    headlines: ((med && med.news) || []).slice(0, 3).map((n) => n.title).join(" | "),
  });
  const sys =
    "You are the lead analyst on a cannabis-sector desk writing a crisp morning note for investors. " +
    "Using ONLY the data provided, return ONLY minified JSON: " +
    '{"thesis":"<one sharp sentence, <=24 words>","drivers":["<=14 words","<=14 words","<=14 words"],"stance":"<Constructive|Neutral|Cautious|Bullish|Bearish>, <=10 words>"}. ' +
    "Reference real tickers, catalysts and numbers from the data. Punchy and specific. No hedging, no disclaimers, no markdown.";
  try {
    const resp = await callClaude({ system: sys, max_tokens: 700, messages: [{ role: "user", content: "DATA:\n" + ctx }] });
    return extractJSON(parseText(resp));
  } catch { return null; }
}

/* ---------- Supabase upsert (overwrite one row per section) ---------- */
async function upsert(section, content) {
  const r = await fetch(process.env.SUPABASE_URL + "/rest/v1/ci_cache", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ section, content, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("supabase " + r.status + " " + (await r.text()).slice(0, 140));
  archive(section, content); // best-effort append-only history; never awaited, never throws
}

// Snapshot a section into ci_history keyed by (section, UTC day). Same-day re-run
// overwrites that day rather than duplicating. Fire-and-forget: if ci_history does
// not exist yet, or Supabase hiccups, this silently no-ops and the refresh proceeds.
async function archive(section, content) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await fetch(process.env.SUPABASE_URL + "/rest/v1/ci_history", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ section, day, content }),
    });
  } catch { /* history is best-effort */ }
}

/* ---------- Twelve Data: real market prices + 30-day history ---------- */
const TD_KEY = process.env.TWELVEDATA_API_KEY;
const TD = "https://api.twelvedata.com";

function fmtMD(d) {
  const p = String(d).split(" ")[0].split("-");
  return p.length === 3 ? parseInt(p[1], 10) + "/" + parseInt(p[2], 10) : d;
}
function fmtAsOf(d) {
  const t = Date.parse(d);
  return isNaN(t) ? d : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Pacing gate: enforce ~11s between ANY Twelve Data call (~5/min, safely under the 8/min free limit).
let _tdLast = 0;
async function tdGate() {
  const wait = Math.max(0, 11000 - (Date.now() - _tdLast));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  _tdLast = Date.now();
}

async function tdQuoteOne(symbol) {
  if (!TD_KEY || !symbol) return null;
  await tdGate();
  try {
    const u = TD + "/quote?symbol=" + encodeURIComponent(symbol) + "&apikey=" + TD_KEY;
    const r = await fetch(u);
    if (!r.ok) return null;
    const o = await r.json();
    if (o && o.close != null && !isNaN(Number(o.close)))
      return { price: Number(o.close), changePct: Number(o.percent_change) };
    return null;
  } catch { return null; }
}

// Batched quotes. Twelve Data's /quote accepts a comma-separated symbol list
// (confirmed available on this account), returning an object keyed by symbol.
// This lets us price the whole ~26-name pool in a couple of calls instead of
// one-at-a-time, so it fits well inside the function's time budget. We still
// pass through tdGate between batches to respect the 8-req/min ceiling.
const QUOTE_BATCH = 8; // symbols per call; keep modest so no single URL is huge

async function tdQuotesBatch(symbols) {
  const out = {};
  if (!TD_KEY || !symbols || !symbols.length) return out;

  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const chunk = symbols.slice(i, i + QUOTE_BATCH);
    await tdGate();
    try {
      const u = TD + "/quote?symbol=" + encodeURIComponent(chunk.join(",")) + "&apikey=" + TD_KEY;
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      // A single-symbol response is a bare object; a multi-symbol response is
      // keyed by symbol. Normalize both into `out`.
      const rows = chunk.length === 1 ? { [chunk[0]]: j } : j;
      for (const sym of chunk) {
        const o = rows && rows[sym];
        if (o && o.close != null && !isNaN(Number(o.close))) {
          out[sym] = { price: Number(o.close), changePct: Number(o.percent_change) };
        }
      }
    } catch { /* skip this chunk, keep whatever we have */ }
  }
  return out;
}

// The curated cannabis pool we price every refresh. Ranking these by movement
// is what surfaces the "movers" board; caching them all makes on-demand lookup
// free. Keep in sync with the ALLOW map in api/lookup.js. Dead OTC symbols
// (verified via scripts/td-probe.mjs) are intentionally omitted.
const POOL = [
  { symbol: "GTBIF", name: "Green Thumb Industries" },
  { symbol: "TCNNF", name: "Trulieve Cannabis" },
  { symbol: "CURLF", name: "Curaleaf Holdings" },
  { symbol: "CRLBF", name: "Cresco Labs" },
  { symbol: "TSNDF", name: "TerrAscend" },
  { symbol: "AYRWF", name: "Ayr Wellness" },
  { symbol: "GLASF", name: "Glass House Brands" },
  { symbol: "TLRY", name: "Tilray Brands" },
  { symbol: "CGC", name: "Canopy Growth" },
  { symbol: "ACB", name: "Aurora Cannabis" },
  { symbol: "CRON", name: "Cronos Group" },
  { symbol: "OGI", name: "Organigram Holdings" },
  { symbol: "SNDL", name: "SNDL Inc." },
  { symbol: "VFF", name: "Village Farms" },
  { symbol: "MSOS", name: "AdvisorShares Pure US Cannabis ETF" },
  { symbol: "MSOX", name: "AdvisorShares MSOS 2x Daily ETF" },
  { symbol: "YOLO", name: "AdvisorShares Pure Cannabis ETF" },
  { symbol: "CNBS", name: "Amplify Seymour Cannabis ETF" },
  { symbol: "IIPR", name: "Innovative Industrial Properties" },
  { symbol: "SMG", name: "Scotts Miracle-Gro" },
  { symbol: "GRWG", name: "GrowGeneration" },
  { symbol: "HYFM", name: "Hydrofarm Holdings" },
  { symbol: "AGFY", name: "Agrify" },
  { symbol: "JAZZ", name: "Jazz Pharmaceuticals" },
  { symbol: "GTII", name: "Green Thumb (alt listing)" },
  { symbol: "MRMD", name: "MariMed" },
];

const INDEX_SYMBOL = "MSOS"; // the sector proxy shown as the headline index
const MOVERS_SHOWN = 6;

// Price the whole pool, rank by absolute % move, and shape the top movers to
// match the existing front-end contract (symbol, name, price, changePct, cap?).
// Returns { movers, priced, index } or null if Twelve Data gave us nothing.
async function buildPricedPool() {
  if (!TD_KEY) return null;
  const symbols = POOL.map((p) => p.symbol);
  const quotes = await tdQuotesBatch(symbols);

  const priced = POOL
    .filter((p) => quotes[p.symbol])
    .map((p) => ({
      symbol: p.symbol,
      name: p.name,
      price: quotes[p.symbol].price,
      changePct: quotes[p.symbol].changePct,
    }));

  if (!priced.length) return null;

  // Rank by absolute % move, but guard against two mechanical-ranking artifacts
  // that a human picker would skip:
  //   - sub-$0.15 pennies, where a 1-cent tick is a huge % and pure noise
  //   - implausible one-day swings (>35%), usually splits/reverse-splits, not news
  // These still get priced and cached (searchable); they just don't hijack the
  // movers board. Falls back to the unfiltered set if the guard leaves too few.
  const rankable = priced.filter(
    (p) => p.price >= 0.15 && Math.abs(p.changePct || 0) <= 35
  );
  const pickFrom = rankable.length >= MOVERS_SHOWN ? rankable : priced;

  const movers = pickFrom
    .slice()
    .sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0))
    .slice(0, MOVERS_SHOWN);

  const idx = quotes[INDEX_SYMBOL];
  const index = idx
    ? { symbol: INDEX_SYMBOL, name: "AdvisorShares Pure US Cannabis ETF", price: idx.price, changePct: idx.changePct }
    : null;

  return { movers, priced, index };
}


async function tdSeries(symbol) {
  if (!TD_KEY) return null;
  await tdGate();
  try {
    const u = TD + "/time_series?symbol=" + encodeURIComponent(symbol) + "&interval=1day&outputsize=30&apikey=" + TD_KEY;
    const r = await fetch(u);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.values) || j.values.length < 2) return null;
    const asc = j.values.slice().reverse(); // API returns newest-first; chart wants oldest-first
    const points = asc.map((v) => ({ t: fmtMD(v.datetime), c: Number(v.close) })).filter((p) => isFinite(p.c));
    if (points.length < 2) return null;
    return { points, asOf: fmtAsOf(asc[asc.length - 1].datetime), currency: (j.meta && j.meta.currency) || "USD" };
  } catch { return null; }
}

// Derive price + daily % change from a history's last two closes (no extra API call).
function quoteFromSeries(series) {
  if (!series || !Array.isArray(series.points) || series.points.length < 2) return null;
  const c = series.points.map((p) => p.c);
  const last = c[c.length - 1], prev = c[c.length - 2];
  if (!isFinite(last) || !isFinite(prev) || prev === 0) return null;
  return { price: last, changePct: ((last - prev) / prev) * 100 };
}

/* ---------- read any cached section (used by quotes mode + weekly gating) ---------- */
async function readSection(section) {
  try {
    const u =
      process.env.SUPABASE_URL + "/rest/v1/ci_cache?section=eq." +
      encodeURIComponent(section) + "&select=content,updated_at";
    const r = await fetch(u, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// The Weekly Sector Summary covers a week but the full refresh runs daily, so it
// was being regenerated seven times per week of content. Regenerate on Mondays
// only — with two safety nets so it can never silently disappear:
//   1. if it has never been generated, build it now
//   2. if the cached copy is 6+ days old (missed cron, deploy gap), rebuild it
// Any other day, the existing row is left untouched and the site keeps serving it.
async function weeklyDue(force) {
  if (force) return true;
  const row = await readSection("brief_weekly");
  if (!row || !row.content) return true;
  const age = (Date.now() - Date.parse(row.updated_at)) / 86400000;
  if (!isFinite(age) || age >= 6) return true;
  return new Date().getUTCDay() === 1; // Monday
}

async function readMarketRow() {
  try {
    const u = process.env.SUPABASE_URL + "/rest/v1/ci_cache?section=eq.market&select=content";
    const r = await fetch(u, { headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY } });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rows[0].content : null;
  } catch { return null; }
}

// Lightweight price overlay via single-symbol quotes (intraday "quotes" mode).
async function applyRealPrices(market) {
  if (!market || !Array.isArray(market.tickers) || !TD_KEY) return market;
  const newTickers = [];
  for (const t of market.tickers) {
    const q = await tdQuoteOne(t.symbol);
    newTickers.push(q ? { ...t, price: q.price, changePct: q.changePct } : t);
  }
  market.tickers = newTickers;
  if (market.index && market.index.symbol) {
    const iq = await tdQuoteOne(market.index.symbol);
    if (iq) market.index = { ...market.index, price: iq.price, changePct: iq.changePct };
  }
  market.pricesAsOf = new Date().toISOString();
  return market;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Set CRON_SECRET in the environment to protect this endpoint." });
    return;
  }
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (auth !== "Bearer " + secret && key !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const mode = (req.query && req.query.mode) || "full";
  const out = {};

  // Cheap mode: only refresh real prices on the already-cached market (no Claude calls).
  if (mode === "quotes") {
    try {
      const market = await readMarketRow();
      if (market) { await upsert("market", await applyRealPrices(market)); out.market = "ok"; }
      else out.market = "no-base";
    } catch (e) { out.market = "error: " + (e && e.message ? e.message : String(e)); }
    res.status(200).json({ refreshed: out, mode, at: new Date().toISOString() });
    return;
  }

  const step = async (name, fn) => {
    try {
      const c = await fn();
      if (c) { await upsert(name, c); out[name] = "ok"; return c; }
      out[name] = "empty"; return null;
    } catch (e) { out[name] = "error: " + (e && e.message ? e.message : String(e)); return null; }
  };

  // Sentiment + media via Claude; market generated by Claude then overlaid with real prices.
  const [sentiment, market0, media] = await Promise.all([
    step("sentiment", genSentiment),
    genMarket().catch(() => null),
    step("media", genMedia),
  ]);

  let market = market0;

  // Fetch each ticker's real 30-day history once (paced through the gate), cache it,
  // and derive the ticker's price + daily change from that same history (no extra calls).
  if (market && Array.isArray(market.tickers) && TD_KEY) {
    const tickers = [];
    for (const t of market.tickers) {
      let nt = t;
      try {
        const s = await tdSeries(t.symbol);
        if (s) {
          await upsert("series_" + t.symbol, s);
          out["series_" + t.symbol] = "ok";
          const closes = s.points.map((p) => p.c);
          nt = { ...t, spark: closes };
          const q = quoteFromSeries(s);
          if (q) nt = { ...nt, price: q.price, changePct: q.changePct };
        } else out["series_" + t.symbol] = "empty";
      } catch (e) { out["series_" + t.symbol] = "error: " + (e && e.message ? e.message : String(e)); }
      tickers.push(nt);
    }
    market.tickers = tickers;
    if (market.index && market.index.symbol) {
      const iq = await tdQuoteOne(market.index.symbol);
      if (iq) market.index = { ...market.index, price: iq.price, changePct: iq.changePct };
    }
    market.pricesAsOf = new Date().toISOString();
  }

  // Warm the on-demand lookup cache for the WHOLE priced pool, not just the
  // shown movers. buildPricedPool already fetched these quotes, so this only
  // writes them — no extra Twelve Data calls. Any pool symbol a visitor
  // searches then returns instantly and free.
  if (market && Array.isArray(market.priced)) {
    for (const p of market.priced) {
      try {
        await upsert("lookup_" + p.symbol, {
          symbol: p.symbol, name: p.name,
          price: p.price, changePct: p.changePct,
          series: null,
          fetchedAt: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
    }
    delete market.priced;
  }

  try {
    if (market) { await upsert("market", market); out.market = "ok"; }
    else out.market = "empty";
  } catch (e) { out.market = "error: " + (e && e.message ? e.message : String(e)); }

  // brief_weekly is gated: on non-Mondays the cached row is left in place.
  const force = !!(req.query && (req.query.force === "1" || req.query.force === "true"));
  const weeklyStep = async () => {
    if (!(await weeklyDue(force))) {
      out.brief_weekly = "skipped (not due)";
      return null;
    }
    return step("brief_weekly", () => genBriefing("weekly"));
  };

  const results = await Promise.all([
    step("deskbrief", () => genDeskBrief(sentiment, market, media)),
    step("dashboard", genDashboard),
    step("healthcare", genHealthcare),
    step("catalysts", genCatalysts),
    step("brief_daily", () => genBriefing("daily")),
    weeklyStep(),
  ]);

  // Keep the Home gauge in sync with the Markets gauge: both use the sentiment section's score.
  const dash = results[1];
  if (dash && sentiment && sentiment.overall) {
    dash.sentiment = { score: sentiment.overall.score, label: sentiment.overall.label };
    try { await upsert("dashboard", dash); out.dashboard = "ok+synced"; } catch (e) { /* keep prior */ }
  }

  res.status(200).json({ refreshed: out, mode, at: new Date().toISOString() });
}
