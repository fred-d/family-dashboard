"""
Kitchen Inventory Module
========================
A clean, relational inventory system built on SQLite. Replaces the old
JSON-based pantry/grocery storage.

Architecture
------------
- Product Master (products)          — abstract product definitions
- Inventory (inventory)              — physical lots, per location
- Locations                          — user-definable storage areas
- Categories                         — grocery aisle grouping
- Stores                             — where items are purchased
- Barcode Catalog (barcode_catalog)  — local UPC cache with fallback lookup
- Shopping List (shopping_list)      — auto + manual items
- History (inventory_history)        — audit log for sparklines / attribution

All endpoints are exposed under /api/inventory/* via a Flask Blueprint.
Real-time updates broadcast via the SSE push function provided at init.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import requests
from flask import Blueprint, Flask, g, jsonify, request

# ── Config ────────────────────────────────────────────────────────────────────

DATA      = pathlib.Path('/data')
DB_PATH   = DATA / 'inventory.db'
SCHEMA_VERSION = 1

HA_BASE   = 'http://supervisor/core'
HA_TOKEN  = os.environ.get('SUPERVISOR_TOKEN', '')

OFF_UA    = 'FamilyDashboard-Inventory/2.0'

# Open Food Facts split into product-type-specific databases. We cascade
# through them so non-food UPCs (toiletries, cleaning, dental, batteries,
# generic merchandise) still resolve. Order matters: cheapest-likely-hit
# first. OpenProductsFacts is the catch-all for everything that doesn't
# fit the more specific buckets.
OFF_DBS = [
    ('off',  'world.openfoodfacts.org',     'food'),
    ('obf',  'world.openbeautyfacts.org',   'beauty'),
    ('opff', 'world.openpetfoodfacts.org',  'pet food'),
    ('opf',  'world.openproductsfacts.org', 'general products'),
]

# UPCitemDB free tier — ~100 lookups/day, no auth required. Used as a
# final fallback when none of the OFF databases have the barcode.
UPCITEMDB_URL = 'https://api.upcitemdb.com/prod/trial/lookup?upc={}'

# Injected at blueprint registration — wired up to server.py's _sse_push
_sse_push: Callable[[str, dict], None] = lambda event, data: None

# ── Blueprint ─────────────────────────────────────────────────────────────────

bp = Blueprint('inventory', __name__, url_prefix='/api/inventory')


# ── SQLite connection management ──────────────────────────────────────────────
# One connection per request (stored on flask.g), closed in teardown. This
# sidesteps SQLite's thread-affinity rules for Flask's threaded=True mode.

def _conn() -> sqlite3.Connection:
    if 'inv_db' not in g:
        DATA.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        c.execute('PRAGMA foreign_keys = ON')
        c.execute('PRAGMA journal_mode = WAL')
        c.row_factory = sqlite3.Row
        g.inv_db = c
    return g.inv_db


@bp.teardown_request
def _close_conn(exc):
    c = g.pop('inv_db', None)
    if c is not None:
        try:
            c.close()
        except Exception:
            pass


# ── Schema & seed data ────────────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    icon        TEXT DEFAULT 'mdi:food-variant',
    color       TEXT DEFAULT '#4a90e2',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    icon        TEXT DEFAULT 'mdi:tag',
    color       TEXT DEFAULT '#888888',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    icon        TEXT DEFAULT 'mdi:store',
    color       TEXT DEFAULT '#555555',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    brand                   TEXT DEFAULT '',
    category_id             TEXT REFERENCES categories(id) ON DELETE SET NULL,
    image_url               TEXT DEFAULT '',
    default_location_id     TEXT REFERENCES locations(id) ON DELETE SET NULL,
    default_store_id        TEXT REFERENCES stores(id)    ON DELETE SET NULL,
    default_unit            TEXT DEFAULT 'count',
    min_threshold           REAL DEFAULT 1,
    typical_shelf_life_days INTEGER,
    tracks_percent          INTEGER DEFAULT 0,
    notes                   TEXT DEFAULT '',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS barcode_catalog (
    barcode     TEXT PRIMARY KEY,
    product_id  TEXT REFERENCES products(id) ON DELETE CASCADE,
    source      TEXT NOT NULL,
    raw_data    TEXT,
    cached_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
    id                 TEXT PRIMARY KEY,
    product_id         TEXT NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    location_id        TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    current_qty        REAL NOT NULL DEFAULT 0,
    unit               TEXT NOT NULL DEFAULT 'count',
    percent_remaining  INTEGER,
    purchased_at       TEXT,
    expires_at         TEXT,
    added_by           TEXT,
    last_scanned_at    TEXT,
    notes              TEXT DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_product  ON inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_location ON inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_expires  ON inventory(expires_at);

CREATE TABLE IF NOT EXISTS shopping_list (
    id          TEXT PRIMARY KEY,
    product_id  TEXT REFERENCES products(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    qty         REAL NOT NULL DEFAULT 1,
    unit        TEXT DEFAULT 'count',
    store_id    TEXT REFERENCES stores(id) ON DELETE SET NULL,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'needed',
    source      TEXT NOT NULL DEFAULT 'manual',
    added_by    TEXT,
    notes       TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shopping_status ON shopping_list(status);
CREATE INDEX IF NOT EXISTS idx_shopping_source ON shopping_list(source);

CREATE TABLE IF NOT EXISTS inventory_history (
    id           TEXT PRIMARY KEY,
    inventory_id TEXT,
    product_id   TEXT NOT NULL,
    action       TEXT NOT NULL,
    qty_delta    REAL NOT NULL DEFAULT 0,
    qty_after    REAL NOT NULL DEFAULT 0,
    person       TEXT,
    notes        TEXT DEFAULT '',
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_product ON inventory_history(product_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON inventory_history(created_at);
"""


SEED_LOCATIONS = [
    # (id,           name,           icon,                      color,     sort)
    ('pantry',       'Pantry',       'mdi:food-variant',        '#d97706', 10),
    ('fridge',       'Fridge',       'mdi:fridge',              '#2563eb', 20),
    ('freezer',      'Freezer',      'mdi:snowflake',           '#0ea5e9', 30),
    ('patio_fridge', 'Patio Fridge', 'mdi:fridge-outline',      '#14b8a6', 40),
]

