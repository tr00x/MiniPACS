from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.models.reports import ReportCreate, ReportUpdate
from app.routers.auth import get_current_user
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("")
async def list_reports(
    request: Request,
    study_id: str = None,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    await log_audit("list_reports", user_id=user["id"], ip_address=request.client.host)
    if study_id:
        cursor = await db.execute(
            """SELECT r.*, u.username as created_by_username
               FROM study_reports r
               LEFT JOIN users u ON r.created_by = u.id
               WHERE r.orthanc_study_id = ?
               ORDER BY r.created_at DESC""",
            (study_id,),
        )
    else:
        cursor = await db.execute(
            """SELECT r.*, u.username as created_by_username
               FROM study_reports r
               LEFT JOIN users u ON r.created_by = u.id
               ORDER BY r.created_at DESC""",
        )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


@router.post("", status_code=201)
async def create_report(
    body: ReportCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute(
        """INSERT INTO study_reports (orthanc_study_id, title, report_type, content, filename, created_by)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (body.orthanc_study_id, body.title, body.report_type, body.content, body.filename, user["id"]),
    )
    await db.commit()
    report_id = cursor.lastrowid
    await log_audit(
        "create_report", "report", str(report_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )
    cursor = await db.execute(
        """SELECT r.*, u.username as created_by_username
           FROM study_reports r
           LEFT JOIN users u ON r.created_by = u.id
           WHERE r.id = ?""",
        (report_id,),
    )
    return dict(await cursor.fetchone())


@router.delete("/{report_id}", status_code=204)
async def delete_report(
    report_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM study_reports WHERE id = ?", (report_id,))
    if not await cursor.fetchone():
        raise HTTPException(404, "Report not found")
    await db.execute("DELETE FROM study_reports WHERE id = ?", (report_id,))
    await db.commit()
    await log_audit(
        "delete_report", "report", str(report_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )
