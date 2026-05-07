import { VolumeHandle } from "../adapters/volumeHandle.js";

/**
 * Downsample a volume by a factor (usually 2) using 2x2x2 block averaging.
 * Returns a new VolumeHandle.
 */
export function downsampleVolume(volume, factor = 2) {
  const [sx, sy, sz] = volume.shape;
  const [dx, dy, dz] = volume.spacing;
  const [nx, ny, nz] = [
    Math.floor(sx / factor),
    Math.floor(sy / factor),
    Math.floor(sz / factor),
  ];

  if (nx < 1 || ny < 1 || nz < 1) {
    throw new Error("Volume is too small to downsample further");
  }

  const colorBytes =
    volume.dtype === "rgb24" ? 3 : volume.dtype === "rgba32" ? 4 : 0;
  const isColor = colorBytes > 0;
  const TypedArrayCtor = volume.data.constructor;
  const out = new TypedArrayCtor(nx * ny * nz * (colorBytes || 1));

  const f2 = factor * factor;
  const f3 = factor * factor * factor;

  if (!isColor) {
    // Scalar path
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let sum = 0;
          for (let bz = 0; z * factor + bz < sx && bz < factor; bz++) {
            for (let by = 0; y * factor + by < sy && by < factor; by++) {
              for (let bx = 0; x * factor + bx < sx && bx < factor; bx++) {
                const ix = x * factor + bx;
                const iy = y * factor + by;
                const iz = z * factor + bz;
                sum += volume.data[ix + iy * sx + iz * sx * sy];
              }
            }
          }
          const val = sum / f3;
          out[x + y * nx + z * nx * ny] =
            TypedArrayCtor === Float32Array || TypedArrayCtor === Float64Array
              ? val
              : Math.round(val);
        }
      }
    }
  } else {
    // Color path
    const bpcv = colorBytes;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const sums = new Float32Array(bpcv);
          for (let bz = 0; z * factor + bz < sx && bz < factor; bz++) {
            for (let by = 0; y * factor + by < sy && by < factor; by++) {
              for (let bx = 0; x * factor + bx < sx && bx < factor; bx++) {
                const ix = x * factor + bx;
                const iy = y * factor + by;
                const iz = z * factor + bz;
                const off = (ix + iy * sx + iz * sx * sy) * bpcv;
                for (let c = 0; c < bpcv; c++) {
                  sums[c] += volume.data[off + c];
                }
              }
            }
          }
          const dstOff = (x + y * nx + z * nx * ny) * bpcv;
          for (let c = 0; c < bpcv; c++) {
            out[dstOff + c] = Math.round(sums[c] / f3);
          }
        }
      }
    }
  }

  return new VolumeHandle({
    shape: [nx, ny, nz],
    spacing: [dx * factor, dy * factor, dz * factor],
    dtype: volume.dtype,
    data: out,
    units: volume.units,
    metadata: {
        ...volume.metadata,
        downsampled: factor
    }
  });
}
