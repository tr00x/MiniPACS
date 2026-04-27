"""Schema bootstrap for the MiniPACS backend on PostgreSQL.

The backend shares Orthanc's PG instance (and database) — our table
names do not overlap with Orthanc's internal schema, so no extra DB
or role is needed. Connection management lives in `app/db.py`.
"""

from __future__ import annotations

from app.db import pool, get_db  # re-export for existing imports


SCHEMA_SQL = """
-- Trusted extension since PG 13: lets the database owner enable it without
-- superuser. Used by ops to diagnose slow queries (SELECT ... FROM
-- pg_stat_statements ORDER BY mean_exec_time DESC). Free fixed cost.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    token_version INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS patient_shares (
    id SERIAL PRIMARY KEY,
    orthanc_patient_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    is_active INTEGER DEFAULT 1,
    view_count INTEGER DEFAULT 0,
    first_viewed_at TIMESTAMPTZ,
    last_viewed_at TIMESTAMPTZ,
    pin_hash TEXT
);

CREATE TABLE IF NOT EXISTS pacs_nodes (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    ae_title TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    last_echo_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transfer_log (
    id SERIAL PRIMARY KEY,
    orthanc_study_id TEXT NOT NULL,
    pacs_node_id INTEGER REFERENCES pacs_nodes(id),
    initiated_by INTEGER REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    patient_token TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip_address TEXT,
    timestamp TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS external_viewers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    url_scheme TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    description TEXT,
    icon_key TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_reports (
    id SERIAL PRIMARY KEY,
    orthanc_study_id TEXT NOT NULL,
    title TEXT NOT NULL,
    report_type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    filename TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Idempotent TEXT → TIMESTAMPTZ migration. Old installs were created with
-- TEXT timestamp columns (lex-sortable ISO 8601 string). New installs hit
-- the CREATE TABLE definitions above and skip the type-conversion. The
-- second pass reasserts the correct default state — covers the case where
-- a previous migration over-applied DEFAULT now() to columns that should
-- be nullable on insert (e.g. expires_at, completed_at, *_viewed_at).
DO $$
DECLARE
    -- Columns whose canonical default is now() (write timestamps).
    insert_defaults CONSTANT text[] := ARRAY[
        'users.created_at',
        'patient_shares.created_at',
        'transfer_log.created_at',
        'audit_log.timestamp',
        'settings.updated_at',
        'study_reports.created_at'
    ];
    -- Columns that must stay NULL until explicitly populated. Forcing
    -- DEFAULT now() here would silently expire patient links / mark
    -- transfers as completed at insert time.
    null_defaults CONSTANT text[] := ARRAY[
        'users.last_login',
        'patient_shares.expires_at',
        'patient_shares.first_viewed_at',
        'patient_shares.last_viewed_at',
        'pacs_nodes.last_echo_at',
        'transfer_log.completed_at'
    ];
    spec text;
    tbl  text;
    col  text;
BEGIN
    -- Pass 1: convert any remaining TEXT columns to TIMESTAMPTZ. The
    -- DROP DEFAULT step is required because PG would otherwise try to
    -- cast the legacy to_char()-text default into timestamptz and bail
    -- with DatatypeMismatchError.
    FOREACH spec IN ARRAY (insert_defaults || null_defaults) LOOP
        tbl := split_part(spec, '.', 1);
        col := split_part(spec, '.', 2);
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = tbl
               AND column_name = col
               AND data_type = 'text'
        ) THEN
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', tbl, col);
            EXECUTE format(
                'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I::TIMESTAMPTZ',
                tbl, col, col
            );
        END IF;
    END LOOP;

    -- Pass 2: reassert correct defaults. Idempotent — re-runs are a no-op.
    FOREACH spec IN ARRAY insert_defaults LOOP
        tbl := split_part(spec, '.', 1);
        col := split_part(spec, '.', 2);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT now()', tbl, col);
    END LOOP;
    FOREACH spec IN ARRAY null_defaults LOOP
        tbl := split_part(spec, '.', 1);
        col := split_part(spec, '.', 2);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', tbl, col);
    END LOOP;
END$$;

CREATE INDEX IF NOT EXISTS idx_study_reports_sid ON study_reports(orthanc_study_id);
CREATE INDEX IF NOT EXISTS idx_patient_shares_pid ON patient_shares(orthanc_patient_id);
CREATE INDEX IF NOT EXISTS idx_transfer_log_sid ON transfer_log(orthanc_study_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(timestamp);
-- Dashboard polls /api/transfers + /api/dashboard every 5-15s, ordering
-- transfer_log by created_at DESC. Without this index, even LIMIT 25 forces
-- a full Seq Scan + heapsort on the whole table (2.5 ms on 10k rows in
-- audit, scales linearly).
CREATE INDEX IF NOT EXISTS idx_transfer_log_created_at ON transfer_log(created_at DESC);
-- Partial index for login-rate-limit checks (auth.py:_check_rate_limit).
-- Failed logins are <1% of audit_log writes, so the index stays tiny while
-- giving brute-force checks O(log n) instead of bitmap-recheck on the
-- generic timestamp index.
CREATE INDEX IF NOT EXISTS idx_audit_log_login_failed
    ON audit_log(ip_address, timestamp DESC)
    WHERE action = 'login_failed';
-- Dashboard "failed transfers" badge polls SELECT COUNT(*) FROM transfer_log
-- WHERE status = 'failed'. Partial index covers only the rows that matter
-- (10-20 % of the table at worst) so the badge stays sub-ms even at 100 k+
-- transfers logged.
CREATE INDEX IF NOT EXISTS idx_transfer_log_status
    ON transfer_log(status, created_at DESC)
    WHERE status IN ('failed', 'pending');
-- audit_log filter by action+time (e.g. /api/audit-log?action=login). Becomes
-- the dominant cost once audit_log crosses ~100 k rows; cheap to add now.
CREATE INDEX IF NOT EXISTS idx_audit_log_action_time
    ON audit_log(action, timestamp DESC);

-- Persisted import jobs — replace in-memory _jobs dict so jobs survive
-- backend restarts and are visible across browser tabs / devices.
CREATE TABLE IF NOT EXISTS import_jobs (
    job_id              TEXT PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              TEXT NOT NULL,
    total_files         INTEGER NOT NULL DEFAULT 0,
    processed           INTEGER NOT NULL DEFAULT 0,
    failed              INTEGER NOT NULL DEFAULT 0,
    new_instances       INTEGER NOT NULL DEFAULT 0,
    duplicate_instances INTEGER NOT NULL DEFAULT 0,
    study_ids           TEXT[] NOT NULL DEFAULT '{}',
    errors              TEXT[] NOT NULL DEFAULT '{}',
    current_file        TEXT NOT NULL DEFAULT '',
    upload_ids          TEXT[] NOT NULL DEFAULT '{}',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user_active
    ON import_jobs (user_id) WHERE finished_at IS NULL;

-- File-level dedup: SHA-256 of the raw bytes user uploaded (a .dcm, a
-- .zip, an .iso). Lets precheck answer "we have this exact file" before
-- the user pays bandwidth for a duplicate transfer.
CREATE TABLE IF NOT EXISTS import_file_hashes (
    sha256          CHAR(64) PRIMARY KEY,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    instance_count  INTEGER NOT NULL DEFAULT 0,
    study_ids       TEXT[] NOT NULL DEFAULT '{}'
);
"""