SEED_CATEGORIES = [
    ('produce',     'Produce',            'mdi:carrot',                '#16a34a',  10),
    ('dairy',       'Dairy',              'mdi:cheese',                '#60a5fa',  20),
    ('meat',        'Meat & Seafood',     'mdi:food-steak',            '#dc2626',  30),
    ('bakery',      'Bakery',             'mdi:bread-slice',           '#d97706',  40),
    ('frozen',      'Frozen',             'mdi:snowflake',             '#0ea5e9',  50),
    ('pantry_s',    'Pantry Staples',     'mdi:sack',                  '#a16207',  60),
    ('canned',      'Canned Goods',       'mdi:food-variant',          '#854d0e',  70),
    ('condiments',  'Condiments & Sauces','mdi:bottle-tonic',          '#eab308',  80),
    ('baking',      'Baking',             'mdi:cupcake',               '#ec4899',  90),
    ('breakfast',   'Breakfast & Cereal', 'mdi:bowl-mix',              '#f59e0b', 100),
    ('snacks',      'Snacks',             'mdi:cookie',                '#f97316', 110),
    ('beverages',   'Beverages',          'mdi:cup',                   '#8b5cf6', 120),
    ('cleaning',    'Cleaning',           'mdi:spray-bottle',          '#06b6d4', 130),
    ('personal',    'Personal Care',      'mdi:lotion',                '#db2777', 140),
    ('pet',         'Pet',                'mdi:paw',                   '#92400e', 150),
    ('household',   'Household',          'mdi:home-variant',          '#64748b', 160),
    ('other',       'Other',              'mdi:dots-horizontal',       '#6b7280', 999),
]

SEED_STORES = [
    ('walmart',             'Walmart',                    'mdi:store',          '#0071ce',  10),
    ('walmart_neighborhood','Walmart Neighborhood Market','mdi:store-outline',  '#4a9ae0',  20),
    ('fresh_brookshires',   'Fresh by Brookshires',       'mdi:cart-variant',   '#e85d3a',  30),
    ('super1',              'Super 1 Foods',              'mdi:cart',           '#16a34a',  40),
]


def _now() -> str:
    """ISO-8601 UTC timestamp with 'Z' suffix."""
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _init_db(app: Flask):
    """Create tables, seed reference data, stamp schema version."""
    DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    c.execute('PRAGMA foreign_keys = ON')
    c.execute('PRAGMA journal_mode = WAL')
    try:
        c.executescript(SCHEMA_SQL)

        # Only seed on first run (empty locations = fresh install)
        existing = c.execute('SELECT COUNT(*) FROM locations').fetchone()[0]
        if existing == 0:
            now = _now()
            c.executemany(
                'INSERT INTO locations (id,name,icon,color,sort_order,created_at) '
                'VALUES (?,?,?,?,?,?)',
                [(i, n, ic, co, so, now) for (i, n, ic, co, so) in SEED_LOCATIONS],
            )

        if c.execute('SELECT COUNT(*) FROM categories').fetchone()[0] == 0:
            now = _now()
            c.executemany(
                'INSERT INTO categories (id,name,icon,color,sort_order,created_at) '
                'VALUES (?,?,?,?,?,?)',
                [(i, n, ic, co, so, now) for (i, n, ic, co, so) in SEED_CATEGORIES],
            )

        if c.execute('SELECT COUNT(*) FROM stores').fetchone()[0] == 0:
            now = _now()
            c.executemany(
                'INSERT INTO stores (id,name,icon,color,sort_order,created_at) '
                'VALUES (?,?,?,?,?,?)',
                [(i, n, ic, co, so, now) for (i, n, ic, co, so) in SEED_STORES],
            )

        c.execute(
            'INSERT INTO schema_meta (key,value) VALUES (?,?) '
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ('version', str(SCHEMA_VERSION)),
        )
        app.logger.info(f'[inventory] database ready at {DB_PATH} (schema v{SCHEMA_VERSION})')
    finally:
        c.close()


# ── Row helpers ───────────────────────────────────────────────────────────────

def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r else None


def _rows(rs) -> list[dict]:
    return [dict(r) for r in rs]


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _slug(s: str) -> str:
    s = re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')
    return s or _uid()


def _person_id() -> str:
    """Read person identity from the request body or header for attribution."""
    body = request.get_json(silent=True) or {}
    return (body.get('personId')
            or request.headers.get('X-Person-Id')
            or request.args.get('personId')
            or 'household')


# ── Status derivation ─────────────────────────────────────────────────────────

def _stock_status(current: float, threshold: float) -> str:
    if current <= 0:
        return 'out'
    if current < threshold:
        return 'low'
    return 'ok'


def _expiry_status(expires_at: str | None) -> str | None:
    """Return 'expired' | 'soon' | 'watch' | 'ok' | None (if no date)."""
    if not expires_at:
        return None
    try:
        exp = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
        days = (exp - datetime.now(timezone.utc)).days
    except Exception:
        return None
    if days < 0:    return 'expired'
    if days <= 3:   return 'soon'
    if days <= 7:   return 'watch'
    return 'ok'


# ── HA Person Integration ─────────────────────────────────────────────────────

_HIDDEN_KEY = 'hidden_persons'   # stored in schema_meta as JSON list of entity_ids


def _ha_get(path: str):
    return requests.get(
        f'{HA_BASE}{path}',
        headers={'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'},
        timeout=8,
    )


def _get_hidden_persons(c: sqlite3.Connection) -> list[str]:
    row = c.execute('SELECT value FROM schema_meta WHERE key=?', (_HIDDEN_KEY,)).fetchone()
    if not row:
        return []
    try:
        return json.loads(row['value']) or []
    except Exception:
        return []


def _set_hidden_persons(c: sqlite3.Connection, ids: list[str]):
    c.execute(
        'INSERT INTO schema_meta (key,value) VALUES (?,?) '
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        (_HIDDEN_KEY, json.dumps(ids)),
    )


