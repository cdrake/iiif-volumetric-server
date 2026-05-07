// NIfTI-1 / NIfTI-2 adapter. Uses nifti-reader-js, which understands both
// the .nii and .nii.gz forms (gzip is decompressed via pako under the
// hood). The library returns a typed array in voxel-by-voxel order
// matching the file's data dimensions.

import fs from "node:fs/promises";
import nifti from "nifti-reader-js";
import { VolumeHandle } from "./volumeHandle.js";

export const niftiAdapter = {
  format: "nifti",

  canHandle(p, { isDirectory }) {
    if (isDirectory) return false;
    return /\.nii(\.gz)?$/i.test(p);
  },

  async probe(filePath) {
    const buf = await fs.readFile(filePath);
    const ab = toArrayBuffer(buf);
    const decompressed = nifti.isCompressed(ab)
      ? nifti.decompress(ab)
      : ab;
    if (!nifti.isNIFTI(decompressed)) {
      throw new Error("Not a valid NIfTI file");
    }
    const header = nifti.readHeader(decompressed);
    return {
      shape: [header.dims[1], header.dims[2], header.dims[3] || 1],
      dtype: niftiDtypeName(header.datatypeCode),
      spacing: [
        header.pixDims[1] || 1,
        header.pixDims[2] || 1,
        header.pixDims[3] || 1,
      ],
      affine: header.affine,
    };
  },

  async load(filePath) {
    const buf = await fs.readFile(filePath);
    const ab = toArrayBuffer(buf);
    const decompressed = nifti.isCompressed(ab)
      ? nifti.decompress(ab)
      : ab;
    const header = nifti.readHeader(decompressed);
    const rawImage = nifti.readImage(header, decompressed);
    const data = wrapTyped(rawImage, header.datatypeCode);

    return new VolumeHandle({
      shape: [header.dims[1], header.dims[2], header.dims[3] || 1],
      spacing: [
        header.pixDims[1] || 1,
        header.pixDims[2] || 1,
        header.pixDims[3] || 1,
      ],
      affine: header.affine,
      dtype: niftiDtypeName(header.datatypeCode),
      data,
      units: niftiUnitsName(header.xyzt_units),
      metadata: {
        descrip: header.description?.trim?.() || "",
        intent_name: header.intent_name?.trim?.() || "",
        sform_code: header.sform_code,
        qform_code: header.qform_code,
      },
    });
  },
};

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function wrapTyped(arrayBuffer, datatypeCode) {
  switch (datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8:
      return new Uint8Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_INT16:
      return new Int16Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_UINT16:
      return new Uint16Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_INT32:
      return new Int32Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_UINT32:
      return new Uint32Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_FLOAT32:
      return new Float32Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_FLOAT64:
      return new Float64Array(arrayBuffer);
    case nifti.NIFTI1.TYPE_INT8:
      return new Int8Array(arrayBuffer);
    case 128:
      // RGB24: three contiguous bytes per voxel (R,G,B). VolumeHandle
      // detects the rgb24 dtype and treats every triple as one voxel.
      return new Uint8Array(arrayBuffer);
    case 2304:
      // RGBA32: four contiguous bytes per voxel (R,G,B,A).
      return new Uint8Array(arrayBuffer);
    default:
      throw new Error(`Unsupported NIfTI datatype code ${datatypeCode}`);
  }
}

function niftiDtypeName(code) {
  switch (code) {
    case nifti.NIFTI1.TYPE_UINT8:
      return "uint8";
    case nifti.NIFTI1.TYPE_INT8:
      return "int8";
    case nifti.NIFTI1.TYPE_INT16:
      return "int16";
    case nifti.NIFTI1.TYPE_UINT16:
      return "uint16";
    case nifti.NIFTI1.TYPE_INT32:
      return "int32";
    case nifti.NIFTI1.TYPE_UINT32:
      return "uint32";
    case nifti.NIFTI1.TYPE_FLOAT32:
      return "float32";
    case nifti.NIFTI1.TYPE_FLOAT64:
      return "float64";
    case 128:
      return "rgb24";
    case 2304:
      return "rgba32";
    default:
      return `code-${code}`;
  }
}

function niftiUnitsName(xyzt_units) {
  const SPATIAL_MASK = 0x07;
  const code = (xyzt_units || 0) & SPATIAL_MASK;
  switch (code) {
    case 1:
      return "m";
    case 2:
      return "mm";
    case 3:
      return "um";
    default:
      return "mm";
  }
}
