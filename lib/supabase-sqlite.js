'use strict';

// =============================================================================
// Supabase-compatible adapter backed by better-sqlite3.
//
// Goal: let server.js (and the helper scripts) keep using the EXACT same
// `supabase.from('table').select()/insert()/update()/delete()...` calls they
// used against Supabase/PostgREST, with NO behaviour change — but read/write a
// local SQLite database instead.
//
// It faithfully reproduces only the query surface this project actually uses
// (fully enumerated during the migration audit), namely:
//   .from(t).select('*').eq(col,val).single()
//   .from(t).select('*, users!created_by(username)').eq(...).order(...)
//   .from(t).select('*, loading_versions(count), users!created_by(username)')...
//   .from(t).select('*', { count: 'exact', head: true }).eq(...)
//   .from(t).select('colA, colB').order(...).limit(n)
//   .from(t).insert([...]).select().single()
//   .from(t).update({...}).eq('id', id).is('viewed_at', null).select().single()
//   .from(t).delete().neq('id', ...)
//
// The result object shape ({ data, error, count }) matches @supabase/supabase-js
// so existing `const { data, error } = await supabase...` destructuring works.
// =============================================================================

const crypto = require('crypto');

// ---- Per-table column metadata -------------------------------------------
// jsonArray : stored as a JSON array string, parsed to a JS array on read,
//             defaults to '[]' when missing on insert.
// jsonObj   : stored as a JSON object string, parsed to a JS object on read,
//             defaults to NULL when missing.
// bool      : stored as INTEGER 0/1, returned as a JS boolean on read.
// createdAtCol : column the adapter auto-fills with now() on insert if absent.
const TABLE_META = {
    users: {
        jsonArray: [],
        jsonObj: [],
        bool: [],
        createdAtCol: 'created_at',
    },
    loadings: {
        jsonArray: ['products', 'loaded_vehicle_photos', 'goods_photos', 'damaged_goods_photos'],
        jsonObj: ['needs_improvement_reason'],
        bool: ['is_recorded', 'is_draft', 'is_archived'],
        createdAtCol: 'created_at',
    },
    loading_versions: {
        jsonArray: [],
        jsonObj: ['data'],
        bool: [],
        createdAtCol: 'archived_at',
    },
};

function meta(table) {
    return TABLE_META[table] || { jsonArray: [], jsonObj: [], bool: [], createdAtCol: null };
}
function isJsonCol(table, col) {
    const m = meta(table);
    return m.jsonArray.includes(col) || m.jsonObj.includes(col);
}
function isArrayCol(table, col) {
    return meta(table).jsonArray.includes(col);
}
function isBoolCol(table, col) {
    return meta(table).bool.includes(col);
}

// ---- value (de)serialisation ---------------------------------------------

// Convert any leftover JS value into something better-sqlite3 can bind.
// better-sqlite3 only accepts numbers, strings, bigints, buffers and null.
function toBindable(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Buffer.isBuffer(v)) return v;
    if (typeof v === 'object') return JSON.stringify(v); // safety net
    return v;
}

// Convert a JS value into the stored representation for a given column.
function serialize(table, col, val) {
    if (val === undefined) return null;
    if (isJsonCol(table, col)) {
        if (val === null) return isArrayCol(table, col) ? '[]' : null;
        return typeof val === 'string' ? val : JSON.stringify(val);
    }
    if (isBoolCol(table, col)) {
        if (val === null) return null;
        return val ? 1 : 0;
    }
    return toBindable(val);
}

// Convert a filter value (.eq/.neq) into a bindable value.
function filterVal(table, col, val) {
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (isBoolCol(table, col) && (val === true || val === false)) return val ? 1 : 0;
    return toBindable(val);
}

function parseJson(v, fallback) {
    if (v === null || v === undefined) return fallback;
    if (typeof v !== 'string') return v; // already an object/array
    try {
        return JSON.parse(v);
    } catch (e) {
        return fallback;
    }
}

// Turn a raw SQLite row (base columns only) into the shape the app expects:
// JSON columns parsed, array columns parsed, booleans coerced to true/false.
function deserializeRow(table, row) {
    if (!row) return row;
    const m = meta(table);
    const out = {};
    for (const k of Object.keys(row)) out[k] = row[k];
    for (const col of m.jsonArray) if (col in out) out[col] = parseJson(out[col], []);
    for (const col of m.jsonObj) if (col in out) out[col] = parseJson(out[col], null);
    for (const col of m.bool) if (col in out) out[col] = !!out[col];
    return out;
}

// ---- select-string parsing -----------------------------------------------

// Split a PostgREST select string on top-level commas (respecting parentheses).
function splitTop(str) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

