/**
 * bulk-scanner.js — Rapid catalog-building scanner.
 *
 * Unlike BarcodeScanner (which is one-shot: scan → confirm → close), this
 * scanner stays open for as long as you want and auto-persists every scan
 * to the catalog. Designed for "stand in the pantry, beep every can"
 * sessions where you want to populate the catalog fast.
 *
 * Flow:
 *   open() →
 *     camera detects barcode →
 *     POST /api/pantry/scan/quick-add →
 *     play feedback (sound + haptic + animated card) →
 *     restart camera in ~600ms →
 *     repeat
 *
 *   For "not_found" results, a quick name-prompt slides in over the
 *   camera. User can type a name + tap Add (auto-creates with that name)
 *   or tap Skip (camera resumes immediately). Camera never has to be
 *   reopened mid-session.
 */

import { apiUrl } from './utils.js';

const COOLDOWN_MS = 700;   // pause after each scan before camera restarts

export class BulkScanner {
    constructor() {
        this._qr      = null;
        this._overlay = null;
        this._busy    = false;
        this._audio   = null;
        this._results = [];           // { status, barcode, product, ts }
        this._counts  = { added: 0, dup: 0, missed: 0 };
        this._onClose = null;
        this._lastBarcode = null;     // dedup: same code shown twice in a row
    }

    /** Open the bulk scanner. onClose(results) fires when the user taps Done. */
    async open(onClose) {
        if (this._overlay) return;
        this._onClose = onClose;
        this._results = [];
        this._counts  = { added: 0, dup: 0, missed: 0 };
        this._lastBarcode = null;
        await this._loadLib();
        this._buildOverlay();
        await this._startCamera();
    }

    close() {
        // Fire close exactly once even if called twice (e.g. user double-taps).
        if (this._closing) return;
        this._closing = true;
        try { this._stopCamera(); } catch (_) { /* ignore */ }
        if (this._overlay) {
            try { this._overlay.remove(); } catch (_) { /* ignore */ }
            this._overlay = null;
        }
        const onClose = this._onClose;
        this._onClose = null;
        try { onClose?.(this._results, this._counts); } catch (_) { /* ignore */ }
        this._closing = false;
    }

    // ── Library loading (shared CDN with BarcodeScanner) ──────────────────────

