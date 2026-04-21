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
    if (item.percent != null) return Math.max(0, Math.min(100, item.percent));
    // No percent set — derive from qty vs par_qty (target on-hand quantity).
    const par = item.par_qty || item.low_qty_threshold || 1;
    return Math.max(0, Math.min(100, Math.round((item.qty_on_hand / par) * 100)));
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
        this._location = 'all';   // location id | 'all'
        this._filter   = 'all';   // 'all' | 'low' | 'expiring' | 'out'
        this._search   = '';

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
                <div class="inv-actions">
                    <button type="button" class="inv-btn inv-btn-secondary" data-action="scan">
                        <span class="inv-btn-icon">📷</span> Scan
                    </button>
                    <button type="button" class="inv-btn inv-btn-primary" data-action="add">
                        <span class="inv-btn-icon">＋</span> Add Item
                    </button>
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
            .addEventListener('click', () => this._openAddSheet());

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
            this.store.on('config', () => { this._renderLocations(); this._renderGrid(); }),
            this.store.on('items',  () => { this._renderGrid(); this._renderStats(); }),
            this.store.on('stats',  () => this._renderStats()),
        ];
        this._renderLocations();
        this._renderStats();
        this._renderGrid();
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
            // it in place. Otherwise pre-fill the add sheet with whatever
            // the scanner already resolved (no need to re-hit /scan).
            const existing = (this.store.items || []).find(i => i.upc === result.barcode);
            if (existing) {
                await this.store.restock(existing.id).catch(() => {});
                return;
            }
            const p = result.product || {};
            this._openAddSheet({
                upc:       result.barcode,
                name:      p.name  || '',
                brand:     p.brand || '',
                image_url: p.imageUrl || '',
            });
        });
    }

    _openAddSheet(prefill = {}) {
        // Placeholder for Phase 2B — for now surface a simple prompt so the
        // wall tablet can still capture a quick addition.
        const name = window.prompt('Item name', prefill.name || '');
        if (!name) return;
        const locId = this.store.config.locations[0]?.id;
        if (!locId) {
            alert('No locations configured.');
            return;
        }
        this.store.addInventory({
            name,
            brand:     prefill.brand || '',
            upc:       prefill.upc || '',
            image_url: prefill.image_url || '',
            location_id: locId,
            qty_on_hand: 1,
        }).catch(err => alert(err.message));
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
