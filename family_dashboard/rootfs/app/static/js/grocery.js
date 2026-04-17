/**
 * grocery.js — Smart Family Grocery List UI
 *
 * Tabs:
 *  🛒 List     — active shopping list, grouped by category, with progress
 *  📦 Pantry   — frequently-used item inventory with stock levels
 *  👨‍👩‍👧‍👦 Requests — family members submit requests; wife approves → list
 *
 * Overlays:
 *  🏪 Store Mode      — full-screen in-store shopping view (touch-optimised)
 *  ➕ Item Modal      — add / edit a shopping list item
 *  📦 Pantry Modal    — add / edit a pantry inventory item
 *  📅 Meal Plan Modal — import ingredients from this week's meal plan
 *
 * Addon version: photos uploaded via store.uploadPhoto() (multipart POST to
 * backend) instead of being stored as base64 data URLs.
 */
import { isoWeek, weekDates, formatWeekRange } from './utils.js';
import { BarcodeScanner } from './scanner.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Family members that can submit requests. Edit to match your family. */
const FAMILY_MEMBERS = ['Amy', 'Freddy', 'Boy 1', 'Boy 2'];

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

// ── GroceryApp ────────────────────────────────────────────────────────────────

export class GroceryApp {
    constructor(containerEl, store) {
        this.container = containerEl;
        this.store     = store;

        // Tab state
        this._tab = 'list'; // 'list' | 'pantry' | 'requests'

        // List state
        this._items    = [];
        this._requests = [];
        this._filter   = 'all'; // 'all' | 'curbside' | 'instore'
        this._showChecked = true;

        // Pantry state
        this._inventory      = [];
        this._pantrySearch   = '';
        this._pantryFilter   = 'all'; // 'all' | 'staples' | 'low'

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
        this._items    = cached.items    || [];
        this._requests = cached.requests || [];
        this._inventory = this.store.loadCachedInventory() || [];
        this._render();

        // Subscribe to live SSE updates (SSE is a notification only — re-fetch actual data)
        this._unsub = this.store.subscribe(async ({ type }) => {
            if (type === 'list') {
                const fresh = await this.store.fetchList();
                if (fresh) {
                    this._items    = fresh.items    || [];
                    this._requests = fresh.requests || [];
                }
                this._render();
                this._flashSync();
            } else if (type === 'inventory') {
                const freshInv = await this.store.fetchInventory();
                if (freshInv) this._inventory = freshInv;
                this._render();
            }
        });

        // Fetch fresh from backend
        const freshList = await this.store.fetchList();
        if (freshList) {
            this._items    = freshList.items    || [];
            this._requests = freshList.requests || [];
        }
        const freshInv = await this.store.fetchInventory();
        if (freshInv) this._inventory = freshInv;
        this._render();
    }

    destroy() { this._unsub?.(); }

    // ── Master render ─────────────────────────────────────────────────────────

