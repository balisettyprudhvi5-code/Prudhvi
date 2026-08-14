// api/generate-voice.js
//
// Secure server-side proxy for ElevenLabs Text-to-Speech.
//
// The browser NEVER talks to ElevenLabs directly and NEVER sees the API key.
// Flow: Browser -> POST /api/generate-voice -> this function -> ElevenLabs -> MP3 -> Browser
//
// Required Vercel Environment Variables (Project -> Settings -> Environment Variables):
//   ELEVENLABS_API_KEY   - your ElevenLabs secret API key
//   ELEVENLABS_VOICE_ID  - the ElevenLabs voice ID to use
//
// Neither value is ever read from the request body, query string, or headers sent
// by the browser, and neither is ever included in a response body, header, or log line.

const MAX_TEXT_LENGTH = 3000;

// Server-side allowlists. The browser can never pick an arbitrary model or output
// format — only values from these lists are accepted, everything else is rejected.
const ALLOWED_MODELS = new Set(["eleven_multilingual_v2"]);
const ALLOWED_OUTPUT_FORMATS = new Set(["mp3_44100_128"]);

const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

module.exports = async function handler(req, res) {
  // 1. POST only.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Invalid HTTP method. Use POST." });
  }

  // 2. Server configuration must be present. Never reveal *why* it's missing beyond this.
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    // Do not log the key. Do not echo env var names' values. Safe generic message only.
    console.error("generate-voice: missing required server configuration.");
    return res.status(500).json({ error: "Voice generation is not configured on the server yet." });
  }

  // 3. Parse and validate the request body.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: "Invalid request body." });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request body." });
  }

  const rawText = typeof body.text === "string" ? body.text : "";
  const text = rawText.trim();

  if (!text) {
    return res.status(400).json({ error: "Text is required." });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: `Text must be ${MAX_TEXT_LENGTH} characters or fewer.` });
  }

  // model_id / output_format are optional from the client; if provided they MUST match
  // the server allowlist, otherwise fall back to the safe defaults. The browser can never
  // force an arbitrary/unapproved model or format through to ElevenLabs.
  const modelId = ALLOWED_MODELS.has(body.model_id) ? body.model_id : DEFAULT_MODEL;
  const outputFormat = ALLOWED_OUTPUT_FORMATS.has(body.output_format) ? body.output_format : DEFAULT_OUTPUT_FORMAT;

  // The client is never allowed to specify a voice ID or an arbitrary ElevenLabs URL.
  // The voice ID always comes from server-side configuration.
  const elevenLabsUrl =
    "https://api.elevenlabs.io/v1/text-to-speech/" +
    encodeURIComponent(voiceId) +
    "?output_format=" +
    encodeURIComponent(outputFormat);

  // NOTE (production rate limiting): this endpoint currently has no rate limiting of its
  // own. Before going to production, add IP- or session-based throttling here (e.g. via
  // Vercel Edge Config, Upstash Redis, or a similar store) to prevent abuse of your
  // ElevenLabs quota. If this project already has an auth/rate-limit layer (like the one
  // used by /api/chat), wire this endpoint into that same system instead of building a
  // second, unrelated one.

  try {
    const upstreamResponse = await fetch(elevenLabsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text: text,
        model_id: modelId
      })
    });

    if (!upstreamResponse.ok) {
      // Never forward raw upstream error bodies/headers to the browser — they can leak
      // internal details. Log server-side only, without the key, and return a safe message.
      let upstreamDetail = "";
      try {
        upstreamDetail = await upstreamResponse.text();
      } catch (e) {
        upstreamDetail = "";
      }
      console.error(
        "generate-voice: ElevenLabs request failed with status " + upstreamResponse.status + ": " + upstreamDetail
      );
      return res.status(502).json({ error: "Voice generation is temporarily unavailable. Please try again." });
    }

    const audioBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audioBuffer);
  } catch (err) {
    // Generic catch-all. Never include err.message verbatim if there's any chance it
    // contains request/response details; log full detail server-side only.
    console.error("generate-voice: unexpected error:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Voice generation is temporarily unavailable. Please try again." });
  }
};
