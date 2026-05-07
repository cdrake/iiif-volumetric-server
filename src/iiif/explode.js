// Exploded-view composition.
//
// Given a source VolumeHandle, an (nx, ny, nz) cell grid, and an
// `explode` factor, this module:
//
// 1. Splits the source into nx*ny*nz axis-aligned subvolume cells of
//    equal size (rounded down). Any leftover voxels at the high edge
//    of each axis are clipped — the cells together always cover a
//    rectangular region, never the ragged remainder.
// 2. Computes each cell's *exploded* placement: cell centres scale away
//    from the grid centre by `explode`. With explode=1.0 cells touch;
//    with explode=2.0 there's exactly one cell-width of empty space
//    between cell centres along every axis.
// 3. Returns enough metadata to (a) write a composite NIfTI containing
//    all cells placed at their exploded positions with zeros in
//    between, and (b) generate a per-cell IIIF Scene annotation that
//    matches the same layout.
//
// Coordinates are voxel-space (integers) for everything that touches
// the source/composite buffers. The IIIF Scene placement uses scene
// units = voxel * spacing.

const MAX_VOXELS = 200_000_000; // ~200M voxels max composite (≈800MB float32)

/**
 * @typedef {object} ExplodeParams
 * @property {number} nx
 * @property {number} ny
 * @property {number} nz
 * @property {number} explode  (optional) scales all axes equally if ex/ey/ez not provided
 * @property {number} ex       (optional) explode factor for X axis
 * @property {number} ey       (optional) explode factor for Y axis
 * @property {number} ez       (optional) explode factor for Z axis
 */

/**
 * @typedef {object} ExplodeCell
 * @property {number} i
 * @property {number} j
 * @property {number} k
 * @property {number[]} sourceBbox  [x0,y0,z0,x1,y1,z1] in source voxels
 * @property {number[]} compositeOrigin [ox,oy,oz] in composite voxels
 * @property {number[]} sceneCenter [x,y,z] in scene units (mm-ish)
 */

/**
 * @typedef {object} ExplodeLayout
 * @property {number[]} cellShape    voxel dims of one cell
 * @property {number[]} compositeShape voxel dims of the composite
 * @property {number[]} compositeSpacing  same as source spacing
 * @property {ExplodeCell[]} cells
 * @property {object} params         the normalized parameters used
 */

/**
 * Compute the layout without producing pixel data. Cheap; safe to call
 * for every manifest request.
 */
export function planExplodedView(volume, params) {
  const { nx, ny, nz, ex, ey, ez } = normalizeParams(params);
  const [sx, sy, sz] = volume.shape;
  const cx = Math.floor(sx / nx);
  const cy = Math.floor(sy / ny);
  const cz = Math.floor(sz / nz);
  if (cx < 1 || cy < 1 || cz < 1) {
    const err = new Error(
      `Grid ${nx}×${ny}×${nz} is finer than source shape ${sx}×${sy}×${sz}; cell would be empty.`
    );
    err.status = 400;
    throw err;
  }

  // Centre offset (in voxel units) from grid origin to grid centre.
  const grid = { cx, cy, cz, nx, ny, nz };

  // Each cell is placed so that its centre = explode_axis * (natural offset
  // from grid centre) + global origin. We work out where the lowest
  // exploded origin lands, then translate everything so the composite
  // starts at (0,0,0).
  const placements = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const naturalCenter = [
          (i + 0.5) * cx,
          (j + 0.5) * cy,
          (k + 0.5) * cz,
        ];
        const gridCenter = [(nx * cx) / 2, (ny * cy) / 2, (nz * cz) / 2];
        const explodedCenter = [
          gridCenter[0] + ex * (naturalCenter[0] - gridCenter[0]),
          gridCenter[1] + ey * (naturalCenter[1] - gridCenter[1]),
          gridCenter[2] + ez * (naturalCenter[2] - gridCenter[2]),
        ];
        const explodedOrigin = [
          Math.round(explodedCenter[0] - cx / 2),
          Math.round(explodedCenter[1] - cy / 2),
          Math.round(explodedCenter[2] - cz / 2),
        ];
        const sourceBbox = [
          i * cx,
          j * cy,
          k * cz,
          i * cx + cx,
          j * cy + cy,
          k * cz + cz,
        ];
        placements.push({ i, j, k, sourceBbox, explodedOrigin });
      }
    }
  }

  // Translate so the lowest exploded origin is at (0,0,0).
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  for (const p of placements) {
    if (p.explodedOrigin[0] < minX) minX = p.explodedOrigin[0];
    if (p.explodedOrigin[1] < minY) minY = p.explodedOrigin[1];
    if (p.explodedOrigin[2] < minZ) minZ = p.explodedOrigin[2];
  }

  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const cells = placements.map((p) => {
    const o = [
      p.explodedOrigin[0] - minX,
      p.explodedOrigin[1] - minY,
      p.explodedOrigin[2] - minZ,
    ];
    if (o[0] + cx > maxX) maxX = o[0] + cx;
    if (o[1] + cy > maxY) maxY = o[1] + cy;
    if (o[2] + cz > maxZ) maxZ = o[2] + cz;
    const sceneCenter = [
      (o[0] + cx / 2) * (volume.spacing?.[0] || 1),
      (o[1] + cy / 2) * (volume.spacing?.[1] || 1),
      (o[2] + cz / 2) * (volume.spacing?.[2] || 1),
    ];
    return {
      i: p.i,
      j: p.j,
      k: p.k,
      sourceBbox: p.sourceBbox,
      compositeOrigin: o,
      sceneCenter,
    };
  });

  const compositeShape = [maxX, maxY, maxZ];
  const totalVoxels = compositeShape[0] * compositeShape[1] * compositeShape[2];
  if (totalVoxels > MAX_VOXELS) {
    const err = new Error(
      `Exploded composite would be ${compositeShape.join(
        "×"
      )} = ${totalVoxels.toLocaleString()} voxels (max ${MAX_VOXELS.toLocaleString()}). Reduce nx/ny/nz or explode.`
    );
    err.status = 413;
    throw err;
  }

  return {
    cellShape: [cx, cy, cz],
    compositeShape,
    compositeSpacing: volume.spacing || [1, 1, 1],
    cells,
    params: { nx, ny, nz, ex, ey, ez },
  };
}

