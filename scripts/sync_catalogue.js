// Bring the warehouse's product catalogue into the app.
//
// The warehouse exports its products twice from Odoo: once with Turkish
// names, once with Arabic, and both carry the same product id. This script
// joins the two by that id and puts every product where the app looks for it:
//
//   public/products.json          the list a loader picks from while typing
//   public/products_tr_to_ar.json the Arabic the manager reads for each name
//
// It only ADDS. A name already in either file is never removed, renamed or
// given a different Arabic; the script checks that before writing and stops
// if anything would change. Run it again whenever the warehouse sends new
// sheets: products it already knows are left exactly as they are.
//
// Where the Arabic sheet has no Arabic for a product — raw materials such as
// "LABSA" are written in Latin letters in both sheets — the Turkish name
// stands for itself. A Latin-only difference between the two sheets is either
// cosmetic ("PEG- 40" / "PEG 40") or names another product altogether
// ("STEPANTEX VL 90 A" / "LIRSOFT PPA 90"), and in neither case is it Arabic
// worth showing.
//
// Usage:
//   node scripts/sync_catalogue.js            report what would change
//   node scripts/sync_catalogue.js --write    write the two files
//   node scripts/sync_catalogue.js --write <turkish.xlsx> <arabic.xlsx>

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const PRODUCTS = path.join(ROOT, 'public', 'products.json');
const MAP = path.join(ROOT, 'public', 'products_tr_to_ar.json');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const files = args.filter(a => a !== '--write');
const TR_FILE = files[0] || path.join(ROOT, 'منتجات الواجهة التركي 2026 - with id.xlsx');
const AR_FILE = files[1] || path.join(ROOT, 'منتجات الواجهة العربي 2026 - with id.xlsx');

const hasArabic = s => /[؀-ۿ]/.test(s);
const clean = s => String(s == null ? '' : s).trim();

function fail(msg) {
    console.error('STOPPED, nothing written: ' + msg);
    process.exit(1);
}

function readSheet(file) {
    if (!fs.existsSync(file)) fail('file not found: ' + file);
    const wb = XLSX.readFile(file);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const head = rows[0].map(h => clean(h).toLowerCase());
    const id = head.indexOf('id'), name = head.indexOf('name');
    if (id < 0 || name < 0) fail(`${path.basename(file)}: expected "id" and "name" columns, found ${JSON.stringify(rows[0])}`);
    const out = new Map();
    for (const r of rows.slice(1)) {
        const key = clean(r[id]), value = clean(r[name]);
        if (!key && !value) continue;
        if (!key || !value) fail(`${path.basename(file)}: a row has an id without a name or a name without an id: ${JSON.stringify(r)}`);
        if (out.has(key)) fail(`${path.basename(file)}: product id ${key} appears twice`);
        out.set(key, value);
    }
    return out;
}

const tr = readSheet(TR_FILE);
const ar = readSheet(AR_FILE);

// The two sheets must describe the same products, or the join means nothing.
const onlyTr = [...tr.keys()].filter(id => !ar.has(id));
const onlyAr = [...ar.keys()].filter(id => !tr.has(id));
if (onlyTr.length || onlyAr.length) {
    fail(`the sheets do not hold the same products: ${onlyTr.length} ids only in the Turkish one, ${onlyAr.length} only in the Arabic one`);
}

const oldProducts = JSON.parse(fs.readFileSync(PRODUCTS, 'utf8'));
const oldMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));

const products = new Set(oldProducts);
const map = { ...oldMap };
const added = { products: [], map: [] };
const conflicts = [];   // one Turkish name, two different Arabic names in the sheets
const latinOnly = [];   // the Arabic sheet differs, but only in Latin letters

