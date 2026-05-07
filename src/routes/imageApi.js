// Mounts the IIIF Image API 3.0 routes for slice rendering:
//   /iiif/image/{volId}/{axis}/{slice}/info.json
//   /iiif/image/{volId}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}

import {
  infoJson,
  renderImageRequest,
} from "../iiif/imageApi.js";

const AXES = new Set(["axial", "coronal", "sagittal"]);

export function mountImageApi(app, registry) {
  app.get(
    "/iiif/image/:volId/:axis/:slice/info.json",
    asyncHandler(async (req, res) => {
      const { volId, axis } = req.params;
      const sliceIndex = Number(req.params.slice);
      validate(volId, axis, sliceIndex);
      const entry = await registry.load(volId);
      const handle = entry.volume;
      const [w, h] = handle.physicalSliceDims(axis);
      const baseUrl = req.app.locals.publicBaseUrl;
      res.set("Content-Type", "application/ld+json");
      res.json(
        infoJson({
          baseUrl,
          volId,
          axis,
          sliceIndex,
          width: w,
          height: h,
        })
      );
    })
  );

  // Canonical IIIF URL: id/region/size/rotation/quality.format
  app.get(
    "/iiif/image/:volId/:axis/:slice/:region/:size/:rotation/:qualityFormat",
    asyncHandler(async (req, res) => {
      const { volId, axis, region, size, rotation } = req.params;
      const sliceIndex = Number(req.params.slice);
      validate(volId, axis, sliceIndex);
      const [quality, format] = splitQualityFormat(req.params.qualityFormat);
      const entry = await registry.load(volId);
      const { buffer, contentType } = await renderImageRequest(
        entry.volume,
        axis,
        sliceIndex,
        { region, size, rotation, quality, format }
      );
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "public, max-age=3600");
      res.send(buffer);
    })
  );

  // Convenience: /iiif/image/{volId}/{axis}/{slice} → info.json
  app.get(
    "/iiif/image/:volId/:axis/:slice",
    asyncHandler(async (req, res) => {
      res.redirect(
        302,
        `/iiif/image/${encodeURIComponent(req.params.volId)}/${req.params.axis}/${req.params.slice}/info.json`
      );
    })
  );
}

function validate(_volId, axis, sliceIndex) {
  if (!AXES.has(axis)) {
    const err = new Error(`Unknown axis: ${axis}`);
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0) {
    const err = new Error(`Invalid slice index: ${sliceIndex}`);
    err.status = 400;
    throw err;
  }
}

function splitQualityFormat(s) {
  const dot = s.lastIndexOf(".");
  if (dot < 0) {
    const err = new Error(`Invalid quality.format: ${s}`);
    err.status = 400;
    throw err;
  }
  return [s.slice(0, dot), s.slice(dot + 1).toLowerCase()];
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
