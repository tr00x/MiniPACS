// OHIF config overrides layered on top of the Orthanc OHIF plugin's bundled
// app-config.js. The plugin concatenates this file's contents into the served
// /ohif/app-config.js BEFORE its own assignments to `window.config`, so we
// must initialize `window.config` ourselves (it would otherwise be undefined
// when those later `window.config.xxx = yyy` lines execute).
//
// Plain JS only — no JSON (the plugin does not parse, just inlines).
// Any key set here is overwritten if the plugin explicitly sets the same
// key later, so this is best used for values the bundle does not touch.

window.config = window.config || {};

// The plugin's bundled app-config.js only sets routerBasename/dataSources/
// defaultDataSourceName. Its served app.bundle (67182+) assumes every viewer
// mode lives in an iterable `extensions`/`modes` array and crashes
// "appConfig.extensions is not iterable" otherwise. Seed empty defaults here.
window.config.extensions = window.config.extensions || [];
window.config.modes = window.config.modes || [];

// One decoder worker per core (host has 8+). Previous custom bundle tested
// this against a 3000-instance CT — 8 workers decode ~3x faster than the
// 3-worker default before worker-pool saturation.
window.config.maxNumberOfWebWorkers = 8;

// Eagerly pull metadata for the next series while the user scrolls current —
// hides per-series cold-fetch latency when the radiologist advances from
// T1 to T2 to FLAIR.
window.config.maxNumberOfImagesToPrefetch = 25;

// investigationalUseDialog hidden — radiologists know the tool is production.
window.config.investigationalUseDialog = { option: "never" };
