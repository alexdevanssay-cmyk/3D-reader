import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  if (abs !== 0 && abs < 1) return v.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function volUnit() { return VOL_UNITS[$("vol-unit").value]; }
function fmtVol(mm3) { const u = volUnit(); return mm3 == null ? "—" : `${fmtNum(mm3 / u.factor)} ${u.label}`; }
function fmtArea(mm2) { const u = volUnit(); return mm2 == null ? "—" : `${fmtNum(mm2 / u.areaFactor)} ${u.area}`; }
// Coordinates: hide floating-point noise such as 2.9e-14 around zero.
function fmtPoint(p) { return p ? p.map((x) => fmtNum(Math.abs(x) < 1e-6 ? 0 : x, 2)).join(", ") : "—"; }
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

function clearModel() {
  for (const obj of [...modelGroup.children]) {
    modelGroup.remove(obj);
    obj.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
  state.meshes = [];
  state.edges = [];
  state.selected = -1;
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
    modelGroup.add(mesh);
    state.meshes.push(mesh);

    const edges = new THREE.LineSegments(
      new THREE.WireframeGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, clippingPlanes: [sectionPlane] }),
    );
    edges.visible = $("toggle-wire").classList.contains("active");
    mesh.add(edges);
    state.edges.push(edges);
  });

  const s = result.summary.bbox;
  state.bounds.set(new THREE.Vector3(...s.min), new THREE.Vector3(...s.max));

  if (boxHelper) scene.remove(boxHelper);
  boxHelper = new THREE.Box3Helper(state.bounds, 0xff8800);
  boxHelper.visible = $("toggle-box").classList.contains("active");
  scene.add(boxHelper);

  if (axes) scene.remove(axes);
  const size = state.bounds.getSize(new THREE.Vector3());
  axes = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.25);
  scene.add(axes);

  updateSection();
  setView("iso");
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
  engine.browserClient ??= import("./engine/client.js");
  return engine.browserClient;
}

function fmtMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function setLoading(text, fraction = null) {
  $("loading-text").textContent = text;
  const bar = $("loading-bar");
  bar.hidden = fraction === null;
  if (fraction !== null) bar.value = fraction;
}

function describeProgress(p) {
  switch (p.stage) {
    case "download":
      return p.total
        ? [`Downloading the CAD engine… ${fmtMB(p.loaded)} / ${fmtMB(p.total)}`, p.loaded / p.total]
        : [`Downloading the CAD engine… ${fmtMB(p.loaded)}`, null];
    case "compile":
      return ["Starting the CAD engine…", null];
    case "parse":
      return ["Reading the file…", null];
    case "summary":
      return ["Computing the envelope…", null];
    default:
      return ["Analysing…", null];
  }
}

// Small status chip showing whether the CAD engine (WebAssembly) is ready.
function showEngineStatus(p) {
  const el = $("engine-status");
  if (currentEngine() !== "browser") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle("ready", p.stage === "ready");
  el.classList.toggle("error", p.stage === "error");
  if (p.stage === "download" && p.total) el.textContent = `CAD engine ${Math.round((p.loaded / p.total) * 100)} %`;
  else if (p.stage === "download" || p.stage === "compile") el.textContent = "CAD engine loading…";
  else if (p.stage === "ready") el.textContent = "CAD engine ready";
  else if (p.stage === "idle") el.textContent = "CAD engine not loaded";
  else if (p.stage === "error") {
    el.textContent = "CAD engine unavailable";
    el.title = p.message || "";
  }
}

let serverRequest = null; // AbortController of the request in progress

