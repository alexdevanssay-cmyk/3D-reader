import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyToPage, language, locale, setLanguage, t, tMessage } from "./i18n.js";
import { engravingMask, thicknessHistogram, thicknessStats } from "./engine/thickness.js";
import { summarize } from "./engine/summary.js";
import { buildSemantic3D, SEMANTIC_VERSION } from "./engine/semantic.js";
import { buildAIContext, AI_CONTEXT_VERSION } from "./engine/ai-context.js";

// ---------------------------------------------------------------- units

const VOL_UNITS = {
  mm3: { label: "mm³", factor: 1, area: "mm²", areaFactor: 1 },
  cm3: { label: "cm³", factor: 1e3, area: "cm²", areaFactor: 1e2 },
  dm3: { label: "dm³", factor: 1e6, area: "dm²", areaFactor: 1e4 },
  m3: { label: "m³", factor: 1e9, area: "m²", areaFactor: 1e6 },
  in3: { label: "in³", factor: 16387.064, area: "in²", areaFactor: 645.16 },
};

const $ = (id) => document.getElementById(id);

function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e12)) return v.toExponential(4);
  // Below 1, a fixed number of decimals would leave only one or two significant digits.
  if (abs !== 0 && abs < 1) return v.toLocaleString(locale(), { maximumSignificantDigits: 4 });
  return v.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function volUnit() { return VOL_UNITS[$("vol-unit").value]; }
function fmtVol(mm3) { const u = volUnit(); return mm3 == null ? "—" : `${fmtNum(mm3 / u.factor)} ${u.label}`; }
function fmtArea(mm2) { const u = volUnit(); return mm2 == null ? "—" : `${fmtNum(mm2 / u.areaFactor)} ${u.area}`; }
// Coordinates: hide floating-point noise such as 2.9e-14 around zero.
// (French numbers use a decimal comma: coordinates are then separated by semicolons.)
function fmtPoint(p) { return p ? p.map((x) => fmtNum(Math.abs(x) < 1e-6 ? 0 : x, 2)).join(language() === "fr" ? " ; " : ", ") : "—"; }
function fmtSize(s) { return s.map((x) => fmtNum(x, 2)).join(" × ") + " mm"; }
function fmtMass(mm3, density) {
  if (mm3 == null || !(density >= 0)) return "—";
  const g = (mm3 / 1000) * density;
  return g >= 1000 ? `${fmtNum(g / 1000)} kg` : `${fmtNum(g)} g`;
}

// ---------------------------------------------------------------- scene

const viewport = $("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
camera.up.set(0, 0, 1); // CAD convention: Z is up
camera.position.set(1, -1, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
scene.add(keyLight);
scene.add(camera); // headlight follows the camera
const headLight = new THREE.DirectionalLight(0xffffff, 0.8);
camera.add(headLight);

const modelGroup = new THREE.Group();
scene.add(modelGroup);
let boxHelper = null;
let axes = null;

const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
let sectionOn = false;
let sectionFlip = false;

const state = {
  result: null,
  meshes: [], // THREE.Mesh per body
  edges: [], // wireframe overlays
  selected: -1,
  included: new Set(), // bodies checked in the list: the volume, the exports and the costing are theirs
  bounds: new THREE.Box3(),
};

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- loading

// The Python server sends meshes as base64 strings, the browser engine as typed arrays.
function decode(data, Type) {
  if (typeof data !== "string") return data instanceof Type ? data : new Type(data);
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

const PALETTE = [0x6c8ebf, 0xb4a76c, 0x82b366, 0xd79b00, 0x9673a6, 0x5aa5a5, 0xb85450, 0x8c8c8c];

/** Free the GPU memory of the meshes of a model. */
function disposeObjects(objects) {
  for (const obj of objects) {
    obj.traverse((o) => {
      o.geometry?.dispose();
      // Geometries kept for the wall thickness view (one of them is o.geometry).
      o.userData.indexed?.dispose();
      o.userData.flat?.dispose();
      o.material?.dispose();
    });
  }
}

function clearModel() {
  const objects = [...modelGroup.children];
  modelGroup.clear();
  disposeObjects(objects);
  state.meshes = [];
  state.edges = [];
  state.selected = -1;
}

/**
 * Lines of the edges of a triangle mesh, each edge once (an index buffer for
 * LineSegments sharing the mesh's positions). Typed-array hash of the edges:
 * THREE.WireframeGeometry keys them by strings, far too slow on large meshes.
 */
function wireframeGeometry(geom) {
  const index = geom.index.array;
  let size = 16;
  while (size < index.length * 2) size *= 2;
  const mask = size - 1;
  const keyA = new Int32Array(size).fill(-1);
  const keyB = new Int32Array(size);
  const lines = new Uint32Array(index.length * 2); // at most every edge of every triangle
  let n = 0;
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = index[t + e], w = index[t + ((e + 1) % 3)];
      const i = u < w ? u : w, j = u < w ? w : u;
      let slot = (Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b)) & mask;
      while (keyA[slot] !== -1 && (keyA[slot] !== i || keyB[slot] !== j)) slot = (slot + 1) & mask;
      if (keyA[slot] !== -1) continue;
      keyA[slot] = i;
      keyB[slot] = j;
      lines[n++] = i;
      lines[n++] = j;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", geom.getAttribute("position"));
  out.setIndex(new THREE.BufferAttribute(lines.slice(0, n), 1));
  return out;
}

/** Show or hide the wireframe of every body (built the first time it is shown). */
function showWireframe(on) {
  if (on && !state.edges.length) {
    state.meshes.forEach((mesh) => {
      const geom = mesh.userData.indexed ?? mesh.geometry;
      const edges = new THREE.LineSegments(
        wireframeGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, clippingPlanes: [sectionPlane] }),
      );
      mesh.add(edges);
      state.edges.push(edges);
    });
  }
  state.edges.forEach((l) => (l.visible = on));
}

function buildModel(result) {
  clearModel();
  result.bodies.forEach((body, i) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(decode(body.mesh.positions, Float32Array), 3));
    geom.setIndex(new THREE.BufferAttribute(decode(body.mesh.indices, Uint32Array), 1));
    geom.computeVertexNormals();

    // CAD colours are sRGB values, like CSS colours.
    const color = body.color
      ? new THREE.Color().setRGB(...body.color, THREE.SRGBColorSpace)
      : new THREE.Color(PALETTE[i % PALETTE.length]);
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.15,
      roughness: 0.55,
      side: THREE.DoubleSide, // lets you see inside when sectioning
      clippingPlanes: [sectionPlane],
      clipShadows: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    // Open bodies (no volume) are shown translucent so they stand out.
    if (!body.closed) {
      mat.transparent = true;
      mat.opacity = 0.75;
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.index = i;
    mesh.userData.color = color.clone();
    mesh.userData.look = { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
    modelGroup.add(mesh);
    state.meshes.push(mesh);

  });
  // The wireframe is only built when shown (on a large model it takes longer than the rest of the view).
  if ($("toggle-wire").classList.contains("active")) showWireframe(true);

  state.included = new Set(result.bodies.map((_, i) => i));
  state.subsetSummary = null;
  const s = result.summary.bbox;
  state.bounds.set(new THREE.Vector3(...s.min), new THREE.Vector3(...s.max));
  placeHelpers();
  setView("iso");
}

/** The envelope and the axes of the model shown (none without a model), and the section plane. */
function placeHelpers() {
  if (boxHelper) scene.remove(boxHelper);
  if (axes) scene.remove(axes);
  boxHelper = axes = null;
  if (!state.bounds.isEmpty()) {
    boxHelper = new THREE.Box3Helper(state.bounds, 0xff8800);
    boxHelper.visible = $("toggle-box").classList.contains("active");
    scene.add(boxHelper);
    const size = state.bounds.getSize(new THREE.Vector3());
    axes = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.25);
    scene.add(axes);
  }
  updateSection();
}

// ---------------------------------------------------------------- engines

// "server": the Python engine behind /api (python -m reader3d serve).
// "browser": the WebAssembly engine, used on the static site (GitHub Pages).
const engine = { server: false, browserClient: null };

function currentEngine() {
  return engine.server && $("engine").value === "server" ? "server" : "browser";
}

// config.json is a static file saying "no server" on the static site; the
// Python server answers the same URL itself. (Probing /api would log a 404 in
// the browser console of every visitor of the static site.)
async function detectServer() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    return res.ok && (await res.json()).server === true;
  } catch {
    return false;
  }
}

function browserClient() {
  engine.browserClient ??= import("./engine/client.js").then((client) => {
    client.onMemory(onEngineMemory);
    return client;
  });
  return engine.browserClient;
}

function fmtMB(bytes) {
  const mb = bytes / 1048576;
  return `${mb.toLocaleString(locale(), { maximumFractionDigits: mb < 10 ? 1 : 0 })} ${language() === "fr" ? "Mo" : "MB"}`;
}

// Progress of the file being analysed (0..1, or null when unknown).
function setLoading(text, fraction = null) {
  $("loading-text").textContent = text;
  const bar = $("loading-bar");
  if (fraction === null) bar.removeAttribute("value"); // indeterminate
  else bar.value = Math.min(1, Math.max(0, fraction));
  $("loading-percent").textContent = fraction === null ? "" : `${Math.floor(fraction * 100)} %`;
}

const STEP_TEXT = {
  read: "loading.read",
  transfer: "loading.transfer",
  mesh: "loading.mesh",
  measure: "loading.measure",
  summary: "loading.summary",
  thickness: "loading.thickness",
};

// The engine reports its progress while it works, several times per second
// (measured work, see engine/occt.js); the page also shows the time elapsed.
// Each tab has its own progress (tab.progress: {started, last}); the one of
// the tab shown is on screen.
let progressTimer = null;

function startProgress(tab = activeTab) {
  tab.progress = { started: performance.now(), last: null };
  progressTimer ??= setInterval(tickProgress, 500);
}

function stopProgress(tab = activeTab) {
  tab.progress = null;
  if (tabs.some((other) => other.progress)) return;
  clearInterval(progressTimer);
  progressTimer = null;
}

function showProgress(p, tab = activeTab) {
  if (tab.progress) tab.progress.last = p;
  if (tab === activeTab) tickProgress();
}

function tickProgress() {
  const progress = activeTab?.progress;
  if (!progress) return;
  const p = progress.last;
  const elapsed = Math.floor((performance.now() - progress.started) / 1000);
  $("loading-elapsed").textContent = elapsed >= 2 ? t("loading.elapsed", { seconds: elapsed }) : "";
  if (!p) return;
  let [text, fraction] = describeProgress(p);
  // The total work of this step is only known approximately (typical value).
  if (p.stage === "analyze" && p.approximate) text = t("loading.estimate", { text });
  setLoading(text, fraction);
  renderMemory();
}

