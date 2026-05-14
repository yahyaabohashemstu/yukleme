// Build a Turkish-to-Arabic product-name lookup map.
//
// Inputs:
//   - arabicProducts[] + translateProductName() from ../translate_products_v2.js
//   - public/products.json (the canonical Turkish list as stored in the DB)
//
// Output: public/products_tr_to_ar.json  →  { "<exact TR from products.json>": "<AR name>", ... }
//
// The key contract: every key in the output MUST match an exact value in products.json,
// so getProductDisplayName() can do a direct lookup against names stored in the DB.
//
// Strategy:
//   1. Translate each Arabic product → candidate Turkish name.
//   2. Apply post-translation overrides (e.g. "Spring" → "Bahar Tazeliği") to align
//      with vocabulary actually used in products.json.
//   3. Try exact match against products.json; fall back to a normalized match
//      (lowercased, whitespace-collapsed, punctuation-stripped).
//   4. If matched, use the exact products.json string as the map key.
//   5. Report any unmatched Arabic products and any products.json entries that
//      never got an Arabic mapping.

const fs = require('fs');
const path = require('path');
const { arabicProducts, translateProductName } = require('../translate_products_v2.js');

const productsJsonPath = path.join(__dirname, '..', 'public', 'products.json');
const actualProducts = JSON.parse(fs.readFileSync(productsJsonPath, 'utf8'));

// ---------------------------------------------------------------------------
// MANUAL OVERRIDES
// Translations for products that don't exist (or don't translate cleanly) via
// the Arabic source list in translate_products_v2.js. Add an entry here when
// a product appears in products.json but its Arabic name is curated by hand.
// Keys MUST match the canonical Turkish spelling in products.json exactly.
// ---------------------------------------------------------------------------
const MANUAL_OVERRIDES = {
    'EIFFEL Renkli Çamaşır Suyu': 'إيفيل كلور ملون'
};

// Words that the translation function produces but products.json spells differently.
// Order matters: longer/more-specific replacements first.
const postReplacements = [
    [/\bSpring\b/g, 'Bahar Tazeliği'],
];

function normalizeForMatch(s) {
    return String(s)
        .toLowerCase()
        .replace(/[\s\/\-_*+()]+/g, '') // strip whitespace, separators, and a few symbols
        .replace(/i̇/g, 'i')              // combining-dot i (from İ.toLowerCase())
        .replace(/ı/g, 'i');              // Turkish dotless ı — fold all i-variants together
}

// Build a normalized → original index of products.json so we can match by shape
const normIndex = {};
actualProducts.forEach(p => {
    normIndex[normalizeForMatch(p)] = p;
});

const trToAr = {};
const conflicts = {};
const unmatched = []; // Arabic names whose translation we couldn't tie to a products.json entry

arabicProducts.forEach(ar => {
    let tr = translateProductName(ar);
    if (!tr) return;

    // Apply post-translation overrides
    for (const [from, to] of postReplacements) {
        tr = tr.replace(from, to);
    }

    // Resolve to the exact products.json key when possible
    let key;
    if (actualProducts.includes(tr)) {
        key = tr;
    } else {
        const norm = normalizeForMatch(tr);
        if (normIndex[norm]) {
            key = normIndex[norm];
        }
    }

    if (!key) {
        unmatched.push({ ar, tr });
        return; // skip products that have no canonical Turkish equivalent
    }

    if (trToAr[key] && trToAr[key] !== ar) {
        conflicts[key] = conflicts[key] || [trToAr[key]];
        if (!conflicts[key].includes(ar)) conflicts[key].push(ar);
    }
    trToAr[key] = ar;
});

// ---------------------------------------------------------------------------
// Arabic word-boundary insertion
// The original arabicProducts list has many entries where a brand sits glued
// to the following noun (e.g. "برودوكسابودرة" instead of "برودوكسا بودرة"),
// or a digit sits glued to an Arabic word (e.g. "12يونيفرسال").
// Translation preserved those quirks. We normalize them here so the rendered
// product name reads correctly in the manager view.
//
// Strategy: ensure a space appears BEFORE each known word when it follows
// another Arabic letter or a digit without one. Short unit letters (كغ, غ,
// مل) are NOT in the list, so "3كغ" stays "3كغ".
// ---------------------------------------------------------------------------
const ARABIC_BOUNDARY_WORDS = [
    // Brand names (proper nouns)
    'برودوكسا', 'برودوكسة', 'أيلوكس', 'ايلوكس', 'التونسا', 'إلتونسا',
    'أوروبلس', 'اوروبلس', 'ديوكس', 'نايسي', 'افراح', 'أفراح',
    'فيفا', 'سور', 'موك', 'اسوتا', 'إيفيل', 'ايفيل', 'درغام', 'بابيل',
    // Common product nouns
    'بودرة', 'ماتيك', 'يدوي', 'صابون', 'سائل', 'كلور', 'مطري',
    'معطر', 'منظف', 'ملمع', 'مزيل', 'سوبر', 'جل', 'شامبو',
    'هدية', 'حاوية', 'شوال', 'فلاش', 'نصف', 'مصنع', 'كرتون',
    'كيس', 'رول', 'يونيفرسال', 'يونيفيرسال', 'للغسيل'
    // Note: do NOT add bare "غسيل" — it would break the valid compound
    // "للغسيل" ("for washing") into "لل غسيل".
];

