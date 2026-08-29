// ============================================================================
// productTranslate.js — Arabic for a product name a loader typed by hand.
//
// Three steps, in this order, and it stops at the first that answers:
//
//   1. THE CATALOGUE, verbatim. products_tr_to_ar.json holds 1665 pairs, 801
//      of them joined to the warehouse's own Arabic by Odoo product id. An
//      exact or normalised hit here is not a translation at all — it is the
//      factory's own record, and it costs nothing.
//
//   2. THE CATALOGUE, chosen by the model. Loaders type "Diox toz 9KG" where
//      the catalogue says "DIOX rol toz deterjan matık 9kg mor". The model is
//      shown the closest catalogue lines and asked which one this is. It may
//      only answer with a line it was shown, verbatim — anything else is
//      thrown away — and the Arabic then comes from the catalogue, not from
//      the model. Identifying the product is a judgement; translating it is
//      not, and this keeps the two apart.
//
//   3. A TRANSLATION, when the product is genuinely not in the catalogue.
//      New lines reach the yard before they reach the product list. The model
//      writes the Arabic itself, following the conventions the catalogue
//      already uses, and the answer is recorded as coming from the model
//      rather than from the factory.
//
// Every answer is cached by the exact spelling that produced it, so a given
// way of writing a name is asked about once and never again.
// ============================================================================

const fs = require('fs');
const path = require('path');

const MODEL = () => process.env.GEMINI_PRODUCT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ENABLED = () => String(process.env.PRODUCT_AI_TRANSLATE || 'on').toLowerCase() !== 'off';
const MAX_PER_REQUEST = Number(process.env.PRODUCT_AI_MAX_PER_REQUEST || 8);

// ---- the catalogue ---------------------------------------------------------

const MAP_PATH = path.join(__dirname, '..', 'public', 'products_tr_to_ar.json');
let CATALOGUE = {};
let NORM_INDEX = {};

function normalise(s) {
    // Turkish has two dotless/dotted i pairs and JS lowercasing does not know
    // it, so İ and I are folded to i by hand or the same name written in caps
    // fails to match itself.
    return String(s).toLowerCase()
        .replace(/[\s\/\-_*+()]+/g, '')
        .replace(/i̇/g, 'i')
        .replace(/ı/g, 'i')
        .replace(/×/g, 'x');
}

function loadCatalogue() {
    CATALOGUE = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    NORM_INDEX = {};
    for (const [tr, ar] of Object.entries(CATALOGUE)) NORM_INDEX[normalise(tr)] = { tr, ar };
    return Object.keys(CATALOGUE).length;
}
loadCatalogue();

/** Step 1: the catalogue, verbatim. Returns null on a miss. */
function fromCatalogue(name) {
    if (!name) return null;
    const raw = String(name);
    if (CATALOGUE[raw]) return { ar: CATALOGUE[raw], source: 'catalogue' };
    const trimmed = raw.trim();
    if (CATALOGUE[trimmed]) return { ar: CATALOGUE[trimmed], source: 'catalogue' };
    const noParen = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (noParen && CATALOGUE[noParen]) return { ar: CATALOGUE[noParen], source: 'catalogue' };
    const hit = NORM_INDEX[normalise(trimmed)] || NORM_INDEX[normalise(noParen)];
    return hit ? { ar: hit.ar, source: 'catalogue' } : null;
}

// ---- picking what to show the model ---------------------------------------

const BRANDS = ['aylux', 'diox', 'assuta', 'altunsa', 'altnusa', 'afrah', 'alafrah',
    'nicey', 'europlus', 'butterfly', 'hes', 'bingo', 'omo'];

const fold = s => String(s).toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c')
    .replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/â/g, 'a').replace(/×/g, 'x').replace(/,/g, '.');
const wordsOf = s => new Set(fold(s).split(/[^a-z]+/).filter(w => w.length > 1));
const numsOf = s => (fold(s).match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n > 0);
const brandOf = s => BRANDS.find(b => fold(s).includes(b)) || null;
const codeOf = s => {
    const m = String(s).toUpperCase().replace(/\s+/g, '').match(/\b([A-Z]{1,3})-?(\d{2,3})\b/);
    return m ? m[1] + m[2] : null;
};

