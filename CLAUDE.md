# Family Dashboard — Notes for Claude

A Home Assistant addon. Beautiful family hub with shared calendar, meal planner,
recipe book, and Pantry (shopping list + inventory) — all backed by HA data.

Owner: Freddy. Deploys via HA Supervisor; reachable on the LAN through HA ingress
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
  4. New branch, commit, push, open PR with `gh pr create`, **squash-merge**,
     `git checkout master && git pull`
- Commit messages: conventional prefix (`fix:`, `feat:`), HEREDOC body explaining
  the *why*, end with `Co-Authored-By: Claude ...`.
- Fred updates the addon in HA himself after each merge — don't tell him to
  rebuild anything; just say "update to vX.Y.Z, restart, hard-reload."

---

## Local Development (dev/)

Three modes — choose based on what you're changing:

### Mode 1: Frontend-only (fastest — no Python needed)
```
pip install flask requests python-dotenv
cp dev/.env.example dev/.env    # fill in HA_URL, HA_TOKEN
python dev/proxy.py
# open http://localhost:8099 — edit JS/CSS/HTML, refresh browser
```
API calls proxy to your live HA instance. No deploy needed for frontend changes.

### Mode 2: Full backend (Python changes)
```
pip install -r dev/requirements.txt
cp dev/.env.example dev/.env    # fill in HA_URL, HA_TOKEN
python dev/run-backend.py
# Full Flask app on localhost:8099 with local SQLite in dev/data/
```

### Mode 3: Fully offline (no HA at all)
```
# Terminal 1:
python dev/mock-ha.py           # fake HA API on :8088
# Terminal 2: set HA_URL=http://localhost:8088 in dev/.env
python dev/run-backend.py       # or proxy.py
```

### Local dev notes for agents
- `dev/data/` is gitignored — safe to wipe/reset between test runs
- The mock HA server returns Freddy, Amy, Boy 1, Boy 2 as persons
- SQLite migrations run automatically on startup (idempotent ALTER TABLE)
- No HA token required for proxy.py when SKIP_AUTH=1 (default)

---

## Architecture

### Backend — `family_dashboard/rootfs/app/`

- **`server.py`** — Flask app, all legacy routes (calendar, meals, recipes, auth).
  Static folder is `/app/static`. Auth via session cookie or HA ingress.
- **`pantry.py`** — Flask Blueprint mounted under `/api/pantry/*`. Owns the SQLite
  DB at `/data/inventory.db` (WAL mode, FK on, schema_meta key/val). Also handles
  products, inventory, shopping list, stores, locations, barcode catalog, persons.
  Legacy prefix `/api/inventory/*` is still mounted as a back-compat alias.
- HA access: backend uses `os.environ['SUPERVISOR_TOKEN']` to call
  `http://supervisor/core/...`. **Never put HA tokens in the frontend.**
- Real-time updates: SSE channel `inventory` — `_sse_push('inventory', {...})`
  triggers a re-fetch of the affected slice in the store.

### Frontend — `family_dashboard/rootfs/app/static/`

ES modules. Each "app" is a class + a store:

| App        | View class   | Store          | Hash route  |
|------------|--------------|----------------|-------------|
| Calendar   | `HACalendar` | (HA proxy)     | `#calendar` |
| Meals      | `MealPlanner`| `MealStore`    | `#meals`    |
| Recipes    | `RecipeApp`  | `RecipeStore`  | `#recipes`  |
| Pantry     | `PantryApp`  | `PantryStore`  | `#pantry`   |

- **`app.js`** — entry point, view router, wires up classes after auth.
- **`auth.js`** — checks `/api/auth/status`. Dispatches `app:authed` AND sets
  `window.__appAuthed = true` (both needed — see "Boot race" below).
- **`pantry.js`** — PantryApp class. Shopping List tab + Pantry (inventory) tab.
  Scanner integration, store mode, meal plan import, photo lightbox.
- **`pantry-store.js`** — Thin translation layer: backend SQLite shape →
  old grocery-vocabulary shape the UI was written against.
- **`scanner.js`** — Barcode camera + manual entry fallback.
  Imported with `?v=N` cache-bust — bump when scanner.js changes.

### Key pantry shape translations (pantry-store.js)
- `s.added_by` → `item.addedBy`
- `s.store_id` → `item.storeId`, `st.store_name` → `item.storeName`
- `COALESCE(s.photo_url, p.image_url)` → `item.photo`
- `s.status='bought'` → `item.checked=true`
- Backend category UUID → grocery string id via `CATEGORY_NAME_HINTS`

---

## Stores seeded in DB

| id                   | Name                       |
|----------------------|----------------------------|
| walmart              | Walmart                    |
| walmart_neighborhood | Walmart Neighborhood Market|
| fresh_brookshires    | Fresh by Brookshires       |
| super1               | Super 1 Foods              |

---

## UPC scan flow

1. User scans → `scanner.js` POSTs to `/api/pantry/scan/<upc>`
2. `pantry.py:api_scan` cascades:
   1. Local catalog (`barcode_catalog` JOIN `products`)
   2. Open Food Facts family (4 sister DBs)
   3. UPCitemDB free tier (~100/day)
3. Returns `{ found, source, product: { name, brand, image_url, category_id } }`
4. Shopping List scan: opens Add Item modal pre-filled (not direct-add)
5. Inventory scan (Restock): marks existing item ok or opens inv modal for new

---

## Caching gotcha (has bitten us 3+ times)

ES module imports are cached by URL. Bumping `app.js?v=N` does **not**
invalidate child module imports like `import './pantry.js?v=5'`.

Rule: when you change any module imported with `?v=N`, bump the query string
in the importing file AND bump `app.js?v=N` in `index.html`. The
`Cache-Control: no-cache` header in `server.py` handles the rest going forward.

Current versions (bump as you change files):
- `pantry.js?v=5` (imported in app.js)
- `pantry-store.js?v=5`
- `scanner.js?v=3`
- `pantry.css?v=5`
- `app.js?v=49` (in index.html `<script>` tag)

---

## Boot race (now handled, don't undo)

`auth.js` finishes its import chain before `app.js`. When already authenticated,
`auth.js` dispatches `app:authed` before `app.js` attaches its listener → blank
UI on refresh. Fix: `auth.js` sets `window.__appAuthed = true` alongside the
dispatch; `app.js` checks the flag on load.

---

## iOS layout

- Viewport meta: `viewport-fit=cover`, `apple-mobile-web-app-capable`
- Use `100dvh` (with `100%` fallback), never `100vh`
- `padding: env(safe-area-inset-*)` on `.app`
- `overscroll-behavior-y: none` on body

---

## Versioning

Single source of truth: `family_dashboard/config.yaml` `version:`. Bump on
every user-visible change. Current: **v1.6.4**.

---

## Don't

- Don't add HA credentials to the frontend.
- Don't use `find`/`grep`/`cat` via Bash — use `Glob`/`Grep`/`Read`.
- Don't `git push --force` or `--no-verify`.
- Don't amend commits — make new ones.
- Don't create `*.md` files unless Fred asks.
- Don't hardcode family member names — always fetch from `/api/pantry/family`.