/**
 * Allocate a composite typed array and copy each cell from source.
 * Output array shape matches `layout.compositeShape` in source dtype.
 * For RGB/RGBA volumes the output is also a Uint8Array of the same
 * bytes-per-voxel layout.
 */
export function composeExplodedBuffer(volume, layout) {
  const [sx, sy] = volume.shape;
  const [Cx, Cy, Cz] = layout.compositeShape;
  const [cx, cy, cz] = layout.cellShape;

  const colorBytes =
    volume.dtype === "rgb24" ? 3 : volume.dtype === "rgba32" ? 4 : 0;
  const elemsPerVoxel = colorBytes || 1;
  const TypedArrayCtor = volume.data.constructor;
  const out = new TypedArrayCtor(Cx * Cy * Cz * elemsPerVoxel);

  if (colorBytes === 0) {
    const { min } = volume.intensityRange();
    out.fill(min);
  }

  for (const cell of layout.cells) {
    const [x0, y0, z0, x1, y1, z1] = cell.sourceBbox;
    const cw = x1 - x0;
    const [ox, oy, oz] = cell.compositeOrigin;
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        const srcVox = x0 + (y0 + y) * sx + (z0 + z) * sx * sy;
        const dstVox =
          ox + (oy + y) * Cx + (oz + z) * Cx * Cy;
        const srcStart = srcVox * elemsPerVoxel;
        const dstStart = dstVox * elemsPerVoxel;
        const len = cw * elemsPerVoxel;
        out.set(volume.data.subarray(srcStart, srcStart + len), dstStart);
      }
    }
  }
  return out;
}

function normalizeParams(p) {
  const nx = clampInt(p?.nx, 1, 10, "nx");
  const ny = clampInt(p?.ny, 1, 10, "ny");
  const nz = clampInt(p?.nz, 1, 10, "nz");
  if (nx * ny * nz > 125) {
    const err = new Error(
      `Grid ${nx}×${ny}×${nz} = ${nx * ny * nz} cells exceeds the POC cap of 125`
    );
    err.status = 400;
    throw err;
  }
  let baseExplode = Number(p?.explode);
  if (!Number.isFinite(baseExplode)) baseExplode = 1.5;

  const ex = clampExplode(p?.ex ?? baseExplode);
  const ey = clampExplode(p?.ey ?? baseExplode);
  const ez = clampExplode(p?.ez ?? baseExplode);

  return { nx, ny, nz, ex, ey, ez };
}

function clampExplode(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 1.5;
  if (n < 1) n = 1;
  if (n > 5) n = 5;
  return n;
}

function clampInt(v, lo, hi, name) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) {
    const err = new Error(`${name} must be an integer in [${lo}, ${hi}]`);
    err.status = 400;
    throw err;
  }
  return n;
}
