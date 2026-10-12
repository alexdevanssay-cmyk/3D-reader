import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { applyToPage, language, locale, setLanguage, t, tMessage } from "./i18n.js";
import { engravingMask, thicknessHistogram, thicknessStats } from "./engine/thickness.js";
import { summarize } from "./engine/summary.js";
import { buildSemantic3D, SEMANTIC_VERSION } from "./engine/semantic.js";
import { buildAIContext, AI_CONTEXT_VERSION } from "./engine/ai-context.js";
import {
  PARTING_VERSION, REACH_DOWN, REACH_UP, SIDE_UPPER, ZERO_DRAFT,
  applyOverrides, faceRegions, lineMesh, lineSummary, mouldBlocks, parseDirection, partingLine, sameDirection, snapDirection,
} from "./engine/parting.js";
import { SIDE_LOWER, SIDE_NONE, axisLabel, parseTriple } from "./engine/parting.js";
import {
  MAX_LOOPS, MAX_POINTS, alignPoints, arcDefault, arcFromCentre, arcGeometry, drawMesh, drawnParting, layArc, layStraight, parseDrawing,
  reviveDrawing, rotateAbout, segmentName, segmentPlane, serializeDrawing, surfacePoint, turnSign,
} from "./engine/parting-draw.js";
import {
  FEEDING_VERSION, METHOD as FEEDING_METHOD, feedingContext, feedingYield, feeds, gateFromPoint, hotSpotsWithoutRiser,
  resizeRiser, riserFromPoint,
} from "./engine/feeding.js";
import { capOrders, capQuad, planeCutsBox } from "./section.js";

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
// A stencil buffer: the section closes the solids it cuts (syncCaps; three.js 0.180 has none by default).
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
camera.up.set(0, 0, 1); // CAD convention: Z is up
camera.position.set(1, -1, 1);

// Trackball: the model turns freely in every direction (an orbit stops at the poles,
// half a turn over the top); the camera's up turns with it.
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 2;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.8;
controls.dynamicDampingFactor = 0.2; // a little inertia after the mouse is released
controls.keys = []; // no A/S/D keys held for rotate/zoom/pan: they are typed in the fields of the page
// Where the view is on the page, read again at each drag: the bar above it may have wrapped since.
renderer.domElement.addEventListener("pointerdown", () => controls.handleResize(), true);

/** The view stopped where it is: no turn, zoom or pan left from the inertia of the last drag (TrackballControls 0.180 fields). */
function stopInertia() {
  controls._lastAngle = 0;
  controls._zoomStart.copy(controls._zoomEnd);
  controls._panStart.copy(controls._panEnd);
}

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
  controls.handleResize();
  // The parting line as wide in pixels at any size of the view.
  for (const mesh of state.meshes) mesh.userData.partingOverlay?.userData.line?.material.resolution.set(w, h);
  // Likewise the lines of the drawing by hand.
  for (const mesh of state.meshes) for (const key of ["drawOverlay", "drawHover"]) mesh.userData[key]?.traverse((o) => o.material?.resolution?.set(w, h));
}
new ResizeObserver(resize).observe(viewport);
resize();

// The pages fill the window under the top bar, whatever its height (it wraps on a narrow window): --topbar-h of style.css.
{
  const topbar = document.querySelector(".topbar");
  const measure = () => document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  new ResizeObserver(measure).observe(topbar);
  measure();
}
// The bottom of the tool bar of the 3D view (it wraps on a narrow window): --toolbar-h, under which the hint of the drawing by hand stands.
{
  const toolbar = viewport.querySelector(".toolbar");
  const measure = () => viewport.style.setProperty("--toolbar-h", `${toolbar.offsetTop + toolbar.offsetHeight}px`);
  new ResizeObserver(measure).observe(toolbar);
  measure();
}

renderer.setAnimationLoop(() => {
  stepTurn(); // the part turned by the arrows of the drawing by hand, animated
  controls.update();
  syncCaps();
  renderer.render(scene, camera);
  drawFrame(); // the numbers of its points, where they are on the view
});
// Drawn again as soon as the view changes size (the panel's splitter dragged,
// panels.js): the canvas resized after the frame was drawn would stay blank, or
// stretched, until the next one.
new ResizeObserver(() => renderer.render(scene, camera)).observe(viewport);

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
  // The hooks of the view for scripts and tests: nothing faded, no parting shown.
  noteFaded();
  $("parting-card").dataset.overlay = $("parting-card").dataset.undercuts = "";
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
    client.onShared(onSharedNote);
    return client;
  });
  return engine.browserClient;
}

/** A write in the shared network folder that failed: said with the results of that key, in the tabs that show them. */
function onSharedNote({ key, note }) {
  for (const tab of tabs) {
    if (tab.result?.cacheKey !== key) continue;
    tab.result.networkNote = note;
    if (tab === activeTab) renderPanel();
  }
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
  network: "loading.network",
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
    // The part's identity before the tab shows the file: the IA page knows its conversations by it.
    const partId = await partIdFor(file, data);
    if (seq !== tab.seq) return;
    // Only now does the tab show this file (a failed file leaves the previous one).
    tab.handle = handle ?? (file === tab.file ? tab.handle : null);
    tab.file = file;
    if (tab.result !== data) partingAbandon(tab.result);
    tab.result = data;
    tab.part = { id: partId, file: file.name };
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
  partingNewModel(data);
  feedingNewModel(data);
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
  if (r.cached) notes.push(t(r.cachedFrom === "network" ? "method.network" : "method.cached"));
  // The shared network folder (engine/shared-cache.js): its access to grant, or a read or a write that failed, said discreetly
  // (why it failed, said in French by the folder's modules, in the French note only: the English one leaves {message} out).
  const net = r.networkNote;
  if (net) notes.push(net.kind === "prompt" ? t("method.networkPrompt") : t(net.write ? "method.networkWrite" : "method.networkRead", { message: net.message }));
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
function currentSummary(indices = includedIndices()) {
  const r = state.result;
  if (!r) return null;
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
  renderParting();
  applyParting();
  renderFeeding();
  applyFeeding();
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
  renderFeeding(); // the masses of the risers
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
    // Its own colour (the material's is grey when faded, white when coloured by triangle).
    const color = (state.meshes[i].userData.color ?? state.meshes[i].material.color).getHexString();

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
  // The parting line card is the body selected's (a message about the body before it, gone), and the risers card.
  const p = partingOf();
  if (p) p.message = null;
  renderParting();
  applyParting();
  renderFeeding();
  applyFeeding();
  document.querySelector("#bodies tr.selected")?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- exports

/** Results without the display meshes, for files and for scripts. */
function exportableResult(r, indices = includedIndices()) {
  const density = parseFloat($("density").value);
  const mass = (v) => (v != null && Number.isFinite(density) && density >= 0 ? (v / 1000) * density : null);
  return {
    file: r.file,
    kind: r.kind,
    source_unit: r.source_unit,
    units: { length: "mm", area: "mm2", volume: "mm3", mass: "g", density: "g/cm3" },
    engine: r.engine ?? "python",
    density,
    summary: { ...(currentSummary(indices) ?? r.summary), mass: mass((currentSummary(indices) ?? r.summary).volume) },
    bodies: indices.map((i) => {
      const { mesh, ...b } = r.bodies[i];
      return { ...b, mass: mass(b.volume), ...thicknessExport(r, [i]), ...partingExport(r, i), ...feedingExport(r, i) };
    }),
    ...thicknessExport(r, indices),
    elapsed_s: r.elapsed_s,
  };
}

/**
 * Wall thickness of bodies of the result shown, for the exports:
 * {thickness: {method, min, median, max, sphere, wall}} (mm), or {} when not
 * computed. sphere and wall: {min, median, max} of those methods, whichever
 * method the view shows (the foundry screen of the AI context reads them).
 */
function thicknessExport(r, indices) {
  if (r !== state.result || !thick.results) return {};
  const stats = thickStats(indices);
  // The thinnest wall always by the "wall" method (see thickness.js).
  const wall = thickStats(indices, "wall");
  const sphere = thickMethod() === "sphere" ? stats : thickStats(indices, "sphere");
  const minMedianMax = (s) => ({ min: s.min, median: s.median, max: s.max });
  return {
    thickness: {
      method: thickMethod(),
      min: wall.min,
      median: stats.median,
      max: stats.max,
      floor: thick.floor,
      details: wall.details,
      sphere: minMedianMax(sphere),
      wall: minMedianMax(wall),
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

/**
 * The pose of the view looking at `centre` from along `dir` (unit, towards
 * the camera), `up` its up, far enough to see a sphere of `radius`, the key
 * light above it: {position, up, target, light, near, far}.
 */
function viewPose(dir, up, centre, radius) {
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  return {
    position: centre.clone().addScaledVector(dir, dist).toArray(),
    up: up.toArray(),
    target: centre.toArray(),
    light: centre.clone().add(new THREE.Vector3(radius, -radius * 2, radius * 3)).toArray(),
    near: dist / 1000,
    far: dist * 100,
  };
}

/** The view in a pose ({position, up, target, light}, near and far when given). */
function applyPose(pose) {
  camera.position.fromArray(pose.position);
  camera.up.fromArray(pose.up);
  controls.target.fromArray(pose.target);
  keyLight.position.fromArray(pose.light);
  if (pose.near) {
    camera.near = pose.near;
    camera.far = pose.far;
    camera.updateProjectionMatrix();
  }
}

/** The camera looking at `centre` from along `dir`, `up` its up, the whole of a sphere of `radius` seen. */
function placeCamera(dir, up, centre, radius) {
  applyPose(viewPose(dir, up, centre, radius));
  stopInertia();
  controls.update();
}

function setView(name) {
  if (state.bounds.isEmpty()) return;
  finishTurn(); // a turn by the arrows of the drawing by hand ends first
  const center = state.bounds.getCenter(new THREE.Vector3());
  const radius = state.bounds.getSize(new THREE.Vector3()).length() / 2 || 1;
  const dir = (VIEWS[name] || camera.position.clone().sub(controls.target)).clone().normalize();
  // A named view stands upright (Z up; looking straight down Z, Y up); "Recadrer" keeps the turn of the view.
  if (VIEWS[name]) {
    camera.up.set(0, 0, 1);
    if (Math.abs(dir.z) > 0.999) camera.up.set(0, 1, 0);
  } else if (Math.abs(camera.up.clone().normalize().dot(dir)) > 0.999) camera.up.set(0, 0, 1);
  placeCamera(dir, camera.up, center, radius);
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

// The section closes the solids it cuts: each closed body shown (not an open
// one, nor one faded, nor one whose triangles the analysis had to turn round
// or found twice: see countable), each riser and the ingate gets a cap lying
// in the section plane, drawn where the plane is inside it. The stencil
// buffer counts per pixel the back faces of the solid clipped by the plane up
// and its front faces down, along the whole ray (no depth test): what is left
// is non-zero where the ray meets the plane inside the solid (three.js
// webgl_clipping_stencil). One solid after the other (increasing render
// orders), each cap resetting the count wherever it is drawn: solids of
// different colours do not mix. The caps share one rectangle, over all the
// solids cut: the same depths, so that where solids overlap the cap drawn
// later wins (LessEqual), never a mix of both. A cap is the solid's colour,
// darker (the neutral grey of the parting display, the grey of no value under
// the thickness colours); opaque, drawn after the opaque bodies and before
// the translucent overlays; translucent for a body seen through (a thickness
// highlight), then only from the side removed (from the side kept, the faces
// in front of the cut write no depth: the cap would be drawn over them). The
// halves of the mould are a display round the part, not material: cut, not
// capped. The caps are not in state.meshes: a click on a cut selects the body
// cut, but places nothing on the faces hidden behind it (onCut). Followed at
// each frame (syncCaps): the plane moved or flipped, another model or tab,
// the risers or the ingate changed, a body shown or hidden; nothing drawn
// without the section.
const capGroup = new THREE.Group();
scene.add(capGroup);
let caps = []; // {target, kind ("body" | "riser" | "gate"), geometry, translucent, group, stencil, cap}
const CAP_SHADE = 0.75; // a body's cut darker than its faces: material, not a face
const CAP_GLOW = 0.4;
const CAP_SEE_THROUGH = 0.45;
const capColor = new THREE.Color();
const capBox = new THREE.Box3();
const capSpan = new THREE.Box3(); // the boxes of the solids cut
// The rectangle of every cap, and the plane and the box it was set for.
const capGeometry = new THREE.BufferGeometry();
capGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
capGeometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(12), 3));
capGeometry.setIndex([0, 1, 2, 0, 2, 3]);
let capGeometryAt = null;
// What the analysis notes when it had to turn triangles round (meshanalysis.js, reader3d/mesh.py).
const WINDING_REPAIRED = "Inconsistent triangle orientation was repaired";

/** The materials counting a solid's faces: its back faces up, its front faces down; [opaque pass, translucent pass]. */
const capCounters = [false, true].map((transparent) => [
  [THREE.BackSide, THREE.IncrementWrapStencilOp],
  [THREE.FrontSide, THREE.DecrementWrapStencilOp],
].map(([side, op]) => new THREE.MeshBasicMaterial({
  side, transparent, colorWrite: false, depthWrite: false, depthTest: false, clippingPlanes: [sectionPlane],
  stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
})));

/** Whether an object is drawn: it and its parents visible, in the scene. */
function shownInScene(o) {
  for (; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === scene) return true;
  }
  return false;
}

/**
 * Whether the stencil can count a closed body's triangles: each face of the
 * solid once, all wound alike (meshanalysis.js mesh.countable). A triangle
 * turned round or drawn twice would leave a count where the plane is outside
 * the solid: a cap in its holes. Results without the flag (kept by an older
 * version, or of the server engine): not when the winding was repaired.
 */
function countable(body) {
  return body.mesh?.countable ?? !body.notes?.includes(WINDING_REPAIRED);
}

/** The solids the section closes, in drawing order: the bodies, then the risers and the ingate (over them where they meet). */
function capTargets() {
  if (!sectionOn || state.bounds.isEmpty()) return [];
  const bodies = [], markers = [];
  for (const mesh of state.meshes) {
    if (!shownInScene(mesh)) continue;
    const body = state.result?.bodies[mesh.userData.index];
    if (body?.closed && countable(body) && !mesh.userData.faded) {
      bodies.push({ target: mesh, kind: "body", geometry: mesh.userData.indexed ?? mesh.geometry, translucent: mesh.material.transparent });
    }
    mesh.userData.feedingOverlay?.traverse((o) => {
      if (o.userData.cap && o.visible) markers.push({ target: o, kind: o.userData.cap, geometry: o.geometry, translucent: false });
    });
  }
  return [...bodies, ...markers];
}

/** The caps of these solids, those before freed. */
function buildCaps(want) {
  for (const { cap } of caps) cap.material.dispose();
  capGroup.clear();
  const orders = capOrders(want.length);
  caps = want.map((w, k) => {
    const [countOrder, capOrder] = orders[k];
    const stencil = capCounters[w.translucent ? 1 : 0].map((material) => {
      const m = new THREE.Mesh(w.geometry, material);
      m.matrixAutoUpdate = false; // the solid's place, copied at each frame
      m.renderOrder = countOrder;
      return m;
    });
    // Drawn where the count is not 0, which it sets back to 0 wherever it is drawn (seen from either
    // side; flat: in one pass, also when translucent).
    const cap = new THREE.Mesh(capGeometry, new THREE.MeshStandardMaterial({
      metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, forceSinglePass: true, // lit as the bodies are
      transparent: w.translucent, opacity: w.translucent ? CAP_SEE_THROUGH : 1, depthWrite: !w.translucent,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    }));
    cap.renderOrder = capOrder;
    cap.frustumCulled = false;
    const group = new THREE.Group();
    group.add(...stencil, cap);
    capGroup.add(group);
    return { ...w, group, stencil, cap };
  });
}

/**
 * The colour of a solid's cap: a riser's or the ingate's own (opaque, where
 * their faces are translucent); a body's own, darker (the neutral grey of the
 * parting display, the grey of no value under the thickness colours).
 */
function capColorOf({ target, kind }) {
  if (kind !== "body") return capColor.copy(target.material.color);
  if (target.userData.parting) capColor.copy(PARTING_FACE);
  else if (target.material.vertexColors) capColor.copy(NO_VALUE);
  else capColor.copy(target.userData.color);
  return capColor.multiplyScalar(CAP_SHADE);
}

/** The caps as the view now is (before each frame): built again when the solids changed, else put on the plane where it cuts them. */
function syncCaps() {
  const want = capTargets();
  if (want.length !== caps.length || want.some((w, k) => w.target !== caps[k].target || w.geometry !== caps[k].geometry || w.translucent !== caps[k].translucent)) buildCaps(want);
  const { normal, constant } = sectionPlane;
  // The camera on the side kept: the cut is behind the solid's faces, which a translucent cap would be drawn over.
  const fromKept = sectionPlane.distanceToPoint(camera.position) >= 0;
  capSpan.makeEmpty();
  for (const entry of caps) {
    const { target, geometry, group, stencil, cap } = entry;
    target.updateWorldMatrix(true, false);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    capBox.copy(geometry.boundingBox).applyMatrix4(target.matrixWorld);
    group.visible = !(entry.translucent && fromKept) && planeCutsBox(normal.toArray(), constant, { min: capBox.min.toArray(), max: capBox.max.toArray() });
    if (!group.visible) continue;
    capSpan.union(capBox);
    for (const m of stencil) {
      m.matrix.copy(target.matrixWorld);
      m.matrixWorldNeedsUpdate = true;
    }
    cap.material.color.copy(capColorOf(entry));
    // A body's glow when selected; a riser or the ingate lit from within a little: its own colour at any angle, where a lit face would turn brown.
    if (entry.kind === "body") cap.material.emissive.copy(target.material.emissive);
    else cap.material.emissive.copy(capColor).multiplyScalar(CAP_GLOW);
  }
  // The rectangle of the caps, on the plane over the boxes of the solids cut: set again when either moved.
  const now = [normal.x, normal.y, normal.z, constant, ...capSpan.min.toArray(), ...capSpan.max.toArray()];
  if (!capSpan.isEmpty() && !(capGeometryAt && now.every((x, k) => x === capGeometryAt[k]))) {
    const quad = capQuad(now.slice(0, 3), constant, { min: capSpan.min.toArray(), max: capSpan.max.toArray() });
    if (quad) {
      capGeometryAt = now;
      const { position, normal: normals } = capGeometry.attributes;
      position.array.set(quad);
      for (let k = 0; k < 4; k++) normals.setXYZ(k, normal.x, normal.y, normal.z);
      position.needsUpdate = normals.needsUpdate = true;
    }
  }
  // What the section closes, for scripts and tests: "body riser gate"…
  const shown = caps.filter((c) => c.group.visible).map((c) => c.kind).join(" ");
  if (viewport.dataset.caps !== shown) viewport.dataset.caps = shown;
}

const cutNormals = new THREE.Matrix3();
const cutFace = new THREE.Vector3();

/**
 * Whether a ray from the camera meets the cut of a body (its cap) before
 * these hits (on the side the section keeps, nearest first): from the side
 * removed, it crosses the plane inside a body capped, counted as the stencil
 * does (that body's back faces kept up, its front faces down: not 0).
 */
function onCut(hits, ray) {
  if (!sectionOn || sectionPlane.distanceToPoint(ray.origin) >= 0) return false;
  return caps.some(({ kind, target, group }) => {
    if (kind !== "body" || !group.visible) return false;
    cutNormals.getNormalMatrix(target.matrixWorld);
    let count = 0;
    for (const h of hits) {
      if (h.object !== target || !h.face) continue;
      count += cutFace.copy(h.face.normal).applyMatrix3(cutNormals).dot(ray.direction) > 0 ? 1 : -1;
    }
    return count !== 0;
  });
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
  // On the cut of a body: no riser, ingate nor face of the parting line on the faces it hides; the body still selected.
  const seen = onCut(hits, raycaster.ray) ? [] : hits;
  if (feedingClick(seen) || partingClick(seen, { x: e.clientX, y: e.clientY })) return;
  // Through the bodies faded: the first body seen there (a faded one where nothing else is behind it).
  const hit = hits.find((h) => !h.object.userData.faded) ?? hits[0];
  select(hit ? hit.object.userData.index : -1);
});

// Drag and drop anywhere on the page.
const hint = $("drop-hint");
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  // The hint is the 3D page's: not shown under the other pages, whose drops it never sees end.
  if ($("page-viewer").hidden) return;
  hint.hidden = false;
  hint.classList.add("dragging");
});
// Whatever takes the drop (a data file row of the costing pages stops it there), the hint goes away:
// captured on the way down, before anything can stop it.
window.addEventListener("drop", () => {
  hint.classList.remove("dragging");
  if (state.result) hint.hidden = true;
}, true);
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
  scale: null, // {area, total}: the histogram drawn over the scale, drawn again alone when the card changes width
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
  thick.scale = null;
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
      client.saveThickness(result.cacheKey, results, result.bodies);
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

// A body other than the card's while the parting line or the risers of that
// body are shown: translucent light grey, so that its overlays read through.
const FADED = new THREE.Color(0xd3d6da);
const FADED_LOOK = { transparent: true, opacity: 0.2, depthWrite: false };

/**
 * Opaque or translucent material: its own look back, see-through for a
 * highlight, or faded ("faded": behind a body that coincides with it, two
 * versions of a part, it gives way).
 */
function setSeeThrough(mesh, on) {
  const m = mesh.material;
  const look = mesh.userData.look;
  const want = on === "faded" ? FADED_LOOK : on ? { transparent: true, opacity: 1, depthWrite: false } : look;
  mesh.userData.faded = on === "faded";
  m.polygonOffsetFactor = m.polygonOffsetUnits = on === "faded" ? 4 : 1;
  if (m.transparent === want.transparent && m.opacity === want.opacity && m.depthWrite === want.depthWrite) return;
  Object.assign(m, want);
  m.needsUpdate = true;
}

/** A body faded: its own geometry, translucent light grey. */
function fadeBody(mesh) {
  plainColors(mesh);
  mesh.material.color.copy(FADED);
  setSeeThrough(mesh, "faded");
}

/**
 * The body whose overlays are shown (its parting line, or its risers and
 * ingate), the others faded; -1: none (or that body unchecked in the list:
 * hidden with its overlays, the others keep their own look).
 */
function overlayBody() {
  const i = partingBody();
  if (i < 0 || !state.meshes[i]?.visible) return -1;
  if (partingShown()) return i;
  const f = feedingOf();
  return f?.show && feedingField(i) ? i : -1;
}

/** How many bodies are faded, on the 3D view (for scripts and tests). */
const noteFaded = () => (viewport.dataset.faded = String(state.meshes.filter((mesh) => mesh.userData.faded).length));

/** The bodies not faded as they should be (the overlays shown or hidden, another body on the card). */
function fadeStale() {
  const i = overlayBody();
  return state.meshes.some((mesh, j) => !!mesh.userData.faded !== (i >= 0 && j !== i));
}

/** A mesh in its own colour: its indexed geometry back (and its colour, after being faded). */
function plainColors(mesh) {
  const m = mesh.material;
  if (mesh.userData.indexed) mesh.geometry = mesh.userData.indexed;
  m.color.copy(mesh.userData.color);
  if (m.vertexColors) {
    m.vertexColors = false;
    m.needsUpdate = true;
  }
}

/**
 * One colour per triangle: a geometry without shared vertices (RGBA: the
 * alpha fades the rest during a highlight), made the first time. The caller
 * sets its colours, then shows it (showFlat).
 */
function flatGeometry(mesh) {
  if (!mesh.userData.indexed) {
    mesh.userData.indexed = mesh.geometry;
    mesh.userData.flat = mesh.geometry.toNonIndexed();
    mesh.userData.flat.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.userData.flat.attributes.position.count * 4), 4));
  }
  return mesh.userData.flat;
}

/** Show the flat geometry of a mesh, in the colours of its triangles. */
function showFlat(mesh, geom) {
  geom.attributes.color.needsUpdate = true;
  if (mesh.geometry !== geom) mesh.geometry = geom;
  if (!mesh.material.vertexColors) {
    mesh.material.vertexColors = true;
    mesh.material.color.set(0xffffff);
    mesh.material.needsUpdate = true;
  }
}

