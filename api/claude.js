// Vercel serverless function: a thin, secure proxy to the Anthropic Messages API.
//
// The browser calls THIS endpoint (/api/claude) instead of Anthropic directly.
// The secret API key is read from an environment variable that you set in the
// Vercel dashboard (Project → Settings → Environment Variables → ANTHROPIC_API_KEY).
// The key lives only on the server and is never sent to the browser or committed to git.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
    return;
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      // Forward the request body the app sent (model, messages, tools, etc.)
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Upstream request to Anthropic failed" });
  }
}