function describeProgress(p) {
  switch (p.stage) {
    case "download":
      return p.total
        ? [t("loading.download", { loaded: fmtMB(p.loaded), total: fmtMB(p.total) }), p.loaded / p.total]
        : [t("loading.downloadNoTotal", { loaded: fmtMB(p.loaded) }), null];
    case "compile":
      return [t("loading.compile"), null];
    case "analyze": {
      const text = t(STEP_TEXT[p.step] ?? "loading.analysing");
      // The wall thickness: on how many processors (calculations in parallel).
      const where = p.step === "thickness" && p.workers ? ` ${t("loading.workers", { n: p.workers })}` : "";
      return [text + where, p.percent == null ? null : p.percent / 100];
    }
    default:
      return [t("loading.analysing"), null];
  }
}

// Small status chip showing whether the CAD engine (WebAssembly) is ready.
let engineStage = "idle";
function showEngineStatus(p) {
  const el = $("engine-status");
  if (p) engineStage = p.stage === "download" && p.total ? { ...p } : p.stage;
  if (currentEngine() !== "browser") {
    el.hidden = true;
    return;
  }
  const stage = typeof engineStage === "object" ? "download" : engineStage;
  el.hidden = false;
  el.classList.toggle("ready", stage === "ready");
  el.classList.toggle("error", stage === "error");
  if (typeof engineStage === "object") el.textContent = t("status.percent", { percent: Math.round((engineStage.loaded / engineStage.total) * 100) });
  else if (stage === "download" || stage === "compile") el.textContent = t("status.loading");
  else if (stage === "ready") el.textContent = t("status.ready");
  else if (stage === "error") {
    el.textContent = t("status.error");
    if (p?.message) el.title = p.message;
  } else el.textContent = t("status.idle");
}

