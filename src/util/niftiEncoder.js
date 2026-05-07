import { gzipSync } from "node:zlib";
import nifti from "nifti-reader-js";

/**
 * Build a gzipped NIfTI-1 file from a typed array + dims + dtype.
 */
export function encodeNifti({ data, shape, spacing, dtype }) {
  const colorBytes = dtype === "rgb24" ? 3 : dtype === "rgba32" ? 4 : 0;
  const elemBytes = colorBytes || data.BYTES_PER_ELEMENT;
  const header = makeNifti1Header({
    dims: shape,
    pixDims: spacing,
    datatypeCode: dtypeNameToNiftiCode(dtype),
    bitsPerVoxel: elemBytes * 8,
  });
  const fileBuf = Buffer.alloc(352 + data.byteLength);
  Buffer.from(header).copy(fileBuf, 0);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(
    fileBuf,
    352
  );
  return gzipSync(fileBuf);
}

/**
 * Build a minimal NIfTI-1 header (348 + 4 padding = 352 bytes,
 * vox_offset=352).
 */
export function makeNifti1Header({ dims, pixDims, datatypeCode, bitsPerVoxel }) {
  const buf = new ArrayBuffer(352);
  const view = new DataView(buf);
  // sizeof_hdr
  view.setInt32(0, 348, true);
  // dim[8] starts at offset 40
  view.setInt16(40, 3, true); // dim[0] = 3 (3D volume)
  view.setInt16(42, dims[0], true);
  view.setInt16(44, dims[1], true);
  view.setInt16(46, dims[2], true);
  view.setInt16(48, 1, true);
  view.setInt16(50, 1, true);
  view.setInt16(52, 1, true);
  view.setInt16(54, 1, true);
  // datatype at offset 70, bitpix at 72
  view.setInt16(70, datatypeCode, true);
  view.setInt16(72, bitsPerVoxel, true);
  // pixdim[8] at offset 76
  view.setFloat32(76, 1, true); // pixdim[0]
  view.setFloat32(80, pixDims[0] || 1, true);
  view.setFloat32(84, pixDims[1] || 1, true);
  view.setFloat32(88, pixDims[2] || 1, true);
  // vox_offset at 108
  view.setFloat32(108, 352, true);
  // scl_slope at 112, scl_inter at 116 — leave 0 (means no scaling)
  // magic "n+1\0" at 344
  const magic = new Uint8Array(buf, 344, 4);
  magic[0] = 0x6e; // n
  magic[1] = 0x2b; // +
  magic[2] = 0x31; // 1
  magic[3] = 0x00;
  return buf;
}

export function dtypeNameToNiftiCode(name) {
  switch (name) {
    case "uint8":
      return nifti.NIFTI1.TYPE_UINT8;
    case "int8":
      return nifti.NIFTI1.TYPE_INT8;
    case "int16":
      return nifti.NIFTI1.TYPE_INT16;
    case "uint16":
      return nifti.NIFTI1.TYPE_UINT16;
    case "int32":
      return nifti.NIFTI1.TYPE_INT32;
    case "uint32":
      return nifti.NIFTI1.TYPE_UINT32;
    case "float32":
      return nifti.NIFTI1.TYPE_FLOAT32;
    case "float64":
      return nifti.NIFTI1.TYPE_FLOAT64;
    case "rgb24":
      return 128;
    case "rgba32":
      return 2304;
    default:
      throw new Error(`Cannot map dtype to NIfTI datatype: ${name}`);
  }
}