async function analyzeOnServer(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("unit", $("unit").value);
  form.append("quality", $("quality").value);
  serverRequest = new AbortController();
  // Aborting the request also stops the analysis on the server.
  const res = await fetch("api/analyze", { method: "POST", body: form, signal: serverRequest.signal });
  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`);
  return data;
}

async function analyzeInBrowser(file) {
  const client = await browserClient();
  return client.analyzeInBrowser(file, {
    unit: $("unit").value,
    quality: $("quality").value,
    onProgress: (p) => {
      setLoading(...describeProgress(p));
      if (p.stage === "download" || p.stage === "compile") showEngineStatus(p);
      if (p.stage === "analyze" && p.engine === "cad") showEngineStatus({ stage: "ready" });
    },
  });
}

let openSeq = 0;

// Stop the analysis in progress, if any: a newer file was opened, or Cancel.
async function stopAnalysis() {
  serverRequest?.abort();
  serverRequest = null;
  if (engine.browserClient) (await engine.browserClient).cancelAll();
}

async function openFile(file) {
  if (!file) return;
  const seq = ++openSeq;
  // The new file must not wait behind an abandoned one (the browser engine
  // handles one file at a time, and server slots are limited).
  await stopAnalysis();
  if (seq !== openSeq) return;
  $("error").hidden = true;
  setLoading("Analysing…");
  $("loading-file").textContent = file.name;
  $("loading").hidden = false;
  try {
    const data = currentEngine() === "server" ? await analyzeOnServer(file) : await analyzeInBrowser(file);
    if (seq !== openSeq) return;
    // Only now does the page show this file (a failed file leaves the previous one).
    state.file = file;
    state.result = data;
    $("file-name").textContent = file.name;
    $("drop-hint").hidden = true;
    buildModel(data);
    renderPanel();
  } catch (err) {
    const cancelled = err.cancelled || err.name === "AbortError";
    if (seq === openSeq && !cancelled) showError(`${file.name}: ${err.message || err}`);
  } finally {
    if (seq === openSeq) $("loading").hidden = true;
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
  const s = r.summary;

  for (const id of ["summary-card", "mass-card", "bodies-card"]) $(id).hidden = false;

  // Meshes with holes get a volume estimated after filling them (not closed, but a volume).
  const estimated = r.bodies.filter(isEstimate).length;
  $("total-volume").textContent = (estimated ? "≈ " : "") + fmtVol(s.volume);
  const method = $("method");
  method.classList.toggle("warn", s.open_bodies > 0 || s.volume == null || estimated > 0);
  const how = r.kind === "cad"
    ? "Exact volume computed on the CAD B-rep geometry (OpenCascade)."
    : `Volume enclosed by the closed triangle mesh. Source unit: ${r.source_unit}.`;
  const notes = [];
  if (estimated) notes.push(`${estimated} body/bodies had holes: volume estimated after filling them.`);
  if (s.open_bodies > 0) notes.push(`${s.open_bodies} open body/bodies excluded from the volume.`);
  method.textContent = s.volume == null
    ? "No closed solid in this file: the volume cannot be computed."
    : [how, ...notes].join(" ");

  $("total-area").textContent = fmtArea(s.area);
  $("bbox-size").textContent = fmtSize(s.bbox.size);
  $("bbox-volume").textContent = fmtVol(s.bbox.volume);
  $("obb-size").textContent = s.obb ? fmtSize(s.obb.size) : "—";
  $("fill").textContent = s.fill_ratio == null ? "—" : `${fmtNum(s.fill_ratio * 100, 2)} %`;
  $("centroid").textContent = fmtPoint(s.centroid);
  $("body-count").textContent = s.open_bodies ? `${s.bodies} (${s.open_bodies} open)` : `${s.bodies}`;

  updateMass();
  renderBodies();
}

function isEstimate(body) {
  return !body.closed && body.volume != null;
}

function updateMass() {
  const r = state.result;
  if (!r) return;
  $("mass").textContent = fmtMass(r.summary.volume, parseFloat($("density").value));
  renderBodyDetail();
}

function renderBodies() {
  const r = state.result;
  const tbody = $("bodies");
  tbody.innerHTML = "";
  const total = r.summary.volume || 0;
  r.bodies.forEach((b, i) => {
    const tr = document.createElement("tr");
    tr.dataset.index = i;
    if (i === state.selected) tr.classList.add("selected");
    const color = state.meshes[i].material.color.getHexString();

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = state.meshes[i].visible;
    vis.title = "Show / hide";
    vis.addEventListener("click", (e) => e.stopPropagation());
    vis.addEventListener("change", () => (state.meshes[i].visible = vis.checked));

    const td0 = document.createElement("td");
    td0.appendChild(vis);
    tr.appendChild(td0);
    tr.insertAdjacentHTML(
      "beforeend",
      `<td class="name" title="${escapeHtml(b.name)}"><span class="swatch" style="background:#${color}"></span>${escapeHtml(b.name)}</td>` +
        `<td class="num ${b.volume == null || isEstimate(b) ? "open" : ""}">${b.volume == null ? "open" : (isEstimate(b) ? "≈ " : "") + fmtVol(b.volume)}</td>` +
        `<td class="num">${b.volume != null && total ? fmtNum((b.volume / total) * 100, 1) : ""}</td>`,
    );
    tr.addEventListener("click", () => select(i === state.selected ? -1 : i));
    tbody.appendChild(tr);
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
    ["Real volume", fmtVol(b.volume)],
    ["Mass", fmtMass(b.volume, density)],
    ["Surface area", fmtArea(b.area)],
    ["Envelope", fmtSize(b.bbox.size)],
    ["Centre of mass (mm)", fmtPoint(b.centroid)],
    ["Triangles (display)", fmtNum(b.triangles, 0)],
  ];
  if (b.method === "brep" && b.volume != null && b.mesh_volume != null) {
    const dev = ((b.mesh_volume - b.volume) / b.volume) * 100;
    rows.push(["Display mesh volume", `${fmtVol(b.mesh_volume)} (${dev >= 0 ? "+" : ""}${fmtNum(dev, 3)} %)`]);
  }
  el.innerHTML =
    `<h4>${escapeHtml(b.name)}</h4><dl class="stats">` +
    rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") +
    "</dl>" +
    b.notes.map((n) => `<div class="note">⚠ ${escapeHtml(n)}</div>`).join("");
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

// A CSV cell. Text starting with = + - @ would be run as a formula by spreadsheet
// software (names come from the file, so they are not trusted).
function csvText(text) {
  const t = String(text);
  return `"${(/^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`;
}

