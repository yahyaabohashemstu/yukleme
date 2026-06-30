// =============================================================================
// database.js — SQLite backend (drop-in replacement for the old Supabase client)
//
// Exposes the SAME interface the rest of the app imports:
//     const { supabase, initializeDatabase } = require('./database');
// where `supabase` is a Supabase-compatible adapter (see lib/supabase-sqlite.js)
// backed by a local better-sqlite3 database file.
//
// The original Supabase version is preserved at database.supabase.js.bak for
// rollback (`git checkout main` also fully restores the old setup).
// =============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const { createClient } = require('./lib/supabase-sqlite');

// ---- Resolve the DB file location ----
// In production (Coolify) set DB_PATH=/app/data/app.db (a PERSISTENT volume).
// Locally it defaults to ./data/app.db.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---- Open the database & set pragmas ----
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better read/write concurrency for a web app
db.pragma('busy_timeout = 5000'); // wait up to 5s instead of throwing SQLITE_BUSY
db.pragma('synchronous = NORMAL'); // safe with WAL, much faster than FULL
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -16000'); // ~16MB page cache in RAM
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O for fast reads
db.pragma('temp_store = MEMORY'); // keep temp tables/indexes in RAM

// ---- Create tables if they don't exist ----
const schema = fs.readFileSync(path.join(__dirname, 'lib', 'sqlite-schema.sql'), 'utf8');
db.exec(schema);

// ---- The Supabase-compatible adapter ----
const supabase = createClient(db);

// Seed users — ONLY inserted when the users table is EMPTY (i.e. a brand-new
// install with no migration). After the data migration this is a no-op, so real
// users/passwords are never touched.
//
// Each password is read from an env var (SEED_<USERNAME>_PASSWORD); the weak
// "<username>123" value is a LAST-RESORT dev fallback only and triggers a loud
// warning. Production should set strong passwords via env (or rely on migration).
const SEED_USERS = [
    { username: 'murat', role: 'loader' },
    { username: 'mahmud', role: 'loader' },
    { username: 'manager', role: 'manager' },
    { username: 'pinar', role: 'manager' },
];

async function initializeDatabase() {
    try {
        const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
        if (c === 0) {
            const now = new Date().toISOString();
            const insert = db.prepare(
                'INSERT INTO users (id, username, password, role, created_at) VALUES (?, ?, ?, ?, ?)'
            );
            let usedFallback = false;
            const prepared = [];
            for (const u of SEED_USERS) {
                const envPass = process.env['SEED_' + u.username.toUpperCase() + '_PASSWORD'];
                const password = envPass || (u.username + '123');
                if (!envPass) usedFallback = true;
                prepared.push([crypto.randomUUID(), u.username, await bcrypt.hash(password, 10), u.role, now]);
            }
            const tx = db.transaction((rows) => {
                for (const r of rows) insert.run(...r);
            });
            tx(prepared);
            console.log(`Seeded ${prepared.length} initial users.`);
            if (usedFallback) {
                console.warn(
                    '⚠️  SECURITY: one or more seed users use the weak default password "<username>123". ' +
                    'Change them immediately (set SEED_<USERNAME>_PASSWORD env vars or update via the scripts).'
                );
            }
        }
        return true;
    } catch (error) {
        console.error('initializeDatabase error:', error);
        return false;
    }
}

module.exports = { supabase, initializeDatabase, db, DB_PATH };
