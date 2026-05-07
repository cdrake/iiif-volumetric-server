// Common VolumeHandle interface produced by every adapter. Routes only
// interact with this, so adding a new format means writing a new adapter
// that returns one of these.
//
// Layout convention: the typed-array `data` is in Fortran order
// (x fastest). shape = [sx, sy, sz]. spacing is in millimetres
// (or the file's native units), as [dx, dy, dz]. orientation is a 3x3
// matrix (row-major) mapping voxel axes to world axes; identity if
// unknown. dtype is one of: "uint8", "int16", "uint16", "int32",
// "float32", "float64".

export class VolumeHandle {
  constructor({
    shape,
    spacing,
    dtype,
    data,
    orientation = IDENTITY3,
    affine = null,
    units = "mm",
    metadata = {},
  }) {
    if (!Array.isArray(shape) || shape.length !== 3) {
      throw new Error("VolumeHandle requires a 3-element shape");
    }
    this.shape = shape;
    this.spacing = spacing || [1, 1, 1];
    this.dtype = dtype;
    this.data = data;
    this.orientation = orientation;
    this.affine = affine;
    this.units = units;
    this.metadata = metadata;
    this._minMax = null;

    if (this.affine) {
      this.spacing = [
        Math.sqrt(
          this.affine[0][0] ** 2 + this.affine[1][0] ** 2 + this.affine[2][0] ** 2
        ),
        Math.sqrt(
          this.affine[0][1] ** 2 + this.affine[1][1] ** 2 + this.affine[2][1] ** 2
        ),
        Math.sqrt(
          this.affine[0][2] ** 2 + this.affine[1][2] ** 2 + this.affine[2][2] ** 2
        ),
      ];
    }
  }

  /** Number of bytes per voxel for RGB types; 0 means scalar. */
  get _bytesPerColorVoxel() {
    if (this.dtype === "rgb24") return 3;
    if (this.dtype === "rgba32") return 4;
    return 0;
  }

  /** Cached intensity range (used to scale scalar volumes to 8-bit). */
  intensityRange() {
    if (this._minMax) return this._minMax;
    if (this._bytesPerColorVoxel > 0) {
      this._minMax = { min: 0, max: 255 };
      return this._minMax;
    }
    let min = Infinity;
    let max = -Infinity;
    const d = this.data;
    // Sample every Nth voxel for big volumes — exact min/max isn't
    // critical for display windowing.
    const step = Math.max(1, Math.floor(d.length / 1_000_000));
    for (let i = 0; i < d.length; i += step) {
      const v = d[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max) || min === max) {
      min = 0;
      max = 1;
    }
    this._minMax = { min, max };
    return this._minMax;
  }

  /**
   * Return a 2D slice as { width, height, data: Uint8Array (rgba)}.
   * axis: "axial" (constant z), "coronal" (constant y), "sagittal"
   * (constant x). index: integer slice index.
   * Note: these are raw voxel dimensions.
   */
  getSlice(axis, index) {
    const [sx, sy, sz] = this.shape;

    let width;
    let height;
    let pickIjk;

    if (axis === "axial") {
      if (index < 0 || index >= sz) throw rangeErr(axis, index, sz);
      width = sx;
      height = sy;
      pickIjk = (u, v) => [u, v, index];
    } else if (axis === "coronal") {
      if (index < 0 || index >= sy) throw rangeErr(axis, index, sy);
      width = sx;
      height = sz;
      pickIjk = (u, v) => [u, index, sz - 1 - v];
    } else if (axis === "sagittal") {
      if (index < 0 || index >= sx) throw rangeErr(axis, index, sx);
      width = sy;
      height = sz;
      pickIjk = (u, v) => [index, u, sz - 1 - v];
    } else {
      throw new Error(`Unknown axis: ${axis}`);
    }

    const rgba = new Uint8Array(width * height * 4);
    const bpcv = this._bytesPerColorVoxel;

    if (bpcv === 0) {
      const { min, max } = this.intensityRange();
      const scale = max > min ? 255 / (max - min) : 1;
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) {
          const [x, y, z] = pickIjk(u, v);
          const value = this._voxelScalar(x, y, z);
          const g = clampByte((value - min) * scale);
          const o = (v * width + u) * 4;
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;
        }
      }
    } else {
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) {
          const [x, y, z] = pickIjk(u, v);
          const off = this._colorVoxelOffset(x, y, z, bpcv);
          const o = (v * width + u) * 4;
          rgba[o] = this.data[off];
          rgba[o + 1] = this.data[off + 1];
          rgba[o + 2] = this.data[off + 2];
          rgba[o + 3] = bpcv === 4 ? this.data[off + 3] : 255;
        }
      }
    }
    return { width, height, data: rgba };
  }

  /** Scalar voxel access using the [x,y,z] (Fortran) layout. */
  _voxelScalar(x, y, z) {
    const [sx, sy] = this.shape;
    return this.data[x + y * sx + z * sx * sy];
  }

  /** Byte offset of a colored voxel in the underlying Uint8Array. */
  _colorVoxelOffset(x, y, z, bpcv) {
    const [sx, sy] = this.shape;
    return (x + y * sx + z * sx * sy) * bpcv;
  }

  /** Backwards-compatible alias used by older callers. */
  _voxel(x, y, z) {
    return this._voxelScalar(x, y, z);
  }

  sliceCount(axis) {
    if (axis === "axial") return this.shape[2];
    if (axis === "coronal") return this.shape[1];
    if (axis === "sagittal") return this.shape[0];
    throw new Error(`Unknown axis: ${axis}`);
  }

  /** Returns [width, height] in voxels for the given axis. */
  sliceDims(axis) {
    if (axis === "axial") return [this.shape[0], this.shape[1]];
    if (axis === "coronal") return [this.shape[0], this.shape[2]];
    if (axis === "sagittal") return [this.shape[1], this.shape[2]];
    throw new Error(`Unknown axis: ${axis}`);
  }

  /** Returns [width, height] in physical units (e.g. mm) for the given axis. */
  physicalSliceDims(axis) {
    const [sx, sy, sz] = this.shape;
    const [dx, dy, dz] = this.spacing;
    if (axis === "axial") return [sx * dx, sy * dy];
    if (axis === "coronal") return [sx * dx, sz * dz];
    if (axis === "sagittal") return [sy * dy, sz * dz];
    throw new Error(`Unknown axis: ${axis}`);
  }
}

const IDENTITY3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function clampByte(v) {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return v | 0;
}

function rangeErr(axis, index, n) {
  const err = new Error(
    `Slice index ${index} out of range for axis ${axis} (0..${n - 1})`
  );
  err.status = 416;
  return err;
}
