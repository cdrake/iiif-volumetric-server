// DICOM-series adapter (proof-of-concept stub).
//
// A DICOM volume is a *folder* containing many .dcm files, one per slice.
// Real implementations (e.g. cornerstone-dicom-image-loader, dcmjs) handle
// transfer syntaxes, JPEG2000, multi-frame, etc. For this POC we keep
// everything optional: if a folder contains .dcm files we try to read it
// using dicom-parser if installed, and otherwise we report a friendly
// stub.
//
// To keep the POC dependency footprint small, we attempt a *dynamic*
// import of dicom-parser. If it's not installed, the adapter still
// registers the volume but returns a placeholder grayscale ramp on
// access. Add `npm install dicom-parser` to enable real DICOM reads.

import fs from "node:fs/promises";
import path from "node:path";
import { VolumeHandle } from "./volumeHandle.js";

export const dicomAdapter = {
  format: "dicom",

  canHandle(p, { isDirectory }) {
    if (!isDirectory) return false;
    return /(_dicom|\.dicom|dicom_series)$/i.test(p);
  },

  async probe(dirPath) {
    const files = await dicomFilesIn(dirPath);
    if (files.length === 0) {
      throw new Error(`No .dcm files found in ${dirPath}`);
    }
    // Without a real parser we estimate: each file is one slice and
    // assume 256x256 unless we can crack one open.
    const dims = await tryReadFirstSliceDims(files[0]);
    return {
      shape: [dims.width, dims.height, files.length],
      dtype: dims.dtype,
      spacing: [1, 1, 1],
    };
  },

  async load(dirPath) {
    const files = await dicomFilesIn(dirPath);
    if (files.length === 0) {
      throw new Error(`No .dcm files found in ${dirPath}`);
    }

    const parser = await tryLoadDicomParser();
    if (parser) {
      return loadWithDicomParser(files, parser);
    }

    // Fallback: synthesise a grayscale gradient so the rest of the
    // pipeline (manifests, viewer) still works end-to-end.
    const dims = await tryReadFirstSliceDims(files[0]);
    const sx = dims.width;
    const sy = dims.height;
    const sz = files.length;
    const data = new Uint8Array(sx * sy * sz);
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          data[x + y * sx + z * sx * sy] = ((x ^ y ^ z) & 0xff);
        }
      }
    }
    return new VolumeHandle({
      shape: [sx, sy, sz],
      spacing: [1, 1, 1],
      dtype: "uint8",
      data,
      metadata: {
        note:
          "DICOM placeholder volume. Install dicom-parser for real pixel data.",
      },
    });
  },
};

async function dicomFilesIn(dirPath) {
  const items = await fs.readdir(dirPath);
  return items
    .filter((f) => /\.dcm$/i.test(f))
    .sort()
    .map((f) => path.join(dirPath, f));
}

async function tryReadFirstSliceDims(_file) {
  // Without dicom-parser available we just guess. Real implementations
  // would read tags (0028,0010) Rows and (0028,0011) Columns.
  return { width: 256, height: 256, dtype: "uint8" };
}

async function tryLoadDicomParser() {
  try {
    const mod = await import("dicom-parser");
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function loadWithDicomParser(files, dicomParser) {
  // Read the first file to learn dimensions and pixel representation.
  const firstBuf = await fs.readFile(files[0]);
  const firstDataSet = dicomParser.parseDicom(firstBuf);
  const cols = firstDataSet.uint16("x00280011");
  const rows = firstDataSet.uint16("x00280010");
  const bitsAllocated = firstDataSet.uint16("x00280100") || 16;
  const pixelRepresentation = firstDataSet.uint16("x00280103") || 0;
  const sx = cols;
  const sy = rows;
  const sz = files.length;

  let TypedArrayCtor;
  let dtype;
  if (bitsAllocated <= 8) {
    TypedArrayCtor = Uint8Array;
    dtype = "uint8";
  } else if (pixelRepresentation === 1) {
    TypedArrayCtor = Int16Array;
    dtype = "int16";
  } else {
    TypedArrayCtor = Uint16Array;
    dtype = "uint16";
  }

  const sliceVoxels = sx * sy;
  const data = new TypedArrayCtor(sliceVoxels * sz);

  for (let z = 0; z < sz; z++) {
    const buf = z === 0 ? firstBuf : await fs.readFile(files[z]);
    const ds = z === 0 ? firstDataSet : dicomParser.parseDicom(buf);
    const pixelDataElement = ds.elements.x7fe00010;
    if (!pixelDataElement) continue;
    const start = pixelDataElement.dataOffset;
    const length = pixelDataElement.length;
    const pixelView = new TypedArrayCtor(
      buf.buffer,
      buf.byteOffset + start,
      length / TypedArrayCtor.BYTES_PER_ELEMENT
    );
    data.set(pixelView, z * sliceVoxels);
  }

  return new VolumeHandle({
    shape: [sx, sy, sz],
    spacing: [1, 1, 1],
    dtype,
    data,
  });
}
