"""
Family Dashboard — HA Addon Backend
====================================
Serves the static web app and provides a REST API for all persistent data.

Architecture
------------
- Static files:  /app/static/  → served at ./
- Data storage:  /data/        → persistent across HA restarts (addon volume)
  ├── recipes/  {slug}.json    — one file per recipe
  ├── recipe_index.json        — lightweight index (no photos)
  ├── meals/    {week}.json    — one file per ISO week (e.g. 2026-W15.json)
  ├── grocery/
  │   ├── list.json            — active shopping list + family requests
  │   └── inventory.json       — pantry / staples database
  └── photos/   {timestamp}.jpg — uploaded item/recipe photos (actual files!)

All HA communication uses $SUPERVISOR_TOKEN — frontend never needs a HA token.
Real-time sync between browser tabs/devices is via Server-Sent Events (SSE).
"""

import json
import os
import pathlib
import re
import threading
import time
import io

import requests
from flask import (Flask, Response, jsonify, request,
                   send_from_directory, stream_with_context)
from PIL import Image

# ── Configuration ──────────────────────────────────────────────────────────────

DATA     = pathlib.Path('/data')
STATIC   = pathlib.Path('/app/static')
PHOTOS   = DATA / 'photos'
RECIPES  = DATA / 'recipes'
MEALS    = DATA / 'meals'
GROCERY  = DATA / 'grocery'

HA_BASE  = 'http://supervisor/core'
HA_TOKEN = os.environ.get('SUPERVISOR_TOKEN', '')

MAX_PHOTO_PX   = 800   # Max dimension for stored photos
PHOTO_QUALITY  = 82    # JPEG quality (good balance of size vs quality)

# ── Flask app ──────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=str(STATIC), static_url_path='')

# ── SSE (Server-Sent Events) ───────────────────────────────────────────────────

_sse_clients: list[list] = []
_sse_lock = threading.Lock()


def _sse_push(event: str, data: dict):
    """Broadcast an SSE message to all connected clients."""
    message = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    with _sse_lock:
        for q in _sse_clients[:]:
            q.append(message)


@app.route('/api/events')
def sse_stream():
    """Server-Sent Events endpoint — one persistent connection per browser tab."""
    def generate():
        q: list[str] = []
        with _sse_lock:
            _sse_clients.append(q)
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                if q:
                    yield q.pop(0)
                else:
                    time.sleep(0.15)
                    yield ": keepalive\n\n"
        finally:
            with _sse_lock:
                if q in _sse_clients:
                    _sse_clients.remove(q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':    'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection':       'keep-alive',
        }
    )

# ── Helpers ────────────────────────────────────────────────────────────────────

def _ha(path: str, **kwargs):
    """Authenticated request to HA Supervisor API."""
    headers = {'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'}
    return requests.get(f'{HA_BASE}{path}', headers=headers, timeout=10, **kwargs)


def _read_json(fp: pathlib.Path, default):
    try:
        return json.loads(fp.read_text()) if fp.exists() else default
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(fp: pathlib.Path, data):
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(json.dumps(data, ensure_ascii=False))


def _valid_slug(s: str) -> bool:
    return bool(s) and bool(re.fullmatch(r'[a-z0-9_]+', s))


def _valid_week(w: str) -> bool:
    return bool(re.fullmatch(r'\d{4}-W\d{2}', w))


# ── Static files ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(STATIC, 'index.html')


# ── Config endpoint (frontend reads HA URL for calendar WebSocket) ─────────────

@app.route('/api/config')
def api_config():
    return jsonify({'version': '1.0.0'})


# ── Calendar (proxy to HA) ─────────────────────────────────────────────────────

@app.route('/api/calendars')
def api_calendars():
    """Return list of all calendar.* entities from HA."""
    try:
        r = _ha('/api/states')
        states = r.json()
        cals = [
            {
                'entity_id': s['entity_id'],
                'name': s['attributes'].get('friendly_name') or
                        s['entity_id'].replace('calendar.', '').replace('_', ' ').title()
            }
            for s in states
            if s['entity_id'].startswith('calendar.')
        ]
        return jsonify(cals)
    except Exception as e:
        app.logger.warning(f'[calendar] list failed: {e}')
        return jsonify([])


@app.route('/api/calendar/<path:entity_id>')
def api_calendar_events(entity_id):
    """Proxy calendar events for a specific entity."""
    start = request.args.get('start', '')
    end   = request.args.get('end',   '')
    try:
        r = _ha(f'/api/calendars/{entity_id}?start={start}&end={end}')
        return jsonify(r.json())
    except Exception as e:
        app.logger.warning(f'[calendar] events failed for {entity_id}: {e}')
        return jsonify([])


# ── Recipe API ────────────────────────────────────────────────────────────────

_recipe_lock = threading.Lock()

INDEX_FILE = DATA / 'recipe_index.json'


def _read_index() -> list:
    return _read_json(INDEX_FILE, [])


def _write_index(index: list):
    _write_json(INDEX_FILE, index)


@app.route('/api/recipes', methods=['GET'])
def api_recipes():
    return jsonify(_read_index())


