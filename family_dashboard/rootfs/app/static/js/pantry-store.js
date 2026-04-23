/**
 * pantry-store.js — SQLite-backed Pantry data store.
 *
 * PR B: this is now a thin translation layer over the same /api/inventory/*
 * routes that the live InventoryApp/InventoryStore uses. It exposes data in
 * the old "grocery" shape that PantryApp (resurrected in PR A) was written
 * against, so PR C can switch the live app over with minimal UI rewiring.
 *
 *   Backend routes used (will be renamed to /api/pantry/* in PR D):
 *     GET    /api/inventory/config                  (categories, locations, stores)
 *     GET    /api/inventory/shopping                (joined shopping_list rows)
 *     POST   /api/inventory/shopping                (manual add)
 *     PATCH  /api/inventory/shopping/<sid>          (update fields)
 *     DELETE /api/inventory/shopping/<sid>
 *     GET    /api/inventory/items                   (joined inventory_items rows)
 *     POST   /api/inventory/items                   (add — requires product_id)
 *     PATCH  /api/inventory/items/<iid>
 *     DELETE /api/inventory/items/<iid>
 *     POST   /api/photos                            (multipart upload)
 *
 *   Real-time sync via the SSE 'inventory' channel; PantryStore re-emits
 *   the event as the legacy {type: 'list' | 'inventory'} signal that
 *   PantryApp's subscriber already understands.
 *
 * Shape translation (backend → grocery):
 *   shopping_list row → {id, name, qty, unit, category, checked, fulfillment,
 *                        notes, addedBy, source, productId, storeId, status}
 *   inventory_items row → {id, name, brand, category, stockLevel, qty,
 *                          unit, photo, upc, notes, locationId, productId,
 *                          isStaple, low}
 *
 * Open gaps (deferred to PR C):
 *   • `isStaple` — backend has no column yet (small migration in PR C)
 *   • `photo` on shopping items — backend has no column (uses product image)
 *   • `inventoryRef` link — backend uses product_id; surfaced as `productId`
 *   • Bulk `saveList()` / `saveInventory()` removed — PantryApp's _persist()
 *     calls will be rewritten to use the per-row mutation methods below.
 *
 * NOT WIRED YET: nothing imports this file on master. PR C swaps the app over.
 */

import { onSSE } from './sse.js';
import { apiUrl } from './utils.js';

const CACHE_LIST      = 'fc_pantry_list';
const CACHE_INVENTORY = 'fc_pantry_inventory';
const CACHE_CONFIG    = 'fc_pantry_config';

/**
 * Map old grocery `category` string ids → keyword/name fragments that should
 * match the user's backend category names. Used to translate IDs in both
 * directions when the user-facing category names follow the obvious labels.
 * If no backend category matches, items fall back to the 'other' bucket.
 */
const CATEGORY_NAME_HINTS = {
    produce:   ['produce', 'fruit', 'veg'],
    dairy:     ['dairy', 'egg'],
    meat:      ['meat', 'seafood', 'fish'],
    bakery:    ['bakery', 'bread'],
    frozen:    ['frozen'],
    pantry:    ['pantry', 'dry good', 'canned', 'shelf'],
    snacks:    ['snack'],
    beverages: ['beverage', 'drink'],
    personal:  ['personal', 'health', 'beauty'],
    household: ['household', 'cleaning', 'paper'],
    other:     ['other', 'misc'],
};

export class PantryStore {
    constructor() {
        // ── Config (loaded once at boot, refreshed on SSE catalog events) ────
        this.config = _load(CACHE_CONFIG, { categories: [], locations: [], stores: [] });

        // ── Listener registry: 'list' | 'inventory' | 'config' ───────────────
        this._listeners = new Map();
        // Internal handle returned by onSSE so callers can unsubscribe.
        this._sseUnsub = null;
    }

    // ── Cache (read-through for instant first paint) ─────────────────────────

    loadCachedList()      { return _load(CACHE_LIST,      { items: [] }); }
    loadCachedInventory() { return _load(CACHE_INVENTORY, []); }

    // ── Fetch ────────────────────────────────────────────────────────────────

    async fetchConfig() {
        try {
            const res = await fetch(apiUrl('/api/inventory/config'));
            if (!res.ok) return null;
            this.config = await res.json();
            _save(CACHE_CONFIG, this.config);
            this._emit('config');
            return this.config;
        } catch (err) {
            console.warn('[PantryStore] fetchConfig failed:', err.message);
            return null;
        }
    }

    async fetchList() {
        // Config powers category-name → grocery-id mapping, so make sure it's
        // primed at least once before the first translation.
        if (!this.config?.categories?.length) await this.fetchConfig();

        try {
            const res = await fetch(apiUrl('/api/inventory/shopping'));
            if (!res.ok) return null;
            const rows = await res.json();
            const items = rows.map(r => this._normalizeShoppingRow(r));
            const data  = { items };
            _save(CACHE_LIST, data);
            return data;
        } catch (err) {
            console.warn('[PantryStore] fetchList failed:', err.message);
            return null;
        }
    }

