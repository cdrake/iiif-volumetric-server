// Raw volume endpoints. niivuegpu (and any other NIfTI-aware client)
// fetches the bytes from here.
//
//   GET /volumes/{id}/raw          → original NIfTI bytes (gzip if source was)
//   GET /volumes/{id}/raw?bbox=x0,y0,z0,x1,y1,z1
//                                   → re-emitted NIfTI cropped to the box
//                                     (subvolume support for the 3D draft)
//
// For non-NIfTI sources, /raw returns the original file (NRRD, OME-Zarr
// will need range-based access; here we just send what we have).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import nifti from "nifti-reader-js";

import {
  encodeNifti,
} from "../util/niftiEncoder.js";

import {
  planExplodedView,
  composeExplodedBuffer,
} from "../iiif/explode.js";

export function mountVolumeRoutes(app, registry) {
  // Some NIfTI clients (notably niivuegpu) sniff the URL extension
  // to choose the format reader. Serving the same bytes under both
  // /raw and /raw.nii.gz lets those clients identify the format
  // without us having to ship a Content-Type-aware loader.
  app.get(
    [
      "/volumes/:volId/raw",
      "/volumes/:volId/raw.nii.gz",
      "/volumes/:volId/raw.nii",
    ],
    asyncHandler(async (req, res) => {
      const entry = registry.get(req.params.volId);
      if (!entry) {
        const err = new Error(`Unknown volume id: ${req.params.volId}`);
        err.status = 404;
        throw err;
      }

      const bbox = parseBbox(req.query.bbox);
      const levelIdx = Number(req.query.level ?? 0);

      if (!bbox && levelIdx > 0) {
        // Stream full level file if no bbox requested
        const level = entry.levels.find((l) => l.level === levelIdx);
        if (level && level.path) {
          res.set("Content-Type", "application/x.nifti+gzip");
          res.set(
            "Content-Disposition",
            `inline; filename="${entry.id}_L${levelIdx}.nii.gz"`
          );
          res.set("Cache-Control", "public, max-age=3600");
          fs.createReadStream(level.path).pipe(res);
          return;
        }
      }

      if (bbox) {
        // Subvolume crop: only NIfTI is implemented in this POC.
        if (entry.format !== "nifti") {
          const err = new Error(
            `bbox crop is only implemented for NIfTI sources in this POC (got format=${entry.format})`
          );
          err.status = 501;
          throw err;
        }

        let volumeToCrop = entry.volume;
        if (levelIdx > 0) {
          const level = entry.levels.find((l) => l.level === levelIdx);
          if (level && level.path) {
            // Load the downsampled volume to crop it
            volumeToCrop = await niftiAdapter.load(level.path);
          }
        } else {
            await registry.load(entry.id);
            volumeToCrop = entry.volume;
        }

        const cropped = cropNifti(volumeToCrop, bbox);
        res.set("Content-Type", "application/x.nifti");
        res.set(
          "Content-Disposition",
          `inline; filename="${entry.id}_crop.nii.gz"`
        );
        res.set("Cache-Control", "public, max-age=3600");
        res.send(cropped);
        return;
      }

      // Default: stream original source
      await streamSource(entry, res);
    })
  );

  // Exploded view: returns a single composite NIfTI containing the
  // source volume sliced into an nx*ny*nz grid of cells, each placed
  // at its exploded position (cells separated by `explode` factor).
  // niivuegpu can render this as a single volume to give you a
  // pan/zoom/orbit-able exploded view.
  app.get(
    [
      "/volumes/:volId/exploded",
      "/volumes/:volId/exploded.nii.gz",
    ],
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId);
      const levelIdx = Number(req.query.level ?? 0);
      const params = {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      };

      let baseVolume = entry.volume;
      if (levelIdx > 0) {
        const level = entry.levels.find((l) => l.level === levelIdx);
        if (level && level.path) {
          baseVolume = await niftiAdapter.load(level.path);
        }
      }

      const layout = planExplodedView(baseVolume, params);
      const out = composeExplodedBuffer(baseVolume, layout);
      const buffer = encodeNifti({
        data: out,
        shape: layout.compositeShape,
        spacing: layout.compositeSpacing,
        dtype: entry.volume.dtype,
      });
      res.set("Content-Type", "application/x.nifti");
      res.set(
        "Content-Disposition",
        `inline; filename="${entry.id}_exploded.nii.gz"`
      );
      res.set("Cache-Control", "public, max-age=3600");
      res.send(buffer);
    })
  );

  // Plan summary as JSON — used by the demo viewer to render cell
  // overlays without re-downloading the composite buffer.
  app.get(
    "/volumes/:volId/exploded/plan",
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId);
      const levelIdx = Number(req.query.level ?? 0);
      const params = {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      };

      let baseVolume = entry.volume;
      if (levelIdx > 0) {
        const level = entry.levels.find((l) => l.level === levelIdx);
        if (level && level.path) {
          baseVolume = await niftiAdapter.load(level.path);
        }
      }

      const layout = planExplodedView(baseVolume, params);
      res.json({
        volumeId: entry.id,
        params: layout.params,
        cellShape: layout.cellShape,
        compositeShape: layout.compositeShape,
        compositeSpacing: layout.compositeSpacing,
        cellCount: layout.cells.length,
        cells: layout.cells,
      });
    })
  );

  // Volume metadata as JSON (handy for debugging and for the demo viewer)
  app.get("/volumes/:volId/metadata", async (req, res, next) => {
    try {
      const entry = await registry.load(req.params.volId);
      res.json({
        id: entry.id,
        format: entry.format,
        shape: entry.volume.shape,
        spacing: entry.volume.spacing,
        dtype: entry.volume.dtype,
        units: entry.volume.units,
        levels: entry.levels,
        intensityRange: entry.volume.intensityRange(),
        metadata: entry.volume.metadata,
      });
    } catch (err) {
      next(err);
    }
  });
}