_DEFAULT_VIEWERS = [
    ("OHIF Viewer",
     "/ohif/viewer?url=/orthanc/studies/{study_id}/ohif-dicom-json",
     1,
     "Built-in web viewer (Orthanc OHIF plugin, dicom-json datasource)",
     "ohif"),
    ("Stone Web Viewer",
     "/stone-webviewer/index.html?study={StudyInstanceUID}",
     1,
     "Native WASM viewer by Orthanc team",
     "stone"),
    ("OsiriX",
     "osirix://open?StudyInstanceUID={StudyInstanceUID}",
     0, "macOS DICOM viewer", "osirix"),
    ("Horos",
     "horos://open?StudyInstanceUID={StudyInstanceUID}",
     0, "Free macOS DICOM viewer", "horos"),
    ("RadiAnt",
     "radiant://open?StudyInstanceUID={StudyInstanceUID}",
     0, "Windows/Mac DICOM viewer", "radiant"),
    ("3D Slicer",
     "slicer://viewer/?StudyInstanceUID={StudyInstanceUID}",
     0, "3D visualization platform", "slicer"),
    ("MicroDicom",
     "microdicom://open?StudyInstanceUID={StudyInstanceUID}",
     0, "Free Windows DICOM viewer", "microdicom"),
    ("PostDICOM",
     "https://cloud.postdicom.com/viewer.html?StudyInstanceUID={StudyInstanceUID}",
     0, "Cloud DICOM viewer", "postdicom"),
    ("MedDream",
     "https://demo.meddream.com/viewer/{StudyInstanceUID}",
     0, "Web-based diagnostic viewer", "meddream"),
]


async def init_db() -> None:
    """Create tables, migrate legacy columns, seed viewers.

    Runs on every backend boot; idempotent. Uses IF NOT EXISTS for DDL
    and ON CONFLICT DO NOTHING for viewer seeding so a restart on a
    warm database is a fast no-op.
    """
    p = pool()
    async with p.acquire() as conn:
        # Schema + indexes.
        await conn.execute(SCHEMA_SQL)

        # Rewrite any legacy OHIF viewer URL to the plugin's dicom-json form.
        # Covers installs migrated from SQLite where the earlier URL shapes
        # (StudyInstanceUIDs=... or the broken ../studies/... relative form)
        # are still persisted.
        await conn.execute(
            """UPDATE external_viewers
               SET url_scheme = $1, description = $2
               WHERE name = $3 AND url_scheme NOT LIKE $4""",
            "/ohif/viewer?url=/orthanc/studies/{study_id}/ohif-dicom-json",
            "Built-in web viewer (Orthanc OHIF plugin, dicom-json datasource)",
            "OHIF Viewer",
            "%/orthanc/studies/%",
        )

        # Seed defaults only when the table is empty.
        count = await conn.fetchval("SELECT COUNT(*) FROM external_viewers")
        if (count or 0) == 0:
            for name, url_scheme, is_enabled, description, icon_key in _DEFAULT_VIEWERS:
                await conn.execute(
                    """INSERT INTO external_viewers
                       (name, url_scheme, is_enabled, description, icon_key)
                       VALUES ($1, $2, $3, $4, $5)""",
                    name, url_scheme, is_enabled, description, icon_key,
                )


# Back-compat re-export: old modules did `from app.database import get_db`
__all__ = ["init_db", "get_db", "pool"]