async function analyzeOnServer(file, tab) {
  const form = new FormData();
  form.append("file", file);
  form.append("unit", $("unit").value);
  form.append("quality", $("quality").value);
  tab.serverRequest = new AbortController(); // of the request in progress
  tab.loading.text = t("loading.upload");
  if (tab === activeTab) setLoading(tab.loading.text, null);
  // Aborting the request also stops the analysis on the server.
  const res = await fetch("api/analyze", { method: "POST", body: form, signal: tab.serverRequest.signal });
  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`);
  return data;
}

async function analyzeInBrowser(file, { refresh = false, close = false, tab = activeTab } = {}) {
  const client = await browserClient();
  return client.analyzeInBrowser(file, {
    unit: $("unit").value,
    quality: $("quality").value,
    cache: !refresh,
    close,
    onProgress: (p) => {
      showProgress(p, tab);
      if (p.stage === "download" || p.stage === "compile") showEngineStatus(p);
      if (p.stage === "analyze" && p.engine === "cad" && engineStage !== "ready") showEngineStatus({ stage: "ready" });
    },
  });
}

// Stop the analysis in progress in a tab: a newer file was opened in it, it
// was closed, or Cancel. The browser engine is restarted: the analyses of the
// other tabs, queued on it, start again (see openFile).
async function stopAnalysis(tab) {
  tab.serverRequest?.abort();
  tab.serverRequest = null;
  if (engine.browserClient) (await engine.browserClient).cancelAll();
}

/** Close the open surfaces of the file shown: analysed again, open surfaces sewn and filled into solids. */
function closeOpenBodies() {
  if (state.file) openFile(state.file, { refresh: true, handle: state.handle, close: true });
}

/**
 * Analyse a file and show it, in a tab (the one shown by default).
 * refresh -- computed again, without the results kept in this browser
 * handle  -- its FileSystemFileHandle when known: "Refresh" reads the file
 *            again from the disk (it may have changed)
 * close   -- close the open surfaces into solids
 */
async function openFile(file, { refresh = false, handle = null, close = false, tab = activeTab } = {}) {
  if (!file) return;
  const seq = ++tab.seq;
  // The new file must not wait behind an abandoned one (the browser engine
  // handles one file at a time, and server slots are limited).
  if (tab.loading) await stopAnalysis(tab);
  if (seq !== tab.seq) return;
  if (currentEngine() === "browser" && !(await memoryCheck(file))) return;
  if (seq !== tab.seq || !tabs.includes(tab)) return;
  const shown = () => tab === activeTab;
  if (shown()) $("error").hidden = true;
  const loading = (tab.loading = { kind: "file", text: t(close ? "loading.closing" : "loading.analysing"), file: file.name });
  startProgress(tab);
  if (shown()) {
    renderLoading();
    setStatus("analysing");
  }
  renderTabs();
  let data = null;
  try {
    data = currentEngine() === "server" ? await analyzeOnServer(file, tab) : await analyzeInBrowser(file, { refresh, close, tab });
    if (seq !== tab.seq) return;
    // Only now does the tab show this file (a failed file leaves the previous one).
    tab.handle = handle ?? (file === tab.file ? tab.handle : null);
    tab.file = file;
    tab.result = data;
    if (!shown()) {
      // Opened in a tab not shown: its model is built when the tab is shown.
      if (tab.view) disposeObjects(tab.view.meshes);
      tab.view = null;
      return;
    }
    state.handle = tab.handle;
    state.file = file;
    state.result = data;
    showModel(data);
    // The wall thickness workers start now, while the model is looked at.
    if (data.bodies.some((b) => b.closed)) browserClient().then((client) => client.warmThicknessPool());
    // Link mode: ?thickness=1 adds the wall thickness to the published results.
    if (params.get("thickness")) {
      tab.loading = null;
      stopProgress(tab);
      renderLoading();
      await ensureThickness();
      if (seq !== tab.seq) return;
    }
    publishResult(data);
    setStatus("done");
    afterAnalysisMemory();
  } catch (err) {
    const cancelled = err.cancelled || err.name === "AbortError";
    // Results kept from an earlier opening that cannot be shown (kept by an
    // older version, damaged): the file is analysed again, and they are replaced.
    // Stopped for another tab (its file opened again, closed or cancelled): started again.
    if (seq === tab.seq && tabs.includes(tab) && ((!cancelled && data?.cached && !refresh) || err.cancelled)) {
      if (!err.cancelled) console.warn(`${file.name}: kept results not usable, analysed again`, err);
      tab.loading = null;
      return openFile(file, { refresh: refresh || !err.cancelled, handle, close, tab });
    }
    if (seq === tab.seq && !cancelled) {
      const message = tMessage(err.message || String(err));
      showError(`${file.name}: ${message}`);
      if (shown()) setStatus("error", message);
    }
  } finally {
    if (tab.loading === loading) {
      tab.loading = null;
      stopProgress(tab);
      if (shown()) {
        renderLoading();
        if (document.body.dataset.status === "analysing") setStatus(tab.result ? "done" : "idle");
      }
    }
    renderTabs();
  }
}

/** Show the model of a file just analysed in the tab shown. */
function showModel(data) {
  $("drop-hint").hidden = true;
  $("refresh").disabled = false;
  buildModel(data);
  renderPanel();
  thicknessNewModel(data.cachedThickness?.length === data.bodies.length ? data.cachedThickness : null);
}

/** The loading box of the tab shown: its analysis in progress, if any. */
function renderLoading() {
  const loading = activeTab?.loading;
  $("loading").hidden = !loading;
  if (!loading) return;
  $("loading-file").textContent = loading.file;
  if (activeTab.progress?.last) tickProgress();
  else {
    setLoading(loading.text);
    tickProgress();
  }
}

async function initEngines() {
  engine.server = await detectServer();
  $("engine-field").hidden = !engine.server;
  $("privacy-note").hidden = engine.server;
  if (engine.server) return;

  // Static site: start downloading the CAD engine while the visitor picks a file,
  // unless they asked the browser to save data.
  const client = await browserClient();
  $("file-input").accept = client.SUPPORTED_EXTENSIONS.join(",");
  if (!navigator.connection?.saveData) {
    const start = () => client.preloadCadEngine(showEngineStatus);
    "requestIdleCallback" in window ? requestIdleCallback(start, { timeout: 3000 }) : setTimeout(start, 1000);
  }
}

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showError.t);
  showError.t = setTimeout(() => (el.hidden = true), 8000);
}

// ---------------------------------------------------------------- panel

function renderPanel() {
  const r = state.result;
  if (!r) return;
  const s = currentSummary() ?? { volume: null, area: null, centroid: null, bodies: 0, solids: 0, open_bodies: 0, bbox: { size: [NaN, NaN, NaN], volume: null }, obb: null, fill_ratio: null };
  const partial = s !== r.summary;

  for (const id of ["summary-card", "mass-card", "bodies-card"]) $(id).hidden = false;

  // Meshes with holes get a volume estimated after filling them (not closed, but a volume).
  const estimated = r.bodies.filter((b, i) => state.included.has(i) && isEstimate(b)).length;
  $("total-volume").textContent = (estimated ? "≈ " : "") + fmtVol(s.volume);
  const method = $("method");
  method.classList.toggle("warn", s.open_bodies > 0 || s.volume == null || estimated > 0);
  const how = r.kind === "cad" ? t("method.cad") : t("method.mesh", { unit: r.source_unit });
  const notes = [];
  if (estimated) notes.push(t("method.estimated", { n: estimated }));
  if (s.open_bodies > 0) notes.push(t("method.open", { n: s.open_bodies }));
  if (r.cached) notes.push(t("method.cached"));
  method.textContent = s.volume == null ? t("method.none") : [how, ...notes].join(" ");

  $("total-area").textContent = fmtArea(s.area);
  $("bbox-size").textContent = s.bodies ? fmtSize(s.bbox.size) : "—";
  $("bbox-volume").textContent = fmtVol(s.bbox.volume);
  $("obb-size").textContent = s.obb ? fmtSize(s.obb.size) : "—";
  $("fill").textContent = s.fill_ratio == null ? "—" : `${fmtNum(s.fill_ratio * 100, 2)} %`;
  $("centroid").textContent = fmtPoint(s.centroid);
  const count = s.open_bodies ? t("summary.bodiesOpen", { bodies: s.bodies, open: s.open_bodies }) : `${s.bodies}`;
  $("body-count").textContent = partial ? t("summary.bodiesSelected", { count, total: r.bodies.length }) : count;

  updateMass();
  renderBodies();
}

/** Indices of the bodies checked in the list. */
function includedIndices() {
  return state.result ? state.result.bodies.map((_, i) => i).filter((i) => state.included.has(i)) : [];
}

/**
 * Totals of the bodies checked in the list (all of them: the file's summary).
 * Null when none is checked. The oriented envelope of a part of the bodies is
 * computed from their display meshes.
 */
function currentSummary() {
  const r = state.result;
  if (!r) return null;
  const indices = includedIndices();
  if (indices.length === r.bodies.length) return r.summary;
  if (!indices.length) return null;
  if (state.subsetSummary?.key === indices.join(",")) return state.subsetSummary.summary;
  const bodies = indices.map((i) => {
    const b = r.bodies[i];
    const geom = state.meshes[i].userData.indexed ?? state.meshes[i].geometry;
    const mesh = { positions: geom.attributes.position.array, indices: geom.index.array };
    if (b.mesh?.positions64 && typeof b.mesh.positions64 !== "string") mesh.positions64 = b.mesh.positions64;
    return { ...b, mesh };
  });
  let summary;
  try {
    summary = summarize(bodies);
  } catch {
    summary = { ...summarize(bodies.map((b) => ({ ...b, mesh: null }))), obb: null };
  }
  state.subsetSummary = { key: indices.join(","), summary };
  return summary;
}

/** Check exactly these bodies (from the list, or from the costing page). */
function setIncluded(indices) {
  state.included = new Set(indices);
  state.meshes.forEach((m, i) => (m.visible = state.included.has(i)));
  renderPanel();
  // The wall thickness card: the values of the bodies checked, on a scale fitted to them.
  if (thick.results) {
    if (!thick.userMax) thick.max = niceCeil((thickQuantiles([0.99]) ?? [thick.max])[0]);
    applyThickness();
    renderThickness();
  }
  updatePublished(state.result);
}

function isEstimate(body) {
  return !body.closed && body.volume != null;
}

function updateMass() {
  const r = state.result;
  if (!r) return;
  $("mass").textContent = fmtMass(currentSummary()?.volume ?? null, parseFloat($("density").value));
  const all = $("bodies-all");
  all.checked = state.included.size === r.bodies.length;
  all.indeterminate = state.included.size > 0 && state.included.size < r.bodies.length;
  renderBodyDetail();
}

function renderBodies() {
  const r = state.result;
  const tbody = $("bodies");
  tbody.innerHTML = "";
  const total = currentSummary()?.volume || 0;
  r.bodies.forEach((b, i) => {
    const tr = document.createElement("tr");
    tr.dataset.index = i;
    if (i === state.selected) tr.classList.add("selected");
    const color = state.meshes[i].material.color.getHexString();

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = state.included.has(i);
    vis.title = t("bodies.showHide");
    vis.addEventListener("click", (e) => e.stopPropagation());
    vis.addEventListener("change", () => {
      const set = new Set(state.included);
      if (vis.checked) set.add(i);
      else set.delete(i);
      setIncluded([...set]);
    });

    const td0 = document.createElement("td");
    td0.appendChild(vis);
    tr.appendChild(td0);
    tr.insertAdjacentHTML(
      "beforeend",
      `<td class="name" title="${escapeHtml(b.name)}"><span class="swatch" style="background:#${color}"></span>${escapeHtml(b.name)}</td>` +
        `<td class="num ${b.volume == null || isEstimate(b) ? "open" : ""}">${b.volume == null ? t("bodies.open") : (isEstimate(b) ? "≈ " : "") + fmtVol(b.volume)}</td>` +
        `<td class="num">${b.volume != null && total ? fmtNum((b.volume / total) * 100, 1) : ""}</td>`,
    );
    tr.addEventListener("click", () => select(i === state.selected ? -1 : i));
    tbody.appendChild(tr);
    // Open surfaces of a CAD file: closed into a solid on request (not during the analysis, too heavy).
    if (!b.closed && r.kind === "cad" && currentEngine() === "browser") {
      const row = document.createElement("tr");
      row.className = "close-row";
      row.innerHTML = `<td></td><td colspan="3"><button type="button" class="linklike close-body" title="${escapeHtml(t("bodies.close.title"))}"><em>${escapeHtml(t("bodies.close"))}</em></button></td>`;
      row.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        closeOpenBodies();
      });
      tbody.appendChild(row);
    }
  });
  renderBodyDetail();
}

function renderBodyDetail() {
  const el = $("body-detail");
  const r = state.result;
  if (!r || state.selected < 0) {
    el.hidden = true;
    return;
  }
  const b = r.bodies[state.selected];
  const density = parseFloat($("density").value);
  const rows = [
    [t("detail.volume"), fmtVol(b.volume)],
    [t("detail.mass"), fmtMass(b.volume, density)],
    [t("detail.area"), fmtArea(b.area)],
    [t("detail.envelope"), fmtSize(b.bbox.size)],
    [t("detail.centroid"), fmtPoint(b.centroid)],
    [t("detail.triangles"), fmtNum(b.triangles, 0)],
  ];
  if (b.method === "brep" && b.volume != null && b.mesh_volume != null) {
    const dev = ((b.mesh_volume - b.volume) / b.volume) * 100;
    rows.push([t("detail.meshVolume"), `${fmtVol(b.mesh_volume)} (${dev >= 0 ? "+" : ""}${fmtNum(dev, 3)} %)`]);
  }
  el.innerHTML =
    `<h4>${escapeHtml(b.name)}</h4><dl class="stats">` +
    rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") +
    "</dl>" +
    b.notes.map((n) => `<div class="note">⚠ ${escapeHtml(tMessage(n))}</div>`).join("");
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function select(i) {
  state.selected = i;
  state.meshes.forEach((m, j) => {
    m.material.emissive.setHex(j === i ? 0x664400 : 0x000000);
  });
  document.querySelectorAll("#bodies tr").forEach((tr) => tr.classList.toggle("selected", +tr.dataset.index === i));
  renderBodyDetail();
  document.querySelector("#bodies tr.selected")?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- exports

/** Results without the display meshes, for files and for scripts. */
function exportableResult(r) {
  const density = parseFloat($("density").value);
  const mass = (v) => (v != null && Number.isFinite(density) && density >= 0 ? (v / 1000) * density : null);
  return {
    file: r.file,
    kind: r.kind,
    source_unit: r.source_unit,
    units: { length: "mm", area: "mm2", volume: "mm3", mass: "g", density: "g/cm3" },
    engine: r.engine ?? "python",
    density,
    summary: { ...(currentSummary() ?? r.summary), mass: mass((currentSummary() ?? r.summary).volume) },
    bodies: includedIndices().map((i) => {
      const { mesh, ...b } = r.bodies[i];
      return { ...b, mass: mass(b.volume), ...thicknessExport(r, [i]) };
    }),
    ...thicknessExport(r, includedIndices()),
    elapsed_s: r.elapsed_s,
  };
}

/**
 * Wall thickness of bodies of the result shown, for the exports:
 * {thickness: {method, min, median, max}} (mm), or {} when not computed.
 */
function thicknessExport(r, indices) {
  if (r !== state.result || !thick.results) return {};
  const stats = thickStats(indices);
  // The thinnest wall always by the "wall" method (see thickness.js).
  const wall = thickStats(indices, "wall");
  return {
    thickness: {
      method: thickMethod(),
      min: wall.min,
      median: stats.median,
      max: stats.max,
      floor: thick.floor,
      details: wall.details,
    },
  };
}

/** Exports include the wall thickness: compute it first if needed (closed bodies only). */
async function withThickness() {
  if (state.result?.bodies.some((b) => b.closed)) await ensureThickness();
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const baseName = (r) => r.file.replace(/\.[^.]+$/, "");

/**
 * Spreadsheet values: 12 significant digits (far beyond the accuracy of the
 * measures), and floating-point noise around zero (1e-15 on a 5 m part) as 0.
 */
function sheetNumber(v, scale) {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  return Math.abs(v) <= 1e-9 * scale ? 0 : Number(v.toPrecision(12));
}

function cleanRows(rows, scale) {
  return rows.map((row) => row.map((v) => (v && typeof v === "object" ? { ...v, value: sheetNumber(v.value, scale) } : sheetNumber(v, scale))));
}

/** One row per body and one column per quantity; numbers stay numbers. */
function tableRows(data) {
  const head = ["xlsx.name", "xlsx.volume", "xlsx.volumeCm3", "xlsx.area", "xlsx.bboxX", "xlsx.bboxY", "xlsx.bboxZ",
    "xlsx.cx", "xlsx.cy", "xlsx.cz", "xlsx.mass", "xlsx.thickMin", "xlsx.thickDetails", "xlsx.thickMedian", "xlsx.thickMax",
    "xlsx.closed", "xlsx.notes"].map((k) => t(k));
  const yesNo = (v) => t(v ? "xlsx.yes" : "xlsx.no");
  const row = (name, x, notes) => [
    name, x.volume, x.volume == null ? null : x.volume / 1000, x.area, ...x.bbox.size,
    ...(x.centroid ?? [null, null, null]), x.mass,
    x.thickness?.min ?? null, x.thickness?.details ? `(${fmtNum(x.thickness.details.min, 2)} mm)` : null, x.thickness?.median ?? null, x.thickness?.max ?? null,
    yesNo(x.closed), notes,
  ];
  const rows = data.bodies.map((b) => row(b.name, b, b.notes.map(tMessage).join(" ; ")));
  const s = data.summary;
  rows.push(row(t("xlsx.total"), { ...s, thickness: data.thickness, closed: data.bodies.every((b) => b.closed) }, ""));
  return [head, ...cleanRows(rows, Math.max(...s.bbox.size, 1e-12))];
}

async function exportXlsx() {
  const r = state.result;
  if (!r) return;
  await withThickness();
  const { buildXlsx, STYLE } = await import("./xlsx.js");
  const data = exportableResult(r);
  const s = data.summary;
  const pct = (v) => (v == null ? null : { value: v, style: STYLE.percent });
  const summary = [
    [t("xlsx.file"), data.file],
    [t("xlsx.kind"), t(data.kind === "cad" ? "xlsx.kind.cad" : "xlsx.kind.mesh")],
    [t("xlsx.sourceUnit"), data.source_unit],
    [t("xlsx.date"), new Date().toLocaleString(locale())],
    [t("xlsx.volume"), s.volume],
    [t("xlsx.volumeCm3"), s.volume == null ? null : s.volume / 1000],
    [t("xlsx.area"), s.area],
    [t("xlsx.bboxX"), s.bbox.size[0]],
    [t("xlsx.bboxY"), s.bbox.size[1]],
    [t("xlsx.bboxZ"), s.bbox.size[2]],
    [t("xlsx.bboxVolume"), s.bbox.volume],
    [`${t("xlsx.obb")} 1`, s.obb?.size[0] ?? null],
    [`${t("xlsx.obb")} 2`, s.obb?.size[1] ?? null],
    [`${t("xlsx.obb")} 3`, s.obb?.size[2] ?? null],
    [t("xlsx.obbVolume"), s.obb?.volume ?? null],
    [t("xlsx.fill"), pct(s.fill_ratio)],
    [t("xlsx.cx"), s.centroid?.[0] ?? null],
    [t("xlsx.cy"), s.centroid?.[1] ?? null],
    [t("xlsx.cz"), s.centroid?.[2] ?? null],
    [t("xlsx.density"), Number.isFinite(data.density) ? data.density : null],
    [t("xlsx.mass"), s.mass],
    [t("xlsx.bodyCount"), { value: s.bodies, style: STYLE.text }],
    [t("xlsx.thickMethod"), data.thickness ? t(`thick.${data.thickness.method}`) : "—"],
    [t("xlsx.thickMin"), data.thickness?.min ?? null],
    [t("xlsx.thickDetails"), data.thickness?.details ? `(${fmtNum(data.thickness.details.min, 2)} mm)` : "—"],
    [t("xlsx.thickMedian"), data.thickness?.median ?? null],
    [t("xlsx.thickMax"), data.thickness?.max ?? null],
  ].map(([k, v]) => [k, k === t("xlsx.fill") || k === t("xlsx.density") ? v : cleanRows([[v]], Math.max(...s.bbox.size, 1e-12))[0][0]]);
  const table = tableRows(data);
  const total = table.length - 1;
  table[total] = table[total].map((v, i) => (i === 0 ? { value: v, style: STYLE.totalText } : typeof v === "number" ? { value: v, style: STYLE.totalNumber } : v));
  const bytes = buildXlsx([
    { name: t("xlsx.bodies"), rows: table, header: true, widths: [28, 18, 16, 18, 16, 16, 16, 18, 18, 18, 14, 16, 20, 16, 16, 12, 50] },
    { name: t("xlsx.summary"), rows: summary, widths: [40, 28] },
  ]);
  download(`${baseName(r)}_volume.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

// A CSV cell. Text starting with = + - @ would be run as a formula by spreadsheet
// software (names come from the file, so they are not trusted).
function csvText(text) {
  const t = String(text);
  return `"${(/^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`;
}

async function exportCsv() {
  const r = state.result;
  if (!r) return;
  await withThickness();
  // French spreadsheet software expects ";" between cells and a decimal comma.
  const fr = language() === "fr";
  const sep = fr ? ";" : ",";
  const cell = (v) => (typeof v === "number" ? (fr ? String(v).replace(".", ",") : String(v)) : v == null ? "" : csvText(v));
  const lines = tableRows(exportableResult(r)).map((row) => row.map(cell).join(sep));
  // The BOM makes spreadsheet software read the names as UTF-8.
  download(`${baseName(r)}_volume.csv`, new Blob(["\ufeff" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
}

async function exportJson() {
  const r = state.result;
  if (!r) return;
  await withThickness();
  download(`${baseName(r)}_volume.json`, new Blob([JSON.stringify(exportableResult(r), null, 2)], { type: "application/json" }));
}

// ---------------------------------------------------------------- view tools

const VIEWS = {
  iso: new THREE.Vector3(1, -1, 0.8),
  front: new THREE.Vector3(0, -1, 0),
  top: new THREE.Vector3(0, 0, 1),
  right: new THREE.Vector3(1, 0, 0),
};

function setView(name) {
  if (state.bounds.isEmpty()) return;
  const center = state.bounds.getCenter(new THREE.Vector3());
  const radius = state.bounds.getSize(new THREE.Vector3()).length() / 2 || 1;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const dir = (VIEWS[name] || camera.position.clone().sub(controls.target)).clone().normalize();
  // A camera looking straight down Z needs a different up vector.
  camera.up.set(0, 0, 1);
  if (Math.abs(dir.z) > 0.999) camera.up.set(0, 1, 0);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 1000;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  keyLight.position.copy(center).add(new THREE.Vector3(radius, -radius * 2, radius * 3));
  controls.update();
}

function updateSection() {
  const on = sectionOn && !state.bounds.isEmpty();
  if (!on) {
    sectionPlane.normal.set(0, 0, -1);
    sectionPlane.constant = 1e12; // everything kept
    return;
  }
  const axis = $("section-axis").value.toLowerCase();
  const t = $("section-pos").value / 1000;
  const lo = state.bounds.min[axis];
  const hi = state.bounds.max[axis];
  const pos = lo + (hi - lo) * t;
  const n = new THREE.Vector3();
  n[axis] = sectionFlip ? 1 : -1;
  // Keeps points where n·p + c >= 0
  sectionPlane.normal.copy(n);
  sectionPlane.constant = sectionFlip ? -pos : pos;
}

// ---------------------------------------------------------------- events

// With the File System Access API (Chrome, Edge) the page keeps a handle on
// the file: "Refresh" then reads it again from the disk.
$("open-file").addEventListener("click", async () => {
  if (typeof window.showOpenFilePicker !== "function" || !engine.browserClient) return $("file-input").click();
  try {
    const client = await engine.browserClient;
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: t("top.open"), accept: { "application/octet-stream": client.SUPPORTED_EXTENSIONS } }],
      excludeAcceptAllOption: false,
    });
    openFile(await handle.getFile(), { handle, tab: freeTab() });
  } catch (err) {
    if (err?.name !== "AbortError") $("file-input").click();
  }
});
// Refresh the model without reloading the page: the file is read again (from
// the disk when the page has a handle on it) and analysed again, without the
// results kept in this browser.
$("refresh").addEventListener("click", async () => {
  if (!state.file) return;
  let file = state.file;
  try {
    if (state.handle) file = await state.handle.getFile();
    else await file.slice(0, 1).arrayBuffer(); // a file changed on the disk can no longer be read
  } catch {
    showError(t("refresh.reopen", { file: state.file.name }));
    return;
  }
  openFile(file, { refresh: true, handle: state.handle });
});
$("file-input").addEventListener("change", (e) => {
  openFile(e.target.files[0], { tab: freeTab() });
  e.target.value = ""; // allow re-opening the same file
});
// Some malformed CAD files make OpenCascade run for a very long time.
$("cancel").addEventListener("click", () => cancelTab(activeTab));
$("engine").addEventListener("change", () => {
  showEngineStatus({ stage: "idle" });
  if (state.file) openFile(state.file);
});
// Mesh unit only applies to mesh files, display quality only to CAD files.
$("unit").addEventListener("change", () => state.result?.kind === "mesh" && openFile(state.file));
$("quality").addEventListener("change", () => state.result?.kind === "cad" && openFile(state.file));
$("vol-unit").addEventListener("change", renderPanel);

