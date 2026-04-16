/**
 * utils.js — Pure helper functions shared across modules.
 * No side-effects, no DOM access, no imports needed.
 */

/** Convert any colour string to rgba(...) */
export function colorToRgba(color, alpha) {
    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${alpha})`;
    if (color.startsWith('#')) {
        const hex = color.replace('#', '');
        const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
        const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
        const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
}

/**
 * Mix a colour with white to produce a solid pastel.
 * factor 0 = original colour, 1 = pure white.  0.82 gives a soft pastel.
 */
export function colorToLight(color, factor = 0.82) {
    const rgba = colorToRgba(color, 1);
    const m = rgba.match(/\d+/g);
    if (!m) return color;
    const r = Math.round(+m[0] + (255 - +m[0]) * factor);
    const g = Math.round(+m[1] + (255 - +m[1]) * factor);
    const b = Math.round(+m[2] + (255 - +m[2]) * factor);
    return `rgb(${r},${g},${b})`;
}

/**
 * Blend multiple colours together then lighten (for multi-cal timed events).
 */
export function blendColorsLight(colors, factor = 0.82) {
    if (!colors.length) return '#f8fafc';
    let r = 0, g = 0, b = 0;
    colors.forEach(c => {
        const m = colorToRgba(c, 1).match(/\d+/g);
        if (m) { r += +m[0]; g += +m[1]; b += +m[2]; }
    });
    const n = colors.length;
    const base = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
    return colorToLight(base, factor);
}

/** Return the ISO week string "YYYY-Www" for a given Date. */
export function isoWeek(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const year = d.getUTCFullYear();
    const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '00')}`;
}

/** Return an array of 7 Date objects for Mon–Sun of the week containing `date`. */
export function weekDates(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay() || 7; // treat Sunday as 7
    d.setDate(d.getDate() - day + 1); // back to Monday
    return Array.from({ length: 7 }, (_, i) => {
        const copy = new Date(d);
        copy.setDate(d.getDate() + i);
        return copy;
    });
}

/** Format a Date to "Mon Apr 14" style. */
export function formatShortDate(date) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Format a Date range to "Apr 7 – 13, 2026" */
export function formatWeekRange(dates) {
    const first = dates[0], last = dates[dates.length - 1];
    const opts = { month: 'short', day: 'numeric' };
    return `${first.toLocaleDateString('en-US', opts)} – ${last.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`;
}

/** True if two Dates fall on the same calendar day. */
export function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth()    === b.getMonth()    &&
           a.getDate()     === b.getDate();
}
