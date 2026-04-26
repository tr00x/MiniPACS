# Phase 4 — experimental performance work (POC before prod)

Two deferred items from the rocket-design spec. Both are marked
"requires staging POC" — enabling either on production without first
validating locally on a representative DICOM set risks breaking Stone
rendering for the whole archive. Procedure is the same for both:
reproduce in local docker, compare measured metrics, then decide.

---

## 4.1 HTJ2K progressive rendering

### What it changes

Orthanc trans-codes stored DICOM on demand into **JPEG 2000 High Throughput**
(`1.2.840.10008.1.2.4.201`, lossless) when the client asks for it via
WADO-RS `Accept`. Stone Web Viewer 3.0 (Dec 2025) renders HTJ2K frames
**progressively** — first low-res pass is visible within the first few KB
of a frame, full quality arrives after the tail of the stream. On 500-
slice MRs the subjective "time to first usable image" collapses from
seconds to fractions of a second.

Frames on disk are untouched — only the WADO-RS output path changes.
Rollback is a config revert + Orthanc restart.

### Why it's not on by default

1. **Stone 3.0 progressive path is young.** Docs claim support; there is
   no track record on mixed archives of CT / MR / CR that match the
   pilot clinic mix. A rendering bug that only shows on certain
   transfer syntaxes would be invisible until radiologist #3 opens the
   wrong study.
2. **GDCM transcoder CPU cost.** First request for a frame pays the
   transcode. On high-traffic study opens (new case, multi-series MR)
   the CPU fan spin-up during ingest is avoidable until we're sure the
   UX win is real.

### POC procedure (local docker)

```bash
# 1. Pick 5–10 representative DICOMs from prod. Types to include:
#    - 1 single-frame CR
#    - 1 multi-frame CT (≥100 slices)
#    - 1 multi-frame MR (≥200 slices)
#    - 1 US cine
#    - 1 Mammo (large pixel buffer)
#
#    Copy them to the local Mac into e.g. ~/minipacs/poc-dicom/
#    (C-STORE them via storescu to local:48924 after `docker compose up -d`)

# 2. Add the transcoding block to `orthanc/orthanc-docker.json`:
#    Insert inside the existing JSON, at the top level:
#
#      "DicomWeb": {
#          ...existing keys stay...
#          "EnableWado": true,
#          "//-transcoding-": "Phase 4 POC — HTJ2K progressive.",
#          "IngestTranscoding": "",
#          "PreferredTransferSyntax": "1.2.840.10008.1.2.4.201"
#      }
#    Restart orthanc:  docker compose restart orthanc

# 3. Playwright timing — before-after on every sample study:
#    A. With HTJ2K off (baseline): `studyToFirstImage` via Stone.
#    B. With HTJ2K on: same metric.
#    Success criteria:
#      - Every study opens without a rendering error.
#      - Window/level + pan/zoom work identically.
#      - firstImage latency drops ≥40% on multi-slice studies.
#    Failure criteria:
#      - Any black frame, corrupted pixels, exception in Stone console.
#      - firstImage regresses on any study.
#      - Orthanc CPU sustained >80% on idle archive.

# 4. Rollback on any red:  revert the two JSON keys, restart orthanc.
```

### Production activation (only after POC green)

Same two-line config change in `orthanc/orthanc-docker.json`, `git commit`,
user does `git pull` + `docker compose restart orthanc` on prod. Monitor
via Stone on a known-good study before announcing to radiologists.

### POC results — 2026-04-24 (BLOCKED at encoder layer)

Ran the POC locally against 3 imported studies (LUMBAR MRI 28-slice T2 axial
series, LT SHOULDER MRI, LT FEMUR DX). After a first pass on the outdated
Jan-2026 image, pulled `orthancteam/orthanc:latest` (2026-04-23 build,
Orthanc 1.12.11, DicomWeb 1.23) and re-ran.

`GET /tools/accepted-transfer-syntaxes` NOW lists `1.2.840.10008.1.2.4.{201,202,203}`,
so the core has the **HTJ2K decoder** via OpenJPH — Orthanc can ingest and
read HTJ2K. But:

