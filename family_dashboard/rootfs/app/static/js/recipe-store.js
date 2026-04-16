/**
 * recipe-store.js — API-backed recipe store.
 *
 * Individual recipes: /data/recipes/{slug}.json
 * Index:             /data/recipe_index.json   (metadata only, no photo data)
 * Photos:            /data/photos/{timestamp}.jpg  (actual files, served as URLs)
 *
 * Real-time sync via SSE. localStorage used as read-through cache.
 */

import { onSSE } from './sse.js';

const CACHE_INDEX  = 'fc_recipe_index';
const CACHE_PREFIX = 'fc_recipe_';

export class RecipeStore {
    constructor() {}

    // ── Slug ──────────────────────────────────────────────────────────────────

    static slugify(name) {
        return String(name)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    // ── Index ─────────────────────────────────────────────────────────────────

    loadCachedIndex() {
        try { return JSON.parse(localStorage.getItem(CACHE_INDEX)) ?? []; }
        catch { return []; }
    }

    async fetchIndex() {
        try {
            const res = await fetch('./api/recipes');
            if (!res.ok) return null;
            const index = await res.json();
            localStorage.setItem(CACHE_INDEX, JSON.stringify(index));
            return index;
        } catch (err) {
            console.warn('[RecipeStore] fetchIndex failed:', err.message);
            return null;
        }
    }

    // ── Individual recipes ────────────────────────────────────────────────────

    loadCachedRecipe(slug) {
        try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + slug)) ?? null; }
        catch { return null; }
    }

    async fetchRecipe(slug) {
        try {
            const res = await fetch(`./api/recipes/${encodeURIComponent(slug)}`);
            if (!res.ok) return null;
            const recipe = await res.json();
            if (recipe) localStorage.setItem(CACHE_PREFIX + slug, JSON.stringify(recipe));
            return recipe;
        } catch (err) {
            console.warn('[RecipeStore] fetchRecipe failed:', err.message);
            return null;
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    async saveRecipe(recipe) {
        const slug = RecipeStore.slugify(recipe.name);
        const now  = new Date().toISOString();
        const full = { ...recipe, slug, updatedAt: now, createdAt: recipe.createdAt || now };

        localStorage.setItem(CACHE_PREFIX + slug, JSON.stringify(full));

        const res = await fetch(`./api/recipes/${encodeURIComponent(slug)}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(full),
        });
        if (!res.ok) throw new Error(`Save failed: ${res.status}`);

        // Refresh cached index
        await this.fetchIndex();
        return full;
    }

    async deleteRecipe(slug) {
        localStorage.removeItem(CACHE_PREFIX + slug);
        await fetch(`./api/recipes/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        await this.fetchIndex();
    }

    // ── Photos ────────────────────────────────────────────────────────────────

    /**
     * Compress a File/Blob in the browser then upload to backend.
     * Returns the permanent URL string (e.g. "./api/photos/1234567890.jpg").
     */
    async uploadPhoto(file, maxPx = 800, quality = 0.82) {
        const blob = await _compressToBlob(file, maxPx, quality);
        const form = new FormData();
        form.append('photo', blob, 'photo.jpg');
        const res  = await fetch('./api/photos', { method: 'POST', body: form });
        const data = await res.json();
        return data.url;
    }

    // ── Subscriptions ─────────────────────────────────────────────────────────

    subscribe(callback) {
        return onSSE('recipe', (evt) => callback(evt));
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
