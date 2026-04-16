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
        const cc = customCalendarColors[entityId]           || config.color;
        const cd = customCalendarColors[entityId + '_dark'] || config.colorDark;
        const item = document.createElement('div');
        item.className = 'calendar-color-item';
        item.innerHTML = `
            <div class="calendar-color-preview" style="background:linear-gradient(135deg,${cc} 0%,${cd} 100%);">${config.initial}</div>
            <div class="calendar-color-info">
                <div class="calendar-color-name">${config.name}</div>
                <div class="calendar-color-entity">${entityId}</div>
            </div>
            <div class="calendar-color-inputs">
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
