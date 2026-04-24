"""Shared Redis-backed cache for Orthanc QIDO results.

Design:
  * One Redis key per cache entry, TTL ~ 10× the "fresh" window so that even
    well-past-TTL entries survive as stale-while-error fallback. Freshness is
    enforced in Python against a timestamp stored inside the value — Redis TTL
    only gates outright eviction.
  * Values are orjson-serialised Python objects. Non-JSON types must not reach
    this module; callers already hand us plain dicts/lists from Orthanc.
  * If REDIS_URL is unset or Redis is unreachable at startup, the module drops
    to a local dict cache with the same API. Every production PACS machine
    will run Redis, but dev boxes and unit-style smoke tests should not hard
    require it, and a Redis crash mid-shift must not 502 the worklist.
  * Invalidation walks all keys under our prefix with SCAN (non-blocking) and
    deletes in pipelines of ~500 — safe even with tens of thousands of entries
    on the cold side.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import orjson

log = logging.getLogger(__name__)

KEY_PREFIX = "minipacs:qido:"
STALE_TTL_SECONDS = 600  # outer envelope; freshness gate is per-call


try:
    from redis.asyncio import Redis  # type: ignore[import-not-found]
    from redis.exceptions import RedisError  # type: ignore[import-not-found]
    _REDIS_AVAILABLE = True
except Exception:  # pragma: no cover - library absent, dev fallback
    Redis = None  # type: ignore[assignment,misc]
    RedisError = Exception  # type: ignore[misc,assignment]
    _REDIS_AVAILABLE = False


_redis: "Redis | None" = None
_memory: dict[str, tuple[float, bytes]] = {}
_memory_lock = asyncio.Lock()


async def init_cache(redis_url: str | None) -> None:
    """Connect to Redis if a URL is configured; otherwise stay on memory.

    Never raises — a bad URL or unreachable Redis falls through to the memory
    backend so the API keeps working. Call once in the FastAPI lifespan.
    """
    global _redis
    _redis = None
    if not redis_url or not _REDIS_AVAILABLE:
        log.info("cache: using in-memory backend (redis_url=%s, lib=%s)",
                 bool(redis_url), _REDIS_AVAILABLE)
        return
    try:
        client = Redis.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=False,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
            health_check_interval=30,
        )
        await client.ping()
        _redis = client
        log.info("cache: connected to redis at %s", redis_url)
    except Exception as exc:
        log.warning("cache: redis unreachable at %s (%s) — falling back to memory", redis_url, exc)
        _redis = None


async def close_cache() -> None:
    global _redis
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None


def _make_key(namespace: str, parts: tuple) -> str:
    # Keep the raw tuple repr — same process class, no hashing collisions
    # worth worrying about for 32-entry cache cohorts.
    return f"{KEY_PREFIX}{namespace}:{repr(parts)}"


def _pack(value: Any) -> bytes:
    return orjson.dumps({"ts": time.time(), "v": value})


def _unpack(blob: bytes) -> tuple[float, Any] | None:
    try:
        obj = orjson.loads(blob)
        return float(obj["ts"]), obj["v"]
    except Exception:
        return None


async def get(namespace: str, parts: tuple, fresh_ttl: float) -> tuple[Any, bool] | None:
    """Return (value, is_fresh) or None if nothing is cached.

    is_fresh=True  →  timestamp inside value is within fresh_ttl seconds
    is_fresh=False →  value is past fresh_ttl but still within STALE_TTL_SECONDS
    """
    key = _make_key(namespace, parts)
    blob = await _raw_get(key)
    if blob is None:
        return None
    parsed = _unpack(blob)
    if parsed is None:
        return None
    ts, value = parsed
    is_fresh = (time.time() - ts) < fresh_ttl
    return value, is_fresh


async def set(namespace: str, parts: tuple, value: Any) -> None:
    key = _make_key(namespace, parts)
    blob = _pack(value)
    await _raw_set(key, blob, STALE_TTL_SECONDS)


async def invalidate_namespace(*namespaces: str) -> int:
    """Delete all cached entries under given namespaces. Returns count removed."""
    if _redis is not None:
        total = 0
        try:
            for ns in namespaces:
                pattern = f"{KEY_PREFIX}{ns}:*"
                batch: list[bytes] = []
                async for k in _redis.scan_iter(match=pattern, count=500):
                    batch.append(k)
                    if len(batch) >= 500:
                        total += await _redis.delete(*batch)
                        batch.clear()
                if batch:
                    total += await _redis.delete(*batch)
            return int(total)
        except RedisError as exc:
            log.warning("cache: redis SCAN failed (%s) — falling back to memory sweep", exc)

    async with _memory_lock:
        prefixes = tuple(f"{KEY_PREFIX}{ns}:" for ns in namespaces)
        victims = [k for k in _memory if k.startswith(prefixes)]
        for k in victims:
            _memory.pop(k, None)
        return len(victims)


async def _raw_get(key: str) -> bytes | None:
    if _redis is not None:
        try:
            return await _redis.get(key)
        except RedisError as exc:
            log.debug("cache: redis GET failed (%s) — memory fallback", exc)
    async with _memory_lock:
        hit = _memory.get(key)
        if hit is None:
            return None
        expires_at, blob = hit
        if time.time() > expires_at:
            _memory.pop(key, None)
            return None
        return blob


async def _raw_set(key: str, blob: bytes, ttl: int) -> None:
    if _redis is not None:
        try:
            await _redis.set(key, blob, ex=ttl)
            return
        except RedisError as exc:
            log.debug("cache: redis SET failed (%s) — memory fallback", exc)
    async with _memory_lock:
        _memory[key] = (time.time() + ttl, blob)
        if len(_memory) > 1024:
            # FIFO eviction; cache is bounded to prevent unbounded growth in
            # the degraded no-redis mode.
            _memory.pop(next(iter(_memory)))
