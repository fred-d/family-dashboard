/**
 * inventory-store.js — Client-side state for the Kitchen Inventory system.
 *
 * Responsibilities
 *   • Fetch config (locations, categories, stores), items, stats, family.
 *   • Keep an in-memory cache so UI re-renders are instant.
 *   • Subscribe to SSE `inventory` events and re-fetch only the slice that
 *     changed (items / products / shopping / family …).
 *   • Broadcast changes to registered listeners so multiple UI components
 *     can subscribe without coupling to each other.
 *
 * API surface
 *   store.config                          Object with { locations, categories, stores }
 *   store.items                           Array of inventory rows (joined with product info)
 *   store.products                        Array of Product Master rows (loaded on demand)
 *   store.shopping                        Array of shopping list items
 *   store.family                          Array of person-roster entries
 *   store.stats                           Object: { total, low, out, expiring_soon, per_location }
 *   store.activePerson                    Currently-selected family member (for attribution)
 *
 *   store.load()                          Initial fetch of everything
 *   store.refresh(type)                   Re-fetch a specific slice
 *   store.on(event, cb)                   Subscribe to store events
 *     events: 'config' | 'items' | 'products' | 'shopping' | 'family' | 'stats' | 'activePerson'
 *
 *   store.consume(itemId, by)             POST /items/:id/consume
 *   store.restock(itemId, by)             POST /items/:id/restock
 *   store.setPercent(itemId, pct)         POST /items/:id/percent
 *   store.createProduct(data)
 *   store.updateProduct(id, patch)
 *   store.addInventory(data)
 *   store.updateItem(id, patch)
 *   store.deleteItem(id)
 *   store.scan(barcode)                   Cascading UPC lookup
 *   store.addShopping(data)
 *   store.updateShopping(id, patch)
 *   store.deleteShopping(id)
 *   store.setActivePerson(personId)       Persists to localStorage
 */

import { onSSE } from './sse.js';
import { apiUrl } from './utils.js';

const CACHE_CONFIG       = 'fc_inv_config';
const CACHE_ITEMS        = 'fc_inv_items';
const CACHE_SHOPPING     = 'fc_inv_shopping';
const CACHE_FAMILY       = 'fc_inv_family';
const CACHE_STATS        = 'fc_inv_stats';
const CACHE_ACTIVE_PERSON = 'fc_inv_active_person';

export class InventoryStore {
    constructor() {
        // ── In-memory state (hydrated from localStorage on construct) ────────
        this.config   = _load(CACHE_CONFIG,    { locations: [], categories: [], stores: [] });
        this.items    = _load(CACHE_ITEMS,     []).map(_normalizeItem);
        this.products = [];
        this.shopping = _load(CACHE_SHOPPING,  []);
        this.family   = _load(CACHE_FAMILY,    []);
        this.stats    = _load(CACHE_STATS,     { total: 0, low: 0, out: 0, expiring_soon: 0, per_location: [] });
        this.activePerson = _loadRaw(CACHE_ACTIVE_PERSON, null);

        this._listeners = new Map();   // event → Set<callback>

        // Wire SSE — re-fetch whichever slice changed
        onSSE('inventory', (evt) => this._onServerEvent(evt));
    }