async function streamSource(entry, res) {
  const stat = await fsp.stat(entry.source);
  if (stat.isDirectory()) {
    const err = new Error(
      `Direct download of ${entry.format} directories is not implemented in this POC. Use /volumes/${entry.id}/metadata or the IIIF Image API endpoints.`
    );
    err.status = 501;
    throw err;
  }
  const ext = path.extname(entry.source).toLowerCase();
  const contentType = pickContentType(entry.format, ext);
  res.set("Content-Type", contentType);
  res.set("Content-Length", String(stat.size));
  res.set("Cache-Control", "public, max-age=3600");
  fs.createReadStream(entry.source).pipe(res);
}

function pickContentType(format, ext) {
  if (format === "nifti") {
    return ext === ".gz" ? "application/x.nifti+gzip" : "application/x.nifti";
  }
  if (format === "nrrd") return "application/octet-stream";
  return "application/octet-stream";
}

function parseBbox(s) {
  if (!s) return null;
  const parts = String(s).split(",").map(Number);
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
    const err = new Error(
      "Invalid bbox; expected six numbers: x0,y0,z0,x1,y1,z1"
    );
    err.status = 400;
    throw err;
  }
  const [x0, y0, z0, x1, y1, z1] = parts.map(Math.round);
  return { x0, y0, z0, x1, y1, z1 };
}

/**
 * Re-emit a NIfTI-1 file containing only the voxels within bbox.
 * Returns a gzipped Buffer so it streams compactly. Uses the original
 * header as a template, updates dims, datatype unchanged, qform/sform
 * untouched (this is a POC; for real medical use the affine should be
 * shifted by the bbox origin).
 */
function cropNifti(entry, bbox) {
  const v = entry.volume;
  const [sx, sy, sz] = v.shape;
  const x0 = clamp(bbox.x0, 0, sx);
  const y0 = clamp(bbox.y0, 0, sy);
  const z0 = clamp(bbox.z0, 0, sz);
  const x1 = clamp(bbox.x1, x0, sx);
  const y1 = clamp(bbox.y1, y0, sy);
  const z1 = clamp(bbox.z1, z0, sz);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const cd = z1 - z0;
  if (cw <= 0 || ch <= 0 || cd <= 0) {
    const err = new Error("bbox produced an empty subvolume");
    err.status = 400;
    throw err;
  }
  const dataView = v.data;
  // RGB volumes store 3 bytes per voxel in a flat Uint8Array; RGBA32
  // stores 4. Scalar volumes use the typed array's element width.
  const colorBytes = v.dtype === "rgb24" ? 3 : v.dtype === "rgba32" ? 4 : 0;
  const elemBytes = colorBytes || dataView.BYTES_PER_ELEMENT;
  const TypedArrayCtor = dataView.constructor;
  const elemsPerSliceRow = cw * (colorBytes || 1);
  const elemsPerSlice = elemsPerSliceRow * ch;
  const out = new TypedArrayCtor(elemsPerSlice * cd);
  const srcRowStride = colorBytes || 1;
  for (let z = 0; z < cd; z++) {
    for (let y = 0; y < ch; y++) {
      const srcVoxStart = x0 + (y0 + y) * sx + (z0 + z) * sx * sy;
      const srcStart = srcVoxStart * srcRowStride;
      const srcLen = cw * srcRowStride;
      const dstStart = y * elemsPerSliceRow + z * elemsPerSlice;
      out.set(
        dataView.subarray(srcStart, srcStart + srcLen),
        dstStart
      );
    }
  }

  return encodeNifti({
    data: out,
    shape: [cw, ch, cd],
    spacing: v.spacing,
    dtype: v.dtype,
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
