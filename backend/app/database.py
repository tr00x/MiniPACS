import os
import aiosqlite
from pathlib import Path

DB_PATH = Path(os.environ.get("DATABASE_PATH", Path(__file__).parent.parent / "minipacs.db"))


async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                token_version INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                last_login TEXT
            );

            CREATE TABLE IF NOT EXISTS patient_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orthanc_patient_id TEXT NOT NULL,
                token TEXT UNIQUE NOT NULL,
                expires_at TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now')),
                is_active INTEGER DEFAULT 1,
                view_count INTEGER DEFAULT 0,
                first_viewed_at TEXT,
                last_viewed_at TEXT,
                pin_hash TEXT
            );

            CREATE TABLE IF NOT EXISTS pacs_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ae_title TEXT NOT NULL,
                ip TEXT NOT NULL,
                port INTEGER NOT NULL,
                description TEXT,
                is_active INTEGER DEFAULT 1,
                last_echo_at TEXT
            );

            CREATE TABLE IF NOT EXISTS transfer_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orthanc_study_id TEXT NOT NULL,
                pacs_node_id INTEGER REFERENCES pacs_nodes(id),
                initiated_by INTEGER REFERENCES users(id),
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                patient_token TEXT,
                action TEXT NOT NULL,
                resource_type TEXT,
                resource_id TEXT,
                ip_address TEXT,
                timestamp TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS external_viewers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT,
                url_scheme TEXT NOT NULL,
                is_enabled INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS study_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orthanc_study_id TEXT NOT NULL,
                title TEXT NOT NULL,
                report_type TEXT NOT NULL DEFAULT 'text',
                content TEXT,
                filename TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)
        await db.commit()

        # Migrations for existing databases
        try:
            await db.execute("ALTER TABLE pacs_nodes ADD COLUMN last_echo_at TEXT")
            await db.commit()
        except Exception:
            pass  # Column already exists

        try:
            await db.execute("ALTER TABLE patient_shares ADD COLUMN pin_hash TEXT")
            await db.commit()
        except Exception:
            pass  # Column already exists

        try:
            await db.execute("ALTER TABLE external_viewers ADD COLUMN description TEXT")
            await db.commit()
        except Exception:
            pass  # Column already exists

        try:
            await db.execute("ALTER TABLE external_viewers ADD COLUMN icon_key TEXT")
            await db.commit()
        except Exception:
            pass  # Column already exists

        # Seed default external viewers if none exist
        cursor = await db.execute("SELECT COUNT(*) FROM external_viewers")
        count = (await cursor.fetchone())[0]
        if count == 0:
            default_viewers = [
                ("OHIF Viewer", "/ohif/viewer?StudyInstanceUIDs={StudyInstanceUID}", 1, "Built-in web viewer", "ohif"),
                ("OsiriX", "osirix://open?StudyInstanceUID={StudyInstanceUID}", 0, "macOS DICOM viewer", "osirix"),
                ("Horos", "horos://open?StudyInstanceUID={StudyInstanceUID}", 0, "Free macOS DICOM viewer", "horos"),
                ("RadiAnt", "radiant://open?StudyInstanceUID={StudyInstanceUID}", 0, "Windows/Mac DICOM viewer", "radiant"),
                ("3D Slicer", "slicer://viewer/?StudyInstanceUID={StudyInstanceUID}", 0, "3D visualization platform", "slicer"),
                ("MicroDicom", "microdicom://open?StudyInstanceUID={StudyInstanceUID}", 0, "Free Windows DICOM viewer", "microdicom"),
                ("PostDICOM", "https://cloud.postdicom.com/viewer.html?StudyInstanceUID={StudyInstanceUID}", 0, "Cloud DICOM viewer", "postdicom"),
                ("MedDream", "https://demo.meddream.com/viewer/{StudyInstanceUID}", 0, "Web-based diagnostic viewer", "meddream"),
            ]
            for name, url_scheme, is_enabled, description, icon_key in default_viewers:
                await db.execute(
                    "INSERT INTO external_viewers (name, url_scheme, is_enabled, description, icon_key) VALUES (?, ?, ?, ?, ?)",
                    (name, url_scheme, is_enabled, description, icon_key),
                )
            await db.commit()
