/**
 * auth.js — Authentication gate for direct (non-ingress) access.
 *
 * On every page load this module calls /api/auth/status.
 *   • authenticated (session cookie or ingress) → overlay stays hidden, app loads normally.
 *   • not authenticated                         → overlay becomes visible, app is blocked.
 *
 * When accessed via HA ingress the status endpoint returns {authenticated:true}
 * immediately, so the overlay never flashes for ingress users.
 *
 * Exports:
 *   logout() — call from the settings panel "Sign Out" button.
 */

import { apiUrl } from './utils.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function _overlay()  { return document.getElementById('authOverlay'); }
function _show()     { _overlay()?.classList.add('visible'); }
function _hide() {
    _overlay()?.classList.remove('visible');
    // Signal app.js that it is safe to initialise (fires at most once per load
    // because app.js listens with { once: true }).
    window.dispatchEvent(new CustomEvent('app:authed'));
}

function _setUsername(name) {
    document.querySelectorAll('[data-auth-username]')
        .forEach(el => { el.textContent = name || '—'; });
}

// ── Auth check on load ────────────────────────────────────────────────────────

async function _checkAuthStatus() {
    try {
        const res  = await fetch(apiUrl('/api/auth/status'));
        const data = await res.json();
        if (data.authenticated) {
            _hide();
            _setUsername(data.username);
        } else {
            _show();
        }
    } catch {
        // If status check fails (server down, network issue) show login
        _show();
    }
}

// ── Login form submission ─────────────────────────────────────────────────────

async function _submitLogin() {
    const tokenEl   = document.getElementById('authTokenInput');
    const nameEl    = document.getElementById('authDisplayNameInput');
    const errorEl   = document.getElementById('authError');
    const btn       = document.getElementById('authSubmitBtn');

    const token       = tokenEl?.value.trim() ?? '';
    const displayName = nameEl?.value.trim()  ?? '';

    if (!token) {
        if (errorEl) errorEl.textContent = 'Please paste your Home Assistant access token.';
        return;
    }

    // Loading state
    if (btn)     { btn.disabled = true; btn.textContent = 'Signing in…'; }
    if (errorEl) { errorEl.textContent = ''; }

    try {
        const res  = await fetch(apiUrl('/api/auth/login'), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ token, displayName }),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
            if (tokenEl) tokenEl.value = '';   // clear token from DOM
            _hide();
            _setUsername(data.username);
        } else {
            if (errorEl) errorEl.textContent = data.error || 'Login failed. Please try again.';
        }
    } catch {
        if (errorEl) errorEl.textContent = 'Cannot reach the server. Check your connection.';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
}

// ── Public: logout ────────────────────────────────────────────────────────────

export async function logout() {
    try {
        await fetch(apiUrl('/api/auth/logout'), { method: 'POST' });
    } catch { /* ignore network errors on logout */ }
    _setUsername('');
    _show();
}

// ── Wire up DOM ───────────────────────────────────────────────────────────────

function _wire() {
    // Login form
    document.getElementById('authForm')
        ?.addEventListener('submit', (e) => { e.preventDefault(); _submitLogin(); });

    // Any element with data-auth-logout triggers logout
    document.querySelectorAll('[data-auth-logout]')
        .forEach(el => el.addEventListener('click', () => logout()));
}

// ── Init (runs as soon as the module loads — DOM is already parsed for modules) ──

_wire();
_checkAuthStatus();