$("material").addEventListener("change", () => {
  const v = $("material").value;
  if (v !== "custom") $("density").value = v;
  else $("density").focus();
  updateMass();
});
$("density").addEventListener("input", () => {
  $("material").value = "custom";
  updateMass();
});

/** Material of the part from elsewhere (the alloy of a customer request): an entry of the list, selected. */
function setMaterial(label, density) {
  if (!(density > 0)) return;
  const select = $("material");
  let option = [...select.options].find((o) => o.dataset.alloy === label);
  if (!option) {
    option = new Option("", String(density));
    option.dataset.alloy = label;
    select.insertBefore(option, select.firstChild);
  }
  option.value = String(density);
  option.textContent = `${label} (${density.toLocaleString(locale(), { minimumFractionDigits: 2 })})`;
  option.selected = true;
  $("density").value = density;
  updateMass();
}

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("fit").addEventListener("click", () => setView(null));

$("toggle-wire").addEventListener("click", (e) => showWireframe(e.currentTarget.classList.toggle("active")));
$("toggle-box").addEventListener("click", (e) => {
  const on = e.currentTarget.classList.toggle("active");
  if (boxHelper) boxHelper.visible = on;
});
$("toggle-section").addEventListener("click", (e) => {
  sectionOn = e.currentTarget.classList.toggle("active");
  $("section-controls").hidden = !sectionOn;
  updateSection();
});
for (const id of ["section-axis", "section-pos"]) $(id).addEventListener("input", updateSection);
$("section-flip").addEventListener("click", () => {
  sectionFlip = !sectionFlip;
  updateSection();
});
$("bodies-all").addEventListener("change", (e) => {
  if (state.result) setIncluded(e.target.checked ? state.result.bodies.map((_, i) => i) : []);
});
$("export-csv").addEventListener("click", () => exportCsv().catch((err) => showError(err.message)));
$("export-xlsx").addEventListener("click", () => exportXlsx().catch((err) => showError(err.message)));
$("export-json").addEventListener("click", () => exportJson().catch((err) => showError(err.message)));

// Click a body in the 3D view to select it.
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster
    .intersectObjects(state.meshes.filter((m) => m.visible), false)
    .filter((h) => !sectionOn || sectionPlane.distanceToPoint(h.point) >= 0);
  select(hits.length ? hits[0].object.userData.index : -1);
});

// Drag and drop anywhere on the page.
const hint = $("drop-hint");
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  hint.hidden = false;
  hint.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget) return;
  hint.classList.remove("dragging");
  if (state.result) hint.hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  hint.classList.remove("dragging");
  if (state.result) hint.hidden = true;
  $("doc-tabs").querySelector(".drop-target")?.classList.remove("drop-target");
  // Dropped on a tab: opened in it; on "+": in a new tab.
  const target = e.target.closest?.(".doc-tab, .doc-tab-new");
  let tab;
  if (target) {
    tab = target.dataset.tab ? tabs.find((x) => x.id === +target.dataset.tab) : createTab();
    if (tab !== activeTab) showTab(tab);
    showPage("viewer");
  } else {
    // On the costing pages, files go to the rows of their data files (chiffrage/ui.js), not to the 3D view.
    if (!$("page-chiffrage").hidden || !$("page-parametres").hidden) return;
    // From the IA page: analysed in the 3D view, where its progress shows.
    if (!$("page-ia").hidden) showPage("viewer");
    tab = freeTab();
  }
  const item = [...(e.dataTransfer.items ?? [])].find((i) => i.kind === "file");
  const handle = item?.getAsFileSystemHandle?.();
  const file = e.dataTransfer.files[0];
  if (!handle) return openFile(file, { tab });
  handle.then((h) => openFile(file, { handle: h?.kind === "file" ? h : null, tab }), () => openFile(file, { tab }));
});

// ---------------------------------------------------------------- wall thickness

// Wall thickness ("épaisseur de toile") for casting design: computed on demand
// in the engine worker (engine/thickness.js), one value per triangle of the
// display mesh. The model can be coloured with a scale (thin: blue, thick:
// red), and the triangles of one thickness (± a tolerance) highlighted.
// Thinner values are lettering or marks on the surface, not walls (kept in this browser).
const FLOOR_KEY = "reader3d.thickness.floor";
function loadFloor() {
  try {
    const v = parseFloat(localStorage.getItem(FLOOR_KEY));
    return Number.isFinite(v) && v >= 0 ? v : 1;
  } catch {
    return 1;
  }
}

// Markings (text, logos) hollow in the part or in relief, at most this deep / high:
// the thickness measured across them is not a wall (kept in this browser).
const MARKINGS_KEY = "reader3d.thickness.markings";
function loadMarkings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKINGS_KEY));
    if (saved && typeof saved.on === "boolean" && saved.depth >= 0) return saved;
  } catch {
    // none kept
  }
  return { on: true, depth: 2 };
}

const thick = {
  floor: loadFloor(), // mm
  markings: loadMarkings(), // {on, depth mm}
  markCache: new Map(), // body -> {key, mask, regions, depth}
  minOverride: null, // mm: thinnest wall typed in for the quote (the model was misjudged), or null
  results: null, // per body {ray, sphere} (Float32Array per triangle) or null
  pending: null, // promise of the computation in progress
  colors: false,
  highlight: false,
  value: null, // mm, thickness highlighted
  tol: null, // mm
  max: null, // mm, top of the colour scale
  userMax: false, // the scale was set by hand
};
const HIGHLIGHT = new THREE.Color(0xff00ff);
const NO_VALUE = new THREE.Color(0x9aa0aa);
const BINS = 50;

function thickMethod() {
  return $("thick-method").value;
}

/** Values (mm per triangle) of body i for a method (default: the one chosen), or null. */
function thickValues(i, method = thickMethod()) {
  return thick.results?.[i]?.[method] ?? null;
}

/** Geometry of body i as analysed (the indexed mesh, also when the view shows the flat one). */
function bodyGeometry(i) {
  const mesh = state.meshes[i];
  return mesh.userData.indexed ?? mesh.geometry;
}