```
GET /instances/{id}/file?transcode=1.2.840.10008.1.2.4.201 → HTTP 404
GET /instances/{id}/file?transcode=1.2.840.10008.1.2.4.90  → OK, 140KB→73KB
```

The stock image ships the HTJ2K **decoder** but **not the encoder**. DicomWeb
WADO-RS correspondingly returns 400 "Unsupported transfer syntax in WADO-RS:
1.2.840.10008.1.2.4.201" — there's nothing to transcode legacy-compressed or
uncompressed DICOM with.

**Unlocking HTJ2K requires one of:**
1. Custom Orthanc image built with an OpenJPH encoder link (non-trivial
   dockerfile + build pipeline + ongoing maintenance).
2. Pre-ingest transcode via an external `dcm2dcm`-style OpenJPH tool —
   store already-HTJ2K DICOMs so Orthanc just serves stored bytes.
   Substantial pipeline work + batch re-transcode of the 5,000+ study
   archive.
3. Wait for an upstream orthancteam image that ships the encoder, or
   switch to commercial Orthanc Team premium images (may include it).

**Collateral POC win (already shipped):** same test confirmed the
`Transcode: 1.2.840.10008.1.2.4.90` (J2K Lossless, commit 9bdfa90) cuts
wire bytes **149 KB → 55 KB per MR instance = −63%** (curl-timed
`/dicom-web/.../instances/{id}` on a T2 axial slice). Not progressive, but
the bandwidth portion of the HTJ2K story is already delivered. On the
full 28-slice series, transcoded total is ~1.5 MB vs. ~4.2 MB native.

**Status:** HTJ2K parked. Reopen only when stock image ships an HTJ2K encoder
or we commit to maintaining a custom base image / pre-ingest pipeline. Progressive rendering is
the remaining unlock — not worth the build-maintenance tax until the
clinic explicitly asks for sub-second first-pixel on huge CT series we
don't currently have in the archive.

### POC results — 2026-04-26 (DEEPER FAIL than encoder layer)

Re-attempted HTJ2K with the assumption that pre-transcoding at ingest would unblock
both Stone and OHIF. Built a hand-rolled HTJ2K transcoder (`scripts/htj2k_repack.py`,
OpenJPH 0.27.0 via brew), pushed an HTJ2K instance into local Orthanc, then tested
all viewer-relevant paths via Playwright:

```
GET /dicom-web/.../instances/{HTJ2K-UID}/metadata           → 200 (metadata fine)
GET /dicom-web/.../instances/{HTJ2K-UID}/frames/1           → 500 "Not implemented yet"
GET /dicom-web/.../instances/{HTJ2K-UID}/frames/1/rendered  → 400 "Parameter out of range"
```

Stone console confirms its fallback chain: `"Trying to decode a compressed image
by transcoding it to Little Endian Explicit"` → `"Switching to server-side
transcoding"` → 500 from server → black canvas.

