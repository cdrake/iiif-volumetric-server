// Smoke test: scan the fixtures directory, generate the synthetic NIfTI
// if needed, and check that the in-process pipeline produces a valid
// IIIF info.json, a valid Presentation 4.0 manifest, and a slice PNG.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import fs from "node:fs/promises";

import { registry } from "../src/registry.js";
import { infoJson, renderImageRequest } from "../src/iiif/imageApi.js";
import {
  buildManifest,
  buildExplodedManifest,
  PREZI_4_CONTEXT,
} from "../src/iiif/presentation.js";
import {
  planExplodedView,
  composeExplodedBuffer,
} from "../src/iiif/explode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "..", "fixtures");

async function ensureFixture() {
  const target = path.join(FIXTURES, "synthetic.nii.gz");
  try {
    await fs.access(target);
  } catch (_) {
    spawnSync("node", [
      path.resolve(__dirname, "..", "scripts", "make-synthetic-nifti.js"),
    ], { stdio: "inherit" });
  }
}

test("registry scans NIfTI", async () => {
  await ensureFixture();
  await registry.scan(FIXTURES);
  const list = registry.list();
  const synthetic = list.find((v) => v.id.startsWith("synthetic"));
  assert.ok(synthetic, "synthetic volume should be registered");
  assert.equal(synthetic.format, "nifti");
  assert.deepEqual(synthetic.shape, [64, 64, 64]);
});

test("Image API info.json shape", async () => {
  const entry = await registry.load(
    registry.list().find((v) => v.format === "nifti").id
  );
  const j = infoJson({
    baseUrl: "http://localhost",
    volId: entry.id,
    axis: "axial",
    sliceIndex: 32,
    width: 64,
    height: 64,
  });
  assert.equal(j["@context"], "http://iiif.io/api/image/3/context.json");
  assert.equal(j.type, "ImageService3");
  assert.equal(j.profile, "level1");
  assert.equal(j.width, 64);
  assert.equal(j.height, 64);
  assert.ok(Array.isArray(j.sizes) && j.sizes.length > 0);
});

test("Image API render produces PNG bytes", async () => {
  const entry = await registry.load(
    registry.list().find((v) => v.format === "nifti").id
  );
  const { buffer, contentType } = await renderImageRequest(
    entry.volume,
    "axial",
    32,
    {
      region: "full",
      size: "max",
      rotation: "0",
      quality: "default",
      format: "png",
    }
  );
  assert.equal(contentType, "image/png");
  // PNG signature
  assert.deepEqual([...buffer.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("Presentation 4.0 manifest contains a Scene with a Model body", async () => {
  const id = registry.list().find((v) => v.format === "nifti").id;
  const entry = await registry.load(id);
  const manifest = buildManifest({
    baseUrl: "http://localhost:8080",
    entry,
  });
  assert.equal(manifest["@context"], PREZI_4_CONTEXT);
  assert.equal(manifest.type, "Manifest");
  const scene = manifest.items.find((i) => i.type === "Scene");
  assert.ok(scene, "manifest should contain a Scene");
  const body = scene.items[0].items[0].body;
  assert.equal(body.type, "Model");
  assert.equal(body.format, "application/x.nifti");
  assert.match(body.id, /\/volumes\/.*\/raw\.nii\.gz$/);
});

test("planExplodedView produces nx*ny*nz cells with correct shape", async () => {
  const synthetic = registry.list().find((v) => v.id === "synthetic");
  const entry = await registry.load(synthetic.id);
  const layout = planExplodedView(entry.volume, {
    nx: 3,
    ny: 3,
    nz: 3,
    explode: 1.5,
  });
  assert.deepEqual(layout.cellShape, [21, 21, 21]); // 64 / 3 floored
  assert.equal(layout.cells.length, 27);
  // explode=1.5 means span scales by 1.5 → composite > natural span
  const naturalSpan = layout.cellShape.map((d, i) => d * [3, 3, 3][i]);
  for (let d = 0; d < 3; d++) {
    assert.ok(layout.compositeShape[d] >= naturalSpan[d]);
    assert.ok(layout.compositeShape[d] <= naturalSpan[d] * 1.5 + 2);
  }
  // Cells should not overlap when explode >= 1
  const cellShape = layout.cellShape;
  for (let a = 0; a < layout.cells.length; a++) {
    for (let b = a + 1; b < layout.cells.length; b++) {
      const A = layout.cells[a].compositeOrigin;
      const B = layout.cells[b].compositeOrigin;
      const overlap =
        Math.abs(A[0] - B[0]) < cellShape[0] &&
        Math.abs(A[1] - B[1]) < cellShape[1] &&
        Math.abs(A[2] - B[2]) < cellShape[2];
      assert.ok(!overlap, `cells ${a} and ${b} should not overlap`);
    }
  }
});

test("composeExplodedBuffer copies source voxels to cell origins", async () => {
  const synthetic = registry.list().find((v) => v.id === "synthetic");
  const entry = await registry.load(synthetic.id);
  const layout = planExplodedView(entry.volume, {
    nx: 2,
    ny: 2,
    nz: 2,
    explode: 2,
  });
  const buf = composeExplodedBuffer(entry.volume, layout);
  // For each cell, sample the (0,0,0) voxel of the cell and confirm
  // it equals the source voxel at the cell's source bbox origin.
  const [Cx, Cy] = layout.compositeShape;
  for (const cell of layout.cells) {
    const [x0, y0, z0] = cell.sourceBbox;
    const [sx, sy] = entry.volume.shape;
    const srcVal = entry.volume.data[x0 + y0 * sx + z0 * sx * sy];
    const [ox, oy, oz] = cell.compositeOrigin;
    const dstVal = buf[ox + oy * Cx + oz * Cx * Cy];
    assert.ok(
      Math.abs(dstVal - srcVal) < 1e-5,
      `cell ${cell.i},${cell.j},${cell.k}: expected ${srcVal}, got ${dstVal}`
    );
  }
});

test("buildExplodedManifest emits a Scene with one Annotation per cell", async () => {
  const synthetic = registry.list().find((v) => v.id === "synthetic");
  const entry = await registry.load(synthetic.id);
  const layout = planExplodedView(entry.volume, {
    nx: 2,
    ny: 2,
    nz: 2,
    explode: 1.5,
  });
  const manifest = buildExplodedManifest({
    baseUrl: "http://localhost:8080",
    entry,
    layout,
  });
  const scene = manifest.items.find((i) => i.type === "Scene");
  assert.ok(scene);
  const annotations = scene.items[0].items;
  assert.equal(annotations.length, 8);
  for (const a of annotations) {
    assert.equal(a.body.type, "Model");
    assert.equal(a.body.format, "application/x.nifti");
    assert.match(a.body.id, /\?bbox=/);
    assert.equal(a.selector.type, "PointSelector");
  }
  // Composite rendering link should be present.
  const composite = manifest.rendering.find(
    (r) => r.format === "application/x.nifti"
  );
  assert.ok(composite);
  assert.match(composite.id, /\/exploded\.nii\.gz\?nx=2/);
});
