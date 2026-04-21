/**
 * scanner.js — UPC Barcode Scanner
 *
 * Lazy-loads html5-qrcode from CDN, opens a camera overlay modal,
 * and proxies UPC lookups through the backend to Open Food Facts.
 *
 * Usage:
 *   import { BarcodeScanner } from './scanner.js';
 *   const scanner = new BarcodeScanner();
 *   scanner.open('restock', result => { ... });
 *   // result = { mode, barcode, product: { found, name, brand, category, imageUrl, upc } }
 */

import { apiUrl } from './utils.js';

export class BarcodeScanner {
    constructor() {
        this._qr       = null;   // Html5Qrcode instance
        this._overlay  = null;   // DOM overlay element
        this._mode     = 'restock'; // 'restock' | 'mark_used'
        this._onResult = null;
        this._busy     = false;  // debounce after scan
    }

    /** Open the scanner modal. mode = 'restock' | 'mark_used' */
    async open(mode, onResult) {
        if (this._overlay) return; // already open
        this._mode     = mode;
        this._onResult = onResult;
        this._busy     = false;
        await this._loadLib();
        this._buildOverlay();
        await this._startCamera();
    }

    close() {
        this._stopCamera();
        this._overlay?.remove();
        this._overlay = null;
    }

    // ── Library loading ───────────────────────────────────────────────────────

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
        el.id        = 'scannerOverlay';
        el.className = 'scanner-overlay';
        el.innerHTML = `
            <div class="scanner-modal">
                <div class="scanner-header">
                    <div class="scanner-mode-tabs">
                        <button class="scanner-mode-tab${this._mode === 'restock'   ? ' active' : ''}" data-mode="restock">
                            📥 Restock
                        </button>
                        <button class="scanner-mode-tab${this._mode === 'mark_used' ? ' active' : ''}" data-mode="mark_used">
                            📤 Used / Empty
                        </button>
                    </div>
                    <button class="scanner-close" id="scannerClose" aria-label="Close scanner">✕</button>
                </div>

                <div class="scanner-camera-wrap">
                    <div id="scannerQr"></div>
                    <div class="scanner-corners">
                        <span class="sc-corner sc-tl"></span><span class="sc-corner sc-tr"></span>
                        <span class="sc-corner sc-bl"></span><span class="sc-corner sc-br"></span>
                    </div>
                    <div class="scanner-hint-text" id="scannerHint">Point camera at barcode</div>
                </div>

                <div class="scanner-result" id="scannerResult" hidden></div>
            </div>`;

        document.body.appendChild(el);
        this._overlay = el;

        // Close button
        el.querySelector('#scannerClose').addEventListener('click', () => this.close());

