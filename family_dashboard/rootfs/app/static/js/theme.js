/**
 * theme.js — Theme definitions, loading, applying, and the custom-colour
 * builder in the settings panel.
 *
 * Addon version: calendarColors removed from theme definitions — each
 * calendar entity now gets its own colour from the dynamic palette assigned
 * in calendar.js. Users can override via the Custom Colors section in settings.
 *
 * Exports: THEMES, currentTheme (live ref), loadTheme, applyTheme,
 *          applyThemeColors, updateCustomPreview, syncColorInput, applyCustomTheme
 */

// ── Theme definitions ────────────────────────────────────────────────────────
export const THEMES = {
    default:      { primary: '#667eea', secondary: '#764ba2', accent: '#667eea', border: '#667eea', sidebarBorder: '#667eea', eventStyle: 'normal',           decoration: null  },
    christmas:    { primary: '#E50000', secondary: '#187F42', accent: '#E50000', border: '#E50000', sidebarBorder: '#187F42', eventStyle: 'festive-border',    decoration: '🎄' },
    halloween:    { primary: '#ff6b35', secondary: '#4a148c', accent: '#ff6b35', border: '#ff6b35', sidebarBorder: '#4a148c', eventStyle: 'spooky-glow',      decoration: '🎃' },
    thanksgiving: { primary: '#d2691e', secondary: '#8b4513', accent: '#d2691e', border: '#d2691e', sidebarBorder: '#8b4513', eventStyle: 'warm-tint',        decoration: '🍂' },
    valentines:   { primary: '#ff1744', secondary: '#f06292', accent: '#ff1744', border: '#ff1744', sidebarBorder: '#f06292', eventStyle: 'romantic-glow',    decoration: '💕' },
    easter:       { primary: '#ab47bc', secondary: '#66bb6a', accent: '#ab47bc', border: '#ab47bc', sidebarBorder: '#66bb6a', eventStyle: 'pastel-blend',     decoration: '🌸' },
    independence: { primary: '#dc143c', secondary: '#00247d', accent: '#dc143c', border: '#dc143c', sidebarBorder: '#00247d', eventStyle: 'patriotic-accent', decoration: '🎆' },
    newyear:      { primary: '#ffd700', secondary: '#000000', accent: '#ffd700', border: '#ffd700', sidebarBorder: '#000000', eventStyle: 'sparkle',           decoration: '✨' },
};

export let currentTheme = THEMES.default;

// ── Core apply ───────────────────────────────────────────────────────────────
export function applyThemeColors(colors) {
    const root = document.documentElement;
    root.style.setProperty('--theme-primary',        colors.primary);
    root.style.setProperty('--theme-secondary',      colors.secondary);
    root.style.setProperty('--theme-accent',         colors.accent);
    root.style.setProperty('--theme-border',         colors.border);
    root.style.setProperty('--theme-sidebar-border', colors.sidebarBorder);
    root.style.setProperty('--theme-header-bg',      colors.primary);
}

/** Load saved theme from localStorage and apply it. */
export function loadTheme() {
    const saved = localStorage.getItem('calendarTheme');
    if (!saved) return;
    const themeData = JSON.parse(saved);
    currentTheme = themeData.colors;
    applyThemeColors(themeData.colors);
    document.querySelectorAll('.theme-card').forEach(card => {
        card.classList.toggle('active', card.dataset.theme === themeData.name);
    });
}

/** Apply a named preset theme. */
export function applyTheme(themeName, haCalendar, updateFilterCircles) {
    const theme = THEMES[themeName];
    if (!theme) return;
    currentTheme = theme;
    applyThemeColors(theme);
    localStorage.setItem('calendarTheme', JSON.stringify({ name: themeName, colors: theme }));
    document.querySelectorAll('.theme-card').forEach(card => {
        card.classList.toggle('active', card.dataset.theme === themeName);
    });
    if (haCalendar?.calendar) {
        const events = haCalendar.calendar.getEvents();
        events.forEach(event => {
            const d = { id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay, extendedProps: event.extendedProps };
            event.remove();
            haCalendar.calendar.addEvent(d);
        });
        setTimeout(() => updateFilterCircles(), 50);
    }
}

// ── Custom theme builder ─────────────────────────────────────────────────────
export function updateCustomPreview() {
    const primary   = document.getElementById('customPrimary').value;
    const secondary = document.getElementById('customSecondary').value;
    document.getElementById('customPrimaryText').value   = primary;
    document.getElementById('customSecondaryText').value = secondary;
    const preview = document.getElementById('customPreview');
    preview.querySelector('.preview-header').style.setProperty('--preview-primary',   primary);
    preview.querySelector('.preview-header').style.setProperty('--preview-secondary', secondary);
    preview.querySelectorAll('.preview-block').forEach(b => b.style.setProperty('--preview-primary', primary));
}

export function syncColorInput(id, val) {
    if (/^#[0-9A-F]{6}$/i.test(val)) {
        document.getElementById(id).value = val;
        updateCustomPreview();
    }
}

export function applyCustomTheme(haCalendar, updateFilterCircles, closeSettings) {
    const primary   = document.getElementById('customPrimary').value;
    const secondary = document.getElementById('customSecondary').value;
    const customTheme = {
        primary, secondary, accent: primary, border: primary, sidebarBorder: secondary,
        eventStyle: 'normal', decoration: null,
        calendarColors: {}  // No hardcoded entities — custom calendar colours are in customCalendarColors
    };
    currentTheme = customTheme;
    applyThemeColors(customTheme);
    localStorage.setItem('calendarTheme', JSON.stringify({ name: 'custom', colors: customTheme }));
    document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
    if (haCalendar?.calendar) { haCalendar.calendar.refetchEvents(); updateFilterCircles(); }
    closeSettings();
}
