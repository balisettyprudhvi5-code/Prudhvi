// api/chat.js
// Production-ready Gemini AI backend for Vercel Serverless Functions.
//
// Required environment variable (set in Vercel Project Settings -> Environment Variables):
//   GEMINI_API_KEY = <your Gemini API key>
//
// Optional environment variable:
//   GEMINI_MODEL = <model id, defaults to "gemini-3.6-flash">
//
// No other configuration is required. Do not hardcode any key anywhere in this file.

const DEFAULT_MODEL = 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      error: 'Method Not Allowed',
      message: `HTTP method "${req.method}" is not supported. Use POST.`,
    });
  }

  // Ensure the API key is configured
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in environment variables.');
    return res.status(500).json({
      error: 'Server Misconfiguration',
      message: 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  // Parse and validate the request body
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({
        error: 'Invalid JSON',
        message: 'Request body could not be parsed as JSON.',
      });
    }
  }

  const message = body && body.message;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      error: 'Invalid Request',
      message: 'Request body must include a non-empty "message" string field.',
    });
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent`;

  try {
    const geminiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: message }],
          },
        ],
      }),
    });

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const errMessage =
        (data && data.error && data.error.message) ||
        'Unknown error occurred while contacting the Gemini API.';
      console.error('Gemini API error:', errMessage);
      return res.status(geminiResponse.status).json({
        error: 'Gemini API Error',
        message: errMessage,
      });
    }

    const candidate = data && data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const reply =
      Array.isArray(parts) && parts.length > 0
        ? parts.map((p) => p.text || '').join('').trim()
        : '';

    if (!reply) {
      const finishReason = candidate && candidate.finishReason;
      return res.status(502).json({
        error: 'Empty Response',
        message: finishReason
          ? `Gemini returned no text content (finishReason: ${finishReason}).`
          : 'Gemini returned no text content.',
      });
    }

    return res.status(200).json({
      reply,
      model,
    });
  } catch (err) {
    console.error('Unexpected error calling Gemini API:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Something went wrong while processing your request. Please try again.',
    });
  }
}
