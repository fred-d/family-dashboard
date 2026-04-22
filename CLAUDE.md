# Family Dashboard — Notes for Claude

A Home Assistant addon. Beautiful family hub with shared calendar, meal planner,
recipe book, grocery list, and Kitchen Inventory — all backed by HA data.

Owner: Fred. Deploys via HA Supervisor; reachable on the LAN through HA ingress
and externally via Cloudflare Tunnel at **dashboard.fna3.net**.

---

## Repo facts (read these first)

- **Default branch is `master`**, not `main`. Pushes / PRs target `master`.
- **GitHub CLI** lives at `C:\Program Files\GitHub CLI\gh.exe`. Quote the path.
- **Working tree is on Windows** under OneDrive — paths in tool calls must use
  the absolute Windows form (`C:/Users/fredd/...`). Files have CRLF line endings;
  git's autocrlf warnings are normal, not an error.
- **Shell is bash via Git Bash.** Standard POSIX commands work.

## Workflow Fred prefers

- Don't ask permission to commit/push/merge — just ship the loop:
  1. Make the edit
  2. Bump `family_dashboard/config.yaml` `version:`
  3. Bump the relevant `?v=` cache-bust string in `index.html` for any JS/CSS
     you touched (see "Caching gotcha" below)
  4. `node --check` JS files and `python -m py_compile` Python files
  5. New branch, commit, push, open PR with `gh pr create`, **squash-merge**,
     `git checkout master && git pull`
- Commit messages: conventional prefix (`fix:`, `feat:`), HEREDOC body explaining
  the *why*, end with `Co-Authored-By: Claude ...`.
- Fred updates the addon in HA himself after each merge — don't tell him to
  rebuild anything; just say "update to vX.Y.Z, restart, hard-reload."

---

## Architecture

### Backend — `family_dashboard/rootfs/app/`

- **`server.py`** — Flask app, all the legacy routes (calendar, meals, recipes,
  grocery, auth). Static folder is `/app/static`. Auth via session cookie or
  HA ingress.
- **`inventory.py`** — Flask Blueprint mounted under `/api/inventory/*`. Owns
  the SQLite DB at `/data/inventory.db` (WAL mode, FK on, schema_meta key/val).
  Owns the UPC scan cascade and barcode catalog.
- HA access: backend uses `os.environ['SUPERVISOR_TOKEN']` to call
  `http://supervisor/core/...`. **Never put HA tokens in the frontend.**
- Real-time updates: SSE channel `inventory` — `_sse_push('inventory', {...})`
  triggers a re-fetch of the affected slice in the store.

### Frontend — `family_dashboard/rootfs/app/static/`

ES modules. Each "app" is a class + a store:

| App        | View class           | Store                  |
|------------|----------------------|------------------------|
| Calendar   | `HACalendar`         | (HA via backend proxy) |
| Meals      | `MealPlanner`        | `MealStore`            |
| Recipes    | `RecipeApp`          | `RecipeStore`          |
| Grocery    | `GroceryApp`         | `GroceryStore`         |
| Inventory  | `InventoryApp`       | `InventoryStore`       |

- **`app.js`** — entry point, view router (`#calendar`, `#meals`, ...), wires up
  classes after `auth.js` says it's safe.
- **`auth.js`** — checks `/api/auth/status`. Hides overlay → dispatches
  `app:authed` event AND sets `window.__appAuthed = true`. **Both signals are
  needed** because `app.js`'s import chain finishes after `auth.js` and would
  otherwise miss the event (see "Boot race" below).
- **`scanner.js`** — barcode camera + manual entry fallback. Calls
  `/api/inventory/scan/<upc>`. Imported with `?v=N` cache-bust by inventory.js
  and grocery.js — bump it when scanner.js changes (see "Caching gotcha").
- **`inventory-store.js`** — `_normalizeItem()` aliases backend join columns
  (`product_name`, `current_qty`, `percent_remaining`, `product_min_threshold`)
  to the names the UI was originally written against (`name`, `qty_on_hand`,
  `percent`, `low_qty_threshold`). **Touch this if you add a new field that
  needs to flow product → inventory.**

