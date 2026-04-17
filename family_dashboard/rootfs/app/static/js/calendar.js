/**
 * calendar.js — HACalendar class plus event-modal helpers.
 *
 * Addon version: all HA API calls go through the Flask backend proxy.
 * No HA URL or access token in the frontend — the backend uses $SUPERVISOR_TOKEN.
 *
 * Calendar entity list is fetched from ./api/calendars on startup.
 * CALENDAR_CONFIG is populated dynamically from that list.
 *
 * Exports: HACalendar, closeEventModal, updateFilterCircles
 */
import { blendColorsLight } from './utils.js';
import { loadTheme } from './theme.js';
import { CALENDAR_CONFIG, getEffectiveCalendarColor, loadDefaultView, isCalendarHidden } from './settings.js';

// ── Auto-assign palette for dynamically discovered calendars ─────────────────
const _PALETTE = ['#3b82f6','#ec4899','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#84cc16','#f97316','#a855f7'];

function _entityToName(entityId) {
    return entityId.replace('calendar.', '').replace(/_/g, ' ')
        .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _entityToInitial(entityId) {
    const words = entityId.replace('calendar.', '').replace(/_/g, ' ').trim().split(/\s+/).filter(w => w.length > 1);
    return (words[0]?.[0] || '?').toUpperCase();
}

// ── Event modal ──────────────────────────────────────────────────────────────
export function showEventModal(eventInfo) {
    document.getElementById('modalIcon').textContent  = eventInfo.event.allDay ? '📅' : '⏰';
    document.getElementById('modalTitle').textContent = eventInfo.event.title;

    const calendarEntity = eventInfo.event.extendedProps.calendar;
    const calendars = eventInfo.event.extendedProps.calendars || [calendarEntity];
    if (calendars.length === 1) {
        const name = CALENDAR_CONFIG[calendars[0]]?.name
            || calendars[0].replace('calendar.', '').replace(/_/g, ' ')
                .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        document.getElementById('modalCalendar').textContent = `📅 ${name}`;
    } else {
        document.getElementById('modalCalendar').textContent =
            `📅 ${calendars.map(c => CALENDAR_CONFIG[c]?.name || c.replace('calendar.', '')).join(', ')}`;
    }

    const { start, end, allDay: isAllDay } = eventInfo.event;
    let dt = '';
    if (isAllDay) {
        const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dt = start.toLocaleDateString('en-US', opts);
        if (end) {
            const ed = new Date(end);
            ed.setDate(ed.getDate() - 1);
            if (ed.toDateString() !== start.toDateString()) dt += ' – ' + ed.toLocaleDateString('en-US', opts);
        }
    } else {
        dt = start.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        dt += ' at ' + start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        if (end) dt += ' – ' + end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }
    document.getElementById('modalDateTime').textContent  = dt;
    document.getElementById('modalTypeBadge').textContent = isAllDay ? 'All-day Event' : 'Timed Event';

    const desc = eventInfo.event.extendedProps.description;
    document.getElementById('modalDescriptionRow').style.display = desc ? 'flex' : 'none';
    if (desc) document.getElementById('modalDescription').textContent = desc;

    const loc = eventInfo.event.extendedProps.location;
    document.getElementById('modalLocationRow').style.display = loc ? 'flex' : 'none';
    if (loc) document.getElementById('modalLocation').textContent = loc;

    document.getElementById('eventModal').classList.add('active');
}

export function closeEventModal() {
    document.getElementById('eventModal').classList.remove('active');
}

// ── Filter circle updates ────────────────────────────────────────────────────
export function updateFilterCircles() {
    Object.keys(CALENDAR_CONFIG).forEach(entityId => {
        const pill = document.querySelector(`.filter-pill[data-calendar="${entityId}"]`);
        if (!pill) return;
        const color = getEffectiveCalendarColor(entityId);
        pill.style.setProperty('--pill-color', color);
        const dot = pill.querySelector('.filter-pill-dot');
        if (dot) dot.style.background = color;
    });
}

// ── Main calendar class ──────────────────────────────────────────────────────
export class HACalendar {
    constructor() {
        this.calendar    = null;
        this.events      = [];
        this.activeFilters = new Set();
        this._loadedStart = null;
        this._loadedEnd   = null;
        this._fetching    = false;
        this.init();
    }

    async init() {
        loadTheme();

        // Fetch calendar entity list from backend; populates CALENDAR_CONFIG
        await this._fetchCalendarList();

        this.initCalendar();
        await this.loadEventsFromHA();
        this.createFilterCircles();
        this.applyFilters();
        this.setupPopoverBackdrop();
        window.addEventListener('resize', () => this.handleResize());

        // After async setup completes, the container is visible — recalculate layout.
        // This fixes the "garbled" initial render when #view-calendar is still display:none.
        this.calendar.updateSize();
    }

    // ── Fetch calendar list from backend ──────────────────────────────────────

    async _fetchCalendarList() {
        try {
            const res = await fetch('./api/calendars');
            if (!res.ok) return;
            const list = await res.json(); // array of { entity_id, name } objects (or strings)

            // Populate CALENDAR_CONFIG for each discovered entity
            let idx = 0;
            for (const item of list) {
                const entityId = typeof item === 'string' ? item : item.entity_id;
                if (!entityId || CALENDAR_CONFIG[entityId]) { idx++; continue; }
                const paletteIdx = idx % _PALETTE.length;
                CALENDAR_CONFIG[entityId] = {
                    name:    (typeof item === 'object' && item.name) || _entityToName(entityId),
                    color:   _PALETTE[paletteIdx],
                    initial: _entityToInitial(entityId),
                };
                idx++;
            }
        } catch (err) {
            console.warn('[HACalendar] Failed to fetch calendar list:', err.message);
        }
    }

    // ── Popover backdrop ──────────────────────────────────────────────────────

    setupPopoverBackdrop() {
        const backdrop = document.getElementById('popoverBackdrop');
        const observer = new MutationObserver(() => {
            backdrop.classList.toggle('active', !!document.querySelector('.fc-popover'));
        });
        observer.observe(document.body, { childList: true, subtree: true });
        backdrop.addEventListener('click', () => { document.querySelector('.fc-popover')?.remove(); });
    }

    // ── Filter state ──────────────────────────────────────────────────────────

    saveFilterState() {
        const state = {};
        Object.keys(CALENDAR_CONFIG).forEach(id => { state[id] = this.activeFilters.has(id); });
        localStorage.setItem('calendarFilterState', JSON.stringify(state));
    }

    loadFilterState() {
        try { const s = localStorage.getItem('calendarFilterState'); return s ? JSON.parse(s) : null; }
        catch { return null; }
    }

    createFilterCircles() {
        const container = document.getElementById('calendarFilters');
        container.innerHTML = '';
        const savedState = this.loadFilterState();

        Object.keys(CALENDAR_CONFIG).forEach(entityId => {
            const config = CALENDAR_CONFIG[entityId];
            if (!config) return;
            if (isCalendarHidden(entityId)) return;
            const isActive = savedState ? savedState[entityId] !== false : true;

            const pill = document.createElement('div');
            pill.className = isActive ? 'filter-pill active' : 'filter-pill inactive';
            pill.dataset.calendar = entityId;
            pill.dataset.name = config.name;

            const color = getEffectiveCalendarColor(entityId);
            pill.style.setProperty('--pill-color', color);

            const dot = document.createElement('div');
            dot.className = 'filter-pill-dot';
            dot.style.background = color;
            if (config.image) {
                const img = document.createElement('img');
                img.src = config.image; img.alt = config.name;
                dot.appendChild(img);
            } else {
                dot.textContent = config.initial;
            }

            const label = document.createElement('span');
            label.className = 'filter-pill-name';
            label.textContent = config.name;

            pill.appendChild(dot);
            pill.appendChild(label);
            pill.addEventListener('click', () => this.toggleFilter(entityId, pill));
            container.appendChild(pill);
            if (isActive) this.activeFilters.add(entityId);
        });
    }

    toggleFilter(entityId, pill) {
        if (this.activeFilters.has(entityId)) {
            this.activeFilters.delete(entityId);
            pill.classList.replace('active', 'inactive');
        } else {
            this.activeFilters.add(entityId);
            pill.classList.replace('inactive', 'active');
        }
        this.applyFilters();
        this.saveFilterState();
    }

    applyFilters() {
        this.calendar.getEvents().forEach(event => {
            const allCals    = event.extendedProps.calendars || [event.extendedProps.calendar];
            const activeCals = allCals.filter(c => this.activeFilters.has(c));
            if (!activeCals.length) { event.setProp('display', 'none'); return; }
            event.setProp('display', 'auto');
            document.querySelectorAll(`[data-event-id="${event.id}"]`)
                .forEach(el => this._styleEventElement(el, event, activeCals));
        });
    }

    _styleEventElement(el, event, activeCals) {
        const colors = activeCals.map(cal => getEffectiveCalendarColor(cal)).filter(Boolean);
        if (!colors.length) return;

        const fcEvent = this.calendar.getEventById(event.id);
        if (fcEvent) {
            fcEvent.setProp('backgroundColor', blendColorsLight(colors));
            fcEvent.setProp('borderColor', 'transparent');
            fcEvent.setProp('textColor', '#1e293b');
        }

        const isTimegrid  = el.classList.contains('fc-timegrid-event');
        const isAllDayEl  = el.classList.contains('fc-daygrid-block-event') || (!isTimegrid && event.allDay);
        const showBar = isTimegrid || isAllDayEl;
        if (showBar) {
            el.querySelector('.cal-bar-container')?.remove();
            const barW   = isTimegrid ? 5 : 4;
            const totalW = colors.length * barW;
            const bar = document.createElement('span');
            bar.className = 'cal-bar-container';
            bar.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${totalW}px;display:flex;z-index:3;pointer-events:none;`;
            colors.forEach(c => { const s = document.createElement('span'); s.style.cssText = `flex:1;background:${c};`; bar.appendChild(s); });
            el.insertBefore(bar, el.firstChild);
            const main = el.querySelector('.fc-event-main');
            if (main) main.style.setProperty('padding-left', (totalW + (isTimegrid ? 7 : 5)) + 'px', 'important');
        }

        el.querySelectorAll('.fc-event-cal-badge').forEach((badge, i) => {
            if (colors[i]) badge.style.background = colors[i];
        });

        const dot = el.querySelector('.fc-daygrid-event-dot');
        if (dot) {
            if (colors.length === 1) {
                dot.style.borderColor = colors[0];
            } else {
                dot.style.cssText = 'border-color:transparent;width:auto;height:auto;display:flex;gap:2px;';
                dot.innerHTML = '';
                colors.forEach(c => { const d = document.createElement('span'); d.style.cssText = `width:7px;height:7px;border-radius:50%;background:${c};display:inline-block;`; dot.appendChild(d); });
            }
        }
    }

    calculateCalendarHeight() {
        const c = document.querySelector('.content');
        return c ? Math.max(400, c.offsetHeight - 20) : 600;
    }

    handleResize() { this.calendar?.setOption('height', this.calculateCalendarHeight()); }

    getScrollTime() {
        const h = Math.max(0, new Date().getHours() - 1);
        return `${String(h).padStart(2, '0')}:00:00`;
    }

    ensureEventsForView(dateInfo) {
        if (!this._loadedStart || !this._loadedEnd || this._fetching) return;
        if (dateInfo.start < this._loadedStart || dateInfo.end > this._loadedEnd) {
            const center   = new Date((dateInfo.start.getTime() + dateInfo.end.getTime()) / 2);
            const newStart = new Date(center.getFullYear(), center.getMonth() - 2, 1);
            const newEnd   = new Date(center.getFullYear(), center.getMonth() + 7, 0);
            this.loadEventsFromHA(newStart, newEnd);
        }
    }

    initCalendar() {
        const defaultView = loadDefaultView();
        this.calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
            initialView:  defaultView,
            firstDay:     0,
            height:       this.calculateCalendarHeight(),
            showNonCurrentDates: false,
            headerToolbar: { left: 'customNav', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
            customButtons: { customNav: { text: '', click() {} } },
            viewDidMount: () => this.renderCustomNav(),
            datesSet: (dateInfo) => { this.updateTodayButton(); this.ensureEventsForView(dateInfo); },
            dayMaxEvents:      true,
            nowIndicator:      true,
            scrollTime:        this.getScrollTime(),
            slotMinTime:       '00:00:00',
            slotMaxTime:       '24:00:00',
            slotDuration:      '00:30:00',
            slotLabelInterval: '01:00',
            slotLabelFormat:   { hour: 'numeric', minute: '2-digit', meridiem: 'uppercase', omitZeroMinute: true },
            expandRows:        false,
            eventTimeFormat:   { hour: 'numeric', minute: '2-digit', meridiem: 'short' },
            eventDidMount: (info) => this._onEventDidMount(info),
            eventClick:    (info) => showEventModal(info)
        });
        this.calendar.render();
    }

    _onEventDidMount(info) {
        info.el.setAttribute('data-event-id', info.event.id);
        const calendars   = info.event.extendedProps.calendars || [info.event.extendedProps.calendar];
        const isTimegrid  = info.el.classList.contains('fc-timegrid-event');
        const colors      = calendars.map(cal => getEffectiveCalendarColor(cal)).filter(Boolean);
        const primaryColor = colors[0];

        // Skylight-style "ALL DAY" label
        if (info.event.allDay && info.el.classList.contains('fc-daygrid-block-event')) {
            const titleEl = info.el.querySelector('.fc-event-title');
            if (titleEl && !info.el.querySelector('.fc-allday-label')) {
                const label = document.createElement('span');
                label.className = 'fc-allday-label';
                label.textContent = 'All Day';
                titleEl.parentNode.insertBefore(label, titleEl);
            }
        }

        // Left colour bar(s)
        const isAllDayBlock = info.event.allDay && info.el.classList.contains('fc-daygrid-block-event');
        const showBar = isTimegrid || isAllDayBlock;
        if (showBar) {
            info.el.querySelector('.cal-bar-container')?.remove();
            const barW   = isTimegrid ? 5 : 4;
            const totalW = colors.length * barW;
            const bar = document.createElement('span');
            bar.className = 'cal-bar-container';
            bar.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${totalW}px;display:flex;z-index:3;pointer-events:none;`;
            colors.forEach(c => { const s = document.createElement('span'); s.style.cssText = `flex:1;background:${c};`; bar.appendChild(s); });
            info.el.insertBefore(bar, info.el.firstChild);
            const main = info.el.querySelector('.fc-event-main');
            if (main) main.style.setProperty('padding-left', (totalW + (isTimegrid ? 7 : 5)) + 'px', 'important');
        }

        // Dot colours (month view)
        if (!info.event.allDay) {
            const dot = info.el.querySelector('.fc-daygrid-event-dot');
            if (dot) {
                if (colors.length === 1) {
                    dot.style.borderColor = primaryColor;
                } else {
                    dot.style.cssText = 'border-color:transparent;width:auto;height:auto;display:flex;gap:2px;';
                    dot.innerHTML = '';
                    colors.forEach(c => { const d = document.createElement('span'); d.style.cssText = `width:7px;height:7px;border-radius:50%;background:${c};display:inline-block;`; dot.appendChild(d); });
                }
            }
        }

        // Badge circles: timed (bottom-right) + all-day block (right, v-centred)
        if (isTimegrid || isAllDayBlock) {
            const badgeCals = calendars.slice(0, 3);
            const badges = badgeCals
                .map(cal => ({ initial: CALENDAR_CONFIG[cal]?.initial, color: getEffectiveCalendarColor(cal) }))
                .filter(b => b.initial && b.initial.length <= 2);

            if (badges.length) {
                const wrapper = document.createElement('span');
                wrapper.className = isAllDayBlock ? 'fc-event-cal-badge-allday' : 'fc-event-cal-badge-timed';
                badges.forEach(b => {
                    const circle = document.createElement('span');
                    circle.className = 'fc-event-cal-badge';
                    circle.textContent = b.initial;
                    circle.style.background = b.color;
                    wrapper.appendChild(circle);
                });
                info.el.appendChild(wrapper);
                if (isAllDayBlock) {
                    const main = info.el.querySelector('.fc-event-main');
                    if (main) main.style.setProperty('padding-right', (badges.length * 15 + 4) + 'px', 'important');
                }
            }
        }
    }

    async loadEventsFromHA(customStart = null, customEnd = null) {
        if (this._fetching) return;
        this._fetching = true;
        try {
            const now   = new Date();
            const start = customStart || new Date(now.getFullYear(), now.getMonth() - 2, 1);
            const end   = customEnd   || new Date(now.getFullYear(), now.getMonth() + 7, 0);
            this._loadedStart = start;
            this._loadedEnd   = end;

            const entityIds = Object.keys(CALENDAR_CONFIG).filter(id => !isCalendarHidden(id));
            const newEvents = [];
            for (const entityId of entityIds) {
                const events = await this._fetchCalendarEvents(entityId, start, end);
                newEvents.push(...events);
            }

            this.calendar.getEvents().forEach(e => e.remove());
            this.events = [];
            const merged = this._mergeDuplicateEvents(newEvents);
            merged.forEach(event => { this.calendar.addEvent(event); this.events.push(event); });
            this.applyFilters();
        } catch (error) {
            console.error('❌ Error loading events:', error);
            this.showError(`Failed to load events: ${error.message}`);
        } finally {
            this._fetching = false;
        }
    }

    _mergeDuplicateEvents(events) {
        const map = new Map();
        events.forEach(event => {
            const key = `${event.title.toLowerCase().trim()}_${new Date(event.start).getTime()}_${event.allDay}`;
            if (map.has(key)) {
                map.get(key).extendedProps.calendars.push(event.extendedProps.calendar);
            } else {
                map.set(key, { ...event, extendedProps: { ...event.extendedProps, calendars: [event.extendedProps.calendar] } });
            }
        });
        return Array.from(map.values()).map(event => {
            const allCals  = event.extendedProps.calendars;
            const allColors = allCals.map(c => getEffectiveCalendarColor(c)).filter(Boolean);
            event.backgroundColor = blendColorsLight(allColors);
            event.borderColor     = 'transparent';
            event.textColor       = '#1e293b';
            return event;
        });
    }

    async _fetchCalendarEvents(entityId, start, end) {
        const startStr = start.toISOString().split('T')[0] + 'T00:00:00';
        const endStr   = end.toISOString().split('T')[0]   + 'T23:59:59';
        const url = `./api/calendar/${encodeURIComponent(entityId)}?start=${startStr}&end=${endStr}`;

        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`[HACalendar] Failed to fetch events for ${entityId}: HTTP ${response.status}`);
            return [];
        }
        const haEvents = await response.json();
        return haEvents.map(event => ({
            id:    event.uid || `${entityId}-${Date.now()}-${Math.random()}`,
            title: event.summary || 'Untitled Event',
            start: event.start.dateTime || event.start.date,
            end:   event.end?.dateTime  || event.end?.date,
            allDay: !event.start.dateTime,
            extendedProps: { calendar: entityId, description: event.description, location: event.location }
        }));
    }

    showError(message) {
        document.getElementById('calendar').innerHTML =
            `<div style="padding:40px;text-align:center;">
                <h2 style="color:var(--color-muted);margin-bottom:16px;">⚠️ Calendar Error</h2>
                <p style="color:var(--color-muted);font-size:14px;">${message}</p>
                <p style="color:var(--color-muted);font-size:13px;margin-top:12px;">
                    Make sure your HA calendar entities are configured correctly in Home Assistant.
                </p>
             </div>`;
    }

    renderCustomNav() {
        const container = document.querySelector('.fc-customNav-button');
        if (!container) return;
        container.innerHTML = '';
        container.style.cssText = 'background:transparent!important;border:none!important;padding:0!important;';

        const toolbar = document.createElement('div');
        toolbar.className = 'custom-nav-toolbar';

        const prev = document.createElement('button');
        prev.className = 'custom-nav-btn arrow';
        prev.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"></polyline></svg>';
        prev.onclick = () => this.calendar.prev();

        const today = document.createElement('button');
        today.className = 'custom-nav-btn today';
        today.id        = 'customTodayBtn';
        today.textContent = 'Today';
        today.onclick   = () => this.calendar.today();

        const next = document.createElement('button');
        next.className = 'custom-nav-btn arrow';
        next.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        next.onclick = () => this.calendar.next();

        toolbar.append(prev, today, next);
        container.appendChild(toolbar);
        this.updateTodayButton();
    }

    updateTodayButton() {
        const btn = document.getElementById('customTodayBtn');
        if (!btn) return;
        const now = new Date();
        btn.disabled = now >= new Date(this.calendar.view.activeStart) &&
                       now <  new Date(this.calendar.view.activeEnd);
    }
}
