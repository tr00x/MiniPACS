"""Real-browser benchmark for MiniPACS: login -> open study -> wait for viewer image.

Runs headless Chromium against the public URL (so CF tunnel latency is included).
Captures phase-by-phase timing plus a network-request summary so we can see which
specific calls are slow from a real browser's perspective, not just server-side curl.

Usage (inside mcr.microsoft.com/playwright/python):
  python scripts/pw_bench.py <study_id>
"""
import asyncio
import os
import sys
import time
from collections import defaultdict

from playwright.async_api import async_playwright

URL = os.environ.get("PW_URL", "https://pacs.clintonmedical.net")
USERNAME = "admin"
PASSWORD = "minipac2026"
STUDY_ID = sys.argv[1] if len(sys.argv) > 1 else "0a09bfbc-3fe97d69-c7f1b83e-0d9844af-b133e3b0"


def bucket(url: str) -> str:
    if "/dicom-web/" in url:
        if "/frames/" in url:
            return "dicomweb-frame"
        if "/metadata" in url:
            return "dicomweb-metadata"
        if "/series" in url:
            return "dicomweb-series"
        if "/studies" in url:
            return "dicomweb-studies"
        return "dicomweb-other"
    if "/api/" in url:
        return "api"
    if "/ohif/" in url or "/stone-webviewer/" in url:
        if url.endswith(".js") or ".js?" in url or ".js/" in url:
            return "viewer-js"
        if url.endswith(".css") or ".css?" in url:
            return "viewer-css"
        if url.endswith(".wasm") or ".wasm?" in url:
            return "viewer-wasm"
        return "viewer-other"
    if "cloudflareinsights" in url:
        return "cf-insights"
    return "other"


async def run():
    phases = {}
    t0 = time.monotonic()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()

        net_stats = defaultdict(lambda: {"count": 0, "total_ms": 0.0, "max_ms": 0.0, "total_bytes": 0})
        t_start = {}

        page.on("request", lambda req: t_start.__setitem__(req.url, time.monotonic()))

        async def on_response(resp):
            url = resp.url
            if url not in t_start:
                return
            dt = (time.monotonic() - t_start.pop(url)) * 1000
            b = bucket(url)
            s = net_stats[b]
            s["count"] += 1
            s["total_ms"] += dt
            s["max_ms"] = max(s["max_ms"], dt)
            try:
                body = await resp.body()
                s["total_bytes"] += len(body)
            except Exception:
                pass

        page.on("response", lambda resp: asyncio.create_task(on_response(resp)))

        errors: list[str] = []
        page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
        page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}  LOC={msg.location}") if msg.type in ("error", "warning") else None)
        page.on("requestfailed", lambda req: errors.append(f"requestfailed: {req.url} — {req.failure}"))

        # --- phase 1: home + login page ---
        t = time.monotonic()
        await page.goto(URL, wait_until="networkidle", timeout=60000)
        phases["1_home"] = time.monotonic() - t

        # --- phase 2: login ---
        t = time.monotonic()
        await page.fill('input[name="username"], input#username, input[type="text"]', USERNAME)
        await page.fill('input[name="password"], input#password, input[type="password"]', PASSWORD)
        await page.click('button[type="submit"]')
        await page.wait_for_url("**/", timeout=30000)
        await page.wait_for_load_state("networkidle", timeout=30000)
        phases["2_login"] = time.monotonic() - t

        # --- phase 3: navigate to study detail ---
        t = time.monotonic()
        await page.goto(f"{URL}/studies/{STUDY_ID}", wait_until="networkidle", timeout=60000)
        phases["3_study_detail"] = time.monotonic() - t

        # --- phase 4: wait for embedded viewer iframe to mount + first image ---
        t = time.monotonic()
        def is_viewer(url: str) -> bool:
            return "/ohif/viewer" in url or "/stone-webviewer/" in url
        try:
            frame = next((fr for fr in page.frames if is_viewer(fr.url)), None)
            if frame is None:
                iframe_el = await page.wait_for_selector(
                    'iframe[src*="/stone-webviewer/"], iframe[src*="/ohif/viewer"]',
                    timeout=30000,
                )
                frame = await iframe_el.content_frame()
                await frame.wait_for_load_state("load", timeout=30000)
            await frame.wait_for_function(
                "() => Array.from(document.querySelectorAll('canvas')).some(c => c.width > 0 && c.height > 0)",
                timeout=60000,
            )
        except Exception as exc:
            phases["4_viewer_first_image"] = -1
            phases["4_error"] = str(exc)[:200]
        else:
            phases["4_viewer_first_image"] = time.monotonic() - t

        total = time.monotonic() - t0

        try:
            for fr in page.frames:
                if is_viewer(fr.url):
                    print()
                    print(f"=== iframe {fr.url}  —  last 500 chars ===")
                    print(await fr.evaluate("document.body.innerText.slice(-500)"))
                    break
        except Exception as exc:
            print(f"iframe dump failed: {exc}")

        await browser.close()

    if errors:
        print()
        print(f"=== browser errors/warnings ({len(errors)}) ===")
        for e in errors[:25]:
            print(f"  {e[:250]}")

    print("=== phase timings (seconds) ===")
    for k, v in phases.items():
        if isinstance(v, float):
            print(f"  {k:35s} {v:.2f}s")
        else:
            print(f"  {k:35s} {v}")
    print(f"  {'total':35s} {total:.2f}s")

    print()
    print("=== network buckets (n, sum_ms, max_ms, KB) ===")
    for b, s in sorted(net_stats.items(), key=lambda kv: -kv[1]["total_ms"]):
        print(f"  {b:25s} n={s['count']:>3}  sum={s['total_ms']:>8.0f}ms  "
              f"max={s['max_ms']:>7.0f}ms  {s['total_bytes']/1024:>8.0f}KB")


if __name__ == "__main__":
    asyncio.run(run())
