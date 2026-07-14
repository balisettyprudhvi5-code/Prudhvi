# Mini Games Hub — Complete Fix

## What was actually broken

The cards render fine because they're pure HTML/CSS. "Play Now" doing
nothing is a **JavaScript binding** problem, not a markup problem. The old
code bound all four "Play Now" click listeners *inside* one giant shared
`DOMContentLoaded` handler that also runs the blog, mobile nav, tool tabs,
and every other subsystem on the page:

```js
document.addEventListener("DOMContentLoaded", function () {
  /* blog code, nav code, tabs code, ... */
  (function () {                         // <- old Mini Games Hub, buried here
    ...
    card.querySelector(".mg-play-btn").addEventListener("click", launch);
  })();
  /* ticket form code, and everything else after it */
});
```

Anything that throws earlier in that same handler stops every line after it
from ever running — including the code that attaches the Play Now click
listeners. Since that handler is 80,000+ characters covering dozens of
unrelated features, it's extremely fragile: one future edit anywhere above
the Mini Games Hub block can silently kill the "Play Now" buttons with zero
visible error to the user.

The iframe path was also relative (`"mini-games/" + gameId + ".html"`),
which is more fragile than it needs to be.

## What was fixed

**1. Fully isolated the Mini Games Hub into its own `<script>` block**, with
its own `DOMContentLoaded` listener and its own `try/catch`. It no longer
lives inside the shared handler, so nothing else on the page — now or in any
future edit — can prevent the Play Now buttons from binding.

**2. Switched to event delegation.** Instead of one listener per button
(fragile if the DOM ever re-renders), there's a single click listener on the
grid container that checks `e.target.closest(".mg-play-btn")`. Simpler,
fewer failure points.

**3. Absolute iframe path.** `iframe.src` now uses `/mini-games/<id>.html`
(leading slash) instead of a relative path — resolves correctly regardless
of how the page is reached.

**4. Added a load-failure fallback.** If a game's iframe doesn't fire its
`load` event within 8 seconds (or fires an `error` event), the overlay now
shows "This game couldn't load — Open it in a new tab instead" with a direct
link, instead of silently sitting on a spinner or a blank Vercel error page.

**5. Defensive inline style fallback.** `openGame`/`closeGame` now toggle
both the `.open` class *and* `overlay.style.display` directly, so the
overlay opening can't be silently defeated by an unrelated CSS rule
elsewhere in the stylesheet overriding `.mg-overlay.open`.

## Deployment structure (unchanged from before)

```
/index.html                          (patched — only the Mini Games Hub script changed)
/vercel.json
/mini-games/bubble-shooter.html
/mini-games/basketball-shoot.html
/mini-games/bowling.html
/mini-games/parking-master.html
```

## Verification performed

- Diffed old vs. new `index.html` — confirmed the *only* changes are the
  two Mini Games Hub script edits; all 6,400+ other lines (Smart Compress
  site, PDF Toolkit, Document Editor, blog, settings, etc.) are byte-for-byte
  identical.
- Extracted and `node --check`'d every `<script>` block in the new
  `index.html` — all pass (the one "failure" is the JSON-LD schema block,
  which is `application/ld+json` data, not executable JS — expected).
- All 4 game files re-verified: no external `src`/`href`, no CDN
  dependencies, no Node/server APIs — pure client-side HTML5 canvas + inline
  JS. Each game's script block passes `node --check` with zero syntax
  errors.
- `data-game` attributes on the 4 cards match the 4 filenames exactly
  (case-sensitive).
- No Content-Security-Policy or X-Frame-Options meta tags in the page that
  would block the iframe.
- No duplicate element IDs anywhere in the file that could cause
  `getElementById` to resolve to the wrong node.

## To deploy

Drop `mini-games/` into your project root next to `index.html`, replace
`index.html` with the patched version, commit, redeploy. Nothing else in
your repo needs to change.

## If it's still not working after this deploy

Open the browser console (F12 → Console) on the live page and click Play
Now — any error printed there (the standalone script wraps its init in
`try/catch` and logs to console) will point at the exact remaining issue.
That console line is the fastest way to close the loop if something in your
specific Vercel project (e.g. a custom `_headers`/CSP rule, or an
edge-config rewrite) is blocking `/mini-games/*` independent of the app
code itself.
