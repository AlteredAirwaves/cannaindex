// api/cache.js — read a cached section from Supabase.
//
// The browser calls /api/cache?section=dashboard and gets back the pre-generated
// content (no Anthropic call, so it's instant and free). Reads use the PUBLISHABLE
// key + the table's row-level-security "public read" policy. Writes never happen here.

export default async function handler(req, res) {
  const section = req.query.section;
  if (!section) {
    res.status(400).json({ error: "missing section" });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: "Supabase env vars are not configured" });
    return;
  }

  try {
    const q =
      url +
      "/rest/v1/ci_cache?section=eq." +
      encodeURIComponent(section) +
      "&select=content,updated_at";
    const r = await fetch(q, {
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    if (!r.ok) {
      res.status(502).json({ error: "supabase read failed (" + r.status + ")" });
      return;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).json({ error: "not cached yet" });
      return;
    }
    // Let Vercel's edge cache hold the response briefly so bursts of visitors
    // don't each hit Supabase; it refreshes in the background.
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=3600");
    res.status(200).json({ content: rows[0].content, updated_at: rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: "read error" });
  }
}