/** Colour the meshes by thickness, or give them their own colour back. */
function applyThickness() {
  const active = (thick.colors || thick.highlight) && thick.results;
  // Not by thickness: the parting line when it is shown.
  if (!active && partingShown()) return applyParting();
  // The risers of a body shown: the other bodies faded.
  const overlay = overlayBody();
  state.meshes.forEach((mesh, i) => {
    if (overlay >= 0 && i !== overlay) return fadeBody(mesh);
    const values = thickValues(i);
    setSeeThrough(mesh, active && thick.highlight);
    if (!active) return plainColors(mesh);
    const geom = flatGeometry(mesh);
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
    showFlat(mesh, geom);
  });
  noteFaded();
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
  thick.scale = { area, total };
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
  if (thick.colors || thick.highlight) partingOff();
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
// The card wider or narrower (the panel's splitter dragged, the card folded): the scale only, its histogram kept.
new ResizeObserver(() => thick.results && thick.scale && drawScale(thick.scale.area, thick.scale.total)).observe($("thick-scale"));

// ---------------------------------------------------------------- parting line

// Draw direction and parting line of a cast part (engine/parting.js):
// proposed for the closed bodies once the model is shown, in a worker of its
// own (engine/partclient.js), and kept with the results of the file in this
// browser. It can be defined by hand: another candidate, the normal of a face
// picked on the 3D view, a direction typed in, and faces reassigned to the
// upper or lower half by clicking them (a stepped or warped line). That
// definition is kept per part (the SHA-256 of its file) in this browser.
const PARTING_KEY = "reader3d.parting.v1";
const PARTING_PARTS = 200; // parts whose definition by hand is kept, the latest
// On the 3D view: the halves of the mould are translucent blocks round the
// body (the upper one blue, the lower one green) and its faces a neutral
// light grey (lighter without draft), the undercuts yellow, the parting line
// red and a few pixels wide over everything.
const PARTING_FACE = new THREE.Color(0xaeb3b9);
const PARTING_UNDERCUT = new THREE.Color(0xffcf00);
const PARTING_LINE = 0xe8141b;
const PARTING_LINE_PX = 4;
const PARTING_UPPER = 0x2f6fde;
const PARTING_LOWER = 0x2c9c4c;
const PARTING_BLOCK_OPACITY = 0.2;
const PARTING_ARROW = 0x1f5fd0;
const WHITE = new THREE.Color(0xffffff);
// Order of the translucent overlays (after the bodies faded): the blocks, then the risers and the ingate (inside the upper block), the parting line last.
const ORDER_BLOCKS = 1;
const ORDER_MARKERS = 2;
const ORDER_LINE = 3;

const partClient = () => (partClient.module ??= import("./engine/partclient.js"));

// Per result: {results (per body {proposal, side, flags, plane, segments} or
// null), pending, percent, error, current (body -> definition by hand), geom
// (body -> its faces and edges), evaluated (directions classified), show,
// mode ("pick" | "assign" | null), busy (directions being classified), seq
// (the choices made on the card: a direction classified after a later
// choice is not applied), message, restored, draw (body -> its drawing by
// hand, see "drawing by hand"; mode "draw"), drawBody (the body drawn on)}.
const partings = new WeakMap();

function partingOf(r = state.result) {
  if (!r) return null;
  let p = partings.get(r);
  if (!p) {
    p = { results: null, pending: null, percent: null, error: null, current: new Map(), geom: new Map(), evaluated: new Map(), show: false, mode: null, busy: 0, seq: 0, message: null, restored: false, draw: new Map(), drawBody: -1 };
    partings.set(r, p);
  }
  return p;
}

/** The body of the card: the one selected in the list, else the largest closed body checked (-1: none). */
function partingBody() {
  const r = state.result;
  if (!r) return -1;
  if (state.selected >= 0 && state.selected < r.bodies.length) return state.selected;
  let best = -1;
  for (const i of includedIndices()) {
    if (r.bodies[i].closed && (best < 0 || (r.bodies[i].volume ?? 0) > (r.bodies[best].volume ?? 0))) best = i;
  }
  return best;
}

/** The id of the part of a result ("sha256:…" of its file), for its definitions by hand. */
function partIdOf(r) {
  return tabs.find((tab) => tab.result === r)?.part?.id ?? null;
}

/** Positions and indices of body i of the model shown (as analysed). */
function bodyArrays(i) {
  const geom = bodyGeometry(i);
  return { positions: geom.attributes.position.array, indices: geom.index.array };
}

/** The proposal of a body as a classification: {direction, summary, side, flags, plane, segments}. */
function proposalBase(res) {
  return { direction: res.proposal.direction, summary: res.proposal, side: res.side, flags: res.flags, plane: res.plane, segments: res.segments };
}

/** What body i shows: its definition by hand, else its proposal (null: none). */
function partingField(i, r = state.result) {
  const p = partingOf(r);
  const res = p?.results?.[i];
  if (!res) return null;
  return p.current.get(i) ?? { manual: false, source: null, overrides: {}, candidate: res.proposal.candidate_index, ...proposalBase(res) };
}

const partingShown = () => {
  const p = partingOf();
  return !!(p?.show && partingField(partingBody()));
};

// ---- definitions kept in this browser: {part id: {savedAt, bodies: {index: {direction, source, candidate, overrides, faces, drawing}}, drafts: {index: drawing}}}

function partingSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(PARTING_KEY));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/** The definition of a body kept (null: forgotten); with `draft`, its drawing by hand not applied (kept beside). */
function savePartingDef(partId, body, def, { draft = false } = {}) {
  if (!partId) return;
  const all = partingSaved();
  const entry = all[partId] ?? { bodies: {} };
  entry.bodies ??= {};
  const kept = draft ? (entry.drafts ??= {}) : entry.bodies;
  if (def) kept[body] = def;
  else delete kept[body];
  if (entry.drafts && !Object.keys(entry.drafts).length) delete entry.drafts;
  if (Object.keys(entry.bodies).length || entry.drafts) all[partId] = { ...entry, savedAt: Date.now() };
  else delete all[partId];
  // The latest parts only.
  const ids = Object.keys(all).sort((a, b) => (all[b].savedAt ?? 0) - (all[a].savedAt ?? 0));
  for (const id of ids.slice(PARTING_PARTS)) delete all[id];
  try {
    localStorage.setItem(PARTING_KEY, JSON.stringify(all));
  } catch {
    // kept for this visit only
  }
}

// ---- computation

/** A new model is shown: its parting, kept from an earlier opening, else computed in the background. */
function partingNewModel(data) {
  const p = partingOf(data);
  const kept = data.cachedParting;
  if (!p.results && kept?.version === PARTING_VERSION && kept.bodies?.length === data.bodies.length) p.results = kept.bodies;
  if (p.results) restoreParting();
  else computePartings(data);
  renderParting();
}

/** Propose the parting of the closed bodies of the model shown, in the background. */
function computePartings(r) {
  const p = partingOf(r);
  if (p.results || p.pending || r !== state.result) return;
  const bodies = r.bodies.map((b, i) => (b.closed ? bodyArrays(i) : null));
  if (!bodies.some(Boolean)) {
    p.results = r.bodies.map(() => null);
    return;
  }
  p.error = null;
  p.percent = 0;
  p.pending = partClient()
    .then((client) => client.computeParting(bodies, {
      owner: r,
      onProgress: ({ percent }) => {
        p.percent = percent;
        if (r === state.result) renderParting();
      },
    }).then((results) => {
      p.results = results.bodies;
      client.saveParting(r.cacheKey, results);
    }))
    .catch((err) => {
      p.error = err.message || String(err);
    })
    .finally(() => {
      p.pending = null;
      if (r !== state.result) return;
      renderParting();
      if (p.results) {
        restoreParting();
        applyParting();
      }
      // The risers and the ingate placed for this parting line (or along +Z without one).
      refreshFeeding();
    });
}

/** The faces (B-rep faces, else regions) and the edges of body i, computed once. */
function partingGeometry(i) {
  const p = partingOf();
  let g = p.geom.get(i);
  if (!g) {
    const { positions, indices } = bodyArrays(i);
    const line = lineMesh(positions, indices);
    g = { line, ...faceRegions(positions, indices, { brep: state.result.bodies[i].method === "brep", line }) };
    p.geom.set(i, g);
  }
  return g;
}

/** Direction d of body i classified on every triangle (in the worker), the proposal's as it is. */
async function partingDirection(i, d) {
  const r = state.result;
  const p = partingOf(r);
  const res = p.results[i];
  if (sameDirection(d, res.proposal.direction)) return proposalBase(res);
  const key = `${i}|${d.map((x) => x.toFixed(9)).join(",")}`;
  if (p.evaluated.has(key)) return p.evaluated.get(key);
  p.busy++;
  renderParting();
  try {
    const client = await partClient();
    const ev = await client.evaluateDirection(bodyArrays(i), d, { owner: r });
    const base = { direction: ev.summary.direction, summary: ev.summary, side: ev.side, flags: ev.flags, plane: ev.plane, segments: ev.segments };
    p.evaluated.set(key, base);
    return base;
  } finally {
    p.busy--;
    if (r === state.result) renderParting();
  }
}

/** A result no longer in any tab (closed, another file opened in it): its parting jobs dropped, they would hold up the other tabs'. */
function partingAbandon(r) {
  if (r) partClient.module?.then((client) => client.cancelParting(r));
}

/**
 * Body i defined by hand: a direction (its classification `base`) and faces
 * reassigned ({face: SIDE_UPPER | SIDE_LOWER}); the line follows the
 * boundary between the halves. The proposal itself, no face moved: no longer
 * a definition by hand. `drawn`: the line drawn by hand ({drawing, result}
 * of drawnParting, source "drawn"), whatever its direction.
 */
function setPartingDefinition(i, { base, source, overrides = {}, candidate = null, drawn = null }) {
  const r = state.result;
  const p = partingOf(r);
  const res = p.results[i];
  const moved = Object.keys(overrides).length;
  p.message = null;
  if (drawn) {
    const { field, def } = drawnDefinition(i, base, drawn);
    p.current.set(i, field);
    savePartingDef(partIdOf(r), i, def);
  } else if (!moved && sameDirection(base.direction, res.proposal.direction)) {
    p.current.delete(i);
    savePartingDef(partIdOf(r), i, null);
  } else {
    let { side, segments } = base;
    let line = base.summary.parting;
    let faces = null;
    let fixed = null; // the triangles of the faces moved
    if (moved) {
      const g = partingGeometry(i);
      faces = g.count;
      side = applyOverrides(base.side, g.region, overrides);
      fixed = Uint8Array.from(g.region, (face) => (face in overrides ? 1 : 0));
      const l = partingLine(g.line, side, base.direction, { flags: base.flags, plane: base.plane, fixed, height: base.summary.mould_height_mm });
      segments = l.segments;
      line = lineSummary(l);
    }
    p.current.set(i, { manual: true, source, overrides, candidate, base, direction: base.direction, summary: { ...base.summary, parting: line }, side, flags: base.flags, plane: base.plane, segments, fixed });
    savePartingDef(partIdOf(r), i, { direction: base.direction, source, candidate, overrides, faces });
  }
  if (!drawn) keepDrawing(i); // a drawing by hand replaced: kept as a draft
  applyParting();
  renderParting();
  // The risers and the ingate placed again for it (those placed by hand stay).
  refreshFeeding();
}

/** Back to the proposal for body i. */
function resetParting(i) {
  const p = partingOf();
  p.seq++; // a direction still being classified is not applied
  p.current.delete(i);
  p.mode = null;
  p.message = null;
  savePartingDef(partIdOf(state.result), i, null);
  keepDrawing(i); // a drawing by hand replaced: kept as a draft
  applyParting();
  renderParting();
  refreshFeeding();
}

/** The definitions by hand kept for the part shown, once its proposals are known. */
async function restoreParting() {
  const r = state.result;
  const p = partingOf(r);
  if (!p?.results || p.restored) return;
  p.restored = true;
  const entry = partingSaved()[partIdOf(r)];
  restoreDrafts(p, entry?.drafts); // the drawings by hand not applied, to go on with
  const defs = entry?.bodies ?? {};
  for (const [key, def] of Object.entries(defs)) {
    const i = Number(key);
    if (!p.results[i] || !Array.isArray(def?.direction) || def.direction.length !== 3) continue;
    try {
      const seq = p.seq;
      const base = await partingDirection(i, def.direction);
      // A choice made on the card meanwhile: it stands.
      if (seq !== p.seq) return;
      if (r !== state.result) {
        p.restored = false; // finished when its tab is shown again
        return;
      }
      // A line drawn by hand: its points, its segments and its halves rebuilt (else its direction only).
      if (def.source === "drawn" && restoreDrawing(i, def, base)) continue;
      let overrides = def.overrides ?? {};
      // Another tessellation of the part (its faces numbered otherwise): only the direction.
      if (Object.keys(overrides).length && def.faces !== partingGeometry(i).count) overrides = {};
      setPartingDefinition(i, { base, source: def.source ?? "vector", overrides, candidate: def.candidate ?? null });
    } catch (err) {
      if (!err.cancelled) console.warn("Parting line kept not restored", err);
    }
  }
}

/** The parting of body i of the result shown, for the exports and the semantic contract: {parting} or {}. */
function partingExport(r, i) {
  if (r !== state.result) return {};
  const p = partingOf(r);
  const res = p?.results?.[i];
  if (!res) return {};
  const cur = p.current.get(i);
  if (!cur) return { parting: res.proposal };
  const { candidates, ranking, sampled, method, version, draft_angle_deg, surface_area_mm2, triangles } = res.proposal;
  return {
    parting: {
      ...cur.summary,
      status: "manual",
      source: cur.source,
      candidate_index: cur.candidate,
      reassigned_faces: Object.keys(cur.overrides).length,
      // Drawn by hand: the undercuts are those of the halves given by part; its loops and segments.
      ...(cur.drawn ? { undercut_basis: "drawn_halves", drawn: cur.drawn } : {}),
      proposed: { axis: res.proposal.axis, direction: res.proposal.direction },
      candidates, ranking, sampled, method, version, draft_angle_deg, surface_area_mm2, triangles,
    },
  };
}

// ---- 3D view

function removePartingOverlay(mesh) {
  const group = mesh.userData.partingOverlay;
  if (!group) return;
  mesh.remove(group);
  group.traverse((o) => {
    if (o.userData.own) o.geometry?.dispose();
    o.material?.dispose();
  });
  mesh.userData.partingOverlay = null;
}

// The halves of the mould of a parting line (mouldBlocks), by its segments: computed once.
const blocksKept = new WeakMap();

/** The halves of the mould round body i for its parting `field` (null: none). */
function partingBlocks(i, field) {
  let blocks = blocksKept.get(field.segments);
  if (blocks === undefined) {
    const line = field.summary.parting;
    // A planar line: flat at its level. Without a line, the body is in one
    // half: under it (the upper half forms it), else over it.
    const level = line?.planar ? line.level_mm : line?.kind ? null : field.side.includes(SIDE_UPPER) ? -Infinity : Infinity;
    blocks = mouldBlocks(bodyArrays(i).positions, field.direction, { segments: field.segments, level });
    blocksKept.set(field.segments, blocks);
  }
  return blocks;
}

/** A translucent block of a half of the mould, with faint edges so that it reads as a block. */
function blockMeshes({ positions, indices, edges: outline }, color, half) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  const block = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: PARTING_BLOCK_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    flatShading: true, roughness: 0.9, clippingPlanes: [sectionPlane],
  }));
  const lines = new THREE.BufferGeometry();
  lines.setAttribute("position", new THREE.BufferAttribute(outline, 3));
  const edges = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.5, depthWrite: false, clippingPlanes: [sectionPlane],
  }));
  for (const o of [block, edges]) {
    o.renderOrder = ORDER_BLOCKS;
    o.userData.own = true;
    o.userData.half = half;
  }
  return [block, edges];
}

/**
 * The parting of the card's body on the 3D view ("Show"): the halves of the
 * mould as translucent blocks round it (the upper one blue, the lower one
 * green; "Mould halves" unchecked: none), their interface along the parting
 * surface; its faces in light grey, lighter where they have no draft, the
 * undercuts in yellow; the parting line in red, thick, over everything; an
 * arrow along the draw direction of the upper half. The other bodies faded.
 */
function applyParting() {
  // Shown before: its colours to take back (else the view is left as it is).
  const shown = state.meshes.some((mesh) => mesh.userData.parting);
  state.meshes.forEach(removePartingOverlay);
  const p = partingOf();
  const i = partingBody();
  const field = p?.show && i >= 0 ? partingField(i) : null;
  const card = $("parting-card");
  card.dataset.overlay = card.dataset.undercuts = "";
  if (!field) {
    if (!shown) return;
    state.meshes.forEach((mesh) => (mesh.userData.parting = false));
    return applyThickness(); // its own colours back, or the thickness
  }
  const color = new THREE.Color();
  let undercuts = 0;
  // While drawing by hand on it: the colours of the drawing, its own line and points, no blocks.
  const drawn = drawShown(i);
  if (drawn) drawn.shownTint = drawn.stage === "halves" ? drawn.tint : null;
  // The card's body unchecked in the list (hidden, with its overlays): the others in their own look, not faded.
  const fade = state.meshes[i].visible;
  state.meshes.forEach((mesh, j) => {
    mesh.userData.parting = j === i;
    if (j !== i) return fade ? fadeBody(mesh) : (setSeeThrough(mesh, false), plainColors(mesh));
    setSeeThrough(mesh, false);
    const geom = flatGeometry(mesh);
    const colors = geom.attributes.color.array;
    const triangles = colors.length / 12;
    for (let f = 0; f < triangles; f++) {
      // Undercuts in yellow, unless moved to a half by hand (drawn by hand: those of its halves).
      let undercut = field.undercut ? field.undercut[f] === 1 : !(field.flags[f] & (REACH_UP | REACH_DOWN)) && !field.fixed?.[f];
      color.copy(undercut ? PARTING_UNDERCUT : PARTING_FACE);
      if (field.flags[f] & ZERO_DRAFT && !undercut) color.lerp(WHITE, 0.5);
      if (drawn) undercut = drawFaceColour(drawn, f, color);
      if (undercut) undercuts++;
      for (let k = 0; k < 3; k++) {
        colors[12 * f + 4 * k] = color.r;
        colors[12 * f + 4 * k + 1] = color.g;
        colors[12 * f + 4 * k + 2] = color.b;
        colors[12 * f + 4 * k + 3] = 1;
      }
    }
    if (drawn) drawSeamColours(drawn, i, colors);
    showFlat(mesh, geom);
  });
  noteFaded();
  const mesh = state.meshes[i];
  const group = new THREE.Group();
  const blocks = $("parting-blocks").checked && !drawn ? partingBlocks(i, field) : null;
  if (blocks) group.add(...blockMeshes(blocks.lower, PARTING_LOWER, "lower"), ...blockMeshes(blocks.upper, PARTING_UPPER, "upper"));
  if (field.segments.length && !drawn) {
    // Width in pixels (the resolution: the size of the view, kept by resize()); drawn last, over the blocks.
    const material = new LineMaterial({ color: PARTING_LINE, linewidth: PARTING_LINE_PX, transparent: true, clippingPlanes: [sectionPlane] });
    material.resolution.set(viewport.clientWidth, viewport.clientHeight);
    const line = new LineSegments2(new LineSegmentsGeometry().setPositions(field.segments), material);
    line.renderOrder = ORDER_LINE;
    line.userData.own = true;
    group.add(line);
    group.userData.line = line;
  }
  // The arrow above the body (above the upper block), along the direction.
  const { min, max, size } = state.result.bodies[i].bbox;
  const centre = new THREE.Vector3(...min.map((v, k) => (v + max[k]) / 2));
  const d = new THREE.Vector3(...field.direction);
  const reach = Math.max(...size);
  const along = Math.abs(d.x) * size[0] + Math.abs(d.y) * size[1] + Math.abs(d.z) * size[2];
  const length = 0.35 * reach;
  // (While drawing: the rotation axis of the drawing instead.)
  if (!drawn) group.add(new THREE.ArrowHelper(d, centre.clone().addScaledVector(d, along / 2 + (blocks?.margin ?? 0) + 0.05 * reach), length, PARTING_ARROW, 0.3 * length, 0.15 * length));
  mesh.add(group);
  mesh.userData.partingOverlay = group;
  // What the view shows, for scripts and tests: "line", "lower", "upper"; the triangles in yellow.
  card.dataset.overlay = group.children.flatMap((o) => (o.isLineSegments2 ? ["line"] : o.isMesh && o.userData.half ? [o.userData.half] : [])).join(" ");
  card.dataset.undercuts = String(undercuts);
  applyDrawOverlay(); // the drawing by hand ("drawing", "axis")
}

/** The parting line no longer shown (the thickness is coloured instead). */
function partingOff() {
  const p = partingOf();
  if (!p?.show) return;
  p.show = false;
  p.mode = null;
  state.meshes.forEach((mesh) => {
    removePartingOverlay(mesh);
    mesh.userData.parting = false; // coloured by the thickness next
  });
  const card = $("parting-card");
  card.dataset.overlay = card.dataset.undercuts = "";
  renderParting();
}

/**
 * The point clicked on body i: the first of the ray on it, through the
 * bodies faded in front of it (another body, two versions of a part one over
 * the other); null when the ray does not meet it, or meets first a body that
 * is not faded (opaque: the face clicked is that body's).
 */
function cardHit(hits, i) {
  for (const h of hits) {
    if (h.object.userData.index === i) return h;
    if (!h.object.userData.faded) return null;
  }
  return null;
}

/**
 * A click on the 3D view while picking a face, reassigning faces or drawing
 * by hand (`at`: where, in client pixels): handled here (true), the
 * selection unchanged.
 */
function partingClick(hits, at = null) {
  const p = partingOf();
  if (!p?.mode) return false;
  const i = partingBody();
  // The card's body without a parting (open, none, being computed): its
  // buttons hidden, the mode off; the click selects as usual.
  if (i < 0 || !partingField(i)) {
    p.mode = null;
    p.message = null;
    renderParting();
    return false;
  }
  const drawing = drawActive();
  if (drawing) return drawClick(drawing, hits, at);
  if (!hits.length) return true;
  const hit = cardHit(hits, i);
  if (!hit) {
    p.message = t("parting.otherBody");
    renderParting();
    return true;
  }
  p.message = null;
  if (p.mode === "pick") {
    p.mode = null;
    pickPartingFace(i, hit.faceIndex);
  } else assignPartingFace(i, hit.faceIndex, Number($("parting-target").value));
  return true;
}

