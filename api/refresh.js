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
const WEB_TOOL = [{ type: "web_search_20250305", name: "web_search" }];

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

async function genMarket() {
  const base =
    "You are a cannabis-equities analyst. Search the web for today's most active and trending cannabis-sector stocks, U.S. MSOs (e.g. Green Thumb GTBIF, Curaleaf CURLF, Trulieve TCNNF, Cresco CRLBF, Verano VRNOF), ETFs (MSOS, MJ), and Canadian LPs (Tilray TLRY, Canopy CGC, Aurora ACB). " +
    'Schema: {"tickers":[{"symbol":"<TICKER>","name":"<short name>","price":<number USD>,"changePct":<number, today % change, negative if down>,"cap":<approx market cap in billions USD, number>,"driver":"<<=8 words>"}],' +
    '"index":{"symbol":"MSOS","name":"<ETF name>","price":<number>,"changePct":<number>},' +
    '"catalyst":{"label":"<next sector catalyst, <=6 words>","date":"<YYYY-MM-DD>"},"asOf":"<Month D, Year>"}. ' +
    "Return exactly 6 tickers, biggest movers first, with real recent values. The index is the leading U.S. cannabis ETF. The catalyst is the next known market-moving event (e.g. a DEA hearing, earnings, a vote).";
  return pullJSON(base, "Today's trending cannabis stocks, sector index, and next catalyst.", (v) => v && Array.isArray(v.tickers) && v.tickers.length);
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

  const out = {};
  const step = async (name, fn) => {
    try {
      const c = await fn();
      if (c) { await upsert(name, c); out[name] = "ok"; return c; }
      out[name] = "empty"; return null;
    } catch (e) { out[name] = "error: " + (e && e.message ? e.message : String(e)); return null; }
  };

  // Generate the market trio first (deskbrief is synthesized from them), then the rest.
  const [sentiment, market, media] = await Promise.all([
    step("sentiment", genSentiment),
    step("market", genMarket),
    step("media", genMedia),
  ]);

  await Promise.all([
    step("deskbrief", () => genDeskBrief(sentiment, market, media)),
    step("dashboard", genDashboard),
    step("healthcare", genHealthcare),
    step("catalysts", genCatalysts),
    step("brief_daily", () => genBriefing("daily")),
    step("brief_weekly", () => genBriefing("weekly")),
  ]);

  res.status(200).json({ refreshed: out, at: new Date().toISOString() });
}
