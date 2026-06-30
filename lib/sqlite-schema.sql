-- =============================================
-- نظام إدارة التحميل - Yükleme Belgesi
-- SQLite schema (mirrors the live Supabase/Postgres schema 1:1)
-- =============================================
--
-- Type mapping notes (Postgres -> SQLite):
--   UUID         -> TEXT   (same uuid string is preserved on migration)
--   JSONB        -> TEXT   (JSON.stringify on write / JSON.parse on read, done in the adapter)
--   TEXT[]       -> TEXT   (stored as a JSON array string)
--   BOOLEAN      -> INTEGER 0/1
--   TIMESTAMPTZ  -> TEXT   (ISO-8601 string, exactly what new Date().toISOString() produces)
--   DATE / TIME  -> TEXT   (kept as the same string the HTML form sends)
--
-- created_at / archived_at are populated by the adapter (new Date().toISOString())
-- to match the exact format the app already produces, so we do NOT use a SQL DEFAULT here.

-- 1) users ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('loader', 'manager')),
    created_at TEXT
);

-- 2) loadings ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loadings (
    id                       TEXT PRIMARY KEY,

    -- Team info
    manager                  TEXT,
    worker1                  TEXT,
    worker2                  TEXT,
    worker3                  TEXT,
    worker4                  TEXT,

    -- Vehicle info
    plate1                   TEXT,
    plate2                   TEXT,
    container_no             TEXT,
    loading_date             TEXT,

    -- Weight / destination
    product_weight           TEXT,
    vehicle_weight_after     TEXT,
    destination_company      TEXT,
    destination_country      TEXT,
    destination_customer     TEXT,

    -- Driver info
    driver_name              TEXT,
    driver_phone             TEXT,
    forklift_operator        TEXT,

    -- Products (JSON array string)
    products                 TEXT DEFAULT '[]',

    -- Documentation (JSON array strings of photo URLs)
    goods_photos             TEXT DEFAULT '[]',
    damaged_goods_photos     TEXT DEFAULT '[]',
    scale_receipt_photo      TEXT,
    loaded_vehicle_photos    TEXT DEFAULT '[]',

    -- Times
    entry_time               TEXT,
    exit_time                TEXT,

    -- Comments
    comments                 TEXT,

    -- Recording status
    is_recorded              INTEGER DEFAULT 0,
    recorded_at              TEXT,
    recorded_by              TEXT,
    safwat_recorded_at       TEXT,
    pinar_recorded_at        TEXT,

    -- View tracking
    viewed_at                TEXT,

    -- Publication / archival
    is_draft                 INTEGER DEFAULT 0,
    is_archived              INTEGER DEFAULT 0,

    -- Paper workflow
    paper_delivered_at       TEXT,
    paper_confirmed_at       TEXT,

    -- Improvement (QA) request
    needs_improvement_at     TEXT,
    needs_improvement_by     TEXT,
    needs_improvement_reason TEXT,

    -- Metadata
    created_by               TEXT,
    created_at               TEXT
);

-- 3) loading_versions (history snapshots) -----------------------------------
CREATE TABLE IF NOT EXISTS loading_versions (
    id             TEXT PRIMARY KEY,
    loading_id     TEXT,
    version_number INTEGER NOT NULL,
    data           TEXT NOT NULL,          -- JSON snapshot of the full loadings row
    archived_at    TEXT,
    archived_by    TEXT,
    FOREIGN KEY (loading_id) REFERENCES loadings(id) ON DELETE CASCADE,
    UNIQUE (loading_id, version_number)
);

-- 4) Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_loadings_created   ON loadings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loadings_archived  ON loadings(is_archived, is_draft);
CREATE INDEX IF NOT EXISTS idx_versions_loading   ON loading_versions(loading_id);
-- Enforce one row per (loading_id, version_number) on EXISTING databases too
-- (the CREATE TABLE UNIQUE only applies to freshly-created tables). Safe:
-- current data has no duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_versions_loading_num ON loading_versions(loading_id, version_number);
