/**
 * family-picker.js — Avatar row component.
 *
 * Renders a horizontal row of family-member avatars plus a "Family" generic
 * chip at the end. Tapping a person makes them the *active person* for
 * attribution on subsequent consume/restock/shopping actions.
 *
 * The component is deliberately stateless about data — it subscribes to the
 * InventoryStore and re-renders when `family` or `activePerson` change.
 *
 * Usage:
 *   const picker = new FamilyPicker(store);
 *   containerEl.appendChild(picker.el);
 *
 * Styling:
 *   .fp-row                     outer flex container
 *   .fp-chip                    individual person chip (or Family)
 *   .fp-chip.active             selected chip (ring + lifted)
 *   .fp-chip.generic            the "Family" fallback chip
 *   .fp-avatar                  the circular avatar (photo or initials)
 *   .fp-dot.home                green presence dot
 *   .fp-name                    small label under the avatar
 *
 * Avatars:
 *   HA person entities with an entity_picture go through the backend
 *   /api/inventory/avatar proxy (already baked into `p.avatar` by the
 *   server). When no photo is available we fall back to hash-derived
 *   initials on a stable colour.
 */

import { apiUrl } from './utils.js';

// Pleasant, well-spaced palette — chosen to remain readable with white text.
const PALETTE = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e',
];

function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function colorFor(id) {
    return PALETTE[hashString(id || 'x') % PALETTE.length];
}

function initialsOf(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export class FamilyPicker {
    /**
     * @param {InventoryStore} store
     * @param {{ showGeneric?: boolean, compact?: boolean }} [opts]
     *   showGeneric — append a "Family" chip (default: true)
     *   compact     — smaller avatars, for inline use (default: false)
     */
    constructor(store, opts = {}) {
        this.store    = store;
        this.showGeneric = opts.showGeneric !== false;
        this.compact    = !!opts.compact;

        this.el = document.createElement('div');
        this.el.className = 'fp-row' + (this.compact ? ' fp-compact' : '');

        this.el.addEventListener('click', (e) => {
            const chip = e.target.closest('.fp-chip');
            if (!chip) return;
            const pid = chip.dataset.pid || null;
            this.store.setActivePerson(pid);
        });

        // Re-render on any relevant store event.
        this._off = [
            this.store.on('family',       () => this.render()),
            this.store.on('activePerson', () => this.render()),
        ];

        this.render();
    }

    destroy() {
        this._off.forEach(fn => fn && fn());
        this.el.remove();
    }

    render() {
        const people = this.store.family || [];
        const active = this.store.activePerson;

        const frag = document.createDocumentFragment();
        people.forEach(p => frag.appendChild(this._chip(p, active === p.id)));

        if (this.showGeneric) {
            frag.appendChild(this._genericChip(active == null));
        }

        this.el.replaceChildren(frag);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _chip(person, isActive) {
        const chip = document.createElement('button');
        chip.className = 'fp-chip' + (isActive ? ' active' : '');
        chip.dataset.pid = person.id;
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(isActive));
        chip.title = person.name || person.id;

        const avatar = document.createElement('div');
        avatar.className = 'fp-avatar';

        if (person.avatar) {
            const img = document.createElement('img');
            img.src = person.avatar.startsWith('http') ? person.avatar : apiUrl(person.avatar);
            img.alt = person.name || '';
            img.loading = 'lazy';
            img.onerror = () => {
                // Fall back to initials on load error.
                img.remove();
                this._paintInitials(avatar, person);
            };
            avatar.appendChild(img);
        } else {
            this._paintInitials(avatar, person);
        }

        // Presence dot — green when HA reports the person is home.
        if (person.state === 'home') {
            const dot = document.createElement('span');
            dot.className = 'fp-dot home';
            dot.title = 'Home';
            avatar.appendChild(dot);
        }

        const name = document.createElement('span');
        name.className = 'fp-name';
        name.textContent = (person.name || '').split(' ')[0] || person.id;

        chip.append(avatar, name);
        return chip;
    }

    _genericChip(isActive) {
        const chip = document.createElement('button');
        chip.className = 'fp-chip generic' + (isActive ? ' active' : '');
        chip.type = 'button';
        // No dataset.pid → clicking clears the active person.
        chip.setAttribute('aria-pressed', String(isActive));
        chip.title = 'Family (no attribution)';

        const avatar = document.createElement('div');
        avatar.className = 'fp-avatar fp-generic-avatar';
        avatar.textContent = '👪';

        const name = document.createElement('span');
        name.className = 'fp-name';
        name.textContent = 'Family';

        chip.append(avatar, name);
        return chip;
    }

    _paintInitials(avatarEl, person) {
        avatarEl.style.background = colorFor(person.id || person.name || 'x');
        avatarEl.style.color      = '#fff';
        avatarEl.textContent      = initialsOf(person.name || person.id);
    }
}