/** Statistics (min, median, max in mm) of the bodies listed (default: those checked) for a method (default: the one chosen). */
function thickStats(indices = includedIndices(), method = thickMethod()) {
  const parts = [];
  let markings = 0;
  for (const i of indices) {
    let values = thickValues(i, method);
    if (!values) continue;
    const geom = bodyGeometry(i);
    // The thinnest wall leaves out the markings.
    const marks = method === "wall" ? markingsOf(i) : null;
    if (marks?.regions) {
      values = Float32Array.from(values, (v, f) => (marks.mask[f] ? NaN : v));
      markings += marks.regions;
    }
    parts.push({ positions: geom.attributes.position.array, indices: geom.index.array, values });
  }
  return { ...thicknessStats(parts, { floor: thick.floor }), markings };
}

/** Markings of body i (engravingMask on its "wall" values), kept until the settings change; null when off. */
function markingsOf(i) {
  if (!thick.markings.on) return null;
  const values = thickValues(i, "wall");
  if (!values) return null;
  const key = `${thick.floor}|${thick.markings.depth}`;
  const kept = thick.markCache.get(i);
  if (kept?.key === key && kept.values === values) return kept;
  const geom = bodyGeometry(i);
  const found = engravingMask(geom.attributes.position.array, geom.index.array, values, { floor: thick.floor, maxDepth: thick.markings.depth });
  const out = { key, values, ...found };
  thick.markCache.set(i, out);
  return out;
}

/** Colour of a thickness on the scale: blue (0) -> cyan -> green -> yellow -> red (max and above). */
function scaleHue(value) {
  const f = Math.min(1, Math.max(0, value / thick.max));
  return (1 - f) * 240;
}

function niceCeil(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x * (1 - 1e-9)) return m * p;
  return 10 * p;
}

function niceStep(range, count) {
  const raw = range / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Area-weighted quantile of the thickness of the bodies checked (method in use). */
function thickQuantiles(fractions) {
  const items = [];
  state.meshes.forEach((mesh, i) => {
    const values = state.included.has(i) ? thickValues(i) : null;
    if (!values) return;
    const pos = mesh.userData.indexed?.attributes.position.array ?? mesh.geometry.attributes.position.array;
    const idx = (mesh.userData.indexed ?? mesh.geometry).index.array;
    for (let f = 0; f < values.length; f++) {
      if (!Number.isFinite(values[f])) continue;
      const a = 3 * idx[3 * f], b = 3 * idx[3 * f + 1], c = 3 * idx[3 * f + 2];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      items.push([values[f], Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)]);
    }
  });
  if (!items.length) return null;
  items.sort((x, y) => x[0] - y[0]);
  const total = items.reduce((n, it) => n + it[1], 0);
  return fractions.map((fr) => {
    let acc = 0;
    for (const [v, w] of items) if ((acc += w) >= fr * total) return v;
    return items.at(-1)[0];
  });
}

/** A new model is shown: forget the previous thicknesses, recompute if in use. */
function thicknessNewModel(kept = null) {
  thick.results = null;
  thick.markCache = new Map();
  thick.minOverride = null;
  thick.pending = null;
  thick.userMax = false;
  thick.value = null;
  // Kept from an earlier opening of the same file: shown at once.
  if (kept) return adoptThickness(kept);
  renderThickness();
  if (thick.colors || thick.highlight) ensureThickness();
}

/** Thicknesses of the model shown, computed or kept from an earlier opening. */
function adoptThickness(results) {
  thick.results = results;
  const [p50, p99] = thickQuantiles([0.5, 0.99]) ?? [NaN, NaN];
  if (!thick.userMax) thick.max = niceCeil(p99);
  thick.value ??= Number.isFinite(p50) ? Math.round(p50 * 10) / 10 : thick.max / 2;
  thick.tol ??= Math.max(0.1, Math.round(thick.max * 2) / 100);
  updatePublished(state.result);
  applyThickness();
  renderThickness();
}

/** Compute the thicknesses of the model shown (once), with progress. */
async function ensureThickness() {
  if (thick.results || !state.result) return thick.results;
  if (thick.pending) return thick.pending;
  const result = state.result;
  const tab = activeTab; // the computation goes on if another tab is shown
  const meshes = state.meshes;
  const run = (async () => {
    const client = await browserClient();
    const bodies = meshes.map((mesh, i) => {
      // Open bodies have no inside: no thickness.
      if (!result.bodies[i].closed) return null;
      const geom = mesh.userData.indexed ?? mesh.geometry;
      return { positions: geom.attributes.position.array, indices: geom.index.array };
    });
    const loading = (tab.loading = { kind: "thickness", text: t("loading.thickness"), file: tab.file?.name ?? "" });
    startProgress(tab);
    if (tab === activeTab) {
      renderLoading();
      setLoading(loading.text, 0);
    }
    renderTabs();
    try {
      const results = await client.computeThickness(bodies, { onProgress: (p) => showProgress(p, tab) });
      if (tab.result !== result) return null; // another file was opened meanwhile
      client.saveThickness(result.cacheKey, results);
      if (tab === activeTab) adoptThickness(results);
      else if (tab.view) {
        // Shown when the tab is shown again.
        tab.view.thick.results = results;
        tab.view.thickReady = true;
      }
      return results;
    } catch (err) {
      if (!err.cancelled) showError(`${t("thick.title")} : ${tMessage(err.message || String(err))}`);
      if (tab === activeTab) thick.colors = thick.highlight = false;
      return null;
    } finally {
      if (tab.result === result) {
        const kept = tab === activeTab ? thick : tab.view?.thick;
        if (kept?.pending === run) kept.pending = null;
      }
      if (tab.loading === loading) {
        tab.loading = null;
        stopProgress(tab);
      }
      if (tab === activeTab && tab.result === result) {
        renderLoading();
        applyThickness();
        renderThickness();
      }
      renderTabs();
    }
  })();
  thick.pending = run;
  return run;
}

// Opacity of the rest of the body while a thickness is highlighted (or the
// thinnest wall located): translucent, so that the highlighted walls show
// through, even those inside or behind.
const HIGHLIGHT_FADE = 0.15;

/** Opaque or translucent material: its own look back, or see-through for a highlight. */
function setSeeThrough(mesh, on) {
  const m = mesh.material;
  const look = mesh.userData.look;
  const want = on ? { transparent: true, opacity: 1, depthWrite: false } : look;
  if (m.transparent === want.transparent && m.opacity === want.opacity && m.depthWrite === want.depthWrite) return;
  Object.assign(m, want);
  m.needsUpdate = true;
}

/** Colour the meshes by thickness, or give them their own colour back. */
function applyThickness() {
  const active = (thick.colors || thick.highlight) && thick.results;
  state.meshes.forEach((mesh, i) => {
    const values = thickValues(i);
    setSeeThrough(mesh, active && thick.highlight);
    if (!active) {
      if (mesh.userData.indexed) {
        mesh.geometry = mesh.userData.indexed;
        mesh.material.vertexColors = false;
        mesh.material.color.copy(mesh.userData.color);
        mesh.material.needsUpdate = true;
      }
      return;
    }
    // One colour per triangle: a geometry without shared vertices (RGBA: the alpha fades the rest during a highlight).
    if (!mesh.userData.indexed) {
      mesh.userData.indexed = mesh.geometry;
      mesh.userData.flat = mesh.geometry.toNonIndexed();
      mesh.userData.flat.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.userData.flat.attributes.position.count * 4), 4));
    }
    const geom = mesh.userData.flat;
    const colors = geom.attributes.color.array;
    const color = new THREE.Color();
    const lo = thick.value - thick.tol;
    const hi = thick.value + thick.tol;
    const triangles = colors.length / 12;
    for (let f = 0; f < triangles; f++) {
      const v = values ? values[f] : NaN;
      const inBand = thick.highlight && v >= lo && v <= hi;
      if (inBand) color.copy(HIGHLIGHT);
      else if (!Number.isFinite(v)) color.copy(NO_VALUE);
      else if (thick.colors) color.setHSL(scaleHue(v) / 360, 0.9, 0.5);
      else color.copy(mesh.userData.color);
      // With a highlight, the rest of the model steps back and becomes translucent.
      if (thick.highlight && !inBand) color.lerp(NO_VALUE, thick.colors ? 0.55 : 0.6).multiplyScalar(0.8);
      const alpha = thick.highlight && !inBand ? HIGHLIGHT_FADE : 1;
      for (let k = 0; k < 3; k++) {
        colors[12 * f + 4 * k] = color.r;
        colors[12 * f + 4 * k + 1] = color.g;
        colors[12 * f + 4 * k + 2] = color.b;
        colors[12 * f + 4 * k + 3] = alpha;
      }
    }
    geom.attributes.color.needsUpdate = true;
    if (mesh.geometry !== geom) mesh.geometry = geom;
    if (!mesh.material.vertexColors) {
      mesh.material.vertexColors = true;
      mesh.material.color.set(0xffffff);
      mesh.material.needsUpdate = true;
    }
  });
}

/** Lettering / fine details below the floor, in brackets: "(0,6 mm : écritures…)". */
function detailsText(details) {
  if (!details) return "";
  return t("thick.details", { value: fmtNum(details.min, 2), share: `${(details.share * 100).toLocaleString(locale(), { maximumFractionDigits: 1 })} %` });
}

function fmtMm(v) {
  return Number.isFinite(v) ? `${fmtNum(v, 2)} mm` : "—";
}