    async fetchInventory() {
        if (!this.config?.categories?.length) await this.fetchConfig();

        try {
            const res = await fetch(apiUrl('/api/inventory/items'));
            if (!res.ok) return null;
            const rows = await res.json();
            const items = rows.map(r => this._normalizeInventoryRow(r));
            _save(CACHE_INVENTORY, items);
            return items;
        } catch (err) {
            console.warn('[PantryStore] fetchInventory failed:', err.message);
            return null;
        }
    }

    // ── Shopping-list mutations (per-row; replaces saveList(items)) ──────────

    /**
     * Add a new shopping-list item. Accepts the old grocery shape; translates
     * to the backend payload (resolves category_id from string id when known).
     */
    async addItem(item) {
        const body = {
            name:        item.name,
            qty:         item.qty ?? 1,
            unit:        item.unit ?? 'count',
            category_id: this._categoryIdForGroceryId(item.category),
            status:      item.checked ? 'bought' : 'needed',
            fulfillment: item.fulfillment ?? 'curbside',
            notes:       item.notes ?? '',
            store_id:    item.storeId ?? null,
            added_by:    item.addedBy ?? null,
        };
        if (item.productId) body.product_id = item.productId;
        return this._send('POST', '/api/inventory/shopping', body);
    }

    /**
     * Update an existing shopping-list item. Accepts grocery-shape patch
     * fields and translates them. Pass `null` for fields that should be
     * cleared on the backend.
     */
    async updateItem(id, patch) {
        const body = {};
        if ('name'        in patch) body.name        = patch.name;
        if ('qty'         in patch) body.qty         = patch.qty;
        if ('unit'        in patch) body.unit        = patch.unit;
        if ('notes'       in patch) body.notes       = patch.notes;
        if ('fulfillment' in patch) body.fulfillment = patch.fulfillment;
        if ('storeId'     in patch) body.store_id    = patch.storeId;
        if ('checked'     in patch) body.status      = patch.checked ? 'bought' : 'needed';
        if ('status'      in patch) body.status      = patch.status;
        if ('category'    in patch) body.category_id = this._categoryIdForGroceryId(patch.category);
        if ('addedBy'     in patch) body.added_by    = patch.addedBy;
        return this._send('PATCH', `/api/inventory/shopping/${id}`, body);
    }

    async deleteItem(id) {
        return this._send('DELETE', `/api/inventory/shopping/${id}`);
    }

    /**
     * Convenience: clear everything currently checked off the list (the old
     * "Clear N done" button). Implemented as a fan-out of DELETEs since the
     * backend has no bulk endpoint. Caller should pass the IDs to clear
     * (it already knows them — avoids re-fetching).
     */
    async clearChecked(ids) {
        return Promise.all(ids.map(id => this.deleteItem(id)));
    }

    // ── Inventory mutations (per-row; replaces saveInventory(items)) ─────────

    /**
     * Add a pantry item. Backend requires a product_id, so the caller must
     * either pass one (`item.productId`) or first create a product via
     * /api/inventory/products. PR C will plumb this through the New Item
     * modal — for now this is a thin pass-through.
     */
    async addInventoryItem(item) {
        if (!item.productId) {
            throw new Error(
                '[PantryStore] addInventoryItem requires productId — ' +
                'create the product first via /api/inventory/products');
        }
        return this._send('POST', '/api/inventory/items', {
            product_id:  item.productId,
            location_id: item.locationId ?? null,
            current_qty: item.qty ?? 1,
            notes:       item.notes ?? '',
        });
    }

    async updateInventoryItem(id, patch) {
        const body = {};
        if ('qty'        in patch) body.current_qty       = patch.qty;
        if ('notes'      in patch) body.notes             = patch.notes;
        if ('locationId' in patch) body.location_id       = patch.locationId;
        if ('percent'    in patch) body.percent_remaining = patch.percent;
        return this._send('PATCH', `/api/inventory/items/${id}`, body);
    }

    async deleteInventoryItem(id) {
        return this._send('DELETE', `/api/inventory/items/${id}`);
    }

    // ── Photos (unchanged from grocery-store) ────────────────────────────────

    async uploadPhoto(file, maxPx = 400, quality = 0.82) {
        const blob = await _compressToBlob(file, maxPx, quality);
        const form = new FormData();
        form.append('photo', blob, 'photo.jpg');
        const res  = await fetch(apiUrl('/api/photos'), { method: 'POST', body: form });
        const data = await res.json();
        return data.url;
    }

    // ── Subscriptions ────────────────────────────────────────────────────────