**Stock orthancteam/orthanc:latest has NO HTJ2K codec at all** — neither encoder
nor decoder. Memory observation 7341 ("Now Ships OpenJPH with 3 HTJ2K UIDs")
was misleading: Orthanc lists `1.2.840.10008.1.2.4.{201,202,203}` in
`/tools/accepted-transfer-syntaxes` only for INGEST validation, not for serving
or transcoding. The serving path on every endpoint (`/instances/{id}/file`,
`/dicom-web/.../frames/{n}`, Stone's transcode-to-LE fallback) lacks the codec.

**Implication:** Stone CANNOT render stored HTJ2K. OHIF CANNOT either.
Pre-transcoding at ingest is wasted unless we control the Orthanc image.

**Two real unlocks (and only two):**

1. **Custom Orthanc Docker image** linked against OpenJPH — fork
   `orthancteam/orthanc` Dockerfile, add `--with-openjph`, maintain rebuild
   on every upstream release. ~2-3 days first build, then ongoing churn.

2. **Wait for upstream** — the orthancteam team may bundle OpenJPH in a
   future release. No timeline.

**HTJ2K is dead in this codebase until one of those two ships.** Pivoting to
other speed wins (advanced-storage §4.2, prefetch, service-worker caching,
OHIF tuning per `docs/ohif-speedup.md`) — see `docs/superpowers/plans/2026-04-26-htj2k-baseline.md`
for the empirical record + the bonus bugs found en route (auth cookie,
local nginx Stone proxy missing).

Investigation artifacts (kept for the next attempt):
- `scripts/htj2k_repack.py` — pure-pydicom transcoder helper
- `scripts/htj2k_smoke.sh` — end-to-end reproducer
- `scripts/htj2k_wado_check.sh` — WADO-RS serving probe
- `docs/superpowers/plans/2026-04-26-htj2k-pipeline.md` — full plan (now superseded)
- `docs/superpowers/plans/2026-04-26-htj2k-baseline.md` — empirical results

---

## 4.2 orthanc-advanced-storage plugin (multi-tier)

### What it changes

Swaps Orthanc's single-directory storage for a tiered pipeline: hot
studies on a tmpfs (~4–6 GB RAM allocation), everything older on SSD.
WADO frames for the current worklist day return without touching disk;
archival studies pay the SSD read that already exists today.

Plugin is **official** (orthanc-team/orthanc-advanced-storage), the risk
isn't code quality — it's data migration. The plugin replaces the
storage layer, so the current 850+-study archive has to be moved into
the new tier layout. Done wrong (or interrupted mid-copy) you have a
torn archive.

### Why it's not on by default

1. **Migration is irreversible without a full backup.** Must `backup.sh`
   completely before activation.
2. **tmpfs budget on the clinic box is tight.** Windows → WSL2 memory
   allocation is shared with the other containers; over-committing tmpfs
   pushes backend / Orthanc index pages out of RAM and slows everything
   else.

### POC procedure (local docker)

```bash
# 1. Full backup of current local Orthanc — you WILL need to roll back
#    during experimentation:
bash scripts/backup.sh

# 2. Add plugin env var to docker-compose.yml in the orthanc service:
#      ADVANCED_STORAGE_PLUGIN_ENABLED: "true"
#    And mount a tmpfs volume to represent the hot tier:
#      tmpfs:
#        - /var/lib/orthanc/hot:size=4g,mode=755

# 3. Add to orthanc-docker.json top level:
#      "AdvancedStorage": {
#          "Enable": true,
#          "MultipleStoragesSettings": {
#              "hot": "/var/lib/orthanc/hot",
#              "cold": "/var/lib/orthanc/db"
#          },
#          "DefaultStorage": "hot",
#          "DelayedDeletion": {
#              "Enable": true,
#              "ThrottleDelayMs": 0
#          }
#      }

# 4. docker compose restart orthanc — plugin migrates existing storage
#    into the tier layout on first boot. Watch `docker compose logs
#    orthanc` for "advanced-storage: migration complete" or equivalent.

# 5. Time 10 cold-opens (first access after boot) of a study that lives
#    in hot tier vs cold. Expected:
#      - Hot-tier frame fetch: indistinguishable from RAM.
#      - Cold-tier frame fetch: same as today.
#      - No errors in Orthanc log, no missing frames in Stone.

# 6. Rollback: disable env var + config block, restart — plugin honors
#    `DefaultStorage` to re-unify. Keep backup from step 1 in case of
#    a torn migration.
```

### Production activation

**Never** without (a) a successful local POC on ≥1 week of ingest +
bulk open simulation, and (b) a fresh `backup.sh` produced immediately
before activation. The plugin's migration happens in-place; aborting
mid-run is exactly the scenario that leaves the archive inconsistent.

---

## Order of operations (if we do Phase 4 at all)

1. **HTJ2K first** — config-only, no data migration, trivial rollback.
2. **Only if HTJ2K delivers measurable win** → consider advanced-storage.
   The cold-open improvement from HTJ2K may subsume the need for hot-
   tier caching (Stone progressive rendering + SSD-fast read beats
   tmpfs when the transcode dominates latency, not the disk read).
3. Never activate either without a full backup and Playwright
   before/after numbers on the same study set.
