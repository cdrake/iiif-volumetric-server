// In-memory volume registry. Scans a directory tree, decides which adapter
// can handle each file (or DICOM directory), and lazily loads volumes on
// first access. Volumes are cached after first load.

import fs from "node:fs/promises";
import path from "node:path";

import { niftiAdapter } from "./adapters/nifti.js";
import { nrrdAdapter } from "./adapters/nrrd.js";
import { dicomAdapter } from "./adapters/dicom.js";
import { omezarrAdapter } from "./adapters/omezarr.js";

const ADAPTERS = [niftiAdapter, nrrdAdapter, omezarrAdapter, dicomAdapter];

class Registry {
  constructor() {
    /** @type {Map<string, {id:string, format:string, source:string, adapter:any, shape:number[], dtype:string, spacing:number[], volume:any}>} */
    this.entries = new Map();
  }

  size() {
    return this.entries.size;
  }

  list() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      format: e.format,
      shape: e.shape,
      dtype: e.dtype,
      spacing: e.spacing,
      source: e.source,
    }));
  }

  get(id) {
    return this.entries.get(id);
  }

  /**
   * Get a fully-loaded VolumeHandle for an entry id, loading it if needed.
   */
  async load(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      const err = new Error(`Unknown volume id: ${id}`);
      err.status = 404;
      throw err;
    }
    if (!entry.volume) {
      entry.volume = await entry.adapter.load(entry.source);
      // Update shape/dtype/spacing from the canonical loaded handle
      entry.shape = entry.volume.shape;
      entry.dtype = entry.volume.dtype;
      entry.spacing = entry.volume.spacing;
    }
    return entry;
  }

  /**
   * Scan a directory and register every supported volume found at the top
   * level. DICOM is detected by directory (a folder containing many .dcm
   * files becomes a single registered volume).
   */
  async scan(dir) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        console.warn(`Fixtures directory ${dir} does not exist; skipping`);
        return;
      }
      throw err;
    }

    for (const item of items) {
      const full = path.join(dir, item.name);
      try {
        if (item.isDirectory()) {
          // DICOM series live as directories; OME-Zarr stores are also
          // directory trees ending in .zarr or .ome.zarr.
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: true })
          );
          if (!adapter) continue;
          const id = sanitizeId(item.name);
          const probe = await adapter.probe(full);
          this.entries.set(id, {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            volume: null,
          });
        } else if (item.isFile()) {
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: false })
          );
          if (!adapter) continue;
          const id = sanitizeId(stripVolumeExtensions(item.name));
          const probe = await adapter.probe(full);
          this.entries.set(id, {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            volume: null,
          });
        }
      } catch (err) {
        console.warn(
          `Skipping ${full}: ${err.message || err} (probe failed)`
        );
      }
    }
  }
}

function sanitizeId(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function stripVolumeExtensions(name) {
  return name
    .replace(/\.nii\.gz$/i, "")
    .replace(/\.nii$/i, "")
    .replace(/\.nhdr$/i, "")
    .replace(/\.nrrd$/i, "")
    .replace(/\.ome\.tiff?$/i, "")
    .replace(/\.tiff?$/i, "");
}

export const registry = new Registry();
