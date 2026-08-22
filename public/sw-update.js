// ============================================================================
// sw-update.js — puts a new release on screen at the FIRST open, not the second.
//
// WHY it is needed: the service worker serves CSS and JS cache-first. When a
// page opens after a deploy, its HTML arrives fresh from the network but the
// stylesheet still comes out of the PREVIOUS worker's cache, because the new
// worker is only installing at that moment. It calls skipWaiting()/claim(), so
// it takes charge a second or two later — and that hand-over is what this file
// listens for. One reload at that point, and the page matches the release.
//
// WHY it will not eat anyone's work: a reload is only ever issued when nothing
// is at stake — no field the user has filled, no open dialog, no submit in
// flight. If the page is busy the new version simply waits, and the check runs
// again each time the page settles. On a phone the loader's twenty-field form
// is what this protects; losing it would be far worse than seeing the previous
// design for one more session.
//
// HOW "filled by the user" is decided: by comparing against a snapshot of the
// form taken once the page has finished starting up — NOT against the markup's
// own default values. The loader's date field is stamped with today's date by
// the page itself, which would otherwise make a brand-new form look like work
// in progress, and that page would then never update at all. The snapshot also
// catches values written by the voice assistant, which assigns them directly
// without firing any event that a listener could see.
// ============================================================================
(function () {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    // No controller means this is a first-ever visit: the worker about to claim
    // this page is the one that cached the very files the page just loaded from
    // the network. Nothing is stale, so nothing needs reloading.
    var hadController = !!navigator.serviceWorker.controller;

    var GUARD = 'sw.reloadedAt';   // survives the reload; makes a loop impossible
    var LOOP_WINDOW = 10000;       // ms
    var SETTLE = 300;              // ms after load before the form is photographed

    var baseline = null;           // Map<element, value> — the page as it started
    var handoverSeen = false;
    var reloading = false;
    var watching = false;
    var timer = null;

    // ---- reading the form --------------------------------------------------

    function controls() {
        return document.querySelectorAll('input, select, textarea');
    }

    function ignorable(el) {
        var t = (el.type || '').toLowerCase();
        return el.disabled || t === 'hidden' || t === 'submit' ||
               t === 'button' || t === 'reset' || t === 'image';
    }

    function valueOf(el) {
        var t = (el.type || '').toLowerCase();
        if (t === 'file') return el.files ? el.files.length : 0;
        if (t === 'checkbox' || t === 'radio') return el.checked ? '1' : '0';
        return el.value;
    }

    // For a control that did not exist when the snapshot was taken — a product
    // row added after the fact — fall back to the markup's own default.
    function differsFromMarkup(el) {
        var t = (el.type || '').toLowerCase();
        if (t === 'file') return !!(el.files && el.files.length);
        if (t === 'checkbox' || t === 'radio') return el.checked !== el.defaultChecked;
        if (el.tagName === 'SELECT') {
            var marked = el.querySelector('option[selected]');
            var initial = marked ? marked.value : (el.options[0] ? el.options[0].value : '');
            return el.value !== initial;
        }
        return el.value !== el.defaultValue;
    }

    function takeSnapshot() {
        var map = new Map();
        var els = controls();
        for (var i = 0; i < els.length; i++) {
            if (!ignorable(els[i])) map.set(els[i], valueOf(els[i]));
        }
        baseline = map;
    }

    // ---- what counts as "leave this page alone" ----------------------------

    function dialogOpen() {
        // Every overlay in the app — details, image, voice, voice log — is a
        // .modal-overlay that becomes visible by gaining .show.
        return !!document.querySelector('.modal-overlay.show');
    }

    function submitInFlight() {
        // Submitting disables the button until the request settles.
        return !!document.querySelector('button[type="submit"]:disabled');
    }

    function fieldFilled() {
        var els = controls();
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (ignorable(el)) continue;

            // The voice assistant marks everything it writes.
            if (el.classList && el.classList.contains('voice-filled')) return true;

            if (baseline.has(el)) {
                if (valueOf(el) !== baseline.get(el)) return true;
            } else if (differsFromMarkup(el)) {
                return true;
            }
        }
        return false;
    }

    function safeToReload() {
        return !!baseline && !dialogOpen() && !submitInFlight() && !fieldFilled();
    }

    // ---- the reload --------------------------------------------------------

    function recentlyReloaded() {
        try {
            return Date.now() - (parseInt(sessionStorage.getItem(GUARD), 10) || 0) < LOOP_WINDOW;
        } catch (e) {
            return false;   // private mode: the in-page flags still guard us
        }
    }

    function reloadOnce() {
        if (reloading || recentlyReloaded()) return;
        reloading = true;
        try { sessionStorage.setItem(GUARD, String(Date.now())); } catch (e) { /* private mode */ }
        window.location.reload();
    }

    function attempt() {
        if (reloading || !handoverSeen) return;
        if (safeToReload()) { reloadOnce(); return; }
        watch();
    }

    // The page is busy, or not photographed yet. Look again whenever something
    // happens that could have freed it — a dialog closing, a form submitted and
    // cleared, the tab being left. Debounced, because these come in bursts.
    function watch() {
        if (watching) return;
        watching = true;
        document.addEventListener('click', later, true);
        document.addEventListener('change', later, true);
        document.addEventListener('visibilitychange', later);
        window.addEventListener('pageshow', later);
    }

    function later() {
        if (reloading) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(attempt, 400);
    }

    // ---- wiring ------------------------------------------------------------

    function armSnapshot() {
        // SETTLE gives the page's own start-up — today's date, populated
        // dropdowns — time to run before it is treated as the baseline.
        setTimeout(function () {
            takeSnapshot();
            if (handoverSeen) attempt();
        }, SETTLE);
    }

    if (document.readyState === 'complete') armSnapshot();
    else window.addEventListener('load', armSnapshot);

    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController) return;
        handoverSeen = true;
        attempt();
    });

    // Diagnostic hook. `safe()` answers "would a new release be allowed to
    // reload the page right now?", which is the only question worth asking
    // when someone reports that an update did not appear.
    window.swUpdate = {
        safe: safeToReload,
        blockedBy: function () {
            if (!baseline) return 'not-settled';
            if (dialogOpen()) return 'dialog';
            if (submitInFlight()) return 'submit';
            if (fieldFilled()) return 'filled-field';
            return null;
        },
        waiting: function () { return watching; },
        ready: function () { return !!baseline; }
    };
})();
