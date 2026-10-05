import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyToPage, language, locale, setLanguage, t, tMessage } from "./i18n.js";

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

const STEP_TEXT = { read: "loading.read", mesh: "loading.mesh", measure: "loading.measure", summary: "loading.summary" };

function describeProgress(p) {
  switch (p.stage) {
    case "download":
      return p.total
        ? [t("loading.download", { loaded: fmtMB(p.loaded), total: fmtMB(p.total) }), p.loaded / p.total]
        : [t("loading.downloadNoTotal", { loaded: fmtMB(p.loaded) }), null];
    case "compile":
      return [t("loading.compile"), null];
    case "analyze":
      return [t(STEP_TEXT[p.step] ?? "loading.analysing"), p.percent == null ? null : p.percent / 100];
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

let serverRequest = null; // AbortController of the request in progress

async function analyzeOnServer(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("unit", $("unit").value);
  form.append("quality", $("quality").value);
  serverRequest = new AbortController();
  setLoading(t("loading.upload"), null);
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
      if (p.stage === "analyze" && p.engine === "cad" && engineStage !== "ready") showEngineStatus({ stage: "ready" });
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
  if (currentEngine() === "browser" && !(await memoryCheck(file))) return;
  $("error").hidden = true;
  setLoading(t("loading.analysing"));
  $("loading-file").textContent = file.name;
  $("loading").hidden = false;
  setStatus("analysing");
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
    publishResult(data);
    setStatus("done");
    afterAnalysisMemory();
  } catch (err) {
    const cancelled = err.cancelled || err.name === "AbortError";
    if (seq === openSeq && !cancelled) {
      const message = tMessage(err.message || String(err));
      showError(`${file.name}: ${message}`);
      setStatus("error", message);
    }
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
  const how = r.kind === "cad" ? t("method.cad") : t("method.mesh", { unit: r.source_unit });
  const notes = [];
  if (estimated) notes.push(t("method.estimated", { n: estimated }));
  if (s.open_bodies > 0) notes.push(t("method.open", { n: s.open_bodies }));
  method.textContent = s.volume == null ? t("method.none") : [how, ...notes].join(" ");

  $("total-area").textContent = fmtArea(s.area);
  $("bbox-size").textContent = fmtSize(s.bbox.size);
  $("bbox-volume").textContent = fmtVol(s.bbox.volume);
  $("obb-size").textContent = s.obb ? fmtSize(s.obb.size) : "—";
  $("fill").textContent = s.fill_ratio == null ? "—" : `${fmtNum(s.fill_ratio * 100, 2)} %`;
  $("centroid").textContent = fmtPoint(s.centroid);
  $("body-count").textContent = s.open_bodies ? t("summary.bodiesOpen", { bodies: s.bodies, open: s.open_bodies }) : `${s.bodies}`;

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
    vis.title = t("bodies.showHide");
    vis.addEventListener("click", (e) => e.stopPropagation());
    vis.addEventListener("change", () => (state.meshes[i].visible = vis.checked));

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
    summary: { ...r.summary, mass: mass(r.summary.volume) },
    bodies: r.bodies.map(({ mesh, ...b }) => ({ ...b, mass: mass(b.volume) })),
    elapsed_s: r.elapsed_s,
  };
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
    "xlsx.cx", "xlsx.cy", "xlsx.cz", "xlsx.mass", "xlsx.closed", "xlsx.notes"].map((k) => t(k));
  const yesNo = (v) => t(v ? "xlsx.yes" : "xlsx.no");
  const row = (name, x, notes) => [
    name, x.volume, x.volume == null ? null : x.volume / 1000, x.area, ...x.bbox.size,
    ...(x.centroid ?? [null, null, null]), x.mass, yesNo(x.closed), notes,
  ];
  const rows = data.bodies.map((b) => row(b.name, b, b.notes.map(tMessage).join(" ; ")));
  const s = data.summary;
  rows.push(row(t("xlsx.total"), { ...s, closed: data.bodies.every((b) => b.closed) }, ""));
  return [head, ...cleanRows(rows, Math.max(...s.bbox.size, 1e-12))];
}

async function exportXlsx() {
  const r = state.result;
  if (!r) return;
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
  ].map(([k, v]) => [k, k === t("xlsx.fill") || k === t("xlsx.density") ? v : cleanRows([[v]], Math.max(...s.bbox.size, 1e-12))[0][0]]);
  const table = tableRows(data);
  const total = table.length - 1;
  table[total] = table[total].map((v, i) => (i === 0 ? { value: v, style: STYLE.totalText } : typeof v === "number" ? { value: v, style: STYLE.totalNumber } : v));
  const bytes = buildXlsx([
    { name: t("xlsx.bodies"), rows: table, header: true, widths: [28, 18, 16, 18, 16, 16, 16, 18, 18, 18, 14, 12, 50] },
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

function exportCsv() {
  const r = state.result;
  if (!r) return;
  // French spreadsheet software expects ";" between cells and a decimal comma.
  const fr = language() === "fr";
  const sep = fr ? ";" : ",";
  const cell = (v) => (typeof v === "number" ? (fr ? String(v).replace(".", ",") : String(v)) : v == null ? "" : csvText(v));
  const lines = tableRows(exportableResult(r)).map((row) => row.map(cell).join(sep));
  // The BOM makes spreadsheet software read the names as UTF-8.
  download(`${baseName(r)}_volume.csv`, new Blob(["\ufeff" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
}

function exportJson() {
  const r = state.result;
  if (!r) return;
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
$("export-xlsx").addEventListener("click", () => exportXlsx().catch((err) => showError(err.message)));
$("export-json").addEventListener("click", exportJson);

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

// ---------------------------------------------------------------- memory gauge

// The CAD engine runs in WebAssembly, whose memory (heap) only grows, up to
// 4 GiB, and is never given back. The browser stops a page that asks for more
// than the device can give: the gauge compares what the analysis uses (or will
// use, estimated from the file size) with what it can safely get.
const GiB = 2 ** 30;
const WASM_MAX = 4294901760;
const memory = { heap: 0, estimate: null, restarted: false };

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
  const rows = [
    [t("memory.cad"), of(memory.heap, budget)],
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
    "",
    "name | volume_mm3 | area_mm2 | size_x_mm | size_y_mm | size_z_mm | closed",
    ...data.bodies.map((b) => [b.name, b.volume ?? "—", b.area, ...b.bbox.size, b.closed].map((v) => (typeof v === "number" ? +v.toPrecision(10) : v)).join(" | ")),
  ];
  return lines.join("\n");
}

function publishResult(r) {
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
  const format = params.get("export");
  if (format === "json") exportJson();
  else if (format === "xlsx") exportXlsx().catch((err) => showError(err.message));
  else if (format === "csv") exportCsv();
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
};

// ---------------------------------------------------------------- language

function applyLanguage() {
  applyToPage();
  $("language").value = language();
  showEngineStatus(null);
  renderPanel();
  renderMemory();
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
applyLanguage();
setStatus("idle");
initEngines().then(() => {
  const url = params.get("url");
  if (url) {
    state.noPrompt = true;
    openUrl(url);
  }
});
