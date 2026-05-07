// NRRD adapter. nrrd-js parses both detached header (.nhdr) and combined
// (.nrrd) forms and gives back a typed array.

import fs from "node:fs/promises";
import nrrd from "nrrd-js";
import { VolumeHandle } from "./volumeHandle.js";

export const nrrdAdapter = {
  format: "nrrd",

  canHandle(p, { isDirectory }) {
    if (isDirectory) return false;
    return /\.(nrrd|nhdr)$/i.test(p);
  },

  async probe(filePath) {
    const parsed = await parse(filePath);
    return summarize(parsed);
  },

  async load(filePath) {
    const parsed = await parse(filePath);
    const summary = summarize(parsed);
    return new VolumeHandle({
      shape: summary.shape,
      spacing: summary.spacing,
      dtype: summary.dtype,
      data: parsed.data,
      metadata: {
        encoding: parsed.encoding,
        endian: parsed.endian,
        space: parsed.space,
      },
    });
  },
};

async function parse(filePath) {
  const buf = await fs.readFile(filePath);
  // nrrd-js works with Buffer / ArrayBuffer
  return nrrd.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function summarize(parsed) {
  const sizes = parsed.sizes || [1, 1, 1];
  const shape = [sizes[0] || 1, sizes[1] || 1, sizes[2] || 1];
  let spacing = [1, 1, 1];
  if (parsed.spacings && parsed.spacings.length >= 3) {
    spacing = [
      parsed.spacings[0] || 1,
      parsed.spacings[1] || 1,
      parsed.spacings[2] || 1,
    ];
  } else if (
    parsed.spaceDirections &&
    parsed.spaceDirections.length >= 3 &&
    parsed.spaceDirections.every(Array.isArray)
  ) {
    spacing = parsed.spaceDirections
      .slice(0, 3)
      .map((v) => Math.hypot(...v.map(Number)) || 1);
  }
  return {
    shape,
    dtype: parsed.type || "float32",
    spacing,
  };
}
