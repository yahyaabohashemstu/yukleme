// ============================================================================
// icons.js — replaces the UI's emoji with one consistent stroked SVG icon set.
//
// WHY a runtime sweep instead of editing the markup: the emoji live in ~370
// places across loader.html / manager.html, many of them inside JavaScript that
// builds HTML at runtime (report rows, modals, toasts, confirm dialogs). Doing
// it here covers all of them from one table, leaves those two 150 KB files
// untouched, and makes the rollback exact: in the 'classic' theme this file
// does nothing at all, so the original emoji are still the original emoji.
//
// Everything is driven by ICONS (name -> svg body) and EMOJI (emoji -> name).
// JS that wants an icon directly can call window.icon('truck').
// ============================================================================
(function () {
    'use strict';

    // ---- the icon set -------------------------------------------------------
    // All on a 24x24 grid, stroke-only, no fills, so they take their colour from
    // `currentColor` and their weight from the --sw custom property.
    var ICONS = {
        truck: '<path d="M3 6.5h11v9H3z"/><path d="M14 9.5h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
        truckSide: '<path d="M2.5 7.5h11v8h-11z"/><path d="M13.5 10.5h4l3 3v2h-7z"/><circle cx="6.5" cy="18" r="1.9"/><circle cx="17" cy="18" r="1.9"/>',
        users: '<path d="M16 19.5v-1.6a3.6 3.6 0 0 0-3.6-3.6h-4.8A3.6 3.6 0 0 0 4 17.9v1.6"/><circle cx="10" cy="8" r="3.3"/><path d="M20 19.5v-1.6a3.6 3.6 0 0 0-2.7-3.5"/><path d="M15.5 5.2a3.3 3.3 0 0 1 0 5.6"/>',
        user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/>',
        driver: '<circle cx="12" cy="7.5" r="3.2"/><path d="M5.5 20.5v-1.2a4.6 4.6 0 0 1 4.6-4.6h3.8a4.6 4.6 0 0 1 4.6 4.6v1.2"/><path d="M9 14.9 12 18l3-3.1"/>',
        hardhat: '<path d="M4 16.5a8 8 0 0 1 16 0"/><path d="M9.5 16.2V7.8a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v8.4"/><path d="M2.5 16.5h19v2.2h-19z"/>',
        tie: '<path d="M9 3.5h6l-1.2 3.2h-3.6z"/><path d="M10.2 6.7 8.6 14.4 12 20.5l3.4-6.1-1.6-7.7"/>',
        box: '<path d="M12 3 20 7.2v9.6L12 21l-8-4.2V7.2z"/><path d="M4 7.2 12 11.4l8-4.2"/><path d="M12 11.4V21"/>',
        pallet: '<path d="M3.5 14.5h17v5h-17z"/><path d="M7 19.5v-5M17 19.5v-5"/><path d="M6.5 4.5h11v10h-11z"/><path d="M12 4.5v10"/>',
        pin: '<path d="M12 21.2s6.4-5.7 6.4-10.4a6.4 6.4 0 1 0-12.8 0C5.6 15.5 12 21.2 12 21.2z"/><circle cx="12" cy="10.6" r="2.4"/>',
        camera: '<path d="M3.5 8.5h3.2l1.4-2.3h7.8l1.4 2.3h3.2v11h-17z"/><circle cx="12" cy="13.6" r="3.6"/>',
        image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.7"/><path d="M4.2 17.2 9 12.9l3.8 3.3 3-2.4 4 3.4"/>',
        chat: '<path d="M20.5 12.6c0 3.9-3.8 7-8.5 7a10 10 0 0 1-2.6-.34L4.2 20.7l1.3-3.4A6.7 6.7 0 0 1 3.5 12.6c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>',
        note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><path d="M9 12h7M9 16h4.5"/>',
        pencil: '<path d="M4 20h4L19.2 8.8a2.3 2.3 0 0 0-3.2-3.2L4.8 16.8z"/><path d="M14.8 6.8l2.4 2.4"/>',
        clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
        calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/>',
        calendarRange: '<rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/><path d="M7.5 14h3M13.5 14h3"/>',
        chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M21.5 20h-19"/>',
        clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="1.5"/><path d="M9 3.5h6v3H9z"/><path d="M9 11.5h6M9 15.5h4"/>',
        trash: '<path d="M5 7h14"/><path d="M9.5 7V4.5h5V7"/><path d="M6.8 7l1 12.5h8.4L17.2 7"/>',
        doc: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
        receipt: '<path d="M6 3.2h12v17.6l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 12h6"/>',
        scale: '<path d="M12 4.5v15"/><path d="M6 8.2h12"/><path d="M6 8.2 3 15h6z"/><path d="M18 8.2 15 15h6z"/>',
        search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.6-4.6"/>',
        save: '<path d="M4.5 4.5h11.4L19.5 8v11.5h-15z"/><path d="M8 4.5h7v4.2H8z"/><rect x="7.5" y="13" width="9" height="6.5"/>',
        upload: '<path d="M12 16V4.5"/><path d="M8 8.2 12 4.2l4 4"/><path d="M4.5 15v4.5h15V15"/>',
        folder: '<path d="M3.5 6.5h6l2 2.5h9v10.5h-17z"/><path d="M3.5 9h17"/>',
        inbox: '<path d="M3.5 13.5h5l1.5 3h4l1.5-3h5"/><path d="M6 4.5h12l2.5 9v6h-17v-6z"/>',
        checkCircle: '<circle cx="12" cy="12" r="8.6"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/>',
        xCircle: '<circle cx="12" cy="12" r="8.6"/><path d="M9 9l6 6M15 9l-6 6"/>',
        alert: '<path d="M12 3.6 21.2 19.6H2.8z"/><path d="M12 9.6v4.2M12 16.9v.1"/>',
        info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.9v.1"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        arrowRight: '<path d="M4.5 12h14"/><path d="M14 7.2l5 4.8-5 4.8"/>',
        arrowLeft: '<path d="M19.5 12h-14"/><path d="M10 7.2 5 12l5 4.8"/>',
        plus: '<path d="M12 5.5v13M5.5 12h13"/>',
        repeat: '<path d="M4 11.2a7 7 0 0 1 7-7h6"/><path d="M14.4 1.6 17.6 4.2 14.4 6.8"/><path d="M20 12.8a7 7 0 0 1-7 7H7"/><path d="M9.6 22.4 6.4 19.8 9.6 17.2"/>',
        refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.5 4v4.2h-4.2"/>',
        recycle: '<path d="M8.4 5.6 12 3.5l3.6 2.1"/><path d="M12 3.9v6.6"/><path d="M4.6 15.4l.5-4.1 3.6.9"/><path d="M5.3 11.6 9 17.4"/><path d="M19.4 15.4l-.5-4.1-3.6.9"/><path d="M18.7 11.6 15 17.4"/><path d="M7.5 20.5h9"/>',
        speaker: '<path d="M4.5 9.5h3l4-3.4v11.8l-4-3.4h-3z"/><path d="M15 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M17.6 6.8a7.2 7.2 0 0 1 0 10.4"/>',
        mic: '<rect x="9.2" y="3" width="5.6" height="10.6" rx="2.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
        recDot: '<circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="9"/>',
        lock: '<rect x="5" y="10.4" width="14" height="9.6" rx="1.5"/><path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8"/>',
        lockKey: '<rect x="4.5" y="10.4" width="15" height="9.6" rx="1.5"/><path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8"/><path d="M12 14v2.6"/>',
        logout: '<path d="M14 7V5.5A2.5 2.5 0 0 0 11.5 3h-5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h5a2.5 2.5 0 0 0 2.5-2.5V17"/><path d="M20 12H9.5"/><path d="M17 9l3 3-3 3"/>',
        write: '<path d="M3.5 20.5c1.6-.7 2.4-1.9 3.2-3.4"/><path d="M6.8 17.2l2.7.8L20 7.5a2 2 0 0 0-2.8-2.8L6.8 15.3z"/><path d="M15.6 6.9l2.8 2.8"/>',
        target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1"/>',
        printer: '<path d="M7 9V4h10v5"/><rect x="3.8" y="9" width="16.4" height="7.2" rx="1.5"/><path d="M7 14h10v6.2H7z"/>',
        antenna: '<path d="M5.2 5.2a9.6 9.6 0 0 0 0 13.6"/><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8"/><circle cx="12" cy="12" r="1.6"/><path d="M13.4 13.4 20 20"/>',
        bulb: '<path d="M9.4 17.5a6 6 0 1 1 5.2 0"/><path d="M9.6 17.5h4.8v2.2H9.6z"/><path d="M10.4 21.5h3.2"/>',
        filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
        hourglass: '<path d="M7 3.5h10"/><path d="M7 20.5h10"/><path d="M7.5 3.5c0 4.2 4.5 5.9 4.5 8.5s-4.5 4.3-4.5 8.5"/><path d="M16.5 3.5c0 4.2-4.5 5.9-4.5 8.5s4.5 4.3 4.5 8.5"/>',
        skipForward: '<path d="M5.5 5.6 15 12 5.5 18.4z"/><path d="M18.4 5.6v12.8"/>',
        chevronDown: '<path d="M6 9.5l6 6 6-6"/>'
    };

    // ---- emoji -> icon name -------------------------------------------------
    // Multi-codepoint sequences must be listed here too; the matcher tries the
    // exact match first, then the same string with variation selectors stripped.
    var EMOJI = {
        '🧑‍✈️': 'driver', // person-pilot ZWJ sequence
        '🧑‍✈': 'driver',
        '🚛': 'truck',        // articulated lorry
        '🚚': 'truckSide',    // delivery truck
        '👥': 'users',
        '👤': 'user',
        '🧑': 'driver',
        '👷': 'hardhat',
        '👔': 'tie',
        '📦': 'box',
        '🟫': 'pallet',       // brown square (pallet count)
        '📍': 'pin',
        '📷': 'camera',
        '💬': 'chat',
        '📝': 'note',
        '✏': 'pencil',
        '🕐': 'clock',
        '🕒': 'clock',
        '📅': 'calendar',
        '📆': 'calendarRange',
        '📊': 'chart',
        '📋': 'clipboard',
        '🗑': 'trash',
        '📄': 'doc',
        '🧾': 'receipt',
        '⚖': 'scale',
        '🔍': 'search',
        '💾': 'save',
        '📤': 'upload',
        '📂': 'folder',
        '📭': 'inbox',
        '✅': 'checkCircle',
        '❌': 'xCircle',
        '⚠': 'alert',
        'ℹ': 'info',
        '✓': 'check',
        '✕': 'close',
        '→': 'arrowRight',
        '←': 'arrowLeft',   // the Arabic (RTL) locale's "filter" arrow
        '➕': 'plus',
        '🔁': 'repeat',
        '🔄': 'refresh',
        '↻': 'refresh',
        '♻': 'recycle',
        '🔊': 'speaker',
        '🎙': 'mic',
        '🎤': 'mic',
        '🔴': 'recDot',
        '🔒': 'lock',
        '🔐': 'lockKey',
        '🚪': 'logout',
        '✍': 'write',
        '🎯': 'target',
        '🖨': 'printer',
        '📡': 'antenna',
        '💡': 'bulb',
        '⏳': 'hourglass',    // hourglass — "processing" states
        '⌛': 'hourglass',
        '⏭': 'skipForward',  // the voice bot's "skip this field"
        '▼': 'chevronDown',  // the time picker's arrow
        '▲': 'chevronDown'
    };

    // Matches any emoji we might care about (plus an optional variation selector
    // and the one ZWJ sequence). Regional-indicator flags (U+1F1E6..1F1FF) are
    // deliberately OUTSIDE this range: the language switcher keeps its flags.
    // The \uD83C low range deliberately starts at \uDF00: that skips the
    // regional-indicator pairs (U+1F1E6..1F1FF) so the language flags survive.
    var RE = /🧑‍✈️?|(?:[ℹ←-⇿⌀-⏿▀-◿☀-➿⬀-⯿]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF])️?/g;

    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, OPTION: 1, NOSCRIPT: 1 };

    function lookup(raw) {
        return EMOJI[raw] || EMOJI[raw.replace(/[️‍]/g, '')] || null;
    }

    // Build one <span class="ic"> wrapping the icon's <svg>.
    function makeIcon(name) {
        var span = document.createElement('span');
        span.className = 'ic';
        span.setAttribute('data-ic', name);
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = '<svg viewBox="0 0 24 24" focusable="false">' + ICONS[name] + '</svg>';
        return span;
    }

    // Public helper for code that wants markup rather than a DOM node.
    window.icon = function (name, extraClass) {
        if (!ICONS[name]) return '';
        return '<span class="ic ' + (extraClass || '') + '" data-ic="' + name + '" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" focusable="false">' + ICONS[name] + '</svg></span>';
    };

    var busy = false; // ignore the mutations our own replacements produce

    // Remove the emoji from places that can only hold plain text (an <option>'s
    // label, a placeholder, a tooltip). The wording still reads correctly — the
    // glyph was decoration in every one of these.
    function strip(root, selector, attr) {
        var list = [];
        try {
            // The mutated node itself can be the match (an attribute change on
            // one input), so test the root as well as its descendants.
            if (root.matches && root.matches(selector)) list.push(root);
            if (root.querySelectorAll) {
                var found = root.querySelectorAll(selector);
                for (var k = 0; k < found.length; k++) list.push(found[k]);
            }
        } catch (e) { return; }
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (el.closest && el.closest('[data-no-ic]')) continue;
            var val = attr ? el.getAttribute(attr) : el.textContent;
            if (!val) continue;
            RE.lastIndex = 0;
            if (!RE.test(val)) continue;
            RE.lastIndex = 0;
            var next = val.replace(RE, function (e) { return lookup(e) ? '' : e; })
                .replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
            if (next === val) continue;
            if (attr) el.setAttribute(attr, next);
            else el.textContent = next;
        }
    }

    function convertTextNode(node) {
        // The node may already have been detached between the mutation record
        // and this flush (i18n replaces textContent, which drops the old node).
        if (!node || !node.parentNode) return false;
        var text = node.nodeValue;
        if (!text) return false;
        RE.lastIndex = 0;
        if (!RE.test(text)) return false;
        RE.lastIndex = 0;

        // Elements that cannot hold markup: an <option> keeps plain text with
        // the glyph removed; script/style/pre are left completely alone.
        var host = node.parentNode.nodeName;
        if (SKIP[host]) {
            if (host === 'OPTION') {
                node.nodeValue = text.replace(RE, function (e) { return lookup(e) ? '' : e; })
                    .replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
                return true;
            }
            return false;
        }

        var frag = document.createDocumentFragment();
        var last = 0, m, replaced = false;
        while ((m = RE.exec(text)) !== null) {
            var name = lookup(m[0]);
            if (!name) continue; // an emoji we deliberately keep (e.g. a flag)
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            frag.appendChild(makeIcon(name));
            last = m.index + m[0].length;
            replaced = true;
        }
        if (!replaced) return false;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
        return true;
    }

    function sweep(root) {
        if (!root) return;
        busy = true;
        try {
            if (root.nodeType === 3) { convertTextNode(root); return; }
            if (root.nodeType !== 1) return;

            var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (n) {
                    var p = n.parentNode;
                    if (!p || SKIP[p.nodeName] || p.closest('[data-no-ic]')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            var pending = [], n;
            while ((n = walker.nextNode())) pending.push(n);
            for (var i = 0; i < pending.length; i++) convertTextNode(pending[i]);

            // <option> and attributes can hold visible text but cannot hold an
            // <svg>, so there the emoji is stripped instead of replaced.
            strip(root, 'option', null);
            strip(root, 'input[placeholder], textarea[placeholder]', 'placeholder');
            strip(root, 'input[title], button[title], span[title], div[title], a[title]', 'title');
        } finally {
            busy = false;
        }
    }

    function start() {
        sweep(document.body);

        var queue = [], scheduled = false;
        var flush = function () {
            scheduled = false;
            var batch = queue;
            queue = [];
            for (var i = 0; i < batch.length; i++) {
                // One bad node must never drop the rest of the batch: that is
                // how i18n's re-labelled buttons kept their emoji.
                try { sweep(batch[i]); } catch (e) { /* keep sweeping */ }
            }
        };

        new MutationObserver(function (records) {
            if (busy) return;
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                if (r.type === 'characterData') {
                    queue.push(r.target);
                } else if (r.type === 'attributes') {
                    // i18n re-applies placeholders/tooltips after our first pass.
                    queue.push(r.target);
                } else {
                    for (var j = 0; j < r.addedNodes.length; j++) {
                        var node = r.addedNodes[j];
                        if (node.nodeType === 1 || node.nodeType === 3) queue.push(node);
                    }
                }
            }
            if (queue.length && !scheduled) {
                scheduled = true;
                if (window.requestAnimationFrame) window.requestAnimationFrame(flush);
                else setTimeout(flush, 0);
            }
        }).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['placeholder', 'title']
        });
    }

    // The classic theme keeps its emoji — this file is a no-op there.
    if (document.documentElement.getAttribute('data-theme') === 'classic') return;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
