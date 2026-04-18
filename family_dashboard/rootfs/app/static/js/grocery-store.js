/**
 * grocery-store.js — API-backed grocery list + pantry store.
 *
 * Shopping list + requests: /data/grocery/list.json
 * Pantry inventory:         /data/grocery/inventory.json
 * Photos:                   /data/photos/{timestamp}.jpg  (actual files)
 *
 * Real-time sync via SSE. localStorage used as read-through cache.
 */

import { onSSE } from './sse.js';
import { apiUrl } from './utils.js';

const CACHE_LIST      = 'fc_grocery_list';
const CACHE_INVENTORY = 'fc_grocery_inventory';

export class GroceryStore {
    constructor() {}

    // ── Cache ─────────────────────────────────────────────────────────────────

    loadCachedList() {
        try { return JSON.parse(localStorage.getItem(CACHE_LIST)) ?? { items: [], requests: [] }; }
        catch { return { items: [], requests: [] }; }
    }

    loadCachedInventory() {
        try { return JSON.parse(localStorage.getItem(CACHE_INVENTORY)) ?? []; }
        catch { return []; }
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    async fetchList() {
        try {
            const res  = await fetch(apiUrl('/api/grocery/list'));
            if (!res.ok) return null;
            const data = await res.json();
            localStorage.setItem(CACHE_LIST, JSON.stringify(data));
            return data;
        } catch (err) {
            console.warn('[GroceryStore] fetchList failed:', err.message);
            return null;
        }
    }

    async fetchInventory() {
        try {
            const res   = await fetch(apiUrl('/api/grocery/inventory'));
            if (!res.ok) return null;
            const items = await res.json();
            localStorage.setItem(CACHE_INVENTORY, JSON.stringify(items));
            return items;
        } catch (err) {
            console.warn('[GroceryStore] fetchInventory failed:', err.message);
            return null;
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    async saveList(items, requests) {
        const data = { items, requests };
        localStorage.setItem(CACHE_LIST, JSON.stringify(data));
        try {
            await fetch('./api/grocery/list', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(data),
            });
            return 'saved';
        } catch (err) {
            console.warn('[GroceryStore] saveList failed:', err.message);
            return 'cached';
        }
    }

    async saveInventory(items) {
        localStorage.setItem(CACHE_INVENTORY, JSON.stringify(items));
        try {
            await fetch('./api/grocery/inventory', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(items),
            });
            return 'saved';
        } catch (err) {
            console.warn('[GroceryStore] saveInventory failed:', err.message);
            return 'cached';
        }
    }

    // ── Photos ────────────────────────────────────────────────────────────────

    async uploadPhoto(file, maxPx = 400, quality = 0.82) {
        const blob = await _compressToBlob(file, maxPx, quality);
        const form = new FormData();
        form.append('photo', blob, 'photo.jpg');
        const res  = await fetch(apiUrl('/api/photos'), { method: 'POST', body: form });
        const data = await res.json();
        return data.url;
    }

    // ── Subscriptions ─────────────────────────────────────────────────────────

    subscribe(callback) {
        return onSSE('grocery', (evt) => callback({ type: evt.type, data: evt }));
    }
}

// ── Canvas compression helper ─────────────────────────────────────────────────

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
