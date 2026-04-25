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
import { BarcodeScanner } from './scanner.js?v=3';

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
        this._items    = [];
        this._filter   = 'all'; // 'all' | 'curbside' | 'instore'
        this._showChecked = true;

        // Pantry state
        this._inventory      = [];
        this._pantrySearch   = '';
        this._pantryFilter   = 'all'; // 'all' | 'staples' | 'low'

        // Family (HA persons) for "Added By" picker
        this._family = [];

        // All products from DB (used for name autocomplete)
        this._products = [];

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

        // Load HA family members + full product catalog
        this._loadFamily();
        this.store.fetchProducts().then(prods => {
            if (prods) { this._products = prods; this._catalogProds = prods; }
        });

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
        const total     = this._items.length;
        const checked   = this._items.filter(i => i.checked).length;
        const pct       = total > 0 ? (checked / total) * 100 : 0;

        let items = [...this._items];
        if (this._filter !== 'all') {
            items = items.filter(i => i.fulfillment === this._filter);
        }
        if (!this._showChecked) {
            items = items.filter(i => !i.checked);
        }

        // Group by category, sorted A→Z within each group.
        // Checked state never changes sort order — items stay in place when ticked.
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

        body.innerHTML = `
            <div class="pantry-list-toolbar">
                <div class="pantry-filters">
                    <button class="pantry-filter-btn${this._filter === 'all'      ? ' active' : ''}" data-filter="all">All</button>
                    <button class="pantry-filter-btn${this._filter === 'curbside' ? ' active' : ''}" data-filter="curbside">🚗 Curbside</button>
                    <button class="pantry-filter-btn${this._filter === 'instore'  ? ' active' : ''}" data-filter="instore">🏪 In-Store</button>
                </div>
                <div class="pantry-list-actions">
                    <button class="pantry-action-btn" id="pantryMealPlanBtn" title="Import from this week's meal plan">
                        📅 From Meals
                    </button>
                    <button class="pantry-action-btn" id="pantryStaplesBtn" title="Add your weekly staples">
                        ⭐ Staples
                    </button>
                    ${checked > 0 ? `
                        <button class="pantry-action-btn danger" id="pantryClearChecked">
                            🗑 Clear ${checked} done
                        </button>` : ''}
                    <button class="pantry-toggle-checked" id="pantryToggleChecked" title="${this._showChecked ? 'Hide' : 'Show'} checked items">
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

            <div class="pantry-categories" id="pantryCategories">
                ${catOrder.length === 0
                    ? `<div class="pantry-empty">
                           <div class="pantry-empty-icon">🛒</div>
                           <div class="pantry-empty-title">Your list is empty</div>
                           <div class="pantry-empty-text">Add items below, import from your meal plan, or add your weekly staples.</div>
                       </div>`
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
            btn.addEventListener('click', () => { this._filter = btn.dataset.filter; this._render(); });
        });
        body.querySelector('#pantryToggleChecked')?.addEventListener('click', () => {
            this._showChecked = !this._showChecked; this._render();
        });
        body.querySelector('#pantryClearChecked')?.addEventListener('click', () => this._clearChecked());
        body.querySelector('#pantryMealPlanBtn')?.addEventListener('click', () => this._openMealPlanImport());
        body.querySelector('#pantryStaplesBtn')?.addEventListener('click', () => this._addStaples());
        body.querySelector('#pantryAddFab')?.addEventListener('click', () => this._openItemModal());
        body.querySelector('#pantryScanNeedFab')?.addEventListener('click', () => this._openScanner('need'));

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
            // Thumbnail click → photo lightbox
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
        const fulfillIcon = item.fulfillment === 'instore'  ? '<span class="pantry-fulfillment instore" title="In-Store">🏪</span>'
                          : item.fulfillment === 'curbside' ? '<span class="pantry-fulfillment curbside" title="Curbside">🚗</span>'
                          : '';
        const _unit    = item.unit && item.unit !== 'count' ? item.unit : '';
        const amountStr = _unit ? `${item.qty} ${_unit}` : (item.qty !== 1 ? `${item.qty}` : '');
        const storeName = item.storeName || this._storeNameById(item.storeId);
        const storeColor = item.storeColor || '#64748b';
        return `
            <div class="pantry-item-row${item.checked ? ' checked' : ''}" data-id="${item.id}">
                <button class="pantry-item-check${item.checked ? ' done' : ''}" aria-label="Toggle">
                    ${item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'
                        : ''}
                </button>
                ${item.photo
                    ? `<div class="pantry-item-photo-thumb" data-photo="${this._esc(item.photo)}"
                            style="background-image:url('${item.photo}')" title="Tap to enlarge"></div>`
                    : ''}
                <div class="pantry-item-info">
                    <span class="pantry-item-name">${this._esc(item.name)}</span>
                    ${amountStr ? `<span class="pantry-item-amount">${this._esc(amountStr)}</span>` : ''}
                    <span class="pantry-item-meta">
                        ${storeName ? `<span class="pantry-item-store" style="--store-color:${this._esc(storeColor)}">${this._esc(storeName)}</span>` : ''}
                        ${item.addedBy && item.addedBy.toLowerCase() !== 'household'
                            ? `<span class="pantry-item-addedby">by ${this._esc(item.addedBy)}</span>`
                            : ''}
                        ${item.notes  ? `<span class="pantry-item-notes">${this._esc(item.notes)}</span>` : ''}
                    </span>
                </div>
                ${fulfillIcon}
                <button class="pantry-item-edit" aria-label="Edit" title="Edit">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
            </div>`;
    }

    // ── PANTRY TAB ────────────────────────────────────────────────────────────

    _renderPantryTab(body) {
        const q       = this._pantrySearch.toLowerCase();
        const filter  = this._pantryFilter;
        let   items   = [...this._inventory];
        if (q)                  items = items.filter(i => i.name.toLowerCase().includes(q) || i.brand?.toLowerCase().includes(q) || i.notes?.toLowerCase().includes(q));
        if (filter === 'staples') items = items.filter(i => i.isStaple);
        if (filter === 'low')     items = items.filter(i => i.stockLevel === 'low' || i.stockLevel === 'out');

        const staples  = this._inventory.filter(i => i.isStaple);
        const lowItems = this._inventory.filter(i => i.stockLevel === 'low' || i.stockLevel === 'out');
        const outItems = this._inventory.filter(i => i.stockLevel === 'out');

        body.innerHTML = `
            <div class="pantry-pantry-toolbar">
                <div class="pantry-pantry-search-wrap">
                    <svg class="pantry-pantry-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input type="search" id="pantryPantrySearch" class="pantry-pantry-search"
                           placeholder="Search pantry…" value="${this._esc(this._pantrySearch)}">
                </div>
                <button class="pantry-action-btn primary" id="pantryAddPantryItem">+ New Item</button>
            </div>

            <div class="pantry-scan-bar">
                <button class="pantry-scan-btn restock" id="pantryScanRestock">
                    <span class="pantry-scan-icon">📥</span>
                    <span>Scan to Restock</span>
                </button>
                <button class="pantry-scan-btn mark-used" id="pantryScanMarkUsed">
                    <span class="pantry-scan-icon">📤</span>
                    <span>Scan to Mark Empty</span>
                </button>
            </div>

            <div class="pantry-pantry-filters">
                <button class="pantry-filter-btn${filter === 'all'     ? ' active' : ''}" data-pfilter="all">All (${this._inventory.length})</button>
                <button class="pantry-filter-btn${filter === 'staples' ? ' active' : ''}" data-pfilter="staples">⭐ Staples (${staples.length})</button>
                <button class="pantry-filter-btn${filter === 'low'     ? ' active' : ''}" data-pfilter="low">
                    ⚠️ Need Restock (${lowItems.length})${lowItems.length > 0 ? ' 🔴' : ''}
                </button>
            </div>

            ${outItems.length > 0 && filter === 'all' ? `
                <div class="pantry-pantry-alert">
                    🔴 <strong>${outItems.length} item${outItems.length > 1 ? 's' : ''} out</strong> — add to shopping list?
                    <button class="pantry-pantry-alert-btn" id="pantryAddAllOut">Add All Out</button>
                </div>` : ''}

            ${lowItems.length > 0 && (filter === 'all' || filter === 'low') ? `
                <div class="pantry-pantry-alert pantry-pantry-alert-low">
                    🟡 <strong>${lowItems.length} item${lowItems.length > 1 ? 's' : ''} low or out</strong> — restock?
                    <button class="pantry-pantry-alert-btn" id="pantryAddAllLow">Add All Low</button>
                </div>` : ''}

            <div class="pantry-grid" id="pantryGrid">
                ${items.length === 0
                    ? `<div class="pantry-empty" style="grid-column:1/-1">
                           <div class="pantry-empty-icon">📦</div>
                           <div class="pantry-empty-title">${q || filter !== 'all' ? 'No items match' : 'Pantry is empty'}</div>
                           <div class="pantry-empty-text">Add items manually or use Scan to Restock to add items by scanning their barcode.</div>
                       </div>`
                    : items.map(inv => this._pantryCardHTML(inv)).join('')
                }
            </div>
        `;

        body.querySelector('#pantryPantrySearch')?.addEventListener('input', e => {
            this._pantrySearch = e.target.value;
            this._renderPantryTab(body);
        });
        body.querySelectorAll('[data-pfilter]').forEach(btn => {
            btn.addEventListener('click', () => { this._pantryFilter = btn.dataset.pfilter; this._render(); });
        });
        body.querySelector('#pantryAddPantryItem')?.addEventListener('click', () => this._openInvModal());
        body.querySelector('#pantryAddAllOut')?.addEventListener('click', () => {
            outItems.forEach(inv => this._addFromInventory(inv));
        });
        body.querySelector('#pantryAddAllLow')?.addEventListener('click', () => {
            // "Low" alert covers both low and out items so one button restocks
            // everything that needs attention. Skip items that already have an
            // open (non-bought) shopping-list entry to avoid duplicates.
            const openNames = new Set(
                this._items
                    .filter(i => !i.checked)
                    .map(i => (i.name || '').trim().toLowerCase())
            );
            lowItems
                .filter(inv => !openNames.has((inv.name || '').trim().toLowerCase()))
                .forEach(inv => this._addFromInventory(inv));
        });

        // Scan buttons
        body.querySelector('#pantryScanRestock')?.addEventListener('click', () => this._openScanner('restock'));
        body.querySelector('#pantryScanMarkUsed')?.addEventListener('click', () => this._openScanner('mark_used'));

        // Card interactions
        body.querySelectorAll('.pantry-card').forEach(card => {
            const id  = card.dataset.id;
            const inv = this._inventory.find(i => i.id === id);
            if (!inv) return;

            // Status buttons
            card.querySelectorAll('.pantry-status-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const newStatus = btn.dataset.status;
                    this._setStockStatus(id, newStatus);
                });
            });

            card.querySelector('.pantry-card-add')?.addEventListener('click', () => this._addFromInventory(inv));
            card.querySelector('.pantry-card-edit')?.addEventListener('click', () => this._openInvModal(inv));
            card.querySelector('.pantry-card-staple')?.addEventListener('click', () => {
                this._updateInventoryItem(id, { isStaple: !inv.isStaple });
            });
        });
    }

    _pantryCardHTML(inv) {
        const cat      = catOf(inv.category);
        const onList   = this._items.some(i => !i.checked && (i.inventoryRef === inv.id || i.name.toLowerCase() === inv.name.toLowerCase()));
        const status   = inv.stockLevel || 'ok';
        const statusInfo = { ok: { cls:'ok', label:'In Stock', icon:'✅' }, low: { cls:'low', label:'Low', icon:'⚠️' }, out: { cls:'out', label:'Out', icon:'🔴' } }[status] || { cls:'ok', label:'In Stock', icon:'✅' };

        return `
        <div class="pantry-card status-${statusInfo.cls}" data-id="${inv.id}">
            <div class="pantry-card-media" style="--cat-color:${cat.color}">
                ${inv.photo
                    ? `<img src="${inv.photo}" class="pantry-card-photo" alt="${this._esc(inv.name)}">`
                    : `<span class="pantry-card-emoji">${cat.emoji}</span>`}
                ${inv.isStaple ? `<span class="pantry-staple-badge" title="Weekly staple">⭐</span>` : ''}
                ${onList ? `<span class="pantry-on-list-badge">✓ On list</span>` : ''}
                ${inv.upc ? `<span class="pantry-upc-badge" title="UPC: ${inv.upc}">🔲</span>` : ''}
            </div>
            <div class="pantry-card-body">
                <div class="pantry-card-name">${this._esc(inv.name)}</div>
                ${inv.brand ? `<div class="pantry-card-brand">${this._esc(inv.brand)}</div>` : ''}
                ${inv.notes && !inv.brand ? `<div class="pantry-card-brand">${this._esc(inv.notes)}</div>` : ''}
                <div class="pantry-status-row">
                    <button class="pantry-status-btn${status === 'ok'  ? ' active' : ''}" data-status="ok"  title="In Stock">✅</button>
                    <button class="pantry-status-btn${status === 'low' ? ' active' : ''}" data-status="low" title="Running Low">⚠️</button>
                    <button class="pantry-status-btn${status === 'out' ? ' active' : ''}" data-status="out" title="Out">🔴</button>
                    <span class="pantry-status-label status-${statusInfo.cls}">${statusInfo.label}</span>
                </div>
            </div>
            <div class="pantry-card-footer">
                <button class="pantry-card-staple" title="${inv.isStaple ? 'Remove staple' : 'Mark as staple'}">${inv.isStaple ? '⭐' : '☆'}</button>
                <button class="pantry-card-edit"   title="Edit">✏️</button>
                <button class="pantry-card-add${onList ? ' on-list' : ''}" title="Add to shopping list">
                    ${onList ? '✓ Listed' : '+ List'}
                </button>
            </div>
        </div>`;
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
                               placeholder="e.g. Orange Juice" value="${this._esc(p?.name || '')}">
                    </div>
                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Brand</label>
                            <input class="pantry-modal-input" id="prodBrand" type="text"
                                   placeholder="e.g. Simply Orange" value="${this._esc(p?.brand || '')}">
                        </div>
                        <div class="pantry-modal-field">
                            <label class="pantry-modal-label">Category</label>
                            <select class="pantry-modal-input" id="prodCategory">${catOpts}</select>
                        </div>
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
            const payload = {
                name,
                brand:       overlay.querySelector('#prodBrand')?.value.trim() || '',
                category_id: overlay.querySelector('#prodCategory')?.value || 'other',
                image_url:   this._editProductPhoto || '',
                barcodes:    this._editProductBarcodes.map(b => b.barcode),
            };
            if (this._editProduct?.id) {
                await this.store.updateProduct(this._editProduct.id, payload);
            } else {
                await this.store.createProduct(payload);
            }
            const freshProds = await this.store.fetchProducts();
            if (freshProds) { this._catalogProds = freshProds; this._products = freshProds; }
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

                    <div class="pantry-modal-field">
                        <label>Fulfillment</label>
                        <div class="pantry-fulfillment-toggle">
                            <button class="pantry-fulfillment-btn${(val('fulfillment') ?? 'curbside') === 'curbside' ? ' active' : ''}"
                                    data-ful="curbside">🚗 Curbside / Delivery</button>
                            <button class="pantry-fulfillment-btn${val('fulfillment') === 'instore' ? ' active' : ''}"
                                    data-ful="instore">🏪 In-Store (I'll grab it)</button>
                        </div>
                    </div>

                    <div class="pantry-modal-field">
                        <label>Notes / Brand Details</label>
                        <input type="text" id="pantryItemNotes" class="pantry-modal-input"
                               value="${this._esc(val('notes') || '')}"
                               placeholder="Brand, size, substitution notes…">
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

                    ${isNew ? `
                        <div class="pantry-modal-save-pantry">
                            <label class="pantry-checkbox-label">
                                <input type="checkbox" id="pantrySaveToPantry">
                                Also save to Inventory for quick re-adding later
                            </label>
                        </div>` : ''}
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
        nameInput?.addEventListener('input', () => {
            const cat = detectCategory(nameInput.value);
            if (catSelect && cat !== 'other') catSelect.value = cat;
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

        overlay.querySelector('#pantryItemSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.pantry-fulfillment-btn.active');
            const addedBy = overlay.querySelector('#pantryItemAddedBy')?.value || '';
            if (addedBy) this._rememberAddedBy(addedBy);
            const storeId = overlay.querySelector('#pantryItemStore')?.value || null;
            const data = {
                name,
                amount:      overlay.querySelector('#pantryItemAmount')?.value || '1',
                unit:        overlay.querySelector('#pantryItemUnit')?.value.trim()   || '',
                category:    catSelect?.value || detectCategory(name),
                fulfillment: fulfillmentActive?.dataset.ful || 'curbside',
                notes:       overlay.querySelector('#pantryItemNotes')?.value.trim() || '',
                addedBy:     addedBy || null,
                storeId:     storeId || null,
                photo:       this._editItemPhoto || '',
            };
            if (this._editItem) {
                this._updateItem(this._editItem.id, data);
            } else {
                this._addItem(data);
                if (overlay.querySelector('#pantrySaveToPantry')?.checked) {
                    this._addInventoryItemFromListData(data);
                }
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

        // 1. Inventory items — best match (in pantry, has stock info)
        const invMatches = this._inventory
            .filter(i => i.name.toLowerCase().includes(ql))
            .map(i => ({ source: 'inv', id: i.id, name: i.name, category: i.category,
                         notes: i.notes, photo: i.photo,
                         defaultAmount: i.defaultAmount, defaultUnit: i.defaultUnit,
                         defaultFulfillment: i.defaultFulfillment }));

        // 2. Product catalog — items not already surfaced via inventory
        const invNames = new Set(invMatches.map(i => i.name.toLowerCase()));
        const prodMatches = this._products
            .filter(p => p.name.toLowerCase().includes(ql) && !invNames.has(p.name.toLowerCase()))
            .map(p => ({ source: 'prod', id: p.id, name: p.name,
                         category: this._categoryGroceryId(p.category_id),
                         notes: p.notes || '', photo: p.image_url || '',
                         brand: p.brand || '' }));

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
                overlay.querySelector('#pantryItemAmount').value   = m.defaultAmount || '';
                overlay.querySelector('#pantryItemUnit').value     = m.defaultUnit   || '';
                overlay.querySelector('#pantryItemCategory').value = m.category      || 'other';
                overlay.querySelector('#pantryItemNotes').value    = m.notes         || '';
                const fulfBtns = overlay.querySelectorAll('.pantry-fulfillment-btn');
                fulfBtns.forEach(b => b.classList.toggle('active', b.dataset.ful === (m.defaultFulfillment || 'curbside')));
                if (m.photo) { this._editItemPhoto = m.photo; this._updateItemPhotoPreview(overlay); }
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

        overlay.innerHTML = `
            <div class="pantry-modal" role="dialog" aria-modal="true">
                <div class="pantry-modal-header">
                    <div class="pantry-modal-title">${isNew ? '📦 New Pantry Item' : `✏️ Edit: ${this._esc(inv.name)}`}</div>
                    <button class="pantry-modal-close" id="pantryInvClose">×</button>
                </div>
                <div class="pantry-modal-body">

                    <div class="pantry-modal-photo-area" id="pantryInvPhotoArea">
                        ${this._editInvPhoto
                            ? `<img src="${this._editInvPhoto}" class="pantry-modal-photo-img" alt="Item photo">
                               <div class="pantry-modal-photo-overlay">
                                   <button class="pantry-photo-remove-btn" id="pantryInvPhotoRemove">🗑 Remove</button>
                               </div>`
                            : `<div class="pantry-modal-photo-placeholder">
                                   <div style="font-size:28px">📷</div>
                                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Product photo (helps with brand ID)</div>
                               </div>`
                        }
                    </div>
                    <input type="file" id="pantryInvPhotoInput" accept="image/*" style="display:none">

                    <div class="pantry-modal-field">
                        <label>Item Name *</label>
                        <input type="text" id="pantryInvName" class="pantry-modal-input"
                               value="${this._esc(inv?.name || prefill?.name || '')}" placeholder="e.g. Organic Whole Milk">
                    </div>

                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label>Default Amount</label>
                            <input type="text" id="pantryInvAmount" class="pantry-modal-input"
                                   value="${this._esc(inv?.defaultAmount || '')}" placeholder="1">
                        </div>
                        <div class="pantry-modal-field">
                            <label>Unit</label>
                            <input type="text" id="pantryInvUnit" class="pantry-modal-input"
                                   value="${this._esc(inv?.defaultUnit || '')}" placeholder="gallon, lbs…">
                        </div>
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

                    <div class="pantry-modal-field">
                        <label>Brand / Notes</label>
                        <input type="text" id="pantryInvNotes" class="pantry-modal-input"
                               value="${this._esc(inv?.notes || '')}"
                               placeholder="Brand, size, any notes for the shopper…">
                    </div>

                    <div class="pantry-modal-row">
                        <div class="pantry-modal-field">
                            <label>Brand</label>
                            <input type="text" id="pantryInvBrand" class="pantry-modal-input"
                                   value="${this._esc(inv?.brand || prefill?.brand || '')}" placeholder="e.g. Tropicana">
                        </div>
                        <div class="pantry-modal-field">
                            <label>UPC Barcode</label>
                            <input type="text" id="pantryInvUPC" class="pantry-modal-input"
                                   value="${this._esc(inv?.upc || prefill?.upc || '')}" placeholder="Scan or enter manually"
                                   pattern="\\d{6,14}" maxlength="14">
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
                        <button class="pantry-modal-delete" id="pantryInvDelete">🗑 Remove from Pantry</button>` : ''}
                </div>
                <div class="pantry-modal-footer">
                    <button class="pantry-modal-save" id="pantryInvSave">
                        ${isNew ? 'Add to Pantry' : 'Save Changes'}
                    </button>
                    <button class="pantry-modal-cancel" id="pantryInvCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const nameInput = overlay.querySelector('#pantryInvName');
        const catSelect = overlay.querySelector('#pantryInvCategory');
        nameInput?.addEventListener('input', () => {
            const cat = detectCategory(nameInput.value);
            if (catSelect && cat !== 'other') catSelect.value = cat;
        });

        overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.pantry-fulfillment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Photo upload (addon version — async multipart POST)
        const photoArea  = overlay.querySelector('#pantryInvPhotoArea');
        const photoInput = overlay.querySelector('#pantryInvPhotoInput');
        photoArea?.addEventListener('click', e => {
            if (!e.target.closest('#pantryInvPhotoRemove')) photoInput?.click();
        });
        photoInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            photoInput.value = '';
            if (!file) return;
            this._showPhotoUploading(photoArea);
            try {
                const url = await this.store.uploadPhoto(file, 400, 0.75);
                this._editInvPhoto = url;
                this._updateInvPhotoPreview(overlay);
            } catch (err) {
                console.error('[PantryApp] Pantry photo upload failed:', err);
                this._editInvPhoto = null;
                this._updateInvPhotoPreview(overlay);
            }
        });
        overlay.querySelector('#pantryInvPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editInvPhoto = null; this._updateInvPhotoPreview(overlay);
        });

        const close = () => { overlay.classList.remove('active'); this._editInvItem = null; this._editInvPhoto = null; };
        overlay.querySelector('#pantryInvClose')?.addEventListener('click', close);
        overlay.querySelector('#pantryInvCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#pantryInvSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.pantry-fulfillment-btn.active');
            const data = {
                name,
                defaultAmount:      overlay.querySelector('#pantryInvAmount')?.value.trim()   || '',
                defaultUnit:        overlay.querySelector('#pantryInvUnit')?.value.trim()      || '',
                category:           catSelect?.value || detectCategory(name),
                defaultFulfillment: fulfillmentActive?.dataset.ful || 'curbside',
                notes:              overlay.querySelector('#pantryInvNotes')?.value.trim()    || '',
                isStaple:           overlay.querySelector('#pantryInvStaple')?.checked ?? false,
                photo:              this._editInvPhoto || null,
                brand:              overlay.querySelector('#pantryInvBrand')?.value.trim()    || '',
                upc:                overlay.querySelector('#pantryInvUPC')?.value.trim()      || '',
                autoAddToList:      overlay.querySelector('#pantryInvAutoAdd')?.checked ?? false,
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
                    fulfillment: 'curbside',
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
            await this.store.addItem({
                name:        data.name,
                category:    data.category || detectCategory(data.name),
                qty:         Number.isFinite(parsedQty) ? parsedQty : 1,
                unit:        data.unit || 'count',
                fulfillment: data.fulfillment || 'curbside',
                notes:       data.notes || '',
                addedBy:     data.addedBy || null,
                storeId:     data.storeId  || null,
                photo:       data.photo    || null,
            });
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

        // Snapshot so we can revert if the save fails.
        const prevChecked = item.checked;

        // Optimistic update — flip visually right now, no waiting for the network.
        item.checked = !item.checked;
        this._applyCheckVisuals(id, item.checked);

        // Persist. On failure revert the optimistic change so the UI stays
        // consistent with the server.
        try {
            await this._updateItem(id, { checked: item.checked });
        } catch {
            item.checked = prevChecked;
            this._applyCheckVisuals(id, prevChecked);
        }
    }

    /** Update just the check button + row class for a single item — no full re-render. */
    _applyCheckVisuals(id, checked) {
        const row = this.container.querySelector(`.pantry-item-row[data-id="${id}"]`);
        if (!row) return;
        row.classList.toggle('checked', checked);
        const btn = row.querySelector('.pantry-item-check');
        if (btn) {
            btn.classList.toggle('done', checked);
            btn.innerHTML = checked
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
            fulfillment: 'curbside',
            notes:       inv.notes || '',
            // The backend resolves the joined product image from product_id,
            // so passing a plain name is enough to round-trip a sensible row.
        });
    }

    async _addInventoryItem(data) {
        // Two-step: create product, then create the inventory row that points
        // at it. SSE re-fetch lands the new card without needing local state
        // mutation.
        this._setSyncStatus('saving');
        try {
            const product = await this.store.addProduct({
                name:     data.name,
                brand:    data.brand   || '',
                category: data.category || detectCategory(data.name),
                photo:    data.photo   || '',
                notes:    data.notes   || '',
                isStaple: !!data.isStaple,
                upc:      data.upc     || '',
            });
            if (!product?.id) throw new Error('product create returned no id');

            // stockLevel → starting qty. Default "ok" with qty=1 when nothing
            // is supplied — same heuristic as the stockLevel translator below.
            const startQty =
                data.stockLevel === 'out' ? 0 :
                data.stockLevel === 'low' ? 1 :
                                            1;

            await this.store.addInventoryItem({
                productId: product.id,
                qty:       startQty,
                notes:     data.notes || '',
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
        // qty / notes / location patch the inventory row.
        // isStaple patches the parent product row (handled by the store).
        // Other legacy fields (useCount, defaultAmount, …) still no-op until
        // follow-up PRs add columns for them.
        const patch = {};
        if ('qty'        in changes) patch.qty        = changes.qty;
        if ('notes'      in changes) patch.notes      = changes.notes;
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

    _handleScanResult({ mode, barcode, product }) {
        if (mode === 'restock') {
            // Find existing pantry item by UPC or name match
            const existing = this._inventory.find(i => i.upc === barcode) ||
                             (product.name ? this._inventory.find(i => i.name.toLowerCase() === product.name.toLowerCase()) : null);
            if (existing) {
                // Already in pantry — just restock (mark as in_stock)
                this._setStockStatus(existing.id, 'ok', false);
                // Remove from shopping list if present
                const onList = this._items.find(i => !i.checked && (i.inventoryRef === existing.id || i.name.toLowerCase() === existing.name.toLowerCase()));
                if (onList) this._removeItem(onList.id);
                this._showToast(`✅ ${existing.name} restocked!`);
            } else {
                // Not in pantry — open modal to add it
                this._openInvModal(null, {
                    name:     product.name || '',
                    brand:    product.brand || '',
                    upc:      barcode,
                    category: product.category || 'other',
                    photo:    product.imageUrl || null,
                    stockLevel: 'ok',
                });
            }
        } else if (mode === 'mark_used') {
            const existing = this._inventory.find(i => i.upc === barcode) ||
                             (product.name ? this._inventory.find(i => i.name.toLowerCase() === product.name.toLowerCase()) : null);
            if (existing) {
                this._openStatusPickerModal(existing);
            } else {
                // Not in pantry — offer to add to shopping list directly
                this._openAddToListDirectModal(product, barcode);
            }
        } else if (mode === 'need') {
            // Shopping List scan → always open the Add Item modal pre-filled so
            // the user can adjust quantity, store, and fulfillment before adding.
            const existing = this._inventory.find(i => i.upc === barcode) ||
                             (product.name ? this._inventory.find(i => i.name.toLowerCase() === product.name.toLowerCase()) : null);

            if (existing) {
                // Pre-fill from the known pantry record — still opens as NEW item
                this._openItemModal(null, {
                    name:        existing.name,
                    category:    existing.category,
                    fulfillment: existing.defaultFulfillment || 'curbside',
                    notes:       existing.notes || '',
                    photo:       existing.photo || product.imageUrl || null,
                });
            } else {
                // Not in pantry — open modal with barcode-lookup data as NEW item
                const name = product.name || `Item ${barcode}`;
                this._openItemModal(null, {
                    name,
                    category:    product.category || detectCategory(name),
                    notes:       product.brand ? `Brand: ${product.brand}` : '',
                    photo:       product.imageUrl || null,
                    fulfillment: 'curbside',
                });
            }
        }
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
            this._addItem({ name: product.name || 'Unknown item', category: product.category || detectCategory(product.name || ''), photo: product.imageUrl || null, source: 'scan' });
            close();
            this._showToast('🛒 Added to shopping list!');
        });
        overlay.querySelector('#dlAddPantry')?.addEventListener('click', () => {
            close();
            this._openInvModal(null, { name: product.name || '', brand: product.brand || '', upc: barcode, category: product.category || 'other', photo: product.imageUrl || null, stockLevel: 'out' });
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
