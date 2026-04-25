#!/usr/bin/env python3
"""
Family Dashboard — Local Full-Stack Dev Runner
===============================================
Runs the REAL Flask backend on your machine so you can develop and test
backend (Python) changes without deploying to HA.

Usage
-----
1. Copy dev/.env.example → dev/.env and fill in values
2. python dev/run-backend.py
3. Open: http://localhost:8099

What this does
--------------
- Sets DATA_DIR to dev/data/ (local, gitignored)
- Sets STATIC dir to the source tree (hot-reloads on save with Flask debug mode)
- Points HA_BASE at either:
    a) Your real HA instance (set HA_URL + HA_TOKEN in .env)
    b) The mock HA server (run dev/mock-ha.py in another terminal, set HA_URL=http://localhost:8088)
- Mocks SUPERVISOR_TOKEN with the value from .env (can be a real HA long-lived token)

Requirements
------------
  pip install flask requests pillow python-dotenv
"""

import os
import sys
import pathlib

# ── Load .env ─────────────────────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent / '.env')
except ImportError:
    print('[warn] python-dotenv not installed — reading env vars as-is')

# ── Patch paths before importing server ──────────────────────────────────────
ROOT      = pathlib.Path(__file__).parent.parent
APP_DIR   = ROOT / 'family_dashboard' / 'rootfs' / 'app'
DATA_DIR  = ROOT / 'dev' / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)
(DATA_DIR / 'photos').mkdir(exist_ok=True)

# Patch env vars the app reads at module-level
HA_URL   = os.environ.get('HA_URL',   'https://dashboard.fna3.net').rstrip('/')
HA_TOKEN = os.environ.get('HA_TOKEN', '')   # HA long-lived access token

os.environ.setdefault('SUPERVISOR_TOKEN', HA_TOKEN)
os.environ['DATA_DIR']   = str(DATA_DIR)
os.environ['STATIC_DIR'] = str(APP_DIR / 'static')
os.environ['HA_BASE_URL'] = HA_URL  # picked up by the monkey-patch below

# On Windows the hard-coded Linux paths (/data, /app/static) in server.py
# and pantry.py are overwritten via module-level variable assignment below,
# so no pathlib monkey-patch is needed here.

sys.path.insert(0, str(APP_DIR))

import server   # noqa: E402  — must come after path patch
import pantry as pantry_mod

# Override DATA and STATIC in both modules
server.DATA   = DATA_DIR
server.STATIC = APP_DIR / 'static'
server.PHOTOS = DATA_DIR / 'photos'
server.HA_BASE = HA_URL
server.HA_TOKEN = HA_TOKEN

pantry_mod.DATA    = DATA_DIR
pantry_mod.DB_PATH = DATA_DIR / 'inventory.db'
pantry_mod.HA_BASE = HA_URL
pantry_mod.HA_TOKEN = HA_TOKEN

# Fix static_folder — Flask captured STATIC at import time ('/app/static').
# We must update the app object itself so CSS/JS are served from the local tree.
server.app.static_folder = str(APP_DIR / 'static')

# ── Dev auth bypass ───────────────────────────────────────────────────────────
# _require_auth is already registered as a before_request hook inside server.py.
# Insert our bypass BEFORE it so local dev skips the password check entirely.
from flask import session as _flask_session

def _dev_auth_bypass():
    _flask_session['authenticated'] = True

server.app.before_request_funcs.setdefault(None, []).insert(0, _dev_auth_bypass)

# Register the Pantry blueprint and initialise the database.
# pantry_mod.init() does both: it calls _init_db() and registers the
# blueprint at /api/pantry (+ /api/inventory legacy alias).
# server.py's __main__ block normally does this, but since we import
# server rather than running it directly, we must call init() ourselves.
pantry_mod.init(server.app, server._sse_push)

PORT = int(os.environ.get('PORT', 8099))
print(f'[backend] data dir:   {DATA_DIR}')
print(f'[backend] static dir: {APP_DIR / "static"}')
print(f'[backend] HA base:    {HA_URL}')
print(f'[backend] http://localhost:{PORT}')

server.app.run(host='0.0.0.0', port=PORT, debug=True, threaded=True, use_reloader=True)
