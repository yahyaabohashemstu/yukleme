'use strict';
// =============================================================================
// migrate/migrate.js — ONE-TIME lossless migration: Supabase -> SQLite + local files
//
// What it does (READ-ONLY on Supabase — it never deletes or changes anything there):
//   1. Reads every row from users, loadings, loading_versions (paginated).
//   2. Cross-checks exported row counts against Supabase's own COUNT(*).
//   3. Collects every photo/video URL referenced by current rows AND by the
//      JSONB snapshots inside loading_versions, PLUS lists the storage bucket
//      directly, then downloads every file into the local uploads directory.
//   4. Rewrites those Supabase URLs to relative /uploads/<file> URLs, both in
//      the live rows and inside the version snapshots.
//   5. Inserts everything into the local SQLite database (ids/timestamps preserved).
//   6. Writes a verification report (migrate/output/report.json) and an error log.
//
// Re-runnable: it WIPES the 3 target SQLite tables first, then reloads from
// Supabase — so running it twice gives the same clean result.
//
// Usage:
//   node migrate/migrate.js            # full migration
//   node migrate/migrate.js --dry-run  # export + verify counts only; writes nothing
//
// Required env (in .env or the shell):
//   SUPABASE_URL           = https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   = the service_role "secret" key (preferred)
//                            (falls back to SUPABASE_ANON_KEY with a warning)
//   DB_PATH                = target SQLite file   (default ./data/app.db)
//   UPLOADS_DIR            = target uploads dir    (default ./uploads)
// =============================================================================

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const { serialize } = require('../lib/supabase-sqlite');

const DRY_RUN = process.argv.includes('--dry-run');
const BUCKET = 'loading-photos';
const TABLES = ['users', 'loadings', 'loading_versions'];
// Columns (in loadings rows and in version snapshots) that may hold file URLs.
const PHOTO_ARRAY_FIELDS = ['loaded_vehicle_photos', 'goods_photos', 'damaged_goods_photos'];
const PHOTO_STRING_FIELDS = ['scale_receipt_photo'];

// ---- resolve config --------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

const errors = [];
let exportFailed = false; // set if ANY table export could not be completed
function logErr(msg) {
    errors.push(msg);
    console.error('   ⚠️ ', msg);
}

function assertConfig() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY in .env');
        process.exit(1);
    }
    if (!process.env.SUPABASE_SERVICE_KEY) {
        console.warn(
            '⚠️  Using SUPABASE_ANON_KEY (no service_role key). The loading_versions table\n' +
            '    may be unreadable under RLS and could come back EMPTY. For a guaranteed\n' +
            '    complete migration, set SUPABASE_SERVICE_KEY in .env. Continuing in 3s...\n'
        );
    }
}

// ---- export helpers --------------------------------------------------------
async function fetchAll(supabase, table) {
    const pageSize = 1000;
    let from = 0;
    const rows = [];
    for (;;) {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) {
            logErr(`SELECT ${table} range ${from}: ${error.message}`);
            exportFailed = true; // a partial export must NEVER be treated as complete
            break;
        }
        rows.push(...data);
        if (!data || data.length < pageSize) break;
        from += pageSize;
    }
    return rows;
}

async function remoteCount(supabase, table) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) {
        logErr(`COUNT ${table}: ${error.message}`);
        return null;
    }
    return count;
}

// ---- file collection / download -------------------------------------------
function supabaseFilename(url) {
    if (typeof url !== 'string') return null;
    if (!url.includes('/storage/v1/object/')) return null; // not a supabase storage URL
    try {
        const u = new URL(url);
        return decodeURIComponent(u.pathname.split('/').pop());
    } catch (e) {
        return url.split('/').pop();
    }
}

function collectUrlsFromRow(row, set) {
    for (const f of PHOTO_ARRAY_FIELDS) {
        const v = row[f];
        if (Array.isArray(v)) v.forEach((u) => { if (typeof u === 'string') set.add(u); });
    }
    for (const f of PHOTO_STRING_FIELDS) {
        if (typeof row[f] === 'string' && row[f]) set.add(row[f]);
    }
}

async function listBucketFiles(supabase) {
    // Best-effort: enumerate the bucket so files not referenced by any current
    // row (e.g. only in old version snapshots) are still captured.
    const names = [];
    try {
        let offset = 0;
        const limit = 100;
        for (;;) {
            const { data, error } = await supabase.storage.from(BUCKET).list('', {
                limit,
                offset,
                sortBy: { column: 'name', order: 'asc' },
            });
            if (error) { logErr(`storage.list: ${error.message}`); break; }
            if (!data || data.length === 0) break;
            data.forEach((o) => { if (o.name) names.push(o.name); });
            if (data.length < limit) break;
            offset += limit;
        }
    } catch (e) {
        logErr(`storage.list threw: ${e.message}`);
    }
    return names;
}

async function downloadTo(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return buf.length;
}

function rewriteRowUrls(row, urlMap) {
    for (const f of PHOTO_ARRAY_FIELDS) {
        if (Array.isArray(row[f])) row[f] = row[f].map((u) => urlMap.get(u) || u);
    }
    for (const f of PHOTO_STRING_FIELDS) {
        if (typeof row[f] === 'string' && urlMap.has(row[f])) row[f] = urlMap.get(row[f]);
    }
}