/** Normal (not unit) of triangle t of a mesh (positions P, indices I), by the winding of its corners. */
function triangleNormal(P, I, t) {
  const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
  const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

/** 1, or -1 when the triangles of body i turn inwards (by the sign of its enclosed volume): computed once into partingGeometry(i).outward. */
function partingOutward(i) {
  const g = partingGeometry(i);
  if (g.outward == null) {
    const { positions: P, indices: I } = bodyArrays(i);
    let volume = 0;
    for (let t = 0; t < I.length / 3; t++) {
      const n = triangleNormal(P, I, t);
      volume += P[3 * I[3 * t]] * n[0] + P[3 * I[3 * t] + 1] * n[1] + P[3 * I[3 * t] + 2] * n[2];
    }
    g.outward = volume < 0 ? -1 : 1;
  }
  return g.outward;
}

/** The outward normal (not unit) of the face of triangle f of body i: its B-rep face (or region) when planar, else the triangle. */
function faceNormal(i, f) {
  const { positions: P, indices: I } = bodyArrays(i);
  const g = partingGeometry(i);
  const outward = partingOutward(i);
  const sum = [0, 0, 0];
  let area = 0;
  for (let t = 0; t < g.region.length; t++) {
    if (g.region[t] !== g.region[f]) continue;
    const n = triangleNormal(P, I, t);
    for (let k = 0; k < 3; k++) sum[k] += n[k];
    area += Math.hypot(...n);
  }
  const planar = area > 0 && Math.hypot(...sum) > 0.999 * area;
  return (planar ? sum : triangleNormal(P, I, f)).map((x) => x * outward);
}

/** Draw direction from a face picked on the 3D view: its outward normal (that face upwards). */
async function pickPartingFace(i, f) {
  const r = state.result;
  const d = snapDirection(faceNormal(i, f));
  if (!d) return;
  const p = partingOf(r);
  const seq = ++p.seq;
  try {
    const base = await partingDirection(i, d);
    if (r === state.result && seq === p.seq) setPartingDefinition(i, { base, source: "face" });
  } catch (err) {
    if (!err.cancelled) showError(`${t("parting.title")} : ${tMessage(err.message || String(err))}`);
  }
}

/** Face f of body i (its B-rep face, or region) moved to a half of the mould. */
function assignPartingFace(i, f, target) {
  const field = partingField(i);
  if (!field) return;
  const face = partingGeometry(i).region[f];
  const overrides = { ...field.overrides, [face]: target };
  partingOf().seq++; // a direction still being classified is not applied
  const base = field.manual ? field.base : proposalBase(partingOf().results[i]);
  setPartingDefinition(i, { base, source: field.manual ? field.source : "proposal", overrides, candidate: field.candidate });
}

// ---- card

const fmtShare = (share) => `${(share * 100).toLocaleString(locale(), { maximumFractionDigits: 1 })} %`;

/** The parting line in words: planar at a height, stepped, warped, or none. */
function partingLineText(summary) {
  const line = summary.parting;
  if (!line?.kind) return t("parting.line.none");
  if (line.planar) {
    const axis = /^(-?)([XYZ])$/.exec(summary.axis);
    if (!axis) return t("parting.line.planarAlong", { level: fmtNum(line.level_mm, 2) });
    return t("parting.line.planar", { axis: axis[2], level: fmtNum((axis[1] ? -1 : 1) * line.level_mm + 0, 2) });
  }
  if (line.kind === "stepped") return t("parting.line.stepped", { range: fmtNum(line.height_range_mm, 1), levels: (line.levels_mm ?? []).map((h) => fmtNum(h, 1)).join(" / ") });
  return t("parting.line.warped", { range: fmtNum(line.height_range_mm, 1) });
}

/** Rebuilt only when it changes: a click must not lose its row between the press and the release. */
const htmlShown = new WeakMap();
function setHtml(el, html) {
  if (htmlShown.get(el) === html) return;
  el.innerHTML = html;
  htmlShown.set(el, html);
}

function renderParting() {
  const card = $("parting-card");
  const r = state.result;
  card.hidden = !r;
  // A crosshair while placing on the 3D view (here, or a riser or the ingate).
  renderer.domElement.style.cursor = feedingOf(r)?.mode ? "crosshair" : "";
  syncDrawView(partingOf(r), partingBody()); // drawing by hand: left when its body is no longer the card's (or no model); the view's controls
  if (!r) return;
  const p = partingOf(r);
  const i = partingBody();
  const field = i >= 0 ? partingField(i) : null;
  const named = r.bodies.length > 1 && i >= 0;
  $("parting-body").hidden = !named;
  if (named) $("parting-body").textContent = t("parting.body", { name: r.bodies[i].name });
  let status = "";
  if (i < 0) status = t("parting.none");
  else if (!r.bodies[i].closed) status = t("parting.open");
  else if (p.pending) status = t("parting.computing", { percent: p.percent != null ? `${p.percent} %` : "" });
  else if (p.error) status = t("parting.error", { message: tMessage(p.error) });
  else if (p.busy) status = t("parting.busy");
  $("parting-status").hidden = !status;
  $("parting-status").textContent = status;
  $("parting-retry").hidden = !(p.error && !p.pending);
  $("parting-show").checked = p.show && !!field;
  $("parting-show").disabled = !field;
  $("parting-blocks").disabled = !field;
  $("parting-main").hidden = !field;
  if (!field) return;
  if (p.mode) renderer.domElement.style.cursor = "crosshair";

  const s = field.summary;
  const res = p.results[i];
  $("parting-axis").textContent = s.axis;
  const origin = $("parting-origin");
  origin.textContent = t(field.drawn ? drawnOrigin(p, i, field) : field.manual ? "parting.manual" : "parting.proposed");
  origin.classList.toggle("manual", field.manual);
  const draft = s.draft_angle_deg ?? res.proposal.draft_angle_deg;
  const rows = [
    [t("parting.undercut"), `${fmtShare(s.undercut_share)} (${fmtArea(s.undercut_area_mm2)})`],
    [t("parting.zeroDraft", { angle: fmtNum(draft, 2) }), `${fmtShare(s.zero_draft_share)} (${fmtArea(s.zero_draft_area_mm2)})`],
    [t("parting.line"), partingLineText(s)],
    ...(s.parting?.kind ? [[t("parting.length"), t("parting.length.value", { length: fmtNum(s.parting.length_mm, 1), loops: s.parting.loops })]] : []),
    [t("parting.height"), `${fmtNum(s.mould_height_mm, 2)} mm`],
    [t("parting.projected"), fmtArea(s.projected_area_mm2)],
    ...(Object.keys(field.overrides).length ? [[t("parting.reassigned"), String(Object.keys(field.overrides).length)]] : []),
    ...(field.drawn ? [[t("parting.draw.stats"), drawnStats(field.drawn)]] : []),
  ];
  setHtml($("parting-stats"), rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join(""));
  const sampled = res.proposal.sampled;
  $("parting-sampled").hidden = !sampled;
  if (sampled) $("parting-sampled").textContent = t("parting.sampled", { samples: fmtNum(sampled.samples, 0), triangles: fmtNum(sampled.triangles, 0) });

  // The candidates, the proposal first: a click takes one.
  const short = (c) => (c.parting?.kind ? t(`parting.short.${c.parting.kind}`) : "—");
  const order = res.proposal.ranking ?? res.proposal.candidates.map((_, k) => k);
  setHtml($("parting-candidates").tBodies[0], order
    .map((k) => {
      const c = res.proposal.candidates[k];
      const on = sameDirection(c.direction, field.direction);
      const proposed = k === res.proposal.candidate_index;
      return `<tr class="${proposed ? "proposed" : ""}" data-candidate="${k}" title="${escapeHtml(t("parting.candidate.title"))}">` +
        `<td><input type="radio" name="parting-candidate" value="${k}"${on ? " checked" : ""}></td>` +
        `<td>${escapeHtml(c.axis)}${proposed ? " ★" : ""}</td><td class="num">${fmtShare(c.undercut_share)}</td><td class="num">${fmtShare(c.zero_draft_share)}</td><td>${escapeHtml(short(c))}</td></tr>`;
    })
    .join(""));

  $("parting-pick").classList.toggle("active", p.mode === "pick");
  $("parting-assign").classList.toggle("active", p.mode === "assign");
  const hint = p.message ?? (p.mode === "draw" ? drawHint(i) : p.mode === "pick" ? t("parting.pick.hint") : p.mode === "assign" ? t("parting.assign.hint", { target: $("parting-target").selectedOptions[0]?.textContent ?? "" }) : "");
  $("parting-hint").hidden = !hint;
  $("parting-hint").textContent = hint;
  $("parting-reset").disabled = !field.manual;
  $("parting-legend").innerHTML = t(p.mode === "draw" ? "parting.draw.legend" : "parting.legend");
  renderDrawPanel(p, i, field, hint); // the drawing by hand: its panel, its controls on the view, the other ways locked
}

$("parting-show").addEventListener("change", (e) => {
  const p = partingOf();
  if (!p) return;
  p.show = e.target.checked;
  if (!p.show) p.mode = null;
  if (p.show && (thick.colors || thick.highlight)) {
    thick.colors = thick.highlight = false;
    renderThickness();
  }
  applyParting();
  renderParting();
});
// The halves of the mould shown or not (the line and the colours stay); for every part of this page.
$("parting-blocks").addEventListener("change", () => {
  if (partingShown()) applyParting();
});
$("parting-retry").addEventListener("click", () => {
  const p = partingOf();
  if (!p) return;
  p.error = null;
  computePartings(state.result);
  renderParting();
});
$("parting-candidates").addEventListener("click", async (e) => {
  const row = e.target.closest("[data-candidate]");
  const i = partingBody();
  const p = partingOf();
  // Not taken: the radio clicked is not checked (the browser checks it before this runs). Not while drawing by hand.
  if (!row || !p?.results?.[i] || p.busy || p.mode === "draw") {
    e.preventDefault();
    return;
  }
  const k = Number(row.dataset.candidate);
  const direction = p.results[i].proposal.candidates[k].direction;
  // The direction in use: as it is, with its faces reassigned by hand.
  if (sameDirection(direction, partingField(i).direction)) return;
  const r = state.result;
  const seq = ++p.seq;
  try {
    const base = await partingDirection(i, direction);
    if (r === state.result && seq === p.seq) {
      setPartingDefinition(i, { base, source: "candidate", candidate: k });
      return;
    }
  } catch (err) {
    if (!err.cancelled) showError(`${t("parting.title")} : ${tMessage(err.message || String(err))}`);
  }
  // Not applied (failed, or another choice made meanwhile): the radio of the direction in use checked again.
  if (r !== state.result) return;
  htmlShown.delete($("parting-candidates").tBodies[0]);
  renderParting();
});
/** Turn a mode of the 3D view on or off; reassigning faces and drawing by hand show the halves. */
function setPartingMode(mode) {
  const p = partingOf();
  if (!p) return;
  const was = p.mode;
  p.mode = p.mode === mode ? null : mode;
  p.message = null;
  const f = feedingOf();
  if (p.mode && f?.mode) {
    f.mode = null;
    renderFeeding();
  }
  if ((p.mode === "assign" || p.mode === "draw") && !p.show) {
    p.show = true;
    if (thick.colors || thick.highlight) {
      thick.colors = thick.highlight = false;
      renderThickness();
    }
    if (p.mode === "assign") applyParting();
  }
  // Drawing by hand: entered (its plane, its view, its colours), or left (the definition shown as usual).
  if (p.mode === "draw") return enterDrawing();
  renderParting();
  if (was === "draw") applyParting();
}
$("parting-pick").addEventListener("click", () => setPartingMode("pick"));
$("parting-assign").addEventListener("click", () => setPartingMode("assign"));
$("parting-target").addEventListener("change", renderParting);
async function applyTypedDirection() {
  const p = partingOf();
  const i = partingBody();
  if (!p?.results?.[i]) return;
  const d = parseDirection($("parting-vector").value);
  if (!d) {
    p.message = t("parting.vector.invalid");
    renderParting();
    return;
  }
  p.message = null;
  const r = state.result;
  const seq = ++p.seq;
  try {
    const base = await partingDirection(i, d);
    if (r === state.result && seq === p.seq) setPartingDefinition(i, { base, source: "vector" });
  } catch (err) {
    if (!err.cancelled) showError(`${t("parting.title")} : ${tMessage(err.message || String(err))}`);
  }
}
$("parting-apply").addEventListener("click", applyTypedDirection);
$("parting-vector").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyTypedDirection();
});
$("parting-reset").addEventListener("click", () => {
  const i = partingBody();
  if (i >= 0) resetParting(i);
});

// ---- drawing by hand

// The parting line drawn by hand ("Dessin manuel", engine/parting-draw.js).
// A plane is chosen (X, Y, Z, a normal typed, or a face clicked): its normal
// through the centre of the body is the rotation axis, and the draw direction
// of the line drawn (+axis: the upper half). The two arrows of the 3D view
// turn the part about that axis by 1/4 to 1/32 of a turn (the camera turns
// the other way: the model, its overlays and the section stay in their
// frame) without leaving the drawing. Points clicked on the part are joined
// by lines laid on its surface: "droit" at the height of the points round the
// part, "courbe" an arc of a radius typed in, its centre movable. The loop
// closes on point 1 (or "Fermer la boucle", Enter) and the placing stops; the
// parts of the surface it splits go to the chapes by a click on each part
// (never by face), and the definition is applied as any other one: the red
// line, the undercuts, the blocks, the risers placed again. A drawing not
// applied (a draft) and an applied one are kept per part in this browser.

const DRAW_SELECTED = 0xffd23f;
const DRAW_INACTIVE = 0x8a8f96;
const DRAW_FAILED = 0xf08a24;
const DRAW_LINE_PX = 4;
const DRAW_MARKER_PX = 10;
const DRAW_BIG_PX = 14;
const DRAW_PICK_PX = 10; // a point within this many pixels of the pointer: selected, or dragged
const DRAW_CLOSE_PX = 12; // point 1 within this many pixels: the loop closes
const DRAW_MOVE_PX = 4; // a press that moves less is a click
const DRAW_HISTORY = 100;
const DRAW_CACHE = 500;
const DRAW_TILT = (20 * Math.PI) / 180; // the side view: the camera this much above the plane
const TURN_KEY = "reader3d.turnStep";
const TURN_STEPS = [4, 8, 16, 32];
const TURN_MS = 250;
const VIEW_MS = 300;
const HOVER_SLOW_MS = 25; // a hover slower than this: only once the pointer rests
const HOVER_REST_MS = 120;
const DRAFT_MS = 500;
const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const UPPER_TINT = new THREE.Color(PARTING_UPPER);
const LOWER_TINT = new THREE.Color(PARTING_LOWER);

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeInOutCubic = (s) => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);
const vec3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits + 0;

/** The step of a click on an arrow (1/step of a turn), kept in this browser: 4, 8, 16 or 32. */
function loadTurnStep() {
  try {
    const step = Number(localStorage.getItem(TURN_KEY));
    return TURN_STEPS.includes(step) ? step : 4;
  } catch {
    return 4;
  }
}

// The view while drawing: {active (a drawing shown), step, pointer (the last
// position over the view), hoverFrame and hoverTimer (a hover pending), slow
// (hover only after a rest), drag (a point dragged), pressed (a pointer
// button down), draft (its saving pending), labels (the numbers of the
// points: {p, t, el})}.
const drawUi = { active: false, step: loadTurnStep(), pointer: null, hoverFrame: 0, hoverTimer: 0, slow: false, drag: null, pressed: false, draft: null, labels: [] };

// The turn of the view about the axis, from the pose `base` (the camera's
// position, up and target, the key light): k thirty-seconds of a turn of the
// part (the camera turns the other way), `shown` where the animation is (from
// `from` at t0). view: the side view animating ({from, to, t0, d}).
const turn = { base: null, axis: null, centre: null, k: 0, shown: 0, from: 0, t0: 0, running: false, lastPose: null, view: null };

// ---- the drawing

/** The drawing drawn on the 3D view: {p, i, d}, or null. */
function drawActive() {
  const p = partingOf();
  if (p?.mode !== "draw") return null;
  const i = p.drawBody;
  const d = p.draw.get(i);
  return d && !d.dormant && i === partingBody() ? { p, i, d } : null;
}

/** The drawing shown on body i (its colours on the view), or null. */
function drawShown(i) {
  const active = drawActive();
  return active && active.i === i ? active.d : null;
}

/** What the drawing needs of body i (drawMesh: welded vertices, neighbours, normals), built once. */
function drawGeometry(i) {
  const g = partingGeometry(i);
  g.draw ??= drawMesh(g.line, { outward: partingOutward(i) });
  return g.draw;
}

const drawPoints = (d) => (d.dormant ? d.points : d.loops.reduce((n, loop) => n + loop.points.length, 0));
const allClosed = (d) => d.loops.length > 0 && d.loops.every((loop) => loop.closed);
const stageOf = (d) => (allClosed(d) ? "halves" : "points");
const segCount = (loop) => (loop.closed ? loop.points.length : Math.max(0, loop.points.length - 1));
const segName = (d, L, K) => segmentName(d.loops, L, K);
const laidOk = (d) => d.loops.every((loop) => loop.paths.length === segCount(loop) && loop.paths.every((path) => path?.status === "ok"));

/** The loop being drawn (open), or null. */
function openLoop(d) {
  const loop = d.loops[d.current];
  return loop && !loop.closed ? loop : null;
}

/** The number of point k of loop L, counted on from one loop to the next. */
function pointNumber(d, L, k) {
  let n = 0;
  for (let j = 0; j < L; j++) n += d.loops[j].points.length;
  return n + k + 1;
}

/** The components of a direction as typed ("0 0 1", decimal comma in French). */
const axisText = (v) => v.map((x) => fmtNum(Math.abs(x) < 5e-7 ? 0 : x, 3)).join(" ");

/** The plane of a new drawing from a direction: X, Y or Z when along one (its sense kept), else its normal typed. */
function defaultPlane(direction) {
  const axis = snapDirection(direction) ?? [0, 0, 1];
  const k = axis.findIndex((x) => Math.abs(x) === 1);
  return { plane: k >= 0 ? "XYZ"[k] : "vector", axis, vector: axisText(axis) };
}

/**
 * A new drawing on body i, its axis along `direction`: {plane, vector (the
 * normal typed), axis, centre (of the body's box), nt, stage ("axis-face" |
 * "points" | "halves"), sub (null | {kind: "centre", loop, seg}), loops
 * [{points (SurfacePoints), segs (SegSpecs), paths (Paths laid), closed}],
 * current (the loop drawn), seeds [{p, t, side}], swap, target (the chape
 * of the next part clicked), selected ({loop, k}), history and future
 * (snapshots: undo, redo), result (drawnParting of the points as they are),
 * tint (the last one applied: the colours of the halves), base (the
 * classification of the axis), inputs (per segment, a radius or a centre
 * typed in and not applied), messages}.
 */
function newDrawing(i, direction) {
  const { min, max } = state.result.bodies[i].bbox;
  return {
    v: 1,
    ...defaultPlane(direction),
    centre: min.map((v, k) => (v + max[k]) / 2),
    nt: drawGeometry(i).nt,
    stage: "points",
    sub: null,
    prev: null,
    loops: [],
    current: 0,
    seeds: [],
    swap: false,
    target: SIDE_UPPER,
    selected: null,
    hoverSeg: null,
    closeHover: false,
    history: [],
    future: [],
    result: null,
    tint: null,
    shownTint: null,
    base: null,
    baseFor: null,
    basePromise: null,
    inputs: new Map(),
    alignFor: null,
  };
}

/** A drawing read back (reviveDrawing) as one to go on with, its segments not laid yet. */
function drawingFrom(i, revived) {
  const d = newDrawing(i, revived.axis);
  d.plane = revived.plane;
  d.axis = snapDirection(revived.axis) ?? d.axis;
  d.vector = axisText(d.axis);
  d.loops = revived.loops.map((loop) => ({ points: loop.points, segs: loop.segs, paths: loop.segs.map(() => null), closed: loop.closed }));
  d.seeds = revived.seeds;
  d.swap = revived.swap;
  const open = d.loops.findIndex((loop) => !loop.closed);
  d.current = open >= 0 ? open : Math.max(0, d.loops.length - 1);
  d.stage = stageOf(d);
  return d;
}

/** A draft kept (dormant: read, not yet on the mesh) made a drawing to go on with, its segments laid. */
function reviveDormant(i, parsed) {
  const dm = drawGeometry(i);
  const d = drawingFrom(i, reviveDrawing(dm, parsed));
  layAll(dm, d);
  partingOf().draw.set(i, d);
  return d;
}

/** The drafts kept for the part (drawings not applied): taken back, dormant until drawn on. */
function restoreDrafts(p, drafts) {
  for (const [key, json] of Object.entries(drafts ?? {})) {
    const i = Number(key);
    if (!p.results?.[i] || p.draw.has(i)) continue;
    const parsed = parseDrawing(json);
    if (parsed) p.draw.set(i, { dormant: parsed, points: parsed.loops.reduce((n, loop) => n + loop.points.length, 0) });
  }
}

/**
 * The drawn definition kept for body i put back: its points on the mesh as
 * it is now, its segments laid, its halves with its seeds. Not rebuilt (a
 * segment not laid, the loops no longer splitting the part): its direction
 * only, the drawing kept to fix (a draft). True: done.
 */
function restoreDrawing(i, def, base) {
  const p = partingOf();
  const parsed = parseDrawing(def.drawing);
  const fallback = () => {
    setPartingDefinition(i, { base, source: "vector" });
    p.message = parsed ? t("parting.draw.notRestored") : null;
    renderParting();
    return true;
  };
  if (!parsed) return fallback();
  const dm = drawGeometry(i);
  const d = drawingFrom(i, reviveDrawing(dm, parsed));
  d.base = base;
  d.baseFor = d.axis.join(",");
  d.basePromise = Promise.resolve(base);
  layAll(dm, d);
  // A draft kept beside it: the newer drawing, the one to go on with.
  const draft = p.draw.get(i);
  if (!draft) p.draw.set(i, d);
  const result = allClosed(d) && laidOk(d)
    ? drawnParting(dm, engineDrawing(d), { axis: d.axis, flags: base.flags, height: base.summary.mould_height_mm, bodyCentre: d.centre })
    : null;
  if (!result?.ok) {
    if (!draft) saveDraftNow(i);
    return fallback();
  }
  d.result = d.tint = result;
  setPartingDefinition(i, { base, source: "drawn", drawn: { drawing: d, result } });
  return true;
}

/** The drawing as drawnParting takes it (its segments laid). */
function engineDrawing(d) {
  return { loops: d.loops.map(({ points, segs, paths, closed }) => ({ points, segs, paths, closed })), seeds: d.seeds, swap: d.swap };
}

/** What undo and redo go back to: the plane, the axis, the points, the segments, the seeds. */
function drawSnapshot(d) {
  return JSON.stringify({
    plane: d.plane, vector: d.vector, axis: d.axis,
    loops: d.loops.map((loop) => ({ points: loop.points, segs: loop.segs, closed: loop.closed })),
    seeds: d.seeds, swap: d.swap, current: d.current,
  });
}

/** Before a change: the drawing as it was, to undo (100 at most); nothing to redo. */
function pushHistory(d, snapshot = drawSnapshot(d)) {
  d.history.push(snapshot);
  if (d.history.length > DRAW_HISTORY) d.history.shift();
  d.future = [];
}

/** The drawing as a snapshot has it (undo, redo, a drag cancelled): its paths from the cache. */
function restoreSnapshot(i, d, snapshot) {
  const s = JSON.parse(snapshot);
  const axisChanged = !sameDirection(s.axis, d.axis);
  Object.assign(d, { plane: s.plane, vector: s.vector, axis: s.axis, seeds: s.seeds, swap: s.swap, current: s.current });
  d.loops = s.loops.map((loop) => ({ points: loop.points, segs: loop.segs, paths: loop.segs.map(() => null), closed: loop.closed }));
  d.selected = null;
  d.sub = null;
  d.result = null;
  d.inputs.clear();
  d.stage = stageOf(d);
  layAll(drawGeometry(i), d);
  if (axisChanged) {
    finishTurn();
    turn.base = null;
    drawBase(i, d).catch(() => {});
    drawingView(d);
  }
  changed(i, d, { apply: true, recolour: axisChanged });
}

function undoDrawing() {
  const active = drawActive();
  if (!active?.d.history.length || drawUi.drag) return;
  const { p, i, d } = active;
  p.message = null;
  d.future.push(drawSnapshot(d));
  restoreSnapshot(i, d, d.history.pop());
}

function redoDrawing() {
  const active = drawActive();
  if (!active?.d.future.length || drawUi.drag) return;
  const { p, i, d } = active;
  p.message = null;
  d.history.push(drawSnapshot(d));
  restoreSnapshot(i, d, d.future.pop());
}

// ---- segments

const vecKey = (v) => (v ? v.join(",") : "");

/** What a path laid depends on: its ends, its spec, the axis. */
function layKey(A, B, spec, axis) {
  const s = spec.kind === "arc" ? `a${spec.radius}|${vecKey(spec.toward)}` : `s${spec.via}|${vecKey(spec.m)}|${spec.method ?? ""}`;
  return `${vecKey(A.p)}|${A.t}|${vecKey(B.p)}|${B.t}|${s}|${vecKey(axis)}`;
}

/** A path kept for the body (the latest 500): undo and redo lay nothing again. */
function cachePath(dm, key, path) {
  dm.paths ??= new Map();
  dm.paths.delete(key);
  dm.paths.set(key, path);
  if (dm.paths.size > DRAW_CACHE) dm.paths.delete(dm.paths.keys().next().value);
}

/**
 * Segment K of loop L laid on the surface (from the cache when it was laid
 * already): an arc, or a straight line whose plane and sense found are kept
 * in its spec, so that it is laid again the same whatever the view.
 */
