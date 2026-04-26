# HTJ2K Latency Baseline (2026-04-26)

Tracks the verdicts and measurements that drive Task 3.1 / Phase 3 of the HTJ2K
end-to-end pipeline plan (`2026-04-26-htj2k-pipeline.md`).

## WADO-RS HTJ2K serving (Task 0.3 result, 2026-04-26)

Test instance (natively HTJ2K-stored, from Task 0.2):

- StudyInstanceUID: `1.2.826.0.1.3680043.8.498.89660403630396210808681955639703008310`
- SeriesInstanceUID: `1.2.826.0.1.3680043.8.498.11196342524154857620201920211982916259`
- SOPInstanceUID: `1.2.826.0.1.3680043.8.498.91575830460297584858972199863051402008`
- TransferSyntaxUID: `1.2.840.10008.1.2.4.201` (HTJ2K Reversible)
- Orthanc image: `orthancteam/orthanc:latest` (April 2026 build, DicomWeb plugin v1.23)

Reproducer: `scripts/htj2k_wado_check.sh`.

Results:

- **Instance request** (`Accept: multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.201`):
  HTTP **400** — verdict **FAIL**.
  Body: `{"Details":"Unsupported transfer syntax in WADO-RS: 1.2.840.10008.1.2.4.201", "OrthancStatus":8, "Message":"Bad request"}`.
  The DicomWeb plugin's WADO-RS layer rejects HTJ2K at the Accept-validation stage — it never reads the stored bytes.
- **Frame request** (`Accept: multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.4.201`):
  HTTP **500**, magic bytes **NOT FOUND** (body is a JSON error, not HTJ2K), verdict **FAIL**.
  Body: `{"Details":"Unknown transfer syntax: 1.2.840.10008.1.2.4.201", "OrthancStatus":2, "Message":"Not implemented yet"}`.
  Orthanc core itself does not know HTJ2K — no decoder, no pass-through.
- **Wildcard fallback** (`Accept: */*`):
  HTTP **500**, identical "Unknown transfer syntax: 1.2.840.10008.1.2.4.201 / Not implemented yet" error.
  Returned `Content-Type: text/plain` (the JSON error). The server cannot serve this instance under *any* Accept — the stored bytes are unreadable to its DICOM stack, so it can't even transcode them down to a TS the client would accept.
- **`EnableMetadataCache: true` workaround attempt**: applied to `orthanc/orthanc-docker.json`, `docker compose restart orthanc`, re-ran `scripts/htj2k_wado_check.sh`. **Identical FAIL** (400 / 500 / 500). The plugin's rejection is not a stale-cache artifact; it is a hard-coded supported-TS list plus a missing core decoder. Config change reverted.

### Chosen workaround for Task 3.1: `stone-only`

Reasoning:

1. The 400 on the instance endpoint is an explicit DicomWeb supported-TS allowlist rejection — `nginx-rewrite` to force `?transcode=...` won't help because the plugin refuses HTJ2K *before* it would honor any transcode hint, and the encoder needed to produce HTJ2K isn't loaded anyway.
2. The 500 on the frame endpoint ("Unknown transfer syntax … Not implemented yet") proves the Orthanc core in `orthancteam/orthanc:latest` has no HTJ2K codec loaded at all (consistent with memory `project_htj2k_blocked`: stock image lacks OpenJPH). Even on `Accept: */*`, where Orthanc would normally transcode down to its `Transcode` default (J2K Lossless), it can't — because it can't decode the source HTJ2K to begin with.
3. Therefore HTJ2K cannot be exposed via WADO-RS in this Orthanc build, period. **Stone Web Viewer can still consume HTJ2K through its native Stone REST API** (different code path that streams the raw stored frame), so HTJ2K stays viable for the primary viewer. **OHIF stays on J2K Lossless** for the foreseeable future (already configured via `"Transcode": "1.2.840.10008.1.2.4.90"`).

Implication for Phase 3.1: skip nginx rewrites; instead, configure Stone to prefer HTJ2K (Task 4.1) and document the OHIF caveat in the runbook (Task 5.2). Re-evaluate when `orthancteam/orthanc` ships with OpenJPH or when we build a custom image with the HTJ2K codec.