def _avatar_proxy_url(raw: str) -> str:
    """Rewrite HA-relative avatar paths to go through our proxy endpoint."""
    if not raw:
        return ''
    # Already a full URL → leave alone
    if raw.startswith(('http://', 'https://')):
        return raw
    # HA returns paths like "/api/image/serve/<hash>/512x512"
    # Route through our proxy so the browser (on dashboard.fna3.net) can fetch it.
    return f'/api/inventory/avatar?src={requests.utils.quote(raw, safe="")}'


_BOT_NAME_HINTS = ('mqtt', 'bot', 'service', 'system', 'hass', 'node-red', 'esphome')


def _auto_hide_bot_accounts(c: sqlite3.Connection, entity_ids: list[str]) -> list[str]:
    """On first family-load, auto-add obvious bot/service accounts (mqttuser,
    node-red, etc.) to the hidden-persons list. Idempotent — only touches
    entities that aren't already in the list."""
    row = c.execute('SELECT value FROM schema_meta WHERE key=?', (_HIDDEN_KEY,)).fetchone()
    if row is not None:
        return _get_hidden_persons(c)  # already seeded — respect user edits
    auto = [
        eid for eid in entity_ids
        if any(h in eid.lower() for h in _BOT_NAME_HINTS)
    ]
    _set_hidden_persons(c, auto)
    c.commit()
    return auto


@bp.route('/family')
def api_family():
    """Return the roster of HA person entities (hidden persons filtered out)."""
    c = _conn()
    show_hidden = request.args.get('showHidden') == '1'
    try:
        r = _ha_get('/api/states')
        states = r.json()
        all_person_ids = [s.get('entity_id', '') for s in states
                          if s.get('entity_id', '').startswith('person.')]
        # Seed hidden list on first run with obvious bot accounts
        hidden = set(_auto_hide_bot_accounts(c, all_person_ids))
        people = []
        for s in states:
            eid = s.get('entity_id', '')
            if not eid.startswith('person.'):
                continue
            if not show_hidden and eid in hidden:
                continue
            attrs = s.get('attributes', {}) or {}
            name = attrs.get('friendly_name') or eid.replace('person.', '').replace('_', ' ').title()
            people.append({
                'id':       eid,
                'name':     name,
                'avatar':   _avatar_proxy_url(attrs.get('entity_picture', '')),
                'state':    s.get('state', 'unknown'),
                'initials': _initials(name),
                'color':    _stable_color(eid),
                'hidden':   eid in hidden,
            })
        people.sort(key=lambda p: p['name'].lower())
        return jsonify(people)
    except Exception:
        return jsonify([])


@bp.route('/family/hidden', methods=['GET', 'POST'])
def api_family_hidden():
    """Manage the hidden-persons blocklist (used to hide MQTT / system accounts)."""
    c = _conn()
    if request.method == 'GET':
        return jsonify(_get_hidden_persons(c))
    body = request.get_json() or {}
    ids = body.get('hidden') or []
    if not isinstance(ids, list):
        return jsonify({'error': 'hidden must be a list'}), 400
    # Accept only person.* entity_ids
    ids = [x for x in ids if isinstance(x, str) and x.startswith('person.')]
    _set_hidden_persons(c, ids)
    _sse_push('inventory', {'type': 'family'})
    return jsonify({'ok': True, 'hidden': ids})


@bp.route('/avatar')
def api_avatar_proxy():
    """
    Proxy HA-relative avatar images so the browser can load them from
    dashboard.fna3.net (where /api/image/... doesn't exist directly).
    Strict whitelist on src paths — only HA image/media endpoints allowed.
    """
    src = request.args.get('src', '')
    if not src.startswith('/api/image/') and not src.startswith('/api/media/'):
        return jsonify({'error': 'Invalid source'}), 400
    try:
        r = requests.get(
            f'{HA_BASE}{src}',
            headers={'Authorization': f'Bearer {HA_TOKEN}'},
            timeout=8,
            stream=True,
        )
        if r.status_code != 200:
            return ('', r.status_code)
        ctype = r.headers.get('Content-Type', 'image/jpeg')
        # Cache aggressively — avatars don't change often
        return (r.content, 200, {
            'Content-Type':  ctype,
            'Cache-Control': 'public, max-age=86400',
        })
    except Exception:
        return ('', 502)


def _initials(name: str) -> str:
    parts = [p for p in re.split(r'\s+', name.strip()) if p]
    if not parts:
        return '?'
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _stable_color(seed: str) -> str:
    """Hash-derived pastel color so each person gets a consistent hue."""
    palette = [
        '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80',
        '#34d399', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa',
        '#c084fc', '#e879f9', '#f472b6', '#fb7185',
    ]
    h = 0
    for ch in seed:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return palette[h % len(palette)]


# ── Bootstrap config (everything the UI needs in one call) ────────────────────

@bp.route('/config')
def api_config():
    c = _conn()
    return jsonify({
        'locations':  _rows(c.execute('SELECT * FROM locations  ORDER BY sort_order, name')),
        'categories': _rows(c.execute('SELECT * FROM categories ORDER BY sort_order, name')),
        'stores':     _rows(c.execute('SELECT * FROM stores     ORDER BY sort_order, name')),
    })


# ── Locations CRUD ────────────────────────────────────────────────────────────

@bp.route('/locations', methods=['GET', 'POST'])
def api_locations():
    c = _conn()
    if request.method == 'GET':
        return jsonify(_rows(c.execute('SELECT * FROM locations ORDER BY sort_order, name')))

    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    lid = body.get('id') or _slug(name)
    try:
        c.execute(
            'INSERT INTO locations (id,name,icon,color,sort_order,created_at) '
            'VALUES (?,?,?,?,?,?)',
            (lid, name,
             body.get('icon', 'mdi:food-variant'),
             body.get('color', '#4a90e2'),
             int(body.get('sort_order', 500)),
             _now()),
        )
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Location already exists'}), 409
    _sse_push('inventory', {'type': 'locations'})
    return jsonify(_row(c.execute('SELECT * FROM locations WHERE id=?', (lid,)).fetchone()))


