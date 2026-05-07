// Mounts /iiif/presentation/{id}/manifest

import {
  buildManifest,
  buildExplodedManifest,
} from "../iiif/presentation.js";
import { planExplodedView } from "../iiif/explode.js";

export function mountPresentationApi(app, registry) {
  app.get(
    "/iiif/presentation/:volId/manifest",
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId);
      const baseUrl = req.app.locals.publicBaseUrl;
      const manifest = buildManifest({ baseUrl, entry });
      res.set("Content-Type", "application/ld+json");
      res.json(manifest);
    })
  );

  // Exploded-view manifest: Scene with one Model annotation per grid
  // cell, plus a `rendering` link to the composite NIfTI for clients
  // that just want the whole exploded space as a single volume.
  app.get(
    "/iiif/presentation/:volId/exploded/manifest",
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId);
      const baseUrl = req.app.locals.publicBaseUrl;
      const layout = planExplodedView(entry.volume, {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      });
      const manifest = buildExplodedManifest({ baseUrl, entry, layout });
      res.set("Content-Type", "application/ld+json");
      res.json(manifest);
    })
  );

  // Convenience: list manifests
  app.get("/iiif/presentation", (req, res) => {
    const baseUrl = req.app.locals.publicBaseUrl;
    res.json({
      manifests: registry.list().flatMap((v) => [
        {
          id: v.id,
          kind: "single",
          manifest: `${baseUrl}/iiif/presentation/${encodeURIComponent(v.id)}/manifest`,
        },
        {
          id: v.id,
          kind: "exploded-3x3x3-e1.5",
          manifest: `${baseUrl}/iiif/presentation/${encodeURIComponent(v.id)}/exploded/manifest?nx=3&ny=3&nz=3&ex=1.5&ey=1.5&ez=1.5`,
        },
      ]),
    });
  });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