// Parse a select string into base columns, embedded joins, and count embeds.
//   '*'                                  -> { baseAll:true }
//   'id, manager'                        -> baseCols:['id','manager']
//   'users!created_by(username)'         -> joins:[{target,fk,cols}]
//   'loading_versions(count)'            -> countEmbed:{ target }
function parseSelect(str) {
    const result = { baseAll: false, baseCols: [], joins: [], countEmbed: null };
    for (let raw of splitTop(str || '*')) {
        const p = raw.trim();
        if (!p) continue;
        if (p === '*') {
            result.baseAll = true;
            continue;
        }
        const emb = p.match(/^(\w+)\s*!\s*(\w+)\s*\(([^)]*)\)$/); // users!created_by(username)
        if (emb) {
            result.joins.push({
                target: emb[1],
                fk: emb[2],
                cols: emb[3].split(',').map((s) => s.trim()).filter(Boolean),
            });
            continue;
        }
        const cnt = p.match(/^(\w+)\s*\(\s*count\s*\)$/i); // loading_versions(count)
        if (cnt) {
            result.countEmbed = { target: cnt[1] };
            continue;
        }
        result.baseCols.push(p); // plain column
    }
    return result;
}

// ---- the chainable query builder -----------------------------------------

class QueryBuilder {
    constructor(db, table) {
        this.db = db;
        this.table = table;
        this._op = 'select';
        this._selectStr = '*';
        this._countMode = false;
        this._headMode = false;
        this._filters = []; // { col, op: '=' | '!=' | 'is', val }
        this._orders = []; // { col, asc }
        this._limit = null;
        this._single = false;
        this._payload = null;
        this._returning = false;
    }

    // ----- terminal-ish builder verbs -----
    select(arg, opts) {
        if (this._op === 'insert' || this._op === 'update') {
            // `.insert(...).select()` / `.update(...).select()` => RETURNING *
            this._returning = true;
            return this;
        }
        this._op = 'select';
        this._selectStr = arg || '*';
        if (opts && opts.count) {
            this._countMode = true;
            if (opts.head) this._headMode = true;
        }
        return this;
    }
    insert(rows) {
        this._op = 'insert';
        this._payload = Array.isArray(rows) ? rows : [rows];
        return this;
    }
    update(obj) {
        this._op = 'update';
        this._payload = obj || {};
        return this;
    }
    delete() {
        this._op = 'delete';
        return this;
    }

    // ----- filters / modifiers -----
    eq(col, val) {
        this._filters.push({ col, op: '=', val });
        return this;
    }
    neq(col, val) {
        this._filters.push({ col, op: '!=', val });
        return this;
    }
    is(col, val) {
        // Only `.is(col, null)` is used in this project.
        this._filters.push({ col, op: 'is', val });
        return this;
    }
    order(col, opts) {
        this._orders.push({ col, asc: !(opts && opts.ascending === false) });
        return this;
    }
    limit(n) {
        this._limit = n;
        return this;
    }
    single() {
        this._single = true;
        return this;
    }
    maybeSingle() {
        this._single = true;
        this._maybe = true;
        return this;
    }

    // ----- make the builder awaitable (PromiseLike), like supabase-js -----
    then(resolve, reject) {
        let res;
        try {
            res = this._execute();
        } catch (e) {
            res = {
                data: null,
                error: { message: e.message, code: e.code || 'SQLITE_ERROR', details: String(e.stack || '') },
                count: null,
            };
        }
        return Promise.resolve(res).then(resolve, reject);
    }
    catch(cb) {
        return this.then(undefined, cb);
    }
    finally(cb) {
        return this.then().finally(cb);
    }

    // ----- execution -----
    // `alias` qualifies WHERE columns with a table alias (e.g. 't.id') so that
    // columns shared with a joined table (like `id`, `created_at`) are never
    // ambiguous. Pass '' for plain UPDATE/DELETE which have no FROM alias.
    _buildWhere(alias = '') {
        const p = alias ? alias + '.' : '';
        const clauses = [];
        const params = [];
        for (const f of this._filters) {
            if (f.op === 'is') {
                clauses.push(`${p}${f.col} IS NULL`); // only null is ever used
            } else {
                clauses.push(`${p}${f.col} ${f.op} ?`);
                params.push(filterVal(this.table, f.col, f.val));
            }
        }
        return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
    }

    _execute() {
        switch (this._op) {
            case 'select':
                return this._execSelect();
            case 'insert':
                return this._execInsert();
            case 'update':
                return this._execUpdate();
            case 'delete':
                return this._execDelete();
            default:
                return { data: null, error: { message: 'unsupported op' } };
        }
    }

    _finishRows(rows) {
        if (this._single) {
            if (rows.length === 1) return { data: rows[0], error: null, count: 1 };
            return {
                data: null,
                error: {
                    code: 'PGRST116',
                    message:
                        rows.length === 0
                            ? 'JSON object requested, multiple (or no) rows returned (0 rows)'
                            : 'JSON object requested, multiple (or no) rows returned (' + rows.length + ' rows)',
                    details: 'Results contain ' + rows.length + ' rows',
                },
                count: rows.length,
            };
        }
        return { data: rows, error: null, count: rows.length };
    }

