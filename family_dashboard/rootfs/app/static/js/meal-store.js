/**
 * meal-store.js — API-backed meal plan store.
 *
 * Data lives in /data/meals/{week}.json on the addon backend.
 * Real-time sync between devices is via SSE (see sse.js).
 * localStorage is used as a read-through cache for instant UI on load.
 */

import { onSSE } from './sse.js';
import { apiUrl } from './utils.js';


const CACHE_PREFIX = 'fc_meals_';

export class MealStore {
    constructor() {
        // No config needed — backend uses SUPERVISOR_TOKEN for HA
    }

    // ── Cache ─────────────────────────────────────────────────────────────────

    loadCached(isoWeek) {
        try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + isoWeek)) ?? {}; }
        catch { return {}; }
    }

    _localSave(isoWeek, meals) {
        try { localStorage.setItem(CACHE_PREFIX + isoWeek, JSON.stringify(meals)); }
        catch {}
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    /** Fetch week data from backend. Returns meals object or null on error. */
    async fetchFromHA(isoWeek) {
        try {
            const res = await fetch(apiUrl(`/api/meals/${encodeURIComponent(isoWeek)}`));
            if (!res.ok) return null;
            const meals = await res.json();
            this._localSave(isoWeek, meals);
            return meals;
        } catch (err) {
            console.warn('[MealStore] fetch failed:', err.message);
            return null;
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * Save a single meal slot.
     * @param {string}      isoWeek   e.g. "2026-W15"
     * @param {number}      dayIndex  0–6
     * @param {string}      mealType  "breakfast"|"lunch"|"dinner"
     * @param {object|null} data      meal object, or null/falsy to clear
     */
    async saveSlot(isoWeek, dayIndex, mealType, data) {
        // Optimistic local update
        const current = this.loadCached(isoWeek);
        if (data?.name) {
            if (!current[dayIndex]) current[dayIndex] = {};
            current[dayIndex][mealType] = data;
        } else {
            delete current[dayIndex]?.[mealType];
            if (current[dayIndex] && !Object.keys(current[dayIndex]).length)
                delete current[dayIndex];
        }
        this._localSave(isoWeek, current);

        // Persist to backend
        try {
            await fetch(apiUrl(`/api/meals/${encodeURIComponent(isoWeek)}`), {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ day: dayIndex, mealType, data: data?.name ? data : null }),
            });
            return 'saved';
        } catch (err) {
            console.warn('[MealStore] saveSlot failed:', err.message);
            return 'cached';
        }
    }

    // ── Subscriptions ─────────────────────────────────────────────────────────

    /**
     * Subscribe to live updates for a specific week via SSE.
     * Callback receives the updated meals object.
     * Returns an unsubscribe function.
     */
    subscribe(isoWeek, callback) {
        return onSSE('meals', async (evt) => {
            if (evt.week !== isoWeek) return;
            const fresh = await this.fetchFromHA(isoWeek);
            if (fresh) callback(fresh);
        });
    }
}
