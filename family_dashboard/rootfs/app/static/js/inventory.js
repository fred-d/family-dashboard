/**
 * inventory.js — Kitchen Inventory wall-tablet master view.
 *
 * Layout (desktop / tablet ≥ 900px):
 *
 *   ┌───────────────────────────────────────────────────────────────────────┐
 *   │  FAMILY PICKER (avatars)                              [ Scan ][ Add ] │
 *   ├───────────────────────────────────────────────────────────────────────┤
 *   │  [Search …………………………………………………………………]   Stats rail: 127 · Low 6 · 🛒 9  │
 *   ├───────────────────────────────────────────────────────────────────────┤
 *   │  LOCATION TABS:  All · Fridge · Freezer · Outdoor · Pantry            │
 *   │  FILTERS:        [ All ][ Low Stock ][ Expiring ][ Out ]              │
 *   ├───────────────────────────────────────────────────────────────────────┤
 *   │                                                                       │
 *   │  ITEM GRID (responsive tiles: photo, name, qty pill, meter, actions)  │
 *   │                                                                       │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * On phone (<900px) the layout collapses: family row horizontal-scrolls,
 * location tabs become chips that wrap, tile grid drops to 2 columns.
 *
 * Phase 2A scope
 *   • View-only for now — tapping a tile opens a lightweight detail sheet
 *     with consume (−) / restock (+) / percent slider
 *   • Add / Edit product modals land in Phase 2B
 *   • Barcode scanner hooks into the existing BarcodeScanner class
 */

import { FamilyPicker } from './family-picker.js';
import { BarcodeScanner } from './scanner.js?v=2';
import { apiUrl, isoWeek, weekDates } from './utils.js';

// ── MDI → emoji map ──────────────────────────────────────────────────────────
// The backend seeds MDI icon names (e.g. "mdi:fridge"). We render those as
// plain emoji for now — no need to pull in an icon font just for a first look.
const MDI_EMOJI = {
    'mdi:food-variant':    '🥫',
    'mdi:fridge':          '🧊',
    'mdi:fridge-outline':  '❄️',
    'mdi:snowflake':       '❄️',
    'mdi:tag':             '🏷️',
    'mdi:store':           '🏪',
    'mdi:store-outline':   '🏬',
    'mdi:cart':            '🛒',
    'mdi:cart-variant':    '🛍️',
    'mdi:carrot':          '🥕',
    'mdi:cheese':          '🧀',
    'mdi:food-steak':      '🥩',
    'mdi:bread-slice':     '🍞',
    'mdi:sack':            '🌾',
    'mdi:bottle-tonic':    '🧴',
    'mdi:cupcake':         '🧁',
    'mdi:bowl-mix':        '🥣',
    'mdi:cookie':          '🍪',
    'mdi:cup':             '🥤',
    'mdi:spray-bottle':    '🧴',
    'mdi:lotion':          '🧴',
    'mdi:paw':             '🐾',
    'mdi:home-variant':    '🏠',
    'mdi:dots-horizontal': '📦',
};

function iconToEmoji(icon) {
    if (!icon) return '📍';
    if (icon.startsWith('mdi:')) return MDI_EMOJI[icon] || '📦';
    return icon; // already an emoji
}

// ── Tile helpers ─────────────────────────────────────────────────────────────

/** Stock state derived from percent / qty / thresholds. */
function stockState(item) {
    const pct = _effectivePercent(item);
    if (pct <= 0) return 'out';
    if (pct <= 25 || (item.qty_on_hand <= item.low_qty_threshold)) return 'low';
    return 'ok';
}

function _effectivePercent(item) {
    // Guard: Number(null) === 0, which is finite — that would make null-percent
    // items (those that track qty, not %) always appear "Out". Check nullness first.
    if (item?.percent != null) {
        const pct = Number(item.percent);
        if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
    }
    // No percent set — derive from qty vs par_qty (target on-hand quantity).
    const qty = Number(item?.qty_on_hand);
    const par = Number(item?.par_qty || item?.low_qty_threshold) || 1;
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((qty / par) * 100)));
}

function _daysUntil(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return Math.ceil((d - Date.now()) / 86400_000);
}

/** Pluralise a unit label for display. */
function _plural(n, unit) {
    const u = (unit || 'item').trim();
    if (n === 1) return `${n} ${u}`;
    if (/[sx]$/i.test(u)) return `${n} ${u}`;          // already plural-ish
    return `${n} ${u}s`;
}

/** Primary qty label for tile / detail. */
function _qtyLabel(it, pct) {
    if (it.unit === 'pct') return `${pct}%`;
    const qty = Math.round(Number(it.qty_on_hand) || 0);
    return _plural(qty, it.count_unit || 'item');
}

/** Secondary "≈ N packs of M" line, only meaningful if units_per_pack > 1. */
function _packSubLabel(it) {
    const upp = Number(it.units_per_pack) || 1;
    if (upp <= 1) return '';
    const qty = Number(it.qty_on_hand) || 0;
    const packs = qty / upp;
    if (packs <= 0) return `pack of ${upp}`;
    const rounded = Math.round(packs * 10) / 10;
    return `≈ ${rounded} pack${rounded === 1 ? '' : 's'} of ${upp}`;
}

/** Detect "expiring soon" (≤ 7 days) or "expired". */
function expiryState(item) {
    const d = _daysUntil(item.expires_at);
    if (d == null) return null;
    if (d < 0) return 'expired';
    if (d <= 7) return 'soon';
    return null;
}

// ── Inventory view ───────────────────────────────────────────────────────────

export class InventoryApp {
    constructor(containerEl, store) {
        this.container = containerEl;
        this.store     = store;

        // View state
        this._tab       = 'inventory'; // 'inventory' | 'list'
        this._viewStyle = 'list';      // 'list' | 'grid'
        this._location  = 'all';   // location id | 'all'
        this._filter    = 'all';   // 'all' | 'low' | 'expiring' | 'out'
        this._search    = '';
        this._shopStore = 'all';  // store id | 'all'
        this._walkOpen  = false;   // walk mode overlay open

        // Lazy-constructed scanner
        this._scanner = null;

        this._renderShell();
        this._bindStore();
    }

    // ── Initial DOM scaffold ─────────────────────────────────────────────────

