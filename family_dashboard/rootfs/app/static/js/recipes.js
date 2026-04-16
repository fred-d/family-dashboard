/**
 * recipes.js — Recipe Book UI
 *
 * Views (all rendered inside #view-recipes or global overlays):
 *  Library      — searchable, filterable card grid
 *  Detail Modal — full recipe with ingredients + steps, cooking & meal-plan actions
 *  Cooking Mode — full-screen immersive step-by-step guide with timer
 *  Edit Form    — create / edit recipe with dynamic ingredient + step lists
 *  Meal Picker  — link recipe to a meal plan slot
 *
 * Addon version: photos uploaded via store.uploadPhoto() (multipart POST to
 * backend) instead of being stored as base64 data URLs.
 */
import { RecipeStore } from './recipe-store.js';
import { isoWeek, weekDates } from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = [
    { id: 'all',       label: 'All',       emoji: '📖', color: null },
    { id: 'breakfast', label: 'Breakfast',  emoji: '🌅', color: '#f59e0b' },
    { id: 'lunch',     label: 'Lunch',      emoji: '☀️',  color: '#10b981' },
    { id: 'dinner',    label: 'Dinner',     emoji: '🌙', color: '#3b82f6' },
    { id: 'snack',     label: 'Snacks',     emoji: '🍎', color: '#f97316' },
    { id: 'dessert',   label: 'Desserts',   emoji: '🍰', color: '#ec4899' },
    { id: 'other',     label: 'Other',      emoji: '🍴', color: '#6b7280' },
];