/** The card: buttons, scale with histogram, highlighted share, statistics. */
function renderThickness() {
  const card = $("thickness-card");
  card.hidden = !state.result;
  if (!state.result) return;
  const ready = !!thick.results;
  $("thick-compute").hidden = ready || !!thick.pending;
  $("thick-body").hidden = !ready;
  $("thick-colors").checked = thick.colors;
  $("thick-highlight").checked = thick.highlight;
  $("toggle-thickness").classList.toggle("active", thick.colors);
  $("thick-note").textContent = t(`thick.note.${thickMethod()}`);
  if (!ready) return;

  $("thick-max").value = thick.max;
  $("thick-value").value = Math.round(thick.value * 100) / 100;
  $("thick-tol").value = Math.round(thick.tol * 100) / 100;
  $("thick-slider").value = Math.round((Math.min(thick.value, thick.max) / thick.max) * 1000);

  // Area per thickness class, of the bodies checked in the list (the values of the card are theirs).
  const width = thick.max / BINS;
  const area = new Float64Array(BINS + 1); // the last class: thicker than the scale
  let total = 0;
  let band = 0;
  state.meshes.forEach((mesh, i) => {
    const values = state.included.has(i) ? thickValues(i) : null;
    if (!values) return;
    const geom = mesh.userData.indexed ?? mesh.geometry;
    const h = thicknessHistogram(geom.attributes.position.array, geom.index.array, values, width, BINS + 1);
    h.area.forEach((a, k) => (area[k] += a));
    total += h.total;
    const lo = thick.value - thick.tol;
    const hi = thick.value + thick.tol;
    const banded = Float32Array.from(values, (v) => (v >= lo && v <= hi ? 1 : 2));
    band += thicknessHistogram(geom.attributes.position.array, geom.index.array, banded, 1, 3).area[1];
  });
  drawScale(area, total);

  const stats = thickStats();
  const wall = thickStats(undefined, "wall");
  const thinnest = wall.min;
  $("thick-min").textContent = fmtMm(thinnest ?? NaN);
  $("thick-min").classList.toggle("overridden", thick.minOverride != null);
  $("thick-min-used").value = thick.minOverride ?? "";
  $("thick-min-used").placeholder = thinnest == null ? "" : fmtNum(thinnest, 2);
  $("thick-details").textContent = [detailsText(wall.details), wall.markings ? t("thick.markings.found", { count: wall.markings }) : ""].filter(Boolean).join(" ");
  $("thick-markings").checked = thick.markings.on;
  $("thick-mark-depth").value = thick.markings.depth;
  $("thick-floor").value = thick.floor;
  $("thick-locate").disabled = thinnest == null;
  let mode = 0;
  for (let k = 1; k < BINS; k++) if (area[k] > area[mode]) mode = k;
  $("thick-share").textContent = total
    ? t("thick.share", { percent: ((band / total) * 100).toLocaleString(locale(), { maximumFractionDigits: 1 }), lo: fmtNum(Math.max(0, thick.value - thick.tol), 3), hi: fmtNum(thick.value + thick.tol, 3) })
    : t("thick.none");
  // Most frequent and thickest: a click highlights where they are.
  thick.spots = {
    dominant: total ? { value: (mode + 0.5) * width, tol: width / 2 } : null,
    max: stats.max != null ? { value: stats.max, tol: Math.max(0.1, Math.round(stats.max * 5) / 100) } : null,
  };
  const rows = [
    [t("thick.dominant"), total ? `${fmtNum(mode * width, 2)} – ${fmtNum((mode + 1) * width, 2)} mm` : "—", "dominant"],
    [t("thick.median"), fmtMm(stats.median ?? NaN), null],
    [t("thick.maxValue"), fmtMm(stats.max ?? NaN), "max"],
  ];
  const html = rows
    .map(([k, v, spot]) => {
      const label = spot && thick.spots[spot] ? `<button type="button" class="linklike" data-spot="${spot}" title="${escapeHtml(t("thick.spot.title"))}">${escapeHtml(k)}</button>` : escapeHtml(k);
      return `<dt>${label}</dt><dd>${escapeHtml(v)}</dd>`;
    })
    .join("");
  // Rebuilt only when it changes: a click on a link must not lose its button (a field left
  // by that click renders the card again between the press and the release).
  if (html !== thick.statsHtml) $("thick-stats").innerHTML = thick.statsHtml = html;
}

/** Histogram (area per class) over the colour scale, graduated in mm. */
function drawScale(area, total) {
  const canvas = $("thick-scale");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 280;
  const h = canvas.clientHeight || 96;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.body);
  const text = style.color;
  const pad = 16; // room for the first and last labels
  const x = (v) => pad + (Math.min(v, thick.max) / thick.max) * (w - 2 * pad);
  const barTop = 4, barBottom = 52, stripTop = 56, stripBottom = 68;

  // Histogram bars, in the colour of their class.
  const peak = Math.max(...area.slice(0, BINS), 1e-30);
  const width = thick.max / BINS;
  for (let k = 0; k < BINS; k++) {
    if (!area[k]) continue;
    const hgt = Math.max(1, (area[k] / peak) * (barBottom - barTop));
    g.fillStyle = `hsl(${scaleHue((k + 0.5) * width)}, 90%, 50%)`;
    g.fillRect(x(k * width), barBottom - hgt, Math.max(1, x((k + 1) * width) - x(k * width) - 0.5), hgt);
  }
  // Colour scale.
  const grad = g.createLinearGradient(pad, 0, w - pad, 0);
  for (let k = 0; k <= 10; k++) grad.addColorStop(k / 10, `hsl(${(1 - k / 10) * 240}, 90%, 50%)`);
  g.fillStyle = grad;
  g.fillRect(pad, stripTop, w - 2 * pad, stripBottom - stripTop);
  // Graduations.
  g.fillStyle = text;
  g.strokeStyle = text;
  g.font = "11px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "top";
  const step = niceStep(thick.max, Math.max(2, Math.floor((w - 2 * pad) / 48)));
  for (let v = 0; v <= thick.max + 1e-9; v += step / 5) {
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    g.beginPath();
    g.moveTo(x(v) + 0.5, stripBottom);
    g.lineTo(x(v) + 0.5, stripBottom + (major ? 6 : 3));
    g.stroke();
    if (major) g.fillText(fmtNum(v, 3) + (v + step > thick.max + 1e-9 ? "+" : ""), x(v), stripBottom + 8);
  }
  // Highlighted band and cursor.
  if (thick.value != null) {
    const lo = x(Math.max(0, thick.value - thick.tol));
    const hi = x(thick.value + thick.tol);
    g.fillStyle = thick.highlight ? "rgba(255, 0, 255, 0.25)" : "rgba(128, 128, 128, 0.2)";
    g.fillRect(lo, barTop, Math.max(2, hi - lo), stripBottom - barTop);
    g.strokeStyle = thick.highlight ? "#ff00ff" : text;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x(thick.value), barTop);
    g.lineTo(x(thick.value), stripBottom);
    g.stroke();
    g.lineWidth = 1;
  }
  canvas.dataset.max = thick.max;
  canvas.dataset.pad = pad;
}

async function setThickness(changes) {
  Object.assign(thick, changes);
  if ((thick.colors || thick.highlight) && !(await ensureThickness())) {
    renderThickness();
    return;
  }
  applyThickness();
  renderThickness();
}

$("thick-compute").addEventListener("click", () => setThickness({ colors: true }));
$("thick-floor").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (!(v >= 0)) return renderThickness();
  thick.floor = v;
  try {
    localStorage.setItem(FLOOR_KEY, String(v));
  } catch {
    // kept for this visit only
  }
  renderThickness();
  if (state.result) updatePublished(state.result);
});
// Highlight the thinnest walls: from the thinnest value up to the detected minimum.
// (The thinnest wall is measured with the "wall" method, shown for this.)
$("thick-locate").addEventListener("click", () => {
  const { min } = thickStats(undefined, "wall");
  if (min == null) return;
  $("thick-method").value = "wall";
  if (!thick.userMax) thick.max = niceCeil((thickQuantiles([0.99]) ?? [1])[0]);
  const tol = Math.max(0.05, Math.round(min * 5) / 100);
  setThickness({ value: Math.round(min * 100) / 100, tol, highlight: true });
});
$("thick-stats").addEventListener("click", (e) => {
  const spot = thick.spots?.[e.target.closest("[data-spot]")?.dataset.spot];
  if (spot) setThickness({ value: Math.round(spot.value * 100) / 100, tol: Math.round(spot.tol * 100) / 100, highlight: true });
});
// The thinnest wall used by the quote, typed in when the model was misjudged (empty: the one detected).
$("thick-min-used").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  thick.minOverride = v > 0 ? v : null;
  renderThickness();
  if (state.result) updatePublished(state.result);
});
function saveMarkings() {
  try {
    localStorage.setItem(MARKINGS_KEY, JSON.stringify(thick.markings));
  } catch {
    // kept for this visit only
  }
  renderThickness();
  if (state.result) updatePublished(state.result);
}
$("thick-markings").addEventListener("change", (e) => {
  thick.markings = { ...thick.markings, on: e.target.checked };
  saveMarkings();
});
$("thick-mark-depth").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (!(v >= 0)) return renderThickness();
  thick.markings = { ...thick.markings, depth: v };
  saveMarkings();
});
$("toggle-thickness").addEventListener("click", () => setThickness({ colors: !thick.colors }));
$("thick-colors").addEventListener("change", (e) => setThickness({ colors: e.target.checked }));
$("thick-highlight").addEventListener("change", (e) => setThickness({ highlight: e.target.checked }));
$("thick-method").addEventListener("change", () => {
  if (!thick.results) return renderThickness();
  if (!thick.userMax) thick.max = niceCeil((thickQuantiles([0.99]) ?? [1])[0]);
  setThickness({});
});
$("thick-slider").addEventListener("input", (e) => {
  setThickness({ value: Math.round((e.target.value / 1000) * thick.max * 100) / 100, highlight: true });
});
$("thick-value").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (v >= 0) setThickness({ value: v, highlight: true });
  else renderThickness();
});
$("thick-tol").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (v >= 0) setThickness({ tol: v });
  else renderThickness();
});
$("thick-max").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0) setThickness({ max: v, userMax: true });
  else renderThickness();
});
// Click or drag on the scale to choose the thickness to highlight.
{
  const canvas = $("thick-scale");
  const pick = (e) => {
    if (!thick.results) return;
    const rect = canvas.getBoundingClientRect();
    const pad = Number(canvas.dataset.pad) || 0;
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left - pad) / (rect.width - 2 * pad)));
    setThickness({ value: Math.round(f * thick.max * 100) / 100, highlight: true });
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pick(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (canvas.hasPointerCapture(e.pointerId)) pick(e);
  });
}
new ResizeObserver(() => thick.results && renderThickness()).observe($("thick-scale"));

// ---------------------------------------------------------------- tabs

// Several parts open side by side, like the tabs of a browser: a part can be
// opened while another one is still being analysed. Each tab has its own
// model, analysis, wall thickness, material and quote (with its series
// order); the settings, the costing workbook and the metal prices are shared.
// The analyses of the tabs take turns on the CAD engine. The tabs live in this
// page: a reload starts again with one tab.
const tabs = [];
let activeTab = null;
let nextTabId = 1;
let defaultMaterial = null; // material of a new tab: the one of the page at start
// The wall thickness state of a tab (see `thick`), put aside with its model.
const TAB_THICK = ["results", "markCache", "minOverride", "pending", "value", "tol", "max", "userMax", "spots"];

function createTab() {
  const tab = { id: nextTabId++, file: null, handle: null, result: null, view: null, material: null, seq: 0, loading: null, progress: null, serverRequest: null };
  tabs.push(tab);
  renderTabs();
  return tab;
}

/** The tab to open a file in: the one shown, or a new one while it is busy analysing another file. */
function freeTab() {
  if (activeTab.loading?.kind !== "file") return activeTab;
  const tab = createTab();
  showTab(tab);
  return tab;
}

/** Put the model of the tab shown aside (its meshes kept, out of the scene). */
function stashTab(tab) {
  const option = $("material").selectedOptions[0];
  tab.material = { value: $("material").value, alloy: option?.dataset.alloy ?? null, density: $("density").value };
  modelGroup.clear();
  tab.view = state.result && state.meshes.length
    ? {
        meshes: state.meshes,
        edges: state.edges,
        selected: state.selected,
        included: state.included,
        subsetSummary: state.subsetSummary,
        bounds: state.bounds.clone(),
        camera: { position: camera.position.clone(), up: camera.up.clone(), near: camera.near, far: camera.far, target: controls.target.clone() },
        thick: Object.fromEntries(TAB_THICK.map((k) => [k, thick[k]])),
      }
    : null;
  state.meshes = [];
  state.edges = [];
  state.selected = -1;
}

