"""Live worklist feed — WebSocket fan-out + internal event ingress.

Flow: Orthanc Python plugin posts to /api/internal/events/new-study when a
study becomes STABLE → we bust the QIDO cache → broadcast a tiny JSON
notification to every connected browser → React Query invalidates
['studies'] and re-fetches the visible page.

One uvicorn worker per container today, so a plain in-process set of
connections is enough. If we scale to multiple workers later, swap the
connection manager for a Redis pub/sub fan-out (keys already namespaced).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect, status

from app.services.auth import decode_token
from app.services.orthanc import invalidate_study_caches

log = logging.getLogger(__name__)
router = APIRouter()


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> int:
        """Send message to every live client. Dead sockets are dropped silently."""
        async with self._lock:
            clients = list(self._clients)
        sent = 0
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_json(message)
                sent += 1
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
        return sent


_manager = ConnectionManager()


@router.websocket("/api/ws/studies")
async def ws_studies(websocket: WebSocket, token: str = ""):
    """Browser subscribes after login. Token is a standard access JWT passed
    via query string (browsers cannot set Authorization header on a WS open)."""
    payload = decode_token(token) if token else None
    if not payload or payload.get("type") != "access":
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await _manager.connect(websocket)
    try:
        while True:
            # We only push; client messages are ignored, but we still await
            # to keep the socket alive and detect disconnects. aioHTTP-style
            # idle ping is handled by the ASGI server.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("ws_studies terminated: %s", exc)
    finally:
        await _manager.disconnect(websocket)


def _internal_token() -> str:
    """Shared secret used by the Orthanc plugin to authenticate its POSTs.

    Kept distinct from SECRET_KEY so we can rotate without forcing users to
    re-login. Defaults to a value that only works in-container when both
    sides read the same env — prod MUST set INTERNAL_EVENT_TOKEN explicitly.
    """
    return os.environ.get("INTERNAL_EVENT_TOKEN", "")


@router.post("/api/internal/events/new-study", include_in_schema=False)
async def internal_new_study(
    payload: dict,
    request: Request,
    x_internal_token: str = Header(default=""),
):
    expected = _internal_token()
    if not expected or x_internal_token != expected:
        raise HTTPException(status_code=403, detail="forbidden")

    # Only accept from the internal docker network — belt and braces on top
    # of the shared-secret check. Rejects if somebody accidentally exposes
    # the backend port to the LAN with a misconfigured reverse proxy.
    client_ip = (request.client.host if request.client else "") or ""
    if not (client_ip.startswith("172.") or client_ip.startswith("10.") or client_ip == "127.0.0.1" or client_ip.startswith("192.168.")):
        raise HTTPException(status_code=403, detail="external origin")

    await invalidate_study_caches()
    study_id = payload.get("study_id") or payload.get("ID") or ""
    message = {
        "type": "new-study",
        "study_id": study_id,
    }
    # Include a few tags if the plugin sent them, so the UI can render a
    # toast without a round-trip. Cheap — Orthanc already has them.
    for k in ("patient_name", "study_description", "modalities", "study_date"):
        if k in payload:
            message[k] = payload[k]
    delivered = await _manager.broadcast(message)
    log.info("new-study broadcast: study_id=%s delivered_to=%d", study_id[:12], delivered)
    return {"delivered": delivered}