    // ── Subscriptions ────────────────────────────────────────────────────────

    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(cb);
        return () => this._listeners.get(event)?.delete(cb);
    }

    _emit(event) {
        this._listeners.get(event)?.forEach(cb => {
            try { cb(this[event]); } catch (err) { console.error('[inv] listener error:', err); }
        });
    }

    // ── Initial load (call once at boot) ─────────────────────────────────────

    async load() {
        await Promise.all([
            this.refresh('config'),
            this.refresh('items'),
            this.refresh('shopping'),
            this.refresh('family'),
            this.refresh('stats'),
        ]);
    }

    async refresh(type) {
        switch (type) {
            case 'config':   return this._reload('config',   '/api/inventory/config');
            case 'items':    return this._reload('items',    '/api/inventory/items');
            case 'products': return this._reload('products', '/api/inventory/products');
            case 'shopping': return this._reload('shopping', '/api/inventory/shopping');
            case 'family':   return this._reload('family',   '/api/inventory/family');
            case 'stats':    return this._reload('stats',    '/api/inventory/stats');
        }
    }

    async _reload(key, path) {
        try {
            const res = await fetch(apiUrl(path));
            if (!res.ok) return;
            let data = await res.json();
            // Normalize joined inventory rows: backend uses product_* and
            // current_qty / percent_remaining / product_min_threshold; the UI
            // code was written against name / brand / image_url / qty_on_hand
            // / percent / low_qty_threshold. Alias rather than renaming the
            // backend so other consumers stay happy.
            if (key === 'items' && Array.isArray(data)) {
                data = data.map(_normalizeItem);
            }
            this[key] = data;
            _save(`fc_inv_${key}`, data);
            this._emit(key);
        } catch (err) {
            console.warn(`[inv] reload(${key}) failed:`, err.message);
        }
    }

    _onServerEvent(evt) {
        const t = evt?.type;
        // A single mutation can affect multiple slices — be generous about
        // what we re-fetch so counts stay in sync.
        if (!t) {
            this.refresh('items');
            this.refresh('stats');
            return;
        }
        if (t === 'items' || t === 'products' || t === 'catalog') {
            this.refresh('items'); this.refresh('stats'); this.refresh('shopping');
        }
        if (t === 'shopping')  this.refresh('shopping');
        if (t === 'locations') this.refresh('config');
        if (t === 'categories') this.refresh('config');
        if (t === 'stores')    this.refresh('config');
        if (t === 'family')    this.refresh('family');
    }

    // ── Active person (attribution) ──────────────────────────────────────────

    setActivePerson(personId) {
        this.activePerson = personId || null;
        if (personId) localStorage.setItem(CACHE_ACTIVE_PERSON, personId);
        else          localStorage.removeItem(CACHE_ACTIVE_PERSON);
        this._emit('activePerson');
    }

    _personHeaders() {
        return this.activePerson ? { 'X-Person-Id': this.activePerson } : {};
    }

    // ── Mutations ────────────────────────────────────────────────────────────

    async consume(itemId, by = 1) {
        return this._post(`/api/inventory/items/${itemId}/consume`, { by });
    }

    async restock(itemId, by = 1) {
        // by may be a number (units) or { by, packs } for pack-aware restock.
        const body = (typeof by === 'object' && by) ? by : { by };
        return this._post(`/api/inventory/items/${itemId}/restock`, body);
    }
    async restockPacks(itemId, packs = 1) {
        return this._post(`/api/inventory/items/${itemId}/restock`, { packs });
    }
    async needProduct(productId, body = {}) {
        return this._post(`/api/inventory/products/${productId}/need`, body);
    }
    async stockAllBought() {
        return this._post('/api/inventory/shopping/stock-all-bought', {});
    }

    async setPercent(itemId, percent) {
        return this._post(`/api/inventory/items/${itemId}/percent`, { percent });
    }

    async createProduct(data)         { return this._post('/api/inventory/products', data); }
    async updateProduct(id, patch)    { return this._patch(`/api/inventory/products/${id}`, patch); }
    async deleteProduct(id)           { return this._delete(`/api/inventory/products/${id}`); }

    async addInventory(data)          { return this._post('/api/inventory/items', data); }
    async updateItem(id, patch)       { return this._patch(`/api/inventory/items/${id}`, patch); }
    async deleteItem(id)              { return this._delete(`/api/inventory/items/${id}`); }

    async scan(barcode) {
        try {
            const res = await fetch(apiUrl(`/api/inventory/scan/${encodeURIComponent(barcode)}`));
            return await res.json();
        } catch (err) {
            console.warn('[inv] scan failed:', err.message);
            return { found: false, error: 'Lookup unavailable' };
        }
    }

    async addShopping(data)           { return this._post('/api/inventory/shopping', data); }
    async updateShopping(id, patch)   { return this._patch(`/api/inventory/shopping/${id}`, patch); }
    async deleteShopping(id)          { return this._delete(`/api/inventory/shopping/${id}`); }
    async stockShopping(id, body = {}){ return this._post(`/api/inventory/shopping/${id}/stock`, body); }

    async saveHiddenPersons(ids)      { return this._post('/api/inventory/family/hidden', { hidden: ids }); }

    // ── Reference data CRUD (locations / categories / stores) ────────────────

    async addLocation(data)           { return this._post('/api/inventory/locations', data); }
    async updateLocation(id, patch)   { return this._patch(`/api/inventory/locations/${id}`, patch); }
    async deleteLocation(id)          { return this._delete(`/api/inventory/locations/${id}`); }

    async addCategory(data)           { return this._post('/api/inventory/categories', data); }
    async updateCategory(id, patch)   { return this._patch(`/api/inventory/categories/${id}`, patch); }
    async deleteCategory(id)          { return this._delete(`/api/inventory/categories/${id}`); }

    async addStore(data)              { return this._post('/api/inventory/stores', data); }
    async updateStore(id, patch)      { return this._patch(`/api/inventory/stores/${id}`, patch); }
    async deleteStore(id)             { return this._delete(`/api/inventory/stores/${id}`); }

    // ── Generic-product flows ────────────────────────────────────────────────

    async linkBarcode(barcode, productId) {
        return this._post('/api/inventory/scan/link', { barcode, product_id: productId });
    }
    async mergeProducts(srcId, dstId) {
        return this._post(`/api/inventory/products/${srcId}/merge`, { into: dstId });
    }
    async loadProducts() {
        await this.refresh('products');
        return this.products;
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    async _post(path, body)   { return this._send('POST',   path, body); }
    async _patch(path, body)  { return this._send('PATCH',  path, body); }
    async _delete(path)       { return this._send('DELETE', path); }

    async _send(method, path, body) {
        try {
            const res = await fetch(apiUrl(path), {
                method,
                headers: { 'Content-Type': 'application/json', ...this._personHeaders() },
                body:    body ? JSON.stringify(body) : undefined,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`);
            return data;
        } catch (err) {
            console.warn(`[inv] ${method} ${path} failed:`, err.message);
            throw err;
        }
    }

    // ── Convenience lookups ──────────────────────────────────────────────────

    locationById(id)  { return this.config.locations.find(l => l.id === id); }
    categoryById(id)  { return this.config.categories.find(c => c.id === id); }
    storeById(id)     { return this.config.stores.find(s => s.id === id); }
    personById(id)    { return this.family.find(p => p.id === id); }

    itemsInLocation(locId) {
        if (!locId || locId === 'all') return this.items;
        return this.items.filter(i => i.location_id === locId);
    }

    countsByLocation() {
        const out = Object.fromEntries(this.config.locations.map(l => [l.id, 0]));
        this.items.forEach(i => {
            if (out[i.location_id] !== undefined) out[i.location_id] += 1;
        });
        return out;
    }
}

// ── localStorage helpers ─────────────────────────────────────────────────────

function _load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function _loadRaw(key, fallback) {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
}

function _save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota — ignore */ }
}

/**
 * Map an inventory row from the backend (joined with products) into the flat
 * shape the UI expects. Keeps the original fields too so anything that reads
 * the raw column name still works.
 */
function _normalizeItem(row) {
    if (!row || typeof row !== 'object') return row;
    const qty = Number(row.current_qty ?? row.qty_on_hand ?? 0);
    const pct = row.percent_remaining ?? row.percent ?? null;
    return {
        ...row,
        // Display fields pulled off the joined product
        name:       row.name       ?? row.product_name       ?? '',
        brand:      row.brand      ?? row.product_brand      ?? '',
        image_url:  row.image_url  ?? row.product_image      ?? '',
        category_id:row.category_id?? row.product_category_id?? null,
        // Quantity / threshold aliases
        qty_on_hand:        Number.isFinite(qty) ? qty : 0,
        low_qty_threshold:  Number(row.low_qty_threshold ?? row.product_min_threshold ?? 0) || 0,
        percent:            pct == null ? null : Number(pct),
        tracks_percent:     row.tracks_percent ?? row.product_tracks_percent ?? 0,
        units_per_pack:     Number(row.units_per_pack ?? row.product_units_per_pack ?? 1) || 1,
        count_unit:         row.count_unit ?? row.product_count_unit ?? 'item',
    };
}
