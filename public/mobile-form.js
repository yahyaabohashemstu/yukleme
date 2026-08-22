// ============================================================================
// mobile-form.js — phone-only help for the loader's "new report" form.
//
// Two things, both additive: a progress strip that says which of the seven
// sections you are in and how many fields are done, and section folding — a
// section that is complete folds away with a tick when you move to another one,
// so a 23-field form stops being 4 screens of scrolling.
//
// Inert unless the STEEL theme is active AND the viewport is a phone, so the
// classic design and the desktop layout are untouched.
// ============================================================================
(function () {
    'use strict';

    if (document.documentElement.getAttribute('data-theme') === 'classic') return;

    var PHONE = '(max-width: 768px)';
    var form, cards, strip, bar, stepEl, countEl, enabled = false;

    function t(key, fallback) {
        return (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, fallback) : fallback;
    }

    // A section's own fields — the create form only, never the edit modal.
    function fieldsOf(card) {
        return [].slice.call(card.querySelectorAll('input, select, textarea'))
            .filter(function (el) { return el.type !== 'hidden' && el.type !== 'file'; });
    }

    function isFilled(el) {
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
        return String(el.value || '').trim() !== '';
    }

    function titleOf(card) {
        var h = card.querySelector('.form-card-title h2');
        return h ? h.textContent.trim() : '';
    }

    function build() {
        if (strip) return;
        var tabs = document.querySelector('.tabs-container');
        if (!tabs || !tabs.parentNode) return;

        strip = document.createElement('div');
        strip.className = 'form-progress';
        strip.id = 'formProgress';
        strip.setAttribute('data-no-ic', '');
        strip.innerHTML =
            '<div class="fp-bar"><i></i></div>' +
            '<div class="fp-row"><span class="fp-step"></span><span class="fp-count"></span></div>';
        tabs.parentNode.insertBefore(strip, tabs.nextSibling);

        bar = strip.querySelector('.fp-bar i');
        stepEl = strip.querySelector('.fp-step');
        countEl = strip.querySelector('.fp-count');
    }

    function update() {
        if (!enabled || !form || !strip) return;

        var total = 0, done = 0, current = null, currentIndex = 0;

        cards.forEach(function (card, i) {
            var fields = fieldsOf(card);
            var filled = fields.filter(isFilled).length;
            total += fields.length;
            done += filled;

            var complete = fields.length > 0 && filled === fields.length;
            card.classList.toggle('is-complete', complete);
            card.setAttribute('data-done', filled + '/' + fields.length);

            if (!current && !complete && fields.length > 0) { current = card; currentIndex = i; }
        });

        if (!current) { current = cards[cards.length - 1]; currentIndex = cards.length - 1; }

        cards.forEach(function (card) { card.classList.toggle('is-current', card === current); });

        var pct = total ? Math.round((done / total) * 100) : 0;
        bar.style.width = pct + '%';
        stepEl.textContent = t('loader.progress_step', 'Bölüm {n} / {total}')
            .replace('{n}', currentIndex + 1).replace('{total}', cards.length) + ' · ' + titleOf(current);
        countEl.textContent = t('loader.progress_fields', '{done} / {total} alan')
            .replace('{done}', done).replace('{total}', total);
    }

    // Fold a completed section once the loader moves on to a different one.
    function onFocusIn(e) {
        if (!enabled) return;
        var card = e.target.closest ? e.target.closest('.form-card') : null;
        if (!card || cards.indexOf(card) === -1) return;
        cards.forEach(function (c) {
            if (c !== card && c.classList.contains('is-complete')) c.classList.add('is-folded');
        });
        card.classList.remove('is-folded');
    }

    // Tapping a header folds or unfolds that section by hand.
    function onHeaderClick(e) {
        if (!enabled) return;
        var head = e.target.closest ? e.target.closest('.form-card-header') : null;
        if (!head) return;
        var card = head.parentNode;
        if (cards.indexOf(card) === -1) return;
        card.classList.toggle('is-folded');
    }

    function enable() {
        if (enabled) return;
        build();
        if (!strip) return;
        enabled = true;
        document.body.classList.add('phone-form');
        form.addEventListener('input', update);
        form.addEventListener('change', update);
        form.addEventListener('focusin', onFocusIn);
        form.addEventListener('click', onHeaderClick);
        update();
    }

    function disable() {
        if (!enabled) return;
        enabled = false;
        document.body.classList.remove('phone-form');
        form.removeEventListener('input', update);
        form.removeEventListener('change', update);
        form.removeEventListener('focusin', onFocusIn);
        form.removeEventListener('click', onHeaderClick);
        cards.forEach(function (c) { c.classList.remove('is-folded', 'is-current', 'is-complete'); });
    }

    function start() {
        form = document.getElementById('loadingForm');
        if (!form) return;
        cards = [].slice.call(form.querySelectorAll(':scope > .form-card'));
        if (!cards.length) return;

        var mq = window.matchMedia(PHONE);
        var sync = function () { mq.matches ? enable() : disable(); };
        sync();
        if (mq.addEventListener) mq.addEventListener('change', sync);
        else if (mq.addListener) mq.addListener(sync);

        // The voice fill writes values straight into the fields.
        document.addEventListener('i18n:changed', update);
        var mo = new MutationObserver(function () { if (enabled) update(); });
        mo.observe(form, { subtree: true, attributes: true, attributeFilter: ['value', 'class'] });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
