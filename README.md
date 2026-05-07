# IIIF Volumetric Server (POC)

A small Express server that exposes NIfTI (and other volumetric file types)
through two IIIF specs:

- **IIIF Image API 3.0** — serves axial, coronal, and sagittal slices as
  standard tiled 2D images, so any IIIF viewer (Mirador, Universal Viewer,
  Clover) can browse a volume slice-by-slice.
- **IIIF Presentation API 4.0 alpha** (the current draft including 3D
  support) — generates a Manifest containing the three slice Canvases plus
  a `Scene` with a `Model`-bodied painting Annotation pointing at the raw
  NIfTI volume. The bundled demo viewer renders that 3D scene in your local
  build of [niivuegpu](https://github.com/niivue/niivue) (WebGPU/WebGL2).

This is a proof of concept, not production code. It's intentionally small,
single-process, no caching layer beyond per-volume in-memory caching, and
the non-NIfTI adapters are stubs.

## Quick start

```bash
cd ~/Dev/iiif-volumetric-server
npm install
npm run make-fixture        # writes fixtures/synthetic.nii.gz (64^3 float32)
npm test                    # smoke tests for image API + presentation manifest
npm start                   # auto-detects ../niivuegpu/dist as a sibling
```

Then open <http://127.0.0.1:8080/>. Drop additional `.nii`, `.nii.gz`,
`.nrrd`, `.nhdr`, `*.zarr` directories, or DICOM-series directories into
`fixtures/` and restart.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /api` | Service summary, list of registered volumes with shortcut URLs. |
| `GET /iiif/presentation` | Index of presentation manifests. |
| `GET /iiif/presentation/{id}/manifest` | IIIF Presentation 4.0 alpha manifest with 3 slice Canvases + 1 Scene. |
| `GET /iiif/image/{id}/{axis}/{slice}/info.json` | IIIF Image API 3.0 `info.json` for one slice (axis ∈ axial/coronal/sagittal). |
| `GET /iiif/image/{id}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}` | IIIF Image API 3.0 image request. PNG always supported; JPG falls back to PNG in this POC. |
| `GET /volumes/{id}/raw` | Raw NIfTI bytes (or original source for non-NIfTI). |
| `GET /volumes/{id}/raw?bbox=x0,y0,z0,x1,y1,z1` | Re-emitted NIfTI cropped to the voxel-space bounding box (subvolume support). |
| `GET /volumes/{id}/exploded?nx=3&ny=3&nz=3&explode=1.5` | Composite NIfTI: source split into an `nx×ny×nz` grid of cells, each placed at its exploded position with zeros in the gaps. Loads as a single volume in any NIfTI viewer. |
| `GET /volumes/{id}/exploded/plan?...` | JSON description of the same layout (cell shape, composite shape, per-cell source bbox + composite origin + scene-space center). Cheap; doesn't build the buffer. |
| `GET /iiif/presentation/{id}/exploded/manifest?...` | IIIF manifest where the Scene contains one painting `Annotation` per grid cell (each with a Model body pointing at the cell's `bbox`-cropped NIfTI URL and a `PointSelector` for placement) plus a `rendering` link to the composite NIfTI. |
| `GET /volumes/{id}/metadata` | JSON describing shape, spacing, dtype, intensity range. |

## Architecture

```
src/
├── server.js              # Express bootstrap, route mounting, niivuegpu auto-mount
├── registry.js            # Scans fixtures/ and registers volumes by adapter
├── adapters/
│   ├── volumeHandle.js    # Common VolumeHandle interface + getSlice()
│   ├── nifti.js           # NIfTI-1/2 via nifti-reader-js (real)
│   ├── nrrd.js            # NRRD via nrrd-js (real)
│   ├── dicom.js           # DICOM series — real if dicom-parser installed,
│   │                        otherwise generates a placeholder gradient
│   └── omezarr.js         # OME-Zarr metadata only; placeholder voxel data
├── iiif/
│   ├── imageApi.js        # info.json + region/size/rotation/quality renderer
│   └── presentation.js    # Presentation 4.0 alpha manifest builder (Scene + Model)
├── routes/
│   ├── imageApi.js
│   ├── presentationApi.js
│   └── volumeRoutes.js    # /volumes/{id}/raw with optional bbox crop
└── util/png.js            # pngjs wrapper
public/
├── index.html             # Demo: 3 IIIF slice panes + 1 niivuegpu pane
└── viewer.js
scripts/
└── make-synthetic-nifti.js
test/
└── server.test.js         # Smoke tests
```

### How the 3D bit works

The Presentation 4.0 alpha draft introduces a `Scene` primitive — a
boundless 3D space with a right-handed, Y-up coordinate system. Models are
placed in a Scene by an Annotation with `motivation: "painting"` and a
`body` of `type: "Model"` and a `format` MIME hint. The 3D TSG examples use
`model/gltf-binary` for glTF; for NIfTI volumes we use
`application/x.nifti` and include a small custom extensions block:

```jsonc
{
  "type": "Scene",
  "width": 128, "height": 128, "depth": 128,    // scene-space extent in mm
  "items": [{
    "type": "AnnotationPage",
    "items": [{
      "type": "Annotation",
      "motivation": "painting",
      "target": "<scene id>",
      "body": {
        "id": "http://.../volumes/synthetic/raw",
        "type": "Model",
        "format": "application/x.nifti",
        "https://example.org/iiif/volumetric#": {
          "shape": [64, 64, 64],
          "spacing": [2, 2, 2],
          "dtype": "float32",
          "viewer": "http://.../?manifest=..."
        }
      }
    }]
  }]
}
```

The demo viewer (`public/viewer.js`) finds that `Model` body and calls
niivuegpu's `loadVolumes([{ url }])` against it. niivuegpu does its own
NIfTI parsing and WebGPU/WebGL2 rendering — the IIIF server never has to
ship pixel data to the GPU itself.

### Exploded view

`/volumes/{id}/exploded?nx=3&ny=3&nz=3&explode=1.5` returns a single
NIfTI containing the source volume split into an N×N×N grid of cells,
each translated outward from the grid centre by the `explode` factor.
With `explode=1` the cells touch (composite ≈ source). With
`explode=2` there's exactly one cell-width of empty space between
neighbouring cell centres. Gaps are filled with zeros, so the result
is one renderable volume.

The matching IIIF manifest at
`/iiif/presentation/{id}/exploded/manifest?...` describes the same
layout structurally — its Scene contains one painting `Annotation` per
cell, each with a `Model` body pointing at that cell's
`bbox`-cropped NIfTI URL and a `PointSelector` placing it in scene
units (voxel × spacing). The Scene's `rendering` link points at the
composite NIfTI for clients that prefer a single-volume render (which
is what the bundled niivuegpu-driven viewer uses).

POC limits enforced by `src/iiif/explode.js`: each axis ∈ [1,10],
total cells ≤ 125, `explode` ∈ [1, 5], composite ≤ 200M voxels. The
demo viewer's "Render exploded" toggle exposes nx/ny/nz/explode
controls. The exploded composite is regenerated server-side per
request — there's no on-disk cache yet.

### Subvolume support

`/volumes/{id}/raw?bbox=x0,y0,z0,x1,y1,z1` re-emits a NIfTI containing
only the voxels inside the box. The header is regenerated with the new
dims and original pixdims; the affine (qform/sform) is intentionally left
unset in this POC, so subvolumes are addressed in voxel coordinates. A
production version should shift the affine origin by the bbox start.

You can use the bbox parameter directly from any client:

```bash
curl "http://localhost:8080/volumes/synthetic/raw?bbox=16,16,16,48,48,48" -o crop.nii.gz
```

…or have the manifest reference a subvolume by encoding the bbox into the
Model body's `id` URL.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PUBLIC_BASE_URL` | `http://${HOST}:${PORT}` | Used in generated manifests / info.json IDs. Set this when behind a reverse proxy. |
| `FIXTURES_DIR` | `./fixtures` | Directory the server scans for volumes on startup. |
| `NIIVUEGPU_DIST` | auto-detect | Path to a built niivuegpu `dist/` directory. Auto-detects `~/Dev/niivuegpu/dist` and `../niivuegpu/dist`. |