    _renderShell() {
        this.container.classList.add('inv');
        this.container.innerHTML = `
            <!-- Header: family + actions -->
            <div class="inv-header">
                <div class="inv-family"></div>
                <div class="inv-header-actions">
                    <button type="button" class="inv-btn inv-btn-secondary" data-action="scan">
                        📷 Scan
                    </button>
                    <button type="button" class="inv-btn inv-btn-primary" data-action="add">
                        ＋ Add
                    </button>
                    <button type="button" class="inv-btn inv-btn-ghost inv-btn-icon-only"
                            data-action="settings" aria-label="Settings" title="Settings">⚙</button>
                </div>
            </div>

            <!-- Tab bar -->
            <nav class="inv-tabs" data-tabs>
                <button type="button" class="inv-tab active" data-tab="inventory">
                    📦 Inventory
                    <span class="inv-tab-badge" data-badge-inv>0</span>
                </button>
                <button type="button" class="inv-tab" data-tab="list">
                    🛒 List
                    <span class="inv-tab-badge" data-badge-shop>0</span>
                </button>
            </nav>

            <!-- ══ INVENTORY PANEL ══ -->
            <div class="inv-panel" data-panel="inventory">

                <div class="inv-inv-toolbar">
                    <label class="inv-search">
                        <span class="inv-search-icon" aria-hidden="true">🔍</span>
                        <input type="search" class="inv-search-input"
                               placeholder="Search items, brands, categories…" autocomplete="off">
                    </label>
                    <button type="button" class="inv-btn inv-btn-ghost inv-btn-icon-only inv-view-toggle"
                            data-view-toggle title="Switch between list and grid">⊞</button>
                    <div class="inv-stats" data-stats-rail></div>
                </div>

                <nav class="inv-loctabs" data-loctabs></nav>

                <div class="inv-filters" data-filters>
                    <button class="inv-chip active" data-filter="all">All</button>
                    <button class="inv-chip" data-filter="low">Low</button>
                    <button class="inv-chip" data-filter="expiring">Expiring</button>
                    <button class="inv-chip" data-filter="out">Out</button>
                </div>

                <div class="inv-content" data-content>
                    <div class="inv-empty" data-empty hidden>
                        <div class="inv-empty-icon">📦</div>
                        <div class="inv-empty-title">Nothing here yet</div>
                        <div class="inv-empty-sub">Scan a barcode or tap <strong>＋ Add</strong> to get started.</div>
                    </div>
                </div>
            </div>

            <!-- ══ LIST (SHOPPING) PANEL ══ -->
            <div class="inv-panel" data-panel="list" hidden>

                <div class="inv-shop-header">
                    <select class="inv-input inv-shop-store-select" data-shop-store>
                        <option value="all">All stores</option>
                    </select>
                    <button type="button" class="inv-btn inv-btn-secondary"
                            data-action="walk-mode" title="In-store walk mode">
                        🏪 Walk
                    </button>
                    <button type="button" class="inv-btn inv-btn-secondary"
                            data-action="from-meal-plan">
                        📅 From Meal Plan
                    </button>
                    <button type="button" class="inv-btn inv-btn-primary"
                            data-stock-all hidden>
                        📥 Stock all bought
                    </button>
                </div>

                <div class="inv-shop-progress" data-shop-progress hidden>
                    <div class="inv-shop-progress-bar">
                        <div class="inv-shop-progress-fill" data-shop-progress-fill></div>
                    </div>
                    <span class="inv-shop-progress-label" data-shop-progress-label></span>
                </div>

                <div class="inv-shop-list" data-shop-list>
                    <div class="inv-empty" data-shop-empty hidden>
                        <div class="inv-empty-icon">🛒</div>
                        <div class="inv-empty-title">Shopping list is empty</div>
                        <div class="inv-empty-sub">Items appear here when stock falls below minimum, or add one with <strong>＋ Add</strong>.</div>
                    </div>
                </div>

                <!-- Walk mode overlay (full-screen) -->
                <div class="inv-walk-overlay" data-walk-overlay hidden>
                    <div class="inv-walk-header">
                        <div class="inv-walk-header-left">
                            <div class="inv-walk-title">🏪 Store Walk</div>
                            <div class="inv-walk-subtitle" data-walk-subtitle>Loading…</div>
                        </div>
                        <button type="button" class="inv-walk-close" data-walk-close>✕ Done</button>
                    </div>
                    <div class="inv-walk-progress-bar">
                        <div class="inv-walk-progress-fill" data-walk-fill style="width:0%"></div>
                    </div>
                    <div class="inv-walk-items" data-walk-items></div>
                </div>
            </div>

            <!-- Detail sheet -->
            <div class="inv-sheet" data-sheet hidden>
                <div class="inv-sheet-backdrop" data-sheet-close></div>
                <div class="inv-sheet-card" data-sheet-card></div>
            </div>
        `;

        // ── Cache refs ────────────────────────────────────────────────────────

        this.$family      = this.container.querySelector('.inv-family');
        this.$tabs        = this.container.querySelector('[data-tabs]');
        this.$invPanel    = this.container.querySelector('[data-panel="inventory"]');
        this.$shopPanel   = this.container.querySelector('[data-panel="list"]');
        this.$stats       = this.container.querySelector('[data-stats-rail]');
        this.$loctabs     = this.container.querySelector('[data-loctabs]');
        this.$filters     = this.container.querySelector('[data-filters]');
        this.$content     = this.container.querySelector('[data-content]');
        this.$empty       = this.container.querySelector('[data-empty]');
        this.$sheet       = this.container.querySelector('[data-sheet]');
        this.$sheetCard   = this.container.querySelector('[data-sheet-card]');
        this.$search      = this.container.querySelector('.inv-search-input');
        this.$viewToggle  = this.container.querySelector('[data-view-toggle]');
        this.$shopStore   = this.container.querySelector('[data-shop-store]');
        this.$shopList    = this.container.querySelector('[data-shop-list]');
        this.$shopEmpty   = this.container.querySelector('[data-shop-empty]');
        this.$shopProgress = this.container.querySelector('[data-shop-progress]');
        this.$shopProgressFill  = this.container.querySelector('[data-shop-progress-fill]');
        this.$shopProgressLabel = this.container.querySelector('[data-shop-progress-label]');
        this.$walkOverlay = this.container.querySelector('[data-walk-overlay]');
        this.$walkSubtitle = this.container.querySelector('[data-walk-subtitle]');
        this.$walkFill    = this.container.querySelector('[data-walk-fill]');
        this.$walkItems   = this.container.querySelector('[data-walk-items]');
        this.$stockAll    = this.container.querySelector('[data-stock-all]');
        this.$badgeInv    = this.container.querySelector('[data-badge-inv]');
        this.$badgeShop   = this.container.querySelector('[data-badge-shop]');

        // Mount family picker (compact)
        this._picker = new FamilyPicker(this.store);
        this.$family.appendChild(this._picker.el);

        // ── Wire interactions ─────────────────────────────────────────────────

        this.$search.addEventListener('input', e => {
            this._search = e.target.value.trim().toLowerCase();
            this._renderGrid();
        });

        this.$filters.addEventListener('click', e => {
            const chip = e.target.closest('.inv-chip');
            if (!chip) return;
            this._filter = chip.dataset.filter;
            this.$filters.querySelectorAll('.inv-chip').forEach(c =>
                c.classList.toggle('active', c === chip));
            this._renderGrid();
        });

        this.$loctabs.addEventListener('click', e => {
            const tab = e.target.closest('.inv-loctab');
            if (!tab) return;
            this._location = tab.dataset.loc;
            this.$loctabs.querySelectorAll('.inv-loctab').forEach(t =>
                t.classList.toggle('active', t === tab));
            this._renderGrid();
        });

        this.$tabs.addEventListener('click', e => {
            const btn = e.target.closest('[data-tab]');
            if (!btn) return;
            this._setTab(btn.dataset.tab);
        });

        this.$viewToggle.addEventListener('click', () => this._toggleViewStyle());

        this.container.querySelector('[data-action="scan"]')
            .addEventListener('click', () => this._openScanner());
        this.container.querySelector('[data-action="add"]')
            .addEventListener('click', () => {
                if (this._tab === 'list') this._openShoppingAddModal();
                else this._openAddSheet();
            });
        this.container.querySelector('[data-action="settings"]')
            .addEventListener('click', () => this._openSettings());

        this.container.querySelector('[data-action="from-meal-plan"]')
            ?.addEventListener('click', () => this._openMealPlanImport());

        this.container.querySelector('[data-action="walk-mode"]')
            ?.addEventListener('click', () => this._openWalkMode());

        this.$stockAll?.addEventListener('click', () => this._stockAllBought());

        this.$shopStore.addEventListener('change', () => {
            this._shopStore = this.$shopStore.value;
            this._renderShopping();
        });

        this.$shopList.addEventListener('click', e => {
            const cycleBtn = e.target.closest('[data-shop-cycle]');
            const stockBtn = e.target.closest('[data-shop-stock]');
            const delBtn   = e.target.closest('[data-shop-delete]');
            const qDecBtn  = e.target.closest('[data-shop-qdec]');
            const qIncBtn  = e.target.closest('[data-shop-qinc]');
            if (cycleBtn) {
                const id  = cycleBtn.dataset.shopCycle;
                const row = (this.store.shopping || []).find(s => s.id === id);
                const cur = row?.status || 'needed';
                const next = cur === 'needed' ? 'ordered'
                           : cur === 'ordered' ? 'bought'
                           : 'needed';
                this.store.updateShopping(id, { status: next }).catch(() => {});
            } else if (qDecBtn) {
                const id  = qDecBtn.dataset.shopQdec;
                const row = (this.store.shopping || []).find(s => s.id === id);
                const next = Math.max(1, (Number(row?.qty) || 1) - 1);
                this.store.updateShopping(id, { qty: next }).catch(() => {});
            } else if (qIncBtn) {
                const id  = qIncBtn.dataset.shopQinc;
                const row = (this.store.shopping || []).find(s => s.id === id);
                const next = (Number(row?.qty) || 1) + 1;
                this.store.updateShopping(id, { qty: next }).catch(() => {});
            } else if (stockBtn) {
                this._stockShoppingRow(stockBtn.dataset.shopStock);
            } else if (delBtn) {
                this.store.deleteShopping(delBtn.dataset.shopDelete).catch(() => {});
            }
        });

        // Delegated inventory content clicks (tiles and list rows)
        this.$content.addEventListener('click', e => {
            const btnDec  = e.target.closest('[data-dec]');
            const btnInc  = e.target.closest('[data-inc]');
            const btnNeed = e.target.closest('[data-need]');
            const tile    = e.target.closest('.inv-tile, .inv-row');
            if (btnDec) {
                e.stopPropagation();
                this.store.consume(btnDec.dataset.dec).catch(() => {});
            } else if (btnInc) {
                e.stopPropagation();
                this.store.restock(btnInc.dataset.inc).catch(() => {});
            } else if (btnNeed) {
                e.stopPropagation();
                const it = (this.store.items || []).find(i => i.id === btnNeed.dataset.need);
                if (it) this._needThis(it);
            } else if (tile) {
                this._openDetailSheet(tile.dataset.id);
            }
        });

        this.$sheet.addEventListener('click', e => {
            if (e.target.matches('[data-sheet-close]')) this._closeSheet();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (this._walkOpen) { this._closeWalkMode(); return; }
                if (!this.$sheet.hidden) this._closeSheet();
            }
        });

