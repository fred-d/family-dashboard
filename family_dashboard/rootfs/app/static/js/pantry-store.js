/**
 * pantry-store.js — SQLite-backed Pantry data store.
 *
 * Thin translation layer over the SQLite-backed Pantry backend. Exposes
 * data in the old "pantry" shape that PantryApp was originally written
 * against, so the rest of the UI keeps working unchanged.
 *
 *   Backend routes used (renamed from /api/inventory/* in v1.6.0;
 *   the legacy prefix is still mounted as a back-compat alias):
 *     GET    /api/pantry/config                  (categories, locations, stores)
 *     GET    /api/pantry/shopping                (joined shopping_list rows)
 *     POST   /api/pantry/shopping                (manual add)
 *     PATCH  /api/pantry/shopping/<sid>          (update fields)
 *     DELETE /api/pantry/shopping/<sid>
 *     GET    /api/pantry/items                   (joined inventory_items rows)
 *     POST   /api/pantry/items                   (add — requires product_id)
 *     PATCH  /api/pantry/items/<iid>
 *     DELETE /api/pantry/items/<iid>
 *     POST   /api/photos                            (multipart upload)
 *
 *   Real-time sync via the SSE 'inventory' channel; PantryStore re-emits
 *   the event as the legacy {type: 'list' | 'inventory'} signal that
 *   PantryApp's subscriber already understands.
 *
 * Shape translation (backend → pantry):
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
 * Map old pantry `category` string ids → keyword/name fragments that should
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
            const res = await fetch(apiUrl('/api/pantry/config'));
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
        // Config powers category-name → pantry-id mapping, so make sure it's
        // primed at least once before the first translation.
        if (!this.config?.categories?.length) await this.fetchConfig();

        try {
            const res = await fetch(apiUrl('/api/pantry/shopping'));
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

    /**
     * Fetch the full product catalog — used for item-name autocomplete in the
     * Add Item modal and for the Catalog tab. Accepts an optional search string.
     * Returns raw product rows including barcode_count.
     */
    async fetchProducts(q = '') {
        try {
            const url = apiUrl('/api/pantry/products') + (q ? `?q=${encodeURIComponent(q)}` : '');
            const res = await fetch(url);
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.warn('[PantryStore] fetchProducts failed:', err.message);
            return null;
        }
    }

    /** Fetch a single product with its full barcodes array. */
    async fetchProduct(pid) {
        try {
            const res = await fetch(apiUrl(`/api/pantry/products/${pid}`));
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.warn('[PantryStore] fetchProduct failed:', err.message);
            return null;
        }
    }

    /** Create a new product in the catalog. */
    async createProduct(data) {
        return this._send('POST', '/api/pantry/products', data);
    }

    /** Update an existing product. */
    async updateProduct(pid, data) {
        return this._send('PATCH', `/api/pantry/products/${pid}`, data);
    }

    /** Delete a product and all its barcode links. */
    async deleteProduct(pid) {
        return this._send('DELETE', `/api/pantry/products/${pid}`);
    }

    /** Add a single barcode to a product. */
    async addBarcode(pid, barcode) {
        return this._send('POST', `/api/pantry/products/${pid}/barcodes`, { barcode });
    }

    /**
     * Link a scanned barcode to an existing product. Same effect as addBarcode
     * but goes through the dedicated /scan/link endpoint, which is the
     * canonical entry point for the resolver flow.
     */
    async linkBarcode(barcode, productId) {
        return this._send('POST', '/api/pantry/scan/link', {
            barcode,
            product_id: productId,
        });
    }

    /**
     * Create a catalog product from raw fields (third-party hint or hand-typed)
     * and link a barcode to it in the same call. Returns the new product row.
     *
     * Translates the pantry-shape input → backend payload, mirroring addItem().
     */
    async createProductWithBarcode({ name, brand, category, photo, barcode, notes }) {
        const body = {
            name,
            brand:       brand || '',
            category_id: this._categoryIdForPantryId(category),
            image_url:   photo || '',
            notes:       notes || '',
        };
        if (barcode) body.barcodes = [String(barcode)];
        return this._send('POST', '/api/pantry/products', body);
    }

    /** Remove a single barcode from a product. */
    async removeBarcode(pid, barcode) {
        return this._send('DELETE', `/api/pantry/products/${pid}/barcodes/${barcode}`);
    }

    /**
     * TEMPORARY — raw UPC analysis from all external sources.
     * Returns full payloads from Open Food Facts + UPCitemdb without saving.
     * This endpoint will be removed once the catalog is mature.
     */
    async upcRawLookup(barcode) {
        try {
            const res = await fetch(apiUrl(`/api/pantry/upc-raw/${encodeURIComponent(barcode)}`));
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.warn('[PantryStore] upcRawLookup failed:', err.message);
            return null;
        }
    }

    async fetchInventory() {
        if (!this.config?.categories?.length) await this.fetchConfig();

        try {
            const res = await fetch(apiUrl('/api/pantry/items'));
            if (!res.ok) return null;
            const rows = await res.json();
            const items = rows.map(r => this._normalizeInventoryRow(r));
            _save(CACHE_INVENTORY, items);
            // Cache for the productId lookup that updateInventoryItem(isStaple)
            // needs — avoids round-tripping the inventory list per toggle.
            this._inventory = items;
            return items;
        } catch (err) {
            console.warn('[PantryStore] fetchInventory failed:', err.message);
            return null;
        }
    }

    // ── Shopping-list mutations (per-row; replaces saveList(items)) ──────────

    /**
     * Add a new shopping-list item. Accepts the old pantry shape; translates
     * to the backend payload (resolves category_id from string id when known).
     */
    async addItem(item) {
        const body = {
            name:        item.name,
            qty:         item.qty ?? 1,
            unit:        item.unit ?? 'count',
            category_id: this._categoryIdForPantryId(item.category),
            status:      item.checked ? 'bought' : 'needed',
            fulfillment: item.fulfillment ?? 'unplanned',
            notes:       item.notes ?? '',
            store_id:    item.storeId  ?? null,
            added_by:    item.addedBy  ?? null,
            photo_url:   item.photo    ?? '',
        };
        if (item.productId) body.product_id = item.productId;
        return this._send('POST', '/api/pantry/shopping', body);
    }

    /**
     * Update an existing shopping-list item. Accepts pantry-shape patch
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
        if ('category'    in patch) body.category_id = this._categoryIdForPantryId(patch.category);
        if ('addedBy'     in patch) body.added_by    = patch.addedBy;
        if ('photo'       in patch) body.photo_url   = patch.photo ?? '';
        if ('orderStatus' in patch) body.order_status = patch.orderStatus ?? null;
        return this._send('PATCH', `/api/pantry/shopping/${id}`, body);
    }

    async deleteItem(id) {
        return this._send('DELETE', `/api/pantry/shopping/${id}`);
    }

    async putAway(items) {
        return this._send('POST', '/api/pantry/shopping/put-away', { items });
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
     * Create a product row. Required before adding an inventory item from
     * scratch (the inventory table is FK'd to products). Returns the new
     * product row including its server-assigned id.
     */
    async addProduct(product) {
        const body = {
            name:        product.name,
            brand:       product.brand ?? '',
            category_id: this._categoryIdForPantryId(product.category),
            image_url:   product.photo ?? '',
            notes:       product.notes ?? '',
            is_staple:   product.isStaple ? 1 : 0,
        };
        if (product.upc) body.barcodes = [String(product.upc)];
        return this._send('POST', '/api/pantry/products', body);
    }

    /**
     * Add an inventory row. Requires a product_id (use addProduct first if
     * adding from scratch). Defaults the location to the first configured
     * location when one isn't supplied.
     */
    async addInventoryItem(item) {
        if (!item.productId) {
            throw new Error(
                '[PantryStore] addInventoryItem requires productId — ' +
                'create the product first via addProduct()');
        }
        const locationId = item.locationId
            ?? this.config?.locations?.[0]?.id
            ?? null;
        return this._send('POST', '/api/pantry/items', {
            product_id:  item.productId,
            location_id: locationId,
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

        // is_staple lives on `products`, not `inventory`. Patch it via the
        // product endpoint when toggled. Resolve the productId from the
        // cached row so callers can keep using the inventory-row id.
        if ('isStaple' in patch) {
            const inv = (this._inventory || []).find(i => i.id === id);
            if (inv?.productId) {
                await this._send('PATCH', `/api/pantry/products/${inv.productId}`, {
                    is_staple: patch.isStaple ? 1 : 0,
                });
            }
        }

        if (Object.keys(body).length === 0) return null;
        return this._send('PATCH', `/api/pantry/items/${id}`, body);
    }

    async deleteInventoryItem(id) {
        return this._send('DELETE', `/api/pantry/items/${id}`);
    }

    // ── Photos (unchanged from pantry-store) ────────────────────────────────

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
     * `type` in the legacy pantry vocabulary ('list' | 'inventory') so
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
        // Map backend channel events → pantry vocabulary
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

    // ── Shape translation: backend rows → old pantry shape ──────────────────

    _normalizeShoppingRow(row) {
        if (!row) return row;
        return {
            id:          row.id,
            name:        row.name || row.product_name || '',
            qty:         Number(row.qty ?? 1),
            unit:        row.unit || 'count',
            category:    this._pantryIdForCategoryId(row.category_id, row.category_name),
            checked:     row.status === 'bought',
            status:      row.status,                   // raw, in case the UI wants tri-state
            fulfillment: row.fulfillment || 'unplanned',
            orderStatus: row.order_status || null,
            brand:       row.product_brand || '',
            notes:       row.notes || '',
            addedBy:     row.added_by || '',
            source:      row.source || 'manual',
            productId:   row.product_id || null,
            storeId:     row.store_id || null,
            storeName:   row.store_name || '',
            storeColor:  row.store_color || '',
            // resolved_photo = COALESCE(s.photo_url, p.image_url) from backend
            photo:       row.resolved_photo || row.product_image || row.photo_url || '',
            createdAt:   row.created_at,
            updatedAt:   row.updated_at,
        };
    }

    _normalizeInventoryRow(row) {
        if (!row) return row;
        const qty           = Number(row.current_qty ?? 0);
        const threshold     = Number(row.product_min_threshold ?? row.low_qty_threshold ?? 0);
        const unitsPer      = Math.max(1, Number(row.product_units_per_pack ?? 1));
        const tracksPercent = !!row.product_tracks_percent;
        const percent       = row.percent_remaining != null ? Number(row.percent_remaining) : null;
        const countUnit     = row.product_count_unit || 'item';

        // Derive canonical tracking type from product flags / sentinel unit name.
        // 'status'    → count_unit sentinel 'status'; qty 0/1/2 maps to out/low/ok
        // 'percent'   → tracks_percent=true; percent_remaining drives stockLevel
        // 'multipack' → units_per_pack > 1; qty = individual units, stepped by 1
        // 'count'     → default
        const trackType = countUnit === 'status' ? 'status'
                        : tracksPercent           ? 'percent'
                        : unitsPer > 1            ? 'multipack'
                        :                           'count';

        // Derive stock level
        const stockLevel =
            trackType === 'status'
                ? (qty <= 0 ? 'out' : qty === 1 ? 'low' : 'ok')
            : trackType === 'percent'
                ? (percent === null || percent <= 0           ? 'out'
                   : (threshold > 0 && percent <= threshold)  ? 'low'
                   :                                            'ok')
            : (qty <= 0                              ? 'out'
               : (threshold > 0 && qty <= threshold) ? 'low'
               :                                       'ok');

        return {
            id:           row.id,
            productId:    row.product_id || null,
            locationId:   row.location_id || null,
            name:         row.product_name || row.name || '',
            brand:        row.product_brand || '',
            category:     this._pantryIdForCategoryId(row.product_category_id),
            stockLevel,
            qty,
            unit:         countUnit,
            unitsPer,
            tracksPercent,
            percent,
            trackType,
            photo:        row.product_image || '',
            upc:          row.product_upc || row.upc || '',
            notes:        row.notes || '',
            isStaple:     !!row.product_is_staple,
            low:          threshold,
        };
    }

    // ── Category id translation ──────────────────────────────────────────────

    /**
     * Map a backend category row (UUID id) back to the old pantry string id
     * by inspecting its name. Falls back to 'other' when no match.
     */
    _pantryIdForCategoryId(categoryId, hintName = null) {
        if (!categoryId) return 'other';
        const cat  = this.config.categories.find(c => c.id === categoryId);
        const name = (cat?.name || hintName || '').toLowerCase();
        if (!name) return 'other';
        for (const [pantryId, hints] of Object.entries(CATEGORY_NAME_HINTS)) {
            if (hints.some(h => name.includes(h))) return pantryId;
        }
        return 'other';
    }

    /**
     * Map an old pantry string id ('produce', 'dairy', …) to a backend
     * category UUID by name match. Returns null when no backend category
     * matches — the row will be saved without a category_id.
     */
    _categoryIdForPantryId(pantryId) {
        if (!pantryId) return null;
        const hints = CATEGORY_NAME_HINTS[pantryId] || [pantryId];
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

// ── Canvas compression helper (unchanged from pantry-store.js) ──────────────

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