## Format support matrix

| Format | Detection | Slices (Image API) | Manifest (Presentation API) | Raw download | bbox crop |
| --- | --- | --- | --- | --- | --- |
| NIfTI 1/2 (`.nii`, `.nii.gz`) | filename | ✅ real pixels | ✅ Scene + Model | ✅ original gzip | ✅ re-emitted NIfTI |
| NRRD (`.nrrd`, `.nhdr`) | filename | ✅ real pixels | ✅ | ✅ original | ❌ POC scope |
| DICOM series (folder named `*_dicom`) | folder | ✅ if `dicom-parser` installed, else gradient | ✅ | ❌ (folder) | ❌ |
| OME-Zarr (`*.zarr` folder) | folder | ⚠ metadata-only, gradient pixel data | ✅ | ❌ (folder) | ❌ |

To enable real DICOM pixel decoding: `npm install dicom-parser`. To enable
real OME-Zarr decoding, swap in zarrita.js and decode chunks in
`omezarr.js`.

## Limitations / not yet done

- **Affine handling.** Slices are produced in voxel space; we don't apply
  the qform/sform affine. Real medical viewers should.
- **No real tile pyramid.** The Image API endpoint generates one
  resolution and resamples nearest-neighbour on demand. For large
  volumes you'd pre-tile.
- **JPG output is PNG with a JPG URL.** Add `sharp` to fix.
- **Subvolume cropping is voxel-aligned only and NIfTI-only.**
- **niivuegpu must be a sibling repo or pointed at via `NIIVUEGPU_DIST`.**
  We mount the prebuilt `dist/` directly rather than bundling, so the demo
  page imports `/vendor/niivuegpu/niivuegpu.js` with no bundler.
- The `application/x.nifti` MIME type is not officially registered; when
  the IIIF 3D TSG settles a media type for volumetric data it should
  replace it.

## References

- IIIF Image API 3.0 — <https://iiif.io/api/image/3.0/>
- IIIF Presentation API 4.0 alpha (draft 3D) —
  <https://preview.iiif.io/api/prezi-4/presentation/4.0/>
- IIIF 3D TSG repository — <https://github.com/IIIF/3d>
- niivuegpu — `~/Dev/niivuegpu`
- nifti-reader-js — <https://github.com/rii-mango/NIFTI-Reader-JS>