function laySegment(dm, d, L, K) {
  const loop = d.loops[L];
  const n = loop.points.length;
  const A = loop.points[K], B = loop.points[(K + 1) % n];
  const spec = loop.segs[K];
  const key = layKey(A, B, spec, d.axis);
  let path = dm.paths?.get(key);
  if (!path) {
    path = spec.kind === "arc" ? layArc(dm, A, B, spec) : layStraight(dm, A, B, { axis: d.axis, prefer: camera.position.toArray(), spec });
  }
  cachePath(dm, key, path);
  if (spec.kind !== "arc" && path.status === "ok") {
    if (path.method === "edges") {
      spec.method = "edges";
      spec.m = null;
    } else {
      delete spec.method;
      spec.via = path.via === -1 ? -1 : 1;
      spec.m = path.m;
    }
    cachePath(dm, layKey(A, B, spec, d.axis), path);
  }
  loop.paths[K] = path;
  return path;
}

/** Every segment not laid yet, laid. */
function layAll(dm, d) {
  d.loops.forEach((loop, L) => {
    loop.paths.length = segCount(loop);
    for (let K = 0; K < loop.paths.length; K++) if (!loop.paths[K]) laySegment(dm, d, L, K);
  });
}

const straightSpec = () => ({ kind: "straight", via: 1, m: null });

/** A segment whose ends moved: a straight one finds its plane again; an arc keeps its radius and side (straight when the radius is now too small). */
function respec(d, L, K) {
  const loop = d.loops[L];
  const spec = loop.segs[K];
  loop.paths[K] = null;
  if (spec.kind !== "arc") {
    loop.segs[K] = straightSpec();
    return null;
  }
  const A = loop.points[K], B = loop.points[(K + 1) % loop.points.length];
  if (dist3(A.p, B.p) / 2 > spec.radius * (1 + 1e-9)) {
    loop.segs[K] = straightSpec();
    return t("parting.draw.toStraight", { seg: segName(d, L, K) });
  }
  return null;
}

/** The segments of loop L ending or starting at point k. */
function segmentsAt(loop, k) {
  const n = loop.points.length;
  const out = [];
  if (loop.closed) out.push((k - 1 + n) % n, k);
  else {
    if (k > 0) out.push(k - 1);
    if (k < n - 1) out.push(k);
  }
  return [...new Set(out)].filter((K) => K >= 0 && K < segCount(loop));
}

/** The message of a segment not laid. */
function segmentError(d, L, K, path) {
  const loop = d.loops[L];
  const name = segName(d, L, K);
  if (path.error === "radius_too_small") {
    const chord = dist3(loop.points[K].p, loop.points[(K + 1) % loop.points.length].p);
    return t("parting.draw.radiusSmall", { min: fmtNum(chord / 2, 2), seg: name, chord: fmtNum(chord, 2) });
  }
  return t(path.error === "arc_off_surface" ? "parting.draw.arcOff" : "parting.draw.failed", { seg: name });
}

/**
 * Whether a segment is on the parting line: one of its pieces (along the
 * edges: most of its length) between parts given to different chapes (or a
 * part not known), as drawnParting tells its pieces apart.
 */
function segmentActive(result, L, K) {
  const path = result.paths[L]?.[K];
  const pr = result.split.pieceRegions[L]?.[K];
  if (!path || !pr) return true; // not in that result (a segment added since)
  const side = result.regionSide;
  const x = path.xyz;
  let apart = 0, together = 0, unknown = false, any = false;
  for (let j = 0; j < path.tri.length; j++) {
    const len = Math.hypot(x[3 * j + 3] - x[3 * j], x[3 * j + 4] - x[3 * j + 1], x[3 * j + 5] - x[3 * j + 2]);
    if (!len) continue;
    const r1 = pr[2 * j], r2 = pr[2 * j + 1];
    if (r1 < 0 || r2 < 0) unknown = true;
    else if (side[r1] !== side[r2]) {
      apart += len;
      any = true;
    } else together += len;
  }
  return path.method === "edges" ? unknown || (apart + together > 0 && apart >= together) : unknown || any;
}

// ---- applying

/** The classification of the drawing's axis (in the worker; the proposal's at once): its flags, its height, once per axis. */
function drawBase(i, d) {
  const key = d.axis.join(",");
  if (d.baseFor !== key) {
    const r = state.result;
    d.baseFor = key;
    d.base = null;
    d.basePromise = partingDirection(i, d.axis).then((base) => {
      if (d.baseFor === key) {
        d.base = base;
        // The core zones of that axis in yellow (one colouring).
        if (r === state.result && drawShown(i) === d) applyParting();
      }
      return base;
    });
    d.basePromise.catch((err) => {
      if (d.baseFor === key) d.baseFor = null;
      if (!err.cancelled) showError(`${t("parting.title")} : ${tMessage(err.message || String(err))}`);
    });
  }
  return d.basePromise;
}

/**
 * The drawing applied once every loop is closed and every segment laid: its
 * halves (drawnParting), then the definition of the body (red line, yellow
 * undercuts, blocks, risers placed again). The loops not splitting the part:
 * said, nothing applied (the definition before stays).
 */
async function applyDrawing(i, d) {
  const r = state.result;
  const p = partingOf(r);
  if (!allClosed(d)) return;
  if (!laidOk(d)) {
    d.result = null;
    renderParting();
    return;
  }
  const seq = ++p.seq;
  let base;
  try {
    base = await drawBase(i, d);
  } catch {
    return;
  }
  if (r !== state.result || seq !== p.seq || p.draw.get(i) !== d || !allClosed(d) || !laidOk(d)) return;
  const result = drawnParting(drawGeometry(i), engineDrawing(d), {
    axis: d.axis, flags: base.flags, height: base.summary.mould_height_mm, bodyCentre: d.centre, prefer: camera.position.toArray(),
  });
  d.result = result;
  if (!result.ok) {
    d.tint = null;
    if (d.shownTint) applyParting();
    else applyDrawOverlay();
    renderParting();
    return;
  }
  d.tint = result;
  setPartingDefinition(i, { base, source: "drawn", drawn: { drawing: d, result } });
  saveDraftNow(i); // applied as it is: no draft (at once: a reload right after finds none)
}

/**
 * The definition of body i drawn by hand: {field (p.current), def (kept in
 * this browser)}. Its side has the undercuts as SIDE_NONE, as the other
 * definitions have them: the ingate is placed away from them.
 */
function drawnDefinition(i, base, { drawing: d, result }) {
  const saved = serializeDrawing(d, d.nt);
  const info = drawnInfo(d, result);
  return {
    field: {
      manual: true, source: "drawn", overrides: {}, candidate: null, base, direction: base.direction,
      summary: { ...base.summary, undercut_area_mm2: result.figures.undercut_area_mm2, undercut_share: result.figures.undercut_share, parting: lineSummary(result.shape) },
      side: result.side.map((s, f) => (result.undercut[f] ? SIDE_NONE : s)),
      flags: base.flags, plane: null, segments: result.segments, fixed: null, undercut: result.undercut,
      drawing: saved, drawn: info, drawSnap: drawSnapshot(d),
    },
    def: { direction: base.direction, source: "drawn", candidate: null, overrides: {}, faces: null, drawing: saved },
  };
}

/** The drawing as the exports give it: its loops, points, axis, segments (each on the parting line or not) and parts. */
function drawnInfo(d, result) {
  const segments = [];
  d.loops.forEach((loop, L) => loop.paths.forEach((path, K) => {
    const spec = loop.segs[K];
    const arc = spec.kind === "arc" ? arcGeometry(loop.points[K].p, loop.points[(K + 1) % loop.points.length].p, spec) : null;
    segments.push({
      name: segName(d, L, K),
      type: arc ? "curved" : "straight",
      method: path.method,
      length_mm: round(path.length, 1),
      ...(arc && !arc.error ? { radius_mm: round(arc.radius, 2), centre_mm: arc.centre.map((x) => round(x, 2)) } : {}),
      on_parting_line: segmentActive(result, L, K),
    });
  }));
  const f = result.figures;
  return {
    loops: d.loops.length,
    points: drawPoints(d),
    rotation_axis: d.axis.map((x) => round(x, 6)),
    segments,
    parts: f.parts,
    upper_parts: f.upper_parts,
    lower_parts: f.lower_parts,
    seam_area_mm2: f.seam_area_mm2,
    core_excluded: f.core_excluded,
  };
}

/** The row "Dessin manuel" of the card. */
function drawnStats(info) {
  return t("parting.draw.stats.value", {
    points: info.points, segments: info.segments.length, arcs: info.segments.filter((s) => s.type === "curved").length, loops: info.loops, parts: info.parts,
  });
}

/** The drawing of body i not the one applied (changed since, or never applied). */
function drawEdited(p, i) {
  const d = p.draw.get(i);
  if (!d || !drawPoints(d)) return false;
  const cur = p.current.get(i);
  return d.dormant || cur?.source !== "drawn" || cur.drawSnap !== drawSnapshot(d);
}

/** The origin of a drawn definition: "dessin manuel", or "(modification en cours)" while its drawing differs. */
const drawnOrigin = (p, i) => (drawEdited(p, i) ? "parting.drawn.editing" : "parting.drawn");

/** After a change of the drawing: its overlay (its colours when they change), the card, its draft; applied again when asked and closed. */
function changed(i, d, { apply = false, recolour = false } = {}) {
  const tint = d.stage === "halves" ? d.tint : null;
  if (recolour || tint !== d.shownTint) applyParting();
  else applyDrawOverlay();
  renderParting();
  scheduleDraft(i);
  if (apply && allClosed(d)) applyDrawing(i, d);
}

// ---- kept in this browser

/** The drawing of body i kept as a draft in a while (or forgotten: applied as it is, or cleared). */
function scheduleDraft(i) {
  const r = state.result;
  const partId = partIdOf(r);
  if (!partId) return;
  const key = `${partId}|${i}`;
  if (drawUi.draft?.key !== key) flushDraft(); // another body's, saved first
  if (drawUi.draft) clearTimeout(drawUi.draft.timer);
  const write = () => {
    drawUi.draft = null;
    writeDraft(r, partId, i);
  };
  drawUi.draft = { key, timer: setTimeout(write, DRAFT_MS), write };
}

/** The draft pending saved now. */
function flushDraft() {
  const pending = drawUi.draft;
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.write();
}

/** The draft of body i saved now (or forgotten). */
function saveDraftNow(i) {
  scheduleDraft(i);
  flushDraft();
}

// The page left (reloaded, closed): the draft pending saved first.
window.addEventListener("pagehide", flushDraft);

/** Body i's definition replaced by another one (a candidate, a face, a direction, the proposal): its drawing by hand kept as a draft. */
function keepDrawing(i) {
  const d = partingOf()?.draw.get(i);
  if (d && !d.dormant && drawPoints(d)) saveDraftNow(i);
}

function writeDraft(r, partId, i) {
  const p = partingOf(r);
  const d = p.draw.get(i);
  if (d?.dormant) return; // kept as it was read
  const keep = d && drawPoints(d) > 0 && drawEdited(p, i);
  savePartingDef(partId, i, keep ? serializeDrawing(d, d.nt) : null, { draft: true });
}

// ---- entering, leaving

/** Drawing by hand on the card's body: its drawing taken back (else a new one, along the direction shown), the side view. */
function enterDrawing() {
  const p = partingOf();
  const i = partingBody();
  const field = i >= 0 ? partingField(i) : null;
  if (!field) {
    p.mode = null;
    return renderParting();
  }
  let d = p.draw.get(i);
  if (d?.dormant) d = reviveDormant(i, d.dormant);
  if (!d) {
    d = newDrawing(i, field.direction);
    p.draw.set(i, d);
  }
  p.drawBody = i;
  d.sub = null;
  d.prev = null;
  d.closeHover = false;
  d.stage = stageOf(d);
  drawBase(i, d).catch(() => {});
  renderParting(); // the view's controls on
  drawingView(d);
  applyParting();
  resumeHalves(i, d);
}

/**
 * A closed drawing taken back without its halves (a draft, a drawing not
 * restored): its halves once its axis is classified, shown (or why there
 * are none), not applied: the definition stays until the drawing changes.
 */
function resumeHalves(i, d) {
  if (d.result || !allClosed(d) || !laidOk(d)) return;
  const r = state.result;
  const key = d.axis.join(",");
  drawBase(i, d).then((base) => {
    if (r !== state.result || drawShown(i) !== d || d.result || d.axis.join(",") !== key || !allClosed(d) || !laidOk(d)) return;
    d.result = drawnParting(drawGeometry(i), engineDrawing(d), { axis: d.axis, flags: base.flags, height: base.summary.mould_height_mm, bodyCentre: d.centre });
    d.tint = d.result.ok ? d.result : null;
    applyParting();
    renderParting();
  }).catch(() => {});
}

/** Drawing by hand left ("Terminer", Esc, the toggle, another mode): the drawing kept, the definition shown as usual. */
function leaveDrawing() {
  const p = partingOf();
  if (p?.mode !== "draw") return;
  p.mode = null;
  p.message = null;
  renderParting(); // the view as before (syncDrawView)
  applyParting();
}

/**
 * The view's side of the drawing, from renderParting: the drawing left when
 * its body is no longer the card's (another one selected, unchecked) or not
 * shown; while drawing, the view turns without inertia (precise); left: its
 * turn ended, its overlay and its controls gone, its draft saved.
 */
function syncDrawView(p, i) {
  if (p?.mode === "draw" && (i < 0 || i !== p.drawBody || !p.show || !partingField(i))) {
    p.mode = null;
    p.message = null;
  }
  const active = drawActive();
  if (!!active === drawUi.active) return;
  drawUi.active = !!active;
  if (active) {
    controls.staticMoving = true;
    stopInertia();
    return;
  }
  endDrag(null, false);
  finishTurn();
  turn.base = null;
  controls.staticMoving = false;
  stopInertia();
  hideHover();
  for (const mesh of state.meshes) removeDrawOverlay(mesh);
  $("draw-labels").replaceChildren();
  drawUi.labels = [];
  $("draw-overlay").hidden = true;
  delete viewport.dataset.turn;
  delete viewport.dataset.turning;
  flushDraft();
}

// ---- the axis

/** The plane chosen in the list: X, Y, Z (the axis at once), "vector" (typed, then Apply), "face" (a face clicked next). */
function drawPlaneChosen(plane) {
  const active = drawActive();
  if (!active) return;
  const { p, i, d } = active;
  p.message = null;
  if (plane === "face") {
    d.prev = { plane: d.plane };
    d.plane = "face";
    d.stage = "axis-face";
    finishTurn();
    hideHover();
    renderParting();
    return;
  }
  if (plane === "vector") {
    d.plane = "vector";
    d.vector ||= axisText(d.axis);
    if (d.stage === "axis-face") d.stage = stageOf(d);
    renderParting();
    $("parting-draw-vector").focus();
    return;
  }
  const k = "XYZ".indexOf(plane);
  if (k < 0) return;
  // Its sense: that of the direction shown when along the same axis, else +.
  const along = [d.axis, partingField(i)?.direction].find((v) => v && Math.abs(v[k]) === 1);
  const sign = along ? Math.sign(along[k]) : 1;
  changeAxis(i, d, AXES[plane].map((x) => x * sign + 0), { plane });
}

/** The normal typed for "Manuel", applied. */
function applyDrawVector() {
  const active = drawActive();
  if (!active) return;
  const { p, i, d } = active;
  const text = $("parting-draw-vector").value;
  const v = parseDirection(text);
  if (!v) {
    p.message = t("parting.vector.invalid");
    return renderParting();
  }
  p.message = null;
  changeAxis(i, d, v, { plane: "vector", vector: text });
}

/**
 * Another rotation axis (the draw direction): the points stay, every segment
 * laid again in planes found anew, the side view along it, the turn from
 * there; its classification asked for, the halves proposed again once it
 * comes (the parts chosen along the axis before forgotten: undone with it).
 */
function changeAxis(i, d, axis, { plane = d.plane, vector = null } = {}) {
  const same = d.axis && sameDirection(axis, d.axis);
  if (same) {
    d.plane = plane;
    if (vector != null) d.vector = vector;
    d.stage = stageOf(d);
    d.prev = null;
    renderParting();
    return applyDrawOverlay();
  }
  pushHistory(d);
  // The chapes chosen per part were along the axis before (upper: towards +axis): proposed again along this one.
  d.seeds = [];
  d.swap = false;
  d.target = SIDE_UPPER;
  d.plane = plane;
  d.vector = vector ?? axisText(axis);
  d.axis = axis;
  d.prev = null;
  d.stage = stageOf(d);
  for (const loop of d.loops) {
    loop.segs = loop.segs.map((s) => (s.kind === "arc" ? { ...s, straight: null } : straightSpec()));
    loop.paths = loop.paths.map(() => null);
  }
  d.result = null;
  d.inputs.clear();
  layAll(drawGeometry(i), d);
  finishTurn();
  turn.base = null;
  drawBase(i, d).catch(() => {});
  drawingView(d);
  changed(i, d, { apply: true, recolour: true });
}

// ---- points

/** A point clicked on the part (hit: its triangle and its point), joined to the one before by a straight line laid on the surface. */
function addPoint(i, d, hit, at) {
  const p = partingOf();
  const dm = drawGeometry(i);
  const before = drawSnapshot(d);
  if (drawPoints(d) >= MAX_POINTS) {
    p.message = t("parting.draw.maxPoints", { max: MAX_POINTS });
    return renderParting();
  }
  if (!openLoop(d)) {
    const open = d.loops.findIndex((loop) => !loop.closed);
    if (open >= 0) d.current = open;
    else if (d.loops.length >= MAX_LOOPS) {
      p.message = t("parting.draw.maxLoops");
      return renderParting();
    } else {
      d.loops.push({ points: [], segs: [], paths: [], closed: false });
      d.current = d.loops.length - 1;
    }
  }
  const loop = openLoop(d);
  const sp = surfacePoint(dm, hit.faceIndex, hit.point.toArray());
  const prev = loop.points.at(-1);
  if (prev) {
    const s = at ? screenOf(prev.p) : null;
    if (dist3(prev.p, sp.p) <= Math.max(1e-4 * dm.diag, 0.2) || (s && Math.hypot(s.x - at.x, s.y - at.y) <= DRAW_MOVE_PX)) {
      p.message = t("parting.draw.same");
      return renderParting();
    }
  }
  pushHistory(d, before);
  loop.points.push(sp);
  d.selected = null;
  d.result = null;
  d.stage = "points";
  if (loop.points.length > 1) {
    loop.segs.push(straightSpec());
    loop.paths.push(null);
    const K = loop.points.length - 2;
    const path = laySegment(dm, d, d.current, K);
    if (path.status !== "ok") p.message = segmentError(d, d.current, K, path);
    else if (path.method === "edges") p.message = t("parting.draw.edges.msg", { seg: segName(d, d.current, K) });
  }
  changed(i, d);
}

/** The loop drawn closed (its last point joined to point 1): placing stops; every loop closed, the halves proposed and applied. */
function closeLoop(i, d) {
  const p = partingOf();
  const loop = openLoop(d);
  if (!loop) return;
  if (loop.points.length < 3) {
    p.message = t("parting.draw.min3");
    return renderParting();
  }
  pushHistory(d);
  loop.segs.push(straightSpec());
  loop.paths.push(null);
  loop.closed = true;
  d.result = null;
  const K = loop.points.length - 1;
  const path = laySegment(drawGeometry(i), d, d.current, K);
  p.message = path.status !== "ok" ? segmentError(d, d.current, K, path) : null;
  d.closeHover = false;
  d.selected = null;
  hideHover();
  if (allClosed(d)) {
    d.stage = "halves";
    d.target = SIDE_UPPER;
  }
  changed(i, d, { apply: true });
}

/** Another loop (a bore through the parting plane needs its own), once every loop is closed. */
function newLoop() {
  const active = drawActive();
  if (!active || !allClosed(active.d)) return;
  const { p, i, d } = active;
  if (d.loops.length >= MAX_LOOPS) {
    p.message = t("parting.draw.maxLoops");
    return renderParting();
  }
  p.message = null;
  pushHistory(d);
  d.loops.push({ points: [], segs: [], paths: [], closed: false });
  d.current = d.loops.length - 1;
  d.stage = "points";
  d.selected = null;
  d.result = null; // that of the loops before: applied again once this one is closed
  changed(i, d);
}

/** Point k of loop L deleted: its two segments made one straight one; a closed loop of fewer than 3 points opened again, an empty one gone. */
function deletePoint(i, d, { loop: L, k }) {
  const loop = d.loops[L];
  if (!loop?.points[k]) return;
  pushHistory(d);
  const n = loop.points.length;
  loop.points.splice(k, 1);
  if (loop.closed) {
    loop.segs.splice(k, 1);
    loop.paths.splice(k, 1);
    const K = (k - 1 + n - 1) % (n - 1); // the segment now joining the points on either side
    if (n - 1 > 0) {
      loop.segs[K] = straightSpec();
      loop.paths[K] = null;
    }
    if (loop.points.length < 3) {
      loop.closed = false;
      loop.segs = Array.from({ length: Math.max(0, loop.points.length - 1) }, straightSpec);
      loop.paths = loop.segs.map(() => null);
      d.current = L;
    }
  } else if (n > 1) {
    const K = k === n - 1 ? k - 1 : k;
    loop.segs.splice(K, 1);
    loop.paths.splice(K, 1);
    if (k > 0 && k < n - 1) {
      loop.segs[k - 1] = straightSpec();
      loop.paths[k - 1] = null;
    }
  }
  if (!loop.points.length) {
    d.loops.splice(L, 1);
    d.current = Math.max(0, Math.min(d.current, d.loops.length - 1));
    const open = d.loops.findIndex((x) => !x.closed);
    if (open >= 0) d.current = open;
  }
  d.selected = null;
  d.sub = null;
  d.result = null;
  d.inputs.clear();
  d.stage = stageOf(d);
  layAll(drawGeometry(i), d);
  changed(i, d, { apply: true });
}

/** A point added in the middle of segment K of loop L (by length): two straight lines, or two arcs about the same centre. */
function splitSegment(i, d, L, K) {
  const loop = d.loops[L];
  const path = loop.paths[K];
  if (!path || path.status !== "ok") return;
  if (drawPoints(d) >= MAX_POINTS) {
    partingOf().message = t("parting.draw.maxPoints", { max: MAX_POINTS });
    return renderParting();
  }
  const dm = drawGeometry(i);
  // The point at half its length, on the triangle of that piece.
  const x = path.xyz;
  let walked = 0, mid = null;
  for (let j = 0; j < path.tri.length && !mid; j++) {
    const a = [x[3 * j], x[3 * j + 1], x[3 * j + 2]], b = [x[3 * j + 3], x[3 * j + 4], x[3 * j + 5]];
    const len = dist3(a, b);
    if (len > 0 && walked + len >= path.length / 2) {
      const s = (path.length / 2 - walked) / len;
      mid = surfacePoint(dm, path.tri[j], a.map((v, k) => v + (b[k] - v) * s));
    }
    walked += len;
  }
  if (!mid) return;
  pushHistory(d);
  const spec = loop.segs[K];
  const A = loop.points[K], B = loop.points[(K + 1) % loop.points.length];
  let first = straightSpec(), second = straightSpec();
  if (spec.kind === "arc") {
    const geo = arcGeometry(A.p, B.p, spec);
    const c1 = geo.error ? null : arcFromCentre(A.p, mid.p, geo.centre, spec.toward);
    const c2 = geo.error ? null : arcFromCentre(mid.p, B.p, geo.centre, spec.toward);
    if (c1 && !c1.error) first = { kind: "arc", radius: c1.radius, toward: c1.toward, straight: null };
    if (c2 && !c2.error) second = { kind: "arc", radius: c2.radius, toward: c2.toward, straight: null };
  }
  loop.points.splice(K + 1, 0, mid);
  loop.segs.splice(K, 1, first, second);
  loop.paths.splice(K, 1, null, null);
  d.selected = null;
  d.sub = null;
  d.result = null;
  d.inputs.clear();
  layAll(dm, d);
  changed(i, d, { apply: true });
}

/** The points of loop L moved to height h along the axis (alignPoints): its straight segments laid again, level all round. */
function alignLoop(i, d, L, h) {
  const p = partingOf();
  const loop = d.loops[L];
  if (!loop) return;
  const dm = drawGeometry(i);
  const { points, missed } = alignPoints(dm, loop.points, d.axis, h);
  pushHistory(d);
  loop.points = points;
  loop.segs = loop.segs.map((s) => (s.kind === "arc" ? s : straightSpec()));
  loop.paths = loop.paths.map(() => null);
  d.result = null;
  d.inputs.clear();
  layAll(dm, d);
  p.message = missed.length ? t("parting.draw.alignMissed", { list: missed.map((k) => pointNumber(d, L, k)).join(", ") }) : null;
  changed(i, d, { apply: true });
}