function generateId() {
    return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function catByid(id) {
    return CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

// ── RecipeApp ─────────────────────────────────────────────────────────────────

export class RecipeApp {
    constructor(containerEl, store) {
        this.container = containerEl;
        this.store     = store;

        // Library state
        this._index    = [];
        this._search   = '';
        this._category = 'all';

        // Edit state
        this._editRecipe      = null;   // null = new recipe
        this._editIngredients = [];
        this._editSteps       = [];

        // Cooking state
        this._cookRecipe   = null;
        this._checkedIng   = new Set();
        this._checkedSteps = new Set();
        this._stepTimers   = new Map(); // stepIdx -> { total, remaining, running, intervalId }

        // Edit photo state — URL string (from backend) or null
        this._editPhoto = null;

        // Meal picker state
        this._mealPickerRecipe = null;

        // Live subscription handle
        this._unsub = null;

        this._loadAndRender();
        this._subscribeToLiveUpdates();
        this._bindGlobalKeys();
    }

    destroy() {
        this._unsub?.();
        this._stepTimers.forEach(t => clearInterval(t.intervalId));
    }

    // ── Boot ──────────────────────────────────────────────────────────────────

    async _loadAndRender() {
        this._index = this.store.loadCachedIndex();
        this._renderLibrary();

        const fresh = await this.store.fetchIndex();
        if (fresh !== null && JSON.stringify(fresh) !== JSON.stringify(this._index)) {
            this._index = fresh;
            this._renderLibrary();
        }
    }

    _subscribeToLiveUpdates() {
        this._unsub = this.store.subscribe(({ type, data }) => {
            if (type === 'index') {
                this._index = data;
                this._renderLibrary();
            }
        });
    }

    _bindGlobalKeys() {
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (this._isOverlayActive('recipeCookingOverlay')) { this._closeCooking(); return; }
                if (this._isOverlayActive('recipeMealPickerOverlay')) { this._closeMealPicker(); return; }
                if (this._isOverlayActive('recipeEditOverlay'))   { this._closeEdit(); return; }
                if (this._isOverlayActive('recipeDetailOverlay')) { this._closeDetail(); return; }
            }
            if (this._isOverlayActive('recipeCookingOverlay')) {
                if (e.key === 'ArrowRight') this._cookingNext();
                if (e.key === 'ArrowLeft')  this._cookingPrev();
            }
        });
    }

    _isOverlayActive(id) {
        return document.getElementById(id)?.classList.contains('active');
    }

    // ── Library ───────────────────────────────────────────────────────────────

    _renderLibrary() {
        const filtered = this._filterRecipes(this._index);

        this.container.innerHTML = `
            <div class="recipes-page">
                <div class="recipes-header">
                    <div class="recipes-title">📖 Recipe Book</div>
                    <button class="recipe-add-btn" id="recipeAddBtn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        New Recipe
                    </button>
                </div>

                <div class="recipes-controls">
                    <div class="recipes-search">
                        <svg class="recipes-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input type="search" class="recipes-search-input" id="recipeSearch"
                               placeholder="Search recipes, ingredients, tags…"
                               value="${this._esc(this._search)}" autocomplete="off">
                    </div>
                    <div class="recipes-categories">
                        ${CATEGORIES.map(cat => `
                            <button class="recipe-cat-btn${this._category === cat.id ? ' active' : ''}"
                                    data-cat="${cat.id}">${cat.emoji} ${cat.label}</button>
                        `).join('')}
                    </div>
                </div>

                ${filtered.length === 0
                    ? this._emptyStateHTML()
                    : `<div class="recipes-grid">${filtered.map(r => this._cardHTML(r)).join('')}</div>`
                }
            </div>
        `;

        document.getElementById('recipeAddBtn')?.addEventListener('click', () => this._openEdit());

        document.getElementById('recipeSearch')?.addEventListener('input', e => {
            this._search = e.target.value;
            this._renderLibrary();
        });

        this.container.querySelectorAll('.recipe-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._category = btn.dataset.cat;
                this._renderLibrary();
            });
        });

        this.container.querySelectorAll('.recipe-card').forEach(card => {
            card.querySelector('.recipe-card-view')?.addEventListener('click', () =>
                this._openDetail(card.dataset.slug));
            card.querySelector('.recipe-card-cook')?.addEventListener('click', () =>
                this._openDetailForCooking(card.dataset.slug));
        });

        document.getElementById('recipeEmptyAdd')?.addEventListener('click', () => this._openEdit());
    }

    _filterRecipes(recipes) {
        const q = this._search.toLowerCase();
        return recipes.filter(r => {
            const matchCat = this._category === 'all' || r.category === this._category;
            const matchQ   = !q ||
                r.name.toLowerCase().includes(q) ||
                r.tags?.some(t => t.toLowerCase().includes(q)) ||
                r.category?.toLowerCase().includes(q);
            return matchCat && matchQ;
        });
    }

    _cardHTML(r) {
        const cat       = catByid(r.category);
        const totalTime = (r.prepTime || 0) + (r.cookTime || 0);
        const color     = cat.color || 'var(--theme-primary)';

        // Show photo from cache (loaded after first view or after save)
        const cached = r.hasPhoto ? this.store.loadCachedRecipe(r.slug) : null;
        const photo  = cached?.photo || null;

        return `
            <div class="recipe-card" data-slug="${this._esc(r.slug)}" data-id="${this._esc(r.id)}">
                <div class="recipe-card-top${photo ? ' has-photo' : ''}" style="--cat-color:${color}">
                    ${photo
                        ? `<img src="${photo}" class="recipe-card-photo" alt="${this._esc(r.name)}">
                           <div class="recipe-card-photo-badge">${cat.emoji} ${cat.label}</div>`
                        : `<span class="recipe-card-cat-emoji">${cat.emoji}</span>
                           <span class="recipe-card-cat-name">${cat.label}</span>`
                    }
                </div>
                <div class="recipe-card-body">
                    <div class="recipe-card-name">${this._esc(r.name)}</div>
                    <div class="recipe-card-meta">
                        ${totalTime ? `<span class="recipe-meta-item">⏱ ${totalTime}min</span>` : ''}
                        ${r.servings ? `<span class="recipe-meta-item">👥 ${r.servings} servings</span>` : ''}
                    </div>
                    ${r.tags?.length ? `
                        <div class="recipe-card-tags">
                            ${r.tags.slice(0, 3).map(t => `<span class="recipe-tag">${this._esc(t)}</span>`).join('')}
                        </div>` : ''}
                </div>
                <div class="recipe-card-actions">
                    <button class="recipe-card-view">View Recipe</button>
                    <button class="recipe-card-cook">🍳 Cook</button>
                </div>
            </div>`;
    }

    _emptyStateHTML() {
        const hasFilter = this._search || this._category !== 'all';
        return `
            <div class="recipes-empty">
                <div class="recipes-empty-icon">${hasFilter ? '🔍' : '📖'}</div>
                <div class="recipes-empty-title">${hasFilter ? 'No recipes found' : 'Your recipe book is empty'}</div>
                <div class="recipes-empty-text">
                    ${hasFilter
                        ? 'Try adjusting your search or selecting a different category.'
                        : 'Start building your family recipe collection. Add your first recipe to get started!'}
                </div>
                ${!hasFilter ? '<button class="recipe-add-btn" id="recipeEmptyAdd">+ Add First Recipe</button>' : ''}
            </div>`;
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    async _openDetail(slug) {
        const cached = this.store.loadCachedRecipe(slug);
        if (cached) this._showDetail(cached);
        else this._showDetailLoading(slug);

        const fresh = await this.store.fetchRecipe(slug);
        if (fresh) this._showDetail(fresh);
    }

    async _openDetailForCooking(slug) {
        const cached = this.store.loadCachedRecipe(slug) ??
                       await this.store.fetchRecipe(slug);
        if (cached) this._startCooking(cached);
    }

    _showDetailLoading(slug) {
        const overlay = document.getElementById('recipeDetailOverlay');
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="recipe-modal">
                <div class="recipe-modal-header" style="min-height:120px;">
                    <button class="recipe-modal-close" id="recipeDetailClose">×</button>
                    <div style="opacity:0.7;padding-top:40px;">Loading recipe…</div>
                </div>
            </div>`;
        overlay.classList.add('active');
        document.getElementById('recipeDetailClose')?.addEventListener('click', () => this._closeDetail());
    }

    _showDetail(recipe) {
        const overlay = document.getElementById('recipeDetailOverlay');
        if (!overlay) return;

        const cat       = catByid(recipe.category);
        const totalTime = (recipe.prepTime || 0) + (recipe.cookTime || 0);
        const steps     = recipe.steps || [];
        const ings      = recipe.ingredients || [];

        overlay.innerHTML = `
            <div class="recipe-modal" role="dialog" aria-modal="true">
                <div class="recipe-modal-header${recipe.photo ? ' has-photo' : ''}">
                    <button class="recipe-modal-close" id="recipeDetailClose">×</button>
                    ${recipe.photo
                        ? `<div class="recipe-modal-hero">
                               <img src="${recipe.photo}" class="recipe-modal-hero-img" alt="${this._esc(recipe.name)}">
                               <div class="recipe-modal-hero-overlay">
                                   <div class="recipe-modal-cat-badge hero">${cat.emoji} ${cat.label}</div>
                                   <div class="recipe-modal-name hero">${this._esc(recipe.name)}</div>
                                   ${recipe.description ? `<div class="recipe-modal-description hero">${this._esc(recipe.description)}</div>` : ''}
                               </div>
                           </div>`
                        : `<div class="recipe-modal-cat-badge">
                               ${cat.emoji} ${cat.label}
                           </div>
                           <div class="recipe-modal-name">${this._esc(recipe.name)}</div>
                           ${recipe.description ? `<div class="recipe-modal-description">${this._esc(recipe.description)}</div>` : ''}`
                    }
                    <div class="recipe-modal-stats">
                        ${recipe.prepTime ? `
                            <div class="recipe-stat">
                                <span class="recipe-stat-value">${recipe.prepTime}</span>
                                <span class="recipe-stat-label">Prep (min)</span>
                            </div>` : ''}
                        ${recipe.cookTime ? `
                            <div class="recipe-stat">
                                <span class="recipe-stat-value">${recipe.cookTime}</span>
                                <span class="recipe-stat-label">Cook (min)</span>
                            </div>` : ''}
                        ${totalTime ? `
                            <div class="recipe-stat">
                                <span class="recipe-stat-value">${totalTime}</span>
                                <span class="recipe-stat-label">Total (min)</span>
                            </div>` : ''}
                        ${recipe.servings ? `
                            <div class="recipe-stat">
                                <span class="recipe-stat-value">${recipe.servings}</span>
                                <span class="recipe-stat-label">Servings</span>
                            </div>` : ''}
                    </div>
                </div>

                <div class="recipe-modal-body">
                    <div class="recipe-ingredients-panel">
                        <div class="recipe-panel-title">Ingredients</div>
                        ${ings.length
                            ? ings.map(ing => `
                                <div class="recipe-ingredient-item">
                                    <span class="recipe-ingredient-amount">${this._esc(ing.amount || '')}</span>
                                    <span class="recipe-ingredient-unit">${this._esc(ing.unit || '')}</span>
                                    <span class="recipe-ingredient-name">
                                        ${this._esc(ing.name)}
                                        ${ing.notes ? `<span class="recipe-ingredient-notes"> — ${this._esc(ing.notes)}</span>` : ''}
                                    </span>
                                </div>`).join('')
                            : '<p style="color:var(--color-muted);font-size:14px;">No ingredients listed.</p>'
                        }
                    </div>

                    <div class="recipe-steps-panel">
                        <div class="recipe-panel-title">Instructions</div>
                        ${steps.length
                            ? steps.map((s, i) => `
                                <div class="recipe-step-item">
                                    <div class="recipe-step-num">${i + 1}</div>
                                    <div class="recipe-step-text">
                                        ${this._esc(s.text)}
                                        ${s.timerMinutes ? `
                                            <div class="recipe-step-timer">
                                                ⏱ ${s.timerMinutes} min
                                            </div>` : ''}
                                    </div>
                                </div>`).join('')
                            : '<p style="color:var(--color-muted);font-size:14px;">No instructions listed.</p>'
                        }
                    </div>
                </div>

                ${recipe.notes ? `
                <div class="recipe-notes-section">
                    <div class="recipe-notes-title">
                        <span>📝 Notes &amp; Tips</span>
                        <button class="recipe-notes-toggle" id="recipeNotesToggle" style="display:none">Show more</button>
                    </div>
                    <div class="recipe-notes-text" id="recipeNotesText">${this._esc(recipe.notes)}</div>
                </div>` : ''}

                <div class="recipe-modal-footer">
                    <button class="recipe-footer-btn primary" id="detailCookBtn">🍳 Start Cooking</button>
                    <button class="recipe-footer-btn secondary" id="detailMealBtn">📅 Add to Meal Plan</button>
                    <button class="recipe-footer-btn secondary" id="detailEditBtn">✏️ Edit</button>
                    <button class="recipe-footer-btn danger"   id="detailDeleteBtn">🗑</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        document.getElementById('recipeDetailClose')?.addEventListener('click', () => this._closeDetail());
        overlay.addEventListener('click', e => { if (e.target === overlay) this._closeDetail(); });

        document.getElementById('detailCookBtn')?.addEventListener('click', () => {
            this._closeDetail();
            this._startCooking(recipe);
        });
        document.getElementById('detailMealBtn')?.addEventListener('click', () => {
            this._closeDetail();
            this._openAddToMeal(recipe);
        });
        document.getElementById('detailEditBtn')?.addEventListener('click', () => {
            this._closeDetail();
            this._openEdit(recipe);
        });
        document.getElementById('detailDeleteBtn')?.addEventListener('click', () => {
            if (confirm(`Delete "${recipe.name}"? This cannot be undone.`)) {
                this._closeDetail();
                this._deleteRecipe(recipe.slug);
            }
        });

        const notesText   = document.getElementById('recipeNotesText');
        const notesToggle = document.getElementById('recipeNotesToggle');
        if (notesText && notesToggle) {
            requestAnimationFrame(() => {
                const lineH   = parseFloat(getComputedStyle(notesText).lineHeight) || 23.8;
                const maxH    = lineH * 4;
                if (notesText.scrollHeight > maxH + 4) {
                    notesText.classList.add('notes-collapsed');
                    notesToggle.style.display = 'inline';
                    notesToggle.addEventListener('click', () => {
                        const collapsed = notesText.classList.toggle('notes-collapsed');
                        notesToggle.textContent = collapsed ? 'Show more' : 'Show less';
                    });
                }
            });
        }
    }

    _closeDetail() {
        document.getElementById('recipeDetailOverlay')?.classList.remove('active');
    }

    // ── Cooking Mode ──────────────────────────────────────────────────────────

    _startCooking(recipe) {
        this._cookRecipe = recipe;
        this._checkedIng   = new Set();
        this._checkedSteps = new Set();
        this._stepTimers.forEach(t => clearInterval(t.intervalId));
        this._stepTimers   = new Map();
        this._renderCooking();
    }

    _renderCooking() {
        const overlay = document.getElementById('recipeCookingOverlay');
        if (!overlay) return;

        const recipe = this._cookRecipe;
        const steps  = recipe.steps || [];
        const ings   = recipe.ingredients || [];
        const total  = steps.length;
        const done   = this._checkedSteps.size;
        const pct    = total > 0 ? ((done / total) * 100).toFixed(1) : 0;

        overlay.innerHTML = `
            <div class="cooking-header">
                ${recipe.photo
                    ? `<div class="cooking-header-photo">
                           <img src="${recipe.photo}" alt="${this._esc(recipe.name)}" class="cooking-header-photo-img">
                       </div>`
                    : ''}
                <div class="cooking-header-left">
                    <div class="cooking-recipe-name">🍳 ${this._esc(recipe.name)}</div>
                    <div class="cooking-header-meta">
                        <span class="cooking-steps-done" id="cookingStepsDone">${done} of ${total} steps complete</span>
                        ${(recipe.prepTime || recipe.cookTime)
                            ? `<span class="cooking-time-chip">⏱ ${(recipe.prepTime||0)+(recipe.cookTime||0)} min</span>`
                            : ''}
                    </div>
                </div>
                <button class="cooking-close" id="cookingClose">×</button>
            </div>
            <div class="cooking-progress-bar">
                <div class="cooking-progress-fill" id="cookingProgressFill" style="width:${pct}%"></div>
            </div>

            <div class="cooking-body">

                <!-- Left: Ingredients + Notes -->
                <div class="cooking-ingredients-panel">
                    <div class="cooking-ing-title">Ingredients</div>
                    <div class="cooking-ing-list">
                        ${ings.map((ing, i) => `
                            <div class="cooking-ing-item${this._checkedIng.has(i) ? ' checked' : ''}" data-ing-idx="${i}">
                                <div class="cooking-ing-check">
                                    ${this._checkedIng.has(i)
                                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg>'
                                        : ''}
                                </div>
                                <span class="cooking-ing-amount">${this._esc(ing.amount||'')} ${this._esc(ing.unit||'')}</span>
                                <span class="cooking-ing-name">${this._esc(ing.name)}</span>
                            </div>`).join('')}
                    </div>
                    ${recipe.notes ? `
                        <div class="cooking-ing-title" style="margin-top:20px;">Notes &amp; Tips</div>
                        <div class="cooking-notes-text">${this._esc(recipe.notes)}</div>
                    ` : ''}
                </div>

                <!-- Right: ALL steps visible -->
                <div class="cooking-steps-all">
                    <div class="cooking-steps-header">
                        <span class="cooking-steps-heading">Instructions</span>
                        <span class="cooking-steps-hint">Tap any step to mark it done</span>
                    </div>
                    <div class="cooking-steps-list">
                        ${steps.map((step, i) => {
                            const isDone  = this._checkedSteps.has(i);
                            const timer   = this._stepTimers.get(i);
                            const timerSecs = timer?.remaining ?? (step.timerMinutes ? step.timerMinutes * 60 : 0);
                            return `
                            <div class="cooking-step-card${isDone ? ' done' : ''}" data-step-idx="${i}">
                                <div class="cooking-step-badge${isDone ? ' done' : ''}">
                                    ${isDone
                                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>'
                                        : `<span>${i + 1}</span>`}
                                </div>
                                <div class="cooking-step-content">
                                    <div class="cooking-step-body-text">${this._esc(step.text)}</div>
                                    ${step.timerMinutes ? `
                                        <div class="cooking-step-timer-row">
                                            <span class="cooking-step-timer-display" id="step-timer-display-${i}">
                                                ${this._formatTimer(timerSecs)}
                                            </span>
                                            <button class="cooking-step-timer-btn${timer?.running ? ' running' : ''}"
                                                    id="step-timer-btn-${i}"
                                                    data-step-idx="${i}"
                                                    data-minutes="${step.timerMinutes}">
                                                ${timer?.running ? '⏸ Pause' : (timer && timer.remaining < timer.total && timer.remaining > 0 ? '▶ Resume' : '▶ Start Timer')}
                                            </button>
                                        </div>` : ''}
                                </div>
                            </div>`;
                        }).join('')}

                        ${done === total && total > 0 ? `
                            <div class="cooking-all-done">
                                <div class="cooking-all-done-icon">🎉</div>
                                <div class="cooking-all-done-title">All done!</div>
                                <div class="cooking-all-done-text">Time to eat. Enjoy!</div>
                                <button class="recipe-footer-btn primary" id="cookingFinishBtn" style="margin-top:16px;">✓ Finish Cooking</button>
                            </div>` : ''}
                    </div>
                </div>
            </div>`;

        overlay.classList.add('active');

        document.getElementById('cookingClose')?.addEventListener('click', () => this._closeCooking());
        document.getElementById('cookingFinishBtn')?.addEventListener('click', () => this._closeCooking());

        overlay.querySelectorAll('.cooking-step-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.closest('.cooking-step-timer-btn')) return;
                const idx = parseInt(card.dataset.stepIdx);
                if (this._checkedSteps.has(idx)) this._checkedSteps.delete(idx);
                else this._checkedSteps.add(idx);
                this._updateCookingStep(card, idx);
            });
        });

        overlay.querySelectorAll('.cooking-ing-item').forEach(item => {
            item.addEventListener('click', () => {
                const i = parseInt(item.dataset.ingIdx);
                if (this._checkedIng.has(i)) this._checkedIng.delete(i);
                else this._checkedIng.add(i);
                item.classList.toggle('checked', this._checkedIng.has(i));
                const chk = item.querySelector('.cooking-ing-check');
                if (chk) chk.innerHTML = this._checkedIng.has(i)
                    ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg>'
                    : '';
            });
        });

        overlay.querySelectorAll('.cooking-step-timer-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const idx     = parseInt(btn.dataset.stepIdx);
                const minutes = parseInt(btn.dataset.minutes);
                const timer   = this._stepTimers.get(idx);
                if (timer?.running) this._stopStepTimer(idx);
                else                this._startStepTimer(idx, minutes);
            });
        });
    }

    _updateCookingStep(card, idx) {
        const isDone = this._checkedSteps.has(idx);
        card.classList.toggle('done', isDone);
        const badge = card.querySelector('.cooking-step-badge');
        if (badge) {
            badge.classList.toggle('done', isDone);
            badge.innerHTML = isDone
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>'
                : `<span>${idx + 1}</span>`;
        }
        const total = this._cookRecipe?.steps?.length ?? 1;
        const done  = this._checkedSteps.size;
        const pct   = (done / total) * 100;
        const fill  = document.getElementById('cookingProgressFill');
        const label = document.getElementById('cookingStepsDone');
        if (fill)  fill.style.width  = `${pct}%`;
        if (label) label.textContent = `${done} of ${total} steps complete`;
        if (done === total) this._renderCooking();
    }

    _closeCooking() {
        this._stepTimers.forEach(t => clearInterval(t.intervalId));
        this._stepTimers.clear();
        document.getElementById('recipeCookingOverlay')?.classList.remove('active');
    }

    // ── Per-step timers ───────────────────────────────────────────────────────

    _startStepTimer(stepIdx, minutes) {
        const existing  = this._stepTimers.get(stepIdx);
        const total     = minutes * 60;
        const remaining = (existing && existing.remaining > 0) ? existing.remaining : total;

        if (existing?.intervalId) clearInterval(existing.intervalId);

        const timer = { total, remaining, running: true, intervalId: null };
        timer.intervalId = setInterval(() => {
            timer.remaining = Math.max(0, timer.remaining - 1);
            this._updateStepTimerDisplay(stepIdx);
            if (timer.remaining <= 0) {
                clearInterval(timer.intervalId);
                timer.running = false;
                this._stepTimerDone(stepIdx);
            }
        }, 1000);
        this._stepTimers.set(stepIdx, timer);
        this._updateStepTimerDisplay(stepIdx);
    }

    _stopStepTimer(stepIdx) {
        const timer = this._stepTimers.get(stepIdx);
        if (!timer) return;
        clearInterval(timer.intervalId);
        timer.running = false;
        this._updateStepTimerDisplay(stepIdx);
    }

    _updateStepTimerDisplay(stepIdx) {
        const timer   = this._stepTimers.get(stepIdx);
        if (!timer) return;
        const display = document.getElementById(`step-timer-display-${stepIdx}`);
        const btn     = document.getElementById(`step-timer-btn-${stepIdx}`);
        if (display) display.textContent = this._formatTimer(timer.remaining);
        if (btn) {
            btn.textContent = timer.running ? '⏸ Pause'
                : (timer.remaining < timer.total && timer.remaining > 0 ? '▶ Resume' : '▶ Start Timer');
            btn.className = `cooking-step-timer-btn${timer.running ? ' running' : ''}`;
        }
    }

    _stepTimerDone(stepIdx) {
        const card = document.querySelector(`.cooking-step-card[data-step-idx="${stepIdx}"]`);
        if (card) {
            card.classList.add('timer-alert');
            setTimeout(() => card.classList.remove('timer-alert'), 4000);
        }
        const btn = document.getElementById(`step-timer-btn-${stepIdx}`);
        if (btn) { btn.textContent = '▶ Restart'; btn.className = 'cooking-step-timer-btn'; }
    }

    _formatTimer(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    // ── Edit Form ─────────────────────────────────────────────────────────────

    _openEdit(recipe = null) {
        this._editRecipe      = recipe ?? null;
        this._editPhoto       = recipe?.photo || null;
        this._editIngredients = recipe?.ingredients?.map(i => ({ ...i })) ??
                                [{ amount: '', unit: '', name: '', notes: '' }];
        this._editSteps       = recipe?.steps?.map(s => ({ ...s })) ??
                                [{ text: '', timerMinutes: 0 }];
        this._renderEdit();
    }

    _renderEdit() {
        const overlay = document.getElementById('recipeEditOverlay');
        if (!overlay) return;

        const r     = this._editRecipe;
        const isNew = !r;

        overlay.innerHTML = `
            <div class="recipe-edit-modal" role="dialog" aria-modal="true">
                <div class="recipe-edit-header">
                    <div class="recipe-edit-title">${isNew ? '✨ New Recipe' : `✏️ Edit: ${this._esc(r.name)}`}</div>
                    <button class="recipe-edit-close" id="recipeEditClose">×</button>
                </div>

                <div class="recipe-edit-body">
                    <!-- Dish Photo -->
                    <div class="recipe-edit-section">
                        <div class="recipe-edit-section-title">Dish Photo</div>
                        <div class="recipe-photo-upload" id="recipePhotoArea" tabindex="0" role="button" aria-label="Upload dish photo">
                            ${this._editPhoto
                                ? `<img src="${this._editPhoto}" class="recipe-photo-preview" alt="Dish photo">
                                   <div class="recipe-photo-overlay">
                                       <button class="recipe-photo-change-btn" id="recipePhotoChange">📷 Change photo</button>
                                       <button class="recipe-photo-remove-btn" id="recipePhotoRemove">🗑 Remove</button>
                                   </div>`
                                : `<div class="recipe-photo-placeholder">
                                       <div class="recipe-photo-placeholder-icon">📷</div>
                                       <div class="recipe-photo-placeholder-text">Click to upload a photo</div>
                                       <div class="recipe-photo-placeholder-hint">JPG · PNG · WEBP — auto-compressed on upload</div>
                                   </div>`
                            }
                        </div>
                        <input type="file" id="recipePhotoInput" accept="image/*" style="display:none">
                    </div>

                    <!-- Basic Info -->
                    <div class="recipe-edit-section">
                        <div class="recipe-edit-section-title">Basic Info</div>
                        <div class="recipe-field">
                            <label for="editRecipeName">Recipe Name *</label>
                            <input type="text" id="editRecipeName" placeholder="e.g. Grandma's Spaghetti"
                                   value="${this._esc(r?.name || '')}" autocomplete="off">
                        </div>
                        <div class="recipe-field">
                            <label for="editRecipeDescription">Description (optional)</label>
                            <textarea id="editRecipeDescription" rows="2"
                                      placeholder="A short description of the dish…">${this._esc(r?.description || '')}</textarea>
                        </div>
                        <div class="recipe-field-row">
                            <div class="recipe-field">
                                <label for="editRecipeCategory">Category</label>
                                <select id="editRecipeCategory">
                                    ${CATEGORIES.filter(c => c.id !== 'all').map(cat =>
                                        `<option value="${cat.id}" ${r?.category === cat.id ? 'selected' : ''}>
                                            ${cat.emoji} ${cat.label}
                                        </option>`).join('')}
                                </select>
                            </div>
                            <div class="recipe-field">
                                <label for="editRecipeServings">Servings</label>
                                <input type="number" id="editRecipeServings" min="1" max="99"
                                       placeholder="4" value="${r?.servings || ''}">
                            </div>
                        </div>
                        <div class="recipe-field-row">
                            <div class="recipe-field">
                                <label for="editRecipePrepTime">Prep Time (min)</label>
                                <input type="number" id="editRecipePrepTime" min="0"
                                       placeholder="15" value="${r?.prepTime || ''}">
                            </div>
                            <div class="recipe-field">
                                <label for="editRecipeCookTime">Cook Time (min)</label>
                                <input type="number" id="editRecipeCookTime" min="0"
                                       placeholder="30" value="${r?.cookTime || ''}">
                            </div>
                        </div>
                        <div class="recipe-field">
                            <label for="editRecipeTags">Tags (comma-separated)</label>
                            <input type="text" id="editRecipeTags"
                                   placeholder="e.g. italian, family-favorite, quick"
                                   value="${this._esc((r?.tags || []).join(', '))}">
                        </div>
                        <div class="recipe-field">
                            <label for="editRecipeNotes">Notes &amp; Tips (optional)</label>
                            <textarea id="editRecipeNotes" rows="4"
                                      placeholder="Storage tips, substitutions, serving suggestions, make-ahead instructions…">${this._esc(r?.notes || '')}</textarea>
                        </div>
                    </div>

                    <!-- Ingredients -->
                    <div class="recipe-edit-section">
                        <div class="recipe-edit-section-title">Ingredients</div>
                        <div class="recipe-ing-header-row">
                            <span style="font-size:11px;color:var(--color-muted);font-weight:600;grid-column:1">Amount</span>
                            <span style="font-size:11px;color:var(--color-muted);font-weight:600;grid-column:2">Unit</span>
                            <span style="font-size:11px;color:var(--color-muted);font-weight:600;grid-column:3">Ingredient</span>
                            <span style="font-size:11px;color:var(--color-muted);font-weight:600;grid-column:4">Notes</span>
                        </div>
                        <div id="recipeEditIngredients"></div>
                        <button class="recipe-add-row-btn" id="recipeAddIngredient">
                            + Add Ingredient
                        </button>
                    </div>

                    <!-- Steps -->
                    <div class="recipe-edit-section">
                        <div class="recipe-edit-section-title">Instructions</div>
                        <div id="recipeEditSteps"></div>
                        <button class="recipe-add-row-btn" id="recipeAddStep">
                            + Add Step
                        </button>
                    </div>
                </div>

                <div class="recipe-edit-footer">
                    <button class="recipe-footer-btn primary" id="recipeEditSave">
                        ${isNew ? 'Create Recipe' : 'Save Changes'}
                    </button>
                    <button class="recipe-footer-btn secondary" id="recipeEditCancel">Cancel</button>
                    ${!isNew ? `<button class="recipe-footer-btn danger" id="recipeEditDelete">Delete</button>` : ''}
                </div>
            </div>`;

        overlay.classList.add('active');

        this._renderEditIngredients();
        this._renderEditSteps();
        this._bindPhotoUpload();

        document.getElementById('recipeEditClose')  ?.addEventListener('click', () => this._closeEdit());
        document.getElementById('recipeEditCancel') ?.addEventListener('click', () => this._closeEdit());
        document.getElementById('recipeAddIngredient')?.addEventListener('click', () => this._addIngredient());
        document.getElementById('recipeAddStep')    ?.addEventListener('click', () => this._addStep());
        document.getElementById('recipeEditSave')   ?.addEventListener('click', () => this._saveRecipe());
        document.getElementById('recipeEditDelete') ?.addEventListener('click', () => {
            if (confirm(`Delete "${this._editRecipe?.name}"?`)) {
                this._deleteRecipe(this._editRecipe.slug);
                this._closeEdit();
            }
        });

        overlay.addEventListener('click', e => { if (e.target === overlay) this._closeEdit(); });

        if (isNew) setTimeout(() => document.getElementById('editRecipeName')?.focus(), 50);
    }

    // ── Photo upload (addon version) ──────────────────────────────────────────
    // Files are compressed in the browser by RecipeStore.uploadPhoto() and
    // sent to the backend as multipart/form-data. The backend saves the JPEG
    // and returns a URL like "./api/photos/1234567890.jpg".

    _bindPhotoUpload() {
        const area  = document.getElementById('recipePhotoArea');
        const input = document.getElementById('recipePhotoInput');
        if (!area || !input) return;

        area.addEventListener('click', e => {
            if (e.target.closest('#recipePhotoRemove')) return;
            input.click();
        });

        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            input.value = '';

            // Show uploading state
            this._showPhotoUploading(area);

            try {
                const url = await this.store.uploadPhoto(file, 900, 0.82);
                this._editPhoto = url;
                this._updatePhotoPreview();
            } catch (err) {
                console.error('[RecipeApp] Photo upload failed:', err);
                this._editPhoto = null;
                this._updatePhotoPreview();
            }
        });

        document.getElementById('recipePhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editPhoto = null;
            this._updatePhotoPreview();
        });
    }

    _showPhotoUploading(area) {
        if (!area) return;
        area.innerHTML = `
            <div class="recipe-photo-placeholder">
                <div class="recipe-photo-placeholder-icon">⏳</div>
                <div class="recipe-photo-placeholder-text">Uploading photo…</div>
                <div class="recipe-photo-placeholder-hint">Compressing and saving</div>
            </div>`;
    }

    _updatePhotoPreview() {
        const area  = document.getElementById('recipePhotoArea');
        const input = document.getElementById('recipePhotoInput');
        if (!area) return;

        area.innerHTML = this._editPhoto
            ? `<img src="${this._editPhoto}" class="recipe-photo-preview" alt="Dish photo">
               <div class="recipe-photo-overlay">
                   <button class="recipe-photo-change-btn" id="recipePhotoChange">📷 Change photo</button>
                   <button class="recipe-photo-remove-btn" id="recipePhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="recipe-photo-placeholder">
                   <div class="recipe-photo-placeholder-icon">📷</div>
                   <div class="recipe-photo-placeholder-text">Click to upload a photo</div>
                   <div class="recipe-photo-placeholder-hint">JPG · PNG · WEBP — auto-compressed on upload</div>
               </div>`;

        document.getElementById('recipePhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editPhoto = null;
            this._updatePhotoPreview();
        });

        if (input) area.appendChild(input);
    }

    // ── Ingredient / step row management ─────────────────────────────────────

    _renderEditIngredients() {
        const container = document.getElementById('recipeEditIngredients');
        if (!container) return;

        container.innerHTML = this._editIngredients.map((ing, i) => `
            <div class="recipe-ingredient-row" data-ing-idx="${i}">
                <input class="recipe-ing-input" data-field="amount" placeholder="500"
                       value="${this._esc(ing.amount || '')}" autocomplete="off">
                <input class="recipe-ing-input" data-field="unit" placeholder="g"
                       value="${this._esc(ing.unit || '')}" autocomplete="off">
                <input class="recipe-ing-input" data-field="name" placeholder="Ingredient *"
                       value="${this._esc(ing.name || '')}" autocomplete="off">
                <input class="recipe-ing-input recipe-ing-notes" data-field="notes" placeholder="e.g. diced"
                       value="${this._esc(ing.notes || '')}" autocomplete="off">
                <button class="recipe-row-remove" data-remove-ing="${i}" title="Remove">×</button>
            </div>`).join('');

        container.querySelectorAll('[data-remove-ing]').forEach(btn => {
            btn.addEventListener('click', () => this._removeIngredient(parseInt(btn.dataset.removeIng)));
        });
    }

    _renderEditSteps() {
        const container = document.getElementById('recipeEditSteps');
        if (!container) return;

        container.innerHTML = this._editSteps.map((step, i) => `
            <div class="recipe-step-row" data-step-idx="${i}">
                <div class="recipe-step-num-badge">${i + 1}</div>
                <div class="recipe-step-content">
                    <textarea class="recipe-step-textarea" data-field="text"
                              placeholder="Describe this step…" rows="2">${this._esc(step.text || '')}</textarea>
                    <div class="recipe-step-timer-row">
                        <span class="recipe-step-timer-label">⏱ Timer (min, optional):</span>
                        <input type="number" class="recipe-step-timer-input" data-field="timerMinutes"
                               min="0" max="999" placeholder="—"
                               value="${step.timerMinutes || ''}">
                    </div>
                </div>
                <button class="recipe-row-remove" data-remove-step="${i}" title="Remove step">×</button>
            </div>`).join('');

        container.querySelectorAll('[data-remove-step]').forEach(btn => {
            btn.addEventListener('click', () => this._removeStep(parseInt(btn.dataset.removeStep)));
        });
    }

    _syncEditIngredients() {
        const rows = document.querySelectorAll('#recipeEditIngredients .recipe-ingredient-row');
        this._editIngredients = Array.from(rows).map(row => ({
            amount: row.querySelector('[data-field="amount"]')?.value ?? '',
            unit:   row.querySelector('[data-field="unit"]')?.value   ?? '',
            name:   row.querySelector('[data-field="name"]')?.value   ?? '',
            notes:  row.querySelector('[data-field="notes"]')?.value  ?? '',
        }));
    }

    _syncEditSteps() {
        const rows = document.querySelectorAll('#recipeEditSteps .recipe-step-row');
        this._editSteps = Array.from(rows).map(row => ({
            text:         row.querySelector('[data-field="text"]')?.value         ?? '',
            timerMinutes: parseInt(row.querySelector('[data-field="timerMinutes"]')?.value) || 0,
        }));
    }

    _addIngredient() {
        this._syncEditIngredients();
        this._editIngredients.push({ amount: '', unit: '', name: '', notes: '' });
        this._renderEditIngredients();
        document.querySelector('#recipeEditIngredients .recipe-ingredient-row:last-child [data-field="name"]')?.focus();
    }

    _removeIngredient(i) {
        this._syncEditIngredients();
        this._editIngredients.splice(i, 1);
        if (this._editIngredients.length === 0)
            this._editIngredients.push({ amount: '', unit: '', name: '', notes: '' });
        this._renderEditIngredients();
    }

    _addStep() {
        this._syncEditSteps();
        this._editSteps.push({ text: '', timerMinutes: 0 });
        this._renderEditSteps();
        document.querySelector('#recipeEditSteps .recipe-step-row:last-child textarea')?.focus();
    }

    _removeStep(i) {
        this._syncEditSteps();
        this._editSteps.splice(i, 1);
        if (this._editSteps.length === 0)
            this._editSteps.push({ text: '', timerMinutes: 0 });
        this._renderEditSteps();
    }

    _collectEditData() {
        this._syncEditIngredients();
        this._syncEditSteps();

        const tags = (document.getElementById('editRecipeTags')?.value || '')
            .split(',').map(t => t.trim()).filter(Boolean);

        return {
            id:          this._editRecipe?.id || generateId(),
            name:        (document.getElementById('editRecipeName')?.value || '').trim(),
            description: (document.getElementById('editRecipeDescription')?.value || '').trim(),
            notes:       (document.getElementById('editRecipeNotes')?.value || '').trim(),
            category:    document.getElementById('editRecipeCategory')?.value || 'other',
            servings:    parseInt(document.getElementById('editRecipeServings')?.value) || 0,
            prepTime:    parseInt(document.getElementById('editRecipePrepTime')?.value) || 0,
            cookTime:    parseInt(document.getElementById('editRecipeCookTime')?.value) || 0,
            tags,
            photo:       this._editPhoto || null,
            ingredients: this._editIngredients
                .filter(i => i.name.trim())
                .map(i => ({ ...i, name: i.name.trim() })),
            steps: this._editSteps
                .filter(s => s.text.trim())
                .map((s, idx) => ({ step: idx + 1, text: s.text.trim(), timerMinutes: s.timerMinutes || 0 })),
            createdAt: this._editRecipe?.createdAt,
        };
    }

    async _saveRecipe() {
        const data = this._collectEditData();
        if (!data.name) {
            document.getElementById('editRecipeName')?.focus();
            document.getElementById('editRecipeName')?.classList.add('input-error');
            return;
        }

        const saveBtn = document.getElementById('recipeEditSave');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

        try {
            const saved = await this.store.saveRecipe(data);
            this._closeEdit();

            const idx = this._index.findIndex(r => r.slug === saved.slug || r.id === saved.id);
            const meta = {
                id: saved.id, name: saved.name, slug: saved.slug,
                category: saved.category, tags: saved.tags,
                prepTime: saved.prepTime, cookTime: saved.cookTime, servings: saved.servings,
                hasPhoto: !!saved.photo,
            };
            if (idx >= 0) this._index[idx] = meta;
            else          this._index.push(meta);
            this._renderLibrary();
        } catch (err) {
            console.error('[RecipeApp] saveRecipe failed:', err);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
        }
    }

    async _deleteRecipe(slug) {
        await this.store.deleteRecipe(slug);
        this._index = this._index.filter(r => r.slug !== slug);
        this._renderLibrary();
    }

    _closeEdit() {
        document.getElementById('recipeEditOverlay')?.classList.remove('active');
    }

    // ── Add to Meal Plan Picker ───────────────────────────────────────────────

    _openAddToMeal(recipe) {
        this._mealPickerRecipe = recipe;
        this._renderMealPicker();
    }

    _renderMealPicker() {
        const overlay = document.getElementById('recipeMealPickerOverlay');
        if (!overlay) return;

        const recipe = this._mealPickerRecipe;
        const today  = new Date();

        const weekOptions = [0, 1, 2, 3].map(offset => {
            const d = new Date(today);
            d.setDate(d.getDate() + offset * 7);
            const dates = weekDates(d);
            const label = offset === 0 ? 'This week' : offset === 1 ? 'Next week' : `In ${offset} weeks`;
            return { offset, label, dates, week: isoWeek(dates[0]) };
        });

        const defaultDates = weekOptions[0].dates;
        const dayNames     = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        overlay.innerHTML = `
            <div class="recipe-meal-picker" role="dialog" aria-modal="true">
                <div class="recipe-meal-picker-header">
                    <div class="recipe-meal-picker-title">📅 Add to Meal Plan</div>
                    <div class="recipe-meal-picker-recipe">${this._esc(recipe.name)}</div>
                </div>
                <div class="recipe-meal-picker-body">
                    <div class="recipe-meal-picker-field">
                        <label>Week</label>
                        <select id="mealPickerWeek">
                            ${weekOptions.map(w =>
                                `<option value="${w.offset}">${w.label} (${this._formatShortDate(w.dates[0])} – ${this._formatShortDate(w.dates[6])})</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="recipe-meal-picker-field">
                        <label>Day</label>
                        <select id="mealPickerDay">
                            ${defaultDates.map((d, i) => `
                                <option value="${i}">${dayNames[i]} ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}</option>
                            `).join('')}
                        </select>
                    </div>
                    <div class="recipe-meal-picker-field">
                        <label>Meal</label>
                        <select id="mealPickerType">
                            <option value="breakfast">🌅 Breakfast</option>
                            <option value="lunch">☀️ Lunch</option>
                            <option value="dinner" selected>🌙 Dinner</option>
                        </select>
                    </div>
                    <div class="recipe-meal-picker-field">
                        <label>Notes (optional)</label>
                        <input type="text" id="mealPickerNotes" placeholder="Side dishes, modifications…">
                    </div>
                </div>
                <div class="recipe-meal-picker-footer">
                    <button class="recipe-footer-btn primary" id="mealPickerConfirm">Add to Plan</button>
                    <button class="recipe-footer-btn secondary" id="mealPickerCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        document.getElementById('mealPickerWeek')?.addEventListener('change', e => {
            const idx   = parseInt(e.target.value);
            const dates = weekOptions[idx].dates;
            const daySel = document.getElementById('mealPickerDay');
            if (daySel) {
                const selected = daySel.value;
                daySel.innerHTML = dates.map((d, i) =>
                    `<option value="${i}" ${i == selected ? 'selected' : ''}>${dayNames[i]} ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}</option>`
                ).join('');
            }
        });

        document.getElementById('mealPickerConfirm')?.addEventListener('click', () => {
            const weekIdx  = parseInt(document.getElementById('mealPickerWeek').value);
            const dayIndex = parseInt(document.getElementById('mealPickerDay').value);
            const mealType = document.getElementById('mealPickerType').value;
            const notes    = document.getElementById('mealPickerNotes').value.trim();
            const week     = weekOptions[weekIdx].week;
            this._confirmAddToMeal(week, dayIndex, mealType, notes);
        });

        document.getElementById('mealPickerCancel')?.addEventListener('click', () => this._closeMealPicker());
        overlay.addEventListener('click', e => { if (e.target === overlay) this._closeMealPicker(); });
    }

    async _confirmAddToMeal(week, dayIndex, mealType, notes) {
        const recipe = this._mealPickerRecipe;
        if (!recipe || !window.mealPlanner) return;

        const data = {
            name:       recipe.name,
            notes,
            recipeSlug: recipe.slug,
            recipeName: recipe.name,
        };

        this._closeMealPicker();
        await window.mealPlanner.store.saveSlot(week, dayIndex, mealType, data);
    }

    _closeMealPicker() {
        document.getElementById('recipeMealPickerOverlay')?.classList.remove('active');
    }

    // ── Public entry points ───────────────────────────────────────────────────

    openRecipeDetail(slug) {
        this._openDetail(slug);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _formatShortDate(d) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}