function normalizeArabicSpacing(s) {
    if (!s) return s;
    let r = String(s);
    for (const w of ARABIC_BOUNDARY_WORDS) {
        // 1. Arabic letter + word (no space) → "letter word"
        r = r.replace(new RegExp(`([ء-ۿ])(${w})`, 'g'), '$1 $2');
        // 2. Digit + word (no space) → "digit word"
        r = r.replace(new RegExp(`(\\d)(${w})`, 'g'), '$1 $2');
    }
    // Collapse multiple spaces and trim
    r = r.replace(/[ \t]+/g, ' ').trim();
    return r;
}

// Apply manual overrides BEFORE generating suffix variants so the variants
// are based on the curated Arabic name (not whatever the generator produced).
const overrideCount = { added: 0, replaced: 0 };
for (const [tr, ar] of Object.entries(MANUAL_OVERRIDES)) {
    if (!actualProducts.includes(tr)) {
        console.warn(`  ⚠️ Manual override key not in products.json: "${tr}"`);
        continue;
    }
    if (trToAr[tr]) overrideCount.replaced++;
    else overrideCount.added++;
    trToAr[tr] = ar;
}

// Apply Arabic spacing normalization to every value in the map BEFORE
// variant generation so the variants inherit the fix.
let spacingFixCount = 0;
for (const k of Object.keys(trToAr)) {
    const before = trToAr[k];
    const after = normalizeArabicSpacing(before);
    if (before !== after) {
        spacingFixCount++;
        trToAr[k] = after;
    }
}

// Auto-generate suffix variants so DB records carrying common parenthetical
// tags ("(BARKODSUZ)", "(BARKODLU)") still resolve. The runtime also strips
// these dynamically, but baking them into the map keeps the JSON inspectable
// and lets the offline cache cover them too.
const SUFFIX_VARIANTS = ['(BARKODSUZ)', '(BARKODLU)'];
const variantAdditions = {};
for (const [tr, ar] of Object.entries(trToAr)) {
    for (const suffix of SUFFIX_VARIANTS) {
        const withSuffix = `${tr} ${suffix}`;
        if (!trToAr[withSuffix] && !variantAdditions[withSuffix]) {
            variantAdditions[withSuffix] = ar;
        }
    }
}
Object.assign(trToAr, variantAdditions);

// Sanity check: any products.json entries that ended up without a mapping
const mappedKeys = new Set(Object.keys(trToAr));
const missingFromMap = actualProducts.filter(p => !mappedKeys.has(p));

const outPath = path.join(__dirname, '..', 'public', 'products_tr_to_ar.json');
fs.writeFileSync(outPath, JSON.stringify(trToAr, null, 2), 'utf8');

console.log(`✓ Wrote ${Object.keys(trToAr).length} total mappings to ${outPath}`);
console.log(`  Base entries from products.json: ${actualProducts.length}`);
console.log(`  Manual overrides applied: ${overrideCount.added} new, ${overrideCount.replaced} replaced`);
console.log(`  Arabic-spacing fixes applied: ${spacingFixCount}`);
console.log(`  Suffix variants added (${SUFFIX_VARIANTS.join(', ')}): ${Object.keys(variantAdditions).length}`);
console.log(`  Source: ${arabicProducts.length} Arabic product names`);
console.log(`  Conflicts (same TR ⇐ multiple AR): ${Object.keys(conflicts).length}`);
console.log(`  Unmatched Arabic entries: ${unmatched.length}`);
console.log(`  products.json entries WITHOUT an Arabic mapping: ${missingFromMap.length}`);

if (Object.keys(conflicts).length > 0) {
    console.log('\n  Conflict details:');
    for (const [tr, ars] of Object.entries(conflicts)) {
        console.log(`    "${tr}"`);
        ars.forEach(ar => console.log(`       ⇐  "${ar}"`));
    }
}

if (unmatched.length > 0) {
    console.log('\n  Unmatched Arabic entries (translation did not align with products.json):');
    unmatched.slice(0, 20).forEach(({ ar, tr }) => {
        console.log(`    AR: "${ar}"`);
        console.log(`    TR (generated): "${tr}"`);
    });
    if (unmatched.length > 20) console.log(`    ...and ${unmatched.length - 20} more`);
}

if (missingFromMap.length > 0) {
    console.log('\n  products.json entries WITHOUT an Arabic mapping (first 20):');
    missingFromMap.slice(0, 20).forEach(p => console.log(`    "${p}"`));
    if (missingFromMap.length > 20) console.log(`    ...and ${missingFromMap.length - 20} more`);
}
