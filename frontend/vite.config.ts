import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
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
  plugins: [react(), tailwindcss(), ohifStaticPlugin()],
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
