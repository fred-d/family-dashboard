/**
 * settings.js — Settings modal: calendar colours, default view, open/close.
 *
 * Addon version: CALENDAR_CONFIG starts empty and is populated at runtime by
 * HACalendar._fetchCalendarList() which calls ./api/calendars (backend proxy).
 * No HA credentials or hardcoded entity IDs in this file.
 *
 * Exports: openSettings, closeSettings, loadCalendarColors,
 *          initializeCalendarColorsList, toggleCalendarColorMode,
 *          updateCalendarColor, updateCalendarColorFromText, resetCalendarColor,
 *          getEffectiveCalendarColor, calendarColorMode, customCalendarColors,
 *          CALENDAR_CONFIG, loadDefaultView, saveDefaultView
 */
import { currentTheme } from './theme.js';

// ── Calendar entity config ───────────────────────────────────────────────────
// Starts empty — populated by HACalendar._fetchCalendarList() on startup.
// Mutated in-place so all imports see the same live object.
export let CALENDAR_CONFIG = {};

export let calendarColorMode = 'theme';
export const customCalendarColors = {};

// ── Hidden calendars ──────────────────────────────────────────────────────────
// Calendars in this set are excluded from filter pills and event fetching.
const _hiddenCalendars = new Set(
    JSON.parse(localStorage.getItem('hiddenCalendars') || '[]')
);

export function isCalendarHidden(entityId) {
    return _hiddenCalendars.has(entityId);
}

export function toggleCalendarVisibility(entityId) {
    if (_hiddenCalendars.has(entityId)) {
        _hiddenCalendars.delete(entityId);
    } else {
        _hiddenCalendars.add(entityId);
    }
    localStorage.setItem('hiddenCalendars', JSON.stringify([..._hiddenCalendars]));
    initializeCalendarColorsList();
    if (window.haCalendar) {
        window.haCalendar.createFilterCircles();
        window.haCalendar.loadEventsFromHA();
    }
}

// ── Open / close ─────────────────────────────────────────────────────────────
export function openSettings() {
    document.getElementById('settingsOverlay').classList.add('active');
    initializeCalendarColorsList();
    _loadDefaultViewToSelect();
}

export function closeSettings() {
    document.getElementById('settingsOverlay').classList.remove('active');
}

// ── Default view setting ─────────────────────────────────────────────────────
export function saveDefaultView() {
    localStorage.setItem('defaultCalendarView', document.getElementById('defaultViewSetting').value);
}

export function loadDefaultView() {
    return localStorage.getItem('defaultCalendarView') || 'dayGridMonth';
}

function _loadDefaultViewToSelect() {
    const saved = localStorage.getItem('defaultCalendarView');
    if (saved) {
        const s = document.getElementById('defaultViewSetting');
        if (s) s.value = saved;
    }
}

// ── Calendar colour helpers ───────────────────────────────────────────────────
export function getEffectiveCalendarColor(entityId, isDark = false) {
    // 1. Custom user-set colour takes priority
    if (calendarColorMode === 'custom' && customCalendarColors[entityId])
        return isDark ? customCalendarColors[entityId + '_dark'] : customCalendarColors[entityId];

    // 2. Active theme's calendar-specific colour
    if (currentTheme.calendarColors?.[entityId])
        return currentTheme.calendarColors[entityId];

    // 3. Default from CALENDAR_CONFIG (palette colour assigned at fetch time)
    const config = CALENDAR_CONFIG[entityId];
    if (config) return isDark ? config.colorDark : config.color;

    // 4. Theme primary/secondary as final fallback
    const root = document.documentElement;
    return isDark
        ? getComputedStyle(root).getPropertyValue('--theme-secondary').trim()
        : getComputedStyle(root).getPropertyValue('--theme-primary').trim();
}

export function loadCalendarColors() {
    const saved = localStorage.getItem('calendarColorMode');
    if (saved) {
        calendarColorMode = saved;
        const r = document.querySelector(`input[name="calendarColorMode"][value="${saved}"]`);
        if (r) r.checked = true;
    }
    const savedColors = localStorage.getItem('customCalendarColors');
    if (savedColors) Object.assign(customCalendarColors, JSON.parse(savedColors));
    toggleCalendarColorMode();
    initializeCalendarColorsList();
}