/**
 * The loop whose points could be aligned to one height: closed, its points
 * within a few millimetres of each other along the axis (at most 5 % of
 * the mould height, 2 mm) but not at one height already: {L, median}.
 */
function alignCandidate(d) {
  const height = d.base?.summary.mould_height_mm ?? 0;
  const limit = Math.max(0.05 * height, 2);
  for (let L = 0; L < d.loops.length; L++) {
    const loop = d.loops[L];
    if (!loop.closed) continue;
    const h = loop.points.map((sp) => dot3(sp.p, d.axis)).sort((a, b) => a - b);
    const span = h.at(-1) - h[0];
    if (span > 1e-3 && span <= limit) return { L, median: h[h.length >> 1] };
  }
  return null;
}

/** How a height along the axis is shown: the coordinate of the frame along an axis of it (X, -Z…: its sign), else along the axis. */
function heightFrame(axis) {
  const k = axis.findIndex((x) => Math.abs(x) === 1);
  return k >= 0 ? { name: "XYZ"[k], sign: axis[k] } : { name: axisLabel(axis), sign: 1 };
}

// ---- the halves

/** A part of the part clicked: given to the chape chosen (Partie supérieure / inférieure); a core can be given to neither. */
function seedPart(i, d, hit) {
  const p = partingOf();
  const label = d.result?.ok ? d.result.split.label[hit.faceIndex] : null;
  if (label === -1) {
    p.message = t("parting.draw.core");
    return renderParting();
  }
  pushHistory(d);
  d.seeds.push({ p: hit.point.toArray(), t: hit.faceIndex, side: d.target });
  changed(i, d, { apply: true });
}

/** "Inverser les chapes": the proposal swapped, and every part chosen given to the other chape. */
function swapHalves() {
  const active = drawActive();
  if (!active) return;
  const { p, i, d } = active;
  p.message = null;
  pushHistory(d);
  d.swap = !d.swap;
  d.seeds = d.seeds.map((s) => ({ ...s, side: s.side === SIDE_UPPER ? SIDE_LOWER : SIDE_UPPER }));
  changed(i, d, { apply: true });
}

/** "Effacer le tracé": the drawing and its draft gone (once confirmed when a loop is closed), the proposal back if it was applied. */
function clearDrawing() {
  const active = drawActive();
  if (!active) return;
  const { p, i, d } = active;
  if (d.loops.some((loop) => loop.closed) && !confirm(t("parting.draw.clear.confirm", { points: drawPoints(d) }))) return;
  const fresh = newDrawing(i, d.axis);
  Object.assign(fresh, { plane: d.plane, vector: d.vector, base: d.base, baseFor: d.baseFor, basePromise: d.basePromise });
  p.draw.set(i, fresh);
  p.message = null;
  hideHover();
  saveDraftNow(i); // the draft gone
  if (p.current.get(i)?.source === "drawn") {
    p.seq++; // a drawing being applied is not
    p.current.delete(i);
    savePartingDef(partIdOf(state.result), i, null);
    refreshFeeding();
  }
  applyParting();
  renderParting();
}

// ---- segments edited in the table

/** A segment turned "droit" or "courbe": an arc of the default radius (the chord: 60°) in the plane of its line; back to its straight line. */
function setSegmentType(i, d, L, K, type) {
  const loop = d.loops[L];
  const spec = loop?.segs[K];
  if (!spec || (type === "arc") === (spec.kind === "arc")) return;
  pushHistory(d);
  const A = loop.points[K], B = loop.points[(K + 1) % loop.points.length];
  if (type === "arc") {
    const m = spec.m ?? segmentPlane(drawGeometry(i), A, B, d.axis);
    const arc = arcDefault(A, B, m, d.axis, d.centre);
    loop.segs[K] = { kind: "arc", radius: arc.radius, toward: arc.toward, straight: { via: spec.via, m: spec.m, method: spec.method } };
  } else {
    const back = spec.straight ?? {};
    loop.segs[K] = { kind: "straight", via: back.via === -1 ? -1 : 1, m: back.m ?? null, ...(back.method ? { method: back.method } : {}) };
  }
  loop.paths[K] = null;
  d.inputs.delete(`${L}:${K}`);
  d.sub = null;
  d.result = null;
  layAll(drawGeometry(i), d);
  changed(i, d, { apply: true });
}

/** The radius typed for an arc: at least half the chord (else not applied, said), at most 1 km; its side kept. */
function setSegmentRadius(i, d, L, K, text) {
  const loop = d.loops[L];
  const spec = loop?.segs[K];
  if (spec?.kind !== "arc") return;
  const key = `${L}:${K}`;
  const R = Number(String(text).trim().replace(",", "."));
  const A = loop.points[K], B = loop.points[(K + 1) % loop.points.length];
  const chord = dist3(A.p, B.p);
  if (!Number.isFinite(R) || R < (chord / 2) * (1 - 1e-9)) {
    d.inputs.set(key, { radius: text, error: t("parting.draw.radiusSmall", { min: fmtNum(chord / 2, 2), seg: segName(d, L, K), chord: fmtNum(chord, 2) }) });
    return renderParting();
  }
  pushHistory(d);
  loop.segs[K] = { ...spec, radius: Math.min(R, 1e6) };
  loop.paths[K] = null;
  d.inputs.delete(key);
  d.result = null;
  layAll(drawGeometry(i), d);
  changed(i, d, { apply: true });
}

/** The centre of an arc typed or clicked: brought onto the bisector plane of its chord (its plane turning about the chord to it). */
function setSegmentCentre(i, d, L, K, centre, text = null) {
  const p = partingOf();
  const loop = d.loops[L];
  const spec = loop?.segs[K];
  if (spec?.kind !== "arc") return;
  const key = `${L}:${K}`;
  const A = loop.points[K], B = loop.points[(K + 1) % loop.points.length];
  const arc = centre ? arcFromCentre(A.p, B.p, centre, spec.toward) : { error: "centre_invalid" };
  if (arc.error) {
    d.inputs.set(key, { centre: text ?? "", error: t("parting.draw.centreInvalid", { seg: segName(d, L, K) }) });
    return renderParting();
  }
  pushHistory(d);
  loop.segs[K] = { ...spec, radius: Math.min(arc.radius, 1e6), toward: arc.toward };
  loop.paths[K] = null;
  d.inputs.delete(key);
  d.result = null;
  layAll(drawGeometry(i), d);
  p.message = arc.moved ? t("parting.draw.centreMoved", { seg: segName(d, L, K) }) : null;
  changed(i, d, { apply: true });
}

/** '⇄' (a straight line round the other side of the part) or '⇅' (an arc's centre on the other side). */
function flipSegment(i, d, L, K) {
  const loop = d.loops[L];
  const spec = loop.segs[K];
  if (!spec) return;
  if (spec.kind !== "arc" && !spec.m) return;
  pushHistory(d);
  loop.segs[K] = spec.kind === "arc" ? { ...spec, toward: spec.toward.map((x) => -x + 0) } : { ...spec, via: spec.via === -1 ? 1 : -1 };
  loop.paths[K] = null;
  d.result = null;
  layAll(drawGeometry(i), d);
  changed(i, d, { apply: true });
}

// ---- clicks on the 3D view

/** The bodies under a point of the page (client pixels), the cut-away side of the section left out. */
function raycastAt(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObjects(state.meshes.filter((m) => m.visible), false).filter((h) => !sectionOn || sectionPlane.distanceToPoint(h.point) >= 0);
}

/** Where a point of the model is on the page ({x, y} client pixels), or null behind the camera. */
function screenOf(point) {
  if (!Array.isArray(point) || point.length < 3) return null;
  camera.updateMatrixWorld();
  const v = vec3(point);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  if (v.clone().sub(camera.position).dot(forward) <= 0) return null;
  v.project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
}

/** Millimetres per pixel of the view at the depth of a point. */
function pixelSize(point) {
  const depth = vec3(point).sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
  return (2 * Math.max(depth, 0) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(viewport.clientHeight, 1);
}

/** A point of the drawing not hidden by the part: nothing of the card's body under the pointer, or not further than it (a marker's width). */
function pointSeen(dm, point, hit) {
  if (!hit) return true;
  const tol = Math.max(2 * DRAW_MARKER_PX * pixelSize(point), 0.01 * dm.diag);
  return camera.position.distanceTo(vec3(point)) <= hit.distance + tol;
}

/**
 * A click (or the pointer) closing the loop: point 1 within 12 px of it and
 * not hidden by the part (point 1 behind the part never takes a click on
 * the front), or the point of the part under it within a marker's width of
 * point 1.
 */
function nearFirst(i, loop, hits, at) {
  if (!loop || loop.closed || loop.points.length < 3 || !at) return false;
  const dm = drawGeometry(i);
  const first = loop.points[0].p;
  const hit = cardHit(hits, i);
  const tol = Math.max(2 * DRAW_MARKER_PX * pixelSize(first), 0.01 * dm.diag);
  const s = screenOf(first);
  if (s && Math.hypot(s.x - at.x, s.y - at.y) <= DRAW_CLOSE_PX && pointSeen(dm, first, hit)) return true;
  return !!hit && hit.point.distanceTo(vec3(first)) <= tol;
}

/** The point of the drawing under the pointer (within 10 px, seen): {loop, k}, or null. */
function markerAt(i, d, at, hits) {
  if (!at) return null;
  const dm = drawGeometry(i);
  const hit = cardHit(hits, i);
  let best = null, bestDistance = DRAW_PICK_PX;
  d.loops.forEach((loop, L) => loop.points.forEach((sp, k) => {
    const s = screenOf(sp.p);
    if (!s) return;
    const off = Math.hypot(s.x - at.x, s.y - at.y);
    if (off <= bestDistance && pointSeen(dm, sp.p, hit)) {
      best = { loop: L, k };
      bestDistance = off;
    }
  }));
  return best;
}

/**
 * A click on the 3D view while drawing (handled here: true). Choosing the
 * axis by a face; placing an arc's centre; placing points (point 1 closes
 * the loop, a point clicked is selected, else a point is added); the halves
 * (a part given to the chape chosen).
 */
function drawClick({ p, i, d }, hits, at) {
  p.message = null;
  const hit = cardHit(hits, i);
  // Another body under the pointer, not faded: to select first. Nothing there: the point selected no longer.
  const elsewhere = () => {
    if (hits.length) p.message = t("parting.otherBody");
    else if (d.selected) {
      d.selected = null;
      changed(i, d);
      return true;
    }
    renderParting();
    return true;
  };
  if (d.stage === "axis-face") {
    if (!hit) return elsewhere();
    const n = snapDirection(faceNormal(i, hit.faceIndex));
    if (n) changeAxis(i, d, n, { plane: "face" });
    return true;
  }
  if (d.sub?.kind === "centre") {
    const { loop, seg } = d.sub;
    if (!hit) return elsewhere();
    d.sub = null;
    setSegmentCentre(i, d, loop, seg, hit.point.toArray());
    return true;
  }
  if (d.stage === "points" && nearFirst(i, openLoop(d), hits, at)) {
    closeLoop(i, d);
    return true;
  }
  const marker = markerAt(i, d, at, hits);
  if (marker) {
    d.selected = marker;
    changed(i, d);
    return true;
  }
  if (!hit) return elsewhere();
  if (d.stage === "halves") seedPart(i, d, hit);
  else addPoint(i, d, hit, at);
  return true;
}

// ---- pointer: a point dragged, the next segment previewed

const drawCanvas = renderer.domElement;

window.addEventListener("pointerdown", () => (drawUi.pressed = true), true);
window.addEventListener("pointerup", () => (drawUi.pressed = false), true);
window.addEventListener("pointercancel", () => (drawUi.pressed = false), true);
window.addEventListener("blur", () => (drawUi.pressed = false));

// Captured on the way down, before the trackball's own listener: a click or a
// drag sees the turn ended; a point pressed is dragged, the view not turned.
drawCanvas.addEventListener("pointerdown", (e) => {
  const active = drawActive();
  if (!active) return;
  finishTurn();
  hideHover();
  const { i, d } = active;
  if (e.button !== 0 || d.sub || d.stage === "axis-face") return;
  const at = { x: e.clientX, y: e.clientY };
  // (The part under the pointer looked for only near a point: a large mesh takes a while.)
  const near = d.loops.some((loop) => loop.points.some((sp) => {
    const s = screenOf(sp.p);
    return s && Math.hypot(s.x - at.x, s.y - at.y) <= DRAW_PICK_PX;
  }));
  const marker = near ? markerAt(i, d, at, raycastAt(at.x, at.y)) : null;
  if (!marker) return;
  controls.enabled = false;
  drawCanvas.setPointerCapture(e.pointerId);
  drawUi.drag = { ...marker, i, d, pointerId: e.pointerId, from: at, at, moved: false, frame: 0, before: drawSnapshot(d), messages: [] };
}, true);

drawCanvas.addEventListener("pointermove", (e) => {
  drawUi.pointer = { x: e.clientX, y: e.clientY };
  const drag = drawUi.drag;
  if (drag && e.pointerId === drag.pointerId) {
    if (!drag.moved && Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) <= DRAW_MOVE_PX) return;
    drag.moved = true;
    drag.at = { x: e.clientX, y: e.clientY };
    drag.frame ||= requestAnimationFrame(() => {
      drag.frame = 0;
      dragTo(drag);
    });
    return;
  }
  if (e.buttons || !drawUi.active) return;
  scheduleHover();
});
drawCanvas.addEventListener("pointerup", (e) => endDrag(e, true));
drawCanvas.addEventListener("pointercancel", (e) => endDrag(e, false));
drawCanvas.addEventListener("lostpointercapture", (e) => endDrag(e, true));
drawCanvas.addEventListener("pointerleave", () => {
  drawUi.pointer = null;
  if (!drawUi.drag) hideHover();
});

/** The point dragged where the pointer is on the part: its segments laid again at once. */
function dragTo(drag) {
  const { i, d } = drag;
  if (drawShown(i) !== d) return;
  const hit = cardHit(raycastAt(drag.at.x, drag.at.y), i);
  const loop = d.loops[drag.loop];
  if (!hit || !loop?.points[drag.k]) return;
  const dm = drawGeometry(i);
  loop.points[drag.k] = surfacePoint(dm, hit.faceIndex, hit.point.toArray());
  drag.messages = segmentsAt(loop, drag.k).map((K) => respec(d, drag.loop, K)).filter(Boolean);
  d.result = null;
  d.inputs.clear();
  layAll(dm, d);
  applyDrawOverlay();
}

/** The drag ended: kept (undoable, applied again) or cancelled (Esc); the trackball back in every case. */
function endDrag(e, commit) {
  controls.enabled = true;
  const drag = drawUi.drag;
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  drawUi.drag = null;
  if (drag.frame) {
    cancelAnimationFrame(drag.frame);
    if (commit) dragTo(drag);
  }
  if (drawCanvas.hasPointerCapture?.(drag.pointerId)) drawCanvas.releasePointerCapture(drag.pointerId);
  if (!drag.moved || drawShown(drag.i) !== drag.d) return;
  if (!commit) return restoreSnapshot(drag.i, drag.d, drag.before);
  pushHistory(drag.d, drag.before);
  partingOf().message = drag.messages[0] ?? null;
  changed(drag.i, drag.d, { apply: true });
}

/** The next segment previewed under the pointer (once per frame; after a rest when slow). */
function scheduleHover() {
  const active = drawActive();
  if (!active || active.d.stage !== "points" || active.d.sub || !openLoop(active.d)?.points.length || !drawUi.pointer || turn.running || turn.view || drawUi.drag) {
    hideHover();
    return;
  }
  if (drawUi.slow) {
    hideHover();
    clearTimeout(drawUi.hoverTimer);
    drawUi.hoverTimer = setTimeout(runHover, HOVER_REST_MS);
    return;
  }
  drawUi.hoverFrame ||= requestAnimationFrame(() => {
    drawUi.hoverFrame = 0;
    runHover();
  });
}

function runHover() {
  const active = drawActive();
  const loop = active && active.d.stage === "points" && !active.d.sub ? openLoop(active.d) : null;
  const at = drawUi.pointer;
  if (!loop?.points.length || !at || turn.running || turn.view || drawUi.drag) return hideHover();
  const started = performance.now();
  const { i, d } = active;
  const dm = drawGeometry(i);
  const hits = raycastAt(at.x, at.y);
  const close = nearFirst(i, loop, hits, at);
  const hit = cardHit(hits, i);
  const last = loop.points.at(-1);
  const options = { axis: d.axis, prefer: camera.position.toArray(), quick: true };
  let path = null;
  if (close) path = layStraight(dm, last, loop.points[0], options);
  else if (hit) path = layStraight(dm, last, surfacePoint(dm, hit.faceIndex, hit.point.toArray()), options);
  showHover(i, path, close ? loop.points[0].p : null);
  drawUi.slow = performance.now() - started > HOVER_SLOW_MS;
  if (close !== d.closeHover) {
    d.closeHover = close;
    renderParting();
  }
  drawCanvas.style.cursor = close ? "pointer" : "crosshair";
}

// ---- turning the part about the axis (the camera turns)

/** The pose of the view: the camera's position, up and target, the key light. */
function currentPose() {
  return { position: camera.position.toArray(), up: camera.up.toArray(), target: controls.target.toArray(), light: keyLight.position.toArray() };
}

/** Two poses the same (the camera not moved since: within 1e-9 of the distance, its up within 1e-12). */
function samePose(a, b) {
  if (!a || !b) return false;
  const distance = dist3(a.position, a.target) || 1;
  return dist3(a.position, b.position) <= 1e-9 * distance && dist3(a.target, b.target) <= 1e-9 * distance && dist3(a.up, b.up) <= 1e-12;
}

/** The camera's axes: up, towards the viewer, right (for the sense of the arrows). */
function cameraBasis() {
  const q = camera.quaternion;
  return {
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray(),
    toViewer: new THREE.Vector3(0, 0, 1).applyQuaternion(q).toArray(),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(q).toArray(),
  };
}

/** The turn from the view as it is now: nothing turned yet. */
function rebaseTurn(d) {
  turn.base = currentPose();
  turn.axis = d.axis.slice();
  turn.centre = d.centre.slice();
  turn.k = turn.shown = turn.from = 0;
  turn.running = false;
  turn.lastPose = turn.base;
  showTurnAngle();
}

/** The view turned by `shown` thirty-seconds of a turn of the part from the base, exactly (four quarters: back at the base). */
function applyTurn() {
  const { base, axis, centre } = turn;
  const angle = (-2 * Math.PI * turn.shown) / 32;
  const pose = {
    position: rotateAbout(base.position, centre, axis, angle),
    target: rotateAbout(base.target, centre, axis, angle),
    light: rotateAbout(base.light, centre, axis, angle),
    up: rotateAbout(base.up, [0, 0, 0], axis, angle),
  };
  applyPose(pose);
  stopInertia();
  controls.update();
  camera.updateMatrixWorld();
  turn.lastPose = currentPose();
}

/** An arrow: the part turned a step to the left (-1) or to the right (+1) about the axis; the drawing goes on. */
function turnArrow(side) {
  const active = drawActive();
  if (!active?.d.axis || active.d.stage === "axis-face") return;
  const { d } = active;
  finishView();
  // The view moved since (a drag, a zoom, a named view, another tab): the turn starts from there.
  if (!turn.running && (!turn.base || !samePose(currentPose(), turn.lastPose) || !sameDirection(turn.axis, d.axis))) rebaseTurn(d);
  stopInertia();
  hideHover();
  const left = turnSign(turn.axis, cameraBasis());
  turn.k += (side < 0 ? left : -left) * (32 / drawUi.step);
  startTurn();
}

/** "↺ 0°": back to the orientation the turn started from. */
function resetTurn() {
  if (!turn.base || turn.view) return finishView();
  if (!turn.running && !samePose(currentPose(), turn.lastPose)) return;
  turn.k = 0;
  startTurn();
}

function startTurn() {
  if (reducedMotion()) {
    turn.shown = turn.k;
    turn.running = false;
    applyTurn();
    afterTurn();
  } else {
    turn.from = turn.shown;
    turn.t0 = performance.now();
    turn.running = true;
    viewport.dataset.turning = "1";
  }
  showTurnAngle();
}

/** In the animation loop, before the trackball: the turn (and the side view) where they are by now. */
function stepTurn() {
  const now = performance.now();
  if (turn.view) stepView(now);
  if (!turn.running) return;
  const s = Math.min(1, Math.max(0, (now - turn.t0) / TURN_MS));
  turn.shown = s >= 1 ? turn.k : turn.from + (turn.k - turn.from) * easeInOutCubic(s);
  applyTurn();
  if (s >= 1) {
    turn.running = false;
    delete viewport.dataset.turning;
    afterTurn();
  }
}

/** The turn (and the side view) at their end at once: a click, a drag, a named view, another tab, another axis. */
function finishTurn() {
  finishView();
  if (!turn.running) return;
  turn.running = false;
  turn.shown = turn.k;
  applyTurn();
  delete viewport.dataset.turning;
}

/** A turn ended: the preview of the next segment again where the pointer is. */
function afterTurn() {
  if (drawUi.pointer) scheduleHover();
}

/** The angle turned ("Rotation : 22,5°"), and viewport.dataset.turn for scripts and tests. */
function showTurnAngle() {
  const deg = (((turn.k % 32) + 32) % 32) * 11.25;
  viewport.dataset.turn = String(deg);
  $("turn-angle").textContent = t("view.turnAngle", { deg: fmtNum(deg, 2) });
}

/** The step of the arrows chosen (1/4 … 1/32 of a turn), kept in this browser. */
function setTurnStep(step) {
  if (!TURN_STEPS.includes(step)) return;
  drawUi.step = step;
  try {
    localStorage.setItem(TURN_KEY, String(step));
  } catch {
    // kept for this visit only
  }
  renderParting();
}

/** The orientation of a pose (the camera's local axes), to turn smoothly from one pose to another. */
function poseQuaternion(pose) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(vec3(pose.position), vec3(pose.target), vec3(pose.up)));
}

/** A pose between two (s from 0 to 1): turned, moved and zoomed together. */
function blendPose(a, b, s) {
  const q = poseQuaternion(a).slerp(poseQuaternion(b), s);
  const target = vec3(a.target).lerp(vec3(b.target), s);
  const da = dist3(a.position, a.target), db = dist3(b.position, b.target);
  return {
    position: new THREE.Vector3(0, 0, da + (db - da) * s).applyQuaternion(q).add(target).toArray(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray(),
    target: target.toArray(),
    light: vec3(a.light).lerp(vec3(b.light), s).toArray(),
    near: b.near,
    far: b.far,
  };
}

/** A direction square to the axis to look from when the view is along it: the front (-Y), else +X. */
function sideOf(a) {
  const ref = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0, 0);
  return ref.addScaledVector(a, -ref.dot(a)).normalize();
}

/**
 * The side view of the drawing: the axis upright on the screen, the camera
 * 20° above the plane, from the side it looks from now; animated (300 ms),
 * then the turn starts from there.
 */
function drawingView(d) {
  if (state.bounds.isEmpty() || !d.axis) return;
  finishTurn();
  const a = vec3(d.axis);
  const eye = camera.position.clone().sub(controls.target);
  const look = eye.clone().normalize();
  let h = eye.addScaledVector(a, -eye.dot(a));
  if (Math.abs(look.dot(a)) > 0.95 || h.lengthSq() === 0) h = sideOf(a);
  h.normalize();
  const dir = h.multiplyScalar(Math.cos(DRAW_TILT)).addScaledVector(a, Math.sin(DRAW_TILT));
  const radius = state.bounds.getSize(new THREE.Vector3()).length() / 2 || 1;
  const to = viewPose(dir, a, vec3(d.centre), radius);
  if (reducedMotion()) {
    applyPose(to);
    stopInertia();
    controls.update();
    rebaseTurn(d);
    return;
  }
  turn.view = { from: { ...currentPose(), near: camera.near, far: camera.far }, to, t0: performance.now(), d };
}