        // Mode tabs
        el.querySelectorAll('.scanner-mode-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._mode = btn.dataset.mode;
                el.querySelectorAll('.scanner-mode-tab').forEach(b => b.classList.toggle('active', b === btn));
            });
        });
    }

    // ── Camera ────────────────────────────────────────────────────────────────

    async _startCamera() {
        if (!window.Html5Qrcode) {
            this._showCameraFallback('Scanner library failed to load. Check your connection.');
            return;
        }
        const qr = new Html5Qrcode('scannerQr');
        this._qr = qr;
        try {
            await qr.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 260, height: 140 }, aspectRatio: 1.6 },
                (decoded) => this._onDetected(decoded)
            );
        } catch (err) {
            console.warn('[Scanner] Camera error:', err);
            this._qr = null;
            // Camera needs HTTPS — show fallback with manual entry + file scan
            this._showCameraFallback();
        }
    }

    /** Show manual barcode entry + scan-from-photo fallback when camera is unavailable. */
    _showCameraFallback(msg = null) {
        // Replace the black camera box with a friendly explanation
        const wrap = this._overlay?.querySelector('.scanner-camera-wrap');
        if (wrap) {
            wrap.innerHTML = `
                <div class="scanner-no-camera">
                    <div class="scanner-no-camera-icon">📷</div>
                    <div class="scanner-no-camera-msg">
                        ${msg ?? 'Live camera requires HTTPS.<br>Use one of the options below:'}
                    </div>
                </div>`;
        }

        this._showResult(`
            <div class="scanner-fallback">
                <div class="scanner-fallback-section">
                    <div class="scanner-fallback-label">Type or paste a barcode number</div>
                    <div class="scanner-manual-row">
                        <input id="scannerBarcodeInput" class="scanner-input"
                               type="text" inputmode="numeric" pattern="[0-9]*"
                               placeholder="e.g. 048500202548" autocomplete="off" maxlength="14">
                        <button class="scanner-btn primary" id="scannerManualLookup">Look Up</button>
                    </div>
                </div>

                <div class="scanner-fallback-divider"><span>or</span></div>

                <div class="scanner-fallback-section">
                    <div class="scanner-fallback-label">Take or upload a photo of the barcode</div>
                    <label class="scanner-file-label" id="scannerFileLabel">
                        📸 Choose Photo / Take Picture
                        <input type="file" id="scannerFileInput" accept="image/*" capture="environment" style="display:none">
                    </label>
                </div>
            </div>`);

        // Manual barcode lookup
        const doManualLookup = () => {
            const barcode = this._overlay?.querySelector('#scannerBarcodeInput')?.value.trim();
            if (barcode && /^\d{6,14}$/.test(barcode)) {
                this._busy = false;
                this._onDetected(barcode);
            } else {
                this._overlay?.querySelector('#scannerBarcodeInput')?.focus();
            }
        };
        this._overlay?.querySelector('#scannerManualLookup')?.addEventListener('click', doManualLookup);
        this._overlay?.querySelector('#scannerBarcodeInput')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') doManualLookup();
        });

        // File / photo scan
        const fileInput = this._overlay?.querySelector('#scannerFileInput');
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            fileInput.value = '';
            if (!file) return;

            this._showResult(`
                <div class="scanner-lookup">
                    <div class="scanner-spinner"></div>
                    <div class="scanner-lookup-text">Scanning image for barcode…</div>
                </div>`);

            try {
                const reader = new Html5Qrcode('scannerQr');
                const decoded = await reader.scanFile(file, /* showImage */ false);
                reader.clear();
                this._busy = false;
                await this._onDetected(decoded);
            } catch (err) {
                console.warn('[Scanner] File scan failed:', err);
                this._showResult(`
                    <div class="scanner-error">
                        <div class="scanner-error-msg">No barcode found in image.<br>Try a clearer, closer photo or enter manually.</div>
                        <button class="scanner-btn secondary" id="scannerRetryFile">Try Again</button>
                    </div>`);
                this._overlay?.querySelector('#scannerRetryFile')
                    ?.addEventListener('click', () => this._showCameraFallback());
            }
        });
    }

    _stopCamera() {
        if (this._qr) {
            this._qr.stop().catch(() => {});
            this._qr = null;
        }
    }

    // ── Scan handler ──────────────────────────────────────────────────────────

    async _onDetected(barcode) {
        if (this._busy) return;
        this._busy = true;
        this._stopCamera();

        // Haptic feedback on mobile
        if (navigator.vibrate) navigator.vibrate(60);

        // Show lookup spinner
        this._showResult(`
            <div class="scanner-lookup">
                <div class="scanner-spinner"></div>
                <div class="scanner-lookup-text">Looking up <code>${barcode}</code>…</div>
            </div>`);

        let product = { found: false };
        try {
            const r = await fetch(apiUrl(`/api/inventory/scan/${encodeURIComponent(barcode)}`));
            const data = await r.json();
            // Normalize the cascading-scan response shape to what the
            // confirm-modal expects (flat fields with camelCase imageUrl).
            const p = data.product || {};
            product = {
                found:    !!data.found,
                source:   data.source,        // 'local' | 'off' | 'obf' | 'opff' | 'opf' | 'upcitemdb'
                tried:    data.tried,         // populated when no tier matched
                name:     p.name  || '',
                brand:    p.brand || '',
                imageUrl: p.image_url || '',
                category: p.category_id || '',
            };
        } catch (err) {
            console.warn('[Scanner] Lookup failed:', err);
        }
        product.upc = barcode;

        this._showProductConfirm(product);
    }

    _showProductConfirm(product) {
        const modeLabel  = this._mode === 'restock' ? 'Add to Pantry / Restock' : 'Mark as Used';
        const actionText = this._mode === 'restock' ? '✅ Confirm Restock' : '📤 Set Status';

        this._showResult(`
            <div class="scanner-product">
                <div class="scanner-product-media">
                    ${product.imageUrl
                        ? `<img src="${product.imageUrl}" class="scanner-product-img" alt="">`
                        : `<div class="scanner-product-placeholder">📦</div>`}
                </div>
                <div class="scanner-product-info">
                    ${product.found
                        ? `<div class="scanner-product-name">${this._esc(product.name || 'Unknown Product')}</div>
                           ${product.brand ? `<div class="scanner-product-brand">${this._esc(product.brand)}</div>` : ''}`
                        : `<div class="scanner-product-name scanner-not-found">Product not in database</div>
                           <div class="scanner-product-brand">Barcode: ${product.upc}</div>`
                    }
                </div>
            </div>

            ${!product.found ? `
                <div class="scanner-manual-entry">
                    <input id="scannerManualName" class="scanner-input"
                           type="text" placeholder="Enter item name…" autocomplete="off">
                </div>` : ''}

            <div class="scanner-actions">
                <button class="scanner-btn primary" id="scannerConfirm">${actionText}</button>
                <button class="scanner-btn secondary" id="scannerRescan">🔄 Scan Again</button>
            </div>`);

        this._overlay?.querySelector('#scannerConfirm')?.addEventListener('click', () => {
            if (!product.found) {
                const manual = this._overlay?.querySelector('#scannerManualName')?.value.trim();
                if (!manual) { this._overlay?.querySelector('#scannerManualName')?.focus(); return; }
                product = { ...product, name: manual, found: true };
            }
            this._onResult?.({ mode: this._mode, barcode: product.upc, product });
            this.close();
        });

        this._overlay?.querySelector('#scannerRescan')?.addEventListener('click', () => {
            this._busy = false;
            // If camera was working, restart it; otherwise go back to fallback
            if (this._qr) {
                this._hideResult();
                this._startCamera();
            } else {
                this._showCameraFallback();
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _showResult(html) {
        const r = this._overlay?.querySelector('#scannerResult');
        if (!r) return;
        r.innerHTML = html;
        r.hidden = false;
    }

    _hideResult() {
        const r = this._overlay?.querySelector('#scannerResult');
        if (r) r.hidden = true;
    }

    _esc(s) {
        return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
}
