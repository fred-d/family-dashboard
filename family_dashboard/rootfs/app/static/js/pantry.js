/**
 * pantry.js — Pantry App UI (Shopping List + Inventory)
 *
 * Resurrected from the original pantry.js (PR #23 deleted it). The original
 * design + UX are the foundation we're building forward from; only the data
 * layer is being modernised. The Requests tab has been removed per product
 * direction.
 *
 * Tabs (in display order):
 *  🛒 Shopping List — active list, grouped by category, with progress
 *  📦 Inventory     — pantry stock with status (ok / low / out)
 *
 * Overlays:
 *  🏪 Store Mode      — full-screen in-store shopping view (touch-optimised)
 *  ➕ Item Modal      — add / edit a shopping list item
 *  📦 Inventory Modal — add / edit a pantry inventory item
 *  📅 Meal Plan Modal — import ingredients from this week's meal plan
 *
 * NOT WIRED YET — this file is dormant on master until the live app is
 * switched over (PR C). PR A merely restores it. PR B repoints the
 * companion store at the SQLite backend. PR D renames backend routes for
 * naming consistency.
 */
import { isoWeek, weekDates, formatWeekRange } from './utils.js';
import { BarcodeScanner } from './scanner.js?v=5';

// ── Constants ─────────────────────────────────────────────────────────────────

// FAMILY_MEMBERS is now loaded dynamically from HA via /api/pantry/family.
// The constant below is kept only as a last-resort fallback (e.g. HA offline).
const FAMILY_MEMBERS_FALLBACK = [];

const CATEGORIES = [
    { id: 'produce',   label: 'Produce',        emoji: '🥦', color: '#16a34a' },
    { id: 'dairy',     label: 'Dairy & Eggs',   emoji: '🥛', color: '#0ea5e9' },
    { id: 'meat',      label: 'Meat & Seafood', emoji: '🥩', color: '#dc2626' },
    { id: 'bakery',    label: 'Bakery',         emoji: '🍞', color: '#d97706' },
    { id: 'frozen',    label: 'Frozen',         emoji: '🧊', color: '#7c3aed' },
    { id: 'pantry',    label: 'Pantry',         emoji: '🥫', color: '#b45309' },
    { id: 'snacks',    label: 'Snacks',         emoji: '🍿', color: '#f59e0b' },
    { id: 'beverages', label: 'Beverages',      emoji: '🧃', color: '#0891b2' },
    { id: 'personal',  label: 'Personal Care',  emoji: '🧴', color: '#8b5cf6' },
    { id: 'household', label: 'Household',      emoji: '🧹', color: '#64748b' },
    { id: 'other',     label: 'Other',          emoji: '📦', color: '#94a3b8' },
];

const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const CATEGORY_KEYWORDS = {
    produce:   ['apple','banana','orange','lettuce','spinach','tomato','pepper','onion','garlic','potato','carrot','celery','broccoli','strawberry','blueberry','grape','lemon','lime','avocado','mushroom','zucchini','corn','herb','basil','cilantro','parsley','kale','arugula','mango','pineapple','watermelon','peach','cherry','berry','radish','beet','squash','cucumber','asparagus','peas','green bean','eggplant','cauliflower','ginger','jalapeño','jalapeno','scallion','leek','shallot','fruit','vegetable','veggie','produce'],
    dairy:     ['milk','cheese','yogurt','butter','cream','sour cream','cottage cheese','cream cheese','whipped cream','half and half','eggs','egg','cheddar','mozzarella','parmesan','ricotta','heavy cream','oat milk','almond milk','soy milk','brie','gouda','swiss','american cheese','dairy'],
    meat:      ['chicken','beef','pork','turkey','lamb','salmon','tuna','shrimp','fish','steak','ground beef','ground turkey','bacon','ham','sausage','hot dog','deli','lunch meat','seafood','cod','tilapia','crab','lobster','duck','bison','venison','meat'],
    bakery:    ['bread','bagel','muffin','croissant','roll','bun','tortilla','pita','cake','pie','cookie','pastry','donut','doughnut','biscuit','wrap','naan','sourdough','brioche','flatbread'],
    frozen:    ['frozen','ice cream','pizza','waffles','tater tots','french fries','edamame','ice','popsicle','sorbet'],
    pantry:    ['pasta','rice','beans','lentils','canned','tomato sauce','soup','broth','stock','flour','sugar','oil','vinegar','soy sauce','honey','jam','jelly','peanut butter','almond butter','cereal','oats','oatmeal','granola','nuts','seeds','spice','salt','black pepper','oregano','cumin','paprika','cinnamon','vanilla','baking powder','baking soda','cornstarch','breadcrumbs','panko','coconut milk','olive oil','vegetable oil','cooking spray','maple syrup','ketchup','mustard','mayo','salad dressing','sauce','condiment','noodle','quinoa','couscous','barley','polenta','grits'],
    snacks:    ['chips','crackers','popcorn','pretzels','granola bar','protein bar','candy','chocolate','gummy','fruit snack','trail mix','jerky','hummus','salsa','guacamole','dip','snack','doritos','lays','cheetos','oreo','cookie'],
    beverages: ['juice','soda','water','sparkling water','coffee','tea','energy drink','sports drink','kombucha','lemonade','drink','beverage','wine','beer','smoothie','creamer','gatorade','coconut water','apple juice','orange juice'],
    personal:  ['shampoo','conditioner','soap','body wash','toothpaste','toothbrush','deodorant','antiperspirant','razor','shaving','lotion','moisturizer','sunscreen','face wash','mouthwash','floss','tampon','pad','vitamins','supplement','medicine','ibuprofen','tylenol','advil','bandaid','band-aid','tissue','cotton'],
    household: ['paper towel','toilet paper','napkin','garbage bag','trash bag','zip lock','ziploc','aluminum foil','plastic wrap','dish soap','laundry','detergent','fabric softener','dryer sheet','bleach','cleaner','sponge','wipe','cleaning','dishwasher','light bulb','battery','candle','air freshener','scrubber'],
};

function detectCategory(name) {
    const n = name.toLowerCase();
    for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => n.includes(kw))) return catId;
    }
    return 'other';
}

function genId(prefix = 'g') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function catOf(id) { return CAT_MAP[id] ?? CAT_MAP.other; }

// ── PantryApp ─────────────────────────────────────────────────────────────────

export class PantryApp {
    constructor(containerEl, store) {
        this.container = containerEl;
        this.store     = store;

        // Tab state
        this._tab = 'list'; // 'list' | 'inventory' | 'catalog'

        // List state
        this._items         = [];
        this._showChecked   = true;
        this._fulfillFilter = 'all'; // 'all' | 'curbside' | 'instore'

        // Pantry state
        this._inventory      = [];
        this._pantrySearch   = '';
        this._pantryFilter   = 'all'; // 'all' | 'staples' | 'low'

        // Family (HA persons) for "Added By" picker
        this._family = [];

        // All products from DB (used for name autocomplete)
        this._products = [];

        // Inventory tab view state — view mode persists across reloads so
        // the user's preference (audit list vs grid) is remembered.
        const savedView    = (typeof localStorage !== 'undefined' && localStorage.getItem('fc_inv_view_mode')) || '';
        this._invViewMode  = (savedView === 'audit' || savedView === 'grid') ? savedView : 'audit';
        this._invLocId     = null;      // null = All, else location.id

        // Catalog tab state
        this._catalogSearch  = '';
        this._catalogProds   = []; // product rows with barcode_count
        this._editProduct    = null;
        this._editProductPhoto = null;
        this._editProductBarcodes = []; // barcodes on the product being edited
        this._upcLookupOpen  = false;

        // Edit modals
        this._editItem        = null;
        this._editItemPhoto   = null;
        this._editInvItem     = null;
        this._editInvPhoto    = null;

        // Meal-plan import modal
        this._mpModalOpen     = false;
        this._mpIngredients   = []; // { name, amount, unit, category, meal, selected }

        // Scanner
        this._scanner     = new BarcodeScanner();
        this._scannerOpen = false;

        // Sync
        this._syncStatus = 'idle';
        this._syncTimer  = null;
        this._unsub      = null;

        this._load();
    }

    // ── Boot ──────────────────────────────────────────────────────────────────

    async _load() {
        const cached = this.store.loadCachedList();
        this._items     = cached.items || [];
        this._inventory = this.store.loadCachedInventory() || [];
        this._render();

        // Subscribe to live SSE updates (SSE is a notification only — re-fetch actual data)
        this._unsub = this.store.subscribe(async ({ type }) => {
            if (type === 'list') {
                const fresh = await this.store.fetchList();
                if (fresh) this._items = fresh.items || [];
                this._render();
                this._flashSync();
            } else if (type === 'inventory') {
                const freshInv = await this.store.fetchInventory();
                if (freshInv) this._inventory = freshInv;
                // Also refresh catalog (products SSE uses the same 'inventory' channel)
                const freshProds = await this.store.fetchProducts(this._catalogSearch);
                if (freshProds) { this._catalogProds = freshProds; this._products = freshProds; }
                this._render();
            }
        });

        // Fetch fresh from backend
        const freshList = await this.store.fetchList();
        if (freshList) this._items = freshList.items || [];
        const freshInv = await this.store.fetchInventory();
        if (freshInv) this._inventory = freshInv;

        // Load HA family members + full product catalog.
        // Catalog tab badge needs the count on first paint, so await + re-render.
        this._loadFamily();
        const prods = await this.store.fetchProducts();
        if (prods) { this._products = prods; this._catalogProds = prods; }

        this._render();
    }

    destroy() { this._unsub?.(); }

    // ── Family (HA persons) ────────────────────────────────────────────────────

    async _loadFamily() {
        try {
            const { apiUrl } = await import('./utils.js');
            const res = await fetch(apiUrl('/api/pantry/family'));
            if (!res.ok) return;
            const people = await res.json();
            if (Array.isArray(people) && people.length > 0) {
                this._family = people; // [{id, name, avatar, initials, color, …}]
            }
        } catch (err) {
            console.warn('[PantryApp] _loadFamily failed:', err.message);
        }
    }

    // ── Master render ─────────────────────────────────────────────────────────