/**
 * The catalogue lines worth showing for this name. A different brand or a
 * different product code is never a candidate — those two are the identity of
 * a product, and a near-miss on them is how the wrong item reaches a shipping
 * document.
 */
function candidatesFor(name, limit = 12) {
    const brand = brandOf(name), code = codeOf(name);
    const W = wordsOf(name), N = numsOf(name);
    const out = [];
    for (const [tr, ar] of Object.entries(CATALOGUE)) {
        const b = brandOf(tr), c = codeOf(tr);
        if (brand && b && brand !== b) continue;
        if (code && c && code !== c) continue;
        const TW = wordsOf(tr), TN = numsOf(tr);
        let w = 0; for (const x of W) if (TW.has(x)) w++;
        let n = 0; for (const x of N) if (TN.includes(x)) n++;
        if (!w && !n) continue;
        const score = (w / Math.max(W.size, 1)) * 0.6 + (N.length ? n / N.length : 0) * 0.4;
        out.push({ tr, ar, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- the model -------------------------------------------------------------

async function geminiJSON(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = `${base}/${MODEL()}:generateContent`;
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
    const attempts = Math.max(1, Number(process.env.GEMINI_RETRIES || 3));
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
                }),
                signal: controller.signal,
            });
            const text = await res.text();
            if (!res.ok) { const e = new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 200)}`); e.status = res.status; throw e; }
            const data = JSON.parse(text);
            const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!out) throw new Error('Gemini returned no text');
            return JSON.parse(out);
        } catch (err) {
            if (err && err.name === 'AbortError') { err = new Error('Gemini timed out'); err.timeout = true; }
            lastErr = err;
            const retryable = err.timeout || err.status === 503 || err.status === 500;
            if (retryable && i < attempts) { clearTimeout(to); await sleep(600 * 2 ** (i - 1)); continue; }
            throw err;
        } finally { clearTimeout(to); }
    }
    throw lastErr;
}

function buildPrompt(name, candidates, styleExamples) {
    const list = candidates.map((c, i) => `${i + 1}. ${c.tr}\n   العربية: ${c.ar}`).join('\n');
    const style = styleExamples.map(c => `${c.tr}  ⟶  ${c.ar}`).join('\n');
    return `أنت مسؤول عن أسماء منتجات مصنع منظّفات، تُكتب بالتركية وتُعرض بالعربية.

كتب مسؤولُ التحميل هذا الاسم بخطّ يده:
"${name}"

هذه أقرب الأسماء في كتالوج المصنع الرسمي، ومعها مقابلها العربي المعتمد:
${list || '(لا يوجد شيء قريب في الكتالوج)'}

أمثلة على أسلوب الكتالوج في الترجمة:
${style}

مهمّتك: قرّر أيّهما.

(أ) إن كان ما كتبه هو أحد الأسماء أعلاه بصياغة مختلفة، أجب:
{"decision":"match","catalogue_turkish":"<الاسم التركي كما ورد أعلاه حرفًا بحرف>","confidence":"high|medium|low"}

(ب) إن لم يكن أيٌّ منها هو نفس المنتج، ترجم أنت الاسم بأسلوب الكتالوج:
{"decision":"translate","arabic":"<الترجمة>","confidence":"high|medium|low"}

قواعد لا تُخالَف:
- العلامة التجارية جزء من هويّة المنتج. إن كتب "Diox" فلا تختر منتج "Aylux" أبدًا، ولو تطابق كل ما عداه.
- رمز المنتج (A15، K03، AT10) كذلك. لا تخلط بين رمز ورمز.
- اللون والوزن والعدد جزء من الهوية. "turuncu" برتقالي وليس "pembe" زهري. و"9kg" ليست "3kg".
- إن كان ما كتبه لا يذكر لونًا أو تعبئة بينما الكتالوج يفرّق بينها، فلا تختر واحدًا بالتخمين — اختر (ب) وترجم ما كُتب فقط دون إضافة ما لم يُذكر.
- في (أ) يجب أن يكون "catalogue_turkish" منسوخًا حرفيًّا من القائمة أعلاه. أي اسم من عندك يُرفض.
- في (ب): أبقِ الأرقام والوحدات كما هي، واكتب أسماء العلامات كما يكتبها الكتالوج، ولا تُضِف معلومة غير موجودة في النصّ.
- إن لم تكن واثقًا فاجعل "confidence" منخفضًا. الخطأ هنا يظهر على وثيقة شحن.