    _execSelect() {
        const t = this.table;
        const alias = 't';

        // count-only (head:true) -> SELECT COUNT(*)
        if (this._countMode && this._headMode) {
            const { sql: where, params } = this._buildWhere();
            const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}${where}`).get(...params);
            return { data: null, count: row.c, error: null };
        }

        const sel = parseSelect(this._selectStr);
        const exprs = [];
        const noBaseSpecified = !sel.baseAll && sel.baseCols.length === 0;
        if (sel.baseAll || noBaseSpecified) exprs.push(`${alias}.*`);
        for (const c of sel.baseCols) exprs.push(`${alias}.${c}`);

        const joinSqls = [];
        sel.joins.forEach((j, i) => {
            const ja = `j${i}`;
            // Every embedded join in this project is a to-one FK to users(id).
            joinSqls.push(`LEFT JOIN ${j.target} ${ja} ON ${ja}.id = ${alias}.${j.fk}`);
            for (const c of j.cols) exprs.push(`${ja}.${c} AS __join_${i}_${c}`);
        });

        if (sel.countEmbed) {
            // to-many embedded count, e.g. loading_versions(count) on loadings.
            const child = sel.countEmbed.target;
            exprs.push(
                `(SELECT COUNT(*) FROM ${child} WHERE ${child}.loading_id = ${alias}.id) AS __count_${child}`
            );
        }

        const { sql: where, params } = this._buildWhere(alias);
        let sql = `SELECT ${exprs.join(', ')} FROM ${t} ${alias}`;
        if (joinSqls.length) sql += ' ' + joinSqls.join(' ');
        sql += where;
        if (this._orders.length) {
            sql +=
                ' ORDER BY ' +
                this._orders.map((o) => `${alias}.${o.col} ${o.asc ? 'ASC' : 'DESC'}`).join(', ');
        }
        if (this._limit != null) sql += ` LIMIT ${parseInt(this._limit, 10)}`;

        const rawRows = this.db.prepare(sql).all(...params);
        const rows = rawRows.map((r) => this._hydrate(r, sel));
        return this._finishRows(rows);
    }

    _hydrate(raw, sel) {
        const base = {};
        const joinData = {};
        let countVal = 0;
        for (const k of Object.keys(raw)) {
            const jm = k.match(/^__join_(\d+)_(.+)$/);
            const cm = k.match(/^__count_(.+)$/);
            if (jm) {
                const idx = jm[1];
                (joinData[idx] = joinData[idx] || {})[jm[2]] = raw[k];
            } else if (cm) {
                countVal = raw[k];
            } else {
                base[k] = raw[k];
            }
        }
        const row = deserializeRow(this.table, base);
        sel.joins.forEach((j, i) => {
            const d = joinData[i];
            // PostgREST returns a nested object for a to-one relationship, or null.
            row[j.target] = d && Object.values(d).some((v) => v !== null && v !== undefined) ? d : null;
        });
        if (sel.countEmbed) {
            row[sel.countEmbed.target] = [{ count: countVal }];
        }
        return row;
    }

    _execInsert() {
        const t = this.table;
        const m = meta(t);
        const out = [];
        const run = this.db.transaction((rows) => {
            for (const r0 of rows) {
                const r = Object.assign({}, r0);
                if (!('id' in r) || r.id == null) r.id = crypto.randomUUID();
                if (m.createdAtCol && (!(m.createdAtCol in r) || r[m.createdAtCol] == null)) {
                    r[m.createdAtCol] = new Date().toISOString();
                }
                const cols = Object.keys(r);
                const vals = cols.map((c) => serialize(t, c, r[c]));
                const placeholders = cols.map(() => '?').join(', ');
                const sql =
                    `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})` +
                    (this._returning ? ' RETURNING *' : '');
                const stmt = this.db.prepare(sql);
                if (this._returning) out.push(stmt.get(...vals));
                else stmt.run(...vals);
            }
        });
        run(this._payload);
        if (!this._returning) return { data: null, error: null };
        const rows = out.map((r) => deserializeRow(t, r));
        return this._finishRows(rows);
    }

    _execUpdate() {
        const t = this.table;
        const obj = this._payload || {};
        const cols = Object.keys(obj);
        if (cols.length === 0) {
            return { data: this._returning ? [] : null, error: null };
        }
        const setSql = cols.map((c) => `${c} = ?`).join(', ');
        const setParams = cols.map((c) => serialize(t, c, obj[c]));
        const { sql: where, params: whereParams } = this._buildWhere();
        const sql = `UPDATE ${t} SET ${setSql}${where}` + (this._returning ? ' RETURNING *' : '');
        const stmt = this.db.prepare(sql);
        if (this._returning) {
            const rows = stmt.all(...setParams, ...whereParams).map((r) => deserializeRow(t, r));
            return this._finishRows(rows);
        }
        const info = stmt.run(...setParams, ...whereParams);
        return { data: null, error: null, count: info.changes };
    }

    _execDelete() {
        const t = this.table;
        const { sql: where, params } = this._buildWhere();
        const info = this.db.prepare(`DELETE FROM ${t}${where}`).run(...params);
        return { data: null, error: null, count: info.changes };
    }
}

// ---- the client ----------------------------------------------------------
function createClient(db) {
    return {
        from(table) {
            return new QueryBuilder(db, table);
        },
    };
}

module.exports = {
    createClient,
    deserializeRow,
    serialize,
    parseSelect,
    TABLE_META,
};