function stepView(now) {
  const v = turn.view;
  const s = Math.min(1, (now - v.t0) / VIEW_MS);
  if (s >= 1) return finishView();
  applyPose(blendPose(v.from, v.to, easeInOutCubic(s)));
  stopInertia();
}

function finishView() {
  const v = turn.view;
  if (!v) return;
  turn.view = null;
  applyPose(v.to);
  stopInertia();
  controls.update();
  camera.updateMatrixWorld();
  rebaseTurn(v.d);
}

// ---- the 3D view: the line laid, the points, the axis

let drawTextures = null;

/** The round marks of the points: a white dot outlined (tinted by its material), point 1's with a white ring. */
function markerTextures() {
  if (drawTextures) return drawTextures;
  const make = (paint) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    paint(canvas.getContext("2d"));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  const disc = (g, r, fill) => {
    g.beginPath();
    g.arc(32, 32, r, 0, 2 * Math.PI);
    g.fillStyle = fill;
    g.fill();
  };
  drawTextures = {
    dot: make((g) => {
      disc(g, 30, "#1d2330");
      disc(g, 22, "#ffffff");
    }),
    ring: make((g) => {
      disc(g, 31, "#1d2330");
      disc(g, 27, "#ffffff");
      disc(g, 17, "#e8141b");
    }),
  };
  return drawTextures;
}

/** Pieces of a path as pairs of points (none of no length) appended to `out`. */
function pathPairs(path, out) {
  const x = path.xyz;
  for (let j = 0; j + 5 < x.length; j += 3) {
    if (x[j] === x[j + 3] && x[j + 1] === x[j + 4] && x[j + 2] === x[j + 5]) continue;
    out.push(x[j], x[j + 1], x[j + 2], x[j + 3], x[j + 4], x[j + 5]);
  }
  return out;
}

/** A line of the drawing: pixels wide, over the part, dashed or not; a ghost (opacity 0.25, not hidden by the part) of what went behind it. */
function drawLine(pairs, { color, width = DRAW_LINE_PX, dashed = false, dash = 1, opacity = 1, ghost = false, order = ORDER_LINE }) {
  const material = new LineMaterial({
    color, linewidth: width, transparent: true, opacity: ghost ? 0.25 * opacity : opacity, dashed,
    depthTest: !ghost, depthWrite: false, clippingPlanes: [sectionPlane],
  });
  if (dashed) {
    material.dashSize = dash;
    material.gapSize = 0.7 * dash;
  }
  material.resolution.set(viewport.clientWidth, viewport.clientHeight);
  const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pairs), material);
  if (dashed) line.computeLineDistances();
  line.renderOrder = ghost ? order - 0.5 : order;
  return line;
}

/** The points as round marks, `size` pixels whatever the zoom; a ghost through the part. */
function drawMarks(points, { size = DRAW_MARKER_PX, color = PARTING_LINE, map = markerTextures().dot, ghost = false }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(points.flat()), 3));
  const material = new THREE.PointsMaterial({
    size, sizeAttenuation: false, map, color, transparent: true, alphaTest: 0.1, opacity: ghost ? 0.25 : 1,
    depthTest: !ghost, depthWrite: false, clippingPlanes: [sectionPlane],
  });
  const marks = new THREE.Points(geometry, material);
  marks.renderOrder = ghost ? ORDER_LINE + 0.5 : ORDER_LINE + 1;
  return marks;
}

function removeDrawOverlay(mesh) {
  for (const key of ["drawOverlay", "drawHover"]) {
    const group = mesh.userData[key];
    if (!group) continue;
    mesh.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    mesh.userData[key] = null;
  }
}

/**
 * The drawing on the 3D view (no colouring of the part: a point moved costs
 * only this): the line laid in red (the pieces off the parting line, the
 * same chape on both sides, dashed grey; a segment not laid, dashed orange),
 * the segment hovered in the table or at the point selected in yellow, a
 * ghost of all of it through the part, the points (point 1 of each loop
 * with a white ring, the one selected yellow), the centres of the arcs, the
 * rotation axis dashed through the centre of the part; the numbers of the
 * points.
 */
function applyDrawOverlay() {
  state.meshes.forEach((mesh) => {
    const hover = mesh.userData.drawHover;
    mesh.userData.drawHover = null; // the preview stays
    removeDrawOverlay(mesh);
    mesh.userData.drawHover = hover;
  });
  const card = $("parting-card");
  const tags = (card.dataset.overlay || "").split(" ").filter((x) => x && x !== "drawing" && x !== "axis");
  const active = drawActive();
  const mesh = active && state.meshes[active.i];
  if (!mesh || !active.d.axis) {
    card.dataset.overlay = tags.join(" ");
    buildLabels(null);
    return;
  }
  const { i, d } = active;
  card.dataset.draw = d.stage;
  const dm = drawGeometry(i);
  const dash = 0.012 * (dm.diag || 1);
  const group = new THREE.Group();
  const failed = [], marked = [];
  const result = d.result?.ok ? d.result : null;
  // Applied: the pieces on the parting line and those off it, as drawnParting tells them apart; else every piece laid.
  const red = result ? result.segments : [];
  const grey = result ? result.inactive : [];
  const selected = d.selected && d.loops[d.selected.loop]?.points[d.selected.k] ? d.selected : null;
  const hovered = d.hoverSeg ? d.hoverSeg.split(":").map(Number) : null;
  d.loops.forEach((loop, L) => loop.paths.forEach((path, K) => {
    if (!path) return;
    if (path.status !== "ok") pathPairs(path, failed);
    else if (!result) pathPairs(path, red);
    const lit = (hovered && hovered[0] === L && hovered[1] === K) || (selected && selected.loop === L && segmentsAt(loop, selected.k).includes(K));
    if (lit) pathPairs(path, marked);
  }));
  for (const ghost of [true, false]) {
    if (red.length) group.add(drawLine(red, { color: PARTING_LINE, ghost }));
    if (grey.length) group.add(drawLine(grey, { color: DRAW_INACTIVE, width: 3, dashed: true, dash, ghost }));
    if (failed.length) group.add(drawLine(failed, { color: DRAW_FAILED, width: 3, dashed: true, dash, ghost }));
  }
  if (marked.length) group.add(drawLine(marked, { color: DRAW_SELECTED, width: 6, order: ORDER_LINE + 0.2 }));
  // The points: point 1 of each loop bigger, ringed; the one selected yellow.
  const plain = [], firsts = [], chosen = [];
  d.loops.forEach((loop, L) => loop.points.forEach((sp, k) => {
    if (selected && selected.loop === L && selected.k === k) chosen.push(sp.p);
    else (k === 0 ? firsts : plain).push(sp.p);
  }));
  for (const ghost of [true, false]) {
    if (plain.length) group.add(drawMarks(plain, { ghost }));
    if (firsts.length) group.add(drawMarks(firsts, { size: DRAW_BIG_PX, color: 0xffffff, map: markerTextures().ring, ghost }));
    if (chosen.length) group.add(drawMarks(chosen, { size: DRAW_BIG_PX, color: DRAW_SELECTED, ghost }));
  }
  // The centres of the arcs: a small cross, thin lines to the ends.
  const centres = [];
  d.loops.forEach((loop, L) => loop.segs.forEach((spec, K) => {
    if (spec?.kind !== "arc" || K >= segCount(loop)) return;
    const A = loop.points[K].p, B = loop.points[(K + 1) % loop.points.length].p;
    const geo = arcGeometry(A, B, spec);
    if (geo.error) return;
    const c = geo.centre, r = 0.008 * (dm.diag || 1);
    for (let k = 0; k < 3; k++) {
      const a = c.slice(), b = c.slice();
      a[k] -= r;
      b[k] += r;
      centres.push(...a, ...b);
    }
    centres.push(...c, ...A, ...c, ...B);
  }));
  if (centres.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(centres), 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: PARTING_ARROW, transparent: true, opacity: 0.8, depthTest: false, clippingPlanes: [sectionPlane] }));
    lines.renderOrder = ORDER_LINE;
    group.add(lines);
  }
  // The rotation axis through the centre of the part, 1.3 times its diagonal.
  const size = state.result.bodies[i].bbox.size;
  const half = 0.65 * Math.hypot(...size);
  const ends = [-half, half].flatMap((s) => d.centre.map((c, k) => c + s * d.axis[k]));
  group.add(drawLine(ends, { color: PARTING_ARROW, width: 2, dashed: true, dash: 2 * dash, opacity: 0.85, order: ORDER_LINE - 1 }));
  mesh.add(group);
  mesh.userData.drawOverlay = group;
  card.dataset.overlay = [...tags, ...(drawPoints(d) ? ["drawing"] : []), "axis"].join(" ");
  buildLabels(d);
}

/** The preview of the next segment (red, faint; dashed orange when it is not laid), and point 1 ringed when the click would close the loop. */
function showHover(i, path, first) {
  hideHover();
  const mesh = state.meshes[i];
  if (!mesh) return;
  const group = new THREE.Group();
  const pairs = path ? pathPairs(path, []) : [];
  if (pairs.length) {
    const ok = path.status === "ok";
    const dash = 0.012 * (drawGeometry(i).diag || 1);
    group.add(drawLine(pairs, ok ? { color: PARTING_LINE, width: 3, opacity: 0.5 } : { color: DRAW_FAILED, width: 3, dashed: true, dash, opacity: 0.8 }));
  }
  if (first) group.add(drawMarks([first], { size: 22, color: 0xffffff, map: markerTextures().ring }));
  mesh.add(group);
  mesh.userData.drawHover = group;
}

function hideHover() {
  for (const mesh of state.meshes) {
    const group = mesh.userData.drawHover;
    if (!group) continue;
    mesh.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    mesh.userData.drawHover = null;
  }
}

/** The numbers of the points, as labels of the page placed in the animation loop. */
function buildLabels(d) {
  const box = $("draw-labels");
  drawUi.labels = [];
  if (!d) return box.replaceChildren();
  const spans = [];
  d.loops.forEach((loop, L) => loop.points.forEach((sp, k) => {
    const span = document.createElement("span");
    span.textContent = String(pointNumber(d, L, k));
    if (k === 0) span.classList.add("first");
    if (d.selected?.loop === L && d.selected.k === k) span.classList.add("selected");
    spans.push(span);
    drawUi.labels.push({ p: sp.p, t: sp.t, el: span });
  }));
  box.replaceChildren(...spans);
}

