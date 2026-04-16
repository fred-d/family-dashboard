/**
 * meals.js — MealPlanner UI.
 *
 * Sync strategy:
 *  • Renders instantly from localStorage cache.
 *  • Fetches fresh data from HA REST in the background; re-renders if changed.
 *  • Subscribes to MealStore's WebSocket feed — live-updates the grid whenever
 *    any other device saves a meal, without requiring a page refresh.
 *  • Saves go through MealStore.saveSlot() (read-before-write) to prevent
 *    concurrent overwrites.
 */
import { isoWeek, weekDates, formatWeekRange, isSameDay } from './utils.js';

const MEAL_TYPES  = ['breakfast', 'lunch', 'dinner'];
const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

// Category emoji map for recipe suggestions (mirrors recipes.js CATEGORIES)
const CAT_EMOJI = {
    breakfast: '🌅', lunch: '☀️', dinner: '🌙',
    snack: '🍎', dessert: '🍰', other: '🍴',
};

const POLL_INTERVAL = 8000;  // ms — fallback poll when WS misses an event

export class MealPlanner {
    constructor(containerEl, store) {
        this.container   = containerEl;
        this.store       = store;
        this.weekOffset  = 0;
        this._editTarget       = null;  // { dayIndex, mealType }
        this._weekData         = {};
        this._syncStatus       = 'idle';
        this._syncTimer        = null;
        this._unsub            = null;  // current week's WS unsubscribe fn
        this._pollTimer        = null;  // fallback polling timer
        this._linkedRecipeSlug = null;  // recipe linked in the open modal
        this._linkedRecipeName = null;
        this._generation       = 0;     // incremented on every _loadAndRender call

        this._bindModal();
        this._loadAndRender();
    }

    // ── Week helpers ──────────────────────────────────────────────────────────

    _currentDates() {
        const base = new Date();
        base.setDate(base.getDate() + this.weekOffset * 7);
        return weekDates(base);
    }

    _currentWeekKey() {
        return isoWeek(this._currentDates()[0]);
    }

    // ── Load / subscribe / render cycle ───────────────────────────────────────

