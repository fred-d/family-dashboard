#!/usr/bin/env python3
"""
Family Dashboard — Local Frontend Dev Proxy
============================================
Serves the static files from your local checkout and forwards all /api/*
requests to your live HA instance.  No HA addon deploy needed for frontend
(JS/CSS/HTML) changes — just refresh the browser.

HTTPS / Camera access
---------------------
Browsers allow camera (getUserMedia) only on secure contexts:
  ✅  http://localhost:8099         — already secure, camera works
  ✅  https://localhost:8443        -- SSL mode, camera works anywhere
  ✅  https://192.168.x.x:8443     -- phone on same WiFi, camera works
  ❌  http://192.168.x.x:8099      -- NOT secure, camera blocked on phones

HTTP (default, desktop dev):
  python dev/proxy.py

HTTPS with a self-signed cert (phone / cross-device testing):
  python dev/proxy.py --https
  # first run generates dev/certs/cert.pem + key.pem — accept the
  # browser security warning once, or use mkcert for a trusted cert.

Usage
-----
1. Copy dev/.env.example → dev/.env and fill in HA_URL + HA_TOKEN
2. python dev/proxy.py [--https] [--port PORT]
3. Open http://localhost:8099  or  https://localhost:8443

Requirements
------------
  pip install flask requests python-dotenv
  # for HTTPS only (built into Python stdlib since 3.4 — no extra pip needed):
  # uses ssl module + a self-signed cert generated on first run
"""

import argparse
import os
import pathlib
import ssl
import subprocess
import sys
import requests
from flask import Flask, request, Response, send_from_directory

try:
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent / '.env')
except ImportError:
    pass

# ── Config ────────────────────────────────────────────────────────────────────

HA_URL    = os.environ.get('HA_URL',   'https://dashboard.fna3.net').rstrip('/')
HA_TOKEN  = os.environ.get('HA_TOKEN', '')
SKIP_AUTH = os.environ.get('SKIP_AUTH', '1') == '1'

DEV_DIR = pathlib.Path(__file__).parent
STATIC  = DEV_DIR.parent / 'family_dashboard' / 'rootfs' / 'app' / 'static'
CERTS   = DEV_DIR / 'certs'

if not STATIC.exists():
    print(f'[proxy] ERROR: static dir not found: {STATIC}')
    sys.exit(1)

# ── CLI args ──────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description='Family Dashboard local dev proxy')
parser.add_argument('--https', action='store_true', help='Enable HTTPS (required for camera on phones)')
parser.add_argument('--port',  type=int, default=None, help='Port (default: 8443 for HTTPS, 8099 for HTTP)')
args = parser.parse_args()

USE_HTTPS = args.https or os.environ.get('USE_HTTPS', '0') == '1'
PORT = args.port or int(os.environ.get('PORT', 8443 if USE_HTTPS else 8099))

# ── Self-signed cert generator ────────────────────────────────────────────────

def _ensure_cert():
    """Generate a self-signed cert for localhost + LAN IPs if none exists."""
    cert = CERTS / 'cert.pem'
    key  = CERTS / 'key.pem'
    if cert.exists() and key.exists():
        return cert, key

    CERTS.mkdir(exist_ok=True)
    try:
        # Try openssl (available on macOS, Linux, Git Bash on Windows)
        import socket
        lan_ip = socket.gethostbyname(socket.gethostname())
        san = f'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{lan_ip}'
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', str(key), '-out', str(cert),
            '-days', '365', '-nodes',
            '-subj', '/CN=localhost',
            '-addext', san,
        ], check=True, capture_output=True)
        print(f'[proxy] Generated self-signed cert (valid for localhost + {lan_ip})')
        print(f'[proxy] Cert: {cert}')
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback: Python's built-in (no SAN — localhost only)
        try:
            import tempfile
            import datetime
            from cryptography import x509
            from cryptography.x509.oid import NameOID
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
            import ipaddress

            priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
            import socket
            lan_ip = socket.gethostbyname(socket.gethostname())
            cert_obj = (
                x509.CertificateBuilder()
                .subject_name(name).issuer_name(name)
                .public_key(priv.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(datetime.datetime.utcnow())
                .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([
                    x509.DNSName('localhost'),
                    x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
                    x509.IPAddress(ipaddress.IPv4Address(lan_ip)),
                ]), critical=False)
                .sign(priv, hashes.SHA256())
            )
            key.write_bytes(priv.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            ))
            cert.write_bytes(cert_obj.public_bytes(serialization.Encoding.PEM))
            print(f'[proxy] Generated self-signed cert via cryptography lib')
        except ImportError:
            print('[proxy] ERROR: Cannot generate cert. Install openssl or run:')
            print('  pip install cryptography')
            sys.exit(1)

    return cert, key

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=str(STATIC), static_url_path='')


def _proxy(path):
    target  = f'{HA_URL}/api/{path}'
    headers = {k: v for k, v in request.headers
               if k.lower() not in ('host', 'content-length', 'transfer-encoding')}
    if HA_TOKEN:
        headers['X-Ha-Token'] = HA_TOKEN
    try:
        resp = requests.request(
            method  = request.method,
            url     = target,
            headers = headers,
            params  = request.args,
            data    = request.get_data(),
            stream  = True,
            timeout = 30,
        )
        excluded = {'content-encoding', 'content-length', 'transfer-encoding', 'connection'}
        resp_headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded]
        return Response(resp.iter_content(chunk_size=None),
                        status=resp.status_code, headers=resp_headers)
    except requests.exceptions.ConnectionError as e:
        return Response(f'{{"error":"proxy connection failed: {e}"}}',
                        status=502, content_type='application/json')


@app.route('/api/status')
def fake_status():
    if SKIP_AUTH:
        return {'authenticated': True, 'password_set': True}, 200
    return _proxy('status')


@app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
def api(path):
    return _proxy(path)


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def static_files(path):
    target = STATIC / path
    if path and target.exists() and target.is_file():
        return send_from_directory(str(STATIC), path)
    return send_from_directory(str(STATIC), 'index.html')


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import socket
    lan_ip = socket.gethostbyname(socket.gethostname())

    proto = 'https' if USE_HTTPS else 'http'
    print(f'[proxy] static:  {STATIC}')
    print(f'[proxy] API →    {HA_URL}')
    print(f'[proxy] auth bypass: {"YES" if SKIP_AUTH else "NO"}')
    print()
    print(f'  Desktop:  {proto}://localhost:{PORT}')
    if USE_HTTPS:
        print(f'  Phone:    {proto}://{lan_ip}:{PORT}')
        print()
        print('  ⚠  First visit: click "Advanced → Proceed" to accept the')
        print('     self-signed certificate. Camera will work after that.')
        print('  Tip: run  mkcert -install && mkcert localhost 127.0.0.1 {lan_ip}')
        print('       and copy the generated files to dev/certs/ for a trusted cert.')
    print()

    if USE_HTTPS:
        cert, key = _ensure_cert()
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(str(cert), str(key))
        app.run(host='0.0.0.0', port=PORT, debug=True,
                threaded=True, use_reloader=True, ssl_context=ssl_ctx)
    else:
        app.run(host='0.0.0.0', port=PORT, debug=True,
                threaded=True, use_reloader=True)