function exportCsv() {
  const r = state.result;
  if (!r) return;
  const density = parseFloat($("density").value);
  const mass = (v) => (v != null && Number.isFinite(density) && density >= 0 ? (v / 1000) * density : "");
  const head = ["name", "volume_mm3", "area_mm2", "size_x_mm", "size_y_mm", "size_z_mm", "cx_mm", "cy_mm", "cz_mm", "closed", "mass_g"];
  const lines = [head.join(",")];
  for (const b of r.bodies) {
    const c = b.centroid || ["", "", ""];
    lines.push([csvText(b.name), b.volume ?? "", b.area, ...b.bbox.size, ...c, b.closed, mass(b.volume)].join(","));
  }
  const s = r.summary;
  lines.push([csvText("TOTAL"), s.volume ?? "", s.area, ...s.bbox.size, ...(s.centroid || ["", "", ""]),
    s.open_bodies === 0, mass(s.volume)].join(","));
  // The BOM makes spreadsheet software read the names as UTF-8.
  const blob = new Blob(["\ufeff" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = r.file.replace(/\.[^.]+$/, "") + "_volume.csv";
  a.click();
  URL.revokeObjectURL(a.href);
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

$("open-file").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = ""; // allow re-opening the same file
});
// Some malformed CAD files make OpenCascade run for a very long time.
$("cancel").addEventListener("click", () => {
  openSeq++; // forget the file being analysed
  $("loading").hidden = true;
  stopAnalysis();
});
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

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("fit").addEventListener("click", () => setView(null));

$("toggle-wire").addEventListener("click", (e) => {
  const on = e.currentTarget.classList.toggle("active");
  state.edges.forEach((l) => (l.visible = on));
});
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
$("export-csv").addEventListener("click", exportCsv);

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
  openFile(e.dataTransfer.files[0]);
});

initEngines();
