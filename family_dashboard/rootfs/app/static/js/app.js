/**
 * app.js — Family Dashboard entry point.
 *
 * Responsibilities:
 *  - Hash-based view routing (#calendar, #meals, #recipes, #inventory)
 *  - Initialise HACalendar, MealPlanner, RecipeApp, InventoryApp
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
import { PantryApp } from './pantry.js?v=13';
import { PantryStore } from './pantry-store.js?v=13';
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

const VIEWS = ['calendar', 'meals', 'recipes', 'pantry'];

const VIEW_TITLES = {
    calendar: 'Family Dashboard',
    meals:    'Meal Planner',
    recipes:  'Recipe Book',
    pantry:   'Pantry',
};

function getActiveView() {
    const hash = location.hash.replace('#', '');
    // Sunset aliases: old #pantry / #inventory hashes → #pantry
    if (hash === 'pantry' || hash === 'inventory') return 'pantry';
    return VIEWS.includes(hash) ? hash : 'calendar';
}

function switchView(view) {
    // Sunset: redirect any legacy pantry / inventory callers to pantry
    if (view === 'pantry' || view === 'inventory') view = 'pantry';
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
    if (window.pantryApp && view === 'pantry') {
        // Re-fetch when the user switches to the Pantry tab so a pantry
        // change made on another device shows up immediately.
        window.pantryStore?.fetchList();
        window.pantryStore?.fetchInventory();
    }

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
    const mealStore     = new MealStore();
    const recipeStore   = new RecipeStore();
    const pantryStore   = new PantryStore();
    window.pantryStore  = pantryStore;

    window.mealPlanner = new MealPlanner(document.getElementById('view-meals'),    mealStore);
    window.recipeApp   = new RecipeApp(document.getElementById('view-recipes'),    recipeStore);
    window.pantryApp   = new PantryApp(document.getElementById('view-pantry'),     pantryStore);

    // Prime category↔id lookups before the first list render so backend
    // category UUIDs translate to the legacy pantry string ids the UI uses.
    // PantryApp also calls this internally — fire-and-forget here is safe.
    pantryStore.fetchConfig();

    // Initial route
    switchView(getActiveView());
    window.addEventListener('hashchange', () => switchView(getActiveView()));
}

// Wait for auth.js to confirm the user is authenticated before booting.
// auth.js dispatches 'app:authed' after a successful status check or login,
// AND sets window.__appAuthed = true. We check the flag on load in case the
// event already fired before this listener was attached (auth.js's import
// chain finishes before app.js's, so the race is real and was causing a
// blank UI on refresh).
let _booted = false;
function _bootOnce() {
    if (_booted) return;
    _booted = true;
    init();
}
window.addEventListener('app:authed', _bootOnce);
if (window.__appAuthed) _bootOnce();
