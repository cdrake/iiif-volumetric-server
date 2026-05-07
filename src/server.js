// Entry point for the IIIF Volumetric Server (proof of concept).
//
// Serves:
//   - IIIF Image API 3.0 endpoints for 2D slices through a volume
//     /iiif/image/{id}/{axis}/{slice}/info.json
//     /iiif/image/{id}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}
//   - IIIF Presentation API 4.0 alpha (draft 3D) manifests
//     /iiif/presentation/{id}/manifest
//   - Raw volume bytes (for clients that want to render the volume client-side)
//     /volumes/{id}/raw
//   - A demo viewer at /

import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";

import { registry } from "./registry.js";
import { mountImageApi } from "./routes/imageApi.js";
import { mountPresentationApi } from "./routes/presentationApi.js";
import { mountVolumeRoutes } from "./routes/volumeRoutes.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
const FIXTURES_DIR =
  process.env.FIXTURES_DIR ||
  path.resolve(__dirname, "..", "fixtures");

// niivuegpu dist auto-discovery. The server hosts the user's prebuilt
// niivuegpu library under /vendor/niivuegpu/ so the demo viewer can
// import { default as NiiVue } from '/vendor/niivuegpu/niivuegpu.js'
// without any bundler. To use it, set NIIVUEGPU_DIST or place a built
// dist/ directory next to the server (../niivuegpu/dist).
const NIIVUEGPU_DIST = resolveNiivuegpuDist();

function resolveNiivuegpuDist() {
  const candidates = [
    process.env.NIIVUEGPU_DIST,
    path.resolve(__dirname, "..", "niivuegpu", "dist"),
    path.resolve(__dirname, "..", "..", "niivuegpu", "dist"),
    path.resolve(process.env.HOME || "", "Dev", "niivuegpu", "dist"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (_) {
      // not present
    }
  }
  return null;
}

async function main() {
  await registry.scan(FIXTURES_DIR);
  console.log(
    `Loaded ${registry.size()} volume(s) from ${FIXTURES_DIR}:\n` +
      registry
        .list()
        .map(
          (v) =>
            `  - ${v.id} (${v.format}, ${v.shape.join("x")}, dtype=${v.dtype})`
        )
        .join("\n")
  );

  const app = express();
  app.locals.publicBaseUrl = PUBLIC_BASE_URL;

  app.use(cors());
  app.use(morgan("tiny"));
  app.use(express.static(path.resolve(__dirname, "..", "public")));

  if (NIIVUEGPU_DIST) {
    console.log(`Mounting niivuegpu dist from ${NIIVUEGPU_DIST}`);
    app.use(
      "/vendor/niivuegpu",
      express.static(NIIVUEGPU_DIST, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".js")) {
            res.set("Content-Type", "text/javascript");
          }
          if (filePath.endsWith(".wasm")) {
            res.set("Content-Type", "application/wasm");
          }
        },
      })
    );
    app.locals.niivuegpuMounted = true;
  } else {
    console.warn(
      "niivuegpu dist not found. Set NIIVUEGPU_DIST or place a built dist/ next to the server. The 3D viewer page will show a setup message until it's available."
    );
    app.locals.niivuegpuMounted = false;
  }

  // Health / index
  app.get("/api", (req, res) => {
    res.json({
      service: "iiif-volumetric-server",
      version: "0.1.0",
      spec: {
        imageApi: "https://iiif.io/api/image/3.0/",
        presentationApi:
          "https://preview.iiif.io/api/prezi-4/presentation/4.0/ (alpha, includes draft 3D)",
      },
      volumes: registry.list().map((v) => ({
        id: v.id,
        format: v.format,
        shape: v.shape,
        dtype: v.dtype,
        levels: v.levels,
        manifest: `${PUBLIC_BASE_URL}/iiif/presentation/${v.id}/manifest`,
        raw: `${PUBLIC_BASE_URL}/volumes/${v.id}/raw`,
        slices: {
          axial: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/axial/${
            Math.floor(v.shape[2] / 2)
          }/info.json`,
          coronal: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/coronal/${
            Math.floor(v.shape[1] / 2)
          }/info.json`,
          sagittal: `${PUBLIC_BASE_URL}/iiif/image/${v.id}/sagittal/${
            Math.floor(v.shape[0] / 2)
          }/info.json`,
        },
      })),
    });
  });

  mountImageApi(app, registry);
  mountPresentationApi(app, registry);
  mountVolumeRoutes(app, registry);

  // Dev-only: accept raw PNG bytes from the demo page and save them
  // under fixtures/screenshots/ so the agent can present_files them
  // back to the user. Not meant for production.
  app.post(
    "/dev/save-screenshot",
    express.raw({ type: "image/png", limit: "20mb" }),
    async (req, res) => {
      try {
        const { default: fs } = await import("node:fs/promises");
        const dir = path.resolve(__dirname, "..", "fixtures", "screenshots");
        await fs.mkdir(dir, { recursive: true });
        const name = `screenshot-${Date.now()}.png`;
        const full = path.join(dir, name);
        await fs.writeFile(full, req.body);
        res.json({ path: full, bytes: req.body.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  app.use((err, req, res, _next) => {
    console.error(err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal Server Error" });
  });

  app.listen(PORT, HOST, () => {
    console.log(`IIIF volumetric server listening at ${PUBLIC_BASE_URL}`);
    console.log(`Open the demo viewer at ${PUBLIC_BASE_URL}/`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
