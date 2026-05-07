// OME-Zarr / OME-TIFF adapter (proof-of-concept stub).
//
// Real OME-Zarr support requires walking a Zarr v2/v3 store, reading
// .zarray / zarr.json, and decoding chunks (Blosc/Zstd/etc). For this
// POC we register the volume by reading just enough of the .zattrs/
// zarr.json metadata to produce a manifest and rely on niivuegpu's
// own loaders for actual rendering — niivuegpu can ingest a NIfTI URL
// directly, and OME-Zarr support can be added later through zarrita.js.
//
// If the directory contains a `multiscales` entry per the OME-NGFF
// spec we use the first (highest-resolution) array's shape.

import fs from "node:fs/promises";
import path from "node:path";
import { VolumeHandle } from "./volumeHandle.js";

export const omezarrAdapter = {
  format: "ome-zarr",

  canHandle(p, { isDirectory }) {
    if (!isDirectory) return false;
    return /\.(ome\.)?zarr$/i.test(p);
  },

  async probe(dirPath) {
    const meta = await readZarrRoot(dirPath);
    return {
      shape: meta.shape,
      dtype: meta.dtype,
      spacing: meta.spacing,
    };
  },

  async load(dirPath) {
    const meta = await readZarrRoot(dirPath);
    // Synthetic gradient until we wire up zarrita.js for real chunk
    // decoding. The rest of the server still works end-to-end.
    const [sx, sy, sz] = meta.shape;
    const data = new Uint8Array(sx * sy * sz);
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          data[x + y * sx + z * sx * sy] = ((x + y + z) * 2) & 0xff;
        }
      }
    }
    return new VolumeHandle({
      shape: meta.shape,
      spacing: meta.spacing,
      dtype: "uint8",
      data,
      metadata: {
        note:
          "OME-Zarr placeholder. Full chunk decoding is on the roadmap; niivuegpu can render the original store directly via its own loaders.",
        ngffVersion: meta.ngffVersion,
      },
    });
  },
};

async function readZarrRoot(dirPath) {
  // Try Zarr v3 (zarr.json) first, then Zarr v2 (.zattrs + .zarray).
  const v3Path = path.join(dirPath, "zarr.json");
  try {
    const txt = await fs.readFile(v3Path, "utf8");
    const root = JSON.parse(txt);
    return summarizeFromV3(dirPath, root);
  } catch (_) {
    // fall through
  }

  const attrsPath = path.join(dirPath, ".zattrs");
  let attrs = {};
  try {
    const txt = await fs.readFile(attrsPath, "utf8");
    attrs = JSON.parse(txt);
  } catch (_) {
    // no attrs; we'll guess
  }
  const multiscales = attrs.multiscales;
  let arrPath = dirPath;
  if (Array.isArray(multiscales) && multiscales.length > 0) {
    const ds = multiscales[0].datasets?.[0];
    if (ds?.path) arrPath = path.join(dirPath, ds.path);
  }
  const arrayMetaPath = path.join(arrPath, ".zarray");
  let arrayMeta = {};
  try {
    arrayMeta = JSON.parse(await fs.readFile(arrayMetaPath, "utf8"));
  } catch (_) {
    // no .zarray
  }
  const shape = pick3DShape(arrayMeta.shape || [1, 1, 1]);
  const spacing = guessSpacing(multiscales, shape.length);
  return {
    shape,
    spacing,
    dtype: arrayMeta.dtype || "uint8",
    ngffVersion: multiscales?.[0]?.version || "unknown",
  };
}

function summarizeFromV3(dirPath, root) {
  const ms = root.attributes?.["ome"]?.multiscales || root.attributes?.multiscales;
  let shape = [1, 1, 1];
  if (root.shape) shape = pick3DShape(root.shape);
  return {
    shape,
    spacing: guessSpacing(ms, shape.length),
    dtype: root.data_type || "uint8",
    ngffVersion: "v3",
  };
}

function pick3DShape(shape) {
  // OME-NGFF arrays are commonly TCZYX. Take the trailing 3 dims as
  // [z, y, x] and convert to our [x, y, z] convention.
  const last3 = shape.slice(-3);
  while (last3.length < 3) last3.unshift(1);
  return [last3[2], last3[1], last3[0]];
}

function guessSpacing(multiscales, _ndim) {
  if (!Array.isArray(multiscales) || multiscales.length === 0) {
    return [1, 1, 1];
  }
  const ct = multiscales[0]?.datasets?.[0]?.coordinateTransformations || [];
  for (const t of ct) {
    if (t.type === "scale" && Array.isArray(t.scale)) {
      const last3 = t.scale.slice(-3);
      while (last3.length < 3) last3.unshift(1);
      return [last3[2], last3[1], last3[0]];
    }
  }
  return [1, 1, 1];
}
