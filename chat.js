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
// IMPORTANT: after adding/changing an Environment Variable in Vercel you
// must trigger a new deployment (Redeploy) — existing deployments do not
// pick up new env vars automatically.
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

const UPSTREAM_TIMEOUT_MS = 25000; // keep comfortably under Vercel's function timeout

function isModelUnavailableError(status, bodyText) {
  if (status === 404) return true;
  const s = (bodyText || "").toLowerCase();
  return /not found|not supported|does not exist|unable to find|unknown model|no access to model|not available in your (region|location)/.test(s);
}

// Applies permissive CORS so the endpoint also works if the site is ever
// served from a different origin/preview URL than the one the function
// deploys under. Same-origin requests are unaffected by these headers.
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function callGemini(apiKey, model, contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
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
      signal: controller.signal
    });

    const rawText = await upstream.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseErr) {
      // Upstream didn't return JSON (rare, but surface it instead of
      // silently swallowing it into a generic message).
      data = { error: { message: "Gemini returned a non-JSON response: " + rawText.slice(0, 300) } };
    }

    return { ok: upstream.ok && !data.error, status: upstream.status, data: data };
  } catch (err) {
    const message = err && err.name === "AbortError"
      ? "Timed out waiting for Gemini (" + model + ") to respond."
      : "Network error while contacting Gemini (" + model + "): " + (err && err.message ? err.message : String(err));
    return { ok: false, status: 502, data: { error: { message: message } } };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: { message: "Method not allowed. Use POST." } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Never expose whether/why a key is missing beyond a generic server-side message,
    // but DO log server-side so this is diagnosable from Vercel's function logs.
    console.error("GEMINI_API_KEY is not set in the server environment.");
    res.status(500).json({ error: { message: "AI service is not configured on the server (missing GEMINI_API_KEY)." } });
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
    const attempts = [];

    for (let i = 0; i < chain.length; i++) {
      result = await callGemini(apiKey, chain[i], contents);
      attempts.push({ model: chain[i], status: result.status });
      if (result.ok) break;

      const bodyText = JSON.stringify(result.data);
      const unavailable = isModelUnavailableError(result.status, bodyText);
      if (unavailable && i + 1 < chain.length) {
        // Silently fall through to the next candidate model in this tier.
        continue;
      }
      break;
    }

    if (!result.ok) {
      console.error("Gemini request failed. Attempts:", attempts, "Final response:", result.data);
      const status = result.status && result.status >= 400 ? result.status : 502;
      // Ensure the client always gets a real, human-readable message rather
      // than an empty/odd-shaped body.
      const message = (result.data && result.data.error && result.data.error.message)
        || "Gemini request failed with status " + result.status + ".";
      res.status(status).json({ error: { message: message, details: result.data } });
      return;
    }

    res.status(200).json(result.data);
  } catch (err) {
    console.error("Unexpected error in /api/chat:", err);
    res.status(500).json({ error: { message: "Unexpected server error while contacting the AI service: " + (err && err.message ? err.message : String(err)) } });
  }
};