    /**
     * Subscribe to live data changes. Callback receives `{type, data}` with
     * `type` in the legacy grocery vocabulary ('list' | 'inventory') so
     * PantryApp's existing dispatcher continues to work unchanged.
     */
    subscribe(callback) {
        // Register both as a legacy-style callback AND as an SSE listener so
        // we only spin up one onSSE() handle per store instance.
        const wrapped = (type) => callback({ type });
        this._addListener('list',      wrapped);
        this._addListener('inventory', wrapped);

        if (!this._sseUnsub) {
            this._sseUnsub = onSSE('inventory', (evt) => this._onServerEvent(evt));
        }

        return () => {
            this._removeListener('list',      wrapped);
            this._removeListener('inventory', wrapped);
        };
    }

    _onServerEvent(evt) {
        const t = evt?.type;
        // Map backend channel events → grocery vocabulary
        if (!t || t === 'shopping')                this._emit('list');
        if (!t || t === 'items' || t === 'products' || t === 'catalog')
            this._emit('inventory');
        if (t === 'categories' || t === 'stores' || t === 'locations') {
            this.fetchConfig();
            this._emit('inventory');
        }
    }

    _addListener(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(cb);
    }
    _removeListener(event, cb) {
        this._listeners.get(event)?.delete(cb);
    }
    _emit(event) {
        this._listeners.get(event)?.forEach(cb => {
            try { cb(event); } catch (err) { console.error('[PantryStore] listener:', err); }
        });
    }

    // ── HTTP helper ──────────────────────────────────────────────────────────

    async _send(method, path, body) {
        try {
            const res = await fetch(apiUrl(path), {
                method,
                headers: { 'Content-Type': 'application/json' },
                body:    body ? JSON.stringify(body) : undefined,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`);
            return data;
        } catch (err) {
            console.warn(`[PantryStore] ${method} ${path} failed:`, err.message);
            throw err;
        }
    }

    // ── Shape translation: backend rows → old grocery shape ──────────────────

    _normalizeShoppingRow(row) {
        if (!row) return row;
        return {
            id:          row.id,
            name:        row.name || row.product_name || '',
            qty:         Number(row.qty ?? 1),
            unit:        row.unit || 'count',
            category:    this._groceryIdForCategoryId(row.category_id, row.category_name),
            checked:     row.status === 'bought',
            status:      row.status,                   // raw, in case the UI wants tri-state
            fulfillment: row.fulfillment || 'curbside',
            notes:       row.notes || '',
            addedBy:     row.added_by || '',
            source:      row.source || 'manual',
            productId:   row.product_id || null,
            storeId:     row.store_id || null,
            photo:       row.product_image || '',     // shopping rows have no own photo
            createdAt:   row.created_at,
            updatedAt:   row.updated_at,
        };
    }

    _normalizeInventoryRow(row) {
        if (!row) return row;
        const qty       = Number(row.current_qty ?? 0);
        const threshold = Number(row.product_min_threshold ?? row.low_qty_threshold ?? 0);
        const stockLevel =
            qty <= 0                          ? 'out' :
            (threshold > 0 && qty <= threshold) ? 'low' :
                                                  'ok';
        return {
            id:          row.id,
            productId:   row.product_id || null,
            locationId:  row.location_id || null,
            name:        row.product_name || row.name || '',
            brand:       row.product_brand || '',
            category:    this._groceryIdForCategoryId(row.product_category_id),
            stockLevel,
            qty,
            unit:        row.product_count_unit || 'item',
            photo:       row.product_image || '',
            upc:         row.product_upc || row.upc || '',
            notes:       row.notes || '',
            // Not yet tracked by the backend — surface defaults so the UI
            // can render. PR C will add a small migration for is_staple.
            isStaple:    false,
            low:         threshold,
        };
    }

    // ── Category id translation ──────────────────────────────────────────────

    /**
     * Map a backend category row (UUID id) back to the old grocery string id
     * by inspecting its name. Falls back to 'other' when no match.
     */
    _groceryIdForCategoryId(categoryId, hintName = null) {
        if (!categoryId) return 'other';
        const cat  = this.config.categories.find(c => c.id === categoryId);
        const name = (cat?.name || hintName || '').toLowerCase();
        if (!name) return 'other';
        for (const [groceryId, hints] of Object.entries(CATEGORY_NAME_HINTS)) {
            if (hints.some(h => name.includes(h))) return groceryId;
        }
        return 'other';
    }

    /**
     * Map an old grocery string id ('produce', 'dairy', …) to a backend
     * category UUID by name match. Returns null when no backend category
     * matches — the row will be saved without a category_id.
     */
    _categoryIdForGroceryId(groceryId) {
        if (!groceryId) return null;
        const hints = CATEGORY_NAME_HINTS[groceryId] || [groceryId];
        const cat = this.config.categories.find(c => {
            const name = (c.name || '').toLowerCase();
            return hints.some(h => name.includes(h));
        });
        return cat?.id ?? null;
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

function _save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ── Canvas compression helper (unchanged from grocery-store.js) ──────────────

function _compressToBlob(file, maxPx, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new window.Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxPx || height > maxPx) {
                    if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
                    else                { width  = Math.round(width  * maxPx / height); height = maxPx; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
                    'image/jpeg', quality);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