function restoreMaterial(m) {
  if (m.alloy) return setMaterial(m.alloy, parseFloat(m.density));
  $("material").value = m.value;
  $("density").value = m.density;
}

/** Show a tab: its model, its analysis in progress and its quote. */
function showTab(tab) {
  if (tab === activeTab) return;
  if (activeTab && tabs.includes(activeTab)) stashTab(activeTab);
  activeTab = tab;
  state.file = tab.file;
  state.handle = tab.handle;
  state.result = tab.result;
  restoreMaterial(tab.material ?? defaultMaterial);
  $("error").hidden = true;
  const view = tab.view;
  tab.view = null;
  if (view) {
    state.meshes = view.meshes;
    state.edges = view.edges;
    state.selected = view.selected;
    state.included = view.included;
    state.subsetSummary = view.subsetSummary;
    if (view.meshes.length) modelGroup.add(...view.meshes);
    state.bounds.copy(view.bounds);
    placeHelpers();
    camera.position.copy(view.camera.position);
    camera.up.copy(view.camera.up);
    camera.near = view.camera.near;
    camera.far = view.camera.far;
    camera.updateProjectionMatrix();
    controls.target.copy(view.camera.target);
    controls.update();
    Object.assign(thick, view.thick);
    thick.statsHtml = null;
    showWireframe($("toggle-wire").classList.contains("active"));
    $("drop-hint").hidden = true;
    $("refresh").disabled = false;
    renderPanel();
    select(state.selected);
    if (view.thickReady) adoptThickness(thick.results);
    applyThickness();
    renderThickness();
  } else if (tab.result) {
    showModel(tab.result);
  } else {
    clearModel();
    state.bounds.makeEmpty();
    placeHelpers();
    for (const id of ["summary-card", "mass-card", "bodies-card", "body-detail"]) $(id).hidden = true;
    $("drop-hint").hidden = false;
    $("refresh").disabled = true;
    thicknessNewModel();
  }
  renderLoading();
  setStatus(tab.loading && !tab.result ? "analysing" : tab.result ? "done" : "idle");
  if (tab.result) updatePublished(tab.result);
  else {
    $("reader3d-result").textContent = "null";
    publishSemantic();
    document.dispatchEvent(new CustomEvent("reader3d-part"));
  }
  costingPages?.then((ui) => ui.setTab(tab.id));
  renderTabs();
}

/** Stop the analysis in progress in a tab (Cancel). */
function cancelTab(tab) {
  if (!tab.loading) return;
  tab.seq++; // forget the file being analysed
  tab.loading = null;
  stopProgress(tab);
  stopAnalysis(tab);
  if (tab === activeTab) renderLoading();
  renderTabs();
}

/** Close a tab: its model and its quote are forgotten. */
function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  cancelTab(tab);
  if (tab === activeTab) clearModel();
  else if (tab.view) disposeObjects(tab.view.meshes);
  tab.view = tab.result = tab.file = null;
  tabs.splice(i, 1);
  forgetQuote(tab.id);
  if (!tabs.length) nextTabId = 1;
  if (tab === activeTab) {
    activeTab = null;
    showTab(tabs[Math.min(i, tabs.length - 1)] ?? createTab());
  } else renderTabs();
}

function forgetQuote(id) {
  if (costingPages) costingPages.then((ui) => ui.forgetTab(id));
  else if (id === 1) {
    try {
      localStorage.removeItem("reader3d.chiffrage.quote.v1"); // chiffrage/store.js, quote of the first tab
    } catch {
      // no storage
    }
  }
}

/** "3D Reader": start again with one empty tab (the settings, the costing workbook and the metal prices are kept). */
function resetTabs() {
  if (tabs.some((tab) => tab.result || tab.loading) && !confirm(t("tabs.reset.confirm"))) return;
  for (const tab of tabs.filter((x) => x !== activeTab)) closeTab(tab);
  closeTab(activeTab);
  showPage("viewer");
}

function renderTabs() {
  const strip = $("doc-tabs");
  const items = tabs.map((tab) => {
    const name = tab.loading?.file ?? tab.file?.name ?? null;
    const el = document.createElement("div");
    el.className = "doc-tab";
    el.classList.toggle("active", tab === activeTab);
    el.classList.toggle("busy", !!tab.loading);
    el.dataset.tab = tab.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(tab === activeTab));
    el.title = name ?? t("tabs.new");
    el.innerHTML = '<span class="doc-tab-spin" aria-hidden="true"></span><span class="doc-tab-name"></span><button type="button" class="doc-tab-close">×</button>';
    // The part, without the extension of its file (the whole name as a tip).
    el.querySelector(".doc-tab-name").textContent = name ? name.replace(/\.[^.]+$/, "") : t("tabs.new");
    const close = el.querySelector(".doc-tab-close");
    close.title = t("tabs.close");
    close.setAttribute("aria-label", t("tabs.close"));
    return el;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "doc-tab-new";
  add.textContent = "+";
  add.title = t("tabs.add");
  add.setAttribute("aria-label", t("tabs.add"));
  strip.setAttribute("aria-label", t("tabs.label"));
  strip.replaceChildren(...items, add);
}

$("doc-tabs").addEventListener("click", (e) => {
  if (e.target.closest(".doc-tab-new")) return showTab(createTab());
  const el = e.target.closest(".doc-tab");
  const tab = el && tabs.find((x) => x.id === +el.dataset.tab);
  if (!tab) return;
  if (e.target.closest(".doc-tab-close")) closeTab(tab);
  else showTab(tab);
});
// Middle click closes a tab, as in a browser.
$("doc-tabs").addEventListener("auxclick", (e) => {
  const el = e.button === 1 && e.target.closest(".doc-tab");
  const tab = el && tabs.find((x) => x.id === +el.dataset.tab);
  if (tab) closeTab(tab);
});
$("doc-tabs").addEventListener("dragover", (e) => {
  const target = e.target.closest(".doc-tab, .doc-tab-new");
  for (const el of $("doc-tabs").querySelectorAll(".drop-target")) if (el !== target) el.classList.remove("drop-target");
  target?.classList.add("drop-target");
});
$("brand").addEventListener("click", resetTabs);

// ---------------------------------------------------------------- pages

// The costing pages (web/chiffrage/) are loaded the first time they are opened.
let costingPages = null;
let aiWorkspace = null;
function showPage(name) {
  for (const tab of document.querySelectorAll(".tabs .tab")) {
    const on = tab.dataset.page === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  }
  $("page-viewer").hidden = name !== "viewer";
  $("page-ia").hidden = name !== "ia";
  for (const page of ["chiffrage", "parametres"]) $(`page-${page}`).hidden = name !== page;
  if (name === "ia") {
    aiWorkspace ??= import("./ai-workspace.js").then((m) => m.mount({ page: $("page-ia"), reader: window.reader3d }));
    aiWorkspace.then((ui) => ui.show?.()).catch((err) => showError(err.message || String(err)));
    try { sessionStorage.setItem("reader3d.page", name); } catch {}
    return;
  }
  if (name !== "viewer") {
    costingPages ??= import("./chiffrage/ui.js").then((m) => {
      const ui = m.mount({ chiffrage: $("page-chiffrage"), parametres: $("page-parametres") });
      ui.setTab(activeTab.id);
      return ui;
    });
    costingPages.then((ui) => ui.show(name)).catch((err) => showError(err.message || String(err)));
  }
  try {
    sessionStorage.setItem("reader3d.page", name);
  } catch {
    // storage unavailable: the page opens on the 3D view next time
  }
}
for (const tab of document.querySelectorAll(".tabs .tab")) tab.addEventListener("click", () => showPage(tab.dataset.page));

// ---------------------------------------------------------------- memory gauge

// The CAD engine runs in WebAssembly, whose memory (heap) only grows, up to
// 4 GiB, and is never given back. The browser stops a page that asks for more
// than the device can give: the gauge compares what the analysis uses (or will
// use, estimated from the file size) with what it can safely get.
const GiB = 2 ** 30;
const WASM_MAX = 4294901760;
const memory = { heap: 0, loaded: false, estimate: null, restarted: false };

/** Bytes the analysis can use without risking a crash. */
function memoryBudget() {
  // navigator.deviceMemory: GB of RAM, rounded down, at most 8 (Chrome, Edge).
  const device = navigator.deviceMemory;
  if (device) return Math.min(WASM_MAX, (device * GiB) / 2);
  // Not reported (Firefox, Safari): phones and tablets stop pages much earlier.
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 1 * GiB : 2 * GiB;
}

function jsHeap() {
  const m = performance.memory; // Chrome only
  return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

function memoryLevel(ratio) {
  return ratio < 0.6 ? "ok" : ratio < 0.85 ? "warn" : "critical";
}

function renderMemory() {
  if (currentEngine() !== "browser") {
    $("memory-gauge").hidden = true;
    $("memory-card").hidden = true;
    return;
  }
  const budget = memoryBudget();
  const js = jsHeap();
  const ratios = [memory.heap / budget, memory.estimate ? memory.estimate.bytes / budget : 0];
  if (js) ratios.push(js.used / js.limit);
  const ratio = Math.min(1, Math.max(0, ...ratios));
  const level = memoryLevel(ratio);
  const percent = Math.round(ratio * 100);
  for (const id of ["memory-fill", "memory-fill-big"]) {
    $(id).style.width = `${percent}%`;
    $(id).dataset.level = level;
  }
  $("memory-percent").textContent = `${percent} %`;
  $("memory-gauge").hidden = false;
  $("memory-gauge").dataset.level = level;
  $("memory-gauge").title = `${t("memory.title")} : ${percent} % — ${t(`memory.level.${level}`)}`;
  $("memory-level").textContent = t(`memory.level.${level}`);
  $("memory-level").dataset.level = level;

  const of = (used, limit) => t("memory.of", { used: fmtMB(used), limit: fmtMB(limit), percent: Math.round((used / limit) * 100) });
  // Measured by the engine while it works (several times per second).
  const cad = !memory.loaded ? t("memory.notLoaded") : of(memory.heap, budget);
  const rows = [
    [t("memory.cad"), cad],
    [t("memory.budget"), fmtMB(budget)],
    [t("memory.device"), navigator.deviceMemory ? t("memory.deviceValue", { gb: navigator.deviceMemory }) : t("memory.unknown")],
  ];
  if (js) rows.push([t("memory.tab"), of(js.used, js.limit)]);
  if (memory.estimate) rows.push([t("memory.estimate", { file: memory.estimate.file }), of(memory.estimate.bytes, budget)]);
  $("memory-stats").innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  $("memory-advice").textContent = (memory.restarted ? t("memory.restarted") + " " : "") + t(`memory.advice.${level}`);
  $("loading-memory").textContent = `${t("memory.short")} : ${of(Math.max(memory.heap, js?.used ?? 0), budget)}`;
  $("memory-card").hidden = false;
}

function onEngineMemory(m) {
  memory.heap = m.heap;
  memory.loaded = Boolean(m.loaded ?? m.heap > 0);
  if (m.restarted) memory.restarted = true;
  renderMemory();
}

/** Estimate the memory the file needs; ask before an analysis that risks a crash. */
async function memoryCheck(file) {
  const client = await browserClient();
  const { bytes } = client.estimateMemory(file, memory.heap);
  memory.estimate = { file: file.name, bytes };
  memory.restarted = false;
  renderMemory();
  const budget = memoryBudget();
  if (bytes / budget < 0.9 || state.noPrompt) return true;
  return confirm(t("memory.confirm", { file: file.name, need: fmtMB(bytes), percent: Math.round((bytes / budget) * 100), limit: fmtMB(budget) }));
}

/** After an analysis: give a large CAD engine heap back to the system. */
async function afterAnalysisMemory() {
  if (currentEngine() !== "browser") return;
  memory.estimate = null;
  if (memory.heap > 0.6 * memoryBudget()) {
    const client = await browserClient();
    if (client.releaseMemory()) memory.heap = 0;
  }
  renderMemory();
}

setInterval(() => document.visibilityState === "visible" && !$("memory-card").hidden && renderMemory(), 2000);

// ---------------------------------------------------------------- scripts and AI assistants

// The page can be driven by a link (see ai.html):
//   ?url=<address of a 3D file>   analyse that file (the server must allow CORS)
//   &lang=fr|en  &unit=mm|cm|m|in|ft  &quality=coarse|normal|fine
//   &export=json|xlsx|csv         download the results once analysed
//   &report=1                     show the results as plain text in the page
// The results are also in <script id="reader3d-result" type="application/json">,
// <body data-status="analysing|done|error"> and window.reader3d.
const params = new URLSearchParams(location.search);

function setStatus(status, message = "") {
  document.body.dataset.status = status;
  if (message) document.body.dataset.error = message;
  else delete document.body.dataset.error;
}

function plainReport(data) {
  const s = data.summary;
  const n = (v, unit) => (v == null ? "—" : `${+v.toPrecision(10)} ${unit}`);
  const lines = [
    `file: ${data.file}`,
    `kind: ${data.kind} (${data.kind === "cad" ? "exact B-rep volume" : "closed-mesh volume"}), source unit: ${data.source_unit}`,
    `volume: ${n(s.volume, "mm3")}`,
    `surface_area: ${n(s.area, "mm2")}`,
    `envelope_aabb: ${s.bbox.size.map((x) => +x.toPrecision(10)).join(" x ")} mm (volume ${n(s.bbox.volume, "mm3")})`,
    `envelope_min_oriented: ${s.obb ? s.obb.size.map((x) => +x.toPrecision(10)).join(" x ") + " mm" : "—"}`,
    `fill_ratio: ${s.fill_ratio == null ? "—" : +(s.fill_ratio * 100).toPrecision(6) + " %"}`,
    `centre_of_mass: ${s.centroid ? s.centroid.map((x) => +x.toPrecision(10)).join(", ") + " mm" : "—"}`,
    `mass: ${n(s.mass, "g")} (density ${data.density} g/cm3)`,
    `bodies: ${s.bodies} (${s.open_bodies} open)`,
    ...(data.thickness
      ? [`wall_thickness (${data.thickness.method}): min ${n(data.thickness.min, "mm")}, median ${n(data.thickness.median, "mm")}, max ${n(data.thickness.max, "mm")}${data.thickness.details ? `, lettering below ${data.thickness.floor} mm: (${n(data.thickness.details.min, "mm")})` : ""}`]
      : []),
    "",
    "name | volume_mm3 | area_mm2 | size_x_mm | size_y_mm | size_z_mm | closed",
    ...data.bodies.map((b) => [b.name, b.volume ?? "—", b.area, ...b.bbox.size, b.closed].map((v) => (typeof v === "number" ? +v.toPrecision(10) : v)).join(" | ")),
  ];
  return lines.join("\n");
}

function publishResult(r) {
  updatePublished(r);
  const format = params.get("export");
  if (format === "json") exportJson().catch((err) => showError(err.message));
  else if (format === "xlsx") exportXlsx().catch((err) => showError(err.message));
  else if (format === "csv") exportCsv().catch((err) => showError(err.message));
}

/** The machine-readable result in the page (and the text report), kept up to date. */
function updatePublished(r) {
  // First: a listener of the event that asks for the contract gets the new one.
  publishSemantic();
  document.dispatchEvent(new CustomEvent("reader3d-part"));
  const data = exportableResult(r);
  // "<" escaped so that a part name cannot close the script element.
  $("reader3d-result").textContent = JSON.stringify(data).replace(/</g, "\\u003c");
  if (params.get("report")) {
    let pre = $("reader3d-report");
    if (!pre) {
      pre = document.createElement("pre");
      pre.id = "reader3d-report";
      pre.className = "card report";
      document.querySelector(".panel").prepend(pre);
    }
    pre.textContent = plainReport(data);
  }
}

// The semantic contract (engine/semantic.js) of the result shown, for the IA
// page and for scripts. It takes seconds on a part with thousands of faces: it
// is built when asked for, kept until the published result changes, and
// written into #reader3d-semantic-result when the page is idle, so that it
// never holds up or breaks the result itself.
let semanticKept = null; // {result, density, method, semantic}
let semanticPending = null; // idle callback writing #reader3d-semantic-result

/** The semantic contract of the result shown (null without one). */
function currentSemantic() {
  const r = state.result;
  if (!r) return null;
  const density = $("density").value;
  // The thickness method changes the statistics exported without republishing.
  const method = thickMethod();
  if (semanticKept?.result !== r || semanticKept.density !== density || semanticKept.method !== method) {
    // The bodies checked, each with its index in r.bodies (what setSelection takes).
    const data = exportableResult(r);
    const indices = includedIndices();
    data.bodies = data.bodies.map((b, k) => ({ ...b, source_index: indices[k] }));
    semanticKept = { result: r, density, method, semantic: buildSemantic3D(data) };
  }
  return semanticKept.semantic;
}

/** #reader3d-semantic-result: "null" at once (never that of another state), the new contract when the page is idle. */
function publishSemantic() {
  semanticKept = null;
  $("reader3d-semantic-result").textContent = "null";
  if (semanticPending != null) (window.cancelIdleCallback ?? clearTimeout)(semanticPending);
  semanticPending = null;
  if (!state.result) return;
  const write = () => {
    semanticPending = null;
    let text = "null";
    try {
      text = JSON.stringify(currentSemantic()).replace(/</g, "\\u003c");
    } catch (err) {
      console.warn("Semantic contract not built", err);
    }
    $("reader3d-semantic-result").textContent = text;
  };
  semanticPending = window.requestIdleCallback ? requestIdleCallback(write, { timeout: 2000 }) : setTimeout(write);
}

async function openUrl(url) {
  setStatus("analysing");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "model");
    const fileName = params.get("name") || name;
    await openFile(new File([await res.blob()], fileName));
  } catch (err) {
    const message = t("error.loadUrl", { url, reason: err.message });
    showError(message);
    setStatus("error", message);
  }
}