@app.route('/api/recipes/<slug>', methods=['GET', 'POST', 'DELETE'])
def api_recipe(slug):
    if not _valid_slug(slug):
        return jsonify({'error': 'Invalid slug'}), 400

    fp = RECIPES / f'{slug}.json'

    if request.method == 'GET':
        if not fp.exists():
            return jsonify(None), 404
        return jsonify(_read_json(fp, None))

    elif request.method == 'POST':
        recipe = request.get_json()
        if not recipe:
            return jsonify({'error': 'No data'}), 400
        with _recipe_lock:
            _write_json(fp, recipe)
            # Update index (lightweight metadata only, no photo data)
            index = _read_index()
            meta = {
                'id':       recipe.get('id', slug),
                'name':     recipe.get('name', ''),
                'slug':     slug,
                'category': recipe.get('category', ''),
                'tags':     recipe.get('tags', []),
                'prepTime': recipe.get('prepTime', 0),
                'cookTime': recipe.get('cookTime', 0),
                'servings': recipe.get('servings', 0),
                'hasPhoto': bool(recipe.get('photo')),
            }
            pos = next((i for i, r in enumerate(index)
                        if r.get('slug') == slug or r.get('id') == meta['id']), -1)
            if pos >= 0:
                index[pos] = meta
            else:
                index.append(meta)
            _write_index(index)
        _sse_push('recipe', {'slug': slug, 'action': 'saved'})
        return jsonify({'ok': True})

    elif request.method == 'DELETE':
        with _recipe_lock:
            if fp.exists():
                fp.unlink()
            index = [r for r in _read_index() if r.get('slug') != slug]
            _write_index(index)
        _sse_push('recipe', {'slug': slug, 'action': 'deleted'})
        return jsonify({'ok': True})


# ── Meal Plan API ──────────────────────────────────────────────────────────────

_meals_lock = threading.Lock()


@app.route('/api/meals/<week>', methods=['GET', 'PATCH'])
def api_meals(week):
    if not _valid_week(week):
        return jsonify({'error': 'Invalid week format. Use YYYY-Www'}), 400

    fp = MEALS / f'{week}.json'

    if request.method == 'GET':
        return jsonify(_read_json(fp, {}))

    elif request.method == 'PATCH':
        body      = request.get_json() or {}
        day       = str(body.get('day', ''))
        meal_type = body.get('mealType', '')
        meal_data = body.get('data')   # None / falsy → clear the slot

        with _meals_lock:
            current = _read_json(fp, {})
            if meal_data:
                if day not in current:
                    current[day] = {}
                current[day][meal_type] = meal_data
            else:
                if day in current and meal_type in current[day]:
                    del current[day][meal_type]
                    if not current[day]:
                        del current[day]
            _write_json(fp, current)

        _sse_push('meals', {'week': week})
        return jsonify({'ok': True})


# ── Grocery API ────────────────────────────────────────────────────────────────

_grocery_lock = threading.Lock()

LIST_FILE  = GROCERY / 'list.json'
INV_FILE   = GROCERY / 'inventory.json'


@app.route('/api/grocery/list', methods=['GET', 'POST'])
def api_grocery_list():
    if request.method == 'GET':
        return jsonify(_read_json(LIST_FILE, {'items': [], 'requests': []}))
    with _grocery_lock:
        data = request.get_json() or {'items': [], 'requests': []}
        _write_json(LIST_FILE, data)
    _sse_push('grocery', {'type': 'list'})
    return jsonify({'ok': True})


@app.route('/api/grocery/inventory', methods=['GET', 'POST'])
def api_grocery_inventory():
    if request.method == 'GET':
        return jsonify(_read_json(INV_FILE, []))
    with _grocery_lock:
        data = request.get_json() or []
        _write_json(INV_FILE, data)
    _sse_push('grocery', {'type': 'inventory'})
    return jsonify({'ok': True})


# ── Photo API ─────────────────────────────────────────────────────────────────

@app.route('/api/photos', methods=['POST'])
def api_upload_photo():
    """
    Accept a photo upload and store it as an optimised JPEG file.
    Returns { "url": "./api/photos/{filename}" }

    Accepts:
    - multipart/form-data with field 'photo'  (from <input type=file>)
    - application/json  { "data": "data:image/...;base64,..." }  (canvas export)
    """
    PHOTOS.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time() * 1000)}.jpg"
    dest     = PHOTOS / filename

    try:
        if request.content_type and 'multipart' in request.content_type:
            file = request.files.get('photo')
            if not file:
                return jsonify({'error': 'No file'}), 400
            img = Image.open(file.stream)
        else:
            body     = request.get_json() or {}
            data_url = body.get('data', '')
            if ',' not in data_url:
                return jsonify({'error': 'Invalid data URL'}), 400
            import base64
            raw = base64.b64decode(data_url.split(',', 1)[1])
            img = Image.open(io.BytesIO(raw))

        # Convert to RGB (handles PNG with alpha, etc.)
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')

        # Resize to max dimension while keeping aspect ratio
        img.thumbnail((MAX_PHOTO_PX, MAX_PHOTO_PX), Image.LANCZOS)
        img.save(dest, 'JPEG', quality=PHOTO_QUALITY, optimize=True)

    except Exception as e:
        app.logger.error(f'[photo] upload failed: {e}')
        return jsonify({'error': str(e)}), 500

    return jsonify({'url': f'./api/photos/{filename}'})


@app.route('/api/photos/<filename>')
def api_serve_photo(filename):
    if not re.fullmatch(r'[\w\-]+\.jpg', filename):
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory(PHOTOS, filename)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    # Ensure all data directories exist on startup
    for d in (RECIPES, MEALS, GROCERY, PHOTOS):
        d.mkdir(parents=True, exist_ok=True)

    app.run(host='0.0.0.0', port=8099, threaded=True)