    async _loadAndRender() {
        // Bump generation so any in-flight callbacks from a previous call become stale.
        const gen  = ++this._generation;
        const week = this._currentWeekKey();  // snapshot for subscribe / fetch

        // Tear down previous week's subscription and poll
        this._unsub?.();
        this._unsub = null;
        clearInterval(this._pollTimer);
        this._pollTimer = null;

        // 1. Instant render from cache
        this._weekData = this.store.loadCached(week);
        this._render();

        // 2. Subscribe to live WebSocket updates for this week
        this._unsub = this.store.subscribe(week, (freshMeals) => {
            if (this._generation !== gen) return;   // stale — a newer week is active
            this._weekData = freshMeals;
            this._render();
            this._flashSync();
        });

        // 3. Fetch latest from HA REST (may differ from cache)
        const fresh = await this.store.fetchFromHA(week);
        if (this._generation !== gen) return;       // navigated away while awaiting
        if (fresh !== null && JSON.stringify(fresh) !== JSON.stringify(this._weekData)) {
            this._weekData = fresh;
            this._render();
        }

        // 4. Polling fallback — catches any WS events that were missed
        //    (e.g. browser was backgrounded, WS reconnecting, HA briefly unreachable)
        this._pollTimer = setInterval(async () => {
            const polled = await this.store.fetchFromHA(week);
            if (this._generation !== gen) return;   // stale interval from old week
            if (polled !== null && JSON.stringify(polled) !== JSON.stringify(this._weekData)) {
                console.info('[MealPlanner] Poll detected remote change — updating.');
                this._weekData = polled;
                this._render();
                this._flashSync();
            }
        }, POLL_INTERVAL);
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _render() {
        // Always recompute from live weekOffset — never trust closure-captured dates.
        const dates = this._currentDates();
        const week  = isoWeek(dates[0]);
        const today = new Date();

        // Capture modal state so we can keep it open across re-renders
        const modalOpen   = document.getElementById('mealModalOverlay')?.classList.contains('active');
        const editTarget  = this._editTarget;

        this.container.innerHTML = `
            <div class="meals-header">
                <div class="meals-title">🍽️ Meal Planner</div>
                <div class="meals-week-nav">
                    ${this.weekOffset !== 0
                        ? '<button class="meals-today-btn" id="mealsTodayBtn">↩ This week</button>'
                        : ''}
                    <button class="meals-nav-btn" id="mealsPrev" title="Previous week">
                        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    </button>
                    <span class="meals-week-label">${formatWeekRange(dates)}</span>
                    <button class="meals-nav-btn" id="mealsNext" title="Next week">
                        <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </button>
                    <span class="meals-sync-badge" id="mealsSyncBadge" data-status="${this._syncStatus}">
                        ${this._syncBadgeHTML()}
                    </span>
                </div>
            </div>
            <div class="meals-grid" id="mealsGrid"></div>
        `;

        document.getElementById('mealsPrev').addEventListener('click', () => this._changeWeek(-1));
        document.getElementById('mealsNext').addEventListener('click', () => this._changeWeek(1));
        document.getElementById('mealsTodayBtn')?.addEventListener('click', () => {
            this.weekOffset = 0; this._loadAndRender();
        });

        const grid = document.getElementById('mealsGrid');
        dates.forEach((date, dayIndex) => {
            const dayData = this._weekData[dayIndex] || {};
            grid.appendChild(this._buildDayCard(date, dayIndex, dayData, isSameDay(date, today)));
        });
    }

    _changeWeek(delta) {
        this.weekOffset += delta;
        this._weekData = {};
        this._loadAndRender();
    }

    // ── Day card ──────────────────────────────────────────────────────────────

    _buildDayCard(date, dayIndex, dayData, isToday) {
        const card = document.createElement('div');
        card.className = `meal-day-card${isToday ? ' today' : ''}`;
        card.innerHTML = `
            <div class="meal-day-header">
                <span class="meal-day-name">${date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</span>
                <span class="meal-day-date">${date.getDate()}</span>
            </div>
            <div class="meal-slots">
                ${MEAL_TYPES.map(type => this._slotHTML(dayIndex, type, dayData[type])).join('')}
            </div>
        `;
        MEAL_TYPES.forEach(type => {
            card.querySelector(`[data-slot="${dayIndex}-${type}"]`)
                ?.addEventListener('click', (e) => {
                    // If clicking the recipe badge, open recipe detail instead of edit modal
                    const recipeBtn = e.target.closest('.meal-slot-recipe-link');
                    if (recipeBtn) {
                        e.stopPropagation();
                        const slug = recipeBtn.dataset.recipeSlug;
                        if (slug && window.recipeApp) {
                            window.recipeApp.openRecipeDetail(slug);
                        }
                        return;
                    }
                    this._openModal(dayIndex, type, dayData[type], date);
                });
        });
        return card;
    }

    _slotHTML(dayIndex, type, meal) {
        const hasMeal = !!meal?.name;
        const hasRecipe = hasMeal && !!meal.recipeSlug;
        return `
            <div class="meal-slot${hasMeal ? ' has-meal' : ''}" data-slot="${dayIndex}-${type}">
                <span class="meal-slot-label">${MEAL_LABELS[type]}</span>
                ${hasMeal
                    ? `<span class="meal-slot-name">${this._esc(meal.name)}</span>
                       ${meal.notes ? `<span class="meal-slot-notes">${this._esc(meal.notes)}</span>` : ''}
                       ${hasRecipe
                           ? `<button class="meal-slot-recipe-link" data-recipe-slug="${this._esc(meal.recipeSlug)}" title="View recipe">
                                  📖 View Recipe
                              </button>`
                           : ''}`
                    : `<span class="meal-slot-empty">+ Add</span>`
                }
                <span class="meal-slot-add">+</span>
            </div>`;
    }

    _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Sync badge ────────────────────────────────────────────────────────────

    _syncBadgeHTML() {
        return {
            idle:    '',
            saving:  '<span class="sync-dot saving"></span> Saving…',
            saved:   '<span class="sync-dot saved"></span> Synced',
            offline: '<span class="sync-dot offline"></span> Saved locally',
            live:    '<span class="sync-dot live"></span> Updated'
        }[this._syncStatus] ?? '';
    }

    _setSyncStatus(status, duration = 0) {
        this._syncStatus = status;
        clearTimeout(this._syncTimer);
        const badge = document.getElementById('mealsSyncBadge');
        if (badge) { badge.dataset.status = status; badge.innerHTML = this._syncBadgeHTML(); }
        if (duration > 0) {
            this._syncTimer = setTimeout(() => this._setSyncStatus('idle'), duration);
        }
    }

    /** Brief "Updated" flash when a live push arrives from another device. */
    _flashSync() {
        this._setSyncStatus('live', 2500);
    }

    // ── Modal ─────────────────────────────────────────────────────────────────

    _bindModal() {
        document.getElementById('mealModalOverlay')
            ?.addEventListener('click', e => { if (e.target === e.currentTarget) this._closeModal(); });
        document.getElementById('mealModalClose') ?.addEventListener('click', () => this._closeModal());
        document.getElementById('mealSaveBtn')    ?.addEventListener('click', () => this._saveMeal());
        document.getElementById('mealClearBtn')   ?.addEventListener('click', () => this._clearMeal());
        document.addEventListener('keydown', e => { if (e.key === 'Escape') this._closeModal(); });
    }

    _openModal(dayIndex, mealType, meal, date) {
        this._editTarget       = { dayIndex, mealType };
        this._linkedRecipeSlug = meal?.recipeSlug || null;
        this._linkedRecipeName = meal?.recipeName || null;

        document.getElementById('mealModalTitle').textContent    = MEAL_LABELS[mealType];
        document.getElementById('mealModalSubtitle').textContent =
            date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        document.getElementById('mealNameInput').value           = meal?.name  || '';
        document.getElementById('mealNotesInput').value          = meal?.notes || '';
        document.getElementById('mealClearBtn').style.display    = meal?.name ? 'block' : 'none';
        document.getElementById('mealModalOverlay').classList.add('active');

        // Attach recipe autocomplete (defer slightly so DOM is ready)
        setTimeout(() => {
            this._setupRecipeAutocomplete();
            document.getElementById('mealNameInput')?.focus();
        }, 50);
    }

    _closeModal() {
        document.getElementById('mealModalOverlay').classList.remove('active');
        this._editTarget       = null;
        this._linkedRecipeSlug = null;
        this._linkedRecipeName = null;
        const sug = document.getElementById('mealRecipeSuggestions');
        if (sug) sug.innerHTML = '';
        const link = document.getElementById('mealRecipeLink');
        if (link) link.innerHTML = '';
    }

    /** Wire recipe search suggestions into the meal name input. */
    _setupRecipeAutocomplete() {
        const nameInput = document.getElementById('mealNameInput');
        if (!nameInput) return;

        // Create suggestion container once
        if (!document.getElementById('mealRecipeSuggestions')) {
            const sug = document.createElement('div');
            sug.id = 'mealRecipeSuggestions';
            sug.className = 'meal-recipe-suggestions';
            nameInput.parentNode.insertBefore(sug, nameInput.nextSibling);
        }

        // Create recipe-link indicator once
        if (!document.getElementById('mealRecipeLink')) {
            const link = document.createElement('div');
            link.id = 'mealRecipeLink';
            const sug = document.getElementById('mealRecipeSuggestions');
            sug.parentNode.insertBefore(link, sug.nextSibling);
        }

        // Render any pre-existing link
        this._renderRecipeLink();

        // Remove any old listener by replacing the node clone trick
        const fresh = nameInput.cloneNode(true);
        nameInput.parentNode.replaceChild(fresh, nameInput);

        fresh.addEventListener('input', () => {
            const q = fresh.value.trim().toLowerCase();
            // Typing clears the recipe link until they pick one from the list
            this._linkedRecipeSlug = null;
            this._linkedRecipeName = null;
            this._renderRecipeLink();
            this._showRecipeSuggestions(q);
        });

        // Re-bind save/clear buttons to the fresh node (for focus etc.)
        fresh.addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('mealSaveBtn')?.click();
        });
    }

    _showRecipeSuggestions(q) {
        const sug = document.getElementById('mealRecipeSuggestions');
        if (!sug) return;

        if (!q) { sug.innerHTML = ''; return; }

        const recipes = window.recipeApp?.store?.loadCachedIndex() ?? [];
        const matches = recipes
            .filter(r => r.name.toLowerCase().includes(q) || r.tags?.some(t => t.toLowerCase().includes(q)))
            .slice(0, 7);

        if (!matches.length) { sug.innerHTML = ''; return; }

        sug.innerHTML = matches.map(r => `
            <div class="meal-recipe-option" data-slug="${this._esc(r.slug)}" data-name="${this._esc(r.name)}">
                <span class="meal-recipe-option-emoji">${CAT_EMOJI[r.category] || '🍴'}</span>
                <div class="meal-recipe-option-info">
                    <span class="meal-recipe-option-name">${this._esc(r.name)}</span>
                    ${(r.prepTime || r.cookTime)
                        ? `<span class="meal-recipe-option-meta">⏱ ${(r.prepTime||0)+(r.cookTime||0)} min</span>`
                        : ''}
                </div>
            </div>`).join('');

        sug.querySelectorAll('.meal-recipe-option').forEach(opt => {
            opt.addEventListener('mousedown', e => {
                e.preventDefault(); // prevent blur on input
                const nameInput = document.getElementById('mealNameInput');
                if (nameInput) nameInput.value = opt.dataset.name;
                this._linkedRecipeSlug = opt.dataset.slug;
                this._linkedRecipeName = opt.dataset.name;
                sug.innerHTML = '';
                this._renderRecipeLink();
            });
        });
    }

    _renderRecipeLink() {
        const link = document.getElementById('mealRecipeLink');
        if (!link) return;
        if (this._linkedRecipeSlug) {
            link.innerHTML = `
                <div class="meal-recipe-linked">
                    <span class="meal-recipe-linked-icon">📖</span>
                    <span class="meal-recipe-linked-name">Linked: ${this._esc(this._linkedRecipeName || 'Recipe')}</span>
                    <button class="meal-recipe-unlink-btn" id="mealRecipeUnlink" title="Remove link">×</button>
                </div>`;
            document.getElementById('mealRecipeUnlink')?.addEventListener('click', () => {
                this._linkedRecipeSlug = null;
                this._linkedRecipeName = null;
                this._renderRecipeLink();
            });
        } else {
            link.innerHTML = '';
        }
    }

    async _saveMeal() {
        if (!this._editTarget) return;
        const { dayIndex, mealType } = this._editTarget;
        const name  = document.getElementById('mealNameInput').value.trim();
        const notes = document.getElementById('mealNotesInput').value.trim();
        const data  = name ? {
            name,
            notes,
            recipeSlug: this._linkedRecipeSlug || null,
            recipeName: this._linkedRecipeName || null,
        } : null;

        this._closeModal();
        this._setSyncStatus('saving');

        // Optimistically apply to local state for immediate visual feedback
        if (!this._weekData[dayIndex]) this._weekData[dayIndex] = {};
        if (data) {
            this._weekData[dayIndex][mealType] = data;
        } else {
            delete this._weekData[dayIndex][mealType];
            if (!Object.keys(this._weekData[dayIndex]).length) delete this._weekData[dayIndex];
        }
        this._render();

        const result = await this.store.saveSlot(this._currentWeekKey(), dayIndex, mealType, data);
        this._setSyncStatus(result === 'saved' ? 'saved' : 'offline', 3000);
    }

    async _clearMeal() {
        if (!this._editTarget) return;
        const { dayIndex, mealType } = this._editTarget;

        this._closeModal();
        this._setSyncStatus('saving');

        if (this._weekData[dayIndex]) {
            delete this._weekData[dayIndex][mealType];
            if (!Object.keys(this._weekData[dayIndex]).length) delete this._weekData[dayIndex];
        }
        this._render();

        const result = await this.store.saveSlot(this._currentWeekKey(), dayIndex, mealType, null);
        this._setSyncStatus(result === 'saved' ? 'saved' : 'offline', 3000);
    }
}
