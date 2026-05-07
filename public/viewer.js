// Demo viewer for the IIIF Volumetric Server.
//
// Modes:
//   1. "single"   — fetch the per-volume manifest, find its Scene's
//                   single Model annotation, load the raw NIfTI URL
//                   into niivuegpu.
//   2. "exploded" — fetch the exploded manifest, read its `rendering`
//                   link to the composite NIfTI, load that. The
//                   manifest also lists one Annotation per cell so
//                   the user can introspect the structure.
//
// Slice panes always render the *single* manifest's Image API service
// — this is intentional, the IIIF Image API endpoint serves slices
// of the original volume, not the exploded composite.

// niivuegpu ships three entry points: niivuegpu.js (both), .webgpu.js,
// and .webgl2.js. We default to the WebGL2 build because the
// combined/WebGPU paths currently hit a "createBindGroup … buffer
// undefined" error on the very first loadVolumes call when the volume
// slot starts empty (observed on Chrome / macOS Metal). WebGL2 has no
// such issue. Override with ?renderer=webgpu on the URL to test the
// WebGPU path once that bug is resolved.
const RENDERER =
  new URLSearchParams(window.location.search).get("renderer") || "webgl2";
const NIIVUEGPU_URL =
  RENDERER === "webgpu"
    ? "/vendor/niivuegpu/niivuegpu.webgpu.js"
    : RENDERER === "both"
      ? "/vendor/niivuegpu/niivuegpu.js"
      : "/vendor/niivuegpu/niivuegpu.webgl2.js";

const state = {
  baseUrl: window.location.origin,
  volumes: [],
  current: null,
  manifest: null, // single-volume manifest (slices come from here)
  explodedManifest: null, // exploded manifest when toggle is on
  axes: ["axial", "coronal", "sagittal"],
  nv: null,
  mode: "single",
};
// Exposed for ad-hoc debugging from the devtools console.
window.__viewerState = state;

const els = {
  vols: document.getElementById("vols"),
  manifestUrl: document.getElementById("manifestUrl"),
  colormap: document.getElementById("colormap"),
  windowInput: document.getElementById("window"),
  apiPill: document.getElementById("apiPill"),
  niivuePill: document.getElementById("niivuePill"),
  fallback: document.getElementById("nv-fallback"),
  canvas: document.getElementById("nv-canvas"),
  explodedToggle: document.getElementById("explodedToggle"),
  explodeNx: document.getElementById("explodeNx"),
  explodeNy: document.getElementById("explodeNy"),
  explodeNz: document.getElementById("explodeNz"),
  explodeEx: document.getElementById("explodeEx"),
  explodeEy: document.getElementById("explodeEy"),
  explodeEz: document.getElementById("explodeEz"),
  explodePlan: document.getElementById("explodePlan"),
};

// Honour ?mode=exploded URL param on load.
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("mode") === "exploded") {
  els.explodedToggle.checked = true;
}

main().catch((err) => {
  console.error(err);
});

async function main() {
  const api = await fetch("/api").then((r) => r.json());
  state.volumes = api.volumes || [];
  els.apiPill.textContent = `API · ${state.volumes.length} volume(s)`;
  els.apiPill.classList.add("green");
  renderVolList();
  if (state.volumes.length > 0) {
    selectVolume(state.volumes[0].id);
  }
  setupControls();
}

function renderVolList() {
  els.vols.innerHTML = "";
  if (state.volumes.length === 0) {
    els.vols.innerHTML =
      '<div class="empty">No volumes loaded.<br/>Drop a NIfTI file into <code>fixtures/</code> and restart.</div>';
    return;
  }
  for (const v of state.volumes) {
    const div = document.createElement("div");
    div.className = "vol-item";
    div.dataset.id = v.id;
    div.innerHTML = `<strong>${v.id}</strong><small>${v.format} · ${v.shape.join("×")} · ${v.dtype}</small>`;
    div.addEventListener("click", () => selectVolume(v.id));
    els.vols.appendChild(div);
  }
}