    async _loadLib() {
        if (window.Html5Qrcode) return;
        await new Promise((resolve, reject) => {
            const s   = document.createElement('script');
            s.src     = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
            s.onload  = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    // ── DOM ───────────────────────────────────────────────────────────────────

    _buildOverlay() {
        const el = document.createElement('div');
        el.id        = 'bulkScannerOverlay';
        el.className = 'scanner-overlay bulk-scanner-overlay';
        el.innerHTML = `
            <div class="scanner-modal bulk-scanner-modal">
                <div class="scanner-header bulk-scanner-header">
                    <div class="bulk-scanner-title">
                        <span class="bulk-scanner-icon">📦</span>
                        <span>Bulk Catalog Scan</span>
                    </div>
                    <div class="bulk-scanner-stats" id="bulkStats">
                        <span class="bulk-stat bulk-stat-added">
                            <span class="bulk-stat-num" id="bulkAdded">0</span>
                            <span class="bulk-stat-label">added</span>
                        </span>
                        <span class="bulk-stat bulk-stat-dup">
                            <span class="bulk-stat-num" id="bulkDup">0</span>
                            <span class="bulk-stat-label">dup</span>
                        </span>
                        <span class="bulk-stat bulk-stat-missed">
                            <span class="bulk-stat-num" id="bulkMissed">0</span>
                            <span class="bulk-stat-label">miss</span>
                        </span>
                    </div>
                    <button class="scanner-close" id="bulkScannerClose" aria-label="Done">Done</button>
                </div>

                <div class="scanner-camera-wrap bulk-camera-wrap">
                    <div id="bulkScannerQr"></div>
                    <div class="scanner-corners">
                        <span class="sc-corner sc-tl"></span><span class="sc-corner sc-tr"></span>
                        <span class="sc-corner sc-bl"></span><span class="sc-corner sc-br"></span>
                    </div>
                    <div class="scanner-hint-text" id="bulkHint">Aim at any barcode — keep scanning!</div>

                    <!-- Flash overlay for visual scan feedback -->
                    <div class="bulk-flash" id="bulkFlash"></div>

                    <!-- Inline name-prompt for not-found UPCs -->
                    <div class="bulk-name-prompt" id="bulkNamePrompt" hidden>
                        <div class="bulk-name-prompt-card">
                            <div class="bulk-name-prompt-title">
                                ❓ Not in any database
                            </div>
                            <div class="bulk-name-prompt-sub">
                                Barcode: <code id="bulkNamePromptUpc"></code>
                            </div>
                            <input id="bulkNameInput" class="scanner-input"
                                   type="text" placeholder="Type the product name…"
                                   autocomplete="off">
                            <div class="bulk-name-prompt-actions">
                                <button class="scanner-btn secondary" id="bulkNameSkip">Skip</button>
                                <button class="scanner-btn primary"   id="bulkNameAdd">Add</button>
                            </div>
                        </div>
                    </div>

                    <!-- Manual barcode entry (fallback when camera unavailable) -->
                    <div class="bulk-manual-entry" id="bulkManualEntry" hidden>
                        <input id="bulkManualBarcode" class="scanner-input"
                               type="text" inputmode="numeric" placeholder="Type a UPC…"
                               autocomplete="off" maxlength="14">
                        <button class="scanner-btn primary" id="bulkManualGo">Look Up</button>
                    </div>
                </div>

                <!-- Stack of recently-added items (most recent first) -->
                <div class="bulk-stack" id="bulkStack">
                    <div class="bulk-stack-empty">
                        Scanned items will appear here.<br>
                        <small>Scan a UPC anywhere on the screen.</small>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(el);
        this._overlay = el;

        el.querySelector('#bulkScannerClose').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.close();
        });

        // Manual entry button + handler (in case camera is unavailable)
        const goManual = () => {
            const v = el.querySelector('#bulkManualBarcode')?.value.trim();
            if (v && /^\d{6,14}$/.test(v)) {
                el.querySelector('#bulkManualBarcode').value = '';
                this._handleScan(v);
            }
        };
        el.querySelector('#bulkManualGo')?.addEventListener('click', goManual);
        el.querySelector('#bulkManualBarcode')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') goManual();
        });

        // Name-prompt buttons
        el.querySelector('#bulkNameAdd')?.addEventListener('click',  () => this._submitManualName());
        el.querySelector('#bulkNameSkip')?.addEventListener('click', () => this._dismissNamePrompt());
        el.querySelector('#bulkNameInput')?.addEventListener('keydown', e => {
            if (e.key === 'Enter')  this._submitManualName();
            if (e.key === 'Escape') this._dismissNamePrompt();
        });
    }

    // ── Camera ────────────────────────────────────────────────────────────────

    async _startCamera() {
        if (!window.Html5Qrcode) {
            this._showManualFallback();
            return;
        }
        const qr = new Html5Qrcode('bulkScannerQr');
        this._qr = qr;
        try {
            await qr.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 280, height: 160 }, aspectRatio: 1.6 },
                (decoded) => this._handleScan(decoded),
            );
            this._setHint('Aim at any barcode — keep scanning!');
        } catch (err) {
            console.warn('[BulkScanner] Camera error:', err);
            this._qr = null;
            this._showManualFallback();
        }
    }

    _stopCamera() {
        // Detach the reference first so the call site treats us as stopped
        // even if the actual teardown is still resolving in the background.
        const qr = this._qr;
        this._qr = null;
        if (!qr) return;
        // Html5Qrcode.clear() throws synchronously if called while a scan
        // is still running — chain it AFTER stop() resolves, and catch
        // both async rejections and the (rare) sync throw from clear().
        qr.stop()
            .then(() => { try { qr.clear(); } catch (_) { /* ignore */ } })
            .catch(() => { /* already stopped or never started */ });
    }

    _showManualFallback() {
        const wrap = this._overlay?.querySelector('.bulk-camera-wrap');
        wrap?.classList.add('bulk-no-camera');
        const manual = this._overlay?.querySelector('#bulkManualEntry');
        if (manual) manual.hidden = false;
        this._setHint('Camera unavailable — type UPCs below.');
    }

    // ── Scan handler ──────────────────────────────────────────────────────────

    async _handleScan(barcode) {
        if (this._busy) return;
        // Same barcode in a row = dedupe (camera tends to re-fire)
        if (barcode === this._lastBarcode) return;
        this._busy = true;
        this._lastBarcode = barcode;
        this._stopCamera();
        this._flashScreen();
        this._setHint(`Looking up ${barcode}…`);

        try {
            const res = await fetch(apiUrl('/api/pantry/scan/quick-add'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ barcode }),
            });
            const data = await res.json();
            this._processResult(data);
        } catch (err) {
            console.warn('[BulkScanner] Quick-add failed:', err);
            this._processResult({ ok: false, status: 'error', barcode });
        }
    }

    _processResult(data) {
        const status  = data.status || (data.ok ? 'added' : 'error');
        const product = data.product || {};
        const barcode = data.barcode;

        // Counts + audio + haptic + card animation per status
        if (status === 'added') {
            this._counts.added++;
            this._beep('ok');
            navigator.vibrate?.(60);
            this._pushCard({ kind: 'added', barcode, product });
            this._setHint('✅ Added! Aim at the next one.');
            this._resumeAfterCooldown();
        } else if (status === 'already_in_catalog') {
            this._counts.dup++;
            this._beep('dup');
            navigator.vibrate?.([30, 40, 30]);
            this._pushCard({ kind: 'dup', barcode, product });
            this._setHint('↻ Already in catalog. Next!');
            this._resumeAfterCooldown();
        } else if (status === 'not_found') {
            this._counts.missed++;
            this._beep('miss');
            navigator.vibrate?.([80, 50, 80]);
            this._pushCard({ kind: 'missed', barcode, product: { name: 'Unknown', upc: barcode } });
            this._showNamePrompt(barcode);
            // Don't resume yet — wait for user to add or skip
        } else {
            this._setHint('⚠ Lookup error. Tap to retry.');
            this._resumeAfterCooldown();
        }

        this._renderCounts();
        this._results.push({ status, barcode, product, ts: Date.now() });
    }

    _resumeAfterCooldown() {
        setTimeout(() => {
            this._busy = false;
            this._lastBarcode = null;
            // Only restart if camera was working originally
            if (this._overlay && !this._overlay.querySelector('.bulk-camera-wrap')?.classList.contains('bulk-no-camera')) {
                this._startCamera();
            } else {
                this._setHint('Type a UPC or close to finish.');
            }
        }, COOLDOWN_MS);
    }

    // ── Name-prompt for not-found UPCs ────────────────────────────────────────

    _showNamePrompt(barcode) {
        const prompt = this._overlay?.querySelector('#bulkNamePrompt');
        const upc    = this._overlay?.querySelector('#bulkNamePromptUpc');
        const input  = this._overlay?.querySelector('#bulkNameInput');
        if (!prompt) return;
        prompt.hidden = false;
        if (upc)   upc.textContent = barcode;
        if (input) {
            input.value = '';
            setTimeout(() => input.focus(), 50);
        }
    }

    _dismissNamePrompt() {
        const prompt = this._overlay?.querySelector('#bulkNamePrompt');
        if (prompt) prompt.hidden = true;
        this._resumeAfterCooldown();
    }

    async _submitManualName() {
        const input   = this._overlay?.querySelector('#bulkNameInput');
        const upc     = this._overlay?.querySelector('#bulkNamePromptUpc')?.textContent;
        const name    = input?.value.trim();
        if (!name || !upc) return;

        const prompt = this._overlay?.querySelector('#bulkNamePrompt');
        if (prompt) prompt.hidden = true;

        try {
            const res = await fetch(apiUrl('/api/pantry/scan/quick-add'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ barcode: upc, name }),
            });
            const data = await res.json();
            if (data.ok && data.status === 'added') {
                // Replace the "missed" card with the actual added one + bump counts
                this._counts.missed = Math.max(0, this._counts.missed - 1);
                this._counts.added++;
                this._beep('ok');
                navigator.vibrate?.(60);
                this._removeMissedCard(upc);
                this._pushCard({ kind: 'added', barcode: upc, product: data.product });
                this._setHint('✅ Manually added!');
            }
        } catch (err) {
            console.warn('[BulkScanner] Manual add failed:', err);
        }
        this._renderCounts();
        this._resumeAfterCooldown();
    }

    // ── Stack rendering ───────────────────────────────────────────────────────

    _pushCard({ kind, barcode, product }) {
        const stack = this._overlay?.querySelector('#bulkStack');
        if (!stack) return;
        // Clear empty placeholder on first card
        const empty = stack.querySelector('.bulk-stack-empty');
        if (empty) empty.remove();

        const kindLabel = { added: 'Added', dup: 'Already in catalog', missed: 'Unknown' }[kind] || '';
        const kindIcon  = { added: '✅',    dup: '↻',                  missed: '❓'      }[kind] || '';

        const card = document.createElement('div');
        card.className = `bulk-card bulk-card-${kind}`;
        card.dataset.barcode = barcode;
        const img = product.image_url || product.image || '';
        card.innerHTML = `
            <div class="bulk-card-thumb">
                ${img
                    ? `<img src="${this._esc(img)}" alt="">`
                    : `<span class="bulk-card-emoji">📦</span>`}
            </div>
            <div class="bulk-card-body">
                <div class="bulk-card-name">${this._esc(product.name || 'Unknown')}</div>
                ${product.brand ? `<div class="bulk-card-brand">${this._esc(product.brand)}</div>` : ''}
                <div class="bulk-card-meta">${kindIcon} ${kindLabel} · ${this._esc(barcode)}</div>
            </div>`;
        // Newest on top
        stack.insertBefore(card, stack.firstChild);
        // Pulse animation
        requestAnimationFrame(() => card.classList.add('bulk-card-in'));
        // Trim very long stacks (>40 cards)
        const cards = stack.querySelectorAll('.bulk-card');
        if (cards.length > 40) cards[cards.length - 1].remove();
    }

    _removeMissedCard(barcode) {
        const stack = this._overlay?.querySelector('#bulkStack');
        const card  = stack?.querySelector(`.bulk-card-missed[data-barcode="${barcode}"]`);
        card?.remove();
    }

    _renderCounts() {
        const a = this._overlay?.querySelector('#bulkAdded');
        const d = this._overlay?.querySelector('#bulkDup');
        const m = this._overlay?.querySelector('#bulkMissed');
        if (a) { a.textContent = this._counts.added;  this._pulse(a); }
        if (d) { d.textContent = this._counts.dup;    this._pulse(d); }
        if (m) { m.textContent = this._counts.missed; this._pulse(m); }
    }

    _pulse(el) {
        el.classList.remove('bulk-stat-pulse');
        // Force reflow so the animation re-triggers
        // eslint-disable-next-line no-unused-expressions
        el.offsetWidth;
        el.classList.add('bulk-stat-pulse');
    }

    // ── Visual + audio feedback ───────────────────────────────────────────────

    _flashScreen() {
        const flash = this._overlay?.querySelector('#bulkFlash');
        if (!flash) return;
        flash.classList.remove('bulk-flash-active');
        // eslint-disable-next-line no-unused-expressions
        flash.offsetWidth;
        flash.classList.add('bulk-flash-active');
    }

    _setHint(text) {
        const hint = this._overlay?.querySelector('#bulkHint');
        if (hint) hint.textContent = text;
    }

    /**
     * Subtle audio feedback via Web Audio API. No external files required.
     * 'ok'   → bright high ding (newly added)
     * 'dup'  → mid double-blip (already in catalog)
     * 'miss' → low buzz (unknown UPC)
     */
    _beep(kind) {
        try {
            this._audio = this._audio || new (window.AudioContext || window.webkitAudioContext)();
            const ctx = this._audio;
            const now = ctx.currentTime;

            const tone = (freq, dur, delay = 0, type = 'sine') => {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type            = type;
                o.frequency.value = freq;
                g.gain.setValueAtTime(0.0001, now + delay);
                g.gain.exponentialRampToValueAtTime(0.18, now + delay + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
                o.connect(g).connect(ctx.destination);
                o.start(now + delay);
                o.stop(now + delay + dur + 0.02);
            };

            if (kind === 'ok')   { tone(880, 0.14); tone(1320, 0.14, 0.07); }
            if (kind === 'dup')  { tone(660, 0.08); tone(660, 0.08, 0.10); }
            if (kind === 'miss') { tone(220, 0.20, 0, 'square'); }
        } catch (_) { /* audio is purely decorative */ }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _esc(s) {
        return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
}