    _render() {
        // Preserve scroll position across SSE-driven re-renders so checking an
        // item doesn't jump the user back to the top of the list.
        // The scrollable element is #pantryBody (overflow-y:auto in pantry.css),
        // not window — save it before innerHTML wipes the element.
        const savedScroll = document.getElementById('pantryBody')?.scrollTop ?? 0;

        const unchecked = this._items.filter(i => !i.checked).length;
        const inStore   = this._items.filter(i => !i.checked && i.fulfillment === 'instore').length;

        this.container.innerHTML = `
            <div class="pantry-page">
                <div class="pantry-tabs">
                    <button class="pantry-tab${this._tab === 'list'      ? ' active' : ''}" data-tab="list">
                        🛒 Shopping List
                        ${unchecked > 0 ? `<span class="pantry-tab-count">${unchecked}</span>` : ''}
                    </button>
                    <button class="pantry-tab${this._tab === 'inventory' ? ' active' : ''}" data-tab="inventory">
                        📦 Inventory
                        <span class="pantry-tab-count">${this._inventory.length}</span>
                    </button>
                    <button class="pantry-tab${this._tab === 'catalog'   ? ' active' : ''}" data-tab="catalog">
                        📋 Catalog
                        ${this._catalogProds.length > 0 ? `<span class="pantry-tab-count">${this._catalogProds.length}</span>` : ''}
                    </button>
                    <div class="pantry-tabs-right">
                        <span class="pantry-sync-badge" id="pantrySyncBadge"
                              data-status="${this._syncStatus}">${this._syncBadgeHTML()}</span>
                        ${this._tab === 'list' && inStore > 0 ? `
                            <button class="pantry-store-mode-btn" id="pantryStoreModeBtn">
                                🏪 Store Mode
                                <span class="pantry-store-mode-count">${inStore}</span>
                            </button>` : ''}
                    </div>
                </div>

                <div class="pantry-body" id="pantryBody"></div>
            </div>
        `;

        document.querySelectorAll('.pantry-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._tab = btn.dataset.tab;
                this._render();
            });
        });

        document.getElementById('pantryStoreModeBtn')?.addEventListener('click', () => {
            this._openStoreMode();
        });

        const body = document.getElementById('pantryBody');
        if (this._tab === 'list')      this._renderListTab(body);
        if (this._tab === 'inventory') this._renderPantryTab(body);
        if (this._tab === 'catalog')   this._renderCatalogTab(body);

        // Restore the scroll on the new #pantryBody element after layout.
        // Must be in rAF — the element exists in the DOM immediately after
        // innerHTML but its scrollHeight isn't established until layout runs.
        if (savedScroll) {
            requestAnimationFrame(() => {
                const el = document.getElementById('pantryBody');
                if (el) el.scrollTop = savedScroll;
            });
        }
    }

    // ── LIST TAB ──────────────────────────────────────────────────────────────

    _renderListTab(body) {
        const total       = this._items.length;
        const checked     = this._items.filter(i => i.checked).length;
        const putAwayable = this._items.filter(i =>
            i.checked || (i.fulfillment === 'curbside' && i.orderStatus === 'ordered')
        ).length;
        const pct     = total > 0 ? (checked / total) * 100 : 0;
        const ff      = this._fulfillFilter; // 'all' | 'curbside' | 'instore'

        // Apply fulfillment filter + hide-done filter
        const visible = this._items.filter(i => {
            if (!this._showChecked && i.checked) return false;
            if (ff === 'all') return true;
            return (i.fulfillment || 'unplanned') === ff;
        });

        // Group visible items by category in CATEGORIES order
        const grouped = {};
        visible.forEach(item => {
            const cat = item.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });
        Object.keys(grouped).forEach(cat => {
            grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
        });
        const catOrder = CATEGORIES.map(c => c.id).filter(id => grouped[id]);

        const filterBtns = ['all', 'curbside', 'instore'].map(f => {
            const labels = { all: 'All', curbside: '🛻 Curbside', instore: '🏪 In-Store' };
            const count  = f === 'all' ? this._items.length
                : this._items.filter(i => (i.fulfillment || 'unplanned') === f).length;
            return `<button class="pantry-filter-btn${ff === f ? ' active' : ''}" data-filter="${f}">
                ${labels[f]}${count ? ` <span class="pantry-filter-count">${count}</span>` : ''}
            </button>`;
        }).join('');

        body.innerHTML = `
            <div class="pantry-list-toolbar">
                <div class="pantry-fulfill-filters">${filterBtns}</div>
                <div class="pantry-list-actions">
                    ${putAwayable > 0 ? `
                        <button class="pantry-put-away-btn" id="pantryPutAway">
                            📦 Put Away (${putAwayable})
                        </button>` : ''}
                    ${checked > 0 ? `
                        <button class="pantry-action-btn danger" id="pantryClearChecked">
                            🗑 Clear ${checked}
                        </button>` : ''}
                    <button class="pantry-action-btn" id="pantryMealPlanBtn" title="Import from meal plan">
                        📅 From Meals
                    </button>
                    <button class="pantry-action-btn" id="pantryStaplesBtn" title="Add weekly staples">
                        ⭐ Staples
                    </button>
                    <button class="pantry-toggle-checked" id="pantryToggleChecked">
                        ${this._showChecked ? '👁 Hide done' : '👁 Show done'}
                    </button>
                </div>
            </div>

            ${total > 0 ? `
                <div class="pantry-progress-wrap">
                    <div class="pantry-progress-bar">
                        <div class="pantry-progress-fill" style="width:${pct.toFixed(1)}%"></div>
                    </div>
                    <span class="pantry-progress-label">${checked} of ${total} items</span>
                </div>` : ''}

            <div class="pantry-list-items" id="pantryListItems">
                ${total === 0
                    ? `<div class="pantry-empty">
                           <div class="pantry-empty-icon">🛒</div>
                           <div class="pantry-empty-title">Your list is empty</div>
                           <div class="pantry-empty-text">Add items below, import from your meal plan, or add your weekly staples.</div>
                       </div>`
                    : catOrder.length === 0
                        ? `<div class="pantry-empty"><div class="pantry-empty-text">No items match this filter.</div></div>`
                        : catOrder.map(catId => this._categoryGroupHTML(catId, grouped[catId])).join('')
                }
            </div>

            <div class="pantry-list-fabs">
                <button class="pantry-add-fab pantry-scan-fab" id="pantryScanNeedFab" title="Scan to add to list">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
                        <rect x="3" y="6" width="18" height="12" rx="2"/>
                        <line x1="7" y1="9" x2="7" y2="15"/><line x1="11" y1="9" x2="11" y2="15"/>
                        <line x1="15" y1="9" x2="15" y2="15"/><line x1="19" y1="9" x2="19" y2="15"/>
                    </svg>
                    Scan
                </button>
                <button class="pantry-add-fab" id="pantryAddFab" title="Add item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Item
                </button>
            </div>
        `;

        body.querySelectorAll('.pantry-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._fulfillFilter = btn.dataset.filter;
                this._render();
            });
        });
        body.querySelector('#pantryToggleChecked')?.addEventListener('click', () => {
            this._showChecked = !this._showChecked; this._render();
        });
        body.querySelector('#pantryClearChecked')?.addEventListener('click', () => this._clearChecked());
        body.querySelector('#pantryMealPlanBtn')?.addEventListener('click', () => this._openMealPlanImport());
        body.querySelector('#pantryStaplesBtn')?.addEventListener('click', () => this._addStaples());
        body.querySelector('#pantryAddFab')?.addEventListener('click', () => this._openItemModal());
        body.querySelector('#pantryScanNeedFab')?.addEventListener('click', () => this._openScanner('need'));
        body.querySelector('#pantryPutAway')?.addEventListener('click', () => this._openPutAwayModal());

        body.querySelectorAll('.pantry-item-row').forEach(row => {
            const id = row.dataset.id;
            row.querySelector('.pantry-item-check')?.addEventListener('click', e => {
                e.stopPropagation();
                this._toggleItem(id);
            });
            row.querySelector('.pantry-item-edit')?.addEventListener('click', e => {
                e.stopPropagation();
                const item = this._items.find(i => i.id === id);
                if (item) this._openItemModal(item);
            });
            row.querySelector('.pantry-fulfill-pill')?.addEventListener('click', e => {
                e.stopPropagation();
                this._showFulfillmentPicker(id, e.currentTarget);
            });
            row.querySelector('.pantry-order-oos-btn')?.addEventListener('click', e => {
                e.stopPropagation();
                this._markOutOfStock(id);
            });
            const thumb = row.querySelector('.pantry-item-photo-thumb');
            if (thumb) {
                thumb.style.cursor = 'pointer';
                thumb.addEventListener('click', e => {
                    e.stopPropagation();
                    this._openPhotoLightbox(thumb.dataset.photo);
                });
            }
        });
    }

    _swimlaneHTML(laneId, items) {
        const LANES = {
            unplanned: { label: 'Not Yet Planned', icon: '—',  color: '#94a3b8',
                         hint: 'Tap + on each item to assign' },
            curbside:  { label: 'Curbside / Delivery', icon: '🛻', color: '#7c3aed', hint: '' },
            instore:   { label: 'In-Store',             icon: '🏪', color: '#0891b2', hint: '' },
        };
        const lane      = LANES[laneId] || LANES.unplanned;
        const unchecked = items.filter(i => !i.checked).length;

        // Group by category within the lane (same as the original list view)
        const grouped = {};
        items.forEach(item => {
            const cat = item.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });
        Object.keys(grouped).forEach(cat => {
            grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
        });
        const catOrder = CATEGORIES.map(c => c.id).filter(id => grouped[id]);

        return `
            <div class="pantry-swimlane" data-lane="${laneId}">
                <div class="pantry-swimlane-header" style="--lane-color:${lane.color}">
                    <span class="pantry-swimlane-icon">${lane.icon}</span>
                    <span class="pantry-swimlane-label">${lane.label}</span>
                    ${lane.hint ? `<span class="pantry-swimlane-hint">${lane.hint}</span>` : ''}
                    <span class="pantry-swimlane-count${unchecked === 0 ? ' done' : ''}">
                        ${unchecked > 0 ? unchecked : '✓ all done'}
                    </span>
                </div>
                ${catOrder.map(catId => this._categoryGroupHTML(catId, grouped[catId])).join('')}
            </div>`;
    }

    _categoryGroupHTML(catId, items) {
        const cat       = catOf(catId);
        const unchecked = items.filter(i => !i.checked).length;
        return `
            <div class="pantry-cat-group">
                <div class="pantry-cat-header" style="--cat-color:${cat.color}">
                    <span class="pantry-cat-emoji">${cat.emoji}</span>
                    <span class="pantry-cat-label">${cat.label}</span>
                    ${unchecked > 0
                        ? `<span class="pantry-cat-count">${unchecked}</span>`
                        : `<span class="pantry-cat-all-done">✓ all done</span>`}
                </div>
                ${items.map(item => this._itemRowHTML(item)).join('')}
            </div>`;
    }

    _itemRowHTML(item) {
        const ful       = item.fulfillment || 'unplanned';
        const isOrdered = ful === 'curbside' && item.orderStatus === 'ordered';
        const PILL = {
            unplanned: { label: '+ Plan', cls: 'unplanned' },
            curbside:  { label: '🛻',     cls: 'curbside'  },
            instore:   { label: '🏪',     cls: 'instore'   },
        };
        const pill       = PILL[ful] || PILL.unplanned;
        const cat        = catOf(item.category);
        const _unit      = item.unit && item.unit !== 'count' ? item.unit : '';
        const amountStr  = _unit ? `${item.qty} ${_unit}` : (item.qty !== 1 ? `${item.qty}` : '');
        const storeName  = item.storeName || this._storeNameById(item.storeId);
        const storeColor = item.storeColor || '#64748b';
        const orderedRow = (!item.checked && item.orderStatus === 'ordered') ? `
            <span class="pantry-order-row">
                <span class="pantry-order-badge">🟡 Ordered</span>
                <button class="pantry-order-oos-btn" data-id="${item.id}">Out of stock →</button>
            </span>` : '';
        return `
            <div class="pantry-item-row${item.checked ? ' checked' : ''}${isOrdered ? ' ordered' : ''}" data-id="${item.id}">
                <button class="pantry-item-check${item.checked ? ' done' : ''}${isOrdered ? ' ordered' : ''}" aria-label="Toggle" title="${isOrdered ? 'Ordered — tap to unmark' : ful === 'curbside' ? 'Tap to mark as ordered' : 'Tap to mark done'}">
                    ${(item.checked || isOrdered)
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'
                        : ''}
                </button>
                ${item.photo
                    ? `<div class="pantry-item-photo-thumb" data-photo="${this._esc(item.photo)}"
                            style="background-image:url('${item.photo}')" title="Tap to enlarge"></div>`
                    : ''}
                <div class="pantry-item-info">
                    <span class="pantry-item-name">
                        <span class="pantry-item-cat-dot" style="color:${cat.color}" title="${cat.label}">${cat.emoji}</span>
                        ${this._esc(item.name)}
                    </span>
                    ${amountStr ? `<span class="pantry-item-amount">${this._esc(amountStr)}</span>` : ''}
                    <span class="pantry-item-meta">
                        ${(item.brand || item.notes) ? `<span class="pantry-item-brand-notes">${this._esc([item.brand, item.notes].filter(Boolean).join(' · '))}</span>` : ''}
                        ${storeName ? `<span class="pantry-item-store" style="--store-color:${this._esc(storeColor)}">${this._esc(storeName)}</span>` : ''}
                        ${item.addedBy && item.addedBy.toLowerCase() !== 'household'
                            ? `<span class="pantry-item-addedby">${this._esc(item.addedBy)}</span>`
                            : ''}
                    </span>
                    ${orderedRow}
                </div>
                <button class="pantry-fulfill-pill ${pill.cls}" data-id="${item.id}" title="Tap to change fulfillment">
                    ${pill.label}
                </button>
                <button class="pantry-item-edit" aria-label="Edit" title="Edit">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
            </div>`;
    }

    // ── INVENTORY TAB ─────────────────────────────────────────────────────────

    _renderPantryTab(body) {
        const q        = this._pantrySearch.toLowerCase();
        const locations = this.store.config?.locations || [];
        const locId    = this._invLocId;
        const viewMode = this._invViewMode;

        // Filter pipeline
        let items = [...this._inventory];
        if (locId)  items = items.filter(i => i.locationId === locId);
        if (q)      items = items.filter(i =>
            (i.name  || '').toLowerCase().includes(q) ||
            (i.brand || '').toLowerCase().includes(q));

        const sorted   = this._sortInventory(items);
        const lowItems = this._inventory.filter(i => i.stockLevel === 'low' || i.stockLevel === 'out');
        const outItems = this._inventory.filter(i => i.stockLevel === 'out');

        body.innerHTML = `
            <!-- ── Toolbar ── -->
            <div class="inv-toolbar">
                <div class="inv-search-wrap">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input type="search" id="invSearch" class="inv-search"
                           placeholder="Search inventory…" value="${this._esc(this._pantrySearch)}">
                </div>
                <div class="inv-toolbar-actions">
                    <button class="inv-scan-btn" id="invScanRestock" title="Scan to restock">📥 Restock</button>
                    <button class="inv-scan-btn" id="invScanUsed"    title="Scan to mark empty">📤 Used</button>
                    <button class="pantry-action-btn primary" id="invAddItem">+ Add</button>
                </div>
            </div>

            <!-- ── View toggle + Location tabs ── -->
            <div class="inv-nav-row">
                <div class="inv-loc-tabs">
                    <button class="inv-loc-tab${!locId ? ' active' : ''}" data-loc="">
                        All <span class="inv-loc-count">${this._inventory.length}</span>
                    </button>
                    ${locations.map(l => {
                        const cnt = this._inventory.filter(i => i.locationId === l.id).length;
                        return `<button class="inv-loc-tab${locId === l.id ? ' active' : ''}" data-loc="${this._esc(l.id)}">
                            ${this._esc(l.name || l.id)}
                            <span class="inv-loc-count">${cnt}</span>
                        </button>`;
                    }).join('')}
                </div>
                <div class="inv-view-toggle">
                    <button class="inv-view-btn${viewMode === 'audit' ? ' active' : ''}" data-view="audit" title="Audit list">≡</button>
                    <button class="inv-view-btn${viewMode === 'grid'  ? ' active' : ''}" data-view="grid"  title="Visual grid">⊞</button>
                </div>
            </div>

            <!-- ── Reorder alerts ── -->
            ${outItems.length > 0 ? `
                <div class="inv-alert inv-alert-out">
                    🔴 <strong>${outItems.length} item${outItems.length !== 1 ? 's' : ''} out</strong>
                    <button class="inv-alert-btn" id="invAddAllOut">Add all to list</button>
                </div>` : ''}
            ${lowItems.filter(i => i.stockLevel === 'low').length > 0 ? `
                <div class="inv-alert inv-alert-low">
                    ⚠️ <strong>${lowItems.filter(i=>i.stockLevel==='low').length} running low</strong>
                    <button class="inv-alert-btn" id="invAddAllLow">Add all to list</button>
                </div>` : ''}

            <!-- ── Item view ── -->
            <div class="inv-items inv-items-${viewMode}" id="invItems">
                ${sorted.length === 0
                    ? `<div class="pantry-empty">
                           <div class="pantry-empty-icon">📦</div>
                           <div class="pantry-empty-title">${q || locId ? 'No items match' : 'Inventory is empty'}</div>
                           <div class="pantry-empty-text">Scan a barcode or tap + Add to get started.</div>
                       </div>`
                    : sorted.map(inv => this._invCardHTML(inv, viewMode)).join('')}
            </div>
        `;

        // Search
        body.querySelector('#invSearch')?.addEventListener('input', e => {
            this._pantrySearch = e.target.value;
            this._renderPantryTab(body);
        });

        // Location tabs
        body.querySelectorAll('.inv-loc-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._invLocId = btn.dataset.loc || null;
                this._renderPantryTab(body);
            });
        });

        // View toggle — persist the choice so reloads keep the user's preference
        body.querySelectorAll('.inv-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._invViewMode = btn.dataset.view;
                try { localStorage.setItem('fc_inv_view_mode', this._invViewMode); } catch {}
                this._renderPantryTab(body);
            });
        });

        // Toolbar actions
        body.querySelector('#invAddItem')?.addEventListener('click',     () => this._openInvModal());
        body.querySelector('#invScanRestock')?.addEventListener('click', () => this._openScanner('restock'));
        body.querySelector('#invScanUsed')?.addEventListener('click',    () => this._openScanner('mark_used'));

        body.querySelector('#invAddAllOut')?.addEventListener('click', () => {
            outItems.forEach(inv => this._addFromInventory(inv));
        });
        body.querySelector('#invAddAllLow')?.addEventListener('click', () => {
            const openNames = new Set(this._items.filter(i=>!i.checked).map(i=>i.name.toLowerCase()));
            lowItems.filter(inv => !openNames.has(inv.name.toLowerCase()))
                    .forEach(inv => this._addFromInventory(inv));
        });

        // All interactive controls on cards
        this._bindInvControls(body);
    }

    // ── Inventory item helpers ────────────────────────────────────────────────

    /** Derive the tracking type from product data. */
    _invTrackType(inv) {
        // trackType is set by the store normalizer; fall back to flag-based detection
        // for any cached rows that predate the trackType field.
        if (inv.trackType) return inv.trackType;
        if (inv.unit === 'status') return 'status';
        if (inv.tracksPercent)     return 'percent';
        if (inv.unitsPer > 1)      return 'multipack';
        return 'count';
    }

    /** Status badge HTML (GOOD / LOW / REORDER). */
    _invBadgeHTML(inv) {
        const s = inv.stockLevel || 'ok';
        const map = { ok: ['inv-badge-good', 'GOOD'], low: ['inv-badge-low', 'LOW'], out: ['inv-badge-out', 'REORDER'] };
        const [cls, label] = map[s] || map.ok;
        return `<span class="inv-badge ${cls}">${label}</span>`;
    }

    /**
     * Dot-grid visualization for multi-pack items.
     * Shows up to 10 boxes × unitsPer dots (capped at 60 total for layout).
     * Filled dots = in stock; each box of unitsPer forms a visual group.
     */
    _invDotGridHTML(inv) {
        const up     = inv.unitsPer;
        const total  = inv.qty;
        const maxDots = 60;
        const dots   = Math.min(total, maxDots);
        const boxes  = Math.ceil(dots / up);
        let html = '';
        for (let b = 0; b < boxes; b++) {
            html += '<span class="inv-dot-group">';
            for (let d = 0; d < up; d++) {
                const idx = b * up + d;
                html += `<span class="inv-dot${idx < total ? ' filled' : ''}"></span>`;
            }
            html += '</span>';
        }
        if (total > maxDots) html += `<span class="inv-dot-overflow">+${total - maxDots}</span>`;
        return `<div class="inv-dot-grid">${html}</div>`;
    }

    /** Tracking control HTML — differs by type. */
    _invCtrlHTML(inv) {
        const type = this._invTrackType(inv);

        // ── Status: 3-button toggle (REORDER / LOW / GOOD) ──────────────────
        if (type === 'status') {
            const s = inv.stockLevel || 'ok';
            return `
                <div class="inv-ctrl inv-ctrl-status" data-id="${inv.id}">
                    <div class="inv-status-toggle">
                        <button class="inv-status-btn inv-sb-out${s === 'out' ? ' active' : ''}"
                                data-action="set-status" data-id="${inv.id}" data-qty="0">REORDER</button>
                        <button class="inv-status-btn inv-sb-low${s === 'low' ? ' active' : ''}"
                                data-action="set-status" data-id="${inv.id}" data-qty="1">LOW</button>
                        <button class="inv-status-btn inv-sb-ok${s === 'ok' ? ' active' : ''}"
                                data-action="set-status" data-id="${inv.id}" data-qty="2">GOOD</button>
                    </div>
                </div>`;
        }

        // ── Multipack: dot-grid + step by 1 individual unit ──────────────────
        if (type === 'multipack') {
            return `
                <div class="inv-ctrl inv-ctrl-mp" data-id="${inv.id}" data-units-per="${inv.unitsPer}">
                    ${this._invDotGridHTML(inv)}
                    <div class="inv-mp-row">
                        <button class="inv-step-btn" data-action="dec" data-id="${inv.id}">−</button>
                        <span class="inv-count-val">${inv.qty}</span>
                        <span class="inv-count-unit">${inv.unit}${inv.qty !== 1 ? 's' : ''}</span>
                        <button class="inv-step-btn" data-action="inc" data-id="${inv.id}">+</button>
                    </div>
                    ${inv.low > 0 ? `<div class="inv-threshold-hint">Reorder at: ${inv.low} ${inv.unit}s</div>` : ''}
                </div>`;
        }
        if (type === 'percent') {
            const pct = inv.percent ?? 0;
            return `
                <div class="inv-ctrl inv-ctrl-pct" data-id="${inv.id}">
                    <div class="inv-fill-bar-wrap">
                        <div class="inv-fill-bar" style="width:${Math.max(0,Math.min(100,pct))}%"></div>
                        ${inv.low > 0 ? `<div class="inv-fill-threshold" style="left:${inv.low}%"></div>` : ''}
                    </div>
                    <div class="inv-pct-row">
                        <button class="inv-step-btn" data-action="dec-pct" data-id="${inv.id}" data-step="10">−</button>
                        <input type="range" class="inv-pct-slider" min="0" max="100" step="5"
                               value="${pct}" data-id="${inv.id}">
                        <button class="inv-step-btn" data-action="inc-pct" data-id="${inv.id}" data-step="10">+</button>
                        <span class="inv-pct-val" id="inv-pct-val-${inv.id}">${pct}%</span>
                    </div>
                    ${inv.low > 0 ? `<div class="inv-threshold-hint">Reorder at: ${inv.low}%</div>` : ''}
                </div>`;
        }
        // Simple count
        return `
            <div class="inv-ctrl inv-ctrl-count" data-id="${inv.id}">
                <button class="inv-step-btn" data-action="dec" data-id="${inv.id}">−</button>
                <span class="inv-count-val" id="inv-count-${inv.id}">${inv.qty}</span>
                <span class="inv-count-unit">${inv.unit}${inv.qty !== 1 ? 's' : ''}</span>
                <button class="inv-step-btn" data-action="inc" data-id="${inv.id}">+</button>
                ${inv.low > 0 ? `<div class="inv-threshold-hint">Reorder at: ${inv.low}</div>` : ''}
            </div>`;
    }

    /** Single card. Grid mode follows the tactile mockup; audit is the dense list. */
    _invCardHTML(inv, mode = 'grid') {
        const cat    = catOf(inv.category);
        const onList = this._items.some(i => !i.checked && (i.productId === inv.productId || i.name.toLowerCase() === inv.name.toLowerCase()));
        const s      = inv.stockLevel || 'ok';
        const sortOrder = s === 'out' ? 0 : s === 'low' ? 1 : 2;

        if (mode === 'grid') return this._invGridCardHTML(inv, { cat, onList, s, sortOrder });

        // Audit mode — dense horizontal list (left border accent + inline ctrl)
        return `
        <div class="inv-card inv-card-audit inv-status-${s}" data-id="${inv.id}" style="order:${sortOrder}">
            <div class="inv-card-inner">

                <div class="inv-card-media">
                    ${inv.photo
                        ? `<img src="${inv.photo}" alt="${this._esc(inv.name)}">`
                        : `<div class="inv-card-emoji" style="--cat-color:${cat.color}">${cat.emoji}</div>`}
                    ${inv.isStaple ? `<span class="inv-staple-dot" title="Staple">⭐</span>` : ''}
                </div>

                <div class="inv-card-info">
                    <div class="inv-card-name-row">
                        <span class="inv-card-name">${this._esc(inv.name)}</span>
                        ${this._invBadgeHTML(inv)}
                    </div>
                    ${inv.description ? `<div class="inv-card-desc">${this._esc(inv.description)}</div>` : ''}
                    ${inv.brand ? `<div class="inv-card-brand">${this._esc(inv.brand)}</div>` : ''}

                    ${this._invCtrlHTML(inv)}
                </div>

                <div class="inv-card-actions">
                    <button class="inv-card-edit-btn" data-id="${inv.id}" title="Edit">✏️</button>
                    <button class="inv-card-list-btn${onList ? ' on-list' : ''}" data-id="${inv.id}" title="Add to shopping list">
                        ${onList ? '✓' : '+'}
                    </button>
                </div>

            </div>
        </div>`;
    }

    /**
     * Tactile grid card. Follows the v1.9.8 mockup: photo + name + description
     * + status pill on top, brand line below, big stepper / status toggle in
     * the middle, "Add to List" + "Edit" footer buttons. All cards in the
     * grid share the same outer height via CSS `grid-auto-rows: 1fr`.
     */
    _invGridCardHTML(inv, { cat, onList, s, sortOrder }) {
        return `
        <div class="inv-grid-card inv-status-${s}" data-id="${inv.id}" style="order:${sortOrder}">

            <!-- Header: thumb + titles + status pill -->
            <div class="inv-gc-head">
                <div class="inv-gc-thumb">
                    ${inv.photo
                        ? `<img src="${inv.photo}" alt="${this._esc(inv.name)}">`
                        : `<div class="inv-gc-thumb-emoji" style="--cat-color:${cat.color}">${cat.emoji}</div>`}
                    ${inv.isStaple ? `<span class="inv-gc-staple" title="Staple">⭐</span>` : ''}
                </div>
                <div class="inv-gc-titles">
                    <div class="inv-gc-name">${this._esc(inv.name)}</div>
                    ${inv.description
                        ? `<div class="inv-gc-desc">${this._esc(inv.description)}</div>`
                        : ''}
                    ${this._invBadgeHTML(inv)}
                </div>
            </div>

            <!-- Brand annotation (italic) -->
            ${inv.brand
                ? `<div class="inv-gc-brand">${this._esc(inv.brand)}</div>`
                : `<div class="inv-gc-brand-spacer"></div>`}

            <!-- Counter / status / percent control -->
            <div class="inv-gc-control">
                ${this._invGridCtrlHTML(inv)}
            </div>

            <!-- Footer actions -->
            <div class="inv-gc-actions">
                <button class="inv-gc-action-btn list${onList ? ' on-list' : ''}" data-action="list" data-id="${inv.id}">
                    ${onList ? '✓ On List' : '+ Add to List'}
                </button>
                <button class="inv-gc-action-btn edit" data-action="edit" data-id="${inv.id}">
                    Edit
                </button>
            </div>

        </div>`;
    }

    /**
     * Grid-mode tracking control. Same data as `_invCtrlHTML` but laid out
     * for the larger card: oversized stepper buttons, prominent count, and
     * a tucked threshold hint.
     */
    _invGridCtrlHTML(inv) {
        const type = this._invTrackType(inv);

        if (type === 'status') {
            const s = inv.stockLevel || 'ok';
            return `
                <div class="inv-gc-status-toggle">
                    <button class="inv-status-btn inv-sb-out${s === 'out' ? ' active' : ''}"
                            data-action="set-status" data-id="${inv.id}" data-qty="0">REORDER</button>
                    <button class="inv-status-btn inv-sb-low${s === 'low' ? ' active' : ''}"
                            data-action="set-status" data-id="${inv.id}" data-qty="1">LOW</button>
                    <button class="inv-status-btn inv-sb-ok${s === 'ok' ? ' active' : ''}"
                            data-action="set-status" data-id="${inv.id}" data-qty="2">GOOD</button>
                </div>`;
        }

        if (type === 'percent') {
            const pct = inv.percent ?? 0;
            return `
                <div class="inv-gc-percent">
                    <div class="inv-fill-bar-wrap">
                        <div class="inv-fill-bar" style="width:${Math.max(0,Math.min(100,pct))}%"></div>
                        ${inv.low > 0 ? `<div class="inv-fill-threshold" style="left:${inv.low}%"></div>` : ''}
                    </div>
                    <div class="inv-gc-pct-row">
                        <button class="inv-gc-step-btn" data-action="dec-pct" data-id="${inv.id}" data-step="10">−</button>
                        <input type="range" class="inv-pct-slider" min="0" max="100" step="5"
                               value="${pct}" data-id="${inv.id}">
                        <button class="inv-gc-step-btn" data-action="inc-pct" data-id="${inv.id}" data-step="10">+</button>
                    </div>
                    <div class="inv-gc-pct-val" id="inv-pct-val-${inv.id}">${pct}%${inv.low > 0 ? ` <span class="inv-gc-thresh">· reorder at ${inv.low}%</span>` : ''}</div>
                </div>`;
        }

        // Count (and Count + pack-size aka multipack)
        const isMultipack = inv.unitsPer > 1;
        return `
            <div class="inv-gc-stepper">
                <button class="inv-gc-step-btn dec" data-action="dec" data-id="${inv.id}">−</button>
                <div class="inv-gc-count">
                    <span class="inv-gc-count-val">${inv.qty}</span>
                </div>
                <button class="inv-gc-step-btn inc" data-action="inc" data-id="${inv.id}">+</button>
            </div>
            <div class="inv-gc-count-meta">
                ${inv.unit && inv.unit !== 'item' ? `<span class="inv-gc-unit">${this._esc(inv.unit)}${inv.qty !== 1 ? 's' : ''}</span>` : ''}
                ${inv.low > 0 ? `<span class="inv-gc-thresh">· reorder at ${inv.low}</span>` : ''}
            </div>
            ${isMultipack ? `<div class="inv-gc-dotgrid-wrap">${this._invDotGridHTML(inv)}</div>` : ''}
        `;
    }

    /** Sort inventory: out first, then low, then ok; alpha within tier. */
    _sortInventory(items) {
        const order = { out: 0, low: 1, ok: 2 };
        return [...items].sort((a, b) => {
            const sd = (order[a.stockLevel] ?? 2) - (order[b.stockLevel] ?? 2);
            return sd !== 0 ? sd : (a.name || '').localeCompare(b.name || '');
        });
    }

    /** Bind interactive controls on the rendered inventory container. */
    _bindInvControls(container) {
        // +/− step buttons (audit + grid share handler logic).
        // Grid card uses .inv-gc-step-btn; audit / status buttons use .inv-step-btn.
        container.querySelectorAll('.inv-step-btn, .inv-gc-step-btn, .inv-status-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id     = btn.dataset.id;
                const action = btn.dataset.action;
                const inv    = this._inventory.find(i => i.id === id);
                if (!inv) return;

                if (action === 'inc' || action === 'dec') {
                    const delta = action === 'inc' ? 1 : -1;
                    const newQty = Math.max(0, inv.qty + delta);
                    this._updateInventoryItem(id, { qty: newQty });
                } else if (action === 'set-status') {
                    // Status-type items: qty 0=out, 1=low, 2=ok
                    const qty = Math.max(0, Math.min(2, Number(btn.dataset.qty)));
                    this._updateInventoryItem(id, { qty });
                } else if (action === 'inc-pct' || action === 'dec-pct') {
                    const step    = Number(btn.dataset.step || 10);
                    const delta   = action === 'inc-pct' ? step : -step;
                    const newPct  = Math.max(0, Math.min(100, (inv.percent ?? 0) + delta));
                    this._setPercent(id, newPct);
                }
            });
        });

        // Percent slider drag
        container.querySelectorAll('.inv-pct-slider').forEach(slider => {
            let debounce = null;
            slider.addEventListener('input', () => {
                const id  = slider.dataset.id;
                const pct = Number(slider.value);
                const valEl = container.querySelector(`#inv-pct-val-${id}`);
                if (valEl) valEl.textContent = pct + '%';
                clearTimeout(debounce);
                debounce = setTimeout(() => this._setPercent(id, pct), 300);
            });
        });

        // Edit + add-to-list (audit mode uses .inv-card-* classes;
        // grid mode uses data-action on .inv-gc-action-btn)
        container.querySelectorAll('.inv-card-edit-btn, .inv-gc-action-btn[data-action="edit"]').forEach(btn => {
            const inv = this._inventory.find(i => i.id === btn.dataset.id);
            if (inv) btn.addEventListener('click', () => this._openInvModal(inv));
        });
        container.querySelectorAll('.inv-card-list-btn, .inv-gc-action-btn[data-action="list"]').forEach(btn => {
            const inv = this._inventory.find(i => i.id === btn.dataset.id);
            if (inv) btn.addEventListener('click', () => this._addFromInventory(inv));
        });
    }

    async _setPercent(id, pct) {
        this._setSyncStatus('saving');
        try {
            await this.store.updateInventoryItem(id, { percent: pct });
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
    }

    // ── CATALOG TAB ───────────────────────────────────────────────────────────

    _renderCatalogTab(body) {
        const q    = this._catalogSearch.toLowerCase();
        const prods = q
            ? this._catalogProds.filter(p =>
                (p.name || '').toLowerCase().includes(q) ||
                (p.brand || '').toLowerCase().includes(q))
            : this._catalogProds;

        body.innerHTML = `
            <div class="pantry-catalog-toolbar">
                <div class="pantry-catalog-search-wrap">
                    <input class="pantry-catalog-search" id="pantryProductSearch"
                           type="search" placeholder="Search products…"
                           value="${this._esc(this._catalogSearch)}">
                </div>
                <div class="pantry-catalog-actions">
                    ${this._catalogDuplicateGroups().length > 0
                        ? `<button class="pantry-action-btn pantry-action-warn" id="pantryFindDupes"
                                   title="Catalog has products with the same name">
                               🔀 Merge Duplicates (${this._catalogDuplicateGroups().length})
                           </button>`
                        : ''}
                    <button class="pantry-action-btn" id="pantryUpcLookupToggle" title="Temporary UPC analysis tool">
                        🔍 UPC Lookup
                    </button>
                    <button class="pantry-action-btn primary" id="pantryAddProduct">
                        + Add Product
                    </button>
                </div>
            </div>

            <!-- TEMPORARY: UPC raw analysis panel -->
            <div class="pantry-upc-lookup-panel" id="pantryUpcLookupPanel" ${this._upcLookupOpen ? '' : 'hidden'}>
                <div class="pantry-upc-lookup-header">
                    🔍 UPC Raw Analysis <span class="pantry-upc-lookup-note">(temporary dev tool)</span>
                </div>
                <div class="pantry-upc-lookup-row">
                    <input class="pantry-modal-input" id="upcLookupBarcode"
                           type="text" inputmode="numeric" maxlength="14"
                           placeholder="Enter UPC (e.g. 012000030840)">
                    <button class="pantry-action-btn primary" id="upcLookupGo">Look Up</button>
                </div>
                <div id="upcLookupResults" class="pantry-upc-lookup-results"></div>
            </div>

            ${prods.length === 0
                ? `<div class="pantry-empty">
                       <div class="pantry-empty-icon">📋</div>
                       <div class="pantry-empty-title">No products yet</div>
                       <div class="pantry-empty-text">
                           Products are added automatically when you scan barcodes,<br>
                           or you can add them manually with the button above.
                       </div>
                   </div>`
                : `<div class="pantry-catalog-grid" id="pantryProductGrid">
                       ${prods.map(p => this._productCardHTML(p)).join('')}
                   </div>`
            }
        `;

        body.querySelector('#pantryProductSearch')?.addEventListener('input', e => {
            this._catalogSearch = e.target.value;
            this._renderCatalogTab(body);
        });

        body.querySelector('#pantryAddProduct')?.addEventListener('click', () => {
            this._openProductModal(null);
        });

        body.querySelector('#pantryUpcLookupToggle')?.addEventListener('click', () => {
            this._upcLookupOpen = !this._upcLookupOpen;
            this._renderCatalogTab(body);
        });

        body.querySelector('#pantryFindDupes')?.addEventListener('click', () => {
            this._openMergeDuplicatesModal();
        });

        body.querySelector('#upcLookupGo')?.addEventListener('click', () => this._doUpcRawLookup(body));
        body.querySelector('#upcLookupBarcode')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') this._doUpcRawLookup(body);
        });

        body.querySelectorAll('.pantry-product-card').forEach(card => {
            const pid = card.dataset.id;
            card.addEventListener('click', () => {
                const p = this._catalogProds.find(x => x.id === pid);
                if (p) this._openProductModal(p);
            });
        });
    }

    /**
     * Group catalog products by case-insensitive name. Returns an array of
     * groups where each group has size > 1 — i.e. real duplicates that need
     * merging. Empty array means nothing to clean up (button stays hidden).
     */
    _catalogDuplicateGroups() {
        const map = new Map();
        for (const p of (this._catalogProds || [])) {
            const key = (p.name || '').trim().toLowerCase();
            if (!key) continue;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(p);
        }
        return [...map.values()].filter(g => g.length > 1);
    }

    /**
     * Score a duplicate candidate to pick the best survivor by default.
     * Higher score = keep this one. Items with a real photo, more linked
     * UPCs, and more inventory presence all rise to the top.
     */
    _dupeProductScore(p) {
        let s = 0;
        if (p.image_url) s += 10;
        s += Number(p.barcode_count || 0) * 5;
        if (p.brand) s += 2;
        // Older entries (created first) win ties — keeps the oldest as canonical
        return s;
    }

    _openMergeDuplicatesModal() {
        const groups = this._catalogDuplicateGroups();
        if (groups.length === 0) return;

        // Pre-select a survivor for each group (the highest-scoring product)
        this._mergeKeepers = {};
        groups.forEach((grp, i) => {
            const sorted = [...grp].sort((a, b) =>
                this._dupeProductScore(b) - this._dupeProductScore(a) ||
                String(a.created_at || '').localeCompare(String(b.created_at || ''))
            );
            this._mergeKeepers[i] = sorted[0].id;
        });

        const overlay = document.getElementById('pantryItemOverlay');
        if (!overlay) return;
        overlay.classList.add('active');
        this._renderMergeDuplicatesModal();
    }

    _renderMergeDuplicatesModal() {
        const overlay = document.getElementById('pantryItemOverlay');
        if (!overlay) return;
        const groups = this._catalogDuplicateGroups();

        if (groups.length === 0) {
            // Nothing left to merge — auto-close
            overlay.classList.remove('active');
            overlay.innerHTML = '';
            this._render();
            return;
        }

        const groupsHTML = groups.map((grp, gi) => {
            const keepId = this._mergeKeepers[gi] || grp[0].id;
            return `
                <div class="pantry-dupe-group" data-group="${gi}">
                    <div class="pantry-dupe-group-header">
                        <span class="pantry-dupe-group-name">${this._esc(grp[0].name)}</span>
                        <span class="pantry-dupe-group-count">${grp.length} copies</span>
                    </div>
                    <div class="pantry-dupe-group-hint">Pick the one to keep — the rest will merge into it.</div>
                    <div class="pantry-dupe-options">
                        ${grp.map(p => `
                            <label class="pantry-dupe-option${p.id === keepId ? ' selected' : ''}">
                                <input type="radio" name="dupe-${gi}" value="${p.id}" ${p.id === keepId ? 'checked' : ''}>
                                <div class="pantry-dupe-thumb">
                                    ${p.image_url
                                        ? `<img src="${this._esc(p.image_url)}" alt="">`
                                        : `<span class="pantry-dupe-emoji">${catOf(p.category_id || 'other').emoji}</span>`}
                                </div>
                                <div class="pantry-dupe-info">
                                    <div class="pantry-dupe-name">${this._esc(p.name)}</div>
                                    <div class="pantry-dupe-meta">
                                        ${p.brand ? `<span>${this._esc(p.brand)}</span>` : '<span class="muted">— no brand —</span>'}
                                        <span class="pantry-dupe-pill">${p.barcode_count || 0} UPC${p.barcode_count === 1 ? '' : 's'}</span>
                                    </div>
                                </div>
                            </label>
                        `).join('')}
                    </div>
                    <div class="pantry-dupe-group-actions">
                        <button class="pantry-modal-cancel" data-group="${gi}" data-action="skip">Skip</button>
                        <button class="pantry-modal-save" data-group="${gi}" data-action="merge">Merge ${grp.length - 1} into selected</button>
                    </div>
                </div>
            `;
        }).join('');

        overlay.innerHTML = `
            <div class="pantry-modal pantry-dupe-modal" role="dialog" aria-label="Merge Duplicates">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">🔀 Merge Duplicate Products</div>
                    <button class="pantry-modal-close" id="dupeClose">×</button>
                </div>
                <div class="pantry-modal-body">
                    <p class="pantry-dupe-intro">
                        Found ${groups.length} group${groups.length === 1 ? '' : 's'} of products with the same name.
                        For each, pick the one to <strong>keep</strong> — the others will be merged into it
                        (inventory rows summed by location, UPCs and history re-pointed).
                    </p>
                    ${groupsHTML}
                </div>
                <div class="pantry-modal-footer">
                    <button class="pantry-modal-cancel" id="dupeDone">Done</button>
                </div>
            </div>
        `;

        const close = () => {
            overlay.classList.remove('active');
            overlay.innerHTML = '';
            this._mergeKeepers = {};
            this._render();
        };
        overlay.querySelector('#dupeClose')?.addEventListener('click', close);
        overlay.querySelector('#dupeDone')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        // Radio change → update local keeper selection (no re-render of full modal,
        // just toggle the selected class on the labels)
        overlay.querySelectorAll('input[type="radio"]').forEach(r => {
            r.addEventListener('change', () => {
                const gi = Number(r.name.split('-')[1]);
                this._mergeKeepers[gi] = r.value;
                // Re-style this group's options
                const grpEl = overlay.querySelector(`.pantry-dupe-group[data-group="${gi}"]`);
                grpEl?.querySelectorAll('.pantry-dupe-option').forEach(opt => {
                    const input = opt.querySelector('input');
                    opt.classList.toggle('selected', input?.checked);
                });
            });
        });

        // Skip / Merge per group
        overlay.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const gi = Number(btn.dataset.group);
                const action = btn.dataset.action;
                if (action === 'skip') {
                    // Hide just this group; keep others visible
                    const grpEl = overlay.querySelector(`.pantry-dupe-group[data-group="${gi}"]`);
                    if (grpEl) grpEl.style.display = 'none';
                    return;
                }
                if (action === 'merge') {
                    btn.disabled = true;
                    btn.textContent = 'Merging…';
                    const groupsNow = this._catalogDuplicateGroups();
                    const grp = groupsNow[gi];
                    if (!grp) return;
                    const keepId = this._mergeKeepers[gi];
                    const losers = grp.filter(p => p.id !== keepId);
                    try {
                        for (const loser of losers) {
                            await this.store.mergeProduct(loser.id, keepId);
                        }
                        // Refresh products list and re-render the modal
                        const fresh = await this.store.fetchProducts();
                        if (fresh) { this._catalogProds = fresh; this._products = fresh; }
                        this._renderMergeDuplicatesModal();
                    } catch (err) {
                        console.warn('[Merge] failed:', err);
                        btn.disabled = false;
                        btn.textContent = `Merge ${grp.length - 1} into selected`;
                    }
                }
            });
        });
    }

    _productCardHTML(p) {
        const cat      = catOf(p.category_id || 'other');
        const upcCount = p.barcode_count || 0;
        return `
            <div class="pantry-product-card" data-id="${p.id}">
                <div class="pantry-product-thumb" style="--cat-color:${cat.color}">
                    ${p.image_url
                        ? `<img src="${this._esc(p.image_url)}" alt="" class="pantry-product-img">`
                        : `<span class="pantry-product-emoji">${cat.emoji}</span>`}
                </div>
                <div class="pantry-product-info">
                    <div class="pantry-product-name">${this._esc(p.name)}</div>
                    ${p.brand ? `<div class="pantry-product-brand">${this._esc(p.brand)}</div>` : ''}
                    <div class="pantry-product-meta">
                        <span class="pantry-product-cat-badge" style="color:${cat.color}">${cat.emoji} ${cat.label}</span>
                        ${upcCount > 0
                            ? `<span class="pantry-product-upc-badge">${upcCount} UPC${upcCount !== 1 ? 's' : ''}</span>`
                            : `<span class="pantry-product-upc-badge empty">No UPCs</span>`}
                    </div>
                </div>
            </div>`;
    }

    async _doUpcRawLookup(body) {
        const input   = body.querySelector('#upcLookupBarcode');
        const results = body.querySelector('#upcLookupResults');
        const barcode = input?.value.trim().replace(/\D/g, '');
        if (!barcode || barcode.length < 6) { input?.focus(); return; }

        results.innerHTML = `<div class="pantry-upc-lookup-loading">⏳ Looking up ${barcode}…</div>`;
        const data = await this.store.upcRawLookup(barcode);
        if (!data) {
            results.innerHTML = `<div class="pantry-upc-lookup-error">Lookup failed — check the console.</div>`;
            return;
        }

        const sourcesHtml = Object.entries(data.sources || {}).map(([key, src]) => `
            <div class="pantry-upc-source ${src.hit ? 'hit' : 'miss'}">
                <div class="pantry-upc-source-header">
                    <span class="pantry-upc-source-label">${src.hit ? '✅' : '❌'} ${src.label || key}</span>
                    <span class="pantry-upc-source-msg">${this._esc(src.msg || '')}</span>
                </div>
                ${src.hit ? `
                    <div class="pantry-upc-source-normalized">
                        ${Object.entries(src.normalized || {}).map(([k, v]) =>
                            v ? `<div class="pantry-upc-kv"><b>${this._esc(k)}:</b> ${this._esc(String(v))}</div>` : ''
                        ).join('')}
                    </div>
                    <details class="pantry-upc-raw-toggle">
                        <summary>Raw JSON</summary>
                        <pre class="pantry-upc-raw">${this._esc(JSON.stringify(src.raw, null, 2))}</pre>
                    </details>` : ''}
            </div>`).join('');

        results.innerHTML = `
            <div class="pantry-upc-lookup-barcode">Barcode: <code>${barcode}</code></div>
            ${sourcesHtml}`;
    }

    // ── PRODUCT MODAL (Catalog edit) ─────────────────────────────────────────

    async _openProductModal(product) {
        this._editProduct      = product ?? null;
        this._editProductPhoto = product?.image_url || null;
        // Fetch full barcodes list for this product
        if (product?.id) {
            const full = await this.store.fetchProduct(product.id);
            this._editProductBarcodes = (full?.barcodes || []).map(b => ({ barcode: b, source: 'existing' }));
        } else {
            this._editProductBarcodes = [];
        }
        this._renderProductModal();
    }

    _renderProductModal() {
        const overlay = document.getElementById('pantryItemOverlay');
        if (!overlay) return;
        const p        = this._editProduct;
        const isNew    = !p;
        const catOpts  = CATEGORIES.map(c =>
            `<option value="${c.id}" ${(p?.category_id || 'other') === c.id ? 'selected' : ''}>${c.emoji} ${c.label}</option>`
        ).join('');
        const stores   = this.store.config?.stores || [];
        const locs     = this.store.config?.locations || [];
        const storeOpts = `<option value="">— None —</option>` +
            stores.map(s => `<option value="${s.id}" ${p?.default_store_id === s.id ? 'selected' : ''}>${this._esc(s.store_name || s.name || s.id)}</option>`).join('');
        const locOpts   = `<option value="">— None —</option>` +
            locs.map(l => `<option value="${l.id}" ${p?.default_location_id === l.id ? 'selected' : ''}>${this._esc(l.name || l.id)}</option>`).join('');

        // Derive current tracking type from product fields. New products
        // default to 'status' — the most common case for a household pantry
        // (fresh items, anything you don't really count). Note: 'multipack'
        // is no longer a separate top-level tracking type — it's just Count
        // with an optional pack size > 1 that drives the dot-grid rendering.
        const pCU  = p?.count_unit || 'item';
        const initTT = !p                              ? 'status'
                     : pCU === 'status'                ? 'status'
                     : p?.tracks_percent                ? 'percent'
                     :                                    'count';
        const initUnitsPer = Math.max(1, Number(p?.units_per_pack ?? 1));
        const initCU = (pCU === 'status' || pCU === '%') ? 'item' : pCU;
        const sel = (v) => initTT === v ? 'selected' : '';

        overlay.innerHTML = `
            <div class="pantry-modal" role="dialog" aria-label="${isNew ? 'Add Product' : 'Edit Product'}">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">${isNew ? '+ Add Product' : '✏️ Edit Product'}</div>
                    <button class="pantry-modal-close" id="prodModalClose">×</button>
                </div>
                <div class="pantry-modal-body">

                    <div class="pantry-modal-photo-area" id="prodPhotoArea">
                        ${this._editProductPhoto
                            ? `<img src="${this._editProductPhoto}" class="pantry-modal-photo-img" alt="Product photo">
                               <div class="pantry-modal-photo-overlay">
                                   <button class="pantry-photo-remove-btn" id="prodPhotoRemove">🗑 Remove</button>
                               </div>`
                            : `<div class="pantry-modal-photo-placeholder">
                                   <div style="font-size:28px">📷</div>
                                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
                               </div>`}
                    </div>
                    <input type="file" id="prodPhotoInput" accept="image/*" style="display:none">

                    <div class="pantry-modal-field">
                        <label class="pantry-modal-label">Product Name *</label>
                        <input class="pantry-modal-input" id="prodName" type="text"
                               placeholder="e.g. Lemonade Drink Mix" value="${this._esc(p?.name || '')}">
                    </div>
                    <div class="pantry-modal-field">
                        <label class="pantry-modal-label">
                            Description <span class="pantry-modal-label-hint">(form / size — e.g. Pitcher Packets, 64oz Bottle, Family Pack)</span>
                        </label>
                        <input class="pantry-modal-input" id="prodNotes" type="text"
                               placeholder="e.g. Pitcher Packets" value="${this._esc(p?.notes || '')}">
                    </div>
                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Brand</label>
                            <input class="pantry-modal-input" id="prodBrand" type="text"
                                   placeholder="e.g. Great Value, Brookshire's, or Crystal Light" value="${this._esc(p?.brand || '')}">
                        </div>
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Category</label>
                            <select class="pantry-modal-input" id="prodCategory">${catOpts}</select>
                        </div>
                    </div>

                    <!-- Tracking type selector — three modes only -->
                    <div class="pantry-modal-field">
                        <label class="pantry-modal-label">How to track stock</label>
                        <select class="pantry-modal-input" id="prodTrackType">
                            <option value="status"  ${sel('status')}>Status — Good / Low / Out (fresh items, anything you don't count)</option>
                            <option value="count"   ${sel('count')}>Count — track number of units (cans, bags, eggs…)</option>
                            <option value="percent" ${sel('percent')}>Percent — % remaining (liquids, toothpaste, condiments)</option>
                        </select>
                    </div>

                    <!-- Count fields: unit name + optional pack size -->
                    <div class="pantry-track-count-fields" ${initTT !== 'count' ? 'style="display:none"' : ''}>
                        <div class="pantry-modal-row">
                            <div class="pantry-modal-field">
                                <label class="pantry-modal-label">Unit name (e.g. item, can, packet, egg)</label>
                                <input class="pantry-modal-input" id="prodCountUnit" type="text"
                                       placeholder="item" value="${this._esc(initCU)}">
                            </div>
                            <div class="pantry-modal-field">
                                <label class="pantry-modal-label">
                                    Pack size <span class="pantry-modal-label-hint">(optional — set if buying in boxes / cartons)</span>
                                </label>
                                <input class="pantry-modal-input" id="prodUnitsPer" type="number" min="1" step="1"
                                       value="${initUnitsPer}">
                            </div>
                        </div>
                    </div>

                    <!-- Threshold (hidden for status; label changes for percent) -->
                    <div class="pantry-modal-row pantry-track-thresh-row" ${initTT === 'status' ? 'style="display:none"' : ''}>
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label" id="prodMinThreshLabel">
                                ${initTT === 'percent' ? 'Reorder at (% remaining)' : 'Reorder threshold'}
                            </label>
                            <input class="pantry-modal-input" id="prodMinThresh" type="number" min="0"
                                   step="${initTT === 'percent' ? '5' : '0.5'}"
                                   value="${p?.min_threshold ?? (initTT === 'percent' ? 25 : 1)}">
                        </div>
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Default unit</label>
                            <input class="pantry-modal-input" id="prodDefaultUnit" type="text"
                                   placeholder="count" value="${this._esc(p?.default_unit || 'count')}">
                        </div>
                    </div>

                    <!-- Default store & location -->
                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Default Store</label>
                            <select class="pantry-modal-input" id="prodDefaultStore">${storeOpts}</select>
                        </div>
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Default Location</label>
                            <select class="pantry-modal-input" id="prodDefaultLocation">${locOpts}</select>
                        </div>
                    </div>

                    <!-- Staple toggle -->
                    <div class="pantry-modal-field pantry-modal-field-inline">
                        <label class="pantry-modal-toggle-label">
                            <input type="checkbox" id="prodIsStaple" ${p?.is_staple ? 'checked' : ''}>
                            ⭐ Staple item (always keep in stock)
                        </label>
                    </div>

                    <!-- UPCs section -->
                    <div class="pantry-barcodes-section">
                        <div class="pantry-barcodes-header">
                            <span class="pantry-barcodes-title">🔢 Linked UPCs</span>
                            <button class="pantry-action-btn" id="prodAddUpc">+ Add UPC</button>
                        </div>
                        <div class="pantry-barcodes-list" id="prodBarcodeList">
                            ${this._editProductBarcodes.length === 0
                                ? `<div class="pantry-barcodes-empty">No UPCs linked yet. Add one below or scan a barcode.</div>`
                                : this._editProductBarcodes.map(b => this._barcodePillHTML(b.barcode)).join('')}
                        </div>
                        <div class="pantry-barcode-add-row" id="prodAddUpcRow" hidden>
                            <input class="pantry-modal-input" id="prodUpcInput" type="text"
                                   inputmode="numeric" maxlength="14" placeholder="Enter UPC…">
                            <button class="pantry-action-btn primary" id="prodUpcConfirm">Add</button>
                            <button class="pantry-action-btn" id="prodUpcCancel">Cancel</button>
                        </div>
                    </div>

                </div>
                <div class="pantry-modal-footer">
                    ${!isNew ? `<button class="pantry-modal-delete pantry-modal-delete-footer" id="prodDelete">🗑 Delete</button>` : ''}
                    <button class="pantry-modal-cancel" id="prodCancel">Cancel</button>
                    <button class="pantry-modal-save" id="prodSave">Save Product</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const close = () => {
            overlay.classList.remove('active');
            this._editProduct = null;
            this._editProductPhoto = null;
            this._editProductBarcodes = [];
        };
        overlay.querySelector('#prodModalClose')?.addEventListener('click', close);
        overlay.querySelector('#prodCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        // Tracking type dropdown — show/hide conditional fields on change
        const trackTypeSel   = overlay.querySelector('#prodTrackType');
        const countFields    = overlay.querySelector('.pantry-track-count-fields');
        const threshRow      = overlay.querySelector('.pantry-track-thresh-row');
        const threshLabel    = overlay.querySelector('#prodMinThreshLabel');
        const threshInput    = overlay.querySelector('#prodMinThresh');
        const applyTrackType = () => {
            const tt = trackTypeSel?.value || 'status';
            if (countFields) countFields.style.display = tt === 'count'  ? '' : 'none';
            if (threshRow)   threshRow.style.display   = tt === 'status' ? 'none' : '';
            if (threshLabel) threshLabel.textContent   = tt === 'percent' ? 'Reorder at (% remaining)' : 'Reorder threshold';
            if (threshInput) threshInput.step          = tt === 'percent' ? '5' : '0.5';
        };
        trackTypeSel?.addEventListener('change', applyTrackType);

        // Photo upload
        const photoArea  = overlay.querySelector('#prodPhotoArea');
        const photoInput = overlay.querySelector('#prodPhotoInput');
        photoArea?.addEventListener('click', e => {
            if (!e.target.closest('#prodPhotoRemove')) photoInput?.click();
        });
        photoInput?.addEventListener('change', async e => {
            const file = e.target.files?.[0];
            photoInput.value = '';
            if (!file) return;
            photoArea.innerHTML = `<div class="pantry-modal-photo-placeholder"><div style="font-size:28px">⏳</div><div style="font-size:13px;color:var(--color-muted)">Uploading…</div></div>`;
            try {
                const url = await this.store.uploadPhoto(file, 400, 0.75);
                this._editProductPhoto = url;
                this._refreshProductPhotoArea(overlay);
            } catch { this._editProductPhoto = null; this._refreshProductPhotoArea(overlay); }
        });
        overlay.querySelector('#prodPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editProductPhoto = null;
            this._refreshProductPhotoArea(overlay);
        });

        // UPC management
        const addUpcBtn   = overlay.querySelector('#prodAddUpc');
        const addUpcRow   = overlay.querySelector('#prodAddUpcRow');
        const upcInput    = overlay.querySelector('#prodUpcInput');
        addUpcBtn?.addEventListener('click', () => { addUpcRow.hidden = false; upcInput?.focus(); });
        overlay.querySelector('#prodUpcCancel')?.addEventListener('click', () => { addUpcRow.hidden = true; upcInput.value = ''; });
        const confirmUpc = () => {
            const bc = (upcInput?.value || '').trim().replace(/\D/g, '');
            if (!bc || bc.length < 6) { upcInput?.focus(); return; }
            if (!this._editProductBarcodes.find(b => b.barcode === bc)) {
                this._editProductBarcodes.push({ barcode: bc, source: 'manual' });
            }
            upcInput.value = '';
            addUpcRow.hidden = true;
            this._refreshBarcodePills(overlay);
        };
        overlay.querySelector('#prodUpcConfirm')?.addEventListener('click', confirmUpc);
        upcInput?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmUpc(); });

        overlay.querySelectorAll('.pantry-barcode-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const bc = btn.dataset.barcode;
                this._editProductBarcodes = this._editProductBarcodes.filter(b => b.barcode !== bc);
                this._refreshBarcodePills(overlay);
            });
        });

        // Delete — inline two-step confirmation (no browser confirm() dialog)
        const footer = overlay.querySelector('.pantry-modal-footer');
        const footerNormalHTML = footer ? footer.innerHTML : '';

        const restoreFooter = () => {
            if (!footer) return;
            footer.innerHTML = footerNormalHTML;
            overlay.querySelector('#prodDelete')?.addEventListener('click', showDeleteConfirm);
        };

        const doDelete = async () => {
            if (!this._editProduct?.id) return;
            await this.store.deleteProduct(this._editProduct.id);
            const freshProds = await this.store.fetchProducts();
            if (freshProds) { this._catalogProds = freshProds; this._products = freshProds; }
            close();
            this._render();
        };

        const showDeleteConfirm = () => {
            if (!footer) return;
            footer.innerHTML = `
                <span class="pantry-delete-confirm-msg">⚠ This cannot be undone.</span>
                <button class="pantry-modal-cancel" id="prodDeleteCancel">Cancel</button>
                <button class="pantry-modal-delete" id="prodDeleteConfirm">Yes, Delete</button>`;
            footer.querySelector('#prodDeleteCancel')?.addEventListener('click', restoreFooter);
            footer.querySelector('#prodDeleteConfirm')?.addEventListener('click', doDelete);
        };

        overlay.querySelector('#prodDelete')?.addEventListener('click', showDeleteConfirm);

        // Save
        overlay.querySelector('#prodSave')?.addEventListener('click', async () => {
            const name = overlay.querySelector('#prodName')?.value.trim();
            if (!name) { overlay.querySelector('#prodName')?.focus(); return; }

            // Resolve tracking-type-specific fields. Three top-level modes;
            // multipack is just Count with pack size > 1 under the hood.
            const tt = overlay.querySelector('#prodTrackType')?.value || 'status';
            let units_per_pack = 1;
            let count_unit     = 'item';
            let tracks_percent = false;
            if (tt === 'count') {
                count_unit     = overlay.querySelector('#prodCountUnit')?.value.trim() || 'item';
                units_per_pack = Math.max(1, parseFloat(overlay.querySelector('#prodUnitsPer')?.value) || 1);
            } else if (tt === 'percent') {
                tracks_percent = true;
                count_unit     = '%';
            } else {
                // status (default)
                count_unit     = 'status';
            }

            const payload = {
                name,
                brand:               overlay.querySelector('#prodBrand')?.value.trim() || '',
                category_id:         overlay.querySelector('#prodCategory')?.value || 'other',
                image_url:           this._editProductPhoto || '',
                barcodes:            this._editProductBarcodes.map(b => b.barcode),
                tracks_percent,
                units_per_pack,
                count_unit,
                min_threshold:       parseFloat(overlay.querySelector('#prodMinThresh')?.value) || 0,
                default_unit:        overlay.querySelector('#prodDefaultUnit')?.value.trim() || 'count',
                default_store_id:    overlay.querySelector('#prodDefaultStore')?.value || null,
                default_location_id: overlay.querySelector('#prodDefaultLocation')?.value || null,
                is_staple:           overlay.querySelector('#prodIsStaple')?.checked ? 1 : 0,
                // Description (rendered as sub-name on cards)
                notes:               overlay.querySelector('#prodNotes')?.value.trim() || '',
            };
            if (this._editProduct?.id) {
                await this.store.updateProduct(this._editProduct.id, payload);
            } else {
                await this.store.createProduct(payload);
            }
            // Refresh both products AND inventory: an edit to name/brand/photo/
            // description (notes) shows up on inventory cards via the JOIN, so
            // the inventory cache needs to refetch too — the store doesn't
            // auto-emit on product PATCH.
            const [freshProds, freshInv] = await Promise.all([
                this.store.fetchProducts(),
                this.store.fetchInventory(),
            ]);
            if (freshProds) { this._catalogProds = freshProds; this._products = freshProds; }
            if (freshInv)   { this._inventory = freshInv; }
            close();
            this._render();
        });

        setTimeout(() => overlay.querySelector('#prodName')?.focus(), 50);
    }

    _barcodePillHTML(barcode) {
        return `<div class="pantry-barcode-pill">
            <span class="pantry-barcode-value">${this._esc(barcode)}</span>
            <button class="pantry-barcode-remove" data-barcode="${this._esc(barcode)}" title="Remove">×</button>
        </div>`;
    }

    _refreshBarcodePills(overlay) {
        const list = overlay.querySelector('#prodBarcodeList');
        if (!list) return;
        list.innerHTML = this._editProductBarcodes.length === 0
            ? `<div class="pantry-barcodes-empty">No UPCs linked yet.</div>`
            : this._editProductBarcodes.map(b => this._barcodePillHTML(b.barcode)).join('');
        overlay.querySelectorAll('.pantry-barcode-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const bc = btn.dataset.barcode;
                this._editProductBarcodes = this._editProductBarcodes.filter(b => b.barcode !== bc);
                this._refreshBarcodePills(overlay);
            });
        });
    }

    _refreshProductPhotoArea(overlay) {
        const area = overlay.querySelector('#prodPhotoArea');
        if (!area) return;
        area.innerHTML = this._editProductPhoto
            ? `<img src="${this._editProductPhoto}" class="pantry-modal-photo-img" alt="Product photo">
               <div class="pantry-modal-photo-overlay">
                   <button class="pantry-photo-remove-btn" id="prodPhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="pantry-modal-photo-placeholder">
                   <div style="font-size:28px">📷</div>
                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
               </div>`;
        overlay.querySelector('#prodPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editProductPhoto = null;
            this._refreshProductPhotoArea(overlay);
        });
        const input = overlay.querySelector('#prodPhotoInput');
        if (input) area.appendChild(input);
    }

    // ── STORE MODE OVERLAY ────────────────────────────────────────────────────

    _openStoreMode() {
        const overlay = document.getElementById('pantryStoreModeOverlay');
        if (!overlay) return;

        const inStoreItems = this._items.filter(i => i.fulfillment === 'instore');

        overlay.innerHTML = `
            <div class="pantry-store-mode">
                <div class="pantry-store-header">
                    <div class="pantry-store-header-left">
                        <div class="pantry-store-title">🏪 In-Store List</div>
                        <div class="pantry-store-subtitle">
                            ${inStoreItems.filter(i => !i.checked).length} items remaining
                        </div>
                    </div>
                    <button class="pantry-store-close" id="pantryStoreClose">✕ Done</button>
                </div>
                <div class="pantry-store-progress-bar">
                    <div class="pantry-store-progress-fill" style="width:${
                        inStoreItems.length > 0
                            ? (inStoreItems.filter(i => i.checked).length / inStoreItems.length * 100).toFixed(1)
                            : 0}%"></div>
                </div>
                <div class="pantry-store-items" id="pantryStoreItems">
                    ${inStoreItems.length === 0
                        ? `<div style="text-align:center;padding:60px 20px;color:rgba(255,255,255,0.6)">
                               <div style="font-size:48px;margin-bottom:12px">🎉</div>
                               <div style="font-size:18px;font-weight:700">All done!</div>
                               <div style="margin-top:6px">Nothing left to grab in-store.</div>
                           </div>`
                        : inStoreItems.map(item => this._storeModeItemHTML(item)).join('')}
                </div>
            </div>`;

        overlay.classList.add('active');

        overlay.querySelector('#pantryStoreClose')?.addEventListener('click', () => {
            overlay.classList.remove('active');
        });

        overlay.querySelectorAll('.pantry-store-item').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.dataset.id;
                this._toggleItem(id);
                const item = this._items.find(i => i.id === id);
                if (item) {
                    row.classList.toggle('checked', item.checked);
                    const check = row.querySelector('.pantry-store-check');
                    if (check) check.classList.toggle('done', item.checked);
                    check.innerHTML = item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>'
                        : '';
                    const remaining = this._items.filter(i => i.fulfillment === 'instore' && !i.checked).length;
                    overlay.querySelector('.pantry-store-subtitle').textContent = `${remaining} items remaining`;
                    const total2 = this._items.filter(i => i.fulfillment === 'instore').length;
                    const done2  = total2 - remaining;
                    overlay.querySelector('.pantry-store-progress-fill').style.width =
                        total2 > 0 ? `${(done2 / total2 * 100).toFixed(1)}%` : '0%';
                }
            });
        });
    }

    _storeModeItemHTML(item) {
        const amountStr = [item.amount, item.unit].filter(Boolean).join(' ');
        return `
            <div class="pantry-store-item${item.checked ? ' checked' : ''}" data-id="${item.id}">
                <div class="pantry-store-check${item.checked ? ' done' : ''}">
                    ${item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>'
                        : ''}
                </div>
                ${item.photo
                    ? `<div class="pantry-store-photo" style="background-image:url('${item.photo}')"></div>`
                    : ''}
                <div class="pantry-store-item-info">
                    <div class="pantry-store-item-name">${this._esc(item.name)}</div>
                    ${amountStr ? `<div class="pantry-store-item-amount">${this._esc(amountStr)}</div>` : ''}
                    ${item.notes ? `<div class="pantry-store-item-notes">${this._esc(item.notes)}</div>` : ''}
                </div>
                <div class="pantry-store-cat">${catOf(item.category).emoji}</div>
            </div>`;
    }

    // ── ITEM MODAL (add/edit) ─────────────────────────────────────────────────

    /**
     * Open the Add / Edit item modal.
     * @param {object|null} item   - Existing shopping-list item to edit, or null for new.
     * @param {object|null} prefill - Pre-fill values for a NEW item (scan flow). When
     *                               provided, the modal opens in "Add" mode with fields
     *                               already filled in from the barcode lookup.
     */
    _openItemModal(item = null, prefill = null) {
        this._editItem        = item ?? null;
        this._editItemPrefill = prefill ?? null;
        // Use || not ?? so that empty-string photo is treated as "no photo"
        this._editItemPhoto   = item?.photo || prefill?.photo || null;
        this._renderItemModal();
    }

    _renderItemModal() {
        const overlay = document.getElementById('pantryItemOverlay');
        if (!overlay) return;
        const item    = this._editItem;
        const prefill = this._editItemPrefill;  // scan pre-fill (new item mode)
        const isNew   = !item;
        // Merge: existing item takes priority; prefill is used only for new items
        const val = (field) => item?.[field] ?? prefill?.[field] ?? null;

        overlay.innerHTML = `
            <div class="pantry-modal" role="dialog" aria-modal="true">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">${isNew ? '➕ Add Item' : '✏️ Edit Item'}</div>
                    <button class="pantry-modal-close" id="pantryItemClose">×</button>
                </div>
                <div class="pantry-modal-body">

                    <div class="pantry-modal-photo-area" id="pantryItemPhotoArea">
                        ${this._editItemPhoto
                            ? `<img src="${this._editItemPhoto}" class="pantry-modal-photo-img" alt="Item photo">
                               <div class="pantry-modal-photo-overlay">
                                   <button class="pantry-photo-remove-btn" id="pantryItemPhotoRemove">🗑 Remove</button>
                               </div>`
                            : `<div class="pantry-modal-photo-placeholder">
                                   <div style="font-size:28px">📷</div>
                                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
                               </div>`
                        }
                    </div>
                    <input type="file" id="pantryItemPhotoInput" accept="image/*" style="display:none">

                    <div class="pantry-modal-field">
                        <label>Item Name *</label>
                        <input type="text" id="pantryItemName" class="pantry-modal-input"
                               value="${this._esc(val('name') || '')}"
                               placeholder="e.g. Organic Whole Milk" autocomplete="off">
                        <div class="pantry-item-suggestions" id="pantryItemSuggestions"></div>
                    </div>

                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label>Amount</label>
                            <input type="number" id="pantryItemAmount" class="pantry-modal-input"
                                   min="0.25" step="0.25"
                                   value="${this._esc(val('amount') || val('qty') || 1)}">
                        </div>
                        <div class="pantry-modal-field">
                            <label>Unit</label>
                            <input type="text" id="pantryItemUnit" class="pantry-modal-input"
                                   value="${this._esc(val('unit') && val('unit') !== 'count' ? val('unit') : '')}" placeholder="lbs, bags, cans…">
                        </div>
                    </div>

                    <div class="pantry-modal-field">
                        <label>Category</label>
                        <select id="pantryItemCategory" class="pantry-modal-input">
                            ${CATEGORIES.map(c =>
                                `<option value="${c.id}" ${(val('category') || 'other') === c.id ? 'selected' : ''}>
                                    ${c.emoji} ${c.label}</option>`).join('')}
                        </select>
                    </div>

                    ${!isNew ? `
                    <div class="pantry-modal-field">
                        <label>Fulfillment</label>
                        <div class="pantry-fulfillment-toggle">
                            <button class="pantry-fulfillment-btn${(val('fulfillment') || 'unplanned') === 'unplanned' ? ' active' : ''}"
                                    data-ful="unplanned">— Not Planned</button>
                            <button class="pantry-fulfillment-btn${val('fulfillment') === 'curbside' ? ' active' : ''}"
                                    data-ful="curbside">🛻 Curbside</button>
                            <button class="pantry-fulfillment-btn${val('fulfillment') === 'instore' ? ' active' : ''}"
                                    data-ful="instore">🏪 In-Store</button>
                        </div>
                    </div>` : ''}

                    ${!isNew && val('fulfillment') === 'curbside' ? `
                    <div class="pantry-modal-field">
                        <label>Order Status</label>
                        <div class="pantry-order-status-btns">
                            <button class="pantry-order-status-btn${val('orderStatus') === 'ordered' ? ' active' : ''}"
                                    id="pantryToggleOrdered">
                                🟡 ${val('orderStatus') === 'ordered' ? 'Ordered ✓' : 'Mark as Ordered'}
                            </button>
                            ${val('orderStatus') === 'ordered' ? `
                            <button class="pantry-order-status-btn danger" id="pantryMarkOOS">
                                🔴 Out of Stock → In-Store
                            </button>` : ''}
                        </div>
                    </div>` : ''}

                    <div class="pantry-modal-field">
                        <label>Brand</label>
                        <input type="text" id="pantryItemBrand" class="pantry-modal-input"
                               value="${this._esc(val('brand') || '')}"
                               placeholder="e.g. Quaker — or list any acceptable brands">
                    </div>

                    <div class="pantry-modal-field">
                        <label>For this run</label>
                        <input type="text" id="pantryItemNotes" class="pantry-modal-input"
                               value="${this._esc(val('notes') || '')}"
                               placeholder="One-off note, cleared when the item is bought">
                    </div>

                    <div class="pantry-modal-field">
                        <label>Store</label>
                        <select id="pantryItemStore" class="pantry-modal-input">
                            <option value="">— Any store —</option>
                            ${(this.store.config.stores || []).map(s => {
                                const sel = (val('storeId') === s.id) ? ' selected' : '';
                                return `<option value="${this._esc(s.id)}"${sel}>${this._esc(s.name)}</option>`;
                            }).join('')}
                        </select>
                    </div>

                    <div class="pantry-modal-field">
                        <label>Added By</label>
                        <select id="pantryItemAddedBy" class="pantry-modal-input">
                            <option value="">—</option>
                            ${this._familyOptions(val('addedBy') || this._lastAddedBy())}
                        </select>
                    </div>

                </div>
                <div class="pantry-modal-footer">
                    <button class="pantry-modal-save" id="pantryItemSave">
                        ${isNew ? 'Add to List' : 'Save Changes'}
                    </button>
                    <button class="pantry-modal-cancel" id="pantryItemCancel">Cancel</button>
                    ${!isNew ? `
                        <button class="pantry-modal-delete-footer" id="pantryItemDelete">🗑 Remove</button>` : ''}
                </div>
            </div>`;

        overlay.classList.add('active');

        const nameInput = overlay.querySelector('#pantryItemName');
        const catSelect = overlay.querySelector('#pantryItemCategory');
        // Reset autocomplete-link state for this open of the modal
        this._pickedItemProductId = null;
        this._pickedItemSnapshot  = null;
        nameInput?.addEventListener('input', () => {
            // If the user types away from the picked suggestion, drop the link
            // so we don't accidentally save under a stale productId.
            if (this._pickedItemSnapshot &&
                nameInput.value.trim().toLowerCase() !== this._pickedItemSnapshot.name.toLowerCase()) {
                this._pickedItemProductId = null;
                this._pickedItemSnapshot  = null;
            }
            // Only auto-detect if the category hasn't been set explicitly (still at default)
            if (catSelect && catSelect.value === 'other') {
                const cat = detectCategory(nameInput.value);
                if (cat !== 'other') catSelect.value = cat;
            }
            this._showItemSuggestions(nameInput.value, overlay);
        });

        overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Photo upload (addon version — async multipart POST)
        const photoArea  = overlay.querySelector('#pantryItemPhotoArea');
        const photoInput = overlay.querySelector('#pantryItemPhotoInput');
        photoArea?.addEventListener('click', e => {
            if (!e.target.closest('#pantryItemPhotoRemove')) photoInput?.click();
        });
        photoInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            photoInput.value = '';
            if (!file) return;
            this._showPhotoUploading(photoArea);
            try {
                const url = await this.store.uploadPhoto(file, 400, 0.75);
                this._editItemPhoto = url;
                this._updateItemPhotoPreview(overlay);
            } catch (err) {
                console.error('[PantryApp] Photo upload failed:', err);
                this._editItemPhoto = null;
                this._updateItemPhotoPreview(overlay);
            }
        });
        overlay.querySelector('#pantryItemPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editItemPhoto = null;
            this._updateItemPhotoPreview(overlay);
        });

        const close = () => { overlay.classList.remove('active'); this._editItem = null; this._editItemPhoto = null; this._editItemPrefill = null; };
        overlay.querySelector('#pantryItemClose')?.addEventListener('click', close);
        overlay.querySelector('#pantryItemCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#pantryToggleOrdered')?.addEventListener('click', () => {
            if (!this._editItem) return;
            const next = this._editItem.orderStatus === 'ordered' ? null : 'ordered';
            this._updateItem(this._editItem.id, { orderStatus: next });
            close();
        });
        overlay.querySelector('#pantryMarkOOS')?.addEventListener('click', () => {
            if (!this._editItem) return;
            this._updateItem(this._editItem.id, { fulfillment: 'instore', orderStatus: null });
            close();
        });

        overlay.querySelector('#pantryItemSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.pantry-fulfillment-btn.active');
            const addedBy = overlay.querySelector('#pantryItemAddedBy')?.value || '';
            if (addedBy) this._rememberAddedBy(addedBy);
            const storeId = overlay.querySelector('#pantryItemStore')?.value || null;
            const data = {
                name,
                amount:   overlay.querySelector('#pantryItemAmount')?.value || '1',
                unit:     overlay.querySelector('#pantryItemUnit')?.value.trim() || '',
                category: catSelect?.value || detectCategory(name),
                brand:    overlay.querySelector('#pantryItemBrand')?.value.trim() || '',
                notes:    overlay.querySelector('#pantryItemNotes')?.value.trim() || '',
                addedBy:  addedBy || null,
                storeId:  storeId || null,
                photo:    this._editItemPhoto || '',
            };
            // Only include fulfillment when editing an existing item (assigned inline for new items)
            if (fulfillmentActive) data.fulfillment = fulfillmentActive.dataset.ful;
            // Thread scan productId through so the shopping list row links to the catalog product.
            // Carry every prefill field so _addItem can detect which ones the user edited
            // and propagate the product-attribute edits (name, brand, category, photo) onto
            // the linked catalog product. `notes` is row-local on the shopping list — it
            // captures one-off shopping-run notes and never propagates to the catalog.
            if (!this._editItem && prefill?.productId) {
                data.productId            = prefill.productId;
                data.originalScanName     = prefill.name     ?? null;
                data.originalScanBrand    = prefill.brand    ?? null;
                data.originalScanCategory = prefill.category ?? null;
                data.originalScanPhoto    = prefill.photo    ?? null;
            } else if (!this._editItem && this._pickedItemProductId) {
                // User picked an autocomplete suggestion → link to the existing
                // catalog product. Seed originalScan* from the snapshot so the
                // propagation diff in _addItem only fires on fields the user
                // actually edited after picking.
                data.productId            = this._pickedItemProductId;
                data.originalScanName     = this._pickedItemSnapshot?.name     ?? null;
                data.originalScanBrand    = this._pickedItemSnapshot?.brand    ?? null;
                data.originalScanCategory = this._pickedItemSnapshot?.category ?? null;
                data.originalScanPhoto    = this._pickedItemSnapshot?.photo    ?? null;
            }
            if (this._editItem) {
                this._updateItem(this._editItem.id, data);
            } else {
                this._addItem(data);
            }
            close();
        });

        overlay.querySelector('#pantryItemDelete')?.addEventListener('click', () => {
            if (this._editItem) { this._removeItem(this._editItem.id); close(); }
        });

        setTimeout(() => nameInput?.focus(), 50);
    }

    _showPhotoUploading(area) {
        if (!area) return;
        area.innerHTML = `
            <div class="pantry-modal-photo-placeholder">
                <div style="font-size:28px">⏳</div>
                <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Uploading photo…</div>
            </div>`;
    }

    _updateItemPhotoPreview(overlay) {
        const area  = overlay.querySelector('#pantryItemPhotoArea');
        const input = overlay.querySelector('#pantryItemPhotoInput');
        if (!area) return;
        area.innerHTML = this._editItemPhoto
            ? `<img src="${this._editItemPhoto}" class="pantry-modal-photo-img" alt="Item photo">
               <div class="pantry-modal-photo-overlay">
                   <button class="pantry-photo-remove-btn" id="pantryItemPhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="pantry-modal-photo-placeholder">
                   <div style="font-size:28px">📷</div>
                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
               </div>`;
        overlay.querySelector('#pantryItemPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editItemPhoto = null; this._updateItemPhotoPreview(overlay);
        });
        if (input) area.appendChild(input);
    }

    _showItemSuggestions(q, overlay) {
        const sug = overlay.querySelector('#pantryItemSuggestions');
        if (!sug) return;
        if (!q || q.length < 2) { sug.innerHTML = ''; return; }
        const ql = q.toLowerCase();

        // 1. Inventory items — best match (in pantry, has stock info).
        // Always carry productId so picking links the shopping row to the
        // catalog product (no duplicate created on save).
        const invMatches = this._inventory
            .filter(i => i.name.toLowerCase().includes(ql))
            .map(i => ({
                source: 'inv', id: i.id, productId: i.productId,
                name: i.name, brand: i.brand || '',
                category: i.category, photo: i.photo || '',
            }));

        // 2. Product catalog — items not already surfaced via inventory
        const invNames = new Set(invMatches.map(i => i.name.toLowerCase()));
        const prodMatches = this._products
            .filter(p => p.name.toLowerCase().includes(ql) && !invNames.has(p.name.toLowerCase()))
            .map(p => ({
                source: 'prod', id: p.id, productId: p.id,
                name: p.name, brand: p.brand || '',
                category: this._categoryGroceryId(p.category_id),
                photo: p.image_url || '',
            }));

        const matches = [...invMatches, ...prodMatches].slice(0, 6);
        if (!matches.length) { sug.innerHTML = ''; return; }

        sug.innerHTML = matches.map((m, idx) => `
            <div class="pantry-item-suggestion" data-sug-idx="${idx}">
                <span class="pantry-sug-cat">${catOf(m.category).emoji}</span>
                <span class="pantry-sug-name">${this._esc(m.name)}</span>
                ${m.brand ? `<span class="pantry-sug-brand">${this._esc(m.brand)}</span>` : ''}
                ${m.source === 'inv'
                    ? '<span class="pantry-sug-badge inv">In Pantry</span>'
                    : '<span class="pantry-sug-badge prod">Saved</span>'}
            </div>`).join('');

        sug.querySelectorAll('.pantry-item-suggestion').forEach(el => {
            el.addEventListener('mousedown', e => {
                e.preventDefault();
                const m = matches[parseInt(el.dataset.sugIdx)];
                if (!m) return;
                overlay.querySelector('#pantryItemName').value     = m.name;
                overlay.querySelector('#pantryItemBrand').value    = m.brand || '';
                overlay.querySelector('#pantryItemCategory').value = m.category || 'other';
                if (m.photo) { this._editItemPhoto = m.photo; this._updateItemPhotoPreview(overlay); }
                // Track the linked product so the save handler can pass productId
                // and prevent the backend from auto-creating a duplicate. Cleared
                // when the user types again (see name-input handler).
                this._pickedItemProductId = m.productId || null;
                this._pickedItemSnapshot  = {
                    name:     m.name,
                    brand:    m.brand || '',
                    category: m.category || 'other',
                    photo:    m.photo || '',
                };
                sug.innerHTML = '';
            });
        });
    }

    // ── INVENTORY MODAL (add/edit pantry item) ────────────────────────────────

    _openInvModal(inv = null, prefill = null) {
        this._editInvItem  = inv ?? null;
        this._editInvPhoto = inv?.photo ?? prefill?.photo ?? null;
        this._prefillInv   = prefill ?? null;
        this._renderInvModal();
    }

    _renderInvModal() {
        const overlay = document.getElementById('pantryInvOverlay');
        if (!overlay) return;
        const inv     = this._editInvItem;
        const prefill = this._prefillInv;
        const isNew   = !inv;

        // Resolve pack-size info from the linked catalog product so the qty
        // input can show the boxes→individual-units conversion.
        const pid      = inv?.productId || prefill?.productId || null;
        const prod     = pid ? (this._products?.find(p => p.id === pid) ?? null) : null;
        const unitsPer = Math.max(1, Number(prod?.units_per_pack ?? 1));
        const countUnit = (prod?.count_unit || 'item').trim();
        const packLabel = unitsPer > 1 ? `packs (${unitsPer} ${countUnit}s each)` : countUnit + 's';
        // For editing, show current qty converted back to packs when possible.
        const currentPacks = isNew ? 1 : (unitsPer > 1
            ? Math.max(1, Math.round((inv?.qty ?? 1) / unitsPer))
            : (inv?.qty ?? 1));

        overlay.innerHTML = `
            <div class="pantry-modal" role="dialog" aria-modal="true">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">${isNew ? '📦 Add to Inventory' : `✏️ Edit: ${this._esc(inv.name)}`}</div>
                    <button class="pantry-modal-close" id="pantryInvClose">×</button>
                </div>
                <div class="pantry-modal-body">

                    <!-- Read-only product thumbnail — edit image/brand/name in Catalog -->
                    <div class="pantry-inv-thumb-row">
                        <div class="pantry-inv-thumb">
                            ${this._editInvPhoto
                                ? `<img src="${this._editInvPhoto}" alt="Product photo">`
                                : `<div class="pantry-inv-thumb-placeholder">📦</div>`}
                        </div>
                        <div class="pantry-inv-thumb-meta">
                            <div class="pantry-inv-thumb-name">${this._esc(inv?.name || prefill?.name || 'New item')}</div>
                            ${(inv?.brand || prefill?.brand) ? `<div class="pantry-inv-thumb-brand">${this._esc(inv?.brand || prefill?.brand)}</div>` : ''}
                            <div class="pantry-inv-thumb-hint">To change photo or name, edit in Catalog.</div>
                        </div>
                    </div>

                    <div class="pantry-modal-field">
                        <label>Item Name *</label>
                        <input type="text" id="pantryInvName" class="pantry-modal-input"
                               value="${this._esc(inv?.name || prefill?.name || '')}" placeholder="e.g. Organic Whole Milk">
                    </div>

                    <!-- Qty added — pack-aware when product has units_per_pack > 1 -->
                    <div class="pantry-modal-field">
                        <label>${unitsPer > 1 ? `How many ${packLabel} are you adding?` : `Qty (${countUnit}s)`}</label>
                        <input type="number" id="pantryInvQtyPacks" class="pantry-modal-input"
                               min="1" step="1" value="${currentPacks}">
                        ${unitsPer > 1
                            ? `<div class="pantry-inv-qty-calc" id="pantryInvQtyCalc">= ${currentPacks * unitsPer} ${countUnit}s</div>`
                            : ''}
                    </div>

                    <div class="pantry-modal-field">
                        <label>Category</label>
                        <select id="pantryInvCategory" class="pantry-modal-input">
                            ${CATEGORIES.map(c =>
                                `<option value="${c.id}" ${(inv?.category || prefill?.category || 'other') === c.id ? 'selected' : ''}>
                                    ${c.emoji} ${c.label}</option>`).join('')}
                        </select>
                    </div>

                    <div class="pantry-modal-field">
                        <label>Default Fulfillment</label>
                        <div class="pantry-fulfillment-toggle">
                            <button class="pantry-fulfillment-btn${(inv?.defaultFulfillment ?? 'curbside') === 'curbside' ? ' active' : ''}"
                                    data-ful="curbside">🚗 Curbside / Delivery</button>
                            <button class="pantry-fulfillment-btn${inv?.defaultFulfillment === 'instore' ? ' active' : ''}"
                                    data-ful="instore">🏪 In-Store</button>
                        </div>
                    </div>

                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label>Brand</label>
                            <input type="text" id="pantryInvBrand" class="pantry-modal-input"
                                   value="${this._esc(inv?.brand || prefill?.brand || '')}"
                                   placeholder="e.g. Quaker — or list any acceptable brands">
                        </div>
                        <div class="pantry-modal-field">
                            <label>Location</label>
                            <select id="pantryInvLocation" class="pantry-modal-input">
                                <option value="">— None —</option>
                                ${(this.store.config?.locations || []).map(l => {
                                    const sel = ((inv?.locationId ?? prefill?.locationId) === l.id) ? ' selected' : '';
                                    return `<option value="${this._esc(l.id)}"${sel}>${this._esc(l.name || l.id)}</option>`;
                                }).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="pantry-modal-field">
                        <label class="pantry-checkbox-label">
                            <input type="checkbox" id="pantryInvAutoAdd" ${inv?.autoAddToList ? 'checked' : ''}>
                            🛒 Auto-add to shopping list when marked Out
                        </label>
                    </div>

                    <div class="pantry-modal-field">
                        <label class="pantry-checkbox-label">
                            <input type="checkbox" id="pantryInvStaple" ${inv?.isStaple ? 'checked' : ''}>
                            ⭐ Weekly Staple — auto-include when building the list
                        </label>
                    </div>

                    ${!isNew ? `
                        <button class="pantry-modal-delete" id="pantryInvDelete">🗑 Remove from Inventory</button>` : ''}
                </div>
                <div class="pantry-modal-footer">
                    <button class="pantry-modal-save" id="pantryInvSave">
                        ${isNew ? 'Add to Inventory' : 'Save Changes'}
                    </button>
                    <button class="pantry-modal-cancel" id="pantryInvCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const nameInput = overlay.querySelector('#pantryInvName');
        const catSelect = overlay.querySelector('#pantryInvCategory');
        nameInput?.addEventListener('input', () => {
            if (catSelect && catSelect.value === 'other') {
                const cat = detectCategory(nameInput.value);
                if (cat !== 'other') catSelect.value = cat;
            }
        });

        overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Live-update the packs → individual units calculation
        const qtyInput = overlay.querySelector('#pantryInvQtyPacks');
        const qtyCalc  = overlay.querySelector('#pantryInvQtyCalc');
        if (qtyInput && qtyCalc && unitsPer > 1) {
            qtyInput.addEventListener('input', () => {
                const packs = Math.max(0, parseInt(qtyInput.value) || 0);
                qtyCalc.textContent = `= ${packs * unitsPer} ${countUnit}s`;
            });
        }

        const close = () => { overlay.classList.remove('active'); this._editInvItem = null; this._editInvPhoto = null; };
        overlay.querySelector('#pantryInvClose')?.addEventListener('click', close);
        overlay.querySelector('#pantryInvCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#pantryInvSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.pantry-fulfillment-btn.active');
            const packs   = Math.max(1, parseInt(qtyInput?.value) || 1);
            const totalQty = packs * unitsPer;
            const data = {
                name,
                qty:                totalQty,
                category:           catSelect?.value || detectCategory(name),
                defaultFulfillment: fulfillmentActive?.dataset.ful || 'curbside',
                isStaple:           overlay.querySelector('#pantryInvStaple')?.checked ?? false,
                photo:              this._editInvPhoto || null,
                brand:              overlay.querySelector('#pantryInvBrand')?.value.trim()    || '',
                locationId:         overlay.querySelector('#pantryInvLocation')?.value || null,
                autoAddToList:      overlay.querySelector('#pantryInvAutoAdd')?.checked ?? false,
                productId:          prefill?.productId || null,
                stockLevel:         prefill?.stockLevel || null,
            };
            if (this._editInvItem) {
                this._updateInventoryItem(this._editInvItem.id, data);
            } else {
                this._addInventoryItem(data);
            }
            close();
        });

        overlay.querySelector('#pantryInvDelete')?.addEventListener('click', () => {
            if (this._editInvItem) { this._removeInventoryItem(this._editInvItem.id); close(); }
        });

        setTimeout(() => nameInput?.focus(), 50);
    }

    _updateInvPhotoPreview(overlay) {
        const area  = overlay.querySelector('#pantryInvPhotoArea');
        const input = overlay.querySelector('#pantryInvPhotoInput');
        if (!area) return;
        area.innerHTML = this._editInvPhoto
            ? `<img src="${this._editInvPhoto}" class="pantry-modal-photo-img" alt="Item photo">
               <div class="pantry-modal-photo-overlay">
                   <button class="pantry-photo-remove-btn" id="pantryInvPhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="pantry-modal-photo-placeholder">
                   <div style="font-size:28px">📷</div>
                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Product photo (helps with brand ID)</div>
               </div>`;
        overlay.querySelector('#pantryInvPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editInvPhoto = null; this._updateInvPhotoPreview(overlay);
        });
        if (input) area.appendChild(input);
    }

    // ── MEAL PLAN IMPORT ──────────────────────────────────────────────────────

    async _openMealPlanImport() {
        const overlay = document.getElementById('pantryMealPlanOverlay');
        if (!overlay) return;

        overlay.innerHTML = `
            <div class="pantry-modal" style="max-width:560px">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">📅 Import from Meal Plan</div>
                    <button class="pantry-modal-close" id="pantryMPClose">×</button>
                </div>
                <div class="pantry-modal-body" id="pantryMPBody">
                    <div style="text-align:center;padding:40px;color:var(--color-muted)">
                        Loading this week's meal plan…
                    </div>
                </div>
                <div class="pantry-modal-footer" id="pantryMPFooter" style="display:none">
                    <button class="pantry-modal-save" id="pantryMPAdd">Add Selected Items</button>
                    <button class="pantry-modal-cancel" id="pantryMPCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');
        overlay.querySelector('#pantryMPClose')?.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.querySelector('#pantryMPCancel')?.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('active'); });

        const mealStore   = window.mealPlanner?.store;
        const recipeStore = window.recipeApp?.store;
        if (!mealStore) {
            overlay.querySelector('#pantryMPBody').innerHTML =
                `<div style="padding:20px;color:var(--color-muted)">Meal planner not available.</div>`;
            return;
        }

        const today   = new Date();
        const dates   = weekDates(today);
        const weekKey = isoWeek(dates[0]);
        const weekData = mealStore.loadCached(weekKey);

        const ingredientMap  = new Map();
        const recipeGroups   = [];
        const recipeKeyIndex = new Map();

        const DAY_NAMES   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const MEAL_LABELS = { breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack' };

        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const dayData = weekData[dayIdx] || {};
            for (const [mealType, meal] of Object.entries(dayData)) {
                if (!meal?.recipeSlug) continue;
                const recipe = recipeStore?.loadCachedRecipe(meal.recipeSlug)
                            ?? await recipeStore?.fetchRecipe(meal.recipeSlug);
                if (!recipe?.ingredients?.length) continue;

                const groupLabel = recipe.name || meal.name || 'Untitled Recipe';
                const dayLabel   = `${DAY_NAMES[dates[dayIdx]?.getDay?.() ?? dayIdx]} · ${MEAL_LABELS[mealType] || mealType}`;

                if (!recipeKeyIndex.has(groupLabel)) {
                    recipeKeyIndex.set(groupLabel, recipeGroups.length);
                    recipeGroups.push({ recipeName: groupLabel, dayLabel, photo: recipe.photo || null, ingredients: [] });
                }
                const group = recipeGroups[recipeKeyIndex.get(groupLabel)];

                recipe.ingredients.forEach(ing => {
                    if (!ing.name?.trim()) return;
                    const key = ing.name.toLowerCase().trim();
                    if (!ingredientMap.has(key)) {
                        ingredientMap.set(key, {
                            name:         ing.name.trim(),
                            amount:       ing.amount || '',
                            unit:         ing.unit   || '',
                            category:     detectCategory(ing.name),
                            selected:     true,
                            alreadyOnList: this._items.some(i => i.name.toLowerCase() === key && !i.checked),
                        });
                        group.ingredients.push(key);
                    }
                });
            }
        }

        const allIngredients = Array.from(ingredientMap.values());

        if (allIngredients.length === 0) {
            overlay.querySelector('#pantryMPBody').innerHTML = `
                <div class="pantry-empty" style="padding:40px 20px">
                    <div class="pantry-empty-icon">📅</div>
                    <div class="pantry-empty-title">No linked recipes found</div>
                    <div class="pantry-empty-text">
                        Link recipes to your meal plan slots to auto-populate ingredients.<br>
                        ${Object.keys(weekData).length === 0 ? 'Your meal plan for this week is also empty.' : ''}
                    </div>
                </div>`;
            return;
        }

        this._mpIngredients = allIngredients;
        const ingIndex = new Map(allIngredients.map((ing, i) => [ing.name.toLowerCase().trim(), i]));

        overlay.querySelector('#pantryMPBody').innerHTML = `
            <div class="pantry-mp-info">
                Found <strong>${allIngredients.length} ingredient${allIngredients.length !== 1 ? 's' : ''}</strong> across
                <strong>${recipeGroups.length} recipe${recipeGroups.length !== 1 ? 's' : ''}</strong>
                for ${formatWeekRange(dates)}.
            </div>
            <div class="pantry-mp-controls">
                <button class="pantry-mp-toggle-all" id="pantryMPSelectAll">☑ Select all</button>
                <button class="pantry-mp-toggle-all" id="pantryMPDeselectAll">☐ Deselect all</button>
            </div>
            <div class="pantry-mp-list">
                ${recipeGroups.map(group => `
                    <div class="pantry-mp-recipe-group">
                        <div class="pantry-mp-recipe-header">
                            ${group.photo
                                ? `<img src="${group.photo}" class="pantry-mp-recipe-photo" alt="">`
                                : `<span class="pantry-mp-recipe-photo-placeholder">🍽️</span>`}
                            <div class="pantry-mp-recipe-meta">
                                <div class="pantry-mp-recipe-name">${this._esc(group.recipeName)}</div>
                                <div class="pantry-mp-recipe-day">${this._esc(group.dayLabel)} · ${group.ingredients.length} ingredient${group.ingredients.length !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        ${group.ingredients.map(key => {
                            const ing = ingredientMap.get(key);
                            const idx = ingIndex.get(key);
                            const cat = catOf(ing.category);
                            const amountStr = [ing.amount, ing.unit].filter(Boolean).join(' ');
                            return `
                                <label class="pantry-mp-row${ing.alreadyOnList ? ' already' : ''}">
                                    <input type="checkbox" class="pantry-mp-check" data-idx="${idx}"
                                           ${ing.selected && !ing.alreadyOnList ? 'checked' : ''}
                                           ${ing.alreadyOnList ? 'disabled' : ''}>
                                    <span class="pantry-mp-row-check"></span>
                                    <span class="pantry-mp-row-cat" style="background:${cat.color}20;color:${cat.color}">${cat.emoji}</span>
                                    <span class="pantry-mp-row-name">${this._esc(ing.name)}</span>
                                    <span class="pantry-mp-row-right">
                                        ${amountStr ? `<span class="pantry-mp-row-amount">${this._esc(amountStr)}</span>` : ''}
                                        ${ing.alreadyOnList ? `<span class="pantry-mp-row-already">✓ on list</span>` : ''}
                                    </span>
                                </label>`;
                        }).join('')}
                    </div>`).join('')}
            </div>`;

        overlay.querySelector('#pantryMPSelectAll')?.addEventListener('click', () => {
            overlay.querySelectorAll('.pantry-mp-check:not([disabled])').forEach(cb => cb.checked = true);
        });
        overlay.querySelector('#pantryMPDeselectAll')?.addEventListener('click', () => {
            overlay.querySelectorAll('.pantry-mp-check:not([disabled])').forEach(cb => cb.checked = false);
        });

        const footer = overlay.querySelector('#pantryMPFooter');
        footer.style.display = '';
        overlay.querySelector('#pantryMPAdd')?.addEventListener('click', () => {
            const checks = overlay.querySelectorAll('.pantry-mp-check:not([disabled])');
            checks.forEach(cb => {
                if (!cb.checked) return;
                const ing = this._mpIngredients[parseInt(cb.dataset.idx)];
                if (!ing) return;
                this._addItem({
                    name:        ing.name,
                    amount:      ing.amount,
                    unit:        ing.unit,
                    category:    ing.category,
                    fulfillment: 'unplanned',
                    notes:       '',
                    photo:       null,
                    source:      'mealplan',
                });
            });
            overlay.classList.remove('active');
        });
    }

    // ── LIST CRUD ─────────────────────────────────────────────────────────────
    //
    // All mutations go through PantryStore's per-row API. The backend pushes
    // an SSE 'inventory' event after each change; PantryApp's subscriber in
    // _load() re-fetches the list and triggers a re-render. So these methods
    // do NOT mutate this._items locally — they fire the API call and let SSE
    // close the loop.

    async _addItem(data) {
        this._setSyncStatus('saving');
        try {
            // The old pantry shape kept `amount` (freeform: "2 lbs") and
            // `unit` separately. The SQLite shopping_list has numeric `qty`
            // + `unit`. Best-effort split: parseFloat(amount) → qty fallback 1.
            const parsedQty = parseFloat(data.amount ?? data.qty);
            const payload = {
                name:        data.name,
                category:    data.category || detectCategory(data.name),
                qty:         Number.isFinite(parsedQty) ? parsedQty : 1,
                unit:        data.unit || 'count',
                fulfillment: data.fulfillment || 'unplanned',
                notes:       data.notes || '',
                addedBy:     data.addedBy || null,
                storeId:     data.storeId  || null,
                photo:       data.photo    || null,
            };
            if (data.productId) {
                payload.productId = data.productId;
                // Compare each product-attribute field against the prefill baseline
                // (passed via originalScan*) and patch the diff onto the linked
                // catalog product. Falls back to the cached product when the prefill
                // didn't carry a baseline. A freshly-created product may not be in
                // the cache yet, which is why originalScan* is the primary source.
                // `notes` is intentionally NOT in this list — shopping-list notes
                // are row-local ("for this run") and never persist to the catalog.
                const cached = this._products?.find(p => p.id === data.productId);
                const orig = {
                    name:     data.originalScanName     ?? cached?.name,
                    brand:    data.originalScanBrand    ?? cached?.brand     ?? '',
                    category: data.originalScanCategory ?? this._categoryGroceryId(cached?.category_id),
                    photo:    data.originalScanPhoto    ?? cached?.image_url ?? '',
                };
                const patch = {};
                if (data.name && orig.name && orig.name !== data.name) {
                    patch.name = data.name;
                }
                if ((data.brand || '') !== (orig.brand || '')) {
                    patch.brand = data.brand || '';
                }
                if (data.category && orig.category && orig.category !== data.category) {
                    patch.category_id = this.store._categoryIdForPantryId(data.category);
                }
                if ((data.photo || '') !== (orig.photo || '')) {
                    patch.image_url = data.photo || '';
                }
                if (Object.keys(patch).length) {
                    await this.store.updateProduct(data.productId, patch);
                }
            }
            await this.store.addItem(payload);
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
        // Optimistic re-render is unnecessary: the SSE round-trip is fast
        // enough that the new item lands within ~100ms via fetchList().
    }

    async _updateItem(id, changes) {
        this._setSyncStatus('saving');
        try {
            // Translate freeform `amount` back into numeric qty when present.
            const patch = { ...changes };
            if ('amount' in patch) {
                const q = parseFloat(patch.amount);
                patch.qty = Number.isFinite(q) ? q : 1;
                delete patch.amount;
            }
            await this.store.updateItem(id, patch);
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
    }

    async _toggleItem(id) {
        const item = this._items.find(i => i.id === id);
        if (!item) return;

        if (item.fulfillment === 'curbside') {
            // Curbside: checkbox = "ordered" flag, not bought.
            // Toggling again un-marks it.
            const wasOrdered = item.orderStatus === 'ordered';
            const prevOrderStatus = item.orderStatus;
            item.orderStatus = wasOrdered ? null : 'ordered';
            this._applyCheckVisuals(id, item);
            try {
                await this._updateItem(id, { orderStatus: item.orderStatus });
            } catch {
                item.orderStatus = prevOrderStatus;
                this._applyCheckVisuals(id, item);
            }
        } else {
            // In-store / unplanned: normal bought toggle.
            const prevChecked = item.checked;
            item.checked = !item.checked;
            this._applyCheckVisuals(id, item);
            try {
                await this._updateItem(id, { checked: item.checked });
            } catch {
                item.checked = prevChecked;
                this._applyCheckVisuals(id, item);
            }
        }
    }

    /** Update just the check button + row class for a single item — no full re-render. */
    _applyCheckVisuals(id, item) {
        // Accept item object or a plain boolean (legacy call sites).
        if (typeof item === 'boolean') item = { checked: item, fulfillment: null, orderStatus: null };
        const isOrdered = item.fulfillment === 'curbside' && item.orderStatus === 'ordered';
        const active    = item.checked || isOrdered;
        const row = this.container.querySelector(`.pantry-item-row[data-id="${id}"]`);
        if (!row) return;
        row.classList.toggle('checked', item.checked);
        row.classList.toggle('ordered', isOrdered);
        const btn = row.querySelector('.pantry-item-check');
        if (btn) {
            btn.classList.toggle('done',    item.checked);
            btn.classList.toggle('ordered', isOrdered);
            btn.innerHTML = active
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'
                : '';
        }
    }

    async _removeItem(id) {
        this._setSyncStatus('saving');
        try {
            await this.store.deleteItem(id);
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
    }

    async _clearChecked() {
        const ids = this._items.filter(i => i.checked).map(i => i.id);
        if (!ids.length) return;
        this._setSyncStatus('saving');
        try {
            await this.store.clearChecked(ids);
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
    }

    // ── Fulfillment cycling & order status ───────────────────────────────────

    _showFulfillmentPicker(id, pillEl) {
        const item = this._items.find(i => i.id === id);
        if (!item || item.checked) return;

        // Remove any open picker first
        document.querySelectorAll('.pantry-fulfill-picker').forEach(el => el.remove());

        const opts = [
            { value: 'curbside', label: '🚗 Curbside' },
            { value: 'instore',  label: '🏪 In-Store' },
            { value: 'unplanned', label: '⬜ Not Planned' },
        ];

        const picker = document.createElement('div');
        picker.className = 'pantry-fulfill-picker';
        opts.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'pantry-fulfill-picker-opt' + (item.fulfillment === opt.value ? ' active' : '');
            btn.textContent = opt.label;
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                picker.remove();
                if (opt.value !== item.fulfillment) {
                    await this._updateItem(id, { fulfillment: opt.value });
                }
            });
            picker.appendChild(btn);
        });

        // Position using fixed coords so it never goes off-screen
        document.body.appendChild(picker);
        const rect = pillEl.getBoundingClientRect();
        picker.style.position = 'fixed';
        // Prefer opening below; if near bottom, open above
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 130) {
            picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            picker.style.top    = 'auto';
        } else {
            picker.style.top  = `${rect.bottom + 4}px`;
            picker.style.bottom = 'auto';
        }
        // Align left edge with pill, but keep inside viewport
        const left = Math.min(rect.left, window.innerWidth - 160);
        picker.style.left = `${Math.max(4, left)}px`;

        // Dismiss on outside click
        const dismiss = e => {
            if (!picker.contains(e.target) && e.target !== pillEl) {
                picker.remove();
                document.removeEventListener('click', dismiss, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismiss, true), 0);
    }

    async _markOutOfStock(id) {
        await this._updateItem(id, { fulfillment: 'instore', orderStatus: null });
    }

    // ── Put Away modal ────────────────────────────────────────────────────────

    _openPutAwayModal() {
        const purchased = this._items.filter(i =>
            i.checked || (i.fulfillment === 'curbside' && i.orderStatus === 'ordered')
        );
        if (!purchased.length) return;

        const overlay = document.getElementById('pantryItemOverlay');
        if (!overlay) return;

        // Enrich each item with current inventory qty for context
        const rows = purchased.map(item => {
            const invItem = this._inventory.find(inv =>
                (item.productId && inv.productId === item.productId) ||
                inv.name.toLowerCase() === item.name.toLowerCase()
            );
            const unit = (item.unit && item.unit !== 'count') ? item.unit : 'unit';
            return { item, invItem, unit };
        });

        overlay.innerHTML = `
            <div class="pantry-modal pantry-putaway-modal" role="dialog" aria-modal="true">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">📦 Put Away Items</div>
                    <button class="pantry-modal-close" id="pantryPutAwayClose">×</button>
                </div>
                <p class="pantry-putaway-desc">
                    Confirm what you received — quantities are added to Inventory.
                </p>
                <div class="pantry-modal-body pantry-putaway-body">
                    ${rows.map((r, idx) => {
                        const cat = catOf(r.item.category);
                        return `
                        <div class="pantry-putaway-row">
                            ${r.item.photo
                                ? `<div class="pantry-putaway-thumb" style="background-image:url('${r.item.photo}')"></div>`
                                : `<div class="pantry-putaway-thumb no-photo">${cat.emoji}</div>`}
                            <div class="pantry-putaway-info">
                                <div class="pantry-putaway-name">${this._esc(r.item.name)}</div>
                                ${r.invItem
                                    ? `<div class="pantry-putaway-inv">In inventory: ${r.invItem.qty} ${r.invItem.unit}</div>`
                                    : `<div class="pantry-putaway-inv new">New to inventory</div>`}
                            </div>
                            <div class="pantry-putaway-qty">
                                <label>Got</label>
                                <input type="number" class="pantry-putaway-qty-input"
                                       data-idx="${idx}" min="0" step="0.25"
                                       value="${r.item.qty}">
                                <span class="pantry-putaway-unit">${this._esc(r.unit)}</span>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
                <div class="pantry-modal-footer">
                    <button class="pantry-modal-save" id="pantryPutAwayConfirm">
                        ✓ Put Away ${purchased.length} Item${purchased.length !== 1 ? 's' : ''}
                    </button>
                    <button class="pantry-modal-cancel" id="pantryPutAwayCancel">Not now</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const close = () => overlay.classList.remove('active');
        overlay.querySelector('#pantryPutAwayClose')?.addEventListener('click', close);
        overlay.querySelector('#pantryPutAwayCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#pantryPutAwayConfirm')?.addEventListener('click', () => {
            const items = rows.map((r, idx) => {
                const qtyInput = overlay.querySelector(`.pantry-putaway-qty-input[data-idx="${idx}"]`);
                return {
                    id:           r.item.id,
                    received_qty: parseFloat(qtyInput?.value ?? r.item.qty),
                };
            });
            this._confirmPutAway(items);
            close();
        });
    }

    async _confirmPutAway(items) {
        this._setSyncStatus('saving');
        try {
            await this.store.putAway(items);
            this._setSyncStatus('saved', 3000);
        } catch {
            this._setSyncStatus('offline', 3000);
        }
    }

    async _addStaples() {
        // Add every Pantry item flagged ⭐ Staple to the shopping list, skipping
        // anything that's already on the open list (status != bought).
        const staples = this._inventory.filter(i => i.isStaple);
        if (staples.length === 0) {
            alert('No items are marked as ⭐ Staples yet. ' +
                  'Tap the star on a Pantry card to flag it.');
            return;
        }
        const openNames = new Set(
            this._items
                .filter(i => !i.checked)
                .map(i => (i.name || '').trim().toLowerCase())
        );
        const toAdd = staples.filter(
            inv => !openNames.has((inv.name || '').trim().toLowerCase())
        );
        if (toAdd.length === 0) {
            alert('All staples are already on the shopping list.');
            return;
        }
        for (const inv of toAdd) await this._addFromInventory(inv);
    }

    // ── INVENTORY CRUD ────────────────────────────────────────────────────────
    //
    // Same pattern as LIST CRUD: per-row API calls, SSE-driven re-render.
    // The new SQLite backend stores most "default*" fields on the `products`
    // table rather than per-inventory-row, so several legacy fields are
    // dropped silently (defaultAmount, defaultUnit, useCount, lastAdded,
    // autoAddToList). Adding/editing those needs the New Item modal to
    // create or pick a product first — wired in a follow-up PR.

    async _addFromInventory(inv) {
        const alreadyOn = this._items.some(i => !i.checked && i.name.toLowerCase() === inv.name.toLowerCase());
        if (alreadyOn) return;
        await this._addItem({
            name:        inv.name,
            category:    inv.category,
            fulfillment: 'unplanned',
            notes:       inv.notes || '',
            // The backend resolves the joined product image from product_id,
            // so passing a plain name is enough to round-trip a sensible row.
        });
    }

    async _addInventoryItem(data) {
        // If a productId is already in hand (resolver flow), reuse it and patch
        // any product-attribute edits (brand/category/photo/name) onto the
        // catalog product so all surfaces stay in sync. Otherwise create a
        // fresh catalog product first. Either way, the inventory row
        // references the product — image/brand/category live on the product,
        // not duplicated on the inventory row.
        this._setSyncStatus('saving');
        try {
            let pid = data.productId || null;
            if (!pid) {
                const product = await this.store.addProduct({
                    name:     data.name,
                    brand:    data.brand   || '',
                    category: data.category || detectCategory(data.name),
                    photo:    data.photo   || '',
                    isStaple: !!data.isStaple,
                    upc:      data.upc     || '',
                });
                if (!product?.id) throw new Error('product create returned no id');
                pid = product.id;
            } else {
                const cached = this._products?.find(p => p.id === pid);
                const patch = {};
                if (data.name && cached?.name && data.name !== cached.name) {
                    patch.name = data.name;
                }
                if ((data.brand || '') !== (cached?.brand || '')) {
                    patch.brand = data.brand || '';
                }
                const cachedCat = this._categoryGroceryId(cached?.category_id);
                if (data.category && data.category !== cachedCat) {
                    patch.category_id = this.store._categoryIdForPantryId(data.category);
                }
                if ((data.photo || '') !== (cached?.image_url || '')) {
                    patch.image_url = data.photo || '';
                }
                if (data.isStaple !== !!cached?.is_staple) {
                    patch.is_staple = data.isStaple ? 1 : 0;
                }
                if (Object.keys(patch).length) {
                    await this.store.updateProduct(pid, patch);
                }
            }

            // qty comes from the modal (packs × units_per_pack already computed).
            // Fall back to stockLevel hint when called from non-modal paths.
            const startQty = data.qty != null ? data.qty :
                data.stockLevel === 'out' ? 0 : 1;

            await this.store.addInventoryItem({
                productId:  pid,
                qty:        startQty,
                locationId: data.locationId ?? null,
            });
            this._setSyncStatus('saved', 3000);
        } catch (err) {
            console.warn('[PantryApp] _addInventoryItem failed:', err);
            this._setSyncStatus('offline', 3000);
            alert('Could not add the pantry item — see console for details.');
        }
    }

    async _addInventoryItemFromListData(data) {
        // "Save to Pantry" checkbox on the shopping-list Add modal — same
        // create-product-then-inventory flow, just driven by the list data.
        return this._addInventoryItem({
            name:     data.name,
            category: data.category,
            notes:    data.notes,
            photo:    data.photo,
        });
    }

    async _updateInventoryItem(id, changes, _rerender = true) {
        // qty / location patch the inventory row.
        // isStaple patches the parent product row (handled by the store).
        // name / brand / category / photo are product attributes — when the
        // edit modal changes them, propagate the diff onto the linked product
        // so all surfaces (catalog, shopping list, inventory) stay in sync.
        const patch = {};
        if ('qty'        in changes) patch.qty        = changes.qty;
        if ('locationId' in changes) patch.locationId = changes.locationId;
        if ('isStaple'   in changes) patch.isStaple   = changes.isStaple;

        // stockLevel is a derived field — translate back into a qty so the
        // backend's percent/threshold logic keeps working.
        if ('stockLevel' in changes) {
            const inv = this._inventory.find(i => i.id === id);
            const threshold = inv?.low ?? 0;
            patch.qty =
                changes.stockLevel === 'out' ? 0 :
                changes.stockLevel === 'low' ? Math.max(1, threshold) :
                                               Math.max(threshold + 1, (inv?.qty || 0) + 1);
        }

        // Diff product-attribute fields against the inventory row's current
        // (joined-from-product) values, then PATCH the product when any
        // changed. Skip when none of these keys are in the patch payload.
        const inv = this._inventory.find(i => i.id === id);
        if (inv?.productId) {
            const prodPatch = {};
            if ('name' in changes && changes.name && changes.name !== inv.name) {
                prodPatch.name = changes.name;
            }
            if ('brand' in changes && (changes.brand || '') !== (inv.brand || '')) {
                prodPatch.brand = changes.brand || '';
            }
            if ('category' in changes && changes.category && changes.category !== inv.category) {
                prodPatch.category_id = this.store._categoryIdForPantryId(changes.category);
            }
            if ('photo' in changes && (changes.photo || '') !== (inv.photo || '')) {
                prodPatch.image_url = changes.photo || '';
            }
            if (Object.keys(prodPatch).length) {
                try {
                    await this.store.updateProduct(inv.productId, prodPatch);
                } catch (err) {
                    console.warn('[PantryApp] product propagate failed:', err.message);
                }
            }
        }

        if (Object.keys(patch).length === 0) return;
        try {
            await this.store.updateInventoryItem(id, patch);
        } catch (err) {
            console.warn('[PantryApp] updateInventoryItem failed:', err.message);
        }
    }

    // ── Scanner integration ───────────────────────────────────────────────────

    _openScanner(mode) {
        this._scanner.open(mode, result => this._handleScanResult(result));
    }

    /**
     * Scan flow:
     *
     *   1. Scanner reads the UPC and asks the backend for a lookup. The
     *      backend NEVER writes to the catalog — it only returns either a
     *      'local' hit (already in catalog) or a 'preview' hint from
     *      Open Food Facts / UPCitemDB.
     *
     *   2. If we have a local hit, the catalog product is canonical. Skip
     *      the resolver and proceed straight to the mode-specific action.
     *
     *   3. Otherwise the user picks: link this UPC to an existing product
     *      ("this is just another brand of Lemonade Drink Mix") or create
     *      a new catalog entry. Either way, by the time we leave the
     *      resolver we have a productId.
     *
     *   4. Mode dispatch (need/restock/mark_used) acts on the resolved
     *      product. Image / brand / notes are NOT copied onto the row —
     *      they live on the catalog product and the row references it.
     */
    async _handleScanResult({ mode, barcode, product }) {
        let resolved;
        if (product?.source === 'local' && product.productId) {
            resolved = {
                productId: product.productId,
                name:      product.name      || '',
                brand:     product.brand     || '',
                category:  product.category  || 'other',
                photo:     product.imageUrl  || null,
            };
        } else {
            resolved = await this._openResolverModal(barcode, product);
            if (!resolved) return; // user cancelled
        }

        if (mode === 'need')      return this._handleResolvedNeed(barcode, resolved);
        if (mode === 'restock')   return this._handleResolvedRestock(barcode, resolved);
        if (mode === 'mark_used') return this._handleResolvedMarkUsed(barcode, resolved);
    }

    _handleResolvedNeed(barcode, resolved) {
        this._openItemModal(null, {
            name:        resolved.name,
            brand:       resolved.brand    || '',
            category:    resolved.category || detectCategory(resolved.name),
            fulfillment: 'unplanned',
            photo:       resolved.photo    || null,
            productId:   resolved.productId,
        });
    }

    _handleResolvedRestock(barcode, resolved) {
        // Already in inventory? Just mark in-stock and remove any list entry.
        const existing = this._inventory.find(i => i.productId === resolved.productId);
        if (existing) {
            this._setStockStatus(existing.id, 'ok', false);
            const onList = this._items.find(i => !i.checked && i.productId === resolved.productId);
            if (onList) this._removeItem(onList.id);
            this._showToast(`✅ ${resolved.name} restocked!`);
            return;
        }
        // Not in inventory yet — open the inventory modal pre-filled.
        this._openInvModal(null, {
            name:       resolved.name,
            brand:      resolved.brand,
            upc:        barcode,
            category:   resolved.category,
            photo:      resolved.photo,
            productId:  resolved.productId,
            stockLevel: 'ok',
        });
    }

    _handleResolvedMarkUsed(barcode, resolved) {
        const existing = this._inventory.find(i => i.productId === resolved.productId);
        if (existing) {
            this._openStatusPickerModal(existing);
        } else {
            this._openAddToListDirectModal(
                { name: resolved.name, brand: resolved.brand, imageUrl: resolved.photo,
                  category: resolved.category, productId: resolved.productId },
                barcode,
            );
        }
    }

    // ── UPC Resolver Modal ────────────────────────────────────────────────────
    //
    // Opens a modal that lets the user link an unknown UPC to an existing
    // catalog product OR create a new one from the third-party hint. Returns
    // a Promise that resolves to { productId, name, brand, category, photo }
    // or null if the user cancelled.
    //
    // The catalog stays curated: products only land in it when the user
    // explicitly says "this is the same as X" or "create new".

    _openResolverModal(barcode, hint = {}) {
        return new Promise(resolve => {
            const overlay = document.getElementById('pantryResolverOverlay');
            if (!overlay) { resolve(null); return; }

            const hintName  = (hint?.name  || '').trim();
            const hintBrand = (hint?.brand || '').trim();
            const hintImg   = hint?.imageUrl || '';
            const hintCat   = hint?.category || detectCategory(hintName);
            const hasHint   = !!(hintName || hintImg);

            // Initial query for "Link to existing" autocomplete is the third-
            // party name, since that's the most likely match ("Crystal Light
            // Lemonade" → finds your "Lemonade Drink Mix" generic product).
            let query = hintName;

            const close = (result) => {
                overlay.classList.remove('active');
                overlay.innerHTML = '';
                resolve(result);
            };

            const render = () => {
                const matches = this._matchProductsByName(query, 6);
                overlay.innerHTML = `
                    <div class="pantry-modal pantry-resolver-modal" role="dialog" aria-modal="true">
                        <div class="pantry-modal-header">
                            <div class="pantry-modal-title">🔗 Link Barcode</div>
                            <button class="pantry-modal-close" id="resolverClose">×</button>
                        </div>
                        <div class="pantry-modal-body">

                            <div class="pantry-resolver-hint">
                                <div class="pantry-resolver-hint-media">
                                    ${hintImg
                                        ? `<img src="${this._esc(hintImg)}" alt="">`
                                        : `<div class="pantry-resolver-hint-placeholder">📦</div>`}
                                </div>
                                <div class="pantry-resolver-hint-info">
                                    <div class="pantry-resolver-hint-barcode">UPC ${this._esc(barcode)}</div>
                                    ${hasHint
                                        ? `<div class="pantry-resolver-hint-name">${this._esc(hintName || 'Unknown product')}</div>
                                           ${hintBrand ? `<div class="pantry-resolver-hint-brand">${this._esc(hintBrand)}</div>` : ''}`
                                        : `<div class="pantry-resolver-hint-name pantry-resolver-hint-unknown">Not in any database</div>
                                           <div class="pantry-resolver-hint-brand">Type a name below to add it.</div>`
                                    }
                                </div>
                            </div>

                            <div class="pantry-resolver-section">
                                <div class="pantry-resolver-section-label">Link to an existing product</div>
                                <input id="resolverSearch" class="pantry-modal-input"
                                       type="search" autocomplete="off"
                                       placeholder="Search your catalog…"
                                       value="${this._esc(query)}">
                                <div class="pantry-resolver-matches" id="resolverMatches">
                                    ${matches.length === 0
                                        ? `<div class="pantry-resolver-no-match">No matching products in catalog.</div>`
                                        : matches.map(p => `
                                            <button class="pantry-resolver-match" data-pid="${this._esc(p.id)}">
                                                ${p.image_url
                                                    ? `<img src="${this._esc(p.image_url)}" alt="">`
                                                    : `<span class="pantry-resolver-match-emoji">${(catOf(this.store._pantryIdForCategoryId(p.category_id)) || catOf('other')).emoji}</span>`}
                                                <span class="pantry-resolver-match-info">
                                                    <span class="pantry-resolver-match-name">${this._esc(p.name)}</span>
                                                    ${p.brand ? `<span class="pantry-resolver-match-brand">${this._esc(p.brand)}</span>` : ''}
                                                </span>
                                                <span class="pantry-resolver-match-action">Link</span>
                                            </button>`).join('')
                                    }
                                </div>
                            </div>

                            <div class="pantry-resolver-divider"><span>or</span></div>

                            <div class="pantry-resolver-section">
                                <div class="pantry-resolver-section-label">Create a new catalog product</div>
                                <button class="pantry-modal-save" id="resolverCreate">
                                    ➕ ${hasHint ? `Create "${this._esc(hintName || 'New product')}"` : 'Create new product'}
                                </button>
                                <div class="pantry-resolver-create-hint">
                                    You can rename, set the brand, and pick a category right after.
                                </div>
                            </div>

                        </div>
                        <div class="pantry-modal-footer">
                            <button class="pantry-modal-cancel" id="resolverCancel">Cancel</button>
                        </div>
                    </div>`;

                overlay.querySelector('#resolverClose')?.addEventListener('click', () => close(null));
                overlay.querySelector('#resolverCancel')?.addEventListener('click', () => close(null));
                overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });

                const search = overlay.querySelector('#resolverSearch');
                search?.addEventListener('input', () => {
                    query = search.value;
                    // Re-render only the matches list so the input keeps focus
                    const list = overlay.querySelector('#resolverMatches');
                    if (!list) return;
                    const m = this._matchProductsByName(query, 6);
                    list.innerHTML = m.length === 0
                        ? `<div class="pantry-resolver-no-match">No matching products in catalog.</div>`
                        : m.map(p => `
                            <button class="pantry-resolver-match" data-pid="${this._esc(p.id)}">
                                ${p.image_url
                                    ? `<img src="${this._esc(p.image_url)}" alt="">`
                                    : `<span class="pantry-resolver-match-emoji">${(catOf(this.store._pantryIdForCategoryId(p.category_id)) || catOf('other')).emoji}</span>`}
                                <span class="pantry-resolver-match-info">
                                    <span class="pantry-resolver-match-name">${this._esc(p.name)}</span>
                                    ${p.brand ? `<span class="pantry-resolver-match-brand">${this._esc(p.brand)}</span>` : ''}
                                </span>
                                <span class="pantry-resolver-match-action">Link</span>
                            </button>`).join('');
                    bindMatches();
                });

                const bindMatches = () => {
                    overlay.querySelectorAll('.pantry-resolver-match').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const pid = btn.dataset.pid;
                            const prod = this._products.find(p => p.id === pid);
                            if (!prod) return;
                            try {
                                await this.store.linkBarcode(barcode, pid);
                                this._showToast(`🔗 Linked to ${prod.name}`);
                            } catch (err) {
                                console.warn('[PantryApp] linkBarcode failed:', err);
                            }
                            close({
                                productId: pid,
                                name:      prod.name,
                                brand:     prod.brand,
                                category:  this.store._pantryIdForCategoryId(prod.category_id),
                                photo:     prod.image_url,
                            });
                        });
                    });
                };
                bindMatches();

                overlay.querySelector('#resolverCreate')?.addEventListener('click', async () => {
                    // No third-party hint AND empty search → require a name.
                    const name = (hintName || query || '').trim();
                    if (!name) {
                        search?.focus();
                        return;
                    }
                    try {
                        const newProd = await this.store.createProductWithBarcode({
                            name,
                            brand:    hintBrand,
                            category: hintCat,
                            photo:    hintImg,
                            barcode,
                        });
                        this._showToast(`➕ Added "${name}" to catalog`);
                        // Refresh local product cache so subsequent renders see it.
                        const fresh = await this.store.fetchProducts();
                        if (fresh) { this._products = fresh; this._catalogProds = fresh; }
                        close({
                            productId: newProd.id,
                            name:      newProd.name,
                            brand:     newProd.brand,
                            category:  this.store._pantryIdForCategoryId(newProd.category_id) || hintCat,
                            photo:     newProd.image_url,
                        });
                    } catch (err) {
                        console.warn('[PantryApp] createProductWithBarcode failed:', err);
                    }
                });

                setTimeout(() => search?.focus(), 50);
            };

            overlay.classList.add('active');
            render();
        });
    }

    /**
     * Local fuzzy match against this._products. Cheap substring score —
     * exact prefix wins over substring, name beats brand. Returns up to `limit`
     * products. Used by the resolver modal's "Link to existing" autocomplete.
     */
    _matchProductsByName(query, limit = 6) {
        const all = this._products || [];
        const q = (query || '').trim().toLowerCase();
        if (!q) return all.slice(0, limit);
        const score = (p) => {
            const n = (p.name  || '').toLowerCase();
            const b = (p.brand || '').toLowerCase();
            if (n === q)            return 100;
            if (n.startsWith(q))    return 80;
            if (n.includes(q))      return 60;
            if (b.startsWith(q))    return 40;
            if (b.includes(q))      return 20;
            // Token-level: any whitespace-separated token starts with q
            if (n.split(/\s+/).some(t => t.startsWith(q))) return 50;
            return 0;
        };
        return all
            .map(p => ({ p, s: score(p) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
            .slice(0, limit)
            .map(x => x.p);
    }

    _openStatusPickerModal(inv) {
        const overlay = document.getElementById('pantryInvOverlay');
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="pantry-modal status-picker-modal" role="dialog">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">📦 ${this._esc(inv.name)}</div>
                    <button class="pantry-modal-close" id="statusPickerClose">×</button>
                </div>
                <div class="pantry-modal-body" style="text-align:center;padding:32px 20px">
                    ${inv.photo ? `<img src="${inv.photo}" style="width:80px;height:80px;object-fit:contain;border-radius:12px;margin-bottom:16px" alt="">` : `<div style="font-size:48px;margin-bottom:16px">${catOf(inv.category).emoji}</div>`}
                    <div style="font-size:16px;font-weight:600;margin-bottom:8px">How much is left?</div>
                    <div style="font-size:14px;color:var(--color-muted);margin-bottom:24px">${inv.brand ? this._esc(inv.brand) : ''}</div>
                    <div class="status-picker-btns">
                        <button class="status-picker-btn low" id="spLow">⚠️<br><span>Running Low</span></button>
                        <button class="status-picker-btn out" id="spOut">🔴<br><span>All Out</span></button>
                        <button class="status-picker-btn ok"  id="spOk">✅<br><span>Still Good</span></button>
                    </div>
                </div>
            </div>`;
        overlay.classList.add('active');

        const close = () => overlay.classList.remove('active');
        overlay.querySelector('#statusPickerClose')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#spOk')?.addEventListener('click',  () => { this._setStockStatus(inv.id, 'ok');  close(); });
        overlay.querySelector('#spLow')?.addEventListener('click', () => { this._setStockStatus(inv.id, 'low'); close(); });
        overlay.querySelector('#spOut')?.addEventListener('click', () => {
            this._setStockStatus(inv.id, 'out');
            close();
            // Prompt to add to shopping list
            this._promptAddToList(inv);
        });
    }

    _openAddToListDirectModal(product, barcode) {
        const overlay = document.getElementById('pantryInvOverlay');
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="pantry-modal" role="dialog">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">🛒 Not in Pantry</div>
                    <button class="pantry-modal-close" id="directListClose">×</button>
                </div>
                <div class="pantry-modal-body" style="text-align:center;padding:24px 20px">
                    ${product.imageUrl ? `<img src="${product.imageUrl}" style="width:72px;height:72px;object-fit:contain;border-radius:12px;margin-bottom:12px" alt="">` : '<div style="font-size:48px;margin-bottom:12px">📦</div>'}
                    <div style="font-size:16px;font-weight:600;margin-bottom:4px">${this._esc(product.name || 'Unknown item')}</div>
                    ${product.brand ? `<div style="font-size:13px;color:var(--color-muted);margin-bottom:16px">${this._esc(product.brand)}</div>` : '<div style="margin-bottom:16px"></div>'}
                    <div style="font-size:14px;color:var(--color-muted);margin-bottom:24px">This item isn't tracked in your pantry. What would you like to do?</div>
                    <div style="display:flex;flex-direction:column;gap:10px">
                        <button class="pantry-modal-save" id="dlAddList">🛒 Add to Shopping List</button>
                        <button class="pantry-action-btn primary" id="dlAddPantry">📦 Add to Pantry &amp; Shopping List</button>
                        <button class="pantry-modal-cancel" id="dlCancel">Cancel</button>
                    </div>
                </div>
            </div>`;
        overlay.classList.add('active');

        const close = () => overlay.classList.remove('active');
        overlay.querySelector('#directListClose')?.addEventListener('click', close);
        overlay.querySelector('#dlCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#dlAddList')?.addEventListener('click', () => {
            this._addItem({
                name:      product.name || 'Unknown item',
                category:  product.category || detectCategory(product.name || ''),
                photo:     product.imageUrl || null,
                productId: product.productId || null,
                source:    'scan',
            });
            close();
            this._showToast('🛒 Added to shopping list!');
        });
        overlay.querySelector('#dlAddPantry')?.addEventListener('click', () => {
            close();
            this._openInvModal(null, {
                name:       product.name || '',
                brand:      product.brand || '',
                upc:        barcode,
                category:   product.category || 'other',
                photo:      product.imageUrl || null,
                productId:  product.productId || null,
                stockLevel: 'out',
            });
        });
    }

    _setStockStatus(id, newStatus, rerender = true) {
        const inv = this._inventory.find(i => i.id === id);
        if (!inv) return;
        this._updateInventoryItem(id, { stockLevel: newStatus }, rerender);
        if (newStatus === 'out' && inv.autoAddToList) {
            this._promptAddToList({ ...inv, stockLevel: 'out' });
        }
    }

    _promptAddToList(inv) {
        const alreadyOn = this._items.some(i => !i.checked && (i.inventoryRef === inv.id || i.name.toLowerCase() === inv.name.toLowerCase()));
        if (alreadyOn) {
            this._showToast(`${inv.name} is already on your list`);
            return;
        }
        // Small toast with action button
        this._showToast(
            `🔴 ${inv.name} is out — add to list?`,
            'Add to List',
            () => this._addFromInventory(inv)
        );
    }

    _openPhotoLightbox(url) {
        if (!url) return;
        document.querySelectorAll('.pantry-lightbox').forEach(el => el.remove());
        const lb = document.createElement('div');
        lb.className = 'pantry-lightbox';
        lb.innerHTML = `
            <div class="pantry-lightbox-backdrop"></div>
            <div class="pantry-lightbox-content">
                <img src="${this._esc(url)}" class="pantry-lightbox-img" alt="Product photo">
                <button class="pantry-lightbox-close" aria-label="Close">✕</button>
            </div>`;
        document.body.appendChild(lb);
        requestAnimationFrame(() => lb.classList.add('show'));
        const close = () => { lb.classList.remove('show'); setTimeout(() => lb.remove(), 250); };
        lb.querySelector('.pantry-lightbox-close')?.addEventListener('click', close);
        lb.querySelector('.pantry-lightbox-backdrop')?.addEventListener('click', close);
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    _showToast(message, actionLabel = null, onAction = null) {
        document.querySelectorAll('.pantry-toast').forEach(t => t.remove());
        const toast = document.createElement('div');
        toast.className = 'pantry-toast';
        toast.innerHTML = `
            <span class="pantry-toast-msg">${this._esc(message)}</span>
            ${actionLabel ? `<button class="pantry-toast-action">${this._esc(actionLabel)}</button>` : ''}
            <button class="pantry-toast-dismiss">✕</button>`;
        document.body.appendChild(toast);

        const dismiss = () => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); };
        toast.querySelector('.pantry-toast-dismiss')?.addEventListener('click', dismiss);
        toast.querySelector('.pantry-toast-action')?.addEventListener('click', () => { onAction?.(); dismiss(); });
        setTimeout(dismiss, 5000);
        requestAnimationFrame(() => toast.classList.add('show'));
    }

    async _removeInventoryItem(id) {
        try {
            await this.store.deleteInventoryItem(id);
        } catch (err) {
            console.warn('[PantryApp] deleteInventoryItem failed:', err.message);
        }
    }

    // ── Persist (legacy bulk-save shims) ──────────────────────────────────────
    //
    // The old pantry store had bulk saveList/saveInventory endpoints. The
    // SQLite backend doesn't — every mutation is per-row and goes via the
    // PantryStore API directly. These helpers are kept as no-ops so any
    // residual call sites (or future merges from old branches) don't crash.

    async _persist()          { /* per-row API; no bulk save */ }
    async _persistInventory() { /* per-row API; no bulk save */ }

    // ── Sync badge ────────────────────────────────────────────────────────────

    _syncBadgeHTML() {
        return {
            idle:    '',
            saving:  '<span class="sync-dot saving"></span> Saving…',
            saved:   '<span class="sync-dot saved"></span> Synced',
            offline: '<span class="sync-dot offline"></span> Saved locally',
            live:    '<span class="sync-dot live"></span> Updated',
        }[this._syncStatus] ?? '';
    }

    _setSyncStatus(status, duration = 0) {
        this._syncStatus = status;
        clearTimeout(this._syncTimer);
        const badge = document.getElementById('pantrySyncBadge');
        if (badge) { badge.dataset.status = status; badge.innerHTML = this._syncBadgeHTML(); }
        if (duration > 0) {
            this._syncTimer = setTimeout(() => this._setSyncStatus('idle'), duration);
        }
    }

    _flashSync() { this._setSyncStatus('live', 2500); }

    // ── Utilities ─────────────────────────────────────────────────────────────

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Build <option> elements for the "Added By" picker.
     * Uses this._family (HA persons) when available, falls back to the
     * compile-time FAMILY_MEMBERS_FALLBACK list.
     */
    _familyOptions(selectedName = '') {
        const members = this._family.length
            ? this._family.map(p => ({ value: p.name, label: p.name }))
            : FAMILY_MEMBERS_FALLBACK.map(n => ({ value: n, label: n }));
        return members.map(m => {
            const sel = selectedName === m.value ? ' selected' : '';
            return `<option value="${this._esc(m.value)}"${sel}>${this._esc(m.label)}</option>`;
        }).join('');
    }

    /** Resolve a store id → display name from config. */
    _storeNameById(storeId) {
        if (!storeId) return '';
        const s = (this.store.config.stores || []).find(s => s.id === storeId);
        return s?.name || '';
    }

    /** Map a backend category_id UUID → pantry string id for autocomplete. */
    _categoryGroceryId(categoryId) {
        if (!categoryId) return 'other';
        const cat = (this.store.config.categories || []).find(c => c.id === categoryId);
        if (!cat) return 'other';
        const name = (cat.name || '').toLowerCase();
        // Reuse the same hints from PantryStore
        const HINTS = { produce:['produce','fruit','veg'], dairy:['dairy','egg'], meat:['meat','seafood','fish'], bakery:['bakery','bread'], frozen:['frozen'], pantry:['pantry','dry','canned','shelf'], snacks:['snack'], beverages:['beverage','drink'], personal:['personal','health','beauty'], household:['household','cleaning','paper'] };
        for (const [gid, hints] of Object.entries(HINTS)) {
            if (hints.some(h => name.includes(h))) return gid;
        }
        return 'other';
    }

    /**
     * Family picker: remember the last person who added something so the
     * picker pre-selects them next time. Per-browser, so different family
     * members on different devices get their own default.
     */
    _lastAddedBy() {
        try { return localStorage.getItem('pantry.lastAddedBy') || ''; }
        catch { return ''; }
    }
    _rememberAddedBy(name) {
        try { localStorage.setItem('pantry.lastAddedBy', name); } catch {}
    }

    _timeAgo(isoStr) {
        if (!isoStr) return '';
        const diff = Date.now() - new Date(isoStr).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1)   return 'just now';
        if (m < 60)  return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24)  return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    addIngredients(ingredients, source = 'recipe') {
        ingredients.forEach(ing => {
            if (!ing.name?.trim()) return;
            const exists = this._items.some(i => !i.checked && i.name.toLowerCase() === ing.name.toLowerCase().trim());
            if (!exists) this._addItem({ ...ing, source });
        });
    }
}
