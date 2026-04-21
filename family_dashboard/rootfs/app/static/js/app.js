/**
 * app.js — Family Dashboard entry point.
 *
 * Responsibilities:
 *  - Hash-based view routing (#calendar, #meals, #recipes, #grocery)
 *  - Initialise HACalendar, MealPlanner, RecipeApp, GroceryApp
 *  - Wire up global UI (settings open/close, modal backdrop)
 *  - Expose module functions needed by inline HTML onclick attributes
 *
 * All data persistence is handled by the addon backend (/api/*).
 * No HA credentials are stored in the frontend — the backend uses
 * the Supervisor token for all HA communication.
 */
import { HACalendar, closeEventModal, updateFilterCircles } from './calendar.js';
import { MealPlanner } from './meals.js';
import { MealStore } from './meal-store.js';
import { RecipeApp } from './recipes.js';
import { RecipeStore } from './recipe-store.js';
import { GroceryApp } from './grocery.js';
import { GroceryStore } from './grocery-store.js';
import { InventoryApp } from './inventory.js';
import { InventoryStore } from './inventory-store.js';
import {
    openSettings, closeSettings,
    loadCalendarColors, saveDefaultView,
    toggleCalendarColorMode,
    updateCalendarColor, updateCalendarColorFromText, resetCalendarColor,
    toggleCalendarVisibility
} from './settings.js';
import {
    loadTheme, applyTheme,
    updateCustomPreview, syncColorInput, applyCustomTheme
} from './theme.js';

// ── Expose to global scope (used by inline HTML onclick="…") ─────────────────
Object.assign(window, {
    openSettings, closeSettings, saveDefaultView,
    toggleCalendarColorMode,
    updateCalendarColor, updateCalendarColorFromText, resetCalendarColor,
    toggleCalendarVisibility,
    updateCustomPreview, syncColorInput,
    applyTheme:       (name) => applyTheme(name, window.haCalendar, updateFilterCircles),
    applyCustomTheme: ()     => applyCustomTheme(window.haCalendar, updateFilterCircles, closeSettings),
    closeEventModal,
    updateFilterCircles,
    switchView,   // needed by mobile nav onclick="switchView('...')"
});

// ── View router ───────────────────────────────────────────────────────────────

const VIEWS = ['calendar', 'meals', 'recipes', 'grocery', 'inventory'];

const VIEW_TITLES = {
    calendar:  'Family Dashboard',
    meals:     'Meal Planner',
    recipes:   'Recipe Book',
    grocery:   'Shopping List',
    inventory: 'Kitchen Inventory',
};

function getActiveView() {
    const hash = location.hash.replace('#', '');
    return VIEWS.includes(hash) ? hash : 'calendar';
}

function switchView(view) {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.section === view);
    });
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.toggle('active', section.id === `view-${view}`);
    });
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    document.getElementById('headerTitle').textContent =
        VIEW_TITLES[view] || 'Family Dashboard';
    document.getElementById('calendarFilters').style.display =
        view === 'calendar' ? '' : 'none';

    if (window.mealPlanner) {
        if (view === 'meals') window.mealPlanner._loadAndRender();
        else { clearInterval(window.mealPlanner._pollTimer); window.mealPlanner._pollTimer = null; }
    }
    if (window.recipeApp  && view === 'recipes') window.recipeApp._loadAndRender();
    if (window.groceryApp && view === 'grocery') window.groceryApp._load();
    if (window.inventoryApp && view === 'inventory') window.inventoryStore?.refresh('items');

    if (view === 'calendar' && window.haCalendar?.calendar) {
        requestAnimationFrame(() => window.haCalendar.calendar.updateSize());
        setTimeout(() => window.haCalendar?.calendar?.updateSize(), 60);
    }

    location.hash = view;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
    // Apply saved theme before anything renders
    loadTheme();

    // Sidebar navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => { e.preventDefault(); switchView(link.dataset.section); });
    });

    // Modal dismissal
    document.addEventListener('click', e => {
        if (e.target.id === 'settingsOverlay') closeSettings();
        if (e.target.id === 'eventModal')      closeEventModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeSettings(); closeEventModal(); }
    });

    // Calendar (reads HA via backend proxy — no token in frontend)
    window.haCalendar = new HACalendar();
    // Defer loadCalendarColors until after FullCalendar has initialised
    setTimeout(() => loadCalendarColors(), 100);
    setTimeout(updateFilterCircles, 500);

    // Stores use backend API — no HA config needed in frontend
    const mealStore      = new MealStore();
    const recipeStore    = new RecipeStore();
    const groceryStore   = new GroceryStore();
    const inventoryStore = new InventoryStore();
    window.inventoryStore = inventoryStore;

    window.mealPlanner   = new MealPlanner(document.getElementById('view-meals'),    mealStore);
    window.recipeApp     = new RecipeApp(document.getElementById('view-recipes'),   recipeStore);
    window.groceryApp    = new GroceryApp(document.getElementById('view-grocery'),  groceryStore);
    window.inventoryApp  = new InventoryApp(document.getElementById('view-inventory'), inventoryStore);

    // Initial fetch — inventory store hydrates from localStorage, so UI is
    // already interactive; this just refreshes against the server.
    inventoryStore.load();

    // Initial route
    switchView(getActiveView());
    window.addEventListener('hashchange', () => switchView(getActiveView()));
}

// Wait for auth.js to confirm the user is authenticated before booting.
// { once: true } ensures init() only ever runs once per page load.
// auth.js dispatches 'app:authed' after a successful status check or login.
window.addEventListener('app:authed', init, { once: true });
