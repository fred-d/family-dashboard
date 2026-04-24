#!/usr/bin/env python3
"""
Family Dashboard — Mock HA API Server
======================================
Fakes just enough of the HA REST API so the dashboard backend can run
entirely offline — no real HA instance needed.

Endpoints mocked:
  GET /api/states          → returns fake person + calendar entities
  GET /api/calendars       → returns a couple of fake calendars
  GET /api/calendars/<id>  → returns fake events for the current week

Usage
-----
  python dev/mock-ha.py          # starts on port 8088
  # then in dev/.env:
  HA_URL=http://localhost:8088

Requirements
------------
  pip install flask
"""

import json
from datetime import datetime, timedelta, timezone
from flask import Flask, jsonify, request

app = Flask(__name__)

# ── Fake data ─────────────────────────────────────────────────────────────────

FAKE_PERSONS = [
    {'entity_id': 'person.freddy',    'state': 'home',     'attributes': {'friendly_name': 'Freddy',    'entity_picture': ''}},
    {'entity_id': 'person.amy',       'state': 'home',     'attributes': {'friendly_name': 'Amy',       'entity_picture': ''}},
    {'entity_id': 'person.boy_one',   'state': 'not_home', 'attributes': {'friendly_name': 'Boy 1',     'entity_picture': ''}},
    {'entity_id': 'person.boy_two',   'state': 'not_home', 'attributes': {'friendly_name': 'Boy 2',     'entity_picture': ''}},
]

FAKE_CALENDARS = [
    {'entity_id': 'calendar.family',   'state': 'off', 'attributes': {'friendly_name': 'Family'}},
    {'entity_id': 'calendar.holidays', 'state': 'off', 'attributes': {'friendly_name': 'Holidays'}},
]

def _fake_events():
    now   = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    events = []
    for i, title in enumerate(['Doctor appt', 'Soccer practice', 'Family dinner', 'Grocery run']):
        start = today + timedelta(days=i, hours=10)
        end   = start + timedelta(hours=1)
        events.append({
            'summary':   title,
            'start':     {'dateTime': start.isoformat()},
            'end':       {'dateTime': end.isoformat()},
            'uid':       f'mock-{i}',
        })
    return events

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/api/states')
def states():
    return jsonify(FAKE_PERSONS + FAKE_CALENDARS)

@app.route('/api/states/<entity_id>')
def state(entity_id):
    for e in FAKE_PERSONS + FAKE_CALENDARS:
        if e['entity_id'] == entity_id:
            return jsonify(e)
    return jsonify({'error': 'not found'}), 404

@app.route('/api/calendars')
def calendars():
    return jsonify(FAKE_CALENDARS)

@app.route('/api/calendars/<path:cal_id>')
def calendar_events(cal_id):
    return jsonify(_fake_events())

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
def catch_all(path):
    print(f'[mock-ha] unhandled: {request.method} /{path}')
    return jsonify({'message': 'mock HA — endpoint not mocked', 'path': path}), 200

if __name__ == '__main__':
    print('[mock-ha] serving fake HA API on http://localhost:8088')
    print('[mock-ha] set HA_URL=http://localhost:8088 in dev/.env')
    app.run(host='0.0.0.0', port=8088, debug=True)