export function initializeCalendarColorsList() {
    const container = document.getElementById('calendarColorsList');
    if (!container) return;
    container.innerHTML = '';

    const entries = Object.entries(CALENDAR_CONFIG);
    if (entries.length === 0) {
        container.innerHTML = '<p style="color:var(--color-muted);font-size:13px;padding:8px 0;">Calendar colours will appear here after the calendar loads.</p>';
        return;
    }

    entries.forEach(([entityId, config]) => {
        const cc      = customCalendarColors[entityId]           || config.color;
        const cd      = customCalendarColors[entityId + '_dark'] || config.colorDark;
        const hidden  = isCalendarHidden(entityId);
        const item    = document.createElement('div');
        item.className = `calendar-color-item${hidden ? ' cal-hidden' : ''}`;
        item.innerHTML = `
            <button class="cal-vis-btn${hidden ? ' hidden' : ''}" onclick="toggleCalendarVisibility('${entityId}')"
                    title="${hidden ? 'Show this calendar' : 'Hide this calendar'}">
                ${hidden
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
                }
            </button>
            <div class="calendar-color-preview" style="background:linear-gradient(135deg,${cc} 0%,${cd} 100%);${hidden ? 'opacity:0.35;' : ''}">${config.initial}</div>
            <div class="calendar-color-info" style="${hidden ? 'opacity:0.45;' : ''}">
                <div class="calendar-color-name">${config.name}</div>
                <div class="calendar-color-entity">${entityId}</div>
            </div>
            <div class="calendar-color-inputs" style="${hidden ? 'opacity:0.35;pointer-events:none;' : ''}">
                <div class="calendar-color-picker-wrapper">
                    <input type="color" id="color_${entityId}" value="${cc}"
                           onchange="updateCalendarColor('${entityId}', this.value, document.getElementById('colorDark_${entityId}').value)">
                    <input type="text" id="colorText_${entityId}" value="${cc.toUpperCase()}" maxlength="7"
                           onchange="updateCalendarColorFromText('${entityId}', this.value, 'color_${entityId}')">
                </div>
                <div class="calendar-color-picker-wrapper">
                    <input type="color" id="colorDark_${entityId}" value="${cd}"
                           onchange="updateCalendarColor('${entityId}', document.getElementById('color_${entityId}').value, this.value)">
                    <input type="text" id="colorDarkText_${entityId}" value="${cd.toUpperCase()}" maxlength="7"
                           onchange="updateCalendarColorFromText('${entityId}', this.value, 'colorDark_${entityId}')">
                </div>
                <button class="calendar-color-reset" onclick="resetCalendarColor('${entityId}')">Reset</button>
            </div>`;
        container.appendChild(item);
    });
}

export function toggleCalendarColorMode() {
    const m = document.querySelector('input[name="calendarColorMode"]:checked');
    if (!m) return;
    calendarColorMode = m.value;
    localStorage.setItem('calendarColorMode', m.value);
    const cl = document.getElementById('calendarColorsList');
    if (cl) cl.classList.toggle('active', m.value === 'custom');
    if (window.haCalendar?.calendar) window.haCalendar.calendar.refetchEvents();
}

export function updateCalendarColor(entityId, color, colorDark) {
    customCalendarColors[entityId]           = color;
    customCalendarColors[entityId + '_dark'] = colorDark;
    localStorage.setItem('customCalendarColors', JSON.stringify(customCalendarColors));
    const p = document.querySelector(`#color_${entityId}`)
        ?.closest('.calendar-color-item')
        ?.querySelector('.calendar-color-preview');
    if (p) p.style.background = `linear-gradient(135deg,${color} 0%,${colorDark} 100%)`;
    document.getElementById(`colorText_${entityId}`).value     = color.toUpperCase();
    document.getElementById(`colorDarkText_${entityId}`).value = colorDark.toUpperCase();
    if (window.haCalendar?.calendar) { window.haCalendar.calendar.refetchEvents(); window.updateFilterCircles?.(); }
}

export function updateCalendarColorFromText(entityId, value, pickerId) {
    if (/^#[0-9A-F]{6}$/i.test(value)) {
        document.getElementById(pickerId).value = value;
        const isDark = pickerId.includes('Dark');
        isDark
            ? updateCalendarColor(entityId, document.getElementById('color_' + entityId).value, value)
            : updateCalendarColor(entityId, value, document.getElementById('colorDark_' + entityId).value);
    }
}

export function resetCalendarColor(entityId) {
    delete customCalendarColors[entityId];
    delete customCalendarColors[entityId + '_dark'];
    localStorage.setItem('customCalendarColors', JSON.stringify(customCalendarColors));
    const cfg = CALENDAR_CONFIG[entityId];
    if (!cfg) return;
    document.getElementById(`color_${entityId}`).value          = cfg.color;
    document.getElementById(`colorDark_${entityId}`).value      = cfg.colorDark;
    document.getElementById(`colorText_${entityId}`).value      = cfg.color.toUpperCase();
    document.getElementById(`colorDarkText_${entityId}`).value  = cfg.colorDark.toUpperCase();
    const p = document.querySelector(`#color_${entityId}`)
        ?.closest('.calendar-color-item')
        ?.querySelector('.calendar-color-preview');
    if (p) p.style.background = `linear-gradient(135deg,${cfg.color} 0%,${cfg.colorDark} 100%)`;
    if (window.haCalendar?.calendar) { window.haCalendar.calendar.refetchEvents(); window.updateFilterCircles?.(); }
}
