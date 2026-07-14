# Mini Games — Root Cause & Fix

## Root cause
Nothing is wrong inside the four game files. Each one (`basketball-shoot.html`,
`bubble-shooter.html`, `bowling.html`, `parking-master.html`) is 100%
self-contained — single inline `<style>` + single inline `<script>`, zero
external `src`/`href` references, no CDN libraries, no images, no audio, no
fonts. I verified this with `grep` (no `src=`/`href=` at all) and confirmed
every extracted `<script>` block passes `node --check` with no syntax errors.

The actual bug is in `index.html`'s Mini Games Hub loader:

```js
iframe.src = "mini-games/" + gameId + ".html";
```

This is a **relative path** — it expects the four game files to live in a
`mini-games/` subfolder next to `index.html` on the server:

```
/index.html
/mini-games/bubble-shooter.html
/mini-games/basketball-shoot.html
/mini-games/bowling.html
/mini-games/parking-master.html
```

The four files were uploaded/deployed as flat files at the project root
instead (no `mini-games/` folder), so when the hub tries to load
`mini-games/bowling.html` etc. inside the iframe, Vercel can't find that path
and returns its default 404 `NOT_FOUND` page — which is exactly the "Vercel
error page" you're seeing rendered inside the game overlay.

## Fix
Deploy the games inside a `mini-games/` folder at the project root, exactly
as packaged in this output:

```
/index.html            (unchanged — Smart Compress site, untouched)
/vercel.json            (safety config, see below)
/mini-games/basketball-shoot.html
/mini-games/bubble-shooter.html
/mini-games/bowling.html
/mini-games/parking-master.html
```

Just drop the `mini-games/` folder into your repo/project root alongside the
existing `index.html`, commit, and redeploy. No code inside `index.html` or
the game files needed to change.

## Why `vercel.json` is included
If your Vercel project has (or ever gets) a catch-all rewrite like
`{ "source": "/(.*)", "destination": "/index.html" }` for SPA-style routing,
it would silently swallow `/mini-games/*.html` requests and serve the main
site inside the iframe instead of the game (a different bug with the same
symptom of "game doesn't load"). The included `vercel.json` keeps
`cleanUrls`/`trailingSlash` off and adds explicit caching headers for the
`mini-games/` path so these static `.html` files are always served as-is. If
you already have a `vercel.json`, just make sure it doesn't rewrite
`/mini-games/*` to `index.html`.

## Verification checklist
- ✅ All 4 game files: no missing images/audio/textures/CDN scripts (fully self-contained)
- ✅ All 4 game files: JS syntax validated (`node --check`), zero errors
- ✅ All 4 game files: well-formed HTML (proper doctype, closing tags)
- ✅ `data-game` attributes in `index.html` (`bubble-shooter`, `basketball-shoot`,
  `bowling`, `parking-master`) match filenames exactly (case-sensitive match confirmed)
- ✅ `index.html` left byte-for-byte unchanged
- ✅ Correct folder structure (`mini-games/`) reproduced for deployment