/** After each frame: the labels where their points are; faint on the far side of the part. */
function drawFrame() {
  if (!drawUi.active || !drawUi.labels.length) return;
  const active = drawActive();
  if (!active) return;
  const dm = drawGeometry(active.i);
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const eye = camera.position;
  const v = new THREE.Vector3();
  for (const label of drawUi.labels) {
    v.set(label.p[0], label.p[1], label.p[2]).project(camera);
    // Off the view, or on the side of the section cut away.
    const out = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1 || (sectionOn && sectionPlane.distanceToPoint(vec3(label.p)) < 0);
    label.el.hidden = out;
    if (out) continue;
    label.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(6px, -100%)`;
    const n = 3 * label.t;
    const away = dm.normals[n] * (eye.x - label.p[0]) + dm.normals[n + 1] * (eye.y - label.p[1]) + dm.normals[n + 2] * (eye.z - label.p[2]) < 0;
    label.el.classList.toggle("behind", away);
  }
}

/**
 * The triangles the drawn line crosses, while its halves are tinted: each
 * corner in the colour of the half most of the triangles round it (off the
 * line) are in, so that the colour changes across the triangle, along the
 * line, instead of a whole triangle on one side (a face of a CAD body: two
 * large triangles, else split along their diagonal).
 */
function drawSeamColours(d, i, colors) {
  const tint = d.shownTint;
  if (!tint) return;
  const dm = drawGeometry(i);
  const { W, areas } = dm;
  if (!tint.seam) {
    const seam = new Uint8Array(dm.nt);
    for (const loop of tint.paths) for (const path of loop) for (const f of path.tri) seam[f] = 1;
    tint.seam = seam;
  }
  // The triangles round each welded vertex (compressed rows), once per body.
  if (!dm.corners) {
    const start = new Int32Array(dm.nvW + 1);
    for (let k = 0; k < W.length; k++) start[W[k] + 1]++;
    for (let w = 0; w < dm.nvW; w++) start[w + 1] += start[w];
    const list = new Int32Array(W.length);
    const fill = start.slice(0, dm.nvW);
    for (let k = 0; k < W.length; k++) list[fill[W[k]]++] = Math.floor(k / 3);
    dm.corners = { start, list };
  }
  const { start, list } = dm.corners;
  const color = new THREE.Color();
  for (let f = 0; f < dm.nt; f++) {
    if (!tint.seam[f] || tint.undercut[f]) continue;
    for (let k = 0; k < 3; k++) {
      const w = W[3 * f + k];
      let up = 0, down = 0;
      for (let s = start[w]; s < start[w + 1]; s++) {
        const g = list[s];
        if (tint.seam[g]) continue;
        if (tint.side[g] === SIDE_UPPER) up += areas[g];
        else if (tint.side[g] === SIDE_LOWER) down += areas[g];
      }
      const side = up > down ? SIDE_UPPER : down > up ? SIDE_LOWER : tint.side[f];
      color.copy(PARTING_FACE);
      if (side === SIDE_UPPER) color.lerp(UPPER_TINT, 0.35);
      else if (side === SIDE_LOWER) color.lerp(LOWER_TINT, 0.35);
      colors[12 * f + 4 * k] = color.r;
      colors[12 * f + 4 * k + 1] = color.g;
      colors[12 * f + 4 * k + 2] = color.b;
    }
  }
}

/** The colour of triangle f while drawing (returns whether undercut): the halves tinted once applied, else the core zones of the axis in yellow. */
function drawFaceColour(d, f, color) {
  const tint = d.shownTint;
  if (tint) {
    if (tint.undercut[f]) {
      color.copy(PARTING_UNDERCUT);
      return true;
    }
    color.copy(PARTING_FACE);
    if (tint.side[f] === SIDE_UPPER) color.lerp(UPPER_TINT, 0.35);
    else if (tint.side[f] === SIDE_LOWER) color.lerp(LOWER_TINT, 0.35);
    return false;
  }
  color.copy(PARTING_FACE);
  const flags = d.base?.flags;
  if (!flags) return false;
  if (!(flags[f] & (REACH_UP | REACH_DOWN))) {
    color.copy(PARTING_UNDERCUT);
    return true;
  }
  if (flags[f] & ZERO_DRAFT) color.lerp(WHITE, 0.5);
  return false;
}

// ---- the card

/** The hint of the drawing: what to do next, or what went wrong. */
function drawHint(i) {
  const d = drawShown(i);
  if (!d) return "";
  if (d.stage === "axis-face") return t("parting.draw.hint.face");
  if (d.sub?.kind === "centre") return t("parting.draw.hint.centre", { seg: segName(d, d.sub.loop, d.sub.seg) });
  if (!d.axis) return t("parting.draw.hint.plane");
  if (d.stage === "points") {
    const loop = openLoop(d);
    if (d.closeHover && loop) return t("parting.draw.hint.closeHover", { segments: loop.points.length });
    // The number of the next point, and of the first point of its loop (the one closing it).
    const n = pointNumber(d, d.current, loop ? loop.points.length : 0);
    if (!loop?.points.length) return t("parting.draw.hint.first", { n, step: `1/${drawUi.step}`, axis: axisLabel(d.axis) });
    return t("parting.draw.hint.next", { n, first: pointNumber(d, d.current, 0) });
  }
  // The halves: a segment not laid, the loops not splitting the part, a warning; else what to do.
  for (let L = 0; L < d.loops.length; L++) {
    const K = d.loops[L].paths.findIndex((path) => path && path.status !== "ok");
    if (K >= 0) return segmentError(d, L, K, d.loops[L].paths[K]);
  }
  const messages = d.result?.messages ?? [];
  const message = messages.find((m) => m.level === "error") ?? messages.find((m) => m.level === "warning" && m.code !== "edges");
  return message ? t(message.hint, message) : t("parting.draw.hint.halves");
}

/** A control of the card locked while drawing (or for a drawn line), its title saying why. */
function lockControl(el, locked, why, titleKey = null) {
  el.disabled = locked;
  el.title = locked ? why : titleKey ? t(titleKey) : "";
}

/** A point as its field shows it to be edited: 2 decimals, the thousands not grouped (parseTriple reads it back). */
const pointField = (p) => p.map((x) => (Math.abs(x) < 5e-3 ? 0 : x).toLocaleString(locale(), { maximumFractionDigits: 2, useGrouping: false })).join(language() === "fr" ? " ; " : ", ");

/** The rows of the segments: name, type, length, actions; the radius and centre of an arc; an error. */
function segmentRows(d) {
  const rows = [];
  const many = d.loops.length > 1;
  const result = d.result?.ok ? d.result : null;
  const selected = d.selected && d.loops[d.selected.loop]?.points[d.selected.k] ? d.selected : null;
  d.loops.forEach((loop, L) => {
    if (many) rows.push(`<tr class="loop-head"><td colspan="4">${escapeHtml(t("parting.draw.loop", { n: L + 1 }))}</td></tr>`);
    for (let K = 0; K < segCount(loop); K++) {
      const key = `${L}:${K}`;
      const spec = loop.segs[K];
      const path = loop.paths[K];
      const arc = spec?.kind === "arc";
      const name = segName(d, L, K);
      const failed = path && path.status !== "ok";
      const off = result && !failed && !segmentActive(result, L, K);
      const lit = (selected && selected.loop === L && segmentsAt(loop, selected.k).includes(K)) || d.hoverSeg === key;
      const length = !path ? "—"
        : failed ? `<span class="seg-failed">${escapeHtml(t("parting.draw.notLaid"))}</span>`
        : `${path.method === "edges" ? "≈ " : ""}${escapeHtml(fmtNum(path.length, 1))} mm`;
      const title = off ? t("parting.draw.inactive.title") : path?.method === "edges" ? t("parting.draw.edges.title") : "";
      const cls = [lit ? "selected" : "", off ? "inactive" : "", arc ? "seg-arc" : ""].filter(Boolean).join(" ");
      const button = (action, label, titleKey) => `<button type="button" data-action="${action}" title="${escapeHtml(t(titleKey))}" aria-label="${escapeHtml(`${t(titleKey)} (${name})`)}">${label}</button>`;
      rows.push(`<tr data-seg="${key}"${cls ? ` class="${cls}"` : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>` +
        `<td>${escapeHtml(name)}</td>` +
        `<td><select data-field="type" title="${escapeHtml(t("parting.draw.type.title"))}" aria-label="${escapeHtml(`${t("parting.draw.col.type")} ${name}`)}">` +
        `<option value="straight"${arc ? "" : " selected"}>${escapeHtml(t("parting.draw.type.straight"))}</option>` +
        `<option value="arc"${arc ? " selected" : ""}>${escapeHtml(t("parting.draw.type.curved"))}</option></select></td>` +
        `<td class="num">${length}</td>` +
        `<td class="seg-actions">${arc ? "" : button("flip", "⇄", "parting.draw.flip.title")}${button("split", "+", "parting.draw.split.title")}</td></tr>`);
      const typed = d.inputs.get(key);
      if (arc) {
        const A = loop.points[K].p, B = loop.points[(K + 1) % loop.points.length].p;
        const geo = arcGeometry(A, B, spec);
        const min = Math.ceil((dist3(A, B) / 2) * 100) / 100;
        const placing = d.sub?.kind === "centre" && d.sub.loop === L && d.sub.seg === K;
        const radius = typed?.radius ?? String(round(spec.radius, 2));
        const centre = typed?.centre ?? (geo.error ? "" : pointField(geo.centre));
        rows.push(`<tr class="seg-arc-edit" data-seg="${key}"><td colspan="4"><div class="seg-edit">` +
          `<label>${escapeHtml(t("parting.draw.radius"))} <input type="number" data-field="radius" step="0.1" min="${min}" value="${escapeHtml(radius)}"${typed?.radius != null ? ' aria-invalid="true"' : ""}></label>` +
          `<label>${escapeHtml(t("parting.draw.centre"))} <input type="text" class="seg-centre" data-field="centre" autocomplete="off" placeholder="${escapeHtml(t("parting.draw.centre.placeholder"))}" value="${escapeHtml(centre)}"${typed?.centre != null ? ' aria-invalid="true"' : ""}></label>` +
          button("centreFlip", "⇅", "parting.draw.centreFlip.title") +
          `<button type="button" data-action="placeCentre" class="toggle${placing ? " active" : ""}" title="${escapeHtml(t("parting.draw.placeCentre.title"))}">${escapeHtml(t("parting.draw.placeCentre"))}</button>` +
          `</div></td></tr>`);
      }
      const error = typed?.error ?? (failed ? segmentError(d, L, K, path) : null);
      if (error) rows.push(`<tr class="parting-seg-error" data-seg="${key}"><td colspan="4">${escapeHtml(error)}</td></tr>`);
    }
  });
  return rows.join("");
}

/**
 * The drawing's part of the card (from renderParting): the toggle, the
 * draft kept, the panel (plane, axis, actions, segments, point, halves,
 * alignment), the other ways of defining the direction locked while drawing,
 * and the controls on the 3D view.
 */
function renderDrawPanel(p, i, field, hint) {
  const active = drawActive();
  const d = active?.i === i ? active.d : null;
  const why = t("parting.draw.locked");
  lockControl($("parting-pick"), !!d, why, "parting.pick.title");
  lockControl($("parting-vector"), !!d, why, "parting.vector.title");
  lockControl($("parting-apply"), !!d, why);
  // Faces cannot be reassigned on a drawn line: its halves are chosen by part.
  lockControl($("parting-assign"), !!d || field.source === "drawn", d ? why : t("parting.assign.drawn"), "parting.assign.title");
  $("parting-target").disabled = !!d || field.source === "drawn";
  const table = $("parting-candidates");
  table.classList.toggle("locked", !!d);
  table.title = d ? why : "";
  for (const input of table.querySelectorAll("input")) input.disabled = !!d;
  const card = $("parting-card");
  if (d) card.dataset.draw = d.stage;
  else delete card.dataset.draw;

  $("parting-draw").classList.toggle("active", !!d);
  $("parting-draw").setAttribute("aria-pressed", String(!!d));
  const kept = p.draw.get(i);
  const showKept = !d && kept && drawPoints(kept) > 0 && drawEdited(p, i);
  $("parting-draw-kept").hidden = !showKept;
  if (showKept) $("parting-draw-kept").textContent = t("parting.draw.kept", { points: drawPoints(kept) });
  $("parting-draw-panel").hidden = !d;
  renderViewControls(d, hint);
  if (!d) return;

  $("parting-draw-plane").value = d.plane;
  $("parting-draw-vector-row").hidden = d.plane !== "vector";
  if (document.activeElement !== $("parting-draw-vector")) $("parting-draw-vector").value = d.vector ?? "";
  $("parting-draw-axis").textContent = d.axis ? t("parting.draw.axis", { axis: axisLabel(d.axis), centre: fmtPoint(d.centre) }) : "";
  const open = openLoop(d);
  const canClose = !!open && open.points.length >= 3;
  for (const [id, off] of [
    ["parting-draw-undo", !d.history.length], ["draw-undo", !d.history.length], ["parting-draw-redo", !d.future.length],
    ["parting-draw-close", !canClose], ["draw-close", !canClose], ["parting-draw-new", !allClosed(d) || d.loops.length >= MAX_LOOPS],
    ["parting-draw-clear", !drawPoints(d)],
  ]) $(id).disabled = off;

  setHtml($("parting-draw-segments").tBodies[0], segmentRows(d));
  $("parting-draw-segments").hidden = !d.loops.some((loop) => segCount(loop) > 0);

  const sel = d.selected && d.loops[d.selected.loop]?.points[d.selected.k] ? d.selected : null;
  $("parting-draw-point").hidden = !sel;
  if (sel) $("parting-draw-point-label").textContent = t("parting.draw.point", { n: pointNumber(d, sel.loop, sel.k) });

  const halves = d.stage === "halves";
  $("parting-draw-halves").hidden = !halves;
  $("parting-draw-upper").classList.toggle("active", d.target === SIDE_UPPER);
  $("parting-draw-lower").classList.toggle("active", d.target === SIDE_LOWER);
  const figures = d.result?.ok ? d.result.figures : null;
  $("parting-draw-parts").hidden = !figures;
  if (figures) $("parting-draw-parts").textContent = t("parting.draw.parts", { count: figures.parts, upper: figures.upper_parts, lower: figures.lower_parts });

  const align = halves ? alignCandidate(d) : null;
  $("parting-draw-align").hidden = !align;
  if (align) {
    const frame = heightFrame(d.axis);
    $("parting-draw-align-label").textContent = t("parting.draw.alignLabel", { n: align.L + 1, axis: frame.name });
    const value = round(frame.sign * align.median, 1);
    const key = `${align.L}|${value}`;
    if (d.alignFor !== key && document.activeElement !== $("parting-draw-level")) {
      d.alignFor = key;
      $("parting-draw-level").value = String(value);
    }
  }
}

/** The controls on the 3D view: shown while drawing (an axis set), the arrows' and the step's texts, the angle, the hint. */
function renderViewControls(d, hint) {
  const on = !!d && !!d.axis && d.stage !== "axis-face";
  $("draw-overlay").hidden = !on;
  if (!on) return;
  $("draw-hint").textContent = hint;
  const params = { step: `1/${drawUi.step}`, axis: axisLabel(d.axis) };
  for (const [id, key] of [["turn-left", "view.turnLeft"], ["turn-right", "view.turnRight"]]) {
    $(id).title = t(key, params);
    $(id).setAttribute("aria-label", t(key, params));
  }
  $("turn-step").setAttribute("aria-label", t("view.turnStep"));
  for (const button of $("turn-step").querySelectorAll("[data-step]")) {
    const checked = Number(button.dataset.step) === drawUi.step;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
    button.title = t(`view.step.${button.dataset.step}.title`);
    button.setAttribute("aria-label", t(`view.step.${button.dataset.step}.label`));
  }
  for (const id of ["draw-undo", "draw-close", "draw-done"]) $(id).setAttribute("aria-label", $(id).querySelector(".draw-label").textContent);
  $("turn-reset").setAttribute("aria-label", t("view.turnReset"));
  showTurnAngle();
}

// ---- keys

/**
 * The keys of the drawing (true: handled): ← → turn, Ctrl+Z / Ctrl+Y, Enter
 * closes, Delete, Esc (a point dragged: put back). Not while typing, nor with
 * a button pressed, nor on another page than the 3D view.
 */
function drawKey(e) {
  const active = drawActive();
  // Esc during a drag (its button still pressed): the point back where it was.
  if (active && drawUi.drag && e.key === "Escape") {
    endDrag(null, false);
    e.preventDefault();
    return true;
  }
  if (!active || drawUi.pressed || $("page-viewer").hidden) return false;
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return false;
  const { p, i, d } = active;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (key === "Escape") {
    if (d.stage === "axis-face") {
      d.plane = d.prev?.plane ?? d.plane;
      if (d.plane === "face" && d.axis) d.plane = defaultPlane(d.axis).plane;
      d.prev = null;
      d.stage = stageOf(d);
      renderParting();
    } else if (d.sub) {
      d.sub = null;
      renderParting();
    } else leaveDrawing();
    e.preventDefault();
    return true;
  }
  if (mod && !e.altKey && key === "z" && !e.shiftKey) {
    undoDrawing();
    e.preventDefault();
    return true;
  }
  if (mod && !e.altKey && (key === "y" || (key === "z" && e.shiftKey))) {
    redoDrawing();
    e.preventDefault();
    return true;
  }
  if (mod || e.altKey) return false;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (el?.closest?.("#turn-step")) return false; // the step chosen with the arrows there
    turnArrow(key === "ArrowLeft" ? -1 : 1);
    e.preventDefault();
    return true;
  }
  if (key === "Enter") {
    if (el?.tagName === "BUTTON") return false;
    closeLoop(i, d);
    e.preventDefault();
    return true;
  }
  if (key === "Delete" || key === "Backspace") {
    const open = openLoop(d);
    if (d.selected) deletePoint(i, d, d.selected);
    else if (open?.points.length && d.stage === "points") deletePoint(i, d, { loop: d.current, k: open.points.length - 1 });
    p.message = null;
    e.preventDefault();
    return true;
  }
  return false;
}

// ---- events

/** The drawing shown and its body, for the buttons. */
const withDrawing = (fn) => () => {
  const active = drawActive();
  if (active) fn(active);
};

$("parting-draw").addEventListener("click", () => setPartingMode("draw"));
// The plane chosen: the focus leaves the list (← → turn the part, Esc goes back), but to the normal to type.
$("parting-draw-plane").addEventListener("change", (e) => {
  drawPlaneChosen(e.target.value);
  if (e.target.value !== "vector") e.target.blur();
});
$("parting-draw-vector-apply").addEventListener("click", applyDrawVector);
$("parting-draw-vector").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyDrawVector();
});
$("parting-draw-undo").addEventListener("click", undoDrawing);
$("parting-draw-redo").addEventListener("click", redoDrawing);
$("draw-undo").addEventListener("click", undoDrawing);
for (const id of ["parting-draw-close", "draw-close"]) $(id).addEventListener("click", withDrawing(({ i, d }) => closeLoop(i, d)));
$("parting-draw-new").addEventListener("click", newLoop);
$("parting-draw-side").addEventListener("click", withDrawing(({ d }) => drawingView(d)));
$("parting-draw-clear").addEventListener("click", clearDrawing);
for (const id of ["parting-draw-done", "draw-done"]) $(id).addEventListener("click", leaveDrawing);
$("parting-draw-delete").addEventListener("click", withDrawing(({ i, d }) => d.selected && deletePoint(i, d, d.selected)));
for (const [id, side] of [["parting-draw-upper", SIDE_UPPER], ["parting-draw-lower", SIDE_LOWER]]) {
  $(id).addEventListener("click", withDrawing(({ p, d }) => {
    d.target = side;
    p.message = null;
    renderParting();
  }));
}
$("parting-draw-swap").addEventListener("click", swapHalves);
const alignTyped = withDrawing(({ i, d }) => {
  const align = alignCandidate(d);
  const value = Number(String($("parting-draw-level").value).trim().replace(",", "."));
  if (!align || !Number.isFinite(value)) return;
  alignLoop(i, d, align.L, value * heightFrame(d.axis).sign);
});
$("parting-draw-align-apply").addEventListener("click", alignTyped);
$("parting-draw-level").addEventListener("keydown", (e) => {
  if (e.key === "Enter") alignTyped();
});

// The table of the segments: its type, its radius and centre (on change: typing keeps the focus), its buttons; hovered, its line in yellow.
const segmentOf = (el) => {
  const row = el.closest("[data-seg]");
  return row ? row.dataset.seg.split(":").map(Number) : null;
};
$("parting-draw-segments").addEventListener("change", (e) => {
  const active = drawActive();
  const seg = segmentOf(e.target);
  if (!active || !seg) return;
  const { p, i, d } = active;
  p.message = null;
  const [L, K] = seg;
  const field = e.target.dataset.field;
  if (field === "type") setSegmentType(i, d, L, K, e.target.value);
  else if (field === "radius") setSegmentRadius(i, d, L, K, e.target.value);
  else if (field === "centre") setSegmentCentre(i, d, L, K, parseTriple(e.target.value), e.target.value);
});
$("parting-draw-segments").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  const active = drawActive();
  const seg = button && segmentOf(button);
  if (!active || !seg) return;
  const { p, i, d } = active;
  const [L, K] = seg;
  p.message = null;
  const action = button.dataset.action;
  if (action === "flip" || action === "centreFlip") flipSegment(i, d, L, K);
  else if (action === "split") splitSegment(i, d, L, K);
  else if (action === "placeCentre") {
    d.sub = d.sub?.kind === "centre" && d.sub.loop === L && d.sub.seg === K ? null : { kind: "centre", loop: L, seg: K };
    hideHover();
    renderParting();
  }
});
$("parting-draw-segments").addEventListener("mouseover", (e) => {
  const active = drawActive();
  const seg = segmentOf(e.target);
  const key = seg ? seg.join(":") : null;
  if (!active || active.d.hoverSeg === key) return;
  active.d.hoverSeg = key;
  applyDrawOverlay();
});
$("parting-draw-segments").addEventListener("mouseleave", () => {
  const active = drawActive();
  if (!active?.d.hoverSeg) return;
  active.d.hoverSeg = null;
  applyDrawOverlay();
});

// The arrows and the step on the 3D view (outside the canvas: never a click of the drawing, never the trackball).
$("turn-left").addEventListener("click", () => turnArrow(-1));
$("turn-right").addEventListener("click", () => turnArrow(1));
$("turn-reset").addEventListener("click", resetTurn);
$("turn-step").addEventListener("click", (e) => {
  const button = e.target.closest("[data-step]");
  if (button) setTurnStep(Number(button.dataset.step));
});
// A radio group: the arrow keys move the choice.
$("turn-step").addEventListener("keydown", (e) => {
  const button = e.target.closest("[data-step]");
  if (!button || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const k = TURN_STEPS.indexOf(Number(button.dataset.step)) + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
  const step = TURN_STEPS[(k + TURN_STEPS.length) % TURN_STEPS.length];
  setTurnStep(step);
  $("turn-step").querySelector(`[data-step="${step}"]`)?.focus();
  e.preventDefault();
});

// ---------------------------------------------------------------- risers and gating

// Risers ("masselottes") and the ingate ("attaque de coulée") of a cast part
// (engine/feeding.js): the feeding zones of the closed bodies are found once
// the model is shown, in a worker of their own (engine/feedclient.js), and
// kept with the results of the file in this browser; the risers and the
// ingate are placed for the parting line of the body (proposed or by hand) in
// a second worker, and placed again when it changes. They can be placed by hand: a
// riser added, moved, resized or deleted, the ingate placed (brought onto the
// parting line). That definition is kept per part (the SHA-256 of its file)
// in this browser, for the body as it was read (its triangles, its size: not
// put back in another unit nor at another quality); the risers placed by hand
// stay when the parting changes.
const FEEDING_KEY = "reader3d.feeding.v1";
const FEEDING_PARTS = 200; // parts whose definition by hand is kept, the latest
const RISER_COLOR = 0xf08a24;
const RISER_SELECTED = 0xffd23f;
const GATE_COLOR = 0xc040d0;

const feedClient = () => (feedClient.module ??= import("./engine/feedclient.js"));

// Per result: {results (per body {zones, body, zone, sphere, …} or null),
// pending, percent, error, manual (body -> {risers: [...] or null (the
// proposal's), gate: {...} or null (the proposal's)}), placed (body -> the
// placement for a parting: {key, placement, error}), placing (body -> the
// parting key being placed in the worker), queued (body -> {key, parting},
// to send), outward (body -> 1, or -1 when its triangles turn inwards), show,
// mode ("add" | "move" | "gate" | null), selected (a riser id), body (the
// card's, for the selection), message, restored}.
const feedings = new WeakMap();

function feedingOf(r = state.result) {
  if (!r) return null;
  let f = feedings.get(r);
  if (!f) {
    f = { results: null, pending: null, percent: null, error: null, manual: new Map(), placed: new Map(), placing: new Map(), queued: new Map(), outward: new Map(), show: false, mode: null, selected: null, body: -1, message: null, restored: false };
    feedings.set(r, f);
  }
  return f;
}

/** The body of the card: that of the parting line card. */
const feedingBody = () => partingBody();

/** The parting of body i as feeding.js takes it ({direction, side, segments}, or null) and what identifies it. */
function feedingParting(i, r = state.result) {
  const p = partingOf(r);
  const field = partingField(i, r);
  return {
    // The definition by hand, or the proposal.
    key: field ? (field.manual ? p.current.get(i) : p.results[i]) : null,
    parting: field ? { direction: field.direction, side: field.side, segments: field.segments } : null,
  };
}

/**
 * The risers and the ingate of body i proposed for its parting line as shown
 * (proposed or by hand; +Z without one), placed once per parting in the
 * worker (seconds on a large body: never on the page): {key, placement
 * (placeFeeding), error}, or null while it is placed, or without zones. Its
 * placement is asked for here (the model shown); the card and the exports
 * follow when it comes.
 */
function feedingPlacement(i, r = state.result) {
  const f = feedingOf(r);
  const res = f?.results?.[i];
  if (!res) return null;
  const { key, parting } = feedingParting(i, r);
  const kept = f.placed.get(i);
  if (kept && kept.key === key) return kept;
  if (r === state.result && f.placing.get(i) !== key && f.queued.get(i)?.key !== key) {
    // Asked for in one go with the others asked for now (the bodies of an export), sent at the end of this task.
    if (!f.queued.size) queueMicrotask(() => placeQueued(r));
    f.queued.set(i, { key, parting });
  }
  return null;
}

/**
 * The bodies queued sent to the worker: the card's body first, on its own,
 * then the others together; each answer kept when its parting is still the
 * one shown, then the card, the view and the published results once.
 */
function placeQueued(r) {
  const f = feedingOf(r);
  const queued = [...f.queued];
  f.queued.clear();
  if (r !== state.result || !queued.length) return;
  const card = feedingBody();
  const batches = [queued.filter(([i]) => i === card), queued.filter(([i]) => i !== card)].filter((b) => b.length);
  for (const batch of batches) {
    const bodies = batch.map(([i, { key, parting }]) => {
      f.placing.set(i, key);
      const res = f.results[i];
      return { ...bodyArrays(i), zones: { zone: res.zone, sphere: res.sphere, zones: res.zones, body: res.body }, parting };
    });
    const done = (each) => {
      batch.forEach(([i, { key }], n) => {
        if (f.placing.get(i) !== key) return; // asked for again since, for another parting
        f.placing.delete(i);
        if (feedingParting(i, r).key === key) f.placed.set(i, { key, ...each(n) });
      });
      if (r === state.result) refreshFeeding();
    };
    feedClient()
      .then((client) => client.placeFeedings(bodies))
      .then((placements) => done((n) => ({ placement: placements[n], error: null })))
      .catch((err) => done(() => ({ placement: null, error: err.message || String(err) })));
  }
}

const densityShown = () => {
  const d = parseFloat($("density").value);
  return d > 0 ? d : null;
};
const massOfVolume = (mm3, density = densityShown()) => (density && Number.isFinite(mm3) ? Math.round((mm3 / 1000) * density * 10) / 10 : null);

/**
 * What body i shows: {manual, risers, gate, yield, without (zones needing a
 * riser without one), placement, res}, or null (no zones yet, the parting
 * line still being computed, the risers being placed).
 */
function feedingField(i, r = state.result) {
  const f = feedingOf(r);
  const res = f?.results?.[i];
  if (!res || partingOf(r)?.pending) return null;
  const placed = feedingPlacement(i, r);
  if (!placed?.placement) return null;
  const manual = f.manual.get(i) ?? null;
  const risers = (manual?.risers ?? placed.placement.risers).map((x) => ({ ...x, mass_g: massOfVolume(x.volume_mm3) }));
  const gate = manual?.gate ?? placed.placement.gate;
  return {
    manual: !!(manual?.risers || manual?.gate),
    // The risers by hand (added, moved, resized or deleted), apart from the ingate.
    manualRisers: !!manual?.risers,
    risers,
    gate,
    yield: feedingYield(res.body.volume_mm3, risers, gate),
    without: hotSpotsWithoutRiser(res.zones, risers),
    placement: placed.placement,
    res,
  };
}

// ---- definitions kept in this browser: {part id: {savedAt, bodies: {index: {risers, gate}}}}

function feedingSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(FEEDING_KEY));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/**
 * What a definition by hand of body i of the model shown is of: its
 * triangles and the size of its box. The same file read in another unit, or
 * tessellated at another quality, has the same part id: its risers (in mm,
 * on zones of these triangles) are not put back on it.
 */
function feedingMeshTag(i) {
  const size = state.result.bodies[i].bbox?.size ?? [];
  return `${bodyArrays(i).indices.length / 3}|${size.map((x) => Number(x).toFixed(3)).join(",")}`;
}

function saveFeedingDef(partId, body, def) {
  if (!partId) return;
  const all = feedingSaved();
  const entry = all[partId] ?? { bodies: {} };
  if (def?.risers || def?.gate) entry.bodies[body] = { risers: def.risers ?? null, gate: def.gate ?? null, mesh: def.mesh ?? null };
  else delete entry.bodies[body];
  if (Object.keys(entry.bodies).length) all[partId] = { ...entry, savedAt: Date.now() };
  else delete all[partId];
  // The latest parts only.
  const ids = Object.keys(all).sort((a, b) => (all[b].savedAt ?? 0) - (all[a].savedAt ?? 0));
  for (const id of ids.slice(FEEDING_PARTS)) delete all[id];
  try {
    localStorage.setItem(FEEDING_KEY, JSON.stringify(all));
  } catch {
    // kept for this visit only
  }
}

const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const validRiser = (x) => x && typeof x === "object" && typeof x.id === "string" && isPoint(x.position_mm) && isPoint(x.axis) && x.diameter_mm > 0 && x.height_mm > 0;
const validGate = (x) => x && typeof x === "object" && isPoint(x.position_mm) && isPoint(x.direction);

// ---- computation

/** A new model is shown: its feeding zones, kept from an earlier opening, else computed in the background. */
function feedingNewModel(data) {
  const f = feedingOf(data);
  const kept = data.cachedFeeding;
  if (!f.results && kept?.version === FEEDING_VERSION && kept.bodies?.length === data.bodies.length) f.results = kept.bodies;
  if (f.results) restoreFeeding();
  else computeFeedings(data);
  renderFeeding();
}

/** Find the feeding zones of the closed bodies of the model shown, in the background. */
function computeFeedings(r) {
  const f = feedingOf(r);
  if (f.results || f.pending || r !== state.result) return;
  // The inscribed spheres of the wall thickness when computed now (the same values, on every
  // core); not those kept from an earlier opening, maybe by an older engine.
  const spheres = thick.results && thick.results !== r.cachedThickness ? thick.results : null;
  const bodies = r.bodies.map((b, i) => (b.closed ? { ...bodyArrays(i), sphere: spheres?.[i]?.sphere ?? null } : null));
  if (!bodies.some(Boolean)) {
    f.results = r.bodies.map(() => null);
    return;
  }
  f.error = null;
  f.percent = 0;
  f.pending = feedClient()
    .then((client) => client.computeFeeding(bodies, {
      onProgress: ({ percent }) => {
        f.percent = percent;
        if (r === state.result) renderFeeding();
      },
    }).then((results) => {
      f.results = results.bodies;
      client.saveFeeding(r.cacheKey, results);
    }))
    .catch((err) => {
      f.error = err.message || String(err);
    })
    .finally(() => {
      f.pending = null;
      if (r !== state.result) return;
      if (f.results) restoreFeeding();
      refreshFeeding();
    });
}

/** The definitions by hand kept for the part shown, once its zones are known. */
function restoreFeeding() {
  const r = state.result;
  const f = feedingOf(r);
  if (!f?.results || f.restored) return;
  f.restored = true;
  const defs = feedingSaved()[partIdOf(r)]?.bodies ?? {};
  for (const [key, def] of Object.entries(defs)) {
    const i = Number(key);
    if (!f.results[i] || !state.meshes[i]) continue;
    // Of this body as read now (not in another unit, nor at another quality).
    if (def?.mesh !== feedingMeshTag(i)) continue;
    const risers = Array.isArray(def?.risers) ? def.risers.filter(validRiser) : null;
    const gate = validGate(def?.gate) ? def.gate : null;
    if (risers || gate) f.manual.set(i, { risers, gate });
  }
}

/** The card and the markers again, and the published results: the parting, the zones or a definition changed. */
function refreshFeeding() {
  renderFeeding();
  applyFeeding();
  if (state.result) updatePublished(state.result);
}

// ---- edits by hand

/** The definition by hand of body i, changed by `edit({risers, gate})` (the risers: a copy of those shown). */
function editFeeding(i, edit) {
  const f = feedingOf();
  const field = feedingField(i);
  if (!field) return;
  const manual = f.manual.get(i) ?? { risers: null, gate: null };
  const next = { risers: manual.risers, gate: manual.gate };
  edit(next, field);
  if (next.risers || next.gate) f.manual.set(i, next);
  else f.manual.delete(i);
  saveFeedingDef(partIdOf(state.result), i, { ...next, mesh: feedingMeshTag(i) });
  refreshFeeding();
}

/** The risers shown, as a definition by hand to change (without the masses of the density shown). */
const manualRisers = (field) => field.risers.map(({ mass_g, ...x }) => x);

/** A new id for a riser placed by hand: M1, M2… */
function nextRiserId(risers) {
  let n = 1;
  while (risers.some((x) => x.id === `M${n}`)) n++;
  return `M${n}`;
}

/** Back to the proposal for body i. */
function resetFeeding(i) {
  const f = feedingOf();
  f.manual.delete(i);
  f.mode = null;
  f.selected = null;
  f.message = null;
  saveFeedingDef(partIdOf(state.result), i, null);
  refreshFeeding();
}

/**
 * 1, or -1 when the triangles of body i turn inwards (a mirrored CAD
 * instance, an inside-out mesh: shown as they are, only the sign of their
 * volume corrected): by the sign of its enclosed volume, once.
 */
function feedingOutward(i) {
  const f = feedingOf();
  let sign = f.outward.get(i);
  if (sign == null) {
    const { positions: P, indices: I } = bodyArrays(i);
    let volume = 0;
    for (let t = 0; t < I.length / 3; t++) {
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      volume += P[a] * (u[1] * v[2] - u[2] * v[1]) + P[a + 1] * (u[2] * v[0] - u[0] * v[2]) + P[a + 2] * (u[0] * v[1] - u[1] * v[0]);
    }
    sign = volume < 0 ? -1 : 1;
    f.outward.set(i, sign);
  }
  return sign;
}

/**
 * The point clicked in the frame of the mesh, its triangle and its outward
 * normal there (the normal of three.js follows the winding of the triangle:
 * turned outwards by the sign of the body).
 */
function feedingHit(hit, sign = 1) {
  const point = hit.object.worldToLocal(hit.point.clone());
  const n = hit.face?.normal;
  return { point: [point.x, point.y, point.z], triangle: hit.faceIndex ?? -1, normal: n ? [sign * n.x + 0, sign * n.y + 0, sign * n.z + 0] : null };
}

/** A click on the 3D view while placing a riser or the ingate: handled here (true), the selection unchanged. */
function feedingClick(hits) {
  const f = feedingOf();
  if (!f?.mode) return false;
  const i = feedingBody();
  if (!hits.length) return true;
  const hit = cardHit(hits, i);
  if (!hit) {
    f.message = t("feeding.otherBody");
    renderFeeding();
    return true;
  }
  const { point, triangle, normal } = feedingHit(hit, feedingOutward(i));
  const mode = f.mode;
  const field = feedingField(i);
  if (!field) return true;
  let riser = null;
  if (mode === "add" || mode === "move") {
    const moved = mode === "move" ? field.risers.find((x) => x.id === f.selected) : null;
    if (mode === "move" && !moved) {
      // The riser to move is no longer shown (another parting line, another body): nothing changed.
      f.mode = null;
      f.message = null;
      renderFeeding();
      return true;
    }
    // Moved: sized again from the zone it now touches, unless its D and H were typed in.
    const sized = moved?.sized_by_hand ? { diameter: moved.diameter_mm, height: moved.height_mm } : {};
    riser = riserFromPoint(point, { triangle, normal, zones: field.res, direction: field.placement.direction, id: moved?.id ?? nextRiserId(field.risers), ...sized });
    if (!riser) {
      // A face turned down: no riser under the part; another face to click.
      f.message = t("feeding.faceDown");
      renderFeeding();
      return true;
    }
  }
  f.mode = null;
  f.message = null;
  editFeeding(i, (next, field) => {
    if (mode === "gate") {
      const { positions, indices } = bodyArrays(i);
      const ctx = feedingContext(positions, indices, field.res, { parting: feedingParting(i).parting });
      next.gate = gateFromPoint(point, ctx, { triangle, normal });
      return;
    }
    const risers = manualRisers(field);
    if (mode === "add") {
      next.risers = [...risers, riser];
      f.selected = riser.id;
    } else next.risers = risers.map((x) => (x.id === riser.id ? riser : x));
  });
  return true;
}

/** Start or stop placing on the 3D view (a riser, a riser moved, the ingate); the parting line's modes stop. */
function setFeedingMode(mode) {
  const f = feedingOf();
  if (!f) return;
  f.mode = f.mode === mode ? null : mode;
  f.message = null;
  const p = partingOf();
  if (f.mode && p?.mode === "draw") leaveDrawing();
  else if (f.mode && p?.mode) {
    p.mode = null;
    renderParting();
  }
  // Placed on the 3D view: shown there.
  if (f.mode && !f.show) {
    f.show = true;
    applyFeeding();
  }
  renderFeeding();
}

// ---- 3D view

function removeFeedingOverlay(mesh) {
  const group = mesh.userData.feedingOverlay;
  if (!group) return;
  mesh.remove(group);
  group.traverse((o) => {
    if (o.userData.own) o.geometry?.dispose();
    o.material?.dispose();
  });
  mesh.userData.feedingOverlay = null;
}

/**
 * The risers and the ingate of the card's body on the 3D view ("Show"): a
 * cylinder for each riser (standing on the part, or beside it at the parting
 * line), the one selected lighter, and an arrow into the part for the
 * ingate; over whatever colours the view shows (the parting line, the
 * thickness), drawn after the halves of the mould (inside the upper one).
 * The other bodies faded while they are shown.
 */
function applyFeeding() {
  state.meshes.forEach(removeFeedingOverlay);
  const f = feedingOf();
  const i = feedingBody();
  const field = f?.show && i >= 0 && state.meshes[i] ? feedingField(i) : null;
  $("feeding-card").dataset.markers = field ? String(field.risers.length + (field.gate ? 1 : 0)) : "0";
  $("feeding-card").dataset.gateTip = "";
  // The other bodies faded, or given back (the colours of the view again).
  if (fadeStale()) applyThickness();
  if (!field) return;
  const mesh = state.meshes[i];
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  for (const riser of field.risers) {
    const radius = riser.diameter_mm / 2;
    const geometry = new THREE.CylinderGeometry(radius, radius, riser.height_mm, 40);
    const material = new THREE.MeshStandardMaterial({
      color: riser.id === f.selected ? RISER_SELECTED : RISER_COLOR,
      transparent: true, opacity: 0.6, depthWrite: false, clippingPlanes: [sectionPlane],
    });
    const cylinder = new THREE.Mesh(geometry, material);
    const axis = new THREE.Vector3(...riser.axis).normalize();
    cylinder.quaternion.setFromUnitVectors(up, axis);
    // Its base on the part (beside it for a side riser), its height along the axis.
    const base = new THREE.Vector3(...riser.position_mm);
    if (riser.offset) base.addScaledVector(new THREE.Vector3(...riser.offset), radius);
    cylinder.position.copy(base).addScaledVector(axis, riser.height_mm / 2);
    cylinder.renderOrder = ORDER_MARKERS;
    cylinder.userData.own = true;
    cylinder.userData.riser = riser.id;
    cylinder.userData.cap = "riser"; // a solid: closed by the section (syncCaps)
    group.add(cylinder);
  }
  if (field.gate) {
    // A solid arrow from outside the part, its tip at the ingate: the shaft as thick as the ingate, the cone as wide.
    const size = Math.max(...state.result.bodies[i].bbox.size);
    const length = Math.max(2 * (field.gate.width_mm ?? 0), 0.15 * size);
    const head = 0.35 * length;
    const coneRadius = Math.max((field.gate.width_mm ?? 0) / 2, 0.02 * size);
    const shaftRadius = Math.max((field.gate.thickness_mm ?? 0) / 2, 0.008 * size);
    const dir = new THREE.Vector3(...field.gate.direction).normalize();
    const tip = new THREE.Vector3(...field.gate.position_mm);
    // Opaque, but drawn with the translucent overlays: after the halves of the mould, not tinted by them.
    const material = new THREE.MeshStandardMaterial({ color: GATE_COLOR, transparent: true, opacity: 1, clippingPlanes: [sectionPlane] });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(coneRadius, head, 32), material);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftRadius, shaftRadius, length - head, 16), material.clone());
    for (const [part, along] of [[cone, head / 2], [shaft, head + (length - head) / 2]]) {
      // Cone and cylinder along +Y: turned to point along the ingate's direction, back from the tip.
      part.quaternion.setFromUnitVectors(up, dir);
      part.position.copy(tip).addScaledVector(dir, -along);
      part.renderOrder = ORDER_MARKERS;
      part.userData.own = true;
      part.userData.cap = "gate";
      group.add(part);
    }
  }
  mesh.add(group);
  mesh.userData.feedingOverlay = group;
  // Where the tip of the arrow is drawn (mm), for scripts and tests: the cone's apex, on the ingate's point.
  const cone = group.children.find((o) => o.userData.cap === "gate");
  if (cone) {
    cone.updateWorldMatrix(true, false);
    const apex = cone.localToWorld(new THREE.Vector3(0, cone.geometry.parameters.height / 2, 0));
    $("feeding-card").dataset.gateTip = JSON.stringify(apex.toArray().map((x) => Math.round(x * 1e4) / 1e4));
  }
}

// ---- card

const RISER_TYPES = { top: "feeding.type.top", side: "feeding.type.side" };

/** Why a riser or the ingate is there, in the language shown (the engine's `why` is French, for the exports). */
function feedingWhy(x) {
  const away = x.near_undercut == null ? "none" : !x.near_undercut && !x.near_riser ? "both" : !x.near_undercut ? "undercut" : !x.near_riser ? "riser" : "none";
  const params = {
    sphere: fmtNum(x.zone_sphere_mm, 1), modulus: fmtNum(x.modulus_mm, 2), riser: fmtNum(x.riser_modulus_mm, 2),
    // A riser's modulus over its zone's; under 1.2 (made smaller by hand), the zone is counted without a riser.
    ratio: x.modulus_mm > 0 ? fmtNum(x.riser_modulus_mm / x.modulus_mm, 2) : "—",
    short: x.riser_modulus_mm != null && !feeds(x) ? t("feeding.why.short") : "",
    wall: fmtNum(x.wall_sphere_mm, 1), thickness: fmtNum(x.thickness_mm, 1), width: fmtNum(x.width_mm, 1),
    away: t(`feeding.why.away.${away}`),
  };
  const key = `feeding.why.${x.reason}`;
  const text = t(key, params);
  return text === key ? x.why ?? "" : text;
}

function renderFeeding() {
  const card = $("feeding-card");
  const r = state.result;
  card.hidden = !r;
  if (!r) return;
  const f = feedingOf(r);
  const p = partingOf(r);
  // A crosshair while placing on the 3D view (here, or faces of the parting line).
  renderer.domElement.style.cursor = f.mode || p?.mode ? "crosshair" : "";
  const i = feedingBody();
  const field = i >= 0 ? feedingField(i) : null;
  const named = r.bodies.length > 1 && i >= 0;
  $("feeding-body").hidden = !named;
  if (named) $("feeding-body").textContent = t("parting.body", { name: r.bodies[i].name });
  let status = "";
  if (i < 0) status = t("feeding.none");
  else if (!r.bodies[i].closed) status = t("feeding.open");
  else if (f.pending) status = t("feeding.computing", { percent: f.percent != null ? `${f.percent} %` : "" });
  else if (f.error) status = t("feeding.error", { message: tMessage(f.error) });
  else if (p?.pending) status = t("feeding.waitParting");
  else if (f.results?.[i] && !field) {
    // Being placed in the worker, or not placed.
    const placed = f.placed.get(i);
    status = placed?.error && placed.key === feedingParting(i).key ? t("feeding.error", { message: tMessage(placed.error) }) : t("feeding.placing");
  }
  $("feeding-status").hidden = !status;
  $("feeding-status").textContent = status;
  $("feeding-retry").hidden = !((f.error && !f.pending) || (i >= 0 && f.placed.get(i)?.error));
  $("feeding-show").checked = f.show && !!field;
  $("feeding-show").disabled = !field;
  $("feeding-main").hidden = !field;
  card.dataset.status = !field ? "" : field.manual ? "manual" : "proposed";
  if (!field) return;

  const origin = $("feeding-origin");
  origin.textContent = t(field.manual ? "parting.manual" : "parting.proposed");
  origin.classList.toggle("manual", field.manual);
  $("feeding-count").textContent = String(field.risers.length);
  // The riser selected gone (another parting line, deleted) or another body: no selection, nothing to move.
  if (f.body !== i || (f.selected && !field.risers.some((x) => x.id === f.selected))) {
    f.body = i;
    f.selected = null;
    if (f.mode === "move") {
      f.mode = null;
      f.message = null;
      renderer.domElement.style.cursor = p?.mode ? "crosshair" : "";
    }
  }

  // The risers: a click selects one (to move, resize or delete it).
  const zones = field.res.zones;
  setHtml($("feeding-risers").tBodies[0], field.risers.map((x) => {
    const zone = zones[x.zone];
    const weight = x.mass_g == null ? fmtVol(x.volume_mm3) : x.mass_g >= 1000 ? `${fmtNum(x.mass_g / 1000, 2)} kg` : `${fmtNum(x.mass_g, 0)} g`;
    return `<tr class="${x.id === f.selected ? "selected" : ""}" data-riser="${escapeHtml(x.id)}" title="${escapeHtml(t("feeding.select.title"))}">` +
      `<td>${escapeHtml(x.id)}<br><span class="muted">${escapeHtml(t(RISER_TYPES[x.type] ?? x.type))}</span></td>` +
      `<td class="num">${zone ? `${zone.id + 1}<br><span class="muted">Ø ${fmtNum(zone.sphere_mm, 1)}</span>` : "—"}</td>` +
      `<td class="num">${fmtNum(x.modulus_mm, 2)}</td>` +
      `<td class="num">${fmtNum(x.diameter_mm, 1)} × ${fmtNum(x.height_mm, 1)}</td>` +
      `<td class="num">${escapeHtml(weight)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">${escapeHtml(t("feeding.noRiser"))}</td></tr>`);

  const selected = field.risers.find((x) => x.id === f.selected) ?? null;
  $("feeding-editor").hidden = !selected;
  $("feeding-why").hidden = !selected;
  if (selected) {
    if (document.activeElement !== $("feeding-d")) $("feeding-d").value = selected.diameter_mm;
    if (document.activeElement !== $("feeding-h")) $("feeding-h").value = selected.height_mm;
    $("feeding-why").textContent = feedingWhy(selected);
  }
  $("feeding-move").classList.toggle("active", f.mode === "move");
  $("feeding-add").classList.toggle("active", f.mode === "add");
  $("feeding-gate").classList.toggle("active", f.mode === "gate");

  const g = field.gate;
  const rows = [
    // None: no parting line, or no point of it reached from outside the mould.
    [t("feeding.gate"), g ? `${fmtPoint(g.position_mm)} mm` : t(feedingParting(i).parting?.segments?.length ? "feeding.gate.noneFree" : "feeding.gate.none")],
    ...(g ? [
      [t("feeding.gate.section"), t("feeding.gate.sectionValue", { thickness: fmtNum(g.thickness_mm, 1), width: fmtNum(g.width_mm, 1), area: fmtNum(g.section_mm2, 1) })],
      [t("feeding.gate.wall"), `Ø ${fmtNum(g.wall_sphere_mm, 1)} mm`],
    ] : []),
    [t("feeding.yield"), field.yield.value != null ? `${fmtNum(field.yield.value * 100, 1)} %` : "—"],
    ...(field.without.length ? [[t("feeding.without"), field.without.map((z) => z + 1).join(", ")]] : []),
  ];
  setHtml($("feeding-stats"), rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join(""));
  $("feeding-gate-why").hidden = !g;
  if (g) $("feeding-gate-why").textContent = feedingWhy(g);
  const sampled = field.res.sampled;
  $("feeding-sampled").hidden = !sampled;
  if (sampled) $("feeding-sampled").textContent = t("feeding.sampled", { samples: fmtNum(sampled.samples, 0), triangles: fmtNum(sampled.triangles, 0) });
  const hint = f.message ?? (f.mode ? t(`feeding.hint.${f.mode}`) : "");
  $("feeding-hint").hidden = !hint;
  $("feeding-hint").textContent = hint;
  $("feeding-reset").disabled = !field.manual;
  $("feeding-legend").innerHTML = t("feeding.legend");
}

/** The risers and ingate of body i of the result shown, for the exports and the semantic contract: {feeding} or {}. */
function feedingExport(r, i) {
  if (r !== state.result) return {};
  const field = feedingOf(r)?.results?.[i] ? feedingField(i, r) : null;
  if (!field) return {};
  const { res, placement } = field;
  return {
    feeding: {
      status: field.manual ? "manual" : "proposed",
      // The risers by hand or proposed, apart from the ingate (its own source).
      risers_status: field.manualRisers ? "manual" : "proposed",
      version: res.version ?? FEEDING_VERSION,
      method: FEEDING_METHOD,
      draw_direction: placement.direction,
      parting_known: placement.parting_known,
      risers: field.risers,
      gate: field.gate,
      yield: field.yield,
      hot_spots_without_riser: field.without,
      zones: res.zones.map(({ id, sphere_mm, modulus_mm, volume_share, needs_riser, small, hot_spot_mm, necks }) => ({ id, sphere_mm, modulus_mm, volume_share, needs_riser, small, hot_spot_mm, necks: necks.slice(0, 4) })),
      ...(field.manual ? { proposed: { risers: placement.risers.length, gate_position_mm: placement.gate?.position_mm ?? null } } : {}),
      neck_ratio: res.neck_ratio ?? null,
      sphere_source: res.sphere_source ?? null,
      sampled: res.sampled ?? null,
      body: res.body,
    },
  };
}

$("feeding-show").addEventListener("change", (e) => {
  const f = feedingOf();
  if (!f) return;
  f.show = e.target.checked;
  if (!f.show) f.mode = null;
  applyFeeding();
  renderFeeding();
});
$("feeding-retry").addEventListener("click", () => {
  const f = feedingOf();
  if (!f) return;
  f.error = null;
  // The placements that failed, asked for again.
  for (const [i, placed] of f.placed) if (placed.error) f.placed.delete(i);
  computeFeedings(state.result);
  refreshFeeding();
});
$("feeding-risers").addEventListener("click", (e) => {
  const row = e.target.closest("[data-riser]");
  const f = feedingOf();
  if (!row || !f) return;
  f.selected = f.selected === row.dataset.riser ? null : row.dataset.riser;
  if (f.mode === "move") f.mode = null;
  renderFeeding();
  applyFeeding();
});
$("feeding-add").addEventListener("click", () => setFeedingMode("add"));
$("feeding-gate").addEventListener("click", () => setFeedingMode("gate"));
$("feeding-move").addEventListener("click", () => setFeedingMode("move"));
$("feeding-delete").addEventListener("click", () => {
  const f = feedingOf();
  const i = feedingBody();
  if (!f?.selected || i < 0) return;
  const id = f.selected;
  f.selected = null;
  if (f.mode === "move") f.mode = null;
  editFeeding(i, (next, field) => {
    next.risers = manualRisers(field).filter((x) => x.id !== id);
  });
});
/** D or H of the selected riser typed in: its volume, modulus and mass follow. */
function resizeSelected() {
  const f = feedingOf();
  const i = feedingBody();
  if (!f?.selected || i < 0) return;
  const diameter = parseFloat($("feeding-d").value);
  const height = parseFloat($("feeding-h").value);
  if (!(diameter > 0) || !(height > 0)) return;
  editFeeding(i, (next, field) => {
    next.risers = manualRisers(field).map((x) => (x.id === f.selected && (x.diameter_mm !== diameter || x.height_mm !== height) ? resizeRiser(x, { diameter, height }) : x));
  });
}
$("feeding-d").addEventListener("change", resizeSelected);
$("feeding-h").addEventListener("change", resizeSelected);
$("feeding-reset").addEventListener("click", () => {
  const i = feedingBody();
  if (i >= 0) resetFeeding(i);
});
// Esc stops placing on the 3D view. Drawing by hand: its keys (the arrows, Undo, Enter, Delete, Esc).
document.addEventListener("keydown", (e) => {
  if (drawKey(e)) return;
  if (e.key !== "Escape") return;
  const f = feedingOf();
  if (!f?.mode) return;
  f.mode = null;
  f.message = null;
  renderFeeding();
});

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
  leaveDrawing(); // drawing by hand: left (the drawing kept), its turn of the view ended
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
    stopInertia();
    controls.update();
    Object.assign(thick, view.thick);
    thick.statsHtml = null;
    // The thickness colours turned on in another tab (they are the page's): its parting no longer shown.
    if (thick.colors || thick.highlight) partingOff();
    showWireframe($("toggle-wire").classList.contains("active"));
    $("drop-hint").hidden = true;
    $("refresh").disabled = false;
    renderPanel();
    select(state.selected);
    if (view.thickReady) adoptThickness(thick.results);
    applyThickness();
    renderThickness();
    renderParting();
    restoreParting();
    restoreFeeding();
    renderFeeding();
    applyFeeding();
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
    renderParting();
    renderFeeding();
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
  if (tab === activeTab) {
    renderLoading();
    // Its openFile ends without a word (another seq): the status is no longer "analysing".
    if (document.body.dataset.status === "analysing") setStatus(tab.result ? "done" : "idle");
  }
  renderTabs();
}

/**
 * The id of the part a file holds, for the history of the IA page
 * (ai-history.js): "sha256:<hex>" of the file, as the browser's analysis read
 * it (its result's cacheKey), else computed (server engine).
 */
async function partIdFor(file, data) {
  const hash = /^\d+\|([0-9a-f]{64})\|/.exec(data?.cacheKey ?? "")?.[1];
  if (hash) return `sha256:${hash}`;
  return import("./ai-history.js").then(({ partIdOf }) => partIdOf(file)).catch(() => null);
}

/** Close a tab: its model and its quote are forgotten. */
function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  cancelTab(tab);
  if (tab === activeTab) clearModel();
  else if (tab.view) disposeObjects(tab.view.meshes);
  partingAbandon(tab.result);
  tab.view = tab.result = tab.file = tab.part = null;
  tabs.splice(i, 1);
  forgetQuote(tab.id);
  forgetConversation(tab.id);
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

// The conversation of the IA page of a tab (ai-workspace.js: one per tab, in
// sessionStorage, the first tab's under the key of earlier versions).
const conversationKey = (id) => (id === 1 ? "reader3d.ai.messages" : `reader3d.ai.messages.${id}`);

/** Forget the conversation of the IA page of the tab `id` (closed). */
function forgetConversation(id) {
  try {
    sessionStorage.removeItem(conversationKey(id));
  } catch {
    // no storage
  }
  aiWorkspace?.then((ui) => ui.forgetTab?.(id)).catch(() => {});
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
    // A conversation of the history opened in its own tab: its part's name, its model not open.
    const chatOnly = !tab.loading && !tab.file && !!tab.part?.file;
    const name = tab.loading?.file ?? tab.file?.name ?? tab.part?.file ?? null;
    const el = document.createElement("div");
    el.className = "doc-tab";
    el.classList.toggle("active", tab === activeTab);
    el.classList.toggle("busy", !!tab.loading);
    el.classList.toggle("chat-only", chatOnly);
    el.dataset.tab = tab.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(tab === activeTab));
    el.title = chatOnly ? t("tabs.chatOnly", { name }) : name ?? t("tabs.new");
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

/** A tab as window.reader3d gives it: {id, file (its name), part ({id, file}: the part it shows or its conversation is about, once known)}. */
function tabInfo(tab) {
  return { id: tab.id, file: tab.file?.name ?? null, part: tab.part?.id ? { id: tab.part.id, file: tab.part.file ?? null } : null };
}

function setStatus(status, message = "") {
  const changed = document.body.dataset.status !== status;
  document.body.dataset.status = status;
  if (message) document.body.dataset.error = message;
  else delete document.body.dataset.error;
  // The IA page says when the part is still analysed: told when it is no longer.
  if (changed) document.dispatchEvent(new CustomEvent("reader3d-status"));
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
let semanticKept = null; // {result, density, method, key (bodies), semantic}
let semanticPending = null; // idle callback writing #reader3d-semantic-result

/** The semantic contract of the result shown (null without one): of the bodies checked, or of these bodies (indices into r.bodies). */
function currentSemantic(indices = includedIndices()) {
  const r = state.result;
  if (!r) return null;
  const density = $("density").value;
  // The thickness method changes the statistics exported without republishing.
  const method = thickMethod();
  const key = indices.join(",");
  if (semanticKept?.result !== r || semanticKept.density !== density || semanticKept.method !== method || semanticKept.key !== key) {
    // Each body with its index in r.bodies (what setSelection takes).
    const data = exportableResult(r, indices);
    data.bodies = data.bodies.map((b, k) => ({ ...b, source_index: indices[k] }));
    semanticKept = { result: r, density, method, key, semantic: buildSemantic3D(data) };
  }
  return semanticKept.semantic;
}

/**
 * The bodies the IA page sends: the body selected in the list (its row
 * clicked) when there is one, else the bodies checked; and which they are,
 * for the page to say it (names never sent: the context has the counts).
 */
function aiPart({ withSemantic = true } = {}) {
  const r = state.result;
  if (!r) return null;
  const selected = state.selected >= 0 && state.selected < r.bodies.length;
  const indices = selected ? [state.selected] : includedIndices();
  return {
    // Seconds on a large part: not built when only the scope is wanted.
    semantic: withSemantic && indices.length ? currentSemantic(indices) : null,
    scope: {
      mode: selected ? "selected" : indices.length === r.bodies.length ? "all" : "checked",
      bodies_sent: indices.length,
      bodies_in_file: r.bodies.length,
      names: indices.map((i) => r.bodies[i].name),
      // Every body, sent or not, for the anonymizer of the IA page only: a question may name one not sent.
      all_names: r.bodies.map((b) => b.name),
      file: r.file ?? null,
    },
  };
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
  /** For the IA page: {semantic, scope} of the body selected in the list, else of the bodies checked (null without a result). */
  aiPart(options) {
    return aiPart(options);
  },
  get result() {
    return state.result ? exportableResult(state.result) : null;
  },
  get status() {
    return document.body.dataset.status ?? "idle";
  },
  /** Where the 3D view looks from: the camera's position and up, and the point it turns about (mm). */
  get view() {
    return { position: camera.position.toArray(), up: camera.up.toArray(), target: controls.target.toArray() };
  },
  /** Where a point of the model ([x, y, z] mm) is on the page: {x, y} in client pixels, or null behind the camera. */
  screenOf(point) {
    return screenOf(point);
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
  /**
   * The costing of the tab shown, read only (chiffrage/ui.js costingSnapshot):
   * its traced values, best routes, alerts and data files; null without a
   * costing workbook. Also when the costing page was never opened.
   */
  async costing() {
    const tab = activeTab?.id; // the tab shown when asked
    const ui = await import("./chiffrage/ui.js");
    return ui.costingSnapshot({ tab });
  },
  /** The tab shown: its id and the name of the file of its part (null: none). The IA page keeps a conversation per tab. */
  get tab() {
    return activeTab ? tabInfo(activeTab) : null;
  },
  /** Every tab of the 3D page: [{id, file, part}]. */
  get tabs() {
    return tabs.map(tabInfo);
  },
  /** Show the tab `id` of the 3D page (the page shown stays). */
  showTab(id) {
    const tab = tabs.find((x) => x.id === id);
    if (tab && tab !== activeTab) showTab(tab);
  },
  /**
   * A tab for a conversation of the history of the IA page: its part ({id,
   * file}) known, its model not open. A new one; the tab shown when `reuse`
   * and it is empty (no file, no part, nothing being opened): no empty tab
   * left behind. `before(id)` is called with the tab's id before it is shown
   * (its conversation written). Returns that id.
   */
  openPartTab(part, before, { reuse = false } = {}) {
    const empty = reuse && activeTab && !activeTab.file && !activeTab.result && !activeTab.loading && !activeTab.part?.id;
    const tab = empty ? activeTab : createTab();
    tab.part = { id: part?.id ?? null, file: part?.file ?? null };
    before?.(tab.id);
    if (tab === activeTab) {
      renderTabs();
      document.dispatchEvent(new CustomEvent("reader3d-part"));
    } else showTab(tab);
    return tab.id;
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
  renderParting();
  renderFeeding();
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
// The tabs start again: the conversations of the IA page of the tabs of the
// page before a reload are forgotten, but the first tab's (as its quote).
try {
  for (const key of Object.keys(sessionStorage)) if (key.startsWith(`${conversationKey(1)}.`)) sessionStorage.removeItem(key);
} catch {
  // no storage
}
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
