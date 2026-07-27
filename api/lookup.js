// api/lookup.js — on-demand cannabis ticker lookup.
//
// Flow per request:
//   1. Validate the symbol against a curated allowlist (no arbitrary symbols —
//      that keeps this from becoming an open proxy onto your Twelve Data key).
//   2. Read the cached quote+series from Supabase. If it exists and is fresh
//      enough, return it — this is the common case and costs zero TD credits.
//   3. On a miss (or stale), fetch once from Twelve Data, write it back with the
//      SECRET key, and return it. The next visitor for that symbol reads cache.
//
// So a ticker nobody searches costs nothing, and a popular one is fetched at most
// once per freshness window regardless of how many people look at it.
//
// Reads here use the SECRET key (not the publishable one) because this endpoint
// also writes. It never trusts the client for anything but the symbol string.

const TD = "https://api.twelvedata.com";
const TD_KEY = process.env.TWELVEDATA_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;

// How long a cached lookup stays fresh. Prices move intraday, but for a research
// sparkline a few hours is plenty and keeps credit use near zero. The daily cron
// refreshes your 6 tracked movers separately; this is only for on-demand symbols.
const FRESH_HOURS = 6;

// ---- Curated allowlist -------------------------------------------------------
// symbol -> display name. Anything not here is rejected before any TD call.
// Grouped for readability; the code only cares about the keys.
// NOTE: several MSOs trade OTC (F-suffix). Verify TD coverage with scripts/verify-tickers
// and prune any that return no data before relying on them.
const ALLOW = {
  // US MSOs
  GTBIF: "Green Thumb Industries",
  TCNNF: "Trulieve Cannabis",
  CURLF: "Curaleaf Holdings",
  VRNOF: "Verano Holdings",
  CRLBF: "Cresco Labs",
  TSNDF: "TerrAscend",
  AYRWF: "Ayr Wellness",
  GLASF: "Glass House Brands",
  // Canadian LPs
  TLRY: "Tilray Brands",
  CGC: "Canopy Growth",
  ACB: "Aurora Cannabis",
  CRON: "Cronos Group",
  OGI: "Organigram Holdings",
  SNDL: "SNDL Inc.",
  VFF: "Village Farms",
  // ETFs / index
  MSOS: "AdvisorShares Pure US Cannabis ETF",
  MSOX: "AdvisorShares MSOS 2x Daily ETF",
  YOLO: "AdvisorShares Pure Cannabis ETF",
  POTX: "Global X Cannabis ETF",
  CNBS: "Amplify Seymour Cannabis ETF",
  // Ancillary / picks-and-shovels
  IIPR: "Innovative Industrial Properties",
  SMG: "Scotts Miracle-Gro",
  GRWG: "GrowGeneration",
  HYFM: "Hydrofarm Holdings",
  AGFY: "Agrify",
  // Pharma / cannabinoid
  JAZZ: "Jazz Pharmaceuticals",
  // Additional MSOs / brands
  GTII: "Green Thumb (alt listing)",
  CCHWF: "Columbia Care",
  MRMD: "MariMed",
  PLNHF: "Planet 13 Holdings",
};

function sbHeaders(extra) {
  return {
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    ...(extra || {}),
  };
}

async function readCached(section) {
  const q =
    SB_URL + "/rest/v1/ci_cache?section=eq." +
    encodeURIComponent(section) + "&select=content,updated_at";
  const r = await fetch(q, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function writeCached(section, content) {
  // Best-effort: a write failure shouldn't fail the user's lookup, they still
  // get the freshly-fetched data in the response.
  try {
    await fetch(SB_URL + "/rest/v1/ci_cache", {
      method: "POST",
      headers: sbHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({ section, content, updated_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}

function freshEnough(updatedAt) {
  const age = (Date.now() - Date.parse(updatedAt)) / 3600000;
  return isFinite(age) && age < FRESH_HOURS;
}

// ---- Twelve Data fetch (mirrors refresh.js shapes exactly) -------------------
function fmtMD(d) {
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtAsOf(d) {
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function tdQuote(symbol) {
  const r = await fetch(TD + "/quote?symbol=" + encodeURIComponent(symbol) + "&apikey=" + TD_KEY);
  if (!r.ok) return null;
  const o = await r.json();
  if (o && o.close != null && !isNaN(Number(o.close)))
    return { price: Number(o.close), changePct: Number(o.percent_change) };
  return null;
}

async function tdSeries(symbol) {
  const r = await fetch(
    TD + "/time_series?symbol=" + encodeURIComponent(symbol) +
    "&interval=1day&outputsize=30&apikey=" + TD_KEY
  );
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !Array.isArray(j.values) || j.values.length < 2) return null;
  const asc = j.values.slice().reverse();
  const points = asc.map((v) => ({ t: fmtMD(v.datetime), c: Number(v.close) })).filter((p) => isFinite(p.c));
  if (points.length < 2) return null;
  return { points, asOf: fmtAsOf(asc[asc.length - 1].datetime), currency: (j.meta && j.meta.currency) || "USD" };
}

// ---- handler -----------------------------------------------------------------
export default async function handler(req, res) {
  if (!TD_KEY || !SB_URL || !SB_KEY) {
    res.status(500).json({ error: "server not configured" });
    return;
  }

  const raw = (req.query.symbol || "").toString().trim().toUpperCase();
  if (!raw) {
    res.status(400).json({ error: "missing symbol" });
    return;
  }

  const name = ALLOW[raw];
  if (!name) {
    // Not a validation error the user did wrong — just not covered yet.
    res.status(200).json({ ok: false, reason: "not_tracked", symbol: raw });
    return;
  }

  const section = "lookup_" + raw;

  // 1) cache-first
  try {
    const cached = await readCached(section);
    if (cached && cached.content && freshEnough(cached.updated_at)) {
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
      res.status(200).json({ ok: true, cached: true, ...cached.content });
      return;
    }
  } catch { /* fall through to live fetch */ }

  // 2) live fetch on miss/stale — the only path that spends a TD credit
  try {
    const [quote, series] = await Promise.all([tdQuote(raw), tdSeries(raw)]);
    if (!quote && !series) {
      // TD returned nothing (often an OTC symbol it doesn't cover)
      res.status(200).json({ ok: false, reason: "no_data", symbol: raw, name });
      return;
    }
    const content = {
      symbol: raw,
      name,
      price: quote ? quote.price : null,
      changePct: quote ? quote.changePct : null,
      series: series || null,
      fetchedAt: new Date().toISOString(),
    };
    await writeCached(section, content);
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    res.status(200).json({ ok: true, cached: false, ...content });
  } catch (e) {
    res.status(502).json({ error: "lookup failed" });
  }
}
