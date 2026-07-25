// api/chat.js
// Vercel Serverless Function — secure proxy between the Smart Compress
// AI Chat Assistant (browser) and the Gemini REST API.
//
// The Gemini API key NEVER reaches the browser. It is read here from
// process.env.GEMINI_API_KEY, which must be set in:
//   Vercel Dashboard → Project → Settings → Environment Variables
//     Name:  GEMINI_API_KEY
//     Value: <your Gemini API key from https://aistudio.google.com/apikey>
//
// The frontend only ever calls POST /api/chat with:
//   { contents: [...Gemini "contents" array...], tier: "lite" | "flash" | "pro" }
// and gets back the raw Gemini generateContent JSON response (or an
// { error: { message } } object on failure), which the existing frontend
// parsing logic already knows how to read.

// Candidate model IDs per tier, newest/most-capable first. The "-latest"
// alias is tried first so this automatically rides Google's newest release
// for that tier; explicit stable IDs behind it are fallbacks used only if
// the alias or newer model is unavailable for this key/account/region.
const MODEL_CHAINS = {
  lite: ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  flash: ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"],
  pro: ["gemini-pro-latest", "gemini-3.1-pro-preview", "gemini-2.5-pro"]
};

function isModelUnavailableError(status, bodyText) {
  if (status === 404) return true;
  const s = (bodyText || "").toLowerCase();
  return /not found|not supported|does not exist|unable to find|unknown model|no access to model|not available in your (region|location)/.test(s);
}

async function callGemini(apiKey, model, contents, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: contents,
      generationConfig: { temperature: 0.9, topP: 0.95 }
    }),
    signal: signal
  });

  const data = await upstream.json().catch(() => ({}));
  return { ok: upstream.ok && !data.error, status: upstream.status, data: data };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: { message: "Method not allowed. Use POST." } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Never expose whether/why a key is missing beyond a generic server-side message.
    console.error("GEMINI_API_KEY is not set in the server environment.");
    res.status(500).json({ error: { message: "AI service is not configured on the server." } });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const contents = body.contents;
  const tier = MODEL_CHAINS[body.tier] ? body.tier : "lite";
  const chain = MODEL_CHAINS[tier];

  if (!Array.isArray(contents) || !contents.length) {
    res.status(400).json({ error: { message: "Request body must include a non-empty 'contents' array." } });
    return;
  }

  try {
    let result = null;
    for (let i = 0; i < chain.length; i++) {
      result = await callGemini(apiKey, chain[i], contents);
      if (result.ok) break;
      const unavailable = isModelUnavailableError(result.status, JSON.stringify(result.data));
      if (unavailable && i + 1 < chain.length) {
        // Silently fall through to the next candidate model in this tier.
        continue;
      }
      break;
    }

    if (!result.ok) {
      console.error(result.data);
      res.status(result.status && result.status >= 400 ? result.status : 502).json(result.data);
      return;
    }

    res.status(200).json(result.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Unexpected server error while contacting the AI service." } });
  }
};