@bp.route('/locations/<lid>', methods=['PATCH', 'DELETE'])
def api_location(lid):
    c = _conn()
    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields = []
        values: list[Any] = []
        for k in ('name', 'icon', 'color', 'sort_order'):
            if k in body:
                fields.append(f'{k}=?')
                values.append(body[k])
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        values.append(lid)
        c.execute(f'UPDATE locations SET {",".join(fields)} WHERE id=?', values)
        _sse_push('inventory', {'type': 'locations'})
        return jsonify(_row(c.execute('SELECT * FROM locations WHERE id=?', (lid,)).fetchone()))

    # DELETE — blocked if any inventory still references it
    in_use = c.execute('SELECT COUNT(*) FROM inventory WHERE location_id=?', (lid,)).fetchone()[0]
    if in_use:
        return jsonify({'error': f'{in_use} inventory item(s) still in this location'}), 409
    c.execute('DELETE FROM locations WHERE id=?', (lid,))
    _sse_push('inventory', {'type': 'locations'})
    return jsonify({'ok': True})


# ── Categories CRUD ───────────────────────────────────────────────────────────

@bp.route('/categories', methods=['GET', 'POST'])
def api_categories():
    c = _conn()
    if request.method == 'GET':
        return jsonify(_rows(c.execute('SELECT * FROM categories ORDER BY sort_order, name')))

    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    cid = body.get('id') or _slug(name)
    try:
        c.execute(
            'INSERT INTO categories (id,name,icon,color,sort_order,created_at) '
            'VALUES (?,?,?,?,?,?)',
            (cid, name,
             body.get('icon', 'mdi:tag'),
             body.get('color', '#888888'),
             int(body.get('sort_order', 500)),
             _now()),
        )
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Category already exists'}), 409
    _sse_push('inventory', {'type': 'categories'})
    return jsonify(_row(c.execute('SELECT * FROM categories WHERE id=?', (cid,)).fetchone()))


@bp.route('/categories/<cid>', methods=['PATCH', 'DELETE'])
def api_category(cid):
    c = _conn()
    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields = []
        values: list[Any] = []
        for k in ('name', 'icon', 'color', 'sort_order'):
            if k in body:
                fields.append(f'{k}=?')
                values.append(body[k])
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        values.append(cid)
        c.execute(f'UPDATE categories SET {",".join(fields)} WHERE id=?', values)
        _sse_push('inventory', {'type': 'categories'})
        return jsonify(_row(c.execute('SELECT * FROM categories WHERE id=?', (cid,)).fetchone()))

    c.execute('DELETE FROM categories WHERE id=?', (cid,))
    _sse_push('inventory', {'type': 'categories'})
    return jsonify({'ok': True})


# ── Stores CRUD ───────────────────────────────────────────────────────────────

@bp.route('/stores', methods=['GET', 'POST'])
def api_stores():
    c = _conn()
    if request.method == 'GET':
        return jsonify(_rows(c.execute('SELECT * FROM stores ORDER BY sort_order, name')))

    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    sid = body.get('id') or _slug(name)
    try:
        c.execute(
            'INSERT INTO stores (id,name,icon,color,sort_order,created_at) '
            'VALUES (?,?,?,?,?,?)',
            (sid, name,
             body.get('icon', 'mdi:store'),
             body.get('color', '#555555'),
             int(body.get('sort_order', 500)),
             _now()),
        )
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Store already exists'}), 409
    _sse_push('inventory', {'type': 'stores'})
    return jsonify(_row(c.execute('SELECT * FROM stores WHERE id=?', (sid,)).fetchone()))


@bp.route('/stores/<sid>', methods=['PATCH', 'DELETE'])
def api_store(sid):
    c = _conn()
    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields = []
        values: list[Any] = []
        for k in ('name', 'icon', 'color', 'sort_order'):
            if k in body:
                fields.append(f'{k}=?')
                values.append(body[k])
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        values.append(sid)
        c.execute(f'UPDATE stores SET {",".join(fields)} WHERE id=?', values)
        _sse_push('inventory', {'type': 'stores'})
        return jsonify(_row(c.execute('SELECT * FROM stores WHERE id=?', (sid,)).fetchone()))

    c.execute('DELETE FROM stores WHERE id=?', (sid,))
    _sse_push('inventory', {'type': 'stores'})
    return jsonify({'ok': True})


# ── Products CRUD ─────────────────────────────────────────────────────────────

def _product_row(c: sqlite3.Connection, pid: str) -> dict | None:
    return _row(c.execute('SELECT * FROM products WHERE id=?', (pid,)).fetchone())


