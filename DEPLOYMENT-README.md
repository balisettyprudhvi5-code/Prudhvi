# Smart Compress — Deployment & Update Notes

## Files in this delivery
- `index.html` — the full site (all original tools/design/SEO/AdSense untouched)
- `sw.js` — the service worker (offline caching + PWA installability)
- `site.webmanifest` — PWA manifest
- `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `logo-icon.png` — icon assets
- `api/chat.js` — Vercel Serverless Function powering the AI Chat Assistant (OpenRouter backend)
- `vercel.json` — deployment config: registers `api/chat.js` as a function and applies `Cache-Control` headers so browsers/CDNs never serve a stale `index.html` or `sw.js`
- `package.json` — declares the Node.js 20.x runtime for the serverless function

Deploy the whole folder to your project root — nothing needs to move.

## Required environment variable
In Vercel → your project → **Settings → Environment Variables**, add:
```
OPENROUTER_API_KEY = <your OpenRouter API key>
```
Get one at https://openrouter.ai/keys, then **redeploy** — adding an env var does not apply to a deployment that already happened.

Verify the function is live and the key is loading by visiting (GET request):
```
https://YOUR-SITE/api/chat
```
It returns small JSON diagnostics — never the key itself.

## GitHub deployment note
Filenames are case-sensitive on GitHub/Linux builds (unlike macOS/Windows). The serverless
function must be named exactly `api/chat.js` (lowercase) to match `vercel.json`'s
`functions` entry and the frontend's `fetch("/api/chat")` call — this has been verified in
this delivery.

## On every future deployment
Bump `window.APP_VERSION` in `index.html` and the `CACHE_NAME` version suffix in `sw.js`
(e.g. `smart-compress-v1` → `smart-compress-v2`). Browsers byte-compare `sw.js`, so any
change to it is what triggers clients to detect and install the update.

## AI Chat backend
- Provider: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
- Model fallback chain: `google/gemini-2.5-flash` → `deepseek/deepseek-chat-v3-0324` → `qwen/qwen3-235b-a22b`
- Each model gets up to 2 attempts before falling through to the next
- Auth errors (401/403) short-circuit immediately with a clear message pointing at `OPENROUTER_API_KEY`

## Image generation
Handled entirely client-side via Pollinations AI (`image.pollinations.ai`) — no server
component or API key required, and unaffected by the chat backend's status.
