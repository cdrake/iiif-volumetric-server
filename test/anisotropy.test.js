
import { test } from "node:test";
import assert from "node:assert/strict";
import { VolumeHandle } from "../src/adapters/volumeHandle.js";
import { infoJson, renderImageRequest } from "../src/iiif/imageApi.js";

test("VolumeHandle extracts spacing from affine", () => {
  const affine = [
    [0.5, 0, 0, 10],
    [0, 1, 0, 20],
    [0, 0, 2, 30],
    [0, 0, 0, 1]
  ];
  const vol = new VolumeHandle({
    shape: [100, 100, 100],
    data: new Uint8Array(100 * 100 * 100),
    dtype: "uint8",
    affine
  });
  assert.deepEqual(vol.spacing, [0.5, 1, 2]);
});

test("VolumeHandle physicalSliceDims with anisotropy", () => {
  const vol = new VolumeHandle({
    shape: [100, 100, 20],
    spacing: [1, 1, 5],
    data: new Uint8Array(100 * 100 * 20),
    dtype: "uint8"
  });
  
  // Axial: 100x1, 100x1 = 100x100
  assert.deepEqual(vol.physicalSliceDims("axial"), [100, 100]);
  // Coronal: 100x1, 20x5 = 100x100
  assert.deepEqual(vol.physicalSliceDims("coronal"), [100, 100]);
  // Sagittal: 100x1, 20x5 = 100x100
  assert.deepEqual(vol.physicalSliceDims("sagittal"), [100, 100]);
});

test("renderImageRequest scales anisotropic slices", async () => {
  // 10x10x2 voxels, but spacing is [1, 1, 5] -> 10x10x10 physical
  const data = new Uint8Array(10 * 10 * 2);
  data[0] = 255;
  
  const vol = new VolumeHandle({
    shape: [10, 10, 2],
    spacing: [1, 1, 5],
    data,
    dtype: "uint8"
  });

  // Coronal slice (constant y)
  // shape [10, 2] voxels. physical [10, 10].
  const { buffer, contentType } = await renderImageRequest(
    vol,
    "coronal",
    0,
    { region: "full", size: "max", rotation: "0", quality: "default", format: "png" }
  );

  assert.equal(contentType, "image/png");
  assert.ok(buffer.length > 0);
});
