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
import { apiUrl } from './utils.js';

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
    const pct = Number(item?.percent);
    if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
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
        this._mode     = 'inventory'; // 'inventory' | 'shopping'
        this._location = 'all';   // location id | 'all'
        this._filter   = 'all';   // 'all' | 'low' | 'expiring' | 'out'
        this._search   = '';
        this._shopStore = 'all';  // store id | 'all'

        // Lazy-constructed scanner
        this._scanner = null;

        this._renderShell();
        this._bindStore();
    }

    // ── Initial DOM scaffold ─────────────────────────────────────────────────

    _renderShell() {
        this.container.classList.add('inv');
        this.container.innerHTML = `
            <div class="inv-topbar">
                <div class="inv-family"></div>
                <div class="inv-modes" data-modes>
                    <button type="button" class="inv-mode active" data-mode="inventory">📦 Inventory</button>
                    <button type="button" class="inv-mode" data-mode="shopping">🛒 Shopping</button>
                </div>
                <div class="inv-actions">
                    <button type="button" class="inv-btn inv-btn-secondary" data-action="scan">
                        <span class="inv-btn-icon">📷</span> Scan
                    </button>
                    <button type="button" class="inv-btn inv-btn-primary" data-action="add">
                        <span class="inv-btn-icon">＋</span> Add Item
                    </button>
                    <button type="button" class="inv-btn inv-btn-secondary inv-btn-icon-only"
                            data-action="settings" aria-label="Inventory settings" title="Settings">⚙</button>
                </div>
            </div>

            <div class="inv-searchrow">
                <label class="inv-search">
                    <span class="inv-search-icon" aria-hidden="true">🔍</span>
                    <input type="search" class="inv-search-input"
                           placeholder="Search items, brands, categories…" autocomplete="off">
                </label>
                <div class="inv-stats" data-stats-rail></div>
            </div>

            <nav class="inv-loctabs" data-loctabs></nav>

            <div class="inv-filters" data-filters>
                <button class="inv-chip active" data-filter="all">All</button>
                <button class="inv-chip" data-filter="low">Low Stock</button>
                <button class="inv-chip" data-filter="expiring">Expiring</button>
                <button class="inv-chip" data-filter="out">Out</button>
            </div>

            <div class="inv-grid" data-grid>
                <div class="inv-empty" data-empty hidden>
                    <div class="inv-empty-icon">📦</div>
                    <div class="inv-empty-title">Nothing here yet</div>
                    <div class="inv-empty-sub">Scan a barcode or tap <strong>Add Item</strong> to get started.</div>
                </div>
            </div>

            <!-- Shopping list panel (hidden in inventory mode) -->
            <div class="inv-shop" data-shop hidden>
                <div class="inv-shop-toolbar">
                    <label class="inv-field inv-field-wide">
                        <span class="inv-field-label">Store</span>
                        <select class="inv-input" data-shop-store>
                            <option value="all">All stores</option>
                        </select>
                    </label>
                </div>
                <div class="inv-shop-list" data-shop-list>
                    <div class="inv-empty" data-shop-empty hidden>
                        <div class="inv-empty-icon">🛒</div>
                        <div class="inv-empty-title">Shopping list is empty</div>
                        <div class="inv-empty-sub">Items appear here when stock falls below the minimum, or add one with <strong>＋ Add Item</strong>.</div>
                    </div>
                </div>
            </div>

            <!-- Item detail sheet (bottom drawer on phone, centre modal on tablet) -->
            <div class="inv-sheet" data-sheet hidden>
                <div class="inv-sheet-backdrop" data-sheet-close></div>
                <div class="inv-sheet-card" data-sheet-card></div>
            </div>
        `;

        // Cache refs
        this.$family   = this.container.querySelector('.inv-family');
        this.$stats    = this.container.querySelector('[data-stats-rail]');
        this.$loctabs  = this.container.querySelector('[data-loctabs]');
        this.$filters  = this.container.querySelector('[data-filters]');
        this.$grid     = this.container.querySelector('[data-grid]');
        this.$empty    = this.container.querySelector('[data-empty]');
        this.$sheet    = this.container.querySelector('[data-sheet]');
        this.$sheetCard = this.container.querySelector('[data-sheet-card]');
        this.$search   = this.container.querySelector('.inv-search-input');
        this.$modes    = this.container.querySelector('[data-modes]');
        this.$shop     = this.container.querySelector('[data-shop]');
        this.$shopList = this.container.querySelector('[data-shop-list]');
        this.$shopEmpty = this.container.querySelector('[data-shop-empty]');
        this.$shopStore = this.container.querySelector('[data-shop-store]');

        // Mount family picker
        this._picker = new FamilyPicker(this.store);
        this.$family.appendChild(this._picker.el);

        // ── Wire interactions ────────────────────────────────────────────────

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

        this.container.querySelector('[data-action="scan"]')
            .addEventListener('click', () => this._openScanner());
        this.container.querySelector('[data-action="add"]')
            .addEventListener('click', () => {
                if (this._mode === 'shopping') this._openShoppingAddModal();
                else this._openAddSheet();
            });
        this.container.querySelector('[data-action="settings"]')
            .addEventListener('click', () => this._openSettings());

        this.$modes.addEventListener('click', e => {
            const btn = e.target.closest('.inv-mode');
            if (!btn) return;
            this._setMode(btn.dataset.mode);
        });

        this.$shopStore.addEventListener('change', () => {
            this._shopStore = this.$shopStore.value;
            this._renderShopping();
        });

        this.$shopList.addEventListener('click', e => {
            const checkBtn = e.target.closest('[data-shop-toggle]');
            const delBtn   = e.target.closest('[data-shop-delete]');
            if (checkBtn) {
                const id = checkBtn.dataset.shopToggle;
                const row = (this.store.shopping || []).find(s => s.id === id);
                const next = row?.status === 'bought' ? 'needed' : 'bought';
                this.store.updateShopping(id, { status: next }).catch(() => {});
            } else if (delBtn) {
                this.store.deleteShopping(delBtn.dataset.shopDelete).catch(() => {});
            }
        });

        this.$sheet.addEventListener('click', e => {
            if (e.target.matches('[data-sheet-close]')) this._closeSheet();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !this.$sheet.hidden) this._closeSheet();
        });

        // Delegated tile clicks
        this.$grid.addEventListener('click', e => {
            const btnDec = e.target.closest('[data-dec]');
            const btnInc = e.target.closest('[data-inc]');
            const tile   = e.target.closest('.inv-tile');
            if (btnDec) {
                e.stopPropagation();
                this.store.consume(btnDec.dataset.dec).catch(() => {});
            } else if (btnInc) {
                e.stopPropagation();
                this.store.restock(btnInc.dataset.inc).catch(() => {});
            } else if (tile) {
                this._openDetailSheet(tile.dataset.id);
            }
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
            this.store.on('items',    () => { this._renderGrid(); this._renderStats(); }),
            this.store.on('stats',    () => this._renderStats()),
            this.store.on('shopping', () => { this._renderStats(); this._renderShopping(); }),
            this.store.on('family',   () => this._renderShopping()),
        ];
        this._renderLocations();
        this._renderShopStores();
        this._renderStats();
        this._renderGrid();
        this._renderShopping();
    }

    _setMode(mode) {
        if (mode !== 'inventory' && mode !== 'shopping') return;
        this._mode = mode;
        this.$modes.querySelectorAll('.inv-mode').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === mode));
        const isShop = mode === 'shopping';
        this.container.classList.toggle('inv-shopping-mode', isShop);
        this.$shop.hidden = !isShop;
        // Hide inventory-only chrome
        this.$loctabs.hidden = isShop;
        this.$filters.hidden = isShop;
        this.$grid.hidden    = isShop;
        // Re-label primary action
        const $add = this.container.querySelector('[data-action="add"]');
        if ($add) $add.lastChild.textContent = isShop ? ' Add to List' : ' Add Item';
        // Hide Scan in shopping mode (not the right action there)
        const $scan = this.container.querySelector('[data-action="scan"]');
        if ($scan) $scan.hidden = isShop;
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
        const filtered = this._shopStore === 'all'
            ? all
            : all.filter(r => r.store_id === this._shopStore || !r.store_id);

        // Clear previous rows but keep empty state element
        this.$shopList.querySelectorAll('.inv-shop-row, .inv-shop-group').forEach(n => n.remove());

        if (!filtered.length) {
            this.$shopEmpty.hidden = false;
            return;
        }
        this.$shopEmpty.hidden = true;

        // Group by category, status (needed first), then name
        const groups = new Map();
        for (const row of filtered) {
            const key = row.category_name || 'Uncategorized';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }
        const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        const html = sortedGroups.map(([cat, rows]) => {
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

    _shopRowHtml(r) {
        const done = r.status === 'bought';
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
        const photo = r.product_image
            ? `<img class="inv-shop-img" src="${_esc(r.product_image)}" alt="" loading="lazy">`
            : `<div class="inv-shop-img placeholder">🛒</div>`;
        const qty = Number(r.qty) > 1 ? `×${Number(r.qty)}` : '';
        return `
            <div class="inv-shop-row${done ? ' done' : ''}">
                <button type="button" class="inv-shop-check" data-shop-toggle="${_esc(r.id)}"
                        aria-label="${done ? 'Mark needed' : 'Mark bought'}">
                    ${done ? '✓' : ''}
                </button>
                ${photo}
                <div class="inv-shop-body">
                    <div class="inv-shop-name">${_esc(r.name)} ${qty ? `<span class="inv-shop-qty">${qty}</span>` : ''}</div>
                    <div class="inv-shop-meta">
                        ${sourceBadge}
                        ${storeChip}
                        ${personChip}
                    </div>
                </div>
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
    }

    // ── Render: grid ─────────────────────────────────────────────────────────

    _renderGrid() {
        const items = this._visibleItems();
        if (!items.length) {
            this.$empty.hidden = false;
            // Clear previous tiles (but keep empty state)
            this.$grid.querySelectorAll('.inv-tile').forEach(n => n.remove());
            return;
        }
        this.$empty.hidden = true;

        const html = items.map(it => this._tileHtml(it)).join('');
        // Preserve empty state element; replace tiles only
        this.$grid.querySelectorAll('.inv-tile').forEach(n => n.remove());
        this.$empty.insertAdjacentHTML('beforebegin', html);
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

        const qtyLabel = it.unit === 'pct'
            ? `${pct}%`
            : `${it.qty_on_hand ?? 0}${it.unit ? ' ' + it.unit : ''}`;

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
                        <span class="inv-tile-qty">${_esc(qtyLabel)}</span>
                        <div class="inv-tile-actions">
                            <button type="button" class="inv-qbtn" data-dec="${_esc(it.id)}"
                                    aria-label="Consume one" ${it.qty_on_hand <= 0 ? 'disabled' : ''}>−</button>
                            <button type="button" class="inv-qbtn" data-inc="${_esc(it.id)}"
                                    aria-label="Restock one">+</button>
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

            <div class="inv-sheet-meter">
                <input type="range" min="0" max="100" value="${pct}" step="5"
                       class="inv-sheet-slider" data-pct>
                <div class="inv-sheet-pct" data-pct-display>${pct}%</div>
            </div>

            <div class="inv-sheet-actions">
                <button type="button" class="inv-btn inv-btn-secondary"
                        data-cmd="dec">− Consume</button>
                <button type="button" class="inv-btn inv-btn-primary"
                        data-cmd="inc">+ Restock</button>
            </div>

            <div class="inv-sheet-actions inv-sheet-actions-secondary">
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

        const slider  = this.$sheetCard.querySelector('[data-pct]');
        const display = this.$sheetCard.querySelector('[data-pct-display]');
        slider.addEventListener('input', () => {
            display.textContent = `${slider.value}%`;
        });
        slider.addEventListener('change', () => {
            this.store.setPercent(id, Number(slider.value)).catch(() => {});
        });

        this.$sheetCard.querySelector('[data-cmd="dec"]')
            .addEventListener('click', () => this.store.consume(id).catch(() => {}));
        this.$sheetCard.querySelector('[data-cmd="inc"]')
            .addEventListener('click', () => this.store.restock(id).catch(() => {}));
        this.$sheetCard.querySelector('[data-cmd="edit"]')
            ?.addEventListener('click', () => this._openItemModal({ mode: 'edit', itemId: id }));
        this.$sheetCard.querySelector('[data-cmd="delete"]')
            ?.addEventListener('click', () => this._deleteItem(it));

        this.$sheet.hidden = false;
        requestAnimationFrame(() => this.$sheet.classList.add('open'));
    }

    _closeSheet() {
        this.$sheet.classList.remove('open');
        setTimeout(() => { this.$sheet.hidden = true; }, 200);
    }

    // ── Barcode + Add stubs (Phase 2A) ───────────────────────────────────────

    async _openScanner() {
        if (!this._scanner) this._scanner = new BarcodeScanner();
        this._scanner.open('restock', async (result) => {
            if (!result?.barcode) return;

            // If we already have an inventory lot for this UPC, just restock
            // it in place. Otherwise open the Add modal pre-filled with
            // whatever the scanner resolved so the user can pick a location.
            const existing = (this.store.items || []).find(i => i.upc === result.barcode);
            if (existing) {
                await this.store.restock(existing.id).catch(() => {});
                return;
            }
            const p = result.product || {};
            this._openItemModal({
                mode: 'add',
                prefill: {
                    upc:       result.barcode,
                    name:      p.name  || '',
                    brand:     p.brand || '',
                    image_url: p.imageUrl || '',
                    category_id: p.category || '',
                },
            });
        });
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
                    </div>` : ''}

                <div class="inv-form-actions">
                    ${isEdit ? `
                        <button type="button" class="inv-btn inv-btn-danger" data-form-delete>
                            🗑 Delete
                        </button>` : '<span></span>'}
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
