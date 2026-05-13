// Build a Turkish-to-Arabic product-name lookup map.
//
// Input:  arabicProducts[] + translateProductName() from ../translate_products_v2.js
// Output: public/products_tr_to_ar.json  →  { "<TR name>": "<AR name>", ... }
//
// Used by the manager UI to display Arabic product names while the underlying
// DB values remain Turkish (the loader keeps entering Turkish).

const fs = require('fs');
const path = require('path');
const { arabicProducts, translateProductName } = require('../translate_products_v2.js');

const trToAr = {};
const conflicts = {};

arabicProducts.forEach(ar => {
    const tr = translateProductName(ar);
    if (!tr) return;
    if (trToAr[tr] && trToAr[tr] !== ar) {
        conflicts[tr] = conflicts[tr] || [trToAr[tr]];
        if (!conflicts[tr].includes(ar)) conflicts[tr].push(ar);
    }
    trToAr[tr] = ar; // last write wins for collisions
});

const outDir = path.join(__dirname, '..', 'public');
const outPath = path.join(outDir, 'products_tr_to_ar.json');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(trToAr, null, 2), 'utf8');

console.log(`✓ Wrote ${Object.keys(trToAr).length} mappings to ${outPath}`);
console.log(`  Source: ${arabicProducts.length} Arabic product names`);
console.log(`  Conflicts (same TR ⇐ multiple AR): ${Object.keys(conflicts).length}`);

if (Object.keys(conflicts).length > 0) {
    console.log('\n  Conflict details:');
    for (const [tr, ars] of Object.entries(conflicts)) {
        console.log(`    "${tr}"`);
        ars.forEach(ar => console.log(`       ⇐  "${ar}"`));
    }
}