أعد كائن JSON واحدًا فقط، بلا أي نصّ آخر.`;
}

// ---- the cache -------------------------------------------------------------

let cacheReady = false;
function ensureCache(db) {
    if (cacheReady) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS product_name_cache (
            typed       TEXT PRIMARY KEY,
            arabic      TEXT NOT NULL,
            source      TEXT NOT NULL,
            matched_tr  TEXT,
            confidence  TEXT,
            created_at  TEXT NOT NULL
        )`);
    cacheReady = true;
}

function cacheGet(db, name) {
    ensureCache(db);
    const row = db.prepare('SELECT arabic, source, confidence FROM product_name_cache WHERE typed = ?').get(String(name));
    return row ? { ar: row.arabic, source: row.source, confidence: row.confidence } : null;
}

function cachePut(db, name, entry) {
    ensureCache(db);
    db.prepare(`INSERT INTO product_name_cache (typed, arabic, source, matched_tr, confidence, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(typed) DO UPDATE SET
                    arabic = excluded.arabic, source = excluded.source,
                    matched_tr = excluded.matched_tr, confidence = excluded.confidence`)
      .run(String(name), entry.ar, entry.source, entry.matchedTr || null, entry.confidence || null, new Date().toISOString());
}

// ---- one name --------------------------------------------------------------

async function translateOne(db, name) {
    const direct = fromCatalogue(name);
    if (direct) return direct;

    const cached = cacheGet(db, name);
    if (cached) return cached;

    if (!ENABLED() || !process.env.GEMINI_API_KEY) return null;

    const candidates = candidatesFor(name);
    const styleExamples = Object.entries(CATALOGUE).slice(0, 0).map(([tr, ar]) => ({ tr, ar }));
    // a handful of real pairs, taken from the candidates themselves so the
    // style shown is the style of this corner of the catalogue
    const style = candidates.slice(0, 4);

    const answer = await geminiJSON(buildPrompt(name, candidates, style.length ? style : styleExamples));

    let entry = null;
    if (answer && answer.decision === 'match' && typeof answer.catalogue_turkish === 'string') {
        // The model may only return a line it was shown. Anything else — a name
        // it half-remembered, a name it improved — is discarded.
        const picked = candidates.find(c => c.tr === answer.catalogue_turkish.trim());
        if (picked) entry = { ar: picked.ar, source: 'catalogue-ai', matchedTr: picked.tr, confidence: answer.confidence };
    } else if (answer && answer.decision === 'translate' && typeof answer.arabic === 'string' && answer.arabic.trim()) {
        entry = { ar: answer.arabic.trim(), source: 'ai', confidence: answer.confidence };
    }
    if (!entry) return null;

    cachePut(db, name, entry);
    return entry;
}

/**
 * Resolve a list of names. Anything the catalogue or the cache already knows
 * comes back immediately; the rest go to the model, capped per request so one
 * page load cannot turn into a hundred calls.
 */
async function translateMany(db, names) {
    const out = {};
    const pending = [];

    for (const raw of new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))) {
        const direct = fromCatalogue(raw) || cacheGet(db, raw);
        if (direct) out[raw] = direct; else pending.push(raw);
    }

    const batch = pending.slice(0, MAX_PER_REQUEST);
    for (const name of batch) {
        try {
            const r = await translateOne(db, name);
            if (r) out[name] = r;
        } catch (e) {
            console.warn('[products] could not translate %j: %s', name, e.message);
        }
    }
    return { resolved: out, remaining: Math.max(0, pending.length - batch.length) };
}

module.exports = {
    translateMany, translateOne, fromCatalogue, candidatesFor,
    loadCatalogue, normalise, ensureCache,
};
