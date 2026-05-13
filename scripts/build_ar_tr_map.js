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

// Words that the translation function produces but products.json spells differently.
// Order matters: longer/more-specific replacements first.
const postReplacements = [
    [/\bSpring\b/g, 'Bahar Tazeliği'],
];

function normalizeForMatch(s) {
    return String(s)
        .toLowerCase()
        .replace(/[\s\/\-_*+()]+/g, '') // strip whitespace, separators, and a few symbols
        .replace(/i̇/g, 'i');             // Turkish dotted-i normalization
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

// Sanity check: any products.json entries that ended up without a mapping
const mappedKeys = new Set(Object.keys(trToAr));
const missingFromMap = actualProducts.filter(p => !mappedKeys.has(p));

const outPath = path.join(__dirname, '..', 'public', 'products_tr_to_ar.json');
fs.writeFileSync(outPath, JSON.stringify(trToAr, null, 2), 'utf8');

console.log(`✓ Wrote ${Object.keys(trToAr).length} / ${actualProducts.length} mappings to ${outPath}`);
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