---

## UPC scan flow (the part with the most history)

1. User scans → `scanner.js` POSTs to `/api/inventory/scan/<upc>`
2. `inventory.py:api_scan` cascades through tiers, **caching** any hit in
   `products` + `barcode_catalog`:
   1. Local catalog (`barcode_catalog` JOIN `products`)
   2. Open Food Facts family — 4 sister DBs (`world.openfoodfacts.org`,
      `world.openbeautyfacts.org`, `world.openpetfoodfacts.org`,
      `world.openproductsfacts.org`). The split matters: dental floss lives in
      OpenProductsFacts, not the food DB.
   3. UPCitemDB free tier (`api.upcitemdb.com`, ~100/day, no auth)
3. Returns `{ found, source, product: { name, brand, image_url, category_id } }`
4. User clicks Confirm Restock → `POST /api/inventory/items` with the upc.
   Backend resolves `product_id` from `barcode_catalog` (cached in step 2) or
   creates a new product on the fly from name/brand/image_url.

`?debug=1` on the scan endpoint returns the per-tier raw responses.

---

## Caching gotcha (this has bitten us 3+ times)

ES module imports are cached by URL. Bumping `app.js?v=N` does **not**
invalidate child module imports like `import './scanner.js'`. The fix Fred
already shipped:

- Cache-bust query strings on child imports: `import './scanner.js?v=2'`
- Flask `after_request` hook in `server.py` sends
  `Cache-Control: no-cache, must-revalidate` for `.js`/`.css`/`.html`

So the rule: when you change `scanner.js` (or any module imported with `?v=N`),
**bump the query string in the importing files** AND also bump `app.js?v=N` in
`index.html` for good measure. The cache headers handle the rest going forward.

---

## Boot race (now handled, don't undo)

`auth.js` finishes its import chain before `app.js` does (calendar/meals/recipes/
grocery/inventory/settings/theme stores are a long chain). When the user is
already authenticated, `auth.js` dispatches `app:authed` *before* `app.js`
attaches its listener → blank UI on refresh until sign-out/sign-in.

Fix in place: `auth.js` sets `window.__appAuthed = true` alongside the
dispatch; `app.js` checks the flag on load and boots immediately if the event
was missed. **Don't go back to a single `addEventListener('app:authed', init,
{ once: true })`.**

---

## iOS layout

- Viewport meta has `viewport-fit=cover` and `apple-mobile-web-app-capable`
- `html`, `body`, `.app` use `100dvh` (with `100%` fallback) — never `100vh`,
  it doesn't shrink for the dynamic browser chrome
- `.app` has `padding: env(safe-area-inset-*)` so the header sits below the
  notch and the mobile nav clears the home indicator
- `overscroll-behavior-y: none` on body to kill rubber-band reveal

---

## Active bugs / TODOs

- **Phase 2B (Inventory)** still pending: shopping list view, store mode,
  family request pipeline, replace `window.prompt` Add Item placeholder with
  a proper modal, sunset the old Grocery sidebar entry.
- **Legacy `/api/upc/<barcode>`** route in `server.py` is dead code — scanner
  uses the new `/api/inventory/scan/<upc>` endpoint. Safe to delete next time
  someone touches that area.
- **`MDI_EMOJI` map in inventory.js** is a translation layer because the seed
  inserts MDI icon names but the UI renders emoji. Long-term either store
  emoji directly in the DB or render MDI properly in CSS.

---

## Versioning

Single source of truth: `family_dashboard/config.yaml` `version:`. Bump on
every user-visible change, even tiny ones — Fred uses it to confirm the addon
actually updated in HA.

Current at time of writing this doc: **v1.3.6**.

---

## Don't

- Don't add HA credentials to the frontend.
- Don't use `find`/`grep`/`cat` via Bash — use `Glob`/`Grep`/`Read`.
- Don't `git push --force` or `--no-verify`.
- Don't amend commits — make new ones.
- Don't create `*.md` files unless Fred asks (this file is the exception
  because he asked).
