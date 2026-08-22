// ============================================================================
// theme.js — picks the active visual theme BEFORE the page paints.
//
//   'steel'   (default) — the new design: public/styles.css
//   'classic'           — the original design: public/theme-classic.css
//                         (a byte-for-byte copy of the old styles.css)
//
// Rollback, three ways:
//   1. The "Tasarım" button in the header  -> switches and remembers.
//   2. Add ?theme=classic to any URL       -> switches and remembers.
//   3. git checkout migrate/sqlite2        -> removes the new design entirely.
//
// Loaded SYNCHRONOUSLY in <head>, immediately after the stylesheet <link>, so
// the swap happens before first paint (no flash of the wrong theme).
// ============================================================================
(function () {
    'use strict';

    var KEY = 'app.theme';
    var DEFAULT = 'steel';
    var VALID = { steel: 1, classic: 1 };

    function read() {
        var q = null;
        try {
            q = new URLSearchParams(window.location.search).get('theme');
        } catch (e) { /* very old browser */ }
        if (q && VALID[q]) {
            try { localStorage.setItem(KEY, q); } catch (e) { /* private mode */ }
            return q;
        }
        var saved = null;
        try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
        return (saved && VALID[saved]) ? saved : DEFAULT;
    }

    var theme = read();
    document.documentElement.setAttribute('data-theme', theme);

    // Point the single stylesheet link at the right file. The link is already in
    // the document above this script, so this runs before any paint.
    if (theme === 'classic') {
        var link = document.getElementById('themeStylesheet');
        if (link) link.setAttribute('href', '/theme-classic.css');
    }

    window.appTheme = {
        current: function () { return theme; },
        set: function (next) {
            if (!VALID[next]) return;
            try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
            // A full reload is deliberate: it swaps the stylesheet cleanly and
            // re-renders every dynamically built list with the right icons.
            window.location.reload();
        },
        toggle: function () {
            window.appTheme.set(theme === 'steel' ? 'classic' : 'steel');
        }
    };

    // ---- the switch itself, mounted next to the language switcher ----------
    // Its own inline SVG: icons.js is deliberately inert in the classic theme,
    // and this button has to look right in both.
    var SWATCH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
        ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3.5 8.5 12 4l8.5 4.5L12 13z"/><path d="M3.5 12.5 12 17l8.5-4.5"/>' +
        '<path d="M3.5 16.5 12 21l8.5-4.5"/></svg>';

    function label(key, fallback) {
        return (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, fallback) : fallback;
    }

    function paint(btn) {
        var isSteel = theme === 'steel';
        var here = label(isSteel ? 'common.theme_steel' : 'common.theme_classic', isSteel ? 'Çelik' : 'Klasik');
        var there = label(isSteel ? 'common.theme_classic' : 'common.theme_steel', isSteel ? 'Klasik' : 'Çelik');
        btn.innerHTML = SWATCH + '<span>' + here + '</span>';
        btn.title = label('common.theme_label', 'Tasarım') + ': ' + here + ' → ' + there;
        btn.setAttribute('aria-label', btn.title);
    }

    function mount() {
        if (document.getElementById('themeToggleBtn')) return;
        var anchor = document.getElementById('langSwitcherContainer');
        if (!anchor || !anchor.parentNode) return;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'themeToggleBtn';
        btn.className = 'theme-toggle';
        btn.setAttribute('data-no-ic', '');       // keep icons.js away from this label
        paint(btn);
        btn.addEventListener('click', function () { window.appTheme.toggle(); });
        anchor.parentNode.insertBefore(btn, anchor.nextSibling);

        // i18n loads its locale file asynchronously and only fires i18n:changed
        // on a LATER language switch — so paint once more when it is ready.
        if (window.i18n && typeof window.i18n.init === 'function') {
            try {
                var p = window.i18n.init();
                if (p && p.then) p.then(function () { paint(btn); });
            } catch (e) { /* leave the fallback label */ }
        }

        // Re-label when the user changes language.
        document.addEventListener('i18n:changed', function () { paint(btn); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
