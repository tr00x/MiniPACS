import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import compression from "vite-plugin-compression";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import fs from "fs";

// Load backend .env for Orthanc credentials
function loadBackendEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../backend/.env");
  const env: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [k, ...rest] = trimmed.split("=");
        env[k.trim()] = rest.join("=").trim();
      }
    }
  }
  return env;
}
const backendEnv = loadBackendEnv();

// Serve OHIF static files in dev mode
function ohifStaticPlugin() {
  const ohifDir = path.resolve(__dirname, "../ohif-dist");
  return {
    name: "ohif-static",
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use("/ohif", (req: any, res: any, next: any) => {
        const filePath = path.join(ohifDir, req.url === "/" ? "/index.html" : req.url);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader("Content-Type", getContentType(filePath));
          fs.createReadStream(filePath).pipe(res);
        } else {
          // SPA fallback
          const indexPath = path.join(ohifDir, "index.html");
          if (fs.existsSync(indexPath)) {
            res.setHeader("Content-Type", "text/html");
            fs.createReadStream(indexPath).pipe(res);
          } else {
            next();
          }
        }
      });
    },
  };
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath);
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
    ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
    ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2",
    ".woff": "font/woff", ".map": "application/json",
  };
  return types[ext] || "application/octet-stream";
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ohifStaticPlugin(),
    // Service worker + manifest. Gives iPad/Android an "Install to home
    // screen" prompt and keeps the app shell offline-ready. API caching is
    // NetworkFirst with a 5s network timeout — we always prefer fresh data,
    // but if the link is down the portal still opens and shows the last
    // known worklist. DICOM blobs stay NetworkOnly — nginx disk cache owns
    // that layer.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        name: "MiniPACS",
        short_name: "MiniPACS",
        description: "Local-first PACS portal",
        theme_color: "#863bff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // Exclude /api, /orthanc, /ohif, /stone-webviewer, /dicom-web from
        // navigation fallback so their HTML errors aren't masked by SPA shell.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/orthanc\//,
          /^\/ohif\//,
          /^\/stone-webviewer\//,
          /^\/dicom-web\//,
        ],
        // Precache everything Vite emitted plus the manifest.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest,json}"],
        // Viewer WASM/JS bundles can be large; bump the single-file limit.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "minipacs-api",
              networkTimeoutSeconds: 5,
              expiration: { maxAgeSeconds: 300, maxEntries: 100 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/stone-webviewer/"),
            handler: "CacheFirst",
            options: {
              cacheName: "minipacs-stone",
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 7, maxEntries: 200 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // DICOM blob endpoints — nginx disk cache is authoritative,
            // never hand them to Workbox.
            urlPattern: ({ url }) =>
              url.pathname.startsWith("/dicom-web/") ||
              url.pathname.startsWith("/orthanc/dicom-web/"),
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    // Emit .gz alongside every JS/CSS/SVG so nginx gzip_static can serve
    // pre-compressed assets instantly without CPU per request.
    compression({
      algorithm: "gzip",
      ext: ".gz",
      threshold: 1024,
      deleteOriginFile: false,
    }),
  ],
  build: {
    // Split hefty third-party code into long-cache chunks so the app-only
    // chunk stays small and redeploys invalidate only the thin slice that
    // actually changed.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("react-router") || id.includes("/react-dom/") || /\/node_modules\/react\//.test(id)) {
              return "react-vendor";
            }
            if (id.includes("@tanstack")) return "query-vendor";
            if (id.includes("@radix-ui")) return "radix-vendor";
            if (id.includes("lucide-react")) return "icons-vendor";
          }
        },
      },
    },
    // Hard cap so a stray heavy import doesn't silently bloat the main chunk.
    chunkSizeWarningLimit: 600,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 48925,
    proxy: {
      "/api": {
        target: "http://localhost:48922",
        changeOrigin: true,
      },
      "/dicom-web": {
        target: backendEnv.ORTHANC_URL || "http://localhost:48923",
        changeOrigin: true,
        auth: `${backendEnv.ORTHANC_USERNAME || "orthanc"}:${backendEnv.ORTHANC_PASSWORD || "orthanc"}`,
      },
    },
  },
});
