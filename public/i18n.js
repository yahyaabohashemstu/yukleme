// ============================================
// Yükleme Yönetim Sistemi - i18n Engine
// Supports: Turkish (tr), Arabic (ar), English (en)
// ============================================
//
// Usage in HTML:
//   <h1 data-i18n="login.title">Yükleme Yönetim Sistemi</h1>
//   <input data-i18n-placeholder="login.username_placeholder" placeholder="...">
//   <button data-i18n-title="common.copy" title="Kopyala">📋</button>
//   <span data-i18n-html="loader.alert_draft_detail">...</span>
//
// Usage in JS:
//   const text = window.i18n.t('common.save');
//   window.i18n.setLang('ar');       // returns a Promise
//   window.i18n.getLang();           // 'tr' | 'ar' | 'en'
//   window.i18n.isRTL();             // boolean
//   window.i18n.applyDOM(rootEl);    // re-apply translations to a subtree
//   window.i18n.renderSwitcher(el);  // mount the language switcher into an element
//
// Re-render dynamic content on language change:
//   document.addEventListener('i18n:changed', () => { /* re-render */ });

(function (global) {
    'use strict';

    const STORAGE_KEY = 'app.lang';
    const DEFAULT_LANG = 'tr';
    const SUPPORTED_LANGS = ['tr', 'ar', 'en'];
    const RTL_LANGS = new Set(['ar']);

    const LANG_META = {
        tr: { code: 'tr', label: 'TR', flag: '🇹🇷', name: 'Türkçe' },
        ar: { code: 'ar', label: 'AR', flag: '🇸🇦', name: 'العربية' },
        en: { code: 'en', label: 'EN', flag: '🇬🇧', name: 'English' }
    };

    let currentLang = (function () {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
        } catch (e) { /* private mode etc. */ }
        const nav = (navigator.language || '').toLowerCase().slice(0, 2);
        if (SUPPORTED_LANGS.includes(nav)) return nav;
        return DEFAULT_LANG;
    })();

    let translations = {};
    const cache = {}; // lang -> translations object

    async function load(lang) {
        if (cache[lang]) return cache[lang];
        try {
            const res = await fetch(`/locales/${lang}.json`, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            cache[lang] = await res.json();
            return cache[lang];
        } catch (e) {
            console.warn(`[i18n] Failed to load locale "${lang}":`, e);
            return {};
        }
    }

    async function init() {
        translations = await load(currentLang);
        applyDir();
        applyDOM();
        // Announce the FIRST load too, not just later switches: markup with
        // data-i18n is handled by applyDOM above, but anything a page builds
        // in JavaScript has already rendered with its fallback text by now
        // and has to be told to render again.
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: currentLang, first: true } }));
    }

    async function setLang(lang) {
        if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
        currentLang = lang;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
        translations = await load(lang);
        applyDir();
        applyDOM();
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
    }

    function t(key, fallback) {
        if (translations && Object.prototype.hasOwnProperty.call(translations, key)) {
            return translations[key];
        }
        return fallback !== undefined ? fallback : key;
    }

    // Replace {placeholders} in a translation, e.g. t('result.count', null, {n: 5})
    function tf(key, vars, fallback) {
        const raw = t(key, fallback);
        if (!vars) return raw;
        return String(raw).replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? vars[name] : `{${name}}`));
    }

    // Applies to the root element as well as its descendants. That matters for
    // injected content: the node handed to us is often the translatable element.
    function each(root, selector, fn) {
        if (root.nodeType === 1 && root.matches && root.matches(selector)) fn(root);
        root.querySelectorAll(selector).forEach(fn);
    }

    function applyDOM(rootEl) {
        const root = rootEl || document;

        each(root, '[data-i18n]', el => {
            const key = el.dataset.i18n;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.textContent = translations[key];
            }
        });

        each(root, '[data-i18n-html]', el => {
            const key = el.dataset.i18nHtml;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.innerHTML = translations[key];
            }
        });

        each(root, '[data-i18n-placeholder]', el => {
            const key = el.dataset.i18nPlaceholder;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.placeholder = translations[key];
            }
        });

        each(root, '[data-i18n-title]', el => {
            const key = el.dataset.i18nTitle;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.title = translations[key];
            }
        });

        each(root, '[data-i18n-value]', el => {
            const key = el.dataset.i18nValue;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.value = translations[key];
            }
        });

        root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
            const key = el.dataset.i18nAriaLabel;
            if (!key) return;
            if (Object.prototype.hasOwnProperty.call(translations, key)) {
                el.setAttribute('aria-label', translations[key]);
            }
        });
    }

    function applyDir() {
        document.documentElement.lang = currentLang;
        document.documentElement.dir = RTL_LANGS.has(currentLang) ? 'rtl' : 'ltr';
        if (document.body) {
            document.body.classList.toggle('rtl', RTL_LANGS.has(currentLang));
            document.body.setAttribute('data-lang', currentLang);
        }
    }

    function getLang() { return currentLang; }
    function isRTL() { return RTL_LANGS.has(currentLang); }
    function getSupportedLangs() { return SUPPORTED_LANGS.slice(); }
    function getLangMeta(code) { return LANG_META[code]; }

    // Render the language switcher into a container element
    function renderSwitcher(container, options) {
        if (!container) return;
        const opts = options || {};
        const compact = opts.compact !== false; // default true

        container.innerHTML = `
            <div class="lang-switcher" role="group" aria-label="Language">
                ${SUPPORTED_LANGS.map(code => {
                    const meta = LANG_META[code];
                    const active = currentLang === code;
                    return `
                        <button type="button" data-lang="${code}" title="${meta.name}"
                            aria-pressed="${active}"
                            style="background: ${active ? 'var(--primary, #4f46e5)' : 'transparent'};
                                   color: ${active ? '#fff' : 'var(--text-secondary, #475569)'};
                                   border: none; padding: 6px 10px; border-radius: var(--r-sm, 6px);
                                   cursor: pointer; font-size: var(--fs-12, 12px); font-weight: 600;
                                   display: inline-flex; align-items: center; gap: 4px;
                                   transition: background 0.15s, color 0.15s; line-height: 1;">
                            <span style="font-size: var(--fs-14, 14px); line-height: 1;">${meta.flag}</span>
                            <span>${compact ? meta.label : meta.name}</span>
                        </button>
                    `;
                }).join('')}
            </div>
        `;

        // Wrapper styles
        const wrapper = container.querySelector('.lang-switcher');
        if (wrapper) {
            wrapper.style.cssText = 'display: inline-flex; gap: 2px; background: var(--bg-input, rgba(0,0,0,0.04)); border: 1px solid var(--border-color, #e2e8f0); border-radius: var(--r, 8px); padding: 3px;';
        }

        container.querySelectorAll('button[data-lang]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const target = btn.dataset.lang;
                await setLang(target);
                renderSwitcher(container, options); // refresh active state
            });
        });
    }

    // Both panels build most of what you read — the report modal, its edit form,
    // every table row — in JavaScript, after this file has already run. Markup
    // injected that way never passed through applyDOM, so a data-i18n inside it
    // was inert and the Turkish fallback is what stayed on screen. Watching for
    // inserted subtrees fixes that once, for every injection point there is and
    // every one added later.
    const I18N_SELECTOR = '[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-title],[data-i18n-value]';

    function watchInjectedContent() {
        if (typeof MutationObserver !== 'function') return;
        let pending = [];
        let scheduled = false;

        function flush() {
            scheduled = false;
            const nodes = pending;
            pending = [];
            for (const n of nodes) {
                if (!n.isConnected) continue;
                try { applyDOM(n); } catch (e) { /* one bad subtree must not stop the rest */ }
            }
        }

        new MutationObserver(records => {
            for (const rec of records) {
                for (const n of rec.addedNodes) {
                    if (n.nodeType !== 1) continue;   // text nodes carry no keys
                    if ((n.matches && n.matches(I18N_SELECTOR)) || (n.querySelector && n.querySelector(I18N_SELECTOR))) {
                        pending.push(n);
                    }
                }
            }
            // setTimeout, not requestAnimationFrame: a hidden tab never paints,
            // and the queue would sit there forever.
            if (pending.length && !scheduled) { scheduled = true; setTimeout(flush, 0); }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    global.i18n = { init, setLang, t, tf, applyDOM, getLang, isRTL, getSupportedLangs, getLangMeta, renderSwitcher };

    // Auto-init: applies dir + DOM as soon as the script loads.
    // Pages that need to await translations before rendering dynamic content
    // can `await window.i18n.init()` explicitly inside their bootstrap.
    watchInjectedContent();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
