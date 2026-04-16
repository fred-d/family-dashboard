/**
 * sse.js — Shared Server-Sent Events client.
 *
 * One persistent SSE connection is shared across all stores. When the backend
 * saves data it pushes an event here; each store subscribes to its event type
 * and re-fetches only what changed.
 *
 * Replaces the HA WebSocket pattern for app-data real-time sync.
 */

let _source = null;
const _handlers = new Map(); // eventName → Set<callback>
let   _reconnectDelay = 2000;

function _connect() {
    _source = new EventSource('./api/events');

    _source.addEventListener('connected', () => {
        console.info('[SSE] Connected to Family Dashboard backend.');
        _reconnectDelay = 2000;
    });

    // Forward all named events to registered handlers
    const forward = (name) => (e) => {
        const data = JSON.parse(e.data || '{}');
        _handlers.get(name)?.forEach(cb => { try { cb(data); } catch {} });
    };

    ['recipe', 'meals', 'grocery'].forEach(name => {
        _source.addEventListener(name, forward(name));
    });

    _source.onerror = () => {
        _source.close();
        _source = null;
        setTimeout(_connect, _reconnectDelay);
        _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000);
    };
}

/** Register a callback for a backend SSE event type. Returns unsubscribe fn. */
export function onSSE(eventName, callback) {
    if (!_source) _connect();
    if (!_handlers.has(eventName)) _handlers.set(eventName, new Set());
    _handlers.get(eventName).add(callback);
    return () => _handlers.get(eventName)?.delete(callback);
}