// window.reader3d: for scripts and browser-driving AI agents.
//   await reader3d.analyze(fileOrUrl) -> results (same JSON as the export)
window.reader3d = {
  version: 1,
  semanticVersion: SEMANTIC_VERSION,
  aiContextVersion: AI_CONTEXT_VERSION,
  aiContext(options = {}) {
    if (!state.result) return null;
    return buildAIContext(currentSemantic(), options);
  },
  get semantic() {
    return currentSemantic();
  },
  get result() {
    return state.result ? exportableResult(state.result) : null;
  },
  get status() {
    return document.body.dataset.status ?? "idle";
  },
  async analyze(input, { name } = {}) {
    state.noPrompt = true; // no memory confirmation dialog for scripts
    if (typeof input === "string") await openUrl(input);
    else await openFile(input instanceof File ? input : new File([input], name ?? "model"));
    if (document.body.dataset.status === "error") throw new Error(document.body.dataset.error);
    return this.result;
  },
  report() {
    return state.result ? plainReport(exportableResult(state.result)) : "";
  },
  /** The part shown, for the costing page: geometry and wall thickness (null if not computed). */
  part() {
    return partFeatures();
  },
  /** Check these bodies (indices into result.bodies): the volume and the costing become theirs. */
  setSelection(indices) {
    if (state.result) setIncluded(indices.filter((i) => i >= 0 && i < state.result.bodies.length));
    return partFeatures();
  },
  /** Material of the part (alloy name and density g/cm³), e.g. from a customer request. */
  setMaterial(label, density) {
    setMaterial(label, density);
  },
  /** Compute the wall thickness of the part shown (with progress), then return part(). */
  async computeThickness() {
    if (state.result?.bodies.some((b) => b.closed)) await ensureThickness();
    return partFeatures();
  },
};

function partFeatures() {
  const r = state.result;
  if (!r) return null;
  const s = currentSummary() ?? { volume: null, area: null, bbox: { size: [0, 0, 0] }, bodies: 0, open_bodies: 0 };
  const thicknessOf = (indices) => {
    if (!thick.results) return null;
    const wall = thickStats(indices, "wall");
    const sphere = thickStats(indices, "sphere");
    // The thinnest wall of the quote: typed in, else the one detected.
    return { min: thick.minOverride ?? wall.min, detected: wall.min, details: wall.details, floor: thick.floor, markings: wall.markings, median: sphere.median, max: sphere.max };
  };
  return {
    file: r.file,
    volume: s.volume,
    area: s.area,
    bboxSize: s.bbox.size,
    bodies: s.bodies,
    openBodies: s.open_bodies,
    thickness: includedIndices().length ? thicknessOf(includedIndices()) : null,
    // The bodies checked in the list of the 3D page: what is quoted.
    selected: includedIndices(),
    // Every body of the file: the costing page can quote them one by one.
    parts: r.bodies.map((b, i) => ({
      index: i,
      name: b.name,
      closed: b.closed,
      volume: b.volume,
      area: b.area,
      bboxSize: b.bbox.size,
      thickness: b.closed ? thicknessOf([i]) : null,
    })),
  };
}

// ---------------------------------------------------------------- language

function applyLanguage() {
  applyToPage();
  renderTabs();
  $("language").value = language();
  showEngineStatus(null);
  renderPanel();
  renderMemory();
  renderThickness();
}

$("language").addEventListener("change", (e) => {
  setLanguage(e.target.value);
  applyLanguage();
});

// ---------------------------------------------------------------- start

for (const [param, id] of [["unit", "unit"], ["quality", "quality"]]) {
  const value = params.get(param);
  if (value && [...$(id).options].some((o) => o.value === value)) $(id).value = value;
}
defaultMaterial = { value: $("material").value, alloy: null, density: $("density").value };
showTab(createTab());
applyLanguage();
setStatus("idle");
{
  let page = params.get("page");
  try {
    page ??= sessionStorage.getItem("reader3d.page");
  } catch {
    // no storage
  }
  if (page === "ia" || page === "chiffrage" || page === "parametres") showPage(page);
}
initEngines().then(() => {
  const url = params.get("url");
  if (url) {
    state.noPrompt = true;
    openUrl(url);
  }
});
