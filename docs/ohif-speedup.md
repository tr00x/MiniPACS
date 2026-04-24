# OHIF viewer speedup — making it the default

## Why OHIF at all

Stone is fast because it is small and WASM-native. But it is a dead-end:
no plugin ecosystem, limited measurement API, no modern MPR, no AI hooks.

OHIF v3 on Cornerstone3D is where every third-party imaging tool lives.
Hanging protocols, persistent annotations via DICOM SR, MPR/MIP, tracked
measurements, AI extensions — all already built by the OHIF community.
We gain ten features for free the moment OHIF boots as fast as Stone.

## Why it feels slow today

Three independent bottlenecks stack:

1. **Bundle size** — OHIF ships ~8 MB of JS uncompressed. Gzip takes it
   to ~2 MB; brotli would take it to ~1.3 MB. Nginx gzips but doesn't
   brotli yet.
2. **Metadata sequence** — OHIF fetches QIDO study → QIDO series → WADO
   metadata per series, sequentially by default. On a 22-series MR that
   is ~22 round-trips before the first image appears.
3. **Main-thread pixel decode** — Cornerstone3D's default loader decodes
   JPEG 2000 frames on the UI thread. A 28-slice T2 series blocks for
   ~400 ms during scroll if not pre-decoded off-thread.

Each is fixable without forking OHIF.

## Speedup plan (no forking)

### S1. Brotli for the bundle (biggest single win)
Add `brotli_static on;` to `nginx/nginx-prod.conf` — the vite build already
emits `.br` files thanks to `vite-plugin-compression`. Verify with
`curl -H 'Accept-Encoding: br' -I ...` on the OHIF entry. Expected:
bundle cold-load from ~2 MB → ~1.3 MB on first visit, 0 bytes on warm.

### S2. Service Worker cache with `stale-while-revalidate`
Add an SW that caches OHIF static assets under a hashed URL with a 30-day
TTL, and uses `stale-while-revalidate` for `/dicom-web/.../metadata` GETs.
Second open of the same patient = instant. `workbox-webpack-plugin` or
manual SW.

### S3. Parallel metadata prefetch
Server-side endpoint `GET /api/studies/{id}/ohif-bootstrap` that returns
the full OHIF study manifest in one call: QIDO + series-level metadata for
every series, fanned-out in parallel inside the backend (we already have
`_TEXT_FANOUT_LIMIT` pattern). OHIF consumes via a custom data source that
reads from this endpoint instead of QIDO-per-series. Turns 22 RTT into 1.

### S4. Worker-thread decode
Flip `codecsInWebWorker: true` and `useSharedArrayBuffer: true` in the
Cornerstone3D config. Requires `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` headers from nginx —
trivial to add. Main thread stays free during scroll; measurable on MR
series with >20 slices.

### S5. Preload first series first frame
Backend pushes the first instance of the first series as an HTTP/2
Server-Push (or simple `<link rel="preload">` hint) when OHIF loads.
Radiologist sees pixels within ~500 ms of clicking the study.

### S6. Tree-shake unused OHIF extensions
Vite build with the OHIF modes trimmed to what Clinton actually uses
(basic-viewer + maybe measurement-tracking). Cuts bundle another ~30%.

### S7. Cornerstone cache sized to full study
Default cache is 1 GB but Cornerstone3D auto-evicts early. Raise
`cache.setMaxCacheSize` to 2 GB and disable aggressive eviction for the
currently-open study. No repeat fetches on scroll-back.

## Expected after all 7

- Cold open of an average MRI study: Stone ~1.2 s, today's OHIF ~4.5 s, post-tuning OHIF ~1.5 s
- Warm open: Stone ~0.8 s, tuned OHIF ~0.3 s (SW cache hits)
- Scroll through 28-slice T2: Stone ~60 fps, tuned OHIF ~60 fps (off-thread decode)

Not faster than Stone on absolute cold. Faster than Stone on warm and
identical on interaction. Plus we get hanging protocols, MPR, and the
plugin ecosystem.

## Order to ship

S1 → S4 → S3 → S2 → S5 → S6 → S7.
S1 and S4 deliver ~70% of the perceived speedup for ~10% of the work.
S2 is the warm-open magic. S3 is the bigger backend piece — do after we
validate the others are in place so we can A/B them cleanly.

## Stone stays

We don't kill Stone. Keep it as a secondary viewer row in `external_viewers`.
Some users prefer the lightness for a quick "is the image there" glance.
Default stays OHIF once the speedups land.
