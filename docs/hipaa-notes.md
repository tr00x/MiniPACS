# HIPAA implementation notes

> [!IMPORTANT]
> No software is "HIPAA compliant" on its own. **Covered entities pass
> HIPAA, not products.** This document maps what MiniPACS implements
> against the HIPAA Security Rule's technical safeguards
> (45 CFR §164.312) so a clinic's compliance officer can complete the
> remaining administrative and physical safeguards.

## What MiniPACS implements

| Safeguard | Citation | Implementation |
| --- | --- | --- |
| Unique user identification | §164.312(a)(2)(i) | `users` table; JWT carries `user_id` claim; every audit-log row attributes to a user_id. |
| Automatic logoff | §164.312(a)(2)(iii) | `AUTO_LOGOUT_MINUTES` (default 15) drives a frontend session timer with a 60-second warning modal. Backend rejects access tokens past expiry. |
| Encryption / decryption (data in motion) | §164.312(a)(2)(iv), §164.312(e)(1) | TLS via Cloudflare Tunnel for WAN, Cloudflare Origin Cert + HTTP/2 for LAN. DICOMweb is gated to LAN only. |
| Encryption / decryption (data at rest — backups) | §164.312(a)(2)(iv) | `scripts/backup.sh` encrypts `pg_dump` + DICOM tar with AES-256-CBC (openssl + PBKDF2, 100k iterations) using `BACKUP_PASSPHRASE`. Refuses to run if the passphrase is missing. |
| Audit controls | §164.312(b) | Immutable `audit_log` table — every router action writes user_id, action, resource_type/id, IP, UTC timestamp. CSV export available. |
| Person / entity authentication | §164.312(d) | bcrypt password hash, JWT access + refresh tokens, 12+ char password policy with complexity gate, login rate limit. |
| Integrity controls | §164.312(c)(1) | Append-only audit log; bcrypt hashes; HTTPS guarantees in-transit integrity. |
| Transmission integrity | §164.312(e)(2)(i) | TLS for all external traffic. DICOM C-STORE on LAN only (port `48924`). |
| Session management | §164.312(a)(1) | JWT `token_version` claim — admin password change or explicit revoke increments the user's token_version, invalidating all outstanding sessions on the next request (O(1)). |
| Strong password policy | §164.308(a)(5)(ii)(D) | `validate_password_strength()` enforces 12+ chars and 3-of-4 character classes (lower, upper, digit, special). Applied to `create_user`, `change_password`, and the `POST /api/users` admin endpoint. |

## What the deploying clinic must add

These are NOT MiniPACS responsibilities — they are clinic-side
safeguards that MiniPACS cannot implement on the clinic's behalf.

### Required before treating MiniPACS as HIPAA-deployable

- [ ] **Full-disk encryption (FDE)** on the host — BitLocker (Windows)
      or LUKS (Linux). MiniPACS encrypts backups; FDE covers the live
      DICOM volume, the PG data dir, and `/tmp`/swap. §164.312(a)(2)(iv).
- [ ] **Business Associate Agreement (BAA) with Cloudflare** if you use
      Cloudflare Tunnel for WAN access. **Free CF plans do not include
      a BAA** — you need CF Enterprise, or an alternative tunnel
      (Tailscale Funnel + their BAA, your own VPN, etc.).
- [ ] **BAA with every other vendor that touches PHI** — email
      providers (if mailing share links), backup storage providers
      (if pushing encrypted backups off-site), monitoring services.
- [ ] **Off-site backup target** for HIPAA's 3-2-1 expectation
      (3 copies, 2 media, 1 off-site). `rclone` to encrypted S3 / B2
      is the simplest pattern; the local `backup.sh` artefacts are
      already encrypted, so any "dumb" off-site copy works.
- [ ] **Strong, unique passwords for every user.** The complexity gate
      in MiniPACS rejects weak ones — but the clinic must train staff
      not to share accounts and to rotate after staff turnover.
- [ ] **Risk assessment documented in writing** (§164.308(a)(1)(ii)(A)).
      Required before go-live. NIST 800-66 Rev. 2 has a workable
      template.
- [ ] **Workforce HIPAA training** (§164.308(a)(5)). Annual.
- [ ] **Sanction policy** for staff who violate procedures
      (§164.308(a)(1)(ii)(C)).
- [ ] **Contingency plan** — written disaster recovery and emergency
      access procedures (§164.308(a)(7)). MiniPACS provides the
      mechanics (restore-backup.sh); the policy around it is yours.
- [ ] **Business continuity test** — annually: restore an encrypted
      backup to a non-prod box and confirm patient records open. Log
      the result.

### Strongly recommended (not strictly required, but expected in 2026)

- [ ] **Multi-factor authentication.** Not currently implemented in
      MiniPACS. HIPAA does not strictly require MFA, but every modern
      audit framework (HITRUST, SOC 2 healthcare, NIST 800-66 Rev. 2)
      treats it as a baseline expectation. **MFA is on the MiniPACS
      roadmap.** Until it ships, restrict admin login to LAN-only and
      use a long, unique passphrase.
- [ ] **Network segmentation** — DICOM equipment and the MiniPACS host
      on a dedicated VLAN.
- [ ] **Centralised log shipping** — copy `audit_log` rows + nginx
      access logs to a tamper-evident store outside the host
      (a write-only S3 bucket, Loki + S3 backend, etc.).
- [ ] **Annual penetration test** of the deployed instance.

## Cloudflare Tunnel + BAA — the most common mistake

Cloudflare Tunnel is the recommended WAN front-door because it removes
the need to forward inbound HTTPS through the clinic firewall. **But:**

- Cloudflare's standard Terms of Service explicitly say PHI must not
  flow through the network without a signed BAA.
- BAAs are available **only on Cloudflare Enterprise**, not Pro,
  Business, or Free.
- Running PHI through a free CF Tunnel is a HIPAA violation regardless
  of what MiniPACS does locally.

Practical options:

1. **Sign a CF Enterprise BAA** (most realistic for clinics with the
   budget — pricing is custom).
2. **Replace CF Tunnel with a BAA-covered alternative** — Tailscale
   Business with a BAA, your own VPN concentrator, AWS Transit Gateway
   under AWS BAA, etc.
3. **Run LAN-only** — keep the split-horizon HTTPS path
   (`docs/split-horizon-https.md`) but disable cloudflared. Acceptable
   for clinics that only read studies on-site.

## Audit-log scope — known gap

The `audit_log` middleware captures every action that flows through
the FastAPI router layer (`/api/*`). It does **not** currently capture
direct DICOMweb fetches (`/dicom-web/*`) — those are proxied to
Orthanc and a clinic auditor will see them only in nginx access logs.

For compliance purposes:

- Treat the nginx access log as part of the HIPAA audit-log set.
- Ship both `audit_log` table rows and nginx access logs to your
  tamper-evident store.
- Closing this gap (DICOMweb access events into `audit_log`) is on
  the roadmap.

## Breach notification

§164.404 requires notification within 60 days of discovery. MiniPACS
does not yet ship a breach-detection module. Mitigations:

- Monitor failed-login spikes via the rate-limit metric.
- Watch for off-hours `audit_log` activity from unfamiliar IPs.
- A `/api/audit-log` query at end-of-day is a workable manual check
  until automation lands.

## Versioning of this document

This file describes MiniPACS as of the master branch. Each material
change to a §164.312 control should land in CHANGELOG.md and update
the matrix above. If your compliance officer needs a fixed snapshot,
pin to a commit SHA.
