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
