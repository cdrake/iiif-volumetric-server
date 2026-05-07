// In-memory volume registry. Scans a directory tree, decides which adapter
// can handle each file (or DICOM directory), and lazily loads volumes on
// first access. Volumes are cached after first load.

import fs from "node:fs/promises";
import path from "node:path";

import { niftiAdapter } from "./adapters/nifti.js";
import { nrrdAdapter } from "./adapters/nrrd.js";
import { dicomAdapter } from "./adapters/dicom.js";
import { omezarrAdapter } from "./adapters/omezarr.js";
import { downsampleVolume } from "./util/downsample.js";
import { encodeNifti } from "./util/niftiEncoder.js";

const ADAPTERS = [niftiAdapter, nrrdAdapter, omezarrAdapter, dicomAdapter];

class Registry {
  constructor() {
    /** @type {Map<string, {id:string, format:string, source:string, adapter:any, shape:number[], dtype:string, spacing:number[], levels: any[], volume:any}>} */
    this.entries = new Map();
    this.cacheDir = null;
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
      levels: e.levels,
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
    this.cacheDir = path.join(dir, ".cache");
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (_) {}

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
      if (item.name === ".cache") continue;
      const full = path.join(dir, item.name);
      try {
        let entry;
        if (item.isDirectory()) {
          // DICOM series live as directories; OME-Zarr stores are also
          // directory trees ending in .zarr or .ome.zarr.
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: true })
          );
          if (!adapter) continue;
          const id = sanitizeId(item.name);
          const probe = await adapter.probe(full);
          entry = {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            levels: [],
            volume: null,
          };
        } else if (item.isFile()) {
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: false })
          );
          if (!adapter) continue;
          const id = sanitizeId(stripVolumeExtensions(item.name));
          const probe = await adapter.probe(full);
          entry = {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            levels: [],
            volume: null,
          };
        }
        if (entry) {
          this.entries.set(entry.id, entry);
          await this._refreshLevels(entry);
          // Trigger background pyramid generation if missing
          this._generatePyramidBackground(entry.id);
        }
      } catch (err) {
        console.warn(
          `Skipping ${full}: ${err.message || err} (probe failed)`
        );
      }
    }
  }

  async _refreshLevels(entry) {
    const levels = [{ level: 0, shape: entry.shape, spacing: entry.spacing }];
    for (let l = 1; l <= 3; l++) {
      const p = path.join(this.cacheDir, `${entry.id}_L${l}.nii.gz`);
      try {
        await fs.access(p);
        // Level exists, probe it to get shape/spacing
        const probe = await niftiAdapter.probe(p);
        levels.push({
          level: l,
          shape: probe.shape,
          spacing: probe.spacing,
          path: p,
        });
      } catch (_) {
        // missing
      }
    }
    entry.levels = levels;
  }

  async _generatePyramidBackground(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.format !== "nifti") return;

    // Check if we already have levels
    if (entry.levels.length > 1) return;

    // Don't await this, let it run in background
    this._doGeneratePyramid(id).catch((err) => {
      console.error(`Failed to generate pyramid for ${id}:`, err);
    });
  }

  async _doGeneratePyramid(id) {
    console.log(`Generating pyramid for ${id}...`);
    const entry = await this.load(id);
    let currentVolume = entry.volume;
    for (let l = 1; l <= 3; l++) {
      const p = path.join(this.cacheDir, `${id}_L${l}.nii.gz`);
      try {
        await fs.access(p);
        // already exists, load it as current for next level
        const next = await niftiAdapter.load(p);
        currentVolume = next;
        continue;
      } catch (_) {}

      try {
        const down = downsampleVolume(currentVolume, 2);
        const encoded = encodeNifti({
          data: down.data,
          shape: down.shape,
          spacing: down.spacing,
          dtype: down.dtype,
        });
        await fs.writeFile(p, encoded);
        console.log(`  - Wrote ${id} level ${l} (${down.shape.join("x")})`);
        currentVolume = down;
      } catch (err) {
        console.warn(`  - Could not generate level ${l} for ${id}: ${err.message}`);
        break;
      }
    }
    await this._refreshLevels(entry);
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