const arabicFor = {};   // turkish name -> the Arabic the sheets give it
for (const [id, trName] of tr) {
    const arName = ar.get(id);
    let value = trName;
    if (hasArabic(arName)) value = arName;
    else if (arName !== trName) latinOnly.push({ tr: trName, ar: arName });

    const seen = arabicFor[trName];
    if (seen !== undefined && seen !== value) {
        // The warehouse gives one Turkish name two different Arabic names.
        // Choosing between them is not this script's call: the name stands
        // for itself until the sheets agree.
        const c = conflicts.find(x => x.tr === trName);
        if (c) c.arabic.push(value); else conflicts.push({ tr: trName, arabic: [seen, value] });
        arabicFor[trName] = trName;
        continue;
    }
    if (!conflicts.some(x => x.tr === trName)) arabicFor[trName] = value;
}

for (const [trName, value] of Object.entries(arabicFor)) {
    if (!products.has(trName)) { products.add(trName); added.products.push(trName); }
    if (map[trName] === undefined) { map[trName] = value; added.map.push(trName); }
}

// Same order the list has always had: Turkish alphabetical.
const newProducts = [...products].sort((a, b) => a.localeCompare(b, 'tr'));

// ---- the guarantees, checked before anything is written ----
for (const p of oldProducts) if (!newProducts.includes(p)) fail('a name would leave the product list: ' + p);
for (const [k, v] of Object.entries(oldMap)) if (map[k] !== v) fail('an existing Arabic name would change: ' + k);
for (const trName of Object.keys(arabicFor)) {
    if (!newProducts.includes(trName)) fail('a catalogue product is missing from the list: ' + trName);
    if (map[trName] === undefined) fail('a catalogue product has no Arabic entry: ' + trName);
}
for (const p of newProducts) if (map[p] === undefined) fail('a listed product has no Arabic entry: ' + p);

// ---- report ----
const sheetNames = new Set(tr.values());
console.log(`Sheets: ${tr.size} products (${sheetNames.size} distinct Turkish names), joined by id.`);
console.log(`Product list:   ${oldProducts.length} -> ${newProducts.length}  (+${added.products.length})`);
console.log(`Arabic entries: ${Object.keys(oldMap).length} -> ${Object.keys(map).length}  (+${added.map.length})`);
console.log(`  of the added, the Turkish name stands for itself: ${added.map.filter(k => map[k] === k).length}`);
if (latinOnly.length) {
    console.log(`\nArabic sheet differs only in Latin letters (${latinOnly.length}) — the Turkish name is used:`);
    for (const x of latinOnly) console.log(`  ${x.tr}\n    Arabic sheet: ${x.ar}`);
}
if (conflicts.length) {
    console.log(`\nSame Turkish name, different Arabic in the sheets (${conflicts.length}):`);
    for (const x of conflicts) {
        console.log(`  ${x.tr}`);
        for (const a of x.arabic) console.log(`    Arabic sheet: ${a}`);
        console.log(`    in use:       ${map[x.tr]}${oldMap[x.tr] !== undefined ? '  (already in the app, unchanged)' : ''}`);
    }
}
// The same folding the app uses to match a stored name to the catalogue.
const fold = s => String(s).toLowerCase().replace(/[\s\/\-_*+()]+/g, '').replace(/i̇/g, 'i').replace(/ı/g, 'i');
const byFold = new Map();
for (const p of newProducts) { const k = fold(p); byFold.set(k, (byFold.get(k) || []).concat(p)); }
const fresh = new Set(added.products);
const near = [...byFold.values()].filter(v => v.length > 1 && v.some(p => fresh.has(p)));
if (near.length) {
    console.log(`\nAlready in the list under another spelling (${near.length}) — both kept:`);
    for (const v of near) console.log('  ' + v.join('  |  '));
}

if (!WRITE) {
    console.log('\nNothing written. Run again with --write to apply.');
    process.exit(0);
}

fs.writeFileSync(PRODUCTS, JSON.stringify(newProducts, null, 2) + '\n');
fs.writeFileSync(MAP, JSON.stringify(map, null, 2) + '\n');
console.log('\nWritten: public/products.json, public/products_tr_to_ar.json');