        // Walk overlay
        this.$walkOverlay.addEventListener('click', e => {
            if (e.target.closest('[data-walk-close]')) this._closeWalkMode();
        });
    }

    // ── Store wiring ─────────────────────────────────────────────────────────

    _bindStore() {
        this._off = [
            this.store.on('config', () => {
                this._renderLocations();
                this._renderShopStores();
                this._renderGrid();
                this._renderShopping();
            }),
            this.store.on('items',    () => { this._renderLocations(); this._renderGrid(); this._renderStats(); }),
            this.store.on('stats',    () => this._renderStats()),
            this.store.on('shopping', () => {
                this._renderStats();
                this._renderShopping();
                if (this._walkOpen) {
                    const storeId = this._shopStore !== 'all' ? this._shopStore
                        : ((this.store.config.stores || [])[0]?.id || null);
                    let fresh = this.store.shopping || [];
                    if (storeId) fresh = fresh.filter(r => r.store_id === storeId || !r.store_id);
                    this._renderWalkItems(fresh.filter(r => r.status !== 'bought'));
                }
            }),
            this.store.on('family',   () => this._renderShopping()),
        ];
        this._renderLocations();
        this._renderShopStores();
        this._renderStats();
        this._renderGrid();
        this._renderShopping();
    }

    _setTab(tab) {
        if (tab !== 'inventory' && tab !== 'list') return;
        this._tab = tab;
        this.$tabs.querySelectorAll('[data-tab]').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === tab));
        this.$invPanel.hidden  = tab !== 'inventory';
        this.$shopPanel.hidden = tab !== 'list';
        // Re-label Add and Scan buttons to reflect context
        const $add  = this.container.querySelector('[data-action="add"]');
        const $scan = this.container.querySelector('[data-action="scan"]');
        if ($add)  $add.textContent  = tab === 'list' ? '＋ Add to List' : '＋ Add';
        if ($scan) $scan.textContent = tab === 'list' ? '📷 Scan to List' : '📷 Scan';
    }

    _toggleViewStyle() {
        this._viewStyle = this._viewStyle === 'list' ? 'grid' : 'list';
        this.$viewToggle.textContent = this._viewStyle === 'grid' ? '≡' : '⊞';
        this.$viewToggle.title = this._viewStyle === 'grid' ? 'Switch to list view' : 'Switch to grid view';
        this.$content.classList.toggle('inv-content-grid', this._viewStyle === 'grid');
        this._renderGrid();
    }

    _openWalkMode() {
        const stores = this.store.config.stores || [];
        // Default to selected store or first store
        let storeId = this._shopStore !== 'all' ? this._shopStore : (stores[0]?.id || null);
        let all = this.store.shopping || [];
        let items = storeId ? all.filter(r => r.store_id === storeId || !r.store_id) : all;
        items = items.filter(r => r.status !== 'bought');

        this._walkOpen = true;
        this.$walkOverlay.hidden = false;
        requestAnimationFrame(() => this.$walkOverlay.classList.add('open'));
        this._renderWalkItems(items);
    }

    _renderWalkItems(items) {
        const catSortIdx = new Map();
        (this.store.config.categories || []).forEach((c, i) => {
            catSortIdx.set(c.id, Number(c.sort_order) || i);
        });

        const groups = new Map();
        for (const row of items) {
            const key = row.category_name || 'Other';
            if (!groups.has(key)) groups.set(key, { key, cid: row.category_id, rows: [] });
            groups.get(key).rows.push(row);
        }
        const sortedGroups = [...groups.values()].sort((a, b) => {
            const ai = catSortIdx.has(a.cid) ? catSortIdx.get(a.cid) : 9999;
            const bi = catSortIdx.has(b.cid) ? catSortIdx.get(b.cid) : 9999;
            return ai - bi || a.key.localeCompare(b.key);
        });

        const total = items.length;
        const done  = (this.store.shopping || []).filter(r => r.status === 'bought').length;

        if (this.$walkFill) this.$walkFill.style.width = total > 0 ? `${(done / (done + total)) * 100}%` : '0%';
        if (this.$walkSubtitle) this.$walkSubtitle.textContent = `${total} items left to grab`;

        if (!items.length) {
            this.$walkItems.innerHTML = `
                <div class="inv-walk-done">
                    <div style="font-size:56px;margin-bottom:12px">🎉</div>
                    <div class="inv-walk-done-title">All done!</div>
                    <div class="inv-walk-done-sub">Nothing left to grab. Tap Done to finish.</div>
                </div>`;
            return;
        }

        this.$walkItems.innerHTML = sortedGroups.map(({ key, rows }) => `
            <div class="inv-walk-group">
                <div class="inv-walk-group-head">${_esc(key)}</div>
                ${rows.map(r => {
                    const status = r.status || 'needed';
                    const photo = r.product_image
                        ? `<img class="inv-walk-img" src="${_esc(r.product_image)}" alt="" loading="lazy">`
                        : `<div class="inv-walk-img placeholder">🛒</div>`;
                    const qtyNum = Math.max(1, Number(r.qty) || 1);
                    return `
                        <div class="inv-walk-row status-${status}" data-walk-row="${_esc(r.id)}">
                            <button type="button" class="inv-walk-check tri-${status}"
                                    data-walk-cycle="${_esc(r.id)}"
                                    aria-label="Mark bought">
                                ${status === 'bought' ? '✓' : status === 'ordered' ? '📋' : ''}
                            </button>
                            ${photo}
                            <div class="inv-walk-info">
                                <div class="inv-walk-name">${_esc(r.name)}</div>
                                ${qtyNum > 1 ? `<div class="inv-walk-qty">× ${qtyNum}</div>` : ''}
                            </div>
                        </div>`;
                }).join('')}
            </div>`).join('');

        // Bind walk check buttons
        this.$walkItems.querySelectorAll('[data-walk-cycle]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id  = btn.dataset.walkCycle;
                const row = (this.store.shopping || []).find(s => s.id === id);
                const cur = row?.status || 'needed';
                const next = cur === 'bought' ? 'needed' : 'bought';
                await this.store.updateShopping(id, { status: next }).catch(() => {});
                // Re-render walk view with fresh data
                const storeId = this._shopStore !== 'all' ? this._shopStore
                    : ((this.store.config.stores || [])[0]?.id || null);
                let fresh = this.store.shopping || [];
                if (storeId) fresh = fresh.filter(r => r.store_id === storeId || !r.store_id);
                this._renderWalkItems(fresh.filter(r => r.status !== 'bought'));
            });
        });
    }

    _closeWalkMode() {
        this._walkOpen = false;
        this.$walkOverlay.classList.remove('open');
        setTimeout(() => { this.$walkOverlay.hidden = true; }, 250);
    }

    destroy() {
        (this._off || []).forEach(fn => fn && fn());
        this._picker?.destroy();
        this.container.classList.remove('inv');
        this.container.innerHTML = '';
    }

    // ── Render: location tabs ────────────────────────────────────────────────

    _renderLocations() {
        const locs = this.store.config.locations || [];
        const counts = this.store.countsByLocation();
        const total = this.store.items.length;

        const tabs = [
            { id: 'all', name: 'All', emoji: '🏠', count: total },
            ...locs.map(l => ({
                id: l.id,
                name: l.name,
                emoji: iconToEmoji(l.icon),
                count: counts[l.id] || 0,
            })),
        ];

        this.$loctabs.innerHTML = tabs.map(t => `
            <button class="inv-loctab${t.id === this._location ? ' active' : ''}"
                    data-loc="${t.id}" type="button">
                <span class="inv-loctab-emoji">${t.emoji}</span>
                <span class="inv-loctab-name">${_esc(t.name)}</span>
                <span class="inv-loctab-count">${t.count}</span>
            </button>
        `).join('');
    }

    // ── Render: shopping store dropdown ──────────────────────────────────────

    _renderShopStores() {
        const stores = this.store.config.stores || [];
        const cur = this._shopStore;
        this.$shopStore.innerHTML = `
            <option value="all"${cur === 'all' ? ' selected' : ''}>All stores</option>
            ${stores.map(s => `
                <option value="${_esc(s.id)}"${s.id === cur ? ' selected' : ''}>
                    ${_esc(iconToEmoji(s.icon))} ${_esc(s.name)}
                </option>`).join('')}
        `;
    }

    // ── Render: shopping list ────────────────────────────────────────────────

    _renderShopping() {
        const all = this.store.shopping || [];
        let filtered = this._shopStore === 'all'
            ? all
            : all.filter(r => r.store_id === this._shopStore || !r.store_id);

        // Clear previous rows but keep empty state element
        this.$shopList.querySelectorAll('.inv-shop-row, .inv-shop-group').forEach(n => n.remove());

        // Toggle "Stock all bought" button based on whether there's anything to stock
        const anyBought = all.some(r => r.status === 'bought' && r.product_id);
        if (this.$stockAll) this.$stockAll.hidden = !anyBought;

        // Update progress bar
        const total = all.length;
        const bought = all.filter(r => r.status === 'bought').length;
        if (this.$shopProgress) {
            this.$shopProgress.hidden = total === 0;
            if (total > 0) {
                const pct = Math.round((bought / total) * 100);
                if (this.$shopProgressFill)  this.$shopProgressFill.style.width  = `${pct}%`;
                if (this.$shopProgressLabel) this.$shopProgressLabel.textContent = `${bought} of ${total} in cart`;
            }
        }

        if (!filtered.length) {
            this.$shopEmpty.hidden = false;
            return;
        }
        this.$shopEmpty.hidden = true;

        // Build category sort order from config (walk mode follows aisle order)
        const catSortIdx = new Map();
        (this.store.config.categories || []).forEach((c, i) => {
            catSortIdx.set(c.id, Number(c.sort_order) || i);
        });

        // Group by category
        const groups = new Map();
        for (const row of filtered) {
            const key = row.category_name || 'Uncategorized';
            if (!groups.has(key)) groups.set(key, { cat: key, cid: row.category_id, rows: [] });
            groups.get(key).rows.push(row);
        }

        const sortedGroups = [...groups.values()].sort((a, b) =>
            a.cat.localeCompare(b.cat));

        const html = sortedGroups.map(({ cat, rows }) => {
            rows.sort((a, b) =>
                (a.status === 'bought' ? 1 : 0) - (b.status === 'bought' ? 1 : 0) ||
                (a.name || '').localeCompare(b.name || ''));
            const rowsHtml = rows.map(r => this._shopRowHtml(r)).join('');
            return `
                <div class="inv-shop-group">
                    <div class="inv-shop-group-head">${_esc(cat)}</div>
                    ${rowsHtml}
                </div>
            `;
        }).join('');

        this.$shopEmpty.insertAdjacentHTML('beforebegin', html);
    }

    _toggleWalkMode() {
        this._openWalkMode();
    }

    async _stockAllBought() {
        const ok = await this._confirm({
            title: 'Stock all bought items?',
            body:  'Every checked-off shopping item will be moved into your inventory using its default location. This can\'t be undone.',
            confirmLabel: 'Stock all',
        });
        if (!ok) return;
        try {
            await this.store.stockAllBought();
        } catch (err) {
            alert(err.message || 'Failed to stock items.');
        }
    }

    _shopRowHtml(r) {
        const status = r.status === 'ordered' ? 'ordered'
                      : r.status === 'bought' ? 'bought'
                      : 'needed';
        const person = r.added_by ? this.store.personById(r.added_by) : null;
        const personChip = person ? `
            <span class="inv-shop-chip" style="background:${_esc(person.color || '#6b7280')}"
                  title="Requested by ${_esc(person.name || '')}">
                ${_esc((person.name || '?').slice(0, 1))}
            </span>` : '';
        const storeChip = r.store_name ? `
            <span class="inv-shop-store" style="border-color:${_esc(r.store_color || 'var(--color-border)')}">
                ${_esc(r.store_name)}
            </span>` : '';
        const sourceBadge = r.source === 'auto'
            ? `<span class="inv-shop-source auto" title="Auto-added: stock below minimum">⟳ auto</span>`
            : '';
        const statusBadge = status === 'ordered'
            ? `<span class="inv-shop-source ordered" title="Marked as ordered / in cart">📋 ordered</span>`
            : '';
        const photo = r.product_image
            ? `<img class="inv-shop-img" src="${_esc(r.product_image)}" alt="" loading="lazy">`
            : `<div class="inv-shop-img placeholder">🛒</div>`;
        const qtyNum  = Math.max(1, Number(r.qty) || 1);
        const isDone  = status === 'bought';
        const qtyCtrl = `
            <div class="inv-shop-qtyctrl" aria-label="Quantity">
                <button type="button" class="inv-shop-qbtn" data-shop-qdec="${_esc(r.id)}"
                        ${qtyNum <= 1 || isDone ? 'disabled' : ''}
                        aria-label="Decrease quantity">−</button>
                <span class="inv-shop-qnum">${qtyNum}</span>
                <button type="button" class="inv-shop-qbtn" data-shop-qinc="${_esc(r.id)}"
                        ${isDone ? 'disabled' : ''}
                        aria-label="Increase quantity">+</button>
            </div>`;
        // Tri-state checkbox: empty → 📋 ordered → ✓ bought → empty…
        const checkLabel = status === 'needed' ? 'Mark ordered'
                         : status === 'ordered' ? 'Mark bought'
                         : 'Reset to needed';
        const checkGlyph = status === 'needed' ? ''
                         : status === 'ordered' ? '📋' : '✓';
        const stockBtn = (status === 'ordered' || status === 'bought') && r.product_id
            ? `<button type="button" class="inv-shop-stock" data-shop-stock="${_esc(r.id)}"
                       title="Stock to inventory" aria-label="Stock to inventory">📥</button>`
            : '';
        return `
            <div class="inv-shop-row status-${status}">
                <button type="button" class="inv-shop-check tri-${status}"
                        data-shop-cycle="${_esc(r.id)}" aria-label="${checkLabel}">
                    ${checkGlyph}
                </button>
                ${photo}
                <div class="inv-shop-body">
                    <div class="inv-shop-name">${_esc(r.name)}</div>
                    <div class="inv-shop-meta">
                        ${sourceBadge}
                        ${statusBadge}
                        ${storeChip}
                        ${personChip}
                    </div>
                </div>
                ${qtyCtrl}
                ${stockBtn}
                <button type="button" class="inv-shop-del" data-shop-delete="${_esc(r.id)}"
                        aria-label="Remove from list">×</button>
            </div>
        `;
    }

    // ── Shopping: add modal ──────────────────────────────────────────────────

    _openShoppingAddModal() {
        const stores = this.store.config.stores || [];
        const categories = this.store.config.categories || [];

        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <h2 class="inv-form-title">Add to Shopping List</h2>

            <form class="inv-form" data-shop-form novalidate>
                <label class="inv-field">
                    <span class="inv-field-label">Item</span>
                    <input type="text" class="inv-input" name="name" required autocomplete="off"
                           placeholder="e.g. Crest toothpaste (mint)">
                </label>

                <div class="inv-form-grid">
                    <label class="inv-field">
                        <span class="inv-field-label">Quantity</span>
                        <input type="number" class="inv-input" name="qty"
                               min="1" step="1" value="1">
                    </label>
                    <label class="inv-field">
                        <span class="inv-field-label">Store</span>
                        <select class="inv-input" name="store_id">
                            <option value="">— Any —</option>
                            ${stores.map(s => `
                                <option value="${_esc(s.id)}">
                                    ${_esc(iconToEmoji(s.icon))} ${_esc(s.name)}
                                </option>`).join('')}
                        </select>
                    </label>
                    <label class="inv-field inv-field-wide">
                        <span class="inv-field-label">Category</span>
                        <select class="inv-input" name="category_id">
                            <option value="">— None —</option>
                            ${categories.map(c => `
                                <option value="${_esc(c.id)}">
                                    ${_esc(iconToEmoji(c.icon))} ${_esc(c.name)}
                                </option>`).join('')}
                        </select>
                    </label>
                    <label class="inv-field inv-field-wide">
                        <span class="inv-field-label">Notes</span>
                        <input type="text" class="inv-input" name="notes" autocomplete="off"
                               placeholder="optional — brand, flavor, who it's for…">
                    </label>
                </div>

                <div class="inv-form-actions">
                    <span></span>
                    <div class="inv-form-actions-right">
                        <button type="button" class="inv-btn inv-btn-secondary" data-sheet-close>Cancel</button>
                        <button type="submit" class="inv-btn inv-btn-primary">＋ Add</button>
                    </div>
                </div>
            </form>
        `;

        const $form = this.$sheetCard.querySelector('[data-shop-form]');
        $form.addEventListener('submit', async e => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData($form));
            const name = (data.name || '').trim();
            if (!name) { $form.querySelector('[name="name"]')?.focus(); return; }
            const $btn = $form.querySelector('button[type="submit"]');
            if ($btn) { $btn.disabled = true; $btn.textContent = 'Adding…'; }
            try {
                await this.store.addShopping({
                    name,
                    qty:         Number(data.qty) || 1,
                    store_id:    data.store_id || null,
                    category_id: data.category_id || null,
                    notes:       data.notes || '',
                });
                this._closeSheet();
            } catch (err) {
                alert(err.message || 'Add failed.');
                if ($btn) { $btn.disabled = false; $btn.textContent = '＋ Add'; }
            }
        });

        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));
        setTimeout(() => $form.querySelector('[name="name"]')?.focus(), 220);
    }

    // ── Render: stats rail ───────────────────────────────────────────────────

    _renderStats() {
        const s = this.store.stats || {};
        const shoppingCount = (this.store.shopping || []).length;
        this.$stats.innerHTML = `
            <div class="inv-stat" title="Total items">
                <span class="inv-stat-num">${s.total ?? 0}</span>
                <span class="inv-stat-lbl">items</span>
            </div>
            <div class="inv-stat low" title="Low stock">
                <span class="inv-stat-num">${s.low ?? 0}</span>
                <span class="inv-stat-lbl">low</span>
            </div>
            <div class="inv-stat out" title="Out of stock">
                <span class="inv-stat-num">${s.out ?? 0}</span>
                <span class="inv-stat-lbl">out</span>
            </div>
            <div class="inv-stat warn" title="Expiring soon">
                <span class="inv-stat-num">${s.expiring_soon ?? 0}</span>
                <span class="inv-stat-lbl">expiring</span>
            </div>
            <div class="inv-stat shop" title="Shopping list">
                <span class="inv-stat-num">${shoppingCount}</span>
                <span class="inv-stat-lbl">🛒 list</span>
            </div>
        `;
        // Update tab badges
        const total = this.store.stats?.total ?? (this.store.items || []).length;
        if (this.$badgeInv)  this.$badgeInv.textContent  = total;
        if (this.$badgeShop) this.$badgeShop.textContent = shoppingCount;
    }

    // ── Render: grid ─────────────────────────────────────────────────────────

    _renderGrid() {
        if (this._viewStyle === 'list') return this._renderInventoryList();
        return this._renderInventoryGrid();
    }

    _renderInventoryGrid() {
        const items = this._visibleItems();
        // Ensure grid wrapper exists
        let $grid = this.$content.querySelector('.inv-grid');
        if (!$grid) {
            this.$content.querySelectorAll('.inv-list, .inv-grid').forEach(n => n.remove());
            $grid = document.createElement('div');
            $grid.className = 'inv-grid';
            this.$content.insertBefore($grid, this.$empty);
        }
        if (!items.length) {
            this.$empty.hidden = false;
            $grid.querySelectorAll('.inv-tile').forEach(n => n.remove());
            return;
        }
        this.$empty.hidden = true;
        $grid.querySelectorAll('.inv-tile').forEach(n => n.remove());
        $grid.insertAdjacentHTML('afterbegin', items.map(it => this._tileHtml(it)).join(''));
    }

    _renderInventoryList() {
        const items = this._visibleItems();
        // Ensure list wrapper exists
        let $list = this.$content.querySelector('.inv-list');
        if (!$list) {
            this.$content.querySelectorAll('.inv-list, .inv-grid').forEach(n => n.remove());
            $list = document.createElement('div');
            $list.className = 'inv-list';
            this.$content.insertBefore($list, this.$empty);
        }
        if (!items.length) {
            this.$empty.hidden = false;
            $list.innerHTML = '';
            return;
        }
        this.$empty.hidden = true;
        $list.innerHTML = items.map(it => this._rowHtml(it)).join('');
    }

    _rowHtml(it) {
        const state   = stockState(it);
        const pct     = _effectivePercent(it);
        const qtyLabel = _qtyLabel(it, pct);
        const subLabel = _packSubLabel(it);
        const exp      = expiryState(it);
        const expDays  = _daysUntil(it.expires_at);

        let statusBadge = '';
        if (state === 'out') statusBadge = `<span class="inv-badge out">Out</span>`;
        else if (state === 'low') statusBadge = `<span class="inv-badge low">Low</span>`;
        else if (exp === 'expired') statusBadge = `<span class="inv-badge expired">Expired</span>`;
        else if (exp === 'soon') statusBadge = `<span class="inv-badge soon">${expDays}d</span>`;

        const photo = it.image_url
            ? `<img class="inv-row-img" src="${_esc(it.image_url)}" alt="" loading="lazy">`
            : `<div class="inv-row-img placeholder">${_esc(iconToEmoji(it.category_icon || it.category_emoji))}</div>`;

        const loc = this.store.locationById(it.location_id);
        const meta = [it.brand, loc?.name].filter(Boolean).join(' · ');

        return `
            <div class="inv-row state-${state}" data-id="${_esc(it.id)}">
                <div class="inv-row-thumb">${photo}</div>
                <div class="inv-row-body">
                    <div class="inv-row-name">${_esc(it.name || 'Unnamed')} ${statusBadge}</div>
                    <div class="inv-row-meta">${_esc(meta)}${subLabel ? ` · <span class="inv-row-pack">${_esc(subLabel)}</span>` : ''}</div>
                </div>
                <div class="inv-row-qty-wrap">
                    <span class="inv-row-qty">${_esc(qtyLabel)}</span>
                    ${Number(it.tracks_percent) ? `<div class="inv-row-meter"><div class="inv-row-meter-fill" style="width:${pct}%"></div></div>` : ''}
                </div>
                <div class="inv-row-actions">
                    <button type="button" class="inv-qbtn" data-dec="${_esc(it.id)}"
                            aria-label="Use one" ${it.qty_on_hand <= 0 ? 'disabled' : ''}>−</button>
                    <button type="button" class="inv-qbtn" data-inc="${_esc(it.id)}"
                            aria-label="Add one">+</button>
                    <button type="button" class="inv-qbtn need" data-need="${_esc(it.id)}"
                            aria-label="Need" title="Add to shopping list">🛒</button>
                </div>
            </div>`;
    }

    _visibleItems() {
        let items = this.store.items || [];

        // Location filter
        if (this._location !== 'all') {
            items = items.filter(i => i.location_id === this._location);
        }

        // Chip filter
        switch (this._filter) {
            case 'low':      items = items.filter(i => stockState(i) === 'low'); break;
            case 'out':      items = items.filter(i => stockState(i) === 'out'); break;
            case 'expiring': items = items.filter(i => expiryState(i) != null); break;
        }

        // Search
        if (this._search) {
            const q = this._search;
            items = items.filter(i => {
                const hay = `${i.name || ''} ${i.brand || ''} ${i.category_name || ''}`.toLowerCase();
                return hay.includes(q);
            });
        }

        // Sort: out first, then low, then expiring, then alpha
        const rank = i => {
            const s = stockState(i);
            if (s === 'out') return 0;
            if (s === 'low') return 1;
            if (expiryState(i)) return 2;
            return 3;
        };
        items = [...items].sort((a, b) => rank(a) - rank(b) ||
            (a.name || '').localeCompare(b.name || ''));

        return items;
    }

    _tileHtml(it) {
        const state  = stockState(it);
        const pct    = _effectivePercent(it);
        const exp    = expiryState(it);
        const expDays = _daysUntil(it.expires_at);
        const photo  = it.image_url
            ? `<img class="inv-tile-img" src="${_esc(it.image_url)}" alt="" loading="lazy">`
            : `<div class="inv-tile-img placeholder">${_esc(iconToEmoji(it.category_icon || it.category_emoji))}</div>`;

        let expBadge = '';
        if (exp === 'expired') expBadge = `<span class="inv-badge expired">Expired</span>`;
        else if (exp === 'soon') expBadge = `<span class="inv-badge soon">${expDays}d</span>`;

        const qtyLabel = _qtyLabel(it, pct);
        const subLabel = _packSubLabel(it);

        return `
            <article class="inv-tile state-${state}" data-id="${_esc(it.id)}">
                <div class="inv-tile-media">
                    ${photo}
                    <div class="inv-tile-badges">
                        ${state === 'out' ? '<span class="inv-badge out">Out</span>' : ''}
                        ${state === 'low' ? '<span class="inv-badge low">Low</span>' : ''}
                        ${expBadge}
                    </div>
                </div>
                <div class="inv-tile-body">
                    <div class="inv-tile-name" title="${_esc(it.name || '')}">${_esc(it.name || 'Unnamed')}</div>
                    <div class="inv-tile-sub">${_esc(it.brand || it.category_name || '')}</div>
                    <div class="inv-meter">
                        <div class="inv-meter-fill" style="width:${pct}%"></div>
                    </div>
                    <div class="inv-tile-row">
                        <span class="inv-tile-qty">
                            ${_esc(qtyLabel)}
                            ${subLabel ? `<span class="inv-tile-qty-sub">${_esc(subLabel)}</span>` : ''}
                        </span>
                        <div class="inv-tile-actions">
                            <button type="button" class="inv-qbtn" data-dec="${_esc(it.id)}"
                                    aria-label="Use one ${_esc(it.count_unit || 'item')}" ${it.qty_on_hand <= 0 ? 'disabled' : ''}>−</button>
                            <button type="button" class="inv-qbtn" data-inc="${_esc(it.id)}"
                                    aria-label="Add one ${_esc(it.count_unit || 'item')}">+</button>
                            <button type="button" class="inv-qbtn need" data-need="${_esc(it.id)}"
                                    aria-label="Add to shopping list" title="Need this">🛒</button>
                        </div>
                    </div>
                </div>
            </article>
        `;
    }

    // ── Detail sheet ─────────────────────────────────────────────────────────

    _openDetailSheet(id) {
        const it = this.store.items.find(i => i.id === id);
        if (!it) return;
        const pct = _effectivePercent(it);
        const loc = this.store.locationById(it.location_id);
        const upp = Number(it.units_per_pack) || 1;
        const unitLbl = it.count_unit || 'item';
        const showPack = upp > 1;
        const tracksPct = Number(it.tracks_percent) === 1;

        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <div class="inv-sheet-head">
                ${it.image_url
                    ? `<img class="inv-sheet-img" src="${_esc(it.image_url)}" alt="">`
                    : `<div class="inv-sheet-img placeholder">${_esc(iconToEmoji(it.category_icon || it.category_emoji))}</div>`}
                <div class="inv-sheet-title-block">
                    <h2 class="inv-sheet-title">${_esc(it.name || 'Unnamed')}</h2>
                    <div class="inv-sheet-sub">
                        ${_esc(it.brand || '')}${it.brand ? ' · ' : ''}${_esc(loc?.name || '')}
                    </div>
                </div>
            </div>

            <div class="inv-sheet-qty-block">
                <div class="inv-sheet-qty-num" data-qty-display>${_esc(_qtyLabel(it, pct))}</div>
                ${showPack ? `<div class="inv-sheet-qty-sub">${_esc(_packSubLabel(it))}</div>` : ''}
                <div class="inv-sheet-qty-stepper">
                    <button type="button" class="inv-qbtn big" data-cmd="dec"
                            ${it.qty_on_hand <= 0 ? 'disabled' : ''}
                            aria-label="Use one ${_esc(unitLbl)}">− 1 ${_esc(unitLbl)}</button>
                    <input type="number" class="inv-input inv-sheet-qty-input"
                           min="0" step="1" value="${Math.round(it.qty_on_hand || 0)}"
                           data-qty-set>
                    <button type="button" class="inv-qbtn big" data-cmd="inc"
                            aria-label="Add one ${_esc(unitLbl)}">+ 1 ${_esc(unitLbl)}</button>
                </div>
                ${showPack ? `
                    <button type="button" class="inv-btn inv-btn-secondary inv-sheet-pack-btn"
                            data-cmd="inc-pack">📦 + 1 pack (${upp} ${_esc(unitLbl)}s)</button>` : ''}
            </div>

            ${tracksPct ? `
                <div class="inv-sheet-meter">
                    <input type="range" min="0" max="100" value="${pct}" step="5"
                           class="inv-sheet-slider" data-pct>
                    <div class="inv-sheet-pct" data-pct-display>${pct}%</div>
                </div>` : ''}

            <div class="inv-sheet-actions">
                <button type="button" class="inv-btn inv-btn-primary inv-btn-need"
                        data-cmd="need">🛒 Need this</button>
                <button type="button" class="inv-btn inv-btn-ghost"
                        data-cmd="edit">✎ Edit</button>
                <button type="button" class="inv-btn inv-btn-ghost inv-btn-danger-text"
                        data-cmd="delete">🗑 Delete</button>
            </div>

            ${it.expires_at ? `
                <div class="inv-sheet-meta">
                    <span class="inv-sheet-meta-label">Expires</span>
                    <span>${_esc(new Date(it.expires_at).toLocaleDateString())}</span>
                </div>` : ''}
            ${it.upc ? `
                <div class="inv-sheet-meta">
                    <span class="inv-sheet-meta-label">UPC</span>
                    <span class="inv-mono">${_esc(it.upc)}</span>
                </div>` : ''}
        `;

        if (tracksPct) {
            const slider  = this.$sheetCard.querySelector('[data-pct]');
            const display = this.$sheetCard.querySelector('[data-pct-display]');
            slider.addEventListener('input', () => { display.textContent = `${slider.value}%`; });
            slider.addEventListener('change', () => {
                this.store.setPercent(id, Number(slider.value)).catch(() => {});
            });
        }

        this.$sheetCard.querySelector('[data-cmd="dec"]')
            ?.addEventListener('click', () => this.store.consume(id).catch(() => {}));
        this.$sheetCard.querySelector('[data-cmd="inc"]')
            ?.addEventListener('click', () => this.store.restock(id).catch(() => {}));
        this.$sheetCard.querySelector('[data-cmd="inc-pack"]')
            ?.addEventListener('click', () => this.store.restockPacks(id, 1).catch(() => {}));
        this.$sheetCard.querySelector('[data-cmd="need"]')
            ?.addEventListener('click', () => this._needThis(it));
        this.$sheetCard.querySelector('[data-cmd="edit"]')
            ?.addEventListener('click', () => this._openItemModal({ mode: 'edit', itemId: id }));
        this.$sheetCard.querySelector('[data-cmd="delete"]')
            ?.addEventListener('click', () => this._deleteItem(it));

        // Direct qty edit — fires when user blurs / hits enter
        const $set = this.$sheetCard.querySelector('[data-qty-set]');
        $set?.addEventListener('change', () => {
            const v = Math.max(0, Math.round(Number($set.value) || 0));
            this.store.updateItem(id, { current_qty: v }).catch(() => {});
        });

        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));
    }

    async _needThis(it) {
        if (!it?.product_id) {
            alert('This item has no linked product — open Edit and pick a product first.');
            return;
        }
        try {
            await this.store.needProduct(it.product_id, { qty: 1 });
        } catch (err) {
            alert(err.message || 'Could not add to shopping list.');
        }
    }

    _closeSheet() {
        this.$sheet.classList.remove('open');
        setTimeout(() => { this.$sheet.hidden = true; }, 200);
    }

    // ── Barcode + Add stubs (Phase 2A) ───────────────────────────────────────

    async _openScanner() {
        if (!this._scanner) this._scanner = new BarcodeScanner();

        if (this._tab === 'list') {
            // ── List-tab scan ──────────────────────────────────────────────
            // "I'm in the kitchen, tossing something away — quick-add to list."
            // Find the product by UPC (already-known items) or scanner result,
            // then add to the shopping list. No inventory rows are touched.
            this._scanner.open('need', async (result) => {
                if (!result?.barcode) return;
                const p = result.product || {};

                // Already tracked in inventory? Use the known product_id.
                const invItem = (this.store.items || []).find(i => i.upc === result.barcode);
                if (invItem?.product_id) {
                    await this.store.needProduct(invItem.product_id, { qty: 1 }).catch(() => {});
                    this._renderShopping();
                    return;
                }

                // Already on shopping list? Just bump its qty.
                const shopItem = (this.store.shopping || []).find(i => i.upc === result.barcode);
                if (shopItem) {
                    await this.store.updateShopping(shopItem.id, {
                        qty: (Number(shopItem.qty) || 1) + 1,
                    }).catch(() => {});
                    this._renderShopping();
                    return;
                }

                // Completely unknown — add a bare shopping-list row.
                const name = p.name || result.barcode;
                await this.store.addShopping({
                    name,
                    brand:    p.brand || '',
                    qty:      1,
                    upc:      result.barcode,
                    image_url: p.imageUrl || '',
                }).catch(() => {});
                this._renderShopList();
            });
        } else {
            // ── Inventory restock scan ────────────────────────────────────
            // "Groceries just arrived — put them away."
            // If we already have an inventory lot for this UPC, add a full
            // pack worth of units. Otherwise open the Add modal pre-filled
            // with whatever the scanner resolved so the user can pick a location.
            this._scanner.open('restock', async (result) => {
                if (!result?.barcode) return;

                const existing = (this.store.items || []).find(i => i.upc === result.barcode);
                if (existing) {
                    await this.store.restockPacks(existing.id, 1).catch(() => {});
                    return;
                }
                const p = result.product || {};
                this._openItemModal({
                    mode: 'add',
                    prefill: {
                        upc:         result.barcode,
                        name:        p.name     || '',
                        brand:       p.brand    || '',
                        image_url:   p.imageUrl || '',
                        category_id: p.category || '',
                    },
                });
            });
        }
    }

    _openAddSheet(prefill = {}) {
        // Back-compat shim — manual + scan flows now share one modal.
        this._openItemModal({ mode: 'add', prefill });
    }

    // ── Add / Edit item modal ────────────────────────────────────────────────

    /**
     * One modal for create + edit + delete. Reuses the .inv-sheet drawer.
     *   { mode: 'add' | 'edit', prefill?: {...}, itemId?: string }
     * In edit mode we hydrate from the existing item by id (so changes from
     * other tabs / SSE win) and PATCH both the product (name/brand/category/
     * image/threshold) and the inventory row (location/qty/expires/notes) on
     * save. In add mode we POST to /items and the backend creates or links
     * the product from the upc.
     */
    _openItemModal({ mode = 'add', prefill = {}, itemId = null } = {}) {
        const isEdit = mode === 'edit' && itemId;
        const item   = isEdit ? this.store.items.find(i => i.id === itemId) : null;
        if (isEdit && !item) return;

        const locations  = this.store.config.locations || [];
        const categories = this.store.config.categories || [];
        if (!locations.length) {
            alert('No locations configured. Add one in settings first.');
            return;
        }

        // Field values: edit pulls from the existing item, add pulls from
        // prefill (which may itself be empty for a fully-manual add).
        const v = isEdit ? {
            name:        item.name        || '',
            brand:       item.brand       || '',
            upc:         item.upc         || '',
            image_url:   item.image_url   || '',
            category_id: item.category_id || '',
            location_id: item.location_id || locations[0].id,
            current_qty: item.qty_on_hand ?? 1,
            min_threshold: item.low_qty_threshold ?? 1,
            units_per_pack: item.units_per_pack ?? 1,
            count_unit:  item.count_unit || 'item',
            expires_at:  item.expires_at ? String(item.expires_at).slice(0, 10) : '',
            notes:       item.notes || '',
        } : {
            name:        prefill.name        || '',
            brand:       prefill.brand       || '',
            upc:         prefill.upc         || '',
            image_url:   prefill.image_url   || '',
            category_id: prefill.category_id || '',
            location_id: prefill.location_id || locations[0].id,
            current_qty: prefill.current_qty ?? 1,
            min_threshold: prefill.min_threshold ?? 1,
            units_per_pack: prefill.units_per_pack ?? 1,
            count_unit:  prefill.count_unit || 'item',
            expires_at:  prefill.expires_at  || '',
            notes:       prefill.notes       || '',
        };

        const title  = isEdit ? 'Edit Item' : 'Add Item';
        const photo  = v.image_url
            ? `<img class="inv-form-photo" src="${_esc(v.image_url)}" alt="">`
            : `<div class="inv-form-photo placeholder">📦</div>`;

        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <h2 class="inv-form-title">${title}</h2>

            <form class="inv-form" data-form novalidate>
                <div class="inv-form-head">
                    ${photo}
                    <div class="inv-form-head-fields">
                        <label class="inv-field">
                            <span class="inv-field-label">Name</span>
                            <input type="text" class="inv-input" name="name"
                                   value="${_esc(v.name)}" required autocomplete="off"
                                   placeholder="e.g. Cheerios">
                        </label>
                        <label class="inv-field">
                            <span class="inv-field-label">Brand</span>
                            <input type="text" class="inv-input" name="brand"
                                   value="${_esc(v.brand)}" autocomplete="off"
                                   placeholder="optional">
                        </label>
                    </div>
                </div>

                <div class="inv-form-grid">
                    <label class="inv-field">
                        <span class="inv-field-label">Location</span>
                        <select class="inv-input" name="location_id" required>
                            ${locations.map(l => `
                                <option value="${_esc(l.id)}"${l.id === v.location_id ? ' selected' : ''}>
                                    ${_esc(iconToEmoji(l.icon))} ${_esc(l.name)}
                                </option>`).join('')}
                        </select>
                    </label>

                    <label class="inv-field">
                        <span class="inv-field-label">Category</span>
                        <select class="inv-input" name="category_id">
                            <option value="">— None —</option>
                            ${categories.map(c => `
                                <option value="${_esc(c.id)}"${c.id === v.category_id ? ' selected' : ''}>
                                    ${_esc(iconToEmoji(c.icon))} ${_esc(c.name)}
                                </option>`).join('')}
                        </select>
                    </label>

                    <label class="inv-field">
                        <span class="inv-field-label">${isEdit ? 'On hand' : 'Initial qty'}</span>
                        <input type="number" class="inv-input" name="current_qty"
                               min="0" step="1" value="${Number(v.current_qty)}">
                    </label>

                    <label class="inv-field">
                        <span class="inv-field-label">Low at</span>
                        <input type="number" class="inv-input" name="min_threshold"
                               min="0" step="1" value="${Number(v.min_threshold)}">
                    </label>

                    <label class="inv-field">
                        <span class="inv-field-label">Units / pack</span>
                        <input type="number" class="inv-input" name="units_per_pack"
                               min="1" step="1" value="${Number(v.units_per_pack) || 1}"
                               title="How many individual units come in one purchased pack (e.g. 6 packets per box)">
                    </label>

                    <label class="inv-field">
                        <span class="inv-field-label">Unit name</span>
                        <input type="text" class="inv-input" name="count_unit"
                               value="${_esc(v.count_unit || 'item')}"
                               placeholder="packet, battery, can…"
                               title="What you call one individual unit">
                    </label>

                    <label class="inv-field inv-field-wide">
                        <span class="inv-field-label">Expires</span>
                        <input type="date" class="inv-input" name="expires_at"
                               value="${_esc(v.expires_at)}">
                    </label>
                </div>

                ${v.upc ? `
                    <div class="inv-form-meta">
                        <span class="inv-form-meta-label">UPC</span>
                        <span class="inv-mono">${_esc(v.upc)}</span>
                        ${!isEdit ? `
                            <button type="button" class="inv-btn inv-btn-ghost inv-btn-tiny"
                                    data-form-link aria-label="Link this barcode to an existing product">
                                🔗 Link to existing…
                            </button>` : ''}
                    </div>` : ''}

                <div class="inv-form-actions">
                    ${isEdit ? `
                        <div class="inv-form-actions-left">
                            <button type="button" class="inv-btn inv-btn-danger" data-form-delete>
                                🗑 Delete
                            </button>
                            <button type="button" class="inv-btn inv-btn-ghost" data-form-merge>
                                ⇨ Merge into…
                            </button>
                        </div>` : '<span></span>'}
                    <div class="inv-form-actions-right">
                        <button type="button" class="inv-btn inv-btn-secondary" data-sheet-close>Cancel</button>
                        <button type="submit" class="inv-btn inv-btn-primary">
                            ${isEdit ? '💾 Save' : '＋ Add'}
                        </button>
                    </div>
                </div>
            </form>
        `;

        const $form = this.$sheetCard.querySelector('[data-form]');
        $form.addEventListener('submit', e => {
            e.preventDefault();
            this._submitItemForm($form, { isEdit, item, prefill });
        });

        if (isEdit) {
            this.$sheetCard.querySelector('[data-form-delete]')
                ?.addEventListener('click', () => this._deleteItem(item));
            this.$sheetCard.querySelector('[data-form-merge]')
                ?.addEventListener('click', () => this._mergeItem(item));
        } else {
            this.$sheetCard.querySelector('[data-form-link]')
                ?.addEventListener('click', () => this._linkScannedBarcode(v.upc));
        }

        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));
        // Focus name field on add (skip on edit so we don't steal scroll on phones)
        if (!isEdit) setTimeout(() => $form.querySelector('[name="name"]')?.focus(), 220);
    }

    async _submitItemForm($form, { isEdit, item, prefill }) {
        const data = Object.fromEntries(new FormData($form));
        const name = (data.name || '').trim();
        if (!name) {
            $form.querySelector('[name="name"]')?.focus();
            return;
        }

        const submitBtn = $form.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

        try {
            if (isEdit) {
                // Patch product (name/brand/category/threshold) AND the inventory
                // row (location/qty/expires/notes). Two requests, but each is
                // a no-op if nothing changed for that side.
                const productPatch = {
                    name,
                    brand:        data.brand || '',
                    category_id:  data.category_id || null,
                    min_threshold: Number(data.min_threshold) || 1,
                    units_per_pack: Math.max(1, Number(data.units_per_pack) || 1),
                    count_unit:   (data.count_unit || 'item').trim() || 'item',
                };
                const itemPatch = {
                    location_id:  data.location_id,
                    current_qty:  Number(data.current_qty) || 0,
                    expires_at:   data.expires_at || null,
                };
                await Promise.all([
                    item.product_id
                        ? this.store.updateProduct(item.product_id, productPatch).catch(() => {})
                        : Promise.resolve(),
                    this.store.updateItem(item.id, itemPatch),
                ]);
            } else {
                await this.store.addInventory({
                    name,
                    brand:        data.brand || '',
                    category_id:  data.category_id || null,
                    image_url:    prefill.image_url || '',
                    upc:          prefill.upc || '',
                    location_id:  data.location_id,
                    current_qty:  Number(data.current_qty) || 1,
                    min_threshold: Number(data.min_threshold) || 1,
                    units_per_pack: Math.max(1, Number(data.units_per_pack) || 1),
                    count_unit:   (data.count_unit || 'item').trim() || 'item',
                    expires_at:   data.expires_at || null,
                });
            }
            this._closeSheet();
        } catch (err) {
            alert(err.message || 'Save failed.');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = isEdit ? '💾 Save' : '＋ Add';
            }
        }
    }

    async _deleteItem(item) {
        const ok = await this._confirm({
            title: 'Delete this item?',
            body:  `"${item.name || 'this item'}" will be removed from your inventory. This can't be undone.`,
            confirmLabel: '🗑 Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            await this.store.deleteItem(item.id);
            this._closeSheet();
        } catch (err) {
            alert(err.message || 'Delete failed.');
        }
    }

    // ── Pull from meal plan ──────────────────────────────────────────────────

    /**
     * Open a modal that walks this week's meal plan, collects every linked
     * recipe's ingredients, dedupes them, and lets the user pick which ones to
     * push to the shopping list.
     */
    async _openMealPlanImport() {
        const mealStore   = window.mealPlanner?.store;
        const recipeStore = window.recipeApp?.store;

        // Initial loading frame
        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <h2 class="inv-form-title">📅 From Meal Plan</h2>
            <div class="inv-mp-loading">Reading this week's meals…</div>
        `;
        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));

        if (!mealStore || !recipeStore) {
            this.$sheetCard.querySelector('.inv-mp-loading').textContent =
                'Meal Planner or Recipes app is not loaded.';
            return;
        }

        const today    = new Date();
        const weekKey  = isoWeek(today);
        const dates    = weekDates(today);
        // Make sure we have the latest data from HA — cached if offline
        const fresh = await mealStore.fetchFromHA(weekKey).catch(() =>
            mealStore.loadCached(weekKey));
        const weekData = fresh || mealStore.loadCached(weekKey);

        const DAYS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const MEAL  = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
        const map   = new Map(); // key (lowercased name) → { name, amount, unit, sources:Set, alreadyOnList }

        const existingNames = new Set(
            (this.store.shopping || [])
                .filter(s => s.status !== 'bought')
                .map(s => (s.name || '').toLowerCase().trim())
        );

        for (let i = 0; i < 7; i++) {
            const dayData = weekData[i] || weekData[String(i)] || {};
            for (const [mealType, meal] of Object.entries(dayData)) {
                if (!meal?.recipeSlug) continue;
                let recipe = recipeStore.loadCachedRecipe?.(meal.recipeSlug);
                if (!recipe) {
                    try { recipe = await recipeStore.fetchRecipe(meal.recipeSlug); }
                    catch { continue; }
                }
                if (!recipe?.ingredients?.length) continue;
                const dayLabel = `${DAYS[dates[i]?.getDay?.() ?? i]} ${MEAL[mealType] || mealType}`;
                for (const ing of recipe.ingredients) {
                    const name = (ing?.name || '').trim();
                    if (!name) continue;
                    const key = name.toLowerCase();
                    if (!map.has(key)) {
                        map.set(key, {
                            name, amount: ing.amount || '', unit: ing.unit || '',
                            sources: new Set(), alreadyOnList: existingNames.has(key),
                        });
                    }
                    map.get(key).sources.add(`${recipe.name || 'Recipe'} · ${dayLabel}`);
                }
            }
        }

        const all = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
        if (!all.length) {
            this.$sheetCard.innerHTML = `
                <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
                <h2 class="inv-form-title">📅 From Meal Plan</h2>
                <div class="inv-set-empty">
                    No linked recipes found for this week.<br>
                    Plan some meals (with recipes attached) first.
                </div>
            `;
            return;
        }

        const rowsHtml = all.map((ing, idx) => {
            const amt = [ing.amount, ing.unit].filter(Boolean).join(' ');
            const srcList = [...ing.sources].slice(0, 3).join(' • ');
            return `
                <label class="inv-mp-row${ing.alreadyOnList ? ' already' : ''}">
                    <input type="checkbox" class="inv-mp-check" data-idx="${idx}"
                           ${ing.alreadyOnList ? 'disabled' : 'checked'}>
                    <div class="inv-mp-body">
                        <div class="inv-mp-name">${_esc(ing.name)}
                            ${amt ? `<span class="inv-mp-amt">${_esc(amt)}</span>` : ''}
                            ${ing.alreadyOnList ? `<span class="inv-mp-already">✓ on list</span>` : ''}
                        </div>
                        <div class="inv-mp-src">${_esc(srcList)}</div>
                    </div>
                </label>
            `;
        }).join('');

        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <h2 class="inv-form-title">📅 From Meal Plan</h2>
            <p class="inv-set-hint">
                Found <strong>${all.length}</strong> ingredient${all.length === 1 ? '' : 's'} this week.
                Items already on your list are pre-disabled.
            </p>
            <div class="inv-mp-controls">
                <button type="button" class="inv-btn inv-btn-ghost inv-btn-tiny" data-mp-all>☑ Select all</button>
                <button type="button" class="inv-btn inv-btn-ghost inv-btn-tiny" data-mp-none>☐ Deselect</button>
            </div>
            <div class="inv-mp-list">${rowsHtml}</div>
            <div class="inv-form-actions">
                <span></span>
                <div class="inv-form-actions-right">
                    <button type="button" class="inv-btn inv-btn-secondary" data-sheet-close>Cancel</button>
                    <button type="button" class="inv-btn inv-btn-primary" data-mp-add>＋ Add selected</button>
                </div>
            </div>
        `;

        const $list = this.$sheetCard.querySelector('.inv-mp-list');
        this.$sheetCard.querySelector('[data-mp-all]').addEventListener('click', () => {
            $list.querySelectorAll('.inv-mp-check:not([disabled])').forEach(cb => cb.checked = true);
        });
        this.$sheetCard.querySelector('[data-mp-none]').addEventListener('click', () => {
            $list.querySelectorAll('.inv-mp-check:not([disabled])').forEach(cb => cb.checked = false);
        });
        this.$sheetCard.querySelector('[data-mp-add]').addEventListener('click', async (e) => {
            const $btn = e.currentTarget;
            const checks = $list.querySelectorAll('.inv-mp-check:not([disabled])');
            const picks = [];
            checks.forEach(cb => {
                if (cb.checked) {
                    const ing = all[Number(cb.dataset.idx)];
                    if (ing) picks.push(ing);
                }
            });
            if (!picks.length) { this._closeSheet(); return; }
            $btn.disabled = true; $btn.textContent = `Adding ${picks.length}…`;
            let added = 0;
            for (const ing of picks) {
                const amt = [ing.amount, ing.unit].filter(Boolean).join(' ');
                try {
                    await this.store.addShopping({
                        name:  ing.name,
                        qty:   1,
                        notes: amt ? `Meal plan · ${amt}` : 'Meal plan',
                    });
                    added++;
                } catch { /* keep going */ }
            }
            this._closeSheet();
            if (added < picks.length) {
                alert(`Added ${added} of ${picks.length} — some failed to save.`);
            }
        });
    }

    // ── Tri-state shopping: stock-to-inventory ───────────────────────────────

    async _stockShoppingRow(sid) {
        const row = (this.store.shopping || []).find(s => s.id === sid);
        if (!row) return;
        const locations = this.store.config.locations || [];
        if (!locations.length) {
            alert('No locations configured. Add one in Settings first.');
            return;
        }
        const defaultLoc = locations[0].id;
        const loc = await this._pickLocation({
            title: `Stock "${row.name}" to…`,
            defaultId: defaultLoc,
            qty: row.qty || 1,
        });
        if (!loc) return;
        try {
            await this.store.stockShopping(sid, {
                location_id: loc.location_id,
                current_qty: loc.qty,
            });
        } catch (err) {
            alert(err.message || 'Stock failed.');
        }
    }

    /** Mini modal to pick location + qty before stocking. */
    _pickLocation({ title, defaultId, qty = 1 } = {}) {
        const locations = this.store.config.locations || [];
        return new Promise(resolve => {
            const prevHTML = this.$sheetCard.innerHTML;
            const wasOpen  = !this.$sheet.hidden;
            this.$sheetCard.innerHTML = `
                <button type="button" class="inv-sheet-close" data-stock-cancel aria-label="Close">×</button>
                <h2 class="inv-form-title">${_esc(title || 'Stock to inventory')}</h2>
                <form class="inv-form" data-stock-form novalidate>
                    <div class="inv-form-grid">
                        <label class="inv-field">
                            <span class="inv-field-label">Location</span>
                            <select class="inv-input" name="location_id" required>
                                ${locations.map(l => `
                                    <option value="${_esc(l.id)}"${l.id === defaultId ? ' selected' : ''}>
                                        ${_esc(iconToEmoji(l.icon))} ${_esc(l.name)}
                                    </option>`).join('')}
                            </select>
                        </label>
                        <label class="inv-field">
                            <span class="inv-field-label">Quantity</span>
                            <input type="number" class="inv-input" name="qty"
                                   min="0" step="1" value="${Number(qty)}">
                        </label>
                    </div>
                    <div class="inv-form-actions">
                        <span></span>
                        <div class="inv-form-actions-right">
                            <button type="button" class="inv-btn inv-btn-secondary" data-stock-cancel>Cancel</button>
                            <button type="submit" class="inv-btn inv-btn-primary">📥 Stock it</button>
                        </div>
                    </div>
                </form>
            `;
            const finish = (val) => {
                if (wasOpen) this.$sheetCard.innerHTML = prevHTML;
                else         this._closeSheet();
                resolve(val);
            };
            const $form = this.$sheetCard.querySelector('[data-stock-form]');
            $form.addEventListener('submit', e => {
                e.preventDefault();
                const data = Object.fromEntries(new FormData($form));
                finish({
                    location_id: data.location_id,
                    qty:         Number(data.qty) || 1,
                });
            });
            this.$sheetCard.querySelectorAll('[data-stock-cancel]').forEach(b =>
                b.addEventListener('click', () => finish(null)));
            if (!wasOpen) {
                this.$sheet.hidden = false;
                requestAnimationFrame(() => this.$sheet.classList.add('open'));
            }
        });
    }

    // ── Generic products: link scanned UPC / merge ───────────────────────────

    /**
     * Open a searchable product picker. Resolves to the chosen product id, or
     * null if the user cancels. excludeId hides one row (used by merge so you
     * can't merge a product into itself).
     */
    async _openProductPicker({ title = 'Pick a product', excludeId = null,
                               confirmLabel = 'Choose' } = {}) {
        // Make sure we have the products list. The store fetches lazily.
        try { await this.store.loadProducts(); } catch { /* fall through */ }
        const all = (this.store.products || [])
            .filter(p => p.id !== excludeId)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        return new Promise(resolve => {
            const prevHTML = this.$sheetCard.innerHTML;
            const wasOpen  = !this.$sheet.hidden;
            const renderRows = (q) => {
                const ql = (q || '').trim().toLowerCase();
                const rows = ql
                    ? all.filter(p => `${p.name || ''} ${p.brand || ''}`.toLowerCase().includes(ql))
                    : all;
                return rows.length ? rows.slice(0, 200).map(p => `
                    <button type="button" class="inv-pick-row" data-pick="${_esc(p.id)}">
                        ${p.image_url
                            ? `<img class="inv-pick-img" src="${_esc(p.image_url)}" alt="" loading="lazy">`
                            : `<div class="inv-pick-img placeholder">📦</div>`}
                        <div class="inv-pick-body">
                            <div class="inv-pick-name">${_esc(p.name || 'Unnamed')}</div>
                            <div class="inv-pick-sub">${_esc(p.brand || '')}</div>
                        </div>
                    </button>
                `).join('') : `<div class="inv-set-empty">No matches.</div>`;
            };

            this.$sheetCard.innerHTML = `
                <button type="button" class="inv-sheet-close" data-pick-cancel aria-label="Close">×</button>
                <h2 class="inv-form-title">${_esc(title)}</h2>
                <label class="inv-field">
                    <span class="inv-field-label">Search</span>
                    <input type="search" class="inv-input" data-pick-search
                           placeholder="Type a name or brand…" autocomplete="off">
                </label>
                <div class="inv-pick-list" data-pick-list>${renderRows('')}</div>
                <div class="inv-form-actions">
                    <span></span>
                    <div class="inv-form-actions-right">
                        <button type="button" class="inv-btn inv-btn-secondary" data-pick-cancel>Cancel</button>
                    </div>
                </div>
            `;

            const finish = (id) => {
                if (wasOpen) this.$sheetCard.innerHTML = prevHTML;
                else         this._closeSheet();
                resolve(id);
            };
            const $list   = this.$sheetCard.querySelector('[data-pick-list]');
            const $search = this.$sheetCard.querySelector('[data-pick-search]');
            $search.addEventListener('input', () => { $list.innerHTML = renderRows($search.value); });
            $list.addEventListener('click', e => {
                const btn = e.target.closest('[data-pick]');
                if (btn) finish(btn.dataset.pick);
            });
            this.$sheetCard.querySelectorAll('[data-pick-cancel]').forEach(b =>
                b.addEventListener('click', () => finish(null)));
            if (!wasOpen) {
                this.$sheet.hidden = false;
                requestAnimationFrame(() => this.$sheet.classList.add('open'));
            }
            setTimeout(() => $search.focus(), 220);
        });
    }

    async _linkScannedBarcode(upc) {
        if (!upc) return;
        const pid = await this._openProductPicker({
            title: `Link UPC ${upc} to…`,
            confirmLabel: 'Link',
        });
        if (!pid) return;
        try {
            await this.store.linkBarcode(upc, pid);
            // Re-open Add modal pre-filled with the chosen product so the user
            // can pick a location and qty for the new inventory row.
            const p = (this.store.products || []).find(x => x.id === pid) || {};
            this._openItemModal({
                mode: 'add',
                prefill: {
                    upc,
                    name:        p.name      || '',
                    brand:       p.brand     || '',
                    image_url:   p.image_url || '',
                    category_id: p.category_id || '',
                },
            });
        } catch (err) {
            alert(err.message || 'Link failed.');
        }
    }

    async _mergeItem(item) {
        if (!item?.product_id) {
            alert('This item has no linked product to merge.');
            return;
        }
        const dst = await this._openProductPicker({
            title: `Merge "${item.name}" into…`,
            excludeId: item.product_id,
            confirmLabel: 'Merge',
        });
        if (!dst) return;
        const ok = await this._confirm({
            title: 'Merge products?',
            body:  `All inventory, history, shopping entries, and barcodes from "${item.name}" will move to the chosen product. This can't be undone.`,
            confirmLabel: '⇨ Merge',
            danger: true,
        });
        if (!ok) return;
        try {
            await this.store.mergeProducts(item.product_id, dst);
            this._closeSheet();
        } catch (err) {
            alert(err.message || 'Merge failed.');
        }
    }

    // ── Settings: locations / categories / stores CRUD ───────────────────────

    _openSettings(initialTab = 'locations') {
        this._renderSettings(initialTab);
        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));
    }

    _renderSettings(activeTab) {
        const tab = activeTab || this._settingsTab || 'locations';
        this._settingsTab = tab;

        const tabsHtml = ['locations', 'categories', 'stores'].map(t => `
            <button type="button" class="inv-set-tab${t === tab ? ' active' : ''}"
                    data-set-tab="${t}">
                ${t === 'locations' ? '📍 Locations'
                  : t === 'categories' ? '🏷 Categories'
                  : '🏪 Stores'}
            </button>
        `).join('');

        const rows = (tab === 'locations' ? this.store.config.locations
                    : tab === 'categories' ? this.store.config.categories
                    : this.store.config.stores) || [];

        const rowsHtml = rows.length ? rows.map(r => `
            <div class="inv-set-row" data-set-id="${_esc(r.id)}">
                <span class="inv-set-emoji">${_esc(iconToEmoji(r.icon))}</span>
                <input type="text" class="inv-input inv-set-name" value="${_esc(r.name)}"
                       data-set-name="${_esc(r.id)}">
                <input type="color" class="inv-set-color" value="${_esc(r.color || '#888888')}"
                       data-set-color="${_esc(r.id)}" title="Color">
                <input type="number" class="inv-input inv-set-sort" value="${Number(r.sort_order || 0)}"
                       data-set-sort="${_esc(r.id)}" title="Sort order" min="0">
                <button type="button" class="inv-icon-btn" data-set-save="${_esc(r.id)}"
                        title="Save changes">💾</button>
                <button type="button" class="inv-icon-btn danger" data-set-delete="${_esc(r.id)}"
                        title="Delete">🗑</button>
            </div>
        `).join('') : `<div class="inv-set-empty">No ${tab} yet — add one below.</div>`;

        this.$sheetCard.innerHTML = `
            <button type="button" class="inv-sheet-close" data-sheet-close aria-label="Close">×</button>
            <h2 class="inv-form-title">Inventory Settings</h2>
            <div class="inv-set-tabs">${tabsHtml}</div>
            <div class="inv-set-list">${rowsHtml}</div>
            <form class="inv-set-add" data-set-add novalidate>
                <input type="text" class="inv-input" name="emoji"
                       placeholder="🥫" maxlength="3" style="max-width:60px">
                <input type="text" class="inv-input" name="name" required
                       placeholder="New ${tab.slice(0, -1)} name…">
                <input type="color" class="inv-set-color" name="color" value="#4a90e2">
                <button type="submit" class="inv-btn inv-btn-primary">＋ Add</button>
            </form>
            <p class="inv-set-hint">Save with 💾. Delete is blocked while items still reference a location, but a category/store with rows that depend on it will be unlinked.</p>
        `;

        // Wire tab switching
        this.$sheetCard.querySelectorAll('[data-set-tab]').forEach(b =>
            b.addEventListener('click', () => this._renderSettings(b.dataset.setTab)));

        // Wire row save/delete
        this.$sheetCard.querySelectorAll('[data-set-save]').forEach(b =>
            b.addEventListener('click', () => this._settingsSave(tab, b.dataset.setSave)));
        this.$sheetCard.querySelectorAll('[data-set-delete]').forEach(b =>
            b.addEventListener('click', () => this._settingsDelete(tab, b.dataset.setDelete)));

        // Wire add form
        this.$sheetCard.querySelector('[data-set-add]')
            .addEventListener('submit', e => { e.preventDefault(); this._settingsAdd(tab, e.target); });
    }

    async _settingsSave(tab, id) {
        const $row = this.$sheetCard.querySelector(`.inv-set-row[data-set-id="${CSS.escape(id)}"]`);
        if (!$row) return;
        const patch = {
            name:       $row.querySelector('[data-set-name]').value.trim(),
            color:      $row.querySelector('[data-set-color]').value,
            sort_order: Number($row.querySelector('[data-set-sort]').value) || 0,
        };
        if (!patch.name) return;
        const fn = tab === 'locations' ? this.store.updateLocation
                 : tab === 'categories' ? this.store.updateCategory
                 : this.store.updateStore;
        try {
            await fn.call(this.store, id, patch);
            // SSE will trigger config re-fetch which re-renders
        } catch (err) {
            alert(err.message || 'Save failed.');
        }
    }

    async _settingsDelete(tab, id) {
        const list = (tab === 'locations' ? this.store.config.locations
                    : tab === 'categories' ? this.store.config.categories
                    : this.store.config.stores) || [];
        const row = list.find(r => r.id === id);
        const ok = await this._confirm({
            title: `Delete "${row?.name || id}"?`,
            body:  tab === 'locations'
                ? 'You can only delete an empty location — move or remove its items first.'
                : 'Items currently using this will simply lose the link.',
            confirmLabel: '🗑 Delete',
            danger: true,
        });
        if (!ok) { this._renderSettings(tab); return; }
        const fn = tab === 'locations' ? this.store.deleteLocation
                 : tab === 'categories' ? this.store.deleteCategory
                 : this.store.deleteStore;
        try {
            await fn.call(this.store, id);
            this._renderSettings(tab);
        } catch (err) {
            alert(err.message || 'Delete failed.');
            this._renderSettings(tab);
        }
    }

    async _settingsAdd(tab, form) {
        const data  = Object.fromEntries(new FormData(form));
        const name  = (data.name || '').trim();
        if (!name) return;
        const emoji = (data.emoji || '').trim();
        const payload = {
            name,
            color: data.color || '#888888',
            // If they typed an emoji, store it as-is. Otherwise leave the
            // backend default (e.g. mdi:store) which the iconToEmoji map
            // covers for the seeded items.
            ...(emoji ? { icon: emoji } : {}),
        };
        const fn = tab === 'locations' ? this.store.addLocation
                 : tab === 'categories' ? this.store.addCategory
                 : this.store.addStore;
        try {
            await fn.call(this.store, payload);
            form.reset();
            // Wait for SSE-driven config refresh, then re-render
            setTimeout(() => this._renderSettings(tab), 200);
        } catch (err) {
            alert(err.message || 'Add failed.');
        }
    }

    /**
     * Promise-based confirm modal that matches the rest of the inventory UI
     * (the native window.confirm looked out of place). Resolves to true if
     * the user clicks the confirm button, false on cancel / backdrop / Esc.
     */
    _confirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise(resolve => {
            // Reuse the existing sheet so we get its backdrop, animation,
            // and Esc-to-close wiring for free.
            const prevHTML = this.$sheetCard.innerHTML;
            const wasOpen  = !this.$sheet.hidden;
            this.$sheetCard.innerHTML = `
                <div class="inv-confirm">
                    <h2 class="inv-confirm-title">${_esc(title || 'Are you sure?')}</h2>
                    ${body ? `<p class="inv-confirm-body">${_esc(body)}</p>` : ''}
                    <div class="inv-confirm-actions">
                        <button type="button" class="inv-btn inv-btn-secondary" data-confirm-cancel>
                            ${_esc(cancelLabel)}
                        </button>
                        <button type="button" class="inv-btn ${danger ? 'inv-btn-danger' : 'inv-btn-primary'}"
                                data-confirm-ok>
                            ${_esc(confirmLabel)}
                        </button>
                    </div>
                </div>
            `;
            const finish = (result) => {
                if (wasOpen) {
                    // Restore the previous sheet contents (e.g. detail sheet)
                    this.$sheetCard.innerHTML = prevHTML;
                } else {
                    this._closeSheet();
                }
                resolve(result);
            };
            this.$sheetCard.querySelector('[data-confirm-ok]')
                .addEventListener('click', () => finish(true));
            this.$sheetCard.querySelector('[data-confirm-cancel]')
                .addEventListener('click', () => finish(false));
            if (!wasOpen) {
                this.$sheet.hidden = false;
                requestAnimationFrame(() => this.$sheet.classList.add('open'));
            }
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
