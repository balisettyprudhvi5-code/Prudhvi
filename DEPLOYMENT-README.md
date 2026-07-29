# Smart Compress — Deployment & Update Notes

## Files in this delivery
- `index.html` — the full site (all original tools/design/SEO/AdSense untouched, plus Settings, Image Splitter, Merge Images, and the new update system)
- `sw.js` — the service worker (versioned caching)
- `site.webmanifest` — PWA manifest
- `offline.html` — offline fallback page
- `_headers` — Netlify header rules for real `Cache-Control` on HTML/SW (see below if you use a different host)

Deploy all five files to your site root (same folder as your existing `favicon.ico`, `logo-icon.png`, etc.). Nothing else needs to move.

## How the "only updates in Incognito" bug was fixed
That symptom means the **browser's HTTP cache** (not just the service worker) was serving a stale `index.html`. Three layers now work together so this can't happen again:

1. **Real HTTP header** (`_headers` file, or your host's equivalent) tells browsers/CDNs never to cache `index.html` or `sw.js` at the network layer.
2. **Service worker** uses a network-first strategy for HTML: it always tries the network first and only falls back to cache when offline.
3. **Versioned cache name**: every deploy that bumps `CACHE_VERSION` in `sw.js` creates a brand-new cache (`smartcompress-v2`, `smartcompress-v3`, …) and the `activate` step deletes every older `smartcompress-*` cache automatically.

## On every future deployment, do this one step
Open `sw.js` and increment the number:

```js
const CACHE_VERSION = 1;   // bump to 2, 3, 4… on each deploy
```

That single-character change is what makes the browser detect the new deployment (browsers byte-compare `sw.js` and treat any change as an update). You don't need to touch anything else — the page will:
- detect the new service worker in the background,
- show a small "A new version of Smart Compress is available" toast,
- unregister/replace the old cache and reload automatically once the user taps **Refresh** (or on their very next visit).

Also update the matching human-readable version string in `index.html` (search for `window.APP_VERSION`) so it stays in sync with what's shown in Settings → About.

## Cache-Control on hosts other than Netlify
If you're not on Netlify, add the equivalent of `_headers` for your platform:

**Vercel** — create `vercel.json`:
```json
{
  "headers": [
    {
      "source": "/(index.html|sw.js|site.webmanifest)",
      "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
    }
  ]
}
```

**Nginx:**
```
location = /index.html {
  add_header Cache-Control "no-cache, no-store, must-revalidate";
}
location = /sw.js {
  add_header Cache-Control "no-cache, no-store, must-revalidate";
}
```

**Apache (.htaccess):**
```
<FilesMatch "^(index\.html|sw\.js|site\.webmanifest)$">
  Header set Cache-Control "no-cache, no-store, must-revalidate"
</FilesMatch>
```

**GitHub Pages** doesn't allow custom headers — the service-worker network-first strategy is what protects you there; it's already handled in `sw.js`.

## What was added (summary)
- **Settings** menu item (always visible, desktop + mobile) → slide-out panel with Theme (Light/Dark/OLED/Auto), Accent Color, Font Size, Compact Mode, High Contrast, Reduce Animations, Rounded/Square corners, Background Wallpaper (9 CSS-generated presets + custom image upload), Export/Import/Restore Defaults, App Version, Storage Usage. Everything is stored in one `localStorage` key and applied instantly with no page reload. The wallpaper only affects the empty background areas — every card, button, and tool panel keeps its original opaque background exactly as before.
- **Image Splitter** (tool #11) — split into 2/3/4/6/8/9/12/16/25 pieces, live grid preview, ZIP download, full original resolution, PNG/JPG, 100% offline (canvas + JSZip, both already used elsewhere in the app).
- **Merge Images** (tool #12) — horizontal/vertical/grid layouts, adjustable spacing, background color or transparent, live canvas preview, PNG/JPG download, 100% offline.
- Nothing existing was removed, rebuilt, or restyled — all edits were additive.