@bp.route('/products', methods=['GET', 'POST'])
def api_products():
    c = _conn()
    if request.method == 'GET':
        q = (request.args.get('q') or '').strip()
        cat = request.args.get('category')
        sql = 'SELECT * FROM products'
        where = []
        args: list[Any] = []
        if q:
            where.append('(name LIKE ? OR brand LIKE ?)')
            args.extend([f'%{q}%', f'%{q}%'])
        if cat:
            where.append('category_id = ?')
            args.append(cat)
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        sql += ' ORDER BY name'
        return jsonify(_rows(c.execute(sql, args)))

    # POST — create
    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    pid = body.get('id') or _uid()
    now = _now()
    c.execute('''
        INSERT INTO products
          (id,name,brand,category_id,image_url,default_location_id,default_store_id,
           default_unit,min_threshold,typical_shelf_life_days,tracks_percent,notes,
           created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (
        pid, name, body.get('brand', ''),
        body.get('category_id'), body.get('image_url', ''),
        body.get('default_location_id'), body.get('default_store_id'),
        body.get('default_unit', 'count'),
        float(body.get('min_threshold', 1)),
        body.get('typical_shelf_life_days'),
        1 if body.get('tracks_percent') else 0,
        body.get('notes', ''),
        now, now,
    ))

    # Optional barcode linkage on create
    for bc in body.get('barcodes', []) or []:
        bc = re.sub(r'\D', '', str(bc))
        if bc:
            c.execute(
                'INSERT OR REPLACE INTO barcode_catalog '
                '(barcode,product_id,source,raw_data,cached_at) VALUES (?,?,?,?,?)',
                (bc, pid, 'manual', None, now),
            )

    _sse_push('inventory', {'type': 'products'})
    return jsonify(_product_row(c, pid))


@bp.route('/products/<pid>', methods=['GET', 'PATCH', 'DELETE'])
def api_product(pid):
    c = _conn()
    if request.method == 'GET':
        p = _product_row(c, pid)
        if not p:
            return jsonify({'error': 'Not found'}), 404
        # Include linked barcodes
        p['barcodes'] = [r['barcode'] for r in c.execute(
            'SELECT barcode FROM barcode_catalog WHERE product_id=?', (pid,))]
        return jsonify(p)

    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields: list[str] = []
        values: list[Any] = []
        for k in ('name', 'brand', 'category_id', 'image_url',
                  'default_location_id', 'default_store_id',
                  'default_unit', 'min_threshold',
                  'typical_shelf_life_days', 'tracks_percent', 'notes'):
            if k in body:
                fields.append(f'{k}=?')
                v = body[k]
                if k == 'tracks_percent':
                    v = 1 if v else 0
                values.append(v)
        if fields:
            fields.append('updated_at=?')
            values.append(_now())
            values.append(pid)
            c.execute(f'UPDATE products SET {",".join(fields)} WHERE id=?', values)

        # Barcode sync — full replace if `barcodes` provided
        if 'barcodes' in body:
            c.execute('DELETE FROM barcode_catalog WHERE product_id=?', (pid,))
            for bc in body.get('barcodes') or []:
                bc = re.sub(r'\D', '', str(bc))
                if bc:
                    c.execute(
                        'INSERT OR REPLACE INTO barcode_catalog '
                        '(barcode,product_id,source,raw_data,cached_at) VALUES (?,?,?,?,?)',
                        (bc, pid, 'manual', None, _now()),
                    )
        _sse_push('inventory', {'type': 'products'})
        return jsonify(_product_row(c, pid))

    # DELETE — cascades to inventory & barcode_catalog
    c.execute('DELETE FROM products WHERE id=?', (pid,))
    _sse_push('inventory', {'type': 'products'})
    return jsonify({'ok': True})


# ── Inventory CRUD ────────────────────────────────────────────────────────────

def _inv_with_product(c: sqlite3.Connection, where: str = '', args: tuple = ()) -> list[dict]:
    sql = '''
        SELECT
          i.*,
          p.name           AS product_name,
          p.brand          AS product_brand,
          p.image_url      AS product_image,
          p.category_id    AS product_category_id,
          p.min_threshold  AS product_min_threshold,
          p.tracks_percent AS product_tracks_percent
        FROM inventory i
        JOIN products  p ON p.id = i.product_id
    '''
    if where:
        sql += ' WHERE ' + where
    sql += ' ORDER BY p.name'
    out = _rows(c.execute(sql, args))
    for r in out:
        r['stock_status']  = _stock_status(r['current_qty'], r['product_min_threshold'] or 0)
        r['expiry_status'] = _expiry_status(r.get('expires_at'))
    return out


@bp.route('/items', methods=['GET', 'POST'])
def api_items():
    c = _conn()
    if request.method == 'GET':
        loc = request.args.get('location')
        if loc and loc != 'all':
            return jsonify(_inv_with_product(c, 'i.location_id=?', (loc,)))
        return jsonify(_inv_with_product(c))

    # POST — create new inventory entry
    body = request.get_json() or {}
    pid  = body.get('product_id')
    loc  = body.get('location_id')
    if not pid or not loc:
        return jsonify({'error': 'product_id and location_id are required'}), 400

    iid = _uid()
    now = _now()
    qty = float(body.get('current_qty', 1))
    c.execute('''
        INSERT INTO inventory
          (id,product_id,location_id,current_qty,unit,percent_remaining,
           purchased_at,expires_at,added_by,last_scanned_at,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (
        iid, pid, loc, qty,
        body.get('unit', 'count'),
        body.get('percent_remaining'),
        body.get('purchased_at'),
        body.get('expires_at'),
        body.get('added_by') or _person_id(),
        body.get('last_scanned_at'),
        body.get('notes', ''),
        now, now,
    ))
    _log_history(c, iid, pid, 'add', qty, qty, body.get('added_by') or _person_id(),
                 body.get('notes', ''))

    _auto_shopping_sync(c, pid)
    _sse_push('inventory', {'type': 'items'})
    return jsonify(_row(c.execute(
        'SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()))


@bp.route('/items/<iid>', methods=['GET', 'PATCH', 'DELETE'])
def api_item(iid):
    c = _conn()
    if request.method == 'GET':
        rows = _inv_with_product(c, 'i.id=?', (iid,))
        return jsonify(rows[0] if rows else None)

    row = c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields: list[str] = []
        values: list[Any] = []
        for k in ('product_id', 'location_id', 'current_qty', 'unit',
                  'percent_remaining', 'purchased_at', 'expires_at',
                  'last_scanned_at', 'notes'):
            if k in body:
                fields.append(f'{k}=?')
                values.append(body[k])
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        fields.append('updated_at=?')
        values.append(_now())
        values.append(iid)
        c.execute(f'UPDATE inventory SET {",".join(fields)} WHERE id=?', values)

        if 'current_qty' in body:
            new_q = float(body['current_qty'])
            delta = new_q - float(row['current_qty'])
            _log_history(c, iid, row['product_id'], 'adjust', delta, new_q, _person_id())
            _auto_shopping_sync(c, row['product_id'])

        _sse_push('inventory', {'type': 'items'})
        return jsonify(_row(c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()))

    # DELETE
    c.execute('DELETE FROM inventory WHERE id=?', (iid,))
    _log_history(c, iid, row['product_id'], 'delete',
                 -float(row['current_qty']), 0, _person_id())
    _auto_shopping_sync(c, row['product_id'])
    _sse_push('inventory', {'type': 'items'})
    return jsonify({'ok': True})


@bp.route('/items/<iid>/consume', methods=['POST'])
def api_item_consume(iid):
    return _adjust(iid, -abs(float((request.get_json() or {}).get('by', 1))), 'consume')


@bp.route('/items/<iid>/restock', methods=['POST'])
def api_item_restock(iid):
    return _adjust(iid, abs(float((request.get_json() or {}).get('by', 1))), 'restock')


def _adjust(iid: str, delta: float, action: str):
    c = _conn()
    row = c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    new_qty = max(0.0, float(row['current_qty']) + delta)
    c.execute(
        'UPDATE inventory SET current_qty=?, last_scanned_at=?, updated_at=? WHERE id=?',
        (new_qty, _now(), _now(), iid),
    )
    _log_history(c, iid, row['product_id'], action, delta, new_qty, _person_id())
    _auto_shopping_sync(c, row['product_id'])
    _sse_push('inventory', {'type': 'items'})
    return jsonify(_row(c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()))


@bp.route('/items/<iid>/percent', methods=['POST'])
def api_item_percent(iid):
    """Set percent_remaining for partial items (olive oil, etc.)."""
    body = request.get_json() or {}
    try:
        pct = max(0, min(100, int(body.get('percent', 0))))
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid percent'}), 400
    c = _conn()
    row = c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    c.execute(
        'UPDATE inventory SET percent_remaining=?, last_scanned_at=?, updated_at=? WHERE id=?',
        (pct, _now(), _now(), iid),
    )
    _log_history(c, iid, row['product_id'], 'adjust', 0, float(row['current_qty']),
                 _person_id(), notes=f'percent={pct}')
    _sse_push('inventory', {'type': 'items'})
    return jsonify(_row(c.execute('SELECT * FROM inventory WHERE id=?', (iid,)).fetchone()))


def _log_history(c: sqlite3.Connection, inv_id: str | None, pid: str,
                 action: str, delta: float, after: float,
                 person: str, notes: str = ''):
    c.execute('''
        INSERT INTO inventory_history
          (id,inventory_id,product_id,action,qty_delta,qty_after,person,notes,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
    ''', (_uid(), inv_id, pid, action, delta, after, person, notes, _now()))


# ── Stats (for dashboard cards) ───────────────────────────────────────────────

@bp.route('/stats')
def api_stats():
    c = _conn()
    total = c.execute('SELECT COUNT(*) FROM inventory').fetchone()[0]

    low = c.execute('''
        SELECT COUNT(*) FROM inventory i JOIN products p ON p.id = i.product_id
        WHERE i.current_qty > 0 AND i.current_qty < p.min_threshold
    ''').fetchone()[0]

    out = c.execute('''
        SELECT COUNT(*) FROM inventory WHERE current_qty <= 0
    ''').fetchone()[0]

    # Expiring within 7 days (and not already expired)
    now_iso = _now()
    exp_soon = c.execute('''
        SELECT COUNT(*) FROM inventory
        WHERE expires_at IS NOT NULL
          AND expires_at >= ?
          AND datetime(expires_at) <= datetime(?, '+7 days')
    ''', (now_iso, now_iso)).fetchone()[0]

    per_loc = _rows(c.execute('''
        SELECT l.id, l.name, l.color, COUNT(i.id) AS count
        FROM locations l
        LEFT JOIN inventory i ON i.location_id = l.id
        GROUP BY l.id
        ORDER BY l.sort_order, l.name
    '''))

    return jsonify({
        'total': total, 'low': low, 'out': out, 'expiring_soon': exp_soon,
        'per_location': per_loc,
    })


# ── History (for sparklines / detail panel) ───────────────────────────────────

@bp.route('/history/<pid>')
def api_history(pid):
    c = _conn()
    limit = min(int(request.args.get('limit', 50)), 500)
    return jsonify(_rows(c.execute(
        'SELECT * FROM inventory_history WHERE product_id=? '
        'ORDER BY created_at DESC LIMIT ?',
        (pid, limit),
    )))


# ── UPC Lookup (cascading) ────────────────────────────────────────────────────

_OFF_CAT_MAP = {
    'en:fruits': 'produce', 'en:vegetables': 'produce',
    'en:fresh-vegetables': 'produce', 'en:fresh-fruits': 'produce',
    'en:dairy': 'dairy', 'en:cheeses': 'dairy', 'en:milks': 'dairy',
    'en:yogurts': 'dairy', 'en:eggs': 'dairy',
    'en:meats': 'meat', 'en:seafood': 'meat', 'en:fish': 'meat',
    'en:poultry': 'meat',
    'en:breads': 'bakery', 'en:pastries': 'bakery',
    'en:biscuits-and-cakes': 'bakery',
    'en:frozen-foods': 'frozen', 'en:ice-creams': 'frozen',
    'en:beverages': 'beverages', 'en:sodas': 'beverages',
    'en:juices': 'beverages', 'en:waters': 'beverages',
    'en:coffees': 'beverages', 'en:teas': 'beverages',
    'en:snacks': 'snacks', 'en:chips-and-crisps': 'snacks',
    'en:candies': 'snacks',
    'en:cereals-and-their-products': 'breakfast',
    'en:pastas': 'pantry_s', 'en:rices': 'pantry_s',
    'en:sauces': 'condiments', 'en:condiments': 'condiments',
    'en:oils-and-fats': 'pantry_s', 'en:canned-foods': 'canned',
    'en:beauty-products': 'personal', 'en:hygiene-products': 'personal',
    'en:household-products': 'household',
    'en:cleaning-products': 'cleaning',
}

_NAME_KWORDS = {
    'produce':    ['apple','banana','orange','lettuce','tomato','pepper','onion',
                   'potato','carrot','fruit','vegetable','berry','grape','spinach','broccoli'],
    'dairy':      ['milk','cheese','yogurt','butter','cream','eggs','egg'],
    'meat':       ['chicken','beef','pork','turkey','salmon','tuna','shrimp',
                   'fish','steak','bacon','sausage'],
    'bakery':     ['bread','bagel','muffin','roll','tortilla','cake','biscuit'],
    'frozen':     ['frozen','ice cream','popsicle'],
    'beverages':  ['juice','soda','water','coffee','tea','drink','lemonade','gatorade'],
    'snacks':     ['chips','crackers','popcorn','candy','chocolate','pretzel'],
    'pantry_s':   ['pasta','rice','beans','flour','sugar','oil','oats'],
    'condiments': ['sauce','ketchup','mustard','mayo','dressing','syrup'],
    'canned':     ['soup','broth','canned'],
    'breakfast':  ['cereal','oatmeal','granola'],
    'personal':   ['shampoo','soap','lotion','toothpaste','deodorant','razor','shaving'],
    'cleaning':   ['detergent','cleaner','bleach','sponge'],
    'household':  ['paper towel','toilet paper'],
}


def _guess_category(tags: list, name: str) -> str:
    for tag in tags or []:
        if tag in _OFF_CAT_MAP:
            return _OFF_CAT_MAP[tag]
    name_l = (name or '').lower()
    for cat, kws in _NAME_KWORDS.items():
        if any(kw in name_l for kw in kws):
            return cat
    return 'other'


def _valid_barcode(bc: str) -> bool:
    return bool(re.fullmatch(r'\d{6,14}', bc))


def _lookup_off_db(host: str, barcode: str) -> tuple[dict | None, str]:
    """Query a single Open Food Facts–family database. Returns (normalized
    product dict | None, debug message). Never raises."""
    url = f'https://{host}/api/v0/product/{barcode}.json'
    try:
        r = requests.get(url, headers={'User-Agent': OFF_UA}, timeout=8)
        data = r.json()
        status = data.get('status')
        if status != 1 or 'product' not in data:
            return None, f'{r.status_code}: {data.get("status_verbose", "no match")}'
        p = data['product']
        name  = (p.get('product_name_en') or p.get('product_name') or '').strip()
        brand = (p.get('brands') or '').split(',')[0].strip()
        tags  = p.get('categories_tags', [])
        image = p.get('image_front_small_url') or p.get('image_url') or ''
        return {
            'name':  name,
            'brand': brand,
            'tags':  tags,
            'image': image,
            'raw':   p,
        }, f'{r.status_code}: hit'
    except Exception as e:
        return None, f'error: {type(e).__name__}: {e}'


def _lookup_upcitemdb(barcode: str) -> tuple[dict | None, str]:
    """UPCitemDB free tier — generic catch-all. Never raises."""
    try:
        r = requests.get(UPCITEMDB_URL.format(barcode),
                         headers={'User-Agent': OFF_UA}, timeout=8)
        data = r.json()
        items = data.get('items') or []
        if not items:
            msg = data.get('message') or 'no match'
            return None, f'{r.status_code}: {msg}'
        item = items[0]
        return {
            'name':  (item.get('title') or '').strip(),
            'brand': (item.get('brand') or '').strip(),
            'tags':  [item.get('category', '')] if item.get('category') else [],
            'image': (item.get('images') or [''])[0],
            'raw':   item,
        }, f'{r.status_code}: hit'
    except Exception as e:
        return None, f'error: {type(e).__name__}: {e}'


@bp.route('/scan/<barcode>')
def api_scan(barcode):
    """
    Cascading UPC lookup:
      1. Local barcode_catalog (instant cache)
      2. Open Food Facts databases in order:
         food → beauty → pet food → general products
      3. UPCitemDB free tier (catch-all)
      4. {found:false, tried:[…]} if every tier missed

    Pass ?debug=1 to include each tier's raw response in the result for
    troubleshooting.
    """
    debug = request.args.get('debug') == '1'

    if not _valid_barcode(barcode):
        return jsonify({'found': False, 'error': 'Invalid barcode'}), 400

    c = _conn()
    tried: list[dict] = []

    # ── Tier 1: local catalog ────────────────────────────────────────────────
    hit = c.execute('''
        SELECT p.*, b.source AS _source
        FROM barcode_catalog b
        JOIN products p ON p.id = b.product_id
        WHERE b.barcode = ?
    ''', (barcode,)).fetchone()
    if hit:
        p = dict(hit)
        return jsonify({
            'found':   True,
            'source':  'local',
            'barcode': barcode,
            'product': p,
        })
    tried.append({'tier': 'local', 'result': 'miss'})

    # ── Tier 2: Open Food Facts family ───────────────────────────────────────
    for short, host, label in OFF_DBS:
        normalized, msg = _lookup_off_db(host, barcode)
        tried.append({'tier': short, 'host': host, 'label': label, 'result': msg})
        if normalized and normalized['name']:
            return _cache_and_return(c, barcode, short, normalized, tried, debug)

    # ── Tier 3: UPCitemDB free tier ──────────────────────────────────────────
    normalized, msg = _lookup_upcitemdb(barcode)
    tried.append({'tier': 'upcitemdb', 'host': 'api.upcitemdb.com', 'result': msg})
    if normalized and normalized['name']:
        return _cache_and_return(c, barcode, 'upcitemdb', normalized, tried, debug)

    # ── All tiers missed ─────────────────────────────────────────────────────
    body = {'found': False, 'barcode': barcode, 'tried': [t['tier'] for t in tried]}
    if debug:
        body['debug'] = tried
    return jsonify(body)


def _cache_and_return(c, barcode: str, source: str, n: dict,
                      tried: list, debug: bool):
    """Persist a freshly-fetched product to local catalog and return the
    standard scan response shape."""
    cat = _guess_category(n.get('tags', []), n.get('name', ''))
    pid = _uid()
    now = _now()
    c.execute('''
        INSERT INTO products
          (id,name,brand,category_id,image_url,default_unit,
           min_threshold,tracks_percent,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    ''', (pid, n['name'] or f'Item {barcode}', n.get('brand', ''), cat,
          n.get('image', ''), 'count', 1, 0, now, now))
    c.execute('''
        INSERT OR REPLACE INTO barcode_catalog
          (barcode,product_id,source,raw_data,cached_at) VALUES (?,?,?,?,?)
    ''', (barcode, pid, source,
          json.dumps(n.get('raw', {}))[:50000], now))
    c.commit()

    body = {
        'found':   True,
        'source':  source,
        'barcode': barcode,
        'product': _product_row(c, pid),
    }
    if debug:
        body['debug'] = tried
    return jsonify(body)


@bp.route('/scan/link', methods=['POST'])
def api_scan_link():
    """Manually link a barcode to an existing product (for unknown-item flow)."""
    body = request.get_json() or {}
    bc   = re.sub(r'\D', '', str(body.get('barcode', '')))
    pid  = body.get('product_id')
    if not _valid_barcode(bc) or not pid:
        return jsonify({'error': 'barcode and product_id required'}), 400

    c = _conn()
    if not _product_row(c, pid):
        return jsonify({'error': 'Product not found'}), 404

    c.execute('''
        INSERT OR REPLACE INTO barcode_catalog
          (barcode,product_id,source,raw_data,cached_at) VALUES (?,?,?,?,?)
    ''', (bc, pid, 'manual', None, _now()))
    _sse_push('inventory', {'type': 'catalog'})
    return jsonify({'ok': True})


# ── Shopping List ─────────────────────────────────────────────────────────────

def _shopping_list_enriched(c: sqlite3.Connection) -> list[dict]:
    rows = _rows(c.execute('''
        SELECT s.*,
               p.name      AS product_name,
               p.image_url AS product_image,
               cat.name    AS category_name,
               cat.color   AS category_color,
               cat.sort_order AS category_sort,
               st.name     AS store_name,
               st.color    AS store_color
        FROM shopping_list s
        LEFT JOIN products   p   ON p.id   = s.product_id
        LEFT JOIN categories cat ON cat.id = s.category_id
        LEFT JOIN stores     st  ON st.id  = s.store_id
        ORDER BY s.status, cat.sort_order, s.name
    '''))
    return rows


@bp.route('/shopping', methods=['GET', 'POST'])
def api_shopping():
    c = _conn()
    if request.method == 'GET':
        store = request.args.get('store')
        if store and store != 'all':
            rows = _rows(c.execute('''
                SELECT s.*, p.name AS product_name, p.image_url AS product_image,
                       cat.name AS category_name, cat.color AS category_color,
                       cat.sort_order AS category_sort,
                       st.name AS store_name, st.color AS store_color
                FROM shopping_list s
                LEFT JOIN products   p   ON p.id   = s.product_id
                LEFT JOIN categories cat ON cat.id = s.category_id
                LEFT JOIN stores     st  ON st.id  = s.store_id
                WHERE s.store_id = ? OR s.store_id IS NULL
                ORDER BY s.status, cat.sort_order, s.name
            ''', (store,)))
            return jsonify(rows)
        return jsonify(_shopping_list_enriched(c))

    # POST — manual add
    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    if not name and not body.get('product_id'):
        return jsonify({'error': 'Name or product_id required'}), 400

    if body.get('product_id') and not name:
        p = _product_row(c, body['product_id'])
        name = p['name'] if p else ''

    sid = _uid()
    now = _now()
    c.execute('''
        INSERT INTO shopping_list
          (id,product_id,name,qty,unit,store_id,category_id,status,source,
           added_by,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (
        sid, body.get('product_id'), name,
        float(body.get('qty', 1)), body.get('unit', 'count'),
        body.get('store_id'), body.get('category_id'),
        body.get('status', 'needed'), 'manual',
        _person_id(), body.get('notes', ''), now, now,
    ))
    _sse_push('inventory', {'type': 'shopping'})
    return jsonify(_row(c.execute('SELECT * FROM shopping_list WHERE id=?', (sid,)).fetchone()))


@bp.route('/shopping/<sid>', methods=['PATCH', 'DELETE'])
def api_shopping_item(sid):
    c = _conn()
    if request.method == 'PATCH':
        body = request.get_json() or {}
        fields: list[str] = []
        values: list[Any] = []
        for k in ('name', 'qty', 'unit', 'store_id', 'category_id',
                  'status', 'notes'):
            if k in body:
                fields.append(f'{k}=?')
                values.append(body[k])
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        fields.append('updated_at=?')
        values.append(_now())
        values.append(sid)
        c.execute(f'UPDATE shopping_list SET {",".join(fields)} WHERE id=?', values)
        _sse_push('inventory', {'type': 'shopping'})
        return jsonify(_row(c.execute(
            'SELECT * FROM shopping_list WHERE id=?', (sid,)).fetchone()))

    c.execute('DELETE FROM shopping_list WHERE id=?', (sid,))
    _sse_push('inventory', {'type': 'shopping'})
    return jsonify({'ok': True})


def _auto_shopping_sync(c: sqlite3.Connection, pid: str):
    """
    After any inventory change, recalculate auto shopping state for this product.
      - total qty < min_threshold  → ensure an auto entry exists w/ correct qty
      - total qty ≥ min_threshold  → remove any auto entry
    Manual entries are never touched.
    """
    row = c.execute('''
        SELECT p.id, p.name, p.min_threshold, p.default_store_id, p.category_id,
               p.default_unit, p.image_url,
               COALESCE(SUM(i.current_qty), 0) AS total_qty
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id
        WHERE p.id = ?
        GROUP BY p.id
    ''', (pid,)).fetchone()
    if not row:
        return

    total     = float(row['total_qty'] or 0)
    threshold = float(row['min_threshold'] or 0)
    existing  = c.execute(
        'SELECT * FROM shopping_list WHERE product_id=? AND source=?',
        (pid, 'auto')).fetchone()

    if total < threshold:
        needed = max(1.0, threshold - total)
        if existing:
            c.execute('UPDATE shopping_list SET qty=?, updated_at=? WHERE id=?',
                      (needed, _now(), existing['id']))
        else:
            c.execute('''
                INSERT INTO shopping_list
                  (id,product_id,name,qty,unit,store_id,category_id,status,source,
                   notes,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (_uid(), pid, row['name'], needed,
                  row['default_unit'] or 'count',
                  row['default_store_id'], row['category_id'],
                  'needed', 'auto',
                  'Auto-added: below minimum threshold', _now(), _now()))
    else:
        if existing:
            c.execute('DELETE FROM shopping_list WHERE id=?', (existing['id'],))


# ── Registration hook (called from server.py) ────────────────────────────────

def init(app: Flask, sse_push: Callable[[str, dict], None]):
    """Wire the blueprint into the main Flask app and share the SSE broadcaster."""
    global _sse_push
    _sse_push = sse_push
    _init_db(app)
    app.register_blueprint(bp)
