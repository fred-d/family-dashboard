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
function _hide()     { _overlay()?.classList.remove('visible'); }

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
    const usernameEl = document.getElementById('authUsernameInput');
    const passwordEl = document.getElementById('authPasswordInput');
    const errorEl    = document.getElementById('authError');
    const btn        = document.getElementById('authSubmitBtn');

    const username = usernameEl?.value.trim()  ?? '';
    const password = passwordEl?.value         ?? '';

    if (!username || !password) {
        if (errorEl) errorEl.textContent = 'Please enter your username and password.';
        return;
    }

    // Loading state
    if (btn)     { btn.disabled = true; btn.textContent = 'Signing in…'; }
    if (errorEl) { errorEl.textContent = ''; }

    try {
        const res  = await fetch(apiUrl('/api/auth/login'), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
            // Clear the password field before hiding — good hygiene
            if (passwordEl) passwordEl.value = '';
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