    _render() {
        const pendingReqs = this._requests.filter(r => r.status === 'pending').length;
        const unchecked   = this._items.filter(i => !i.checked).length;
        const inStore     = this._items.filter(i => !i.checked && i.fulfillment === 'instore').length;

        this.container.innerHTML = `
            <div class="grocery-page">
                <div class="grocery-header">
                    <div class="grocery-title">🛒 Shopping List</div>
                    <div class="grocery-header-actions">
                        ${inStore > 0 ? `
                            <button class="grocery-store-mode-btn" id="groceryStoreModeBtn">
                                🏪 Store Mode
                                <span class="grocery-store-mode-count">${inStore}</span>
                            </button>` : ''}
                        <span class="grocery-sync-badge" id="grocerySyncBadge"
                              data-status="${this._syncStatus}">${this._syncBadgeHTML()}</span>
                    </div>
                </div>

                <div class="grocery-tabs">
                    <button class="grocery-tab${this._tab === 'list'     ? ' active' : ''}" data-tab="list">
                        🛒 List
                        ${unchecked > 0 ? `<span class="grocery-tab-count">${unchecked}</span>` : ''}
                    </button>
                    <button class="grocery-tab${this._tab === 'pantry'   ? ' active' : ''}" data-tab="pantry">
                        📦 Pantry
                        <span class="grocery-tab-count">${this._inventory.length}</span>
                    </button>
                    <button class="grocery-tab${this._tab === 'requests' ? ' active' : ''}" data-tab="requests">
                        👨‍👩‍👧 Requests
                        ${pendingReqs > 0 ? `<span class="grocery-tab-count alert">${pendingReqs}</span>` : ''}
                    </button>
                </div>

                <div class="grocery-body" id="groceryBody"></div>
            </div>
        `;

        document.querySelectorAll('.grocery-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._tab = btn.dataset.tab;
                this._render();
            });
        });

        document.getElementById('groceryStoreModeBtn')?.addEventListener('click', () => {
            this._openStoreMode();
        });

        const body = document.getElementById('groceryBody');
        if (this._tab === 'list')     this._renderListTab(body);
        if (this._tab === 'pantry')   this._renderPantryTab(body);
        if (this._tab === 'requests') this._renderRequestsTab(body);
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

        // Group by category, unchecked first within each group
        const grouped = {};
        items.forEach(item => {
            const cat = item.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });
        Object.keys(grouped).forEach(cat => {
            grouped[cat].sort((a, b) => a.checked - b.checked);
        });

        const catOrder = CATEGORIES.map(c => c.id).filter(id => grouped[id]);

        body.innerHTML = `
            <div class="grocery-list-toolbar">
                <div class="grocery-filters">
                    <button class="grocery-filter-btn${this._filter === 'all'      ? ' active' : ''}" data-filter="all">All</button>
                    <button class="grocery-filter-btn${this._filter === 'curbside' ? ' active' : ''}" data-filter="curbside">🚗 Curbside</button>
                    <button class="grocery-filter-btn${this._filter === 'instore'  ? ' active' : ''}" data-filter="instore">🏪 In-Store</button>
                </div>
                <div class="grocery-list-actions">
                    <button class="grocery-action-btn" id="groceryMealPlanBtn" title="Import from this week's meal plan">
                        📅 From Meals
                    </button>
                    <button class="grocery-action-btn" id="groceryStaplesBtn" title="Add your weekly staples">
                        ⭐ Staples
                    </button>
                    ${checked > 0 ? `
                        <button class="grocery-action-btn danger" id="groceryClearChecked">
                            🗑 Clear ${checked} done
                        </button>` : ''}
                    <button class="grocery-toggle-checked" id="groceryToggleChecked" title="${this._showChecked ? 'Hide' : 'Show'} checked items">
                        ${this._showChecked ? '👁 Hide done' : '👁 Show done'}
                    </button>
                </div>
            </div>

            ${total > 0 ? `
                <div class="grocery-progress-wrap">
                    <div class="grocery-progress-bar">
                        <div class="grocery-progress-fill" style="width:${pct.toFixed(1)}%"></div>
                    </div>
                    <span class="grocery-progress-label">${checked} of ${total} items</span>
                </div>` : ''}

            <div class="grocery-categories" id="groceryCategories">
                ${catOrder.length === 0
                    ? `<div class="grocery-empty">
                           <div class="grocery-empty-icon">🛒</div>
                           <div class="grocery-empty-title">Your list is empty</div>
                           <div class="grocery-empty-text">Add items below, import from your meal plan, or add your weekly staples.</div>
                       </div>`
                    : catOrder.map(catId => this._categoryGroupHTML(catId, grouped[catId])).join('')
                }
            </div>

            <button class="grocery-add-fab" id="groceryAddFab" title="Add item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add Item
            </button>
        `;

        body.querySelectorAll('.grocery-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => { this._filter = btn.dataset.filter; this._render(); });
        });
        body.querySelector('#groceryToggleChecked')?.addEventListener('click', () => {
            this._showChecked = !this._showChecked; this._render();
        });
        body.querySelector('#groceryClearChecked')?.addEventListener('click', () => this._clearChecked());
        body.querySelector('#groceryMealPlanBtn')?.addEventListener('click', () => this._openMealPlanImport());
        body.querySelector('#groceryStaplesBtn')?.addEventListener('click', () => this._addStaples());
        body.querySelector('#groceryAddFab')?.addEventListener('click', () => this._openItemModal());

        body.querySelectorAll('.grocery-item-row').forEach(row => {
            const id = row.dataset.id;
            row.querySelector('.grocery-item-check')?.addEventListener('click', e => {
                e.stopPropagation();
                this._toggleItem(id);
            });
            row.querySelector('.grocery-item-edit')?.addEventListener('click', e => {
                e.stopPropagation();
                const item = this._items.find(i => i.id === id);
                if (item) this._openItemModal(item);
            });
        });
    }

    _categoryGroupHTML(catId, items) {
        const cat       = catOf(catId);
        const unchecked = items.filter(i => !i.checked).length;
        return `
            <div class="grocery-cat-group">
                <div class="grocery-cat-header" style="--cat-color:${cat.color}">
                    <span class="grocery-cat-emoji">${cat.emoji}</span>
                    <span class="grocery-cat-label">${cat.label}</span>
                    ${unchecked > 0
                        ? `<span class="grocery-cat-count">${unchecked}</span>`
                        : `<span class="grocery-cat-all-done">✓ all done</span>`}
                </div>
                ${items.map(item => this._itemRowHTML(item)).join('')}
            </div>`;
    }

    _itemRowHTML(item) {
        const fulfillIcon = item.fulfillment === 'instore'  ? '<span class="grocery-fulfillment instore" title="In-Store">🏪</span>'
                          : item.fulfillment === 'curbside' ? '<span class="grocery-fulfillment curbside" title="Curbside">🚗</span>'
                          : '';
        const amountStr = [item.amount, item.unit].filter(Boolean).join(' ');
        return `
            <div class="grocery-item-row${item.checked ? ' checked' : ''}" data-id="${item.id}">
                <button class="grocery-item-check${item.checked ? ' done' : ''}" aria-label="Toggle">
                    ${item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>'
                        : ''}
                </button>
                ${item.photo
                    ? `<div class="grocery-item-photo-thumb" style="background-image:url('${item.photo}')"></div>`
                    : ''}
                <div class="grocery-item-info">
                    <span class="grocery-item-name">${this._esc(item.name)}</span>
                    ${amountStr ? `<span class="grocery-item-amount">${this._esc(amountStr)}</span>` : ''}
                    ${item.notes ? `<span class="grocery-item-notes">${this._esc(item.notes)}</span>` : ''}
                    ${item.source === 'request' && item.addedBy
                        ? `<span class="grocery-item-source">Requested by ${this._esc(item.addedBy)}</span>`
                        : ''}
                </div>
                ${fulfillIcon}
                <button class="grocery-item-edit" aria-label="Edit" title="Edit">
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
            <div class="grocery-pantry-toolbar">
                <div class="grocery-pantry-search-wrap">
                    <svg class="grocery-pantry-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input type="search" id="groceryPantrySearch" class="grocery-pantry-search"
                           placeholder="Search pantry…" value="${this._esc(this._pantrySearch)}">
                </div>
                <button class="grocery-action-btn primary" id="groceryAddPantryItem">+ New Item</button>
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

            <div class="grocery-pantry-filters">
                <button class="grocery-filter-btn${filter === 'all'     ? ' active' : ''}" data-pfilter="all">All (${this._inventory.length})</button>
                <button class="grocery-filter-btn${filter === 'staples' ? ' active' : ''}" data-pfilter="staples">⭐ Staples (${staples.length})</button>
                <button class="grocery-filter-btn${filter === 'low'     ? ' active' : ''}" data-pfilter="low">
                    ⚠️ Need Restock (${lowItems.length})${lowItems.length > 0 ? ' 🔴' : ''}
                </button>
            </div>

            ${outItems.length > 0 && filter === 'all' ? `
                <div class="grocery-pantry-alert">
                    🔴 <strong>${outItems.length} item${outItems.length > 1 ? 's' : ''} out</strong> — add to shopping list?
                    <button class="grocery-pantry-alert-btn" id="groceryAddAllOut">Add All Out</button>
                </div>` : ''}

            <div class="pantry-grid" id="pantryGrid">
                ${items.length === 0
                    ? `<div class="grocery-empty" style="grid-column:1/-1">
                           <div class="grocery-empty-icon">📦</div>
                           <div class="grocery-empty-title">${q || filter !== 'all' ? 'No items match' : 'Pantry is empty'}</div>
                           <div class="grocery-empty-text">Add items manually or use Scan to Restock to add items by scanning their barcode.</div>
                       </div>`
                    : items.map(inv => this._pantryCardHTML(inv)).join('')
                }
            </div>
        `;

        body.querySelector('#groceryPantrySearch')?.addEventListener('input', e => {
            this._pantrySearch = e.target.value;
            this._renderPantryTab(body);
        });
        body.querySelectorAll('[data-pfilter]').forEach(btn => {
            btn.addEventListener('click', () => { this._pantryFilter = btn.dataset.pfilter; this._render(); });
        });
        body.querySelector('#groceryAddPantryItem')?.addEventListener('click', () => this._openInvModal());
        body.querySelector('#groceryAddAllOut')?.addEventListener('click', () => {
            outItems.forEach(inv => this._addFromInventory(inv));
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

    // ── REQUESTS TAB ──────────────────────────────────────────────────────────

    _renderRequestsTab(body) {
        const pending   = this._requests.filter(r => r.status === 'pending');
        const recent    = this._requests.filter(r => r.status !== 'pending').slice(-5).reverse();

        body.innerHTML = `
            <div class="grocery-requests-layout">
                <div class="grocery-request-form-card">
                    <div class="grocery-request-form-title">📝 Submit a Request</div>
                    <div class="grocery-request-form-subtitle">Family members: add items you'd like on the next shopping run</div>
                    <div class="grocery-request-who">
                        ${FAMILY_MEMBERS.map(m => `
                            <button class="grocery-who-btn" data-who="${this._esc(m)}">${this._esc(m)}</button>`).join('')}
                    </div>
                    <input type="text" id="groceryRequestName" class="grocery-request-input"
                           placeholder="Item name (e.g. Doritos Nacho Cheese, big bag)" autocomplete="off">
                    <input type="text" id="groceryRequestNotes" class="grocery-request-input"
                           placeholder="Any details? (optional)" autocomplete="off" style="margin-top:8px">
                    <button class="grocery-request-submit" id="groceryRequestSubmit">Submit Request</button>
                </div>

                <div class="grocery-requests-section">
                    <div class="grocery-requests-section-title">
                        Pending Requests
                        ${pending.length > 0 ? `<span class="grocery-tab-count alert">${pending.length}</span>` : ''}
                    </div>
                    ${pending.length === 0
                        ? `<div class="grocery-requests-empty">No pending requests — all caught up! 🎉</div>`
                        : pending.map(req => `
                            <div class="grocery-request-card" data-req-id="${req.id}">
                                <div class="grocery-request-who-badge">${this._esc(req.requestedBy)}</div>
                                <div class="grocery-request-content">
                                    <div class="grocery-request-item-name">${this._esc(req.name)}</div>
                                    ${req.notes ? `<div class="grocery-request-item-notes">${this._esc(req.notes)}</div>` : ''}
                                    <div class="grocery-request-time">${this._timeAgo(req.addedAt)}</div>
                                </div>
                                <div class="grocery-request-card-actions">
                                    <button class="grocery-req-add" title="Add to list">+ Add</button>
                                    <button class="grocery-req-dismiss" title="Dismiss">✕</button>
                                </div>
                            </div>`).join('')}
                </div>

                ${recent.length > 0 ? `
                    <div class="grocery-requests-section">
                        <div class="grocery-requests-section-title muted">Recently Handled</div>
                        ${recent.map(req => `
                            <div class="grocery-request-card done" data-req-id="${req.id}">
                                <div class="grocery-request-who-badge muted">${this._esc(req.requestedBy)}</div>
                                <div class="grocery-request-content">
                                    <div class="grocery-request-item-name muted">${this._esc(req.name)}</div>
                                    <div class="grocery-request-time">${req.status === 'added' ? '✓ Added to list' : '✕ Dismissed'} · ${this._timeAgo(req.addedAt)}</div>
                                </div>
                            </div>`).join('')}
                    </div>` : ''}
            </div>
        `;

        let selectedWho = FAMILY_MEMBERS[0];
        body.querySelectorAll('.grocery-who-btn').forEach(btn => {
            if (btn.dataset.who === selectedWho) btn.classList.add('active');
            btn.addEventListener('click', () => {
                body.querySelectorAll('.grocery-who-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedWho = btn.dataset.who;
            });
        });

        body.querySelector('#groceryRequestSubmit')?.addEventListener('click', () => {
            const name  = body.querySelector('#groceryRequestName')?.value.trim();
            const notes = body.querySelector('#groceryRequestNotes')?.value.trim();
            if (!name) { body.querySelector('#groceryRequestName')?.focus(); return; }
            this._submitRequest({ name, notes, requestedBy: selectedWho });
            body.querySelector('#groceryRequestName').value  = '';
            body.querySelector('#groceryRequestNotes').value = '';
        });

        body.querySelectorAll('.grocery-request-card').forEach(card => {
            const id = card.dataset.reqId;
            card.querySelector('.grocery-req-add')?.addEventListener('click', () => this._approveRequest(id));
            card.querySelector('.grocery-req-dismiss')?.addEventListener('click', () => this._dismissRequest(id));
        });
    }

    // ── STORE MODE OVERLAY ────────────────────────────────────────────────────

    _openStoreMode() {
        const overlay = document.getElementById('groceryStoreModeOverlay');
        if (!overlay) return;

        const inStoreItems = this._items.filter(i => i.fulfillment === 'instore');

        overlay.innerHTML = `
            <div class="grocery-store-mode">
                <div class="grocery-store-header">
                    <div class="grocery-store-header-left">
                        <div class="grocery-store-title">🏪 In-Store List</div>
                        <div class="grocery-store-subtitle">
                            ${inStoreItems.filter(i => !i.checked).length} items remaining
                        </div>
                    </div>
                    <button class="grocery-store-close" id="groceryStoreClose">✕ Done</button>
                </div>
                <div class="grocery-store-progress-bar">
                    <div class="grocery-store-progress-fill" style="width:${
                        inStoreItems.length > 0
                            ? (inStoreItems.filter(i => i.checked).length / inStoreItems.length * 100).toFixed(1)
                            : 0}%"></div>
                </div>
                <div class="grocery-store-items" id="groceryStoreItems">
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

        overlay.querySelector('#groceryStoreClose')?.addEventListener('click', () => {
            overlay.classList.remove('active');
        });

        overlay.querySelectorAll('.grocery-store-item').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.dataset.id;
                this._toggleItem(id);
                const item = this._items.find(i => i.id === id);
                if (item) {
                    row.classList.toggle('checked', item.checked);
                    const check = row.querySelector('.grocery-store-check');
                    if (check) check.classList.toggle('done', item.checked);
                    check.innerHTML = item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>'
                        : '';
                    const remaining = this._items.filter(i => i.fulfillment === 'instore' && !i.checked).length;
                    overlay.querySelector('.grocery-store-subtitle').textContent = `${remaining} items remaining`;
                    const total2 = this._items.filter(i => i.fulfillment === 'instore').length;
                    const done2  = total2 - remaining;
                    overlay.querySelector('.grocery-store-progress-fill').style.width =
                        total2 > 0 ? `${(done2 / total2 * 100).toFixed(1)}%` : '0%';
                }
            });
        });
    }

    _storeModeItemHTML(item) {
        const amountStr = [item.amount, item.unit].filter(Boolean).join(' ');
        return `
            <div class="grocery-store-item${item.checked ? ' checked' : ''}" data-id="${item.id}">
                <div class="grocery-store-check${item.checked ? ' done' : ''}">
                    ${item.checked
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>'
                        : ''}
                </div>
                ${item.photo
                    ? `<div class="grocery-store-photo" style="background-image:url('${item.photo}')"></div>`
                    : ''}
                <div class="grocery-store-item-info">
                    <div class="grocery-store-item-name">${this._esc(item.name)}</div>
                    ${amountStr ? `<div class="grocery-store-item-amount">${this._esc(amountStr)}</div>` : ''}
                    ${item.notes ? `<div class="grocery-store-item-notes">${this._esc(item.notes)}</div>` : ''}
                </div>
                <div class="grocery-store-cat">${catOf(item.category).emoji}</div>
            </div>`;
    }

    // ── ITEM MODAL (add/edit) ─────────────────────────────────────────────────

    _openItemModal(item = null) {
        this._editItem      = item ?? null;
        this._editItemPhoto = item?.photo ?? null;
        this._renderItemModal();
    }

    _renderItemModal() {
        const overlay = document.getElementById('groceryItemOverlay');
        if (!overlay) return;
        const item  = this._editItem;
        const isNew = !item;

        overlay.innerHTML = `
            <div class="grocery-modal" role="dialog" aria-modal="true">
                <div class="grocery-modal-header">
                    <div class="grocery-modal-title">${isNew ? '➕ Add Item' : '✏️ Edit Item'}</div>
                    <button class="grocery-modal-close" id="groceryItemClose">×</button>
                </div>
                <div class="grocery-modal-body">

                    <div class="grocery-modal-photo-area" id="groceryItemPhotoArea">
                        ${this._editItemPhoto
                            ? `<img src="${this._editItemPhoto}" class="grocery-modal-photo-img" alt="Item photo">
                               <div class="grocery-modal-photo-overlay">
                                   <button class="grocery-photo-remove-btn" id="groceryItemPhotoRemove">🗑 Remove</button>
                               </div>`
                            : `<div class="grocery-modal-photo-placeholder">
                                   <div style="font-size:28px">📷</div>
                                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
                               </div>`
                        }
                    </div>
                    <input type="file" id="groceryItemPhotoInput" accept="image/*" style="display:none">

                    <div class="grocery-modal-field">
                        <label>Item Name *</label>
                        <input type="text" id="groceryItemName" class="grocery-modal-input"
                               value="${this._esc(item?.name || '')}"
                               placeholder="e.g. Organic Whole Milk" autocomplete="off">
                        <div class="grocery-item-suggestions" id="groceryItemSuggestions"></div>
                    </div>

                    <div class="grocery-modal-row">
                        <div class="grocery-modal-field">
                            <label>Amount</label>
                            <input type="text" id="groceryItemAmount" class="grocery-modal-input"
                                   value="${this._esc(item?.amount || '')}" placeholder="2">
                        </div>
                        <div class="grocery-modal-field">
                            <label>Unit</label>
                            <input type="text" id="groceryItemUnit" class="grocery-modal-input"
                                   value="${this._esc(item?.unit || '')}" placeholder="lbs, bags, cans…">
                        </div>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Category</label>
                        <select id="groceryItemCategory" class="grocery-modal-input">
                            ${CATEGORIES.map(c =>
                                `<option value="${c.id}" ${(item?.category || 'other') === c.id ? 'selected' : ''}>
                                    ${c.emoji} ${c.label}</option>`).join('')}
                        </select>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Fulfillment</label>
                        <div class="grocery-fulfillment-toggle">
                            <button class="grocery-fulfillment-btn${(item?.fulfillment ?? 'curbside') === 'curbside' ? ' active' : ''}"
                                    data-ful="curbside">🚗 Curbside / Delivery</button>
                            <button class="grocery-fulfillment-btn${item?.fulfillment === 'instore' ? ' active' : ''}"
                                    data-ful="instore">🏪 In-Store (I'll grab it)</button>
                        </div>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Notes / Brand Details</label>
                        <input type="text" id="groceryItemNotes" class="grocery-modal-input"
                               value="${this._esc(item?.notes || '')}"
                               placeholder="Brand, size, substitution notes…">
                    </div>

                    ${isNew ? `
                        <div class="grocery-modal-save-pantry">
                            <label class="grocery-checkbox-label">
                                <input type="checkbox" id="grocerySaveToPantry">
                                Also save to Pantry for quick re-adding later
                            </label>
                        </div>` : ''}

                    ${!isNew ? `
                        <button class="grocery-modal-delete" id="groceryItemDelete">🗑 Remove from list</button>` : ''}
                </div>
                <div class="grocery-modal-footer">
                    <button class="grocery-modal-save" id="groceryItemSave">
                        ${isNew ? 'Add to List' : 'Save Changes'}
                    </button>
                    <button class="grocery-modal-cancel" id="groceryItemCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const nameInput = overlay.querySelector('#groceryItemName');
        const catSelect = overlay.querySelector('#groceryItemCategory');
        nameInput?.addEventListener('input', () => {
            const cat = detectCategory(nameInput.value);
            if (catSelect && cat !== 'other') catSelect.value = cat;
            this._showItemSuggestions(nameInput.value, overlay);
        });

        overlay.querySelectorAll('.grocery-fulfillment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.grocery-fulfillment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Photo upload (addon version — async multipart POST)
        const photoArea  = overlay.querySelector('#groceryItemPhotoArea');
        const photoInput = overlay.querySelector('#groceryItemPhotoInput');
        photoArea?.addEventListener('click', e => {
            if (!e.target.closest('#groceryItemPhotoRemove')) photoInput?.click();
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
                console.error('[GroceryApp] Photo upload failed:', err);
                this._editItemPhoto = null;
                this._updateItemPhotoPreview(overlay);
            }
        });
        overlay.querySelector('#groceryItemPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation();
            this._editItemPhoto = null;
            this._updateItemPhotoPreview(overlay);
        });

        const close = () => { overlay.classList.remove('active'); this._editItem = null; this._editItemPhoto = null; };
        overlay.querySelector('#groceryItemClose')?.addEventListener('click', close);
        overlay.querySelector('#groceryItemCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#groceryItemSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.grocery-fulfillment-btn.active');
            const data = {
                name,
                amount:      overlay.querySelector('#groceryItemAmount')?.value.trim()   || '',
                unit:        overlay.querySelector('#groceryItemUnit')?.value.trim()      || '',
                category:    catSelect?.value || detectCategory(name),
                fulfillment: fulfillmentActive?.dataset.ful || 'curbside',
                notes:       overlay.querySelector('#groceryItemNotes')?.value.trim()    || '',
                photo:       this._editItemPhoto || null,
            };
            if (this._editItem) {
                this._updateItem(this._editItem.id, data);
            } else {
                this._addItem(data);
                if (overlay.querySelector('#grocerySaveToPantry')?.checked) {
                    this._addInventoryItemFromListData(data);
                }
            }
            close();
        });

        overlay.querySelector('#groceryItemDelete')?.addEventListener('click', () => {
            if (this._editItem) { this._removeItem(this._editItem.id); close(); }
        });

        setTimeout(() => nameInput?.focus(), 50);
    }

    _showPhotoUploading(area) {
        if (!area) return;
        area.innerHTML = `
            <div class="grocery-modal-photo-placeholder">
                <div style="font-size:28px">⏳</div>
                <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Uploading photo…</div>
            </div>`;
    }

    _updateItemPhotoPreview(overlay) {
        const area  = overlay.querySelector('#groceryItemPhotoArea');
        const input = overlay.querySelector('#groceryItemPhotoInput');
        if (!area) return;
        area.innerHTML = this._editItemPhoto
            ? `<img src="${this._editItemPhoto}" class="grocery-modal-photo-img" alt="Item photo">
               <div class="grocery-modal-photo-overlay">
                   <button class="grocery-photo-remove-btn" id="groceryItemPhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="grocery-modal-photo-placeholder">
                   <div style="font-size:28px">📷</div>
                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Add product photo</div>
               </div>`;
        overlay.querySelector('#groceryItemPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editItemPhoto = null; this._updateItemPhotoPreview(overlay);
        });
        if (input) area.appendChild(input);
    }

    _showItemSuggestions(q, overlay) {
        const sug = overlay.querySelector('#groceryItemSuggestions');
        if (!sug) return;
        if (!q || q.length < 2) { sug.innerHTML = ''; return; }
        const ql = q.toLowerCase();
        const matches = this._inventory
            .filter(i => i.name.toLowerCase().includes(ql))
            .slice(0, 5);
        if (!matches.length) { sug.innerHTML = ''; return; }
        sug.innerHTML = matches.map(i => `
            <div class="grocery-item-suggestion" data-inv-id="${i.id}">
                ${catOf(i.category).emoji} ${this._esc(i.name)}
                ${i.defaultAmount ? `<span class="grocery-suggestion-amount">${i.defaultAmount} ${i.defaultUnit || ''}</span>` : ''}
            </div>`).join('');
        sug.querySelectorAll('.grocery-item-suggestion').forEach(el => {
            el.addEventListener('mousedown', e => {
                e.preventDefault();
                const inv = this._inventory.find(i => i.id === el.dataset.invId);
                if (!inv) return;
                overlay.querySelector('#groceryItemName').value     = inv.name;
                overlay.querySelector('#groceryItemAmount').value   = inv.defaultAmount || '';
                overlay.querySelector('#groceryItemUnit').value     = inv.defaultUnit   || '';
                overlay.querySelector('#groceryItemCategory').value = inv.category      || 'other';
                overlay.querySelector('#groceryItemNotes').value    = inv.notes         || '';
                const fulfBtns = overlay.querySelectorAll('.grocery-fulfillment-btn');
                fulfBtns.forEach(b => b.classList.toggle('active', b.dataset.ful === (inv.defaultFulfillment || 'curbside')));
                if (inv.photo) { this._editItemPhoto = inv.photo; this._updateItemPhotoPreview(overlay); }
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
        const overlay = document.getElementById('groceryInvOverlay');
        if (!overlay) return;
        const inv     = this._editInvItem;
        const prefill = this._prefillInv;
        const isNew   = !inv;

        overlay.innerHTML = `
            <div class="grocery-modal" role="dialog" aria-modal="true">
                <div class="grocery-modal-header">
                    <div class="grocery-modal-title">${isNew ? '📦 New Pantry Item' : `✏️ Edit: ${this._esc(inv.name)}`}</div>
                    <button class="grocery-modal-close" id="groceryInvClose">×</button>
                </div>
                <div class="grocery-modal-body">

                    <div class="grocery-modal-photo-area" id="groceryInvPhotoArea">
                        ${this._editInvPhoto
                            ? `<img src="${this._editInvPhoto}" class="grocery-modal-photo-img" alt="Item photo">
                               <div class="grocery-modal-photo-overlay">
                                   <button class="grocery-photo-remove-btn" id="groceryInvPhotoRemove">🗑 Remove</button>
                               </div>`
                            : `<div class="grocery-modal-photo-placeholder">
                                   <div style="font-size:28px">📷</div>
                                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Product photo (helps with brand ID)</div>
                               </div>`
                        }
                    </div>
                    <input type="file" id="groceryInvPhotoInput" accept="image/*" style="display:none">

                    <div class="grocery-modal-field">
                        <label>Item Name *</label>
                        <input type="text" id="groceryInvName" class="grocery-modal-input"
                               value="${this._esc(inv?.name || prefill?.name || '')}" placeholder="e.g. Organic Whole Milk">
                    </div>

                    <div class="grocery-modal-row">
                        <div class="grocery-modal-field">
                            <label>Default Amount</label>
                            <input type="text" id="groceryInvAmount" class="grocery-modal-input"
                                   value="${this._esc(inv?.defaultAmount || '')}" placeholder="1">
                        </div>
                        <div class="grocery-modal-field">
                            <label>Unit</label>
                            <input type="text" id="groceryInvUnit" class="grocery-modal-input"
                                   value="${this._esc(inv?.defaultUnit || '')}" placeholder="gallon, lbs…">
                        </div>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Category</label>
                        <select id="groceryInvCategory" class="grocery-modal-input">
                            ${CATEGORIES.map(c =>
                                `<option value="${c.id}" ${(inv?.category || prefill?.category || 'other') === c.id ? 'selected' : ''}>
                                    ${c.emoji} ${c.label}</option>`).join('')}
                        </select>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Default Fulfillment</label>
                        <div class="grocery-fulfillment-toggle">
                            <button class="grocery-fulfillment-btn${(inv?.defaultFulfillment ?? 'curbside') === 'curbside' ? ' active' : ''}"
                                    data-ful="curbside">🚗 Curbside / Delivery</button>
                            <button class="grocery-fulfillment-btn${inv?.defaultFulfillment === 'instore' ? ' active' : ''}"
                                    data-ful="instore">🏪 In-Store</button>
                        </div>
                    </div>

                    <div class="grocery-modal-field">
                        <label>Brand / Notes</label>
                        <input type="text" id="groceryInvNotes" class="grocery-modal-input"
                               value="${this._esc(inv?.notes || '')}"
                               placeholder="Brand, size, any notes for the shopper…">
                    </div>

                    <div class="grocery-modal-row">
                        <div class="grocery-modal-field">
                            <label>Brand</label>
                            <input type="text" id="groceryInvBrand" class="grocery-modal-input"
                                   value="${this._esc(inv?.brand || prefill?.brand || '')}" placeholder="e.g. Tropicana">
                        </div>
                        <div class="grocery-modal-field">
                            <label>UPC Barcode</label>
                            <input type="text" id="groceryInvUPC" class="grocery-modal-input"
                                   value="${this._esc(inv?.upc || prefill?.upc || '')}" placeholder="Scan or enter manually"
                                   pattern="\\d{6,14}" maxlength="14">
                        </div>
                    </div>

                    <div class="grocery-modal-field">
                        <label class="grocery-checkbox-label">
                            <input type="checkbox" id="groceryInvAutoAdd" ${inv?.autoAddToList ? 'checked' : ''}>
                            🛒 Auto-add to shopping list when marked Out
                        </label>
                    </div>

                    <div class="grocery-modal-field">
                        <label class="grocery-checkbox-label">
                            <input type="checkbox" id="groceryInvStaple" ${inv?.isStaple ? 'checked' : ''}>
                            ⭐ Weekly Staple — auto-include when building the list
                        </label>
                    </div>

                    ${!isNew ? `
                        <button class="grocery-modal-delete" id="groceryInvDelete">🗑 Remove from Pantry</button>` : ''}
                </div>
                <div class="grocery-modal-footer">
                    <button class="grocery-modal-save" id="groceryInvSave">
                        ${isNew ? 'Add to Pantry' : 'Save Changes'}
                    </button>
                    <button class="grocery-modal-cancel" id="groceryInvCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');

        const nameInput = overlay.querySelector('#groceryInvName');
        const catSelect = overlay.querySelector('#groceryInvCategory');
        nameInput?.addEventListener('input', () => {
            const cat = detectCategory(nameInput.value);
            if (catSelect && cat !== 'other') catSelect.value = cat;
        });

        overlay.querySelectorAll('.grocery-fulfillment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.grocery-fulfillment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Photo upload (addon version — async multipart POST)
        const photoArea  = overlay.querySelector('#groceryInvPhotoArea');
        const photoInput = overlay.querySelector('#groceryInvPhotoInput');
        photoArea?.addEventListener('click', e => {
            if (!e.target.closest('#groceryInvPhotoRemove')) photoInput?.click();
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
                console.error('[GroceryApp] Pantry photo upload failed:', err);
                this._editInvPhoto = null;
                this._updateInvPhotoPreview(overlay);
            }
        });
        overlay.querySelector('#groceryInvPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editInvPhoto = null; this._updateInvPhotoPreview(overlay);
        });

        const close = () => { overlay.classList.remove('active'); this._editInvItem = null; this._editInvPhoto = null; };
        overlay.querySelector('#groceryInvClose')?.addEventListener('click', close);
        overlay.querySelector('#groceryInvCancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#groceryInvSave')?.addEventListener('click', () => {
            const name = nameInput?.value.trim();
            if (!name) { nameInput?.focus(); return; }
            const fulfillmentActive = overlay.querySelector('.grocery-fulfillment-btn.active');
            const data = {
                name,
                defaultAmount:      overlay.querySelector('#groceryInvAmount')?.value.trim()   || '',
                defaultUnit:        overlay.querySelector('#groceryInvUnit')?.value.trim()      || '',
                category:           catSelect?.value || detectCategory(name),
                defaultFulfillment: fulfillmentActive?.dataset.ful || 'curbside',
                notes:              overlay.querySelector('#groceryInvNotes')?.value.trim()    || '',
                isStaple:           overlay.querySelector('#groceryInvStaple')?.checked ?? false,
                photo:              this._editInvPhoto || null,
                brand:              overlay.querySelector('#groceryInvBrand')?.value.trim()    || '',
                upc:                overlay.querySelector('#groceryInvUPC')?.value.trim()      || '',
                autoAddToList:      overlay.querySelector('#groceryInvAutoAdd')?.checked ?? false,
            };
            if (this._editInvItem) {
                this._updateInventoryItem(this._editInvItem.id, data);
            } else {
                this._addInventoryItem(data);
            }
            close();
        });

        overlay.querySelector('#groceryInvDelete')?.addEventListener('click', () => {
            if (this._editInvItem) { this._removeInventoryItem(this._editInvItem.id); close(); }
        });

        setTimeout(() => nameInput?.focus(), 50);
    }

    _updateInvPhotoPreview(overlay) {
        const area  = overlay.querySelector('#groceryInvPhotoArea');
        const input = overlay.querySelector('#groceryInvPhotoInput');
        if (!area) return;
        area.innerHTML = this._editInvPhoto
            ? `<img src="${this._editInvPhoto}" class="grocery-modal-photo-img" alt="Item photo">
               <div class="grocery-modal-photo-overlay">
                   <button class="grocery-photo-remove-btn" id="groceryInvPhotoRemove">🗑 Remove</button>
               </div>`
            : `<div class="grocery-modal-photo-placeholder">
                   <div style="font-size:28px">📷</div>
                   <div style="font-size:13px;color:var(--color-muted);margin-top:4px">Product photo (helps with brand ID)</div>
               </div>`;
        overlay.querySelector('#groceryInvPhotoRemove')?.addEventListener('click', e => {
            e.stopPropagation(); this._editInvPhoto = null; this._updateInvPhotoPreview(overlay);
        });
        if (input) area.appendChild(input);
    }

    // ── MEAL PLAN IMPORT ──────────────────────────────────────────────────────

    async _openMealPlanImport() {
        const overlay = document.getElementById('groceryMealPlanOverlay');
        if (!overlay) return;

        overlay.innerHTML = `
            <div class="grocery-modal" style="max-width:560px">
                <div class="grocery-modal-header">
                    <div class="grocery-modal-title">📅 Import from Meal Plan</div>
                    <button class="grocery-modal-close" id="groceryMPClose">×</button>
                </div>
                <div class="grocery-modal-body" id="groceryMPBody">
                    <div style="text-align:center;padding:40px;color:var(--color-muted)">
                        Loading this week's meal plan…
                    </div>
                </div>
                <div class="grocery-modal-footer" id="groceryMPFooter" style="display:none">
                    <button class="grocery-modal-save" id="groceryMPAdd">Add Selected Items</button>
                    <button class="grocery-modal-cancel" id="groceryMPCancel">Cancel</button>
                </div>
            </div>`;

        overlay.classList.add('active');
        overlay.querySelector('#groceryMPClose')?.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.querySelector('#groceryMPCancel')?.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('active'); });

        const mealStore   = window.mealPlanner?.store;
        const recipeStore = window.recipeApp?.store;
        if (!mealStore) {
            overlay.querySelector('#groceryMPBody').innerHTML =
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
            overlay.querySelector('#groceryMPBody').innerHTML = `
                <div class="grocery-empty" style="padding:40px 20px">
                    <div class="grocery-empty-icon">📅</div>
                    <div class="grocery-empty-title">No linked recipes found</div>
                    <div class="grocery-empty-text">
                        Link recipes to your meal plan slots to auto-populate ingredients.<br>
                        ${Object.keys(weekData).length === 0 ? 'Your meal plan for this week is also empty.' : ''}
                    </div>
                </div>`;
            return;
        }

        this._mpIngredients = allIngredients;
        const ingIndex = new Map(allIngredients.map((ing, i) => [ing.name.toLowerCase().trim(), i]));

        overlay.querySelector('#groceryMPBody').innerHTML = `
            <div class="grocery-mp-info">
                Found <strong>${allIngredients.length} ingredient${allIngredients.length !== 1 ? 's' : ''}</strong> across
                <strong>${recipeGroups.length} recipe${recipeGroups.length !== 1 ? 's' : ''}</strong>
                for ${formatWeekRange(dates)}.
            </div>
            <div class="grocery-mp-controls">
                <button class="grocery-mp-toggle-all" id="groceryMPSelectAll">☑ Select all</button>
                <button class="grocery-mp-toggle-all" id="groceryMPDeselectAll">☐ Deselect all</button>
            </div>
            <div class="grocery-mp-list">
                ${recipeGroups.map(group => `
                    <div class="grocery-mp-recipe-group">
                        <div class="grocery-mp-recipe-header">
                            ${group.photo
                                ? `<img src="${group.photo}" class="grocery-mp-recipe-photo" alt="">`
                                : `<span class="grocery-mp-recipe-photo-placeholder">🍽️</span>`}
                            <div class="grocery-mp-recipe-meta">
                                <div class="grocery-mp-recipe-name">${this._esc(group.recipeName)}</div>
                                <div class="grocery-mp-recipe-day">${this._esc(group.dayLabel)} · ${group.ingredients.length} ingredient${group.ingredients.length !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        ${group.ingredients.map(key => {
                            const ing = ingredientMap.get(key);
                            const idx = ingIndex.get(key);
                            const cat = catOf(ing.category);
                            const amountStr = [ing.amount, ing.unit].filter(Boolean).join(' ');
                            return `
                                <label class="grocery-mp-row${ing.alreadyOnList ? ' already' : ''}">
                                    <input type="checkbox" class="grocery-mp-check" data-idx="${idx}"
                                           ${ing.selected && !ing.alreadyOnList ? 'checked' : ''}
                                           ${ing.alreadyOnList ? 'disabled' : ''}>
                                    <span class="grocery-mp-row-check"></span>
                                    <span class="grocery-mp-row-cat" style="background:${cat.color}20;color:${cat.color}">${cat.emoji}</span>
                                    <span class="grocery-mp-row-name">${this._esc(ing.name)}</span>
                                    <span class="grocery-mp-row-right">
                                        ${amountStr ? `<span class="grocery-mp-row-amount">${this._esc(amountStr)}</span>` : ''}
                                        ${ing.alreadyOnList ? `<span class="grocery-mp-row-already">✓ on list</span>` : ''}
                                    </span>
                                </label>`;
                        }).join('')}
                    </div>`).join('')}
            </div>`;

        overlay.querySelector('#groceryMPSelectAll')?.addEventListener('click', () => {
            overlay.querySelectorAll('.grocery-mp-check:not([disabled])').forEach(cb => cb.checked = true);
        });
        overlay.querySelector('#groceryMPDeselectAll')?.addEventListener('click', () => {
            overlay.querySelectorAll('.grocery-mp-check:not([disabled])').forEach(cb => cb.checked = false);
        });

        const footer = overlay.querySelector('#groceryMPFooter');
        footer.style.display = '';
        overlay.querySelector('#groceryMPAdd')?.addEventListener('click', () => {
            const checks = overlay.querySelectorAll('.grocery-mp-check:not([disabled])');
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

    _addItem(data) {
        const item = {
            id:          genId('g'),
            name:        data.name,
            category:    data.category || detectCategory(data.name),
            amount:      data.amount   || '',
            unit:        data.unit     || '',
            notes:       data.notes    || '',
            photo:       data.photo    || null,
            fulfillment: data.fulfillment || 'curbside',
            checked:     false,
            source:      data.source   || 'manual',
            addedBy:     data.addedBy  || null,
            inventoryRef: data.inventoryRef || null,
            addedAt:     new Date().toISOString(),
        };
        this._items.push(item);
        this._persist();
        this._render();
    }

    _updateItem(id, changes) {
        const idx = this._items.findIndex(i => i.id === id);
        if (idx < 0) return;
        this._items[idx] = { ...this._items[idx], ...changes };
        this._persist();
        this._render();
    }

    _toggleItem(id) {
        const item = this._items.find(i => i.id === id);
        if (!item) return;
        item.checked = !item.checked;
        this._persist();
        this._render();
    }

    _removeItem(id) {
        this._items = this._items.filter(i => i.id !== id);
        this._persist();
        this._render();
    }

    _clearChecked() {
        this._items = this._items.filter(i => !i.checked);
        this._persist();
        this._render();
    }

    _addStaples() {
        const staples = this._inventory.filter(i => i.isStaple);
        if (staples.length === 0) {
            alert('No staples set yet. Mark items as ⭐ Staples in the Pantry tab first.');
            return;
        }
        let added = 0;
        staples.forEach(inv => {
            const alreadyOn = this._items.some(i => !i.checked && i.name.toLowerCase() === inv.name.toLowerCase());
            if (!alreadyOn) { this._addFromInventory(inv); added++; }
        });
        if (added === 0) alert('All your staples are already on the list!');
    }

    // ── INVENTORY CRUD ────────────────────────────────────────────────────────

    _addFromInventory(inv) {
        const alreadyOn = this._items.some(i => !i.checked && i.name.toLowerCase() === inv.name.toLowerCase());
        if (alreadyOn) return;
        this._addItem({
            name:         inv.name,
            amount:       inv.defaultAmount || '',
            unit:         inv.defaultUnit   || '',
            category:     inv.category,
            fulfillment:  inv.defaultFulfillment || 'curbside',
            notes:        inv.notes || '',
            photo:        inv.photo || null,
            source:       'inventory',
            inventoryRef: inv.id,
        });
        this._updateInventoryItem(inv.id, { useCount: (inv.useCount || 0) + 1, lastAdded: new Date().toISOString() }, false);
    }

    _addInventoryItem(data) {
        const item = {
            id:                 genId('inv'),
            name:               data.name,
            category:           data.category || detectCategory(data.name),
            defaultAmount:      data.defaultAmount      || '',
            defaultUnit:        data.defaultUnit        || '',
            notes:              data.notes              || '',
            photo:              data.photo              || null,
            defaultFulfillment: data.defaultFulfillment || 'curbside',
            isStaple:           data.isStaple           || false,
            stockLevel:         data.stockLevel         || 'ok',
            brand:              data.brand              || '',
            upc:                data.upc                || '',
            autoAddToList:      data.autoAddToList      ?? false,
            useCount:           0,
            lastAdded:          null,
        };
        this._inventory.push(item);
        this._persistInventory();
        this._render();
    }

    _addInventoryItemFromListData(data) {
        const exists = this._inventory.some(i => i.name.toLowerCase() === data.name.toLowerCase());
        if (exists) return;
        this._addInventoryItem({
            name:               data.name,
            category:           data.category,
            defaultAmount:      data.amount,
            defaultUnit:        data.unit,
            notes:              data.notes,
            photo:              data.photo,
            defaultFulfillment: data.fulfillment,
        });
    }

    _updateInventoryItem(id, changes, rerender = true) {
        const idx = this._inventory.findIndex(i => i.id === id);
        if (idx < 0) return;
        this._inventory[idx] = { ...this._inventory[idx], ...changes };
        this._persistInventory();
        if (rerender) this._render();
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
        }
    }

    _openStatusPickerModal(inv) {
        const overlay = document.getElementById('groceryInvOverlay');
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="grocery-modal status-picker-modal" role="dialog">
                <div class="grocery-modal-header">
                    <div class="grocery-modal-title">📦 ${this._esc(inv.name)}</div>
                    <button class="grocery-modal-close" id="statusPickerClose">×</button>
                </div>
                <div class="grocery-modal-body" style="text-align:center;padding:32px 20px">
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
        const overlay = document.getElementById('groceryInvOverlay');
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="grocery-modal" role="dialog">
                <div class="grocery-modal-header">
                    <div class="grocery-modal-title">🛒 Not in Pantry</div>
                    <button class="grocery-modal-close" id="directListClose">×</button>
                </div>
                <div class="grocery-modal-body" style="text-align:center;padding:24px 20px">
                    ${product.imageUrl ? `<img src="${product.imageUrl}" style="width:72px;height:72px;object-fit:contain;border-radius:12px;margin-bottom:12px" alt="">` : '<div style="font-size:48px;margin-bottom:12px">📦</div>'}
                    <div style="font-size:16px;font-weight:600;margin-bottom:4px">${this._esc(product.name || 'Unknown item')}</div>
                    ${product.brand ? `<div style="font-size:13px;color:var(--color-muted);margin-bottom:16px">${this._esc(product.brand)}</div>` : '<div style="margin-bottom:16px"></div>'}
                    <div style="font-size:14px;color:var(--color-muted);margin-bottom:24px">This item isn't tracked in your pantry. What would you like to do?</div>
                    <div style="display:flex;flex-direction:column;gap:10px">
                        <button class="grocery-modal-save" id="dlAddList">🛒 Add to Shopping List</button>
                        <button class="grocery-action-btn primary" id="dlAddPantry">📦 Add to Pantry &amp; Shopping List</button>
                        <button class="grocery-modal-cancel" id="dlCancel">Cancel</button>
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

    _removeInventoryItem(id) {
        this._inventory = this._inventory.filter(i => i.id !== id);
        this._persistInventory();
        this._render();
    }

    // ── REQUESTS CRUD ─────────────────────────────────────────────────────────

    _submitRequest(data) {
        const req = {
            id:          genId('req'),
            name:        data.name,
            notes:       data.notes       || '',
            requestedBy: data.requestedBy || 'Family',
            addedAt:     new Date().toISOString(),
            status:      'pending',
        };
        this._requests.push(req);
        this._persist();
        this._render();
    }

    _approveRequest(reqId) {
        const req = this._requests.find(r => r.id === reqId);
        if (!req) return;
        this._addItem({
            name:    req.name,
            notes:   req.notes,
            source:  'request',
            addedBy: req.requestedBy,
        });
        req.status = 'added';
        this._persist();
        this._render();
    }

    _dismissRequest(reqId) {
        const req = this._requests.find(r => r.id === reqId);
        if (req) { req.status = 'dismissed'; this._persist(); this._render(); }
    }

    // ── Persist ───────────────────────────────────────────────────────────────

    async _persist() {
        this._setSyncStatus('saving');
        const result = await this.store.saveList(this._items, this._requests);
        this._setSyncStatus(result === 'saved' ? 'saved' : 'offline', 3000);
    }

    async _persistInventory() {
        await this.store.saveInventory(this._inventory);
    }

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
        const badge = document.getElementById('grocerySyncBadge');
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