async function selectVolume(id) {
  state.current = state.volumes.find((v) => v.id === id);
  if (!state.current) return;
  for (const el of els.vols.querySelectorAll(".vol-item")) {
    el.classList.toggle("active", el.dataset.id === id);
  }
  // Always fetch the single manifest (drives slice panes).
  const singleManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/manifest`;
  state.manifest = await fetch(singleManifestUrl).then((r) => r.json());
  setupSliceUi();
  await refreshManifestForMode();
}

function setupSliceUi() {
  const m = state.manifest;
  for (const axis of state.axes) {
    const canvas = m.items.find(
      (it) =>
        it.type === "Canvas" &&
        Array.isArray(it.metadata) &&
        it.metadata.some(
          (md) =>
            md.label?.en?.[0] === "Slice axis" && md.value?.en?.[0] === axis
        )
    );
    const sliceCount = canvas
      ? Number(
          canvas.metadata.find(
            (md) => md.label?.en?.[0] === "Slice count"
          )?.value?.en?.[0]
        )
      : 0;
    const range = document.getElementById(`slice-${axis}`);
    range.max = String(Math.max(0, sliceCount - 1));
    range.value = String(Math.floor(sliceCount / 2));
    range.oninput = () => updateSlice(axis);
    updateSlice(axis);
  }
}

function updateSlice(axis) {
  const range = document.getElementById(`slice-${axis}`);
  const val = Number(range.value);
  document.getElementById(`slice-${axis}-val`).textContent = val;
  const id = state.current?.id;
  if (!id) return;
  const url = `${state.baseUrl}/iiif/image/${encodeURIComponent(id)}/${axis}/${val}/full/max/0/default.png`;
  document.getElementById(`img-${axis}`).src = url;
}

/** Decide which manifest drives the 3D pane and load the volume. */
async function refreshManifestForMode() {
  const id = state.current?.id;
  if (!id) return;
  const exploded = els.explodedToggle.checked;
  state.mode = exploded ? "exploded" : "single";

  let url;
  let displayedManifestUrl;
  let summary = "";
  if (exploded) {
    const qs = new URLSearchParams({
      nx: els.explodeNx.value,
      ny: els.explodeNy.value,
      nz: els.explodeNz.value,
      ex: els.explodeEx.value,
      ey: els.explodeEy.value,
      ez: els.explodeEz.value,
    });
    displayedManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/exploded/manifest?${qs}`;
    state.explodedManifest = await fetch(displayedManifestUrl).then((r) =>
      r.json()
    );
    // The composite NIfTI URL lives in the manifest's `rendering`.
    const composite = (state.explodedManifest.rendering || []).find(
      (r) => r.format === "application/x.nifti"
    );
    if (!composite) {
      showFallback("Exploded manifest has no composite NIfTI rendering link.");
      return;
    }
    url = composite.id;
    const plan = await fetch(
      `${state.baseUrl}/volumes/${encodeURIComponent(id)}/exploded/plan?${qs}`
    ).then((r) => r.json());
    summary = `${plan.cellCount} cells · cell ${plan.cellShape.join(
      "×"
    )} · composite ${plan.compositeShape.join("×")}`;
  } else {
    displayedManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/manifest`;
    const scene = state.manifest.items.find((it) => it.type === "Scene");
    if (!scene) {
      showFallback("Manifest has no Scene.");
      return;
    }
    const ann = scene.items?.[0]?.items?.[0];
    const body = ann?.body;
    if (!body || body.type !== "Model") {
      showFallback("Manifest scene has no Model annotation body.");
      return;
    }
    url = body.id;
  }

  els.manifestUrl.value = displayedManifestUrl;
  els.explodePlan.textContent = summary;

  await ensureNiivue();
  if (!state.nv) return;

  try {
    const colormap = els.colormap.value || "Gray";
    const win = parseWindow(els.windowInput.value);
    const opts = { url, colormap };
    if (win) {
      opts.calMin = win.min;
      opts.calMax = win.max;
    }
    await state.nv.loadVolumes([opts]);
    state.nv.sliceType = 4; // 3D render mode
  } catch (err) {
    console.error(err);
    showFallback(`niivuegpu failed to load the volume: ${err.message || err}`);
  }
}

async function ensureNiivue() {
  if (state.nv) return;
  try {
    const mod = await import(NIIVUEGPU_URL);
    const NiiVue = mod.default || mod.NiiVue;
    if (!NiiVue) throw new Error("niivuegpu default export missing");
    state.nv = new NiiVue({
      backgroundColor: [0, 0, 0, 1],
      isColorbarVisible: true,
    });
    await state.nv.attachToCanvas(els.canvas);
    els.niivuePill.textContent = "niivuegpu · ready";
    els.niivuePill.classList.add("green");
  } catch (err) {
    console.warn("niivuegpu failed to load:", err);
    els.niivuePill.textContent = "niivuegpu · unavailable";
    els.niivuePill.classList.add("red");
    showFallback(
      `niivuegpu is not mounted at ${NIIVUEGPU_URL}. Set NIIVUEGPU_DIST or place a built dist/ next to the server.`
    );
  }
}

function showFallback(msg) {
  els.fallback.hidden = false;
  els.fallback.textContent = msg;
  els.canvas.style.display = "none";
}

function parseWindow(s) {
  if (!s) return null;
  const parts = s.split(",").map((n) => Number(n));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return { min: parts[0], max: parts[1] };
}

function setupControls() {
  const reload = () => {
    if (state.current) refreshManifestForMode();
  };
  els.colormap.addEventListener("change", reload);
  els.windowInput.addEventListener("change", reload);
  els.explodedToggle.addEventListener("change", reload);
  
  for (const axis of ["Ex", "Ey", "Ez"]) {
    const el = els[`explode${axis}`];
    const valEl = document.getElementById(`val${axis}`);
    el.addEventListener("input", () => {
        valEl.textContent = el.value;
    });
    el.addEventListener("change", reload);
  }

  for (const el of [
    els.explodeNx,
    els.explodeNy,
    els.explodeNz,
  ]) {
    el.addEventListener("change", reload);
  }
}