// ---- sqlite insertion ------------------------------------------------------
function tableColumns(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function insertRows(db, table, rows) {
    if (rows.length === 0) return 0;
    const validCols = new Set(tableColumns(db, table));
    let inserted = 0;
    const tx = db.transaction(() => {
        for (const row of rows) {
            const cols = Object.keys(row).filter((c) => validCols.has(c));
            const dropped = Object.keys(row).filter((c) => !validCols.has(c));
            if (dropped.length) logErr(`${table} id=${row.id}: dropped unknown columns ${dropped.join(', ')}`);
            const vals = cols.map((c) => serialize(table, c, row[c]));
            const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
            db.prepare(sql).run(...vals);
            inserted++;
        }
    });
    tx();
    return inserted;
}

// ---- main ------------------------------------------------------------------
(async () => {
    assertConfig();
    if (!process.env.SUPABASE_SERVICE_KEY) await new Promise((r) => setTimeout(r, 3000));

    console.log('========================================');
    console.log(' Supabase -> SQLite migration', DRY_RUN ? '(DRY RUN)' : '');
    console.log('========================================');
    console.log(' Source :', SUPABASE_URL);
    console.log(' Target DB :', DB_PATH);
    console.log(' Uploads   :', UPLOADS_DIR);
    console.log('');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

    // 1) EXPORT --------------------------------------------------------------
    console.log('1) Exporting rows from Supabase...');
    const exported = {};
    const remoteCounts = {};
    for (const t of TABLES) {
        exported[t] = await fetchAll(supabase, t);
        remoteCounts[t] = await remoteCount(supabase, t);
        const cmp = remoteCounts[t] == null ? '(count unknown)' : `of ${remoteCounts[t]}`;
        console.log(`   • ${t}: exported ${exported[t].length} ${cmp}`);
        if (remoteCounts[t] != null && remoteCounts[t] !== exported[t].length) {
            logErr(`${t}: exported ${exported[t].length} but COUNT(*)=${remoteCounts[t]} — possible RLS/pagination gap!`);
        }
    }
    if (exported.loading_versions.length === 0 && (remoteCounts.loading_versions || 0) === 0) {
        console.warn('   ⚠️  loading_versions came back EMPTY. If you expected history, this is the\n' +
                     '       RLS issue — re-run with SUPABASE_SERVICE_KEY set.');
    }

    // 2) COLLECT FILE URLS ---------------------------------------------------
    console.log('\n2) Collecting file references...');
    const urlSet = new Set();
    exported.loadings.forEach((r) => collectUrlsFromRow(r, urlSet));
    // also from version snapshots (data is the full old loadings row)
    exported.loading_versions.forEach((v) => {
        const snap = v.data;
        if (snap && typeof snap === 'object') collectUrlsFromRow(snap, urlSet);
    });
    console.log(`   • ${urlSet.size} URL(s) referenced by rows + version snapshots`);

    // bucket listing (catches orphan files not referenced anywhere)
    const bucketFiles = await listBucketFiles(supabase);
    console.log(`   • ${bucketFiles.length} file(s) found in the '${BUCKET}' bucket`);
    // Build a public URL for any bucket file not already referenced
    const referencedNames = new Set([...urlSet].map(supabaseFilename).filter(Boolean));
    let orphanCount = 0;
    for (const name of bucketFiles) {
        if (!referencedNames.has(name)) {
            const { data } = supabase.storage.from(BUCKET).getPublicUrl(name);
            if (data && data.publicUrl) { urlSet.add(data.publicUrl); orphanCount++; }
        }
    }
    if (orphanCount) console.log(`   • +${orphanCount} orphan bucket file(s) queued for download`);

    // 3) DOWNLOAD FILES ------------------------------------------------------
    const urlMap = new Map(); // oldUrl -> /uploads/<filename>
    let downloaded = 0, skipped = 0, newly = 0;
    if (!DRY_RUN) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        console.log('\n3) Downloading files (RE-RUNNABLE: anything already on disk is SKIPPED, not re-downloaded)...');
        const total = urlSet.size;
        let i = 0;
        for (const url of urlSet) {
            i++;
            if (typeof url !== 'string') continue;
            if (url.startsWith('/uploads/')) { urlMap.set(url, url); skipped++; continue; }
            const filename = supabaseFilename(url) || url.split('/').pop();
            if (!filename) { logErr(`cannot derive filename from URL: ${url}`); continue; }
            const dest = path.join(UPLOADS_DIR, filename);
            const localUrl = `/uploads/${filename}`;
            try {
                if (fs.existsSync(dest)) {
                    // Already downloaded on a previous run -> skip (resume support).
                } else {
                    const bytes = await downloadTo(url, dest);
                    newly++;
                    process.stdout.write(`   ↓ [${i}/${total}] ${filename} (${bytes} bytes)\n`);
                }
                urlMap.set(url, localUrl);
                downloaded++;
            } catch (e) {
                logErr(`download failed for ${url}: ${e.message} — leaving original URL`);
                urlMap.set(url, url); // keep original so nothing silently breaks
            }
        }
        console.log(`   • located ${downloaded} file(s): ${newly} newly downloaded, ${downloaded - newly} already on disk (skipped). already-local: ${skipped}`);
    } else {
        console.log('\n3) [dry-run] skipping downloads');
    }

    // 4) REWRITE URLS --------------------------------------------------------
    console.log('\n4) Rewriting URLs to /uploads/...');
    exported.loadings.forEach((r) => rewriteRowUrls(r, urlMap));
    exported.loading_versions.forEach((v) => {
        if (v.data && typeof v.data === 'object') rewriteRowUrls(v.data, urlMap);
    });

    // 5) WRITE TO SQLITE -----------------------------------------------------
    const insertedCounts = {};
    if (!DRY_RUN) {
        // ---- SAFETY GATE: never wipe+reload the target unless the export is
        // provably COMPLETE. Otherwise a transient Supabase/RLS/network hiccup
        // could silently replace good data with a partial copy.
        const countsComplete = TABLES.every(
            (t) => remoteCounts[t] != null && remoteCounts[t] === exported[t].length
        );
        if (exportFailed || !countsComplete) {
            console.error('\n❌ ABORTING WRITE: the Supabase export is INCOMPLETE — refusing to wipe the target DB.');
            for (const t of TABLES) {
                console.error(`     ${t}: remote=${remoteCounts[t]} exported=${exported[t].length}`);
            }
            console.error('     Fix the cause (use SUPABASE_SERVICE_KEY, check connectivity) and re-run. Nothing was changed.');
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            fs.writeFileSync(path.join(OUTPUT_DIR, 'errors.log'), errors.concat('ABORTED: incomplete export').join('\n'));
            process.exit(3);
        }

        console.log('\n5) Writing to SQLite...');
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        const db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = OFF'); // import order independent; we trust source integrity
        // ensure schema exists
        const schema = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sqlite-schema.sql'), 'utf8');
        db.exec(schema);
        // wipe target tables (clean reload) — order: child first
        db.exec('DELETE FROM loading_versions; DELETE FROM loadings; DELETE FROM users;');
        insertedCounts.users = insertRows(db, 'users', exported.users);
        insertedCounts.loadings = insertRows(db, 'loadings', exported.loadings);
        insertedCounts.loading_versions = insertRows(db, 'loading_versions', exported.loading_versions);
        for (const t of TABLES) console.log(`   • inserted ${insertedCounts[t]} into ${t}`);
        db.close();
    } else {
        console.log('\n5) [dry-run] skipping SQLite write');
    }

    // 6) VERIFY + REPORT -----------------------------------------------------
    console.log('\n6) Verification');
    let filesOnDisk = 0;
    try {
        filesOnDisk = fs.readdirSync(UPLOADS_DIR).filter((f) => f !== 'thumbs' && !f.startsWith('.')).length;
    } catch (e) {}
    const downloadFailures = errors.filter((e) => e.startsWith('download failed')).length;
    if (downloadFailures > 0) {
        console.warn(`   ⚠️  ${downloadFailures} file(s) failed to download — their original URLs were kept; see errors.log`);
    }
    const report = {
        when: new Date().toISOString(),
        dryRun: DRY_RUN,
        source: SUPABASE_URL,
        usedServiceKey: !!process.env.SUPABASE_SERVICE_KEY,
        remoteCounts,
        exportedCounts: Object.fromEntries(TABLES.map((t) => [t, exported[t].length])),
        insertedCounts: DRY_RUN ? null : insertedCounts,
        files: {
            referencedUrls: urlSet.size,
            bucketFiles: bucketFiles.length,
            downloaded: DRY_RUN ? null : downloaded,
            onDisk: filesOnDisk,
        },
        errorCount: errors.length,
    };
    let allMatch = true;
    for (const t of TABLES) {
        const exp = exported[t].length;
        const ins = DRY_RUN ? exp : insertedCounts[t];
        const rem = remoteCounts[t];
        const tableOk = (rem == null || rem === exp) && exp === ins;
        if (!tableOk) allMatch = false;
        console.log(`   • ${t}: remote=${rem} exported=${exp} inserted=${DRY_RUN ? '-' : ins} ${tableOk ? '✓' : '✗'}`);
    }
    console.log(`   • files: referenced=${urlSet.size} bucket=${bucketFiles.length} onDisk=${filesOnDisk}`);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (errors.length) fs.writeFileSync(path.join(OUTPUT_DIR, 'errors.log'), errors.join('\n'));

    console.log('\n========================================');
    if (errors.length === 0 && allMatch) {
        console.log(' ✅ Migration completed with NO errors and all counts match.');
    } else {
        console.log(` ⚠️  Completed with ${errors.length} warning(s); counts match: ${allMatch}.`);
        console.log('     See migrate/output/report.json and migrate/output/errors.log');
    }
    console.log('========================================');
    process.exit(errors.length === 0 && allMatch ? 0 : 2);
})().catch((e) => {
    console.error('MIGRATION CRASHED:', e);
    process.exit(1);
});
