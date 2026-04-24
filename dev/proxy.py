#!/usr/bin/env python3
"""
Family Dashboard — Local Frontend Dev Proxy
============================================
Serves the static files from your local checkout and forwards all /api/*
requests to your live HA instance.  No HA addon deploy needed for frontend
(JS/CSS/HTML) changes — just refresh the browser.

Usage
-----
1. Copy dev/.env.example → dev/.env and fill in HA_URL + HA_TOKEN
2. Run:  python dev/proxy.py
3. Open: http://localhost:8099

How it works
------------
  localhost:8099/*       → serves family_dashboard/rootfs/app/static/*
  localhost:8099/api/*   → proxied to $HA_URL (your live dashboard)

The proxy injects a session cookie spoof so the auth gate doesn't block you
(the live HA instance already manages real auth via the addon).  You can also
bypass the auth gate entirely by setting SKIP_AUTH=1 in dev/.env.

Requirements
------------
  pip install flask requests python-dotenv
"""

import os
import sys
import pathlib
import requests
from flask import Flask, request, Response, send_from_directory
try:
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent / '.env')
except ImportError:
    pass  # python-dotenv optional

# ── Config ────────────────────────────────────────────────────────────────────

HA_URL    = os.environ.get('HA_URL',    'https://dashboard.fna3.net').rstrip('/')
HA_TOKEN  = os.environ.get('HA_TOKEN',  '')   # HA long-lived access token (optional)
PORT      = int(os.environ.get('PORT',  8099))
SKIP_AUTH = os.environ.get('SKIP_AUTH', '1') == '1'

STATIC = pathlib.Path(__file__).parent.parent / 'family_dashboard' / 'rootfs' / 'app' / 'static'

if not STATIC.exists():
    print(f'[error] static dir not found: {STATIC}')
    sys.exit(1)

print(f'[proxy] serving static files from: {STATIC}')
print(f'[proxy] forwarding /api/* to:       {HA_URL}')
print(f'[proxy] auth bypass:                {"YES" if SKIP_AUTH else "NO"}')
print(f'[proxy] http://localhost:{PORT}')

# ── App ───────────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=str(STATIC), static_url_path='')


def _proxy(path):
    """Forward request to the live HA instance."""
    target = f'{HA_URL}/api/{path}'
    headers = {k: v for k, v in request.headers if k.lower() not in
               ('host', 'content-length', 'transfer-encoding')}
    if HA_TOKEN:
        headers['X-Ha-Token'] = HA_TOKEN
    try:
        resp = requests.request(
            method=request.method,
            url=target,
            headers=headers,
            params=request.args,
            data=request.get_data(),
            stream=True,
            timeout=30,
        )
        # Stream SSE responses transparently
        excluded = {'content-encoding', 'content-length', 'transfer-encoding', 'connection'}
        resp_headers = [(k, v) for k, v in resp.headers.items()
                        if k.lower() not in excluded]
        return Response(
            resp.iter_content(chunk_size=None),
            status=resp.status_code,
            headers=resp_headers,
        )
    except requests.exceptions.ConnectionError as e:
        return Response(f'{{"error": "proxy connection failed: {e}"}}', status=502,
                        content_type='application/json')


@app.route('/api/status')
def fake_status():
    """If SKIP_AUTH, make the auth gate think we're already logged in."""
    if SKIP_AUTH:
        return {'authenticated': True, 'password_set': True}, 200
    return _proxy('status')


@app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
def api(path):
    return _proxy(path)


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def static_files(path):
    """Serve static files; fall back to index.html for SPA routing."""
    target = STATIC / path
    if path and target.exists() and target.is_file():
        return send_from_directory(str(STATIC), path)
    return send_from_directory(str(STATIC), 'index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT, debug=True, threaded=True, use_reloader=True)
