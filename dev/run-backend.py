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
(DATA_DIR / 'recipes').mkdir(exist_ok=True)
(DATA_DIR / 'meals').mkdir(exist_ok=True)

# Patch env vars the app reads at module-level
HA_URL   = os.environ.get('HA_URL',   'https://dashboard.fna3.net').rstrip('/')
HA_TOKEN = os.environ.get('HA_TOKEN', '')   # HA long-lived access token

os.environ.setdefault('SUPERVISOR_TOKEN', HA_TOKEN)
os.environ['DATA_DIR']   = str(DATA_DIR)
os.environ['STATIC_DIR'] = str(APP_DIR / 'static')
os.environ['HA_BASE_URL'] = HA_URL  # picked up by the monkey-patch below

# ── Monkey-patch the hard-coded /data and /app/static paths ──────────────────
# server.py uses pathlib.Path('/data') and '/app/static'. We patch those
# at the module level before importing so the app uses local paths instead.
import pathlib as _pathlib
_orig_Path = _pathlib.Path

class _PatchedPath(_orig_Path):
    _flavour = _orig_Path('.')._flavour  # keep platform flavour
    def __new__(cls, *args, **kwargs):
        p = super().__new__(cls, *args, **kwargs)
        s = str(p)
        if s == '/data' or s.startswith('/data/'):
            p = super().__new__(cls, str(DATA_DIR) + s[5:])
        elif s == '/app/static':
            p = super().__new__(cls, str(APP_DIR / 'static'))
        return p

# Don't patch on Windows — absolute paths differ; use env vars instead.
# The server.py and pantry.py read DATA / STATIC from module-level variables.
# We patch them by importing and overwriting before Flask starts.

sys.path.insert(0, str(APP_DIR))

import server   # noqa: E402  — must come after path patch
import pantry as pantry_mod

# Override DATA and STATIC in both modules
server.DATA   = DATA_DIR
server.STATIC = APP_DIR / 'static'
server.PHOTOS = DATA_DIR / 'photos'
server.RECIPES = DATA_DIR / 'recipes'
server.MEALS   = DATA_DIR / 'meals'
server.HA_BASE = HA_URL
server.HA_TOKEN = HA_TOKEN

pantry_mod.DATA    = DATA_DIR
pantry_mod.DB_PATH = DATA_DIR / 'inventory.db'
pantry_mod.HA_BASE = HA_URL
pantry_mod.HA_TOKEN = HA_TOKEN

# Re-initialise the database at the new path
with server.app.app_context():
    pantry_mod._init_db(server.app)

PORT = int(os.environ.get('PORT', 8099))
print(f'[backend] data dir:   {DATA_DIR}')
print(f'[backend] static dir: {APP_DIR / "static"}')
print(f'[backend] HA base:    {HA_URL}')
print(f'[backend] http://localhost:{PORT}')

server.app.run(host='0.0.0.0', port=PORT, debug=True, threaded=True, use_reloader=False)
