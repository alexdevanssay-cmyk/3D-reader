// Costing pages: "Chiffrage" (quote of the part shown in the 3D view) and
// "Paramètres" (TRS, islands, methods, rates of increase). French only: the
// costing follows the SAB costing workbook, in French.

import { MODES, readCostingWorkbook, readIndicesWorkbook } from "./workbook.js";
import { centreRates, indexAverage, quote, saleMetalPrice, solveMargin as minimumMargin } from "./model.js";
import { bestRoutes, buildRoute, rankRoutes } from "./routes.js";
import { estimateTooling } from "./tooling.js";
import { coreBoxCost, coresPerPiece, newCore } from "./cores.js";
import { programmeOf, readSeriesOrder } from "./rfq.js";
import * as store from "./store.js";

let el = null;
let page = "chiffrage";
let base = store.loadBase();
let indices = store.loadIndices();
let settings = store.loadSettings(base);
let q = store.loadQuote(base, indices);
let message = null; // {kind: "ok" | "error", text}
let thicknessBusy = false;

export function mount(targets) {
  el = targets;
  for (const container of Object.values(el)) {
    container.addEventListener("change", onChange);
    container.addEventListener("click", onClick);
    container.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, [data-action]")) pointerDown = true;
    }, true);
  }
  document.addEventListener("reader3d-part", () => {
    if (!el.chiffrage.hidden) render();
  });
  return { show };
}

export function show(name) {
  page = name;
  render();
}

// --------------------------------------------------------------------------- formatting

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = (v, digits = 2) => (Number.isFinite(v) ? v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—");
const eur = (v, digits = 3) => (Number.isFinite(v) ? `${nf(v, digits)} €` : "—");
const pct = (v, digits = 1) => (Number.isFinite(v) ? `${nf(v * 100, digits)} %` : "—");
const monthLabel = (m) => {
  const [y, mo] = String(m).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
};
const dateLabel = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");
// Inputs of the user (the others are defaults from the workbook).
const USER_FIELDS = ["client", "reference", "designation", "plan", "volumeAnnuel", "annees", "premiereAnnee", "volumes", "pieces", "pieceFile", "serie", "moqs", "prixCible", "serieEnergie", "outillageInclus", "margeOutillage", "prototype"];
// Inputs of each piece (q.pieces[key]); null: from the 3D model or estimated.
const PIECE_DEFAULTS = {
  poids: null, toileMini: null, epaisseurMax: null, moduleMm: null, dimMax: null,
  tth: null, // heat treatment (code of settings.tth or "none"); null: the one of the customer request, else none
  tthMode: "scie", // weight treated: the piece ("scie": feeders sawn off before) or the casting with its feeders
  noyaux: false, sableKg: 0, tribo: false, redressage: false,
  procede: "auto", finition: "auto", mode: null, cycle: null, empreintes: null, miseAuMille: null,
  outillagePrix: null, // € of the tooling; null: estimated
  cores: [], // sand cores (cores.js): {nom, masse kg, qte per piece, L, l, h box mm, type, tiroirs, complexite}
  composants: [],
};
function pieceInputs(key) {
  const i = { ...PIECE_DEFAULTS, ...q.pieces?.[key] };
  // Saved by an earlier version: tth was "scie" / "masselotte" (a T6).
  if (i.tth === "scie" || i.tth === "masselotte") [i.tth, i.tthMode] = ["T6", i.tth];
  i.tth ??= q.serie?.tth ?? "none";
  return i;
}
function pieceStore(key) {
  q.pieces ??= {};
  return (q.pieces[key] ??= {});
}
let currentKey = "manuel"; // piece shown (set at each rendering)
const UO = { kgCast: "kg coulé", kgSold: "kg", pph: "h", hour: "h" };

// Form fields. data-bind: "q.<path>" (quote) or "s.<path>" (settings);
// data-kind: num (number, empty = null), pct (percent shown, ratio stored), text, bool, raw (select value).
function input(bind, value, { kind = "num", step = "any", min, placeholder = "", width } = {}) {
  const shown = value === null || value === undefined ? "" : kind === "pct" ? +(value * 100).toFixed(4) : kind === "list" ? value.join(" ; ") : value;
  const type = kind === "text" || kind === "list" ? "text" : "number";
  return `<input type="${type}" data-bind="${esc(bind)}" data-kind="${kind}" value="${esc(shown)}"${type === "number" ? ` step="${step}"` : ""}${min !== undefined ? ` min="${min}"` : ""} placeholder="${esc(placeholder)}"${width ? ` style="width:${width}"` : ""}>`;
}

function select(bind, value, options, { kind = "raw" } = {}) {
  const opts = options
    .map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${String(v) === String(value ?? "") ? " selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
  return `<select data-bind="${esc(bind)}" data-kind="${kind}">${opts}</select>`;
}

const checkbox = (bind, value, label) =>
  `<label class="check"><input type="checkbox" data-bind="${esc(bind)}" data-kind="bool"${value ? " checked" : ""}> ${esc(label)}</label>`;

const field = (label, control, hint = "") => `<label class="cf"><span>${esc(label)}</span>${control}${hint ? `<small>${hint}</small>` : ""}</label>`;

// --------------------------------------------------------------------------- state changes

function setPath(root, path, value) {
  const keys = path.split(".");
  let o = root;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

function readValue(target) {
  const kind = target.dataset.kind;
  if (kind === "bool") return target.checked;
  const raw = target.value.trim();
  if (kind === "text" || kind === "raw") return raw;
  if (kind === "nullraw") return raw === "" ? null : raw;
  // Positive whole numbers separated by ";", "," or spaces, largest first (order quantities).
  if (kind === "list") return [...new Set(raw.split(/[;,\s]+/).map((x) => Math.round(Number(x))).filter((n) => n > 0))].sort((a, b) => b - a);
  if (raw === "") return null;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (kind === "pct") return n / 100;
  return n;
}

function onChange(event) {
  const target = event.target;
  const bind = target.dataset.bind;
  if (!bind) {
    if (target.dataset.file) importFile(target);
    return;
  }
  const value = readValue(target);
  const [scope, ...rest] = bind.split(".");
  const path = rest.join(".");
  if (bind === "q.piece") {
    // The piece costed is the selection of the 3D page: changing it here changes it there.
    const c = compute();
    const all = (c?.p3d?.parts ?? []).map((x) => x.index);
    const part = c?.allPieces.find((p) => p.key === value);
    if (value === "tout") window.reader3d?.setSelection?.(all);
    else if (part && part.index !== undefined) window.reader3d?.setSelection?.([part.index]);
    setTimeout(render, 0);
    return;
  }
  if (scope === "q") {
    // Editing the volume of one year: the list of the per-year volumes starts from the annual volume.
    if (path.startsWith("volumes.") && (!Array.isArray(q.volumes) || q.volumes.length !== q.annees)) {
      q.volumes = Array.from({ length: q.annees }, () => q.volumeAnnuel || 0);
    }
    setPath(q, path, value);
    // A new annual volume or programme length resets the per-year volumes.
    if (path === "volumeAnnuel" || path === "annees") q.volumes = null;
    // Prototype or series: the volumes of the request change (strategy of the request workbook).
    if (path === "prototype") applyProgramme();
    store.saveQuote(q);
  } else if (scope === "p") {
    // Inputs of the piece shown.
    const piece = pieceStore(currentKey);
    setPath(piece, path, value);
    if (path === "procede") {
      piece.finition = "auto";
      piece.cycle = piece.empreintes = piece.miseAuMille = piece.mode = null;
    }
    // Cores checked: a first core to describe (its sand: the one typed in before, if any).
    if (path === "noyaux" && value && !piece.cores?.length) {
      const poids = compute()?.results.find((r) => r.piece.key === currentKey)?.part.poids ?? 0;
      piece.cores = [{ ...newCore(0, poids), ...(piece.sableKg > 0 ? { masse: piece.sableKg } : {}) }];
    }
    store.saveQuote(q);
  } else {
    setPath(settings, path, value);
    store.saveSettings(settings);
  }
  setTimeout(render, 0);
}

async function onClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "import-workbook" || action === "import-indices" || action === "import-settings" || action === "import-rfq") button.parentElement.querySelector("input[data-file]")?.click();
  else if (action === "thickness") {
    thicknessBusy = true;
    render();
    try {
      await window.reader3d?.computeThickness?.();
    } finally {
      thicknessBusy = false;
      render();
    }
  } else if (action === "retain" || action === "auto") {
    const piece = pieceStore(currentKey);
    piece.procede = action === "auto" ? "auto" : button.dataset.process;
    piece.finition = action === "auto" ? "auto" : button.dataset.finition;
    piece.cycle = piece.empreintes = piece.miseAuMille = piece.mode = null;
    store.saveQuote(q);
    render();
  } else if (action === "piece") {
    const index = Number(button.dataset.index);
    if (Number.isInteger(index)) window.reader3d?.setSelection?.([index]);
    render();
  } else if (action === "marge-mini") {
    const c = compute();
    const shown = c?.selected === "ensemble" ? c.results.filter((r) => r.final) : [c?.results.find((r) => r.piece.key === c.selected)].filter((r) => r?.final);
    if (!shown.length) return;
    // Goal seek of the "Calcul mini" macro, over the piece or the whole set.
    const m = minimumMargin((marge) => {
      const ys = shown.map((r) => quote(r.finalRates, base.lists, { ...r.finalInput, marge }).years[0]);
      const sold = ys.reduce((a, y) => a + y.vaVendueTotale, 0);
      return sold > 0 ? ys.reduce((a, y) => a + y.margeVa, 0) / sold : 0;
    }, settings.tauxMini);
    if (m === null) message = { kind: "error", text: "Pas de marge qui donne ce taux mini." };
    else {
      q.marge = m;
      store.saveQuote(q);
      message = { kind: "ok", text: `Marge sur VA fixée à ${pct(m, 2)} : marge sur VA de la première année = ${pct(settings.tauxMini)}.` };
    }
    render();
  } else if (action === "add-core") {
    const piece = pieceStore(currentKey);
    const poids = compute()?.results.find((r) => r.piece.key === currentKey)?.part.poids ?? 0;
    piece.cores = [...(piece.cores ?? []), newCore((piece.cores ?? []).length, poids)];
    store.saveQuote(q);
    render();
  } else if (action === "remove-core") {
    const piece = pieceStore(currentKey);
    piece.cores = (piece.cores ?? []).filter((_, i) => i !== Number(button.dataset.index));
    store.saveQuote(q);
    render();
  } else if (action === "add-component") {
    const piece = pieceStore(currentKey);
    piece.composants = [...(piece.composants ?? []), { designation: "", qte: 1, prix: 0, marge: 0.1 }];
    store.saveQuote(q);
    render();
  } else if (action === "remove-component") {
    const piece = pieceStore(currentKey);
    piece.composants = (piece.composants ?? []).filter((_, i) => i !== Number(button.dataset.index));
    store.saveQuote(q);
    render();
  } else if (action === "remove-rfq") {
    q.serie = null;
    store.saveQuote(q);
    render();
  } else if (action === "reset-quote") {
    if (!confirm("Effacer les saisies de ce chiffrage ?")) return;
    store.resetQuote();
    q = store.defaultQuote(base, indices);
    render();
  } else if (action === "reset-settings") {
    if (!confirm("Revenir aux paramètres par défaut (TRS, îlots, méthodes, inflation) ?")) return;
    store.resetSettings();
    settings = store.loadSettings(base);
    render();
  } else if (action === "export-settings") {
    download("parametres_chiffrage.json", new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" }));
  } else if (action === "export-xlsx") {
    exportXlsx().catch((err) => {
      message = { kind: "error", text: err.message };
      render();
    });
  }
}

async function importFile(target) {
  const file = target.files?.[0];
  target.value = "";
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (target.dataset.file === "workbook") {
      const hadBase = !!base;
      const result = readCostingWorkbook(bytes, file.name);
      base = result.base;
      store.saveBase(base);
      // The copy of the indices in the workbook, unless a prices file was imported.
      if (result.indices && (!indices || indices.source !== "fichier")) {
        indices = { ...result.indices, source: "classeur", fileName: file.name, importedAt: new Date().toISOString() };
        store.saveIndices(indices);
      }
      settings = store.loadSettings(base);
      // Inputs typed before the first import are kept; the rest comes from the workbook.
      if (!hadBase) {
        const keep = Object.fromEntries(Object.entries(q).filter(([k, v]) => USER_FIELDS.includes(k) && v !== null && v !== ""));
        q = { ...store.defaultQuote(base, indices), ...keep };
      } else q = { ...store.defaultQuote(base, indices), ...q };
      store.saveQuote(q);
      message = { kind: "ok", text: `Classeur « ${file.name} » importé : ${base.centres.length} centres de profit.` };
    } else if (target.dataset.file === "indices") {
      indices = { ...readIndicesWorkbook(bytes), source: "fichier", fileName: file.name, importedAt: new Date().toISOString() };
      store.saveIndices(indices);
      // Follow the newest month of the file that has a value for the chosen index.
      q.month = [...indices.months].reverse().find((m) => indexAverage(indices, q.cours, m, q.typologie) !== null) ?? indices.months.at(-1);
      store.saveQuote(q);
      message = { kind: "ok", text: `Indices « ${file.name} » importés : ${Object.keys(indices.series).length} cours, ${monthLabel(indices.months[0])} à ${monthLabel(indices.months.at(-1))}.` };
    } else if (target.dataset.file === "rfq") {
      const order = readSeriesOrder(bytes, file.name);
      applySeriesOrder(order);
      store.saveQuote(q);
      const prog = programmeOf(order, { proto: q.prototype });
      message = {
        kind: "ok",
        text: `${q.prototype ? "Demande de prototypes" : "Commande série"} « ${file.name} » importée : ${prog ? `${prog.annees} an${prog.annees > 1 ? "s" : ""} à partir de ${prog.premiereAnnee}, ${nf(prog.volumes.reduce((a, b) => a + b, 0), 0)} pièces` : "pas de volume série"}${order.moqs.length ? `, MOQ ${order.moqs.join(" / ")}` : ""}${order.targetPrice ? `, prix cible ${eur(order.targetPrice, 2)}` : ""}.`,
      };
    } else if (target.dataset.file === "settings") {
      const saved = JSON.parse(new TextDecoder().decode(bytes));
      store.saveSettings(saved);
      settings = store.loadSettings(base);
      message = { kind: "ok", text: `Paramètres « ${file.name} » importés.` };
    }
  } catch (err) {
    message = { kind: "error", text: `${file.name} : ${err.message || err}` };
  }
  render();
}

/** The volumes of the request into the quote: series volumes, or prototype volumes for a prototype. */
function applyProgramme() {
  const prog = q.serie ? programmeOf(q.serie, { proto: q.prototype }) : null;
  if (prog) {
    q.premiereAnnee = prog.premiereAnnee;
    q.annees = prog.annees;
    q.volumes = prog.volumes;
    q.volumeAnnuel = prog.pic;
  }
  return prog;
}

/** Take the series order of a customer request into the quote. */
function applySeriesOrder(order) {
  q.serie = order;
  q.prototype = !!order.prototype;
  const prog = applyProgramme();
  if (order.moqs.length) {
    q.moqs = order.moqs;
    // The changeover is spread over the largest order quantity, at most a year of production.
    q.tailleSerie = prog ? Math.min(order.moqs[0], prog.pic) : order.moqs[0];
  }
  if (order.targetPrice) q.prixCible = order.targetPrice;
  if (order.client) q.client = order.client;
  // "MZ-0681155 - K.451.256G LABLE PLATE RIGHT": reference, then designation.
  const m = /^(\S+)\s+-\s+(.+)$/.exec(order.reference);
  if (m) [q.reference, q.designation] = [m[1], m[2]];
  else if (order.reference) q.reference = order.reference;
  if (order.plan) q.plan = order.plan;
  // The metal of the foundry quote of the request, as the default of the "Matière" card.
  const metal = order.matiere;
  const pick = (value, options) => options?.find((o) => String(o).toLowerCase() === String(value ?? "").toLowerCase());
  q.alliage = pick(metal?.alliage, base?.lists.alliages) ?? pick(order.alliage, base?.lists.alliages) ?? q.alliage;
  if (metal) {
    const typologies = indices?.typologies?.length ? indices.typologies.map((t) => t.name) : base?.lists.typologies;
    q.typologie = pick(metal.typologie, typologies) ?? q.typologie;
    q.cours = pick(metal.cours, base?.lists.cours) ?? q.cours;
    if (metal.month) q.month = metal.month;
    for (const k of ["coursAchat", "p1020Achat", "premiumAchat", "premiumVente", "pafAchat", "pafVente"]) if (metal[k] !== null) q[k] = metal[k];
  }
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

// --------------------------------------------------------------------------- computation

/** The pieces of the 3D model (closed bodies), or one piece typed in by hand. */
function piecesOf(p3d) {
  const parts = (p3d?.parts ?? []).filter((x) => x.closed && x.volume > 0);
  if (!parts.length) return [{ key: "manuel", name: q.designation || q.reference || "Pièce", volume: null, area: null, bboxSize: null, thickness: null }];
  return parts.map((x) => ({ ...x, key: `${x.index}:${x.name}` }));
}

/** The pieces costed: those of the bodies selected on the 3D page. */
function selectedPieces(p3d, all) {
  if (!p3d?.parts?.length || !Array.isArray(p3d.selected)) return all;
  const chosen = new Set(p3d.selected);
  return all.filter((p) => chosen.has(p.index));
}

/** Everything the page shows, from the data, the settings and the inputs. */
function compute() {
  if (!base) return null;
  const p3d = window.reader3d?.part?.() ?? null;
  // Another 3D file: the inputs of the pieces of the previous one do not apply.
  const file = p3d?.file ?? null;
  if (file !== (q.pieceFile ?? null)) {
    q.pieceFile = file;
    q.pieces = {};
    store.saveQuote(q);
  }
  const allPieces = piecesOf(p3d);
  const pieces = selectedPieces(p3d, allPieces);
  if (!pieces.length) return { p3d, allPieces, pieces, selected: null, results: [] };
  const selected = pieces.length > 1 ? "ensemble" : pieces[0].key;
  currentKey = selected === "ensemble" ? currentKey : selected;

  const density = settings.densities[q.alliage] ?? 2.7;
  const years = Array.from({ length: Math.max(1, q.annees || 1) }, (_, i) => (q.premiereAnnee || new Date().getFullYear()) + i);
  const volumes = Array.isArray(q.volumes) && q.volumes.length === years.length ? q.volumes : years.map(() => q.volumeAnnuel || 0);
  const volumeTotal = volumes.reduce((a, b) => a + (b || 0), 0);
  let sale = indices ? saleMetalPrice(indices, base.lists, { month: q.month, typology: q.typologie, index: q.cours }) : { cours: null, p1020: null };
  // Month missing from the price indices: the sale values of the request's own quote, for its month.
  const m = q.serie?.matiere;
  if (sale.cours === null && m?.coursVente > 0 && m.month === q.month) sale = { cours: m.coursVente, p1020: m.p1020Vente ?? 0, source: "demande" };
  const metal = {
    coursAchat: q.coursAchat || 0,
    p1020Achat: q.p1020Achat || 0,
    premiumAchat: q.premiumAchat || 0,
    coursVente: sale.cours ?? 0,
    p1020Vente: sale.p1020 ?? 0,
    premiumVente: q.premiumVente || 0,
    pafAchat: q.pafAchat || 0,
    pafVente: q.pafVente || 0,
  };
  const energy = Object.fromEntries(Object.entries(settings.energy ?? {}).filter(([, v]) => Number.isFinite(v)));
  // Energy prices of the customer request (€/MWh), in place of the new prices of the settings.
  if (q.serie && q.serieEnergie !== false) {
    if (q.serie.elec > 0) energy.elecNouveau = q.serie.elec;
    if (q.serie.gaz > 0) energy.gazNouveau = q.serie.gaz;
  }
  const rates = centreRates(base, { modes: settings.modes, energy });
  const common = { density, years, volumes, volumeTotal, sale, metal, energy, rates };
  const results = pieces.map((piece) => computePiece(piece, common));
  const out = { p3d, allPieces, pieces, selected, results, ...common };
  if (selected === "ensemble") out.ensemble = aggregate(results.filter((r) => r.final), years);
  return out;
}

/** Quote of one piece: its features, the routes, the retained route and its costing. */
function computePiece(piece, { density, years, volumes, volumeTotal, metal, energy, rates }) {
  const inputs = pieceInputs(piece.key);
  const auto = {
    poids: piece.volume ? (piece.volume / 1e6) * density : null,
    toileMini: piece.thickness?.min ?? null,
    epaisseurMax: piece.thickness?.max ?? null,
    moduleMm: piece.volume && piece.area ? piece.volume / piece.area : null,
    dimMax: piece.bboxSize ? Math.max(...piece.bboxSize) : null,
  };
  const value = (k) => inputs[k] ?? auto[k];
  const part = {
    poids: value("poids"),
    toileMini: value("toileMini") ?? 0,
    epaisseurMax: value("epaisseurMax") ?? 0,
    moduleMm: value("moduleMm") ?? 0,
    dimMax: value("dimMax") ?? 0,
    // For the estimate of the tooling: the envelope, volume and surface of the 3D model.
    bboxSize: piece.bboxSize ?? null,
    volume: piece.volume ?? null,
    area: piece.area ?? null,
    volumeAnnuel: q.volumeAnnuel || 0,
    volumeTotal,
    tth: inputs.tth !== "none",
    noyaux: !!inputs.noyaux,
    // The cores described (sand and core-making time per piece), else the sand typed in.
    ...(() => {
      const c = inputs.noyaux && inputs.cores?.length ? coresPerPiece(inputs.cores, settings.operations.ASN) : null;
      return { sableKg: c ? c.sable : inputs.sableKg || 0, noyauxCycle: c ? c.cycle : 0 };
    })(),
    tribo: !!inputs.tribo,
    redressage: !!inputs.redressage,
  };
  const quoteBase = {
    metal,
    coefDifficulte: q.coefDifficulte,
    vaUsinage: q.vaUsinage,
    rebutUsinage: q.rebutUsinage,
    changeover: [],
    coefSecurite: settings.coefSecurite,
    tailleSerie: q.tailleSerie,
    nombrePieces: volumeTotal,
    composants: inputs.composants,
    marge: q.marge ?? settings.marge,
    evolution: settings.inflation,
    years,
    volumes,
    tth: inputs.tth === "none" ? "none" : inputs.tthMode,
    tthCoef: settings.tth[inputs.tth]?.coef ?? 1,
  };
  const out = { piece, inputs, auto, part, density };
  if (!(part.poids > 0)) return out;

  const ranked = rankRoutes(rates, base.lists, part, settings, quoteBase);
  const best = bestRoutes(ranked, 3);
  out.ranked = ranked;
  out.best = best;

  // The route retained: the best one, or the island chosen in the page.
  const chosen = inputs.procede !== "auto" && settings.processes[inputs.procede] && rates.has(inputs.procede);
  const code = chosen ? inputs.procede : best[0]?.process;
  if (!code) return out;
  const process = settings.processes[code];
  const finition =
    inputs.finition !== "auto" && process.finitions.includes(inputs.finition)
      ? inputs.finition
      : ranked.find((r) => r.process === code && r.feasible)?.finition ?? ranked.find((r) => r.process === code)?.finition ?? process.finitions[0];
  const finalRates = chosen && inputs.mode ? centreRates(base, { modes: { ...settings.modes, [code]: inputs.mode }, energy }) : rates;
  const route = buildRoute(code, finition, part, settings, finalRates);
  out.estimated = { cycle: route.cycle, parCycle: route.parCycle, miseAuMille: route.miseAuMille, miseAuMilleDetail: route.miseAuMilleDetail };
  if (chosen) {
    const casting = route.operations.find((o) => o.code === code);
    if (inputs.miseAuMille > 0) route.miseAuMille = inputs.miseAuMille;
    if (inputs.empreintes > 0) casting.parCycle = inputs.empreintes;
    if (inputs.cycle > 0) casting.cycle = inputs.cycle;
  }
  // The in-house die for the number of cavities retained; or the price typed in.
  const cavities = route.operations.find((o) => o.code === code)?.parCycle;
  if (route.tooling && cavities !== route.tooling.cavities) {
    route.tooling = estimateTooling(part, cavities, settings.tooling);
    route.outillage = route.tooling.total;
  }
  route.outillageEstime = route.outillage;
  if (inputs.outillagePrix > 0) route.outillage = inputs.outillagePrix;
  // Core boxes of the cores of the piece, added to the tooling.
  route.outillageMoule = route.outillage;
  route.boxes = part.noyaux ? (inputs.cores ?? []).map((core) => ({ core, ...coreBoxCost(core, settings.cores) })) : [];
  route.outillage += route.boxes.reduce((n, b) => n + b.total, 0);
  out.chosen = chosen;
  out.route = route;
  out.finalRates = finalRates;
  out.finalInput = {
    ...quoteBase,
    poids: part.poids,
    miseAuMille: route.miseAuMille,
    sableKg: route.sableKg,
    tth: part.tth ? (inputs.tthMode === "masselotte" ? "masselotte" : "scie") : "none",
    operations: route.operations,
    changeover: [
      { code, heures: settings.heuresChangementCoulee },
      { code: finition, heures: settings.heuresChangementFinition },
    ],
    // Tooling amortised in the piece price, or sold apart (q.outillageInclus).
    outillages:
      q.outillageInclus === false
        ? []
        : [
            { designation: route.tooling ? "Coquille acier réalisée sur place" : `Outillage ${process.famille}`, qte: 1, prix: route.outillageMoule },
            ...route.boxes.map((b) => ({ designation: `Boîte à noyau — ${b.core.nom}`, qte: 1, prix: b.total })),
          ],
    margeOutillages: 0,
  };
  out.final = quote(finalRates, base.lists, out.finalInput);
  return out;
}

/** The whole set: sums of the pieces, year by year. */
function aggregate(results, years) {
  const total = (fn) => results.reduce((a, r) => a + (fn(r) || 0), 0);
  const ys = years.map((year, i) => {
    const y = (k) => total((r) => r.final.years[i][k]);
    const vaVendueTotale = y("vaVendueTotale");
    const prixVente = y("prixVente");
    const margeVa = y("margeVa");
    const margeTotale = y("margeTotale");
    return {
      year,
      volume: results[0]?.final.years[i].volume ?? 0,
      pri: y("pri"), prixVente, prixPri: y("prixPri"), vmVendue: y("vmVendue"), vaVendue: y("vaVendue"),
      miseEnRouteVendue: y("miseEnRouteVendue"), vaVendueTotale, margeVa, margeMatiere: y("margeMatiere"), margeTotale,
      margeVaPct: vaVendueTotale > 0 ? margeVa / vaVendueTotale : null,
      margeTotalePct: prixVente > 0 ? margeTotale / prixVente : null,
      ca: y("ca"), margeVaAnnuelle: y("margeVaAnnuelle"),
    };
  });
  return {
    count: results.length,
    poids: total((r) => r.part.poids),
    va: total((r) => r.final.va),
    matiere: total((r) => r.final.matiere),
    perteAuFeu: total((r) => r.final.perteAuFeu),
    pri: total((r) => r.final.pri),
    outillage: total((r) => r.route?.outillage),
    outillagesPiece: total((r) => r.final.outillages),
    autresVendus: total((r) => r.final.composants.sold + r.final.sousTraitance.sold + r.final.emballage.sold),
    years: ys,
  };
}

/** Thinnest wall text, with the lettering below the floor in brackets. */
function thicknessText(t) {
  if (!t) return "—";
  return `${nf(t.min, 2)} mm${t.details ? ` (${nf(t.details.min, 2)} mm : écritures / détails fins sous ${nf(t.floor, 1)} mm, ignorés)` : ""}`;
}

// --------------------------------------------------------------------------- rendering

// The page is redrawn after each change. Not while a button is being pressed
// (the change of a field fires when it loses the focus, before the click: the
// button must still be there to receive it), and the field that had the focus
// gets it back.
let pointerDown = false;
let pending = false;
window.addEventListener("pointerup", () => {
  pointerDown = false;
  if (pending) setTimeout(render, 0);
}, true);

function render() {
  if (!el) return;
  if (pointerDown) {
    pending = true;
    return;
  }
  pending = false;
  const container = page === "parametres" ? el.parametres : el.chiffrage;
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset?.bind : null;
  container.innerHTML = page === "parametres" ? renderSettings() : renderQuote();
  if (focused) container.querySelector(`[data-bind="${CSS.escape(focused)}"]`)?.focus();
}

function messageHtml() {
  if (!message) return "";
  const html = `<div class="cmsg ${message.kind}">${esc(message.text)}</div>`;
  message = null;
  return html;
}

function sourcesCard() {
  const indicesInfo = indices
    ? `${esc(indices.fileName ?? "")} (${indices.source === "fichier" ? "fichier des cours" : "copie du classeur"}) — ${Object.keys(indices.series).length} cours, ${monthLabel(indices.months[0])} à ${monthLabel(indices.months.at(-1))} — importé le ${dateLabel(indices.importedAt)}`
    : "aucun";
  return `<section class="ccard csources">
    <h3>Données</h3>
    <div class="crow"><span>Classeur de chiffrage :</span> <strong>${base ? `${esc(base.source?.fileName)} — importé le ${dateLabel(base.source?.importedAt)}` : "aucun"}</strong>
      <button type="button" class="small" data-action="import-workbook">Importer le classeur…</button>
      <input type="file" data-file="workbook" accept=".xlsm,.xlsx" hidden></div>
    <div class="crow"><span>Indices matière :</span> <strong>${indicesInfo}</strong>
      <button type="button" class="small" data-action="import-indices">Importer les indices…</button>
      <input type="file" data-file="indices" accept=".xlsx,.xlsm" hidden></div>
    <div class="crow"><span>Commande série :</span> <strong>${q.serie ? `${esc(q.serie.fileName)} — importée le ${dateLabel(q.serie.importedAt)}` : "aucune"}</strong>
      <button type="button" class="small" data-action="import-rfq">Importer la demande client…</button>
      <input type="file" data-file="rfq" accept=".xlsm,.xlsx" hidden>${q.serie ? ` <button type="button" class="small" data-action="remove-rfq">Retirer</button>` : ""}</div>
    <p class="muted small">Les fichiers sont lus dans ce navigateur et mémorisés sur ce poste : rien n'est envoyé sur Internet.
      Indices : fichier Excel avec un onglet « Suivi indice » (comme VALEURS MB LME.xlsx) ; réimportez-le après chaque mise à jour des cours.</p>
  </section>`;
}

function renderQuote() {
  if (!base) {
    return `<div class="cpage">${messageHtml()}${sourcesCard()}
      <section class="ccard"><h3>Chiffrage de pièce</h3>
      <p>Importez d'abord le classeur de chiffrage (.xlsm) : les coûts des centres de profit, les listes (alliages, coefficients, cours) et les valeurs par défaut en sont tirés.</p></section></div>`;
  }
  const c = compute();
  const lists = base.lists;
  const typologies = indices?.typologies?.length ? indices.typologies.map((t) => t.name) : lists.typologies;
  const months = indices?.months ?? [];
  const ensemble = c.selected === "ensemble";
  const r = ensemble ? null : c.results.find((x) => x.piece.key === c.selected);
  const thicknessButton = c.p3d && !c.p3d.thickness
    ? ` <button type="button" class="small" data-action="thickness"${thicknessBusy ? " disabled" : ""}>${thicknessBusy ? "Calcul…" : "Calculer les épaisseurs"}</button>`
    : "";
  const pieceSelect = c.allPieces.length > 1
    ? field("Pièce chiffrée", select("q.piece", c.selected === "ensemble" && c.pieces.length === c.allPieces.length ? "tout" : c.selected ?? "", [
        ...(c.selected === "ensemble" && c.pieces.length < c.allPieces.length ? [["ensemble", `Sélection 3D (${c.pieces.length} pièces)`]] : []),
        ...(c.selected ? [] : [["", "Aucune pièce sélectionnée"]]),
        ["tout", `Ensemble (${c.allPieces.length} pièces)`],
        ...c.allPieces.map((p) => [p.key, p.name]),
      ]) + `<p class="muted small">Lié à la sélection des corps de la page 3D.</p>`)
    : "";
  const openParts = (c.p3d?.parts ?? []).filter((x) => !x.closed);
  if (!c.selected) {
    return `<div class="cpage">${messageHtml()}<div class="cgrid">${sourcesCard()}
      <section class="ccard"><h3>Pièce</h3><div class="cfields">${pieceSelect}</div>
      <p>Aucune pièce sélectionnée : cochez au moins un corps fermé dans la liste des corps de la page Analyse 3D, ou choisissez une pièce ci-dessus.</p></section></div></div>`;
  }

  return `<div class="cpage">${messageHtml()}
  <div class="cgrid">
    ${sourcesCard()}
    <section class="ccard">
      <h3>${ensemble ? "Ensemble" : "Pièce"}</h3>
      <div class="cfields">
        ${field("Prototype", checkbox("q.prototype", q.prototype, "chiffrage de prototypes"), q.prototype ? "volumes proto de la demande, sans prix cible ni gains de productivité" : "")}
        ${field("Client", input("q.client", q.client, { kind: "text" }))}
        ${field("Référence", input("q.reference", q.reference, { kind: "text" }))}
        ${field("Désignation", input("q.designation", q.designation, { kind: "text" }))}
        ${field("N° de plan", input("q.plan", q.plan, { kind: "text" }))}
        ${pieceSelect}
        ${field("Alliage", select("q.alliage", q.alliage, lists.alliages), `densité ${nf(c.density, 2)}`)}
        ${field("Volume annuel (ensembles / pièces)", input("q.volumeAnnuel", q.volumeAnnuel, { step: 1, min: 0 }))}
        ${field("Durée du programme", select("q.annees", q.annees, [...new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, q.annees])].sort((a, b) => a - b).map((n) => [n, `${n} an${n > 1 ? "s" : ""}`]), { kind: "num" }))}
        ${field("Première année", select("q.premiereAnnee", q.premiereAnnee, [...new Set([...Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 1 + i), q.premiereAnnee])].sort((a, b) => a - b), { kind: "num" }))}
      </div>
      <p class="small muted">Modèle 3D : ${c.p3d ? `<strong>${esc(c.p3d.file)}</strong> — ${c.pieces.length} pièce${c.pieces.length > 1 ? "s" : ""}${openParts.length ? ` (${openParts.length} surface${openParts.length > 1 ? "s" : ""} ouverte${openParts.length > 1 ? "s" : ""} non chiffrée${openParts.length > 1 ? "s" : ""})` : ""}${thicknessButton}` : "aucun (ouvrez un fichier dans l'onglet Analyse 3D, ou saisissez les valeurs)"}</p>
      ${ensemble ? "" : pieceFields(r)}
    </section>

    <section class="ccard">
      <h3>Matière</h3>
      <div class="cfields">
        ${field("Date d'application", months.length || q.month ? select("q.month", q.month, [...new Set([...months, ...(q.month ? [q.month] : [])])].sort().reverse().map((m) => [m, monthLabel(m)])) : "<em>importez les indices</em>")}
        ${field("Typologie de la moyenne", select("q.typologie", q.typologie, typologies))}
        ${field("Cours utilisé", select("q.cours", q.cours, lists.cours))}
        ${field("Cours vente (€/t)", `<output>${c.sale.cours === null ? "indisponible" : nf(c.sale.cours, 2)}</output>`, c.sale.cours === null ? "mois absent du fichier des indices" : c.sale.source === "demande" ? "valeur de la demande client (mois absent des indices)" : "moyenne des indices")}
        ${field("Prime P1020 vente (€/t)", `<output>${nf(c.sale.p1020 ?? 0, 2)}</output>`)}
        ${field("Premium vente (€/t)", input("q.premiumVente", q.premiumVente))}
        ${field("PAF vendue", input("q.pafVente", q.pafVente, { kind: "pct" }), "%")}
        ${field("Cours achat (€/t)", input("q.coursAchat", q.coursAchat))}
        ${field("P1020 achat (€/t)", input("q.p1020Achat", q.p1020Achat))}
        ${field("Premium achat (€/t)", input("q.premiumAchat", q.premiumAchat))}
        ${field("Perte au feu achat", input("q.pafAchat", q.pafAchat, { kind: "pct" }), "%")}
        ${field("Coef de difficulté", select("q.coefDifficulte", q.coefDifficulte, lists.coefs.map((x) => [x.coef, String(x.coef)]), { kind: "num" }))}
      </div>
    </section>

    ${ensemble ? "" : castingCard(r)}
    ${ensemble ? "" : toolingCard(r)}
  </div>

  ${!ensemble && r?.inputs.noyaux ? coresFields(r) : ""}
  ${ensemble ? ensembleCard(c) : solutionsCard(r)}
  ${ensemble ? ensembleDetailCard(c) : detailCard(r)}
  ${seriesCard(c)}
  ${projectionCard(c, ensemble ? c.ensemble : r?.final)}
  <p class="cactions">
    <button type="button" data-action="export-xlsx"${c.results.some((x) => x.final) ? "" : " disabled"}>Exporter le chiffrage (Excel)</button>
    <button type="button" data-action="reset-quote">Nouveau chiffrage</button>
  </p>
  </div>`;
}

/** Inputs of one piece: geometry (from the 3D model unless typed in) and options. */
function pieceFields(r) {
  const i = r.inputs;
  const a = r.auto;
  return `<h4>${esc(r.piece.name)}</h4>
    <p class="small">Toile mini retenue : <strong>${r.piece.thickness ? thicknessText(r.piece.thickness) : r.piece.volume ? "épaisseurs non calculées" : "—"}</strong></p>
    <div class="cfields">
      ${field("Poids pièce (kg)", input("p.poids", i.poids, { placeholder: a.poids ? nf(a.poids, 3) : "à saisir" }), "vide = volume × densité")}
      ${field("Toile mini (mm)", input("p.toileMini", i.toileMini, { placeholder: a.toileMini ? nf(a.toileMini, 2) : "" }), "écritures fines exclues")}
      ${field("Épaisseur maxi / point chaud (mm)", input("p.epaisseurMax", i.epaisseurMax, { placeholder: a.epaisseurMax ? nf(a.epaisseurMax, 2) : "" }))}
      ${field("Module V/S (mm)", input("p.moduleMm", i.moduleMm, { placeholder: a.moduleMm ? nf(a.moduleMm, 2) : "" }), "fixe le temps de solidification")}
      ${field("Plus grande dimension (mm)", input("p.dimMax", i.dimMax, { placeholder: a.dimMax ? nf(a.dimMax, 0) : "" }))}
      ${field("Traitement thermique", select("p.tth", i.tth, [["none", "Aucun"], ...Object.entries(settings.tth).map(([code, t]) => [code, t.label])]), i.tth !== "none" ? esc(settings.tth[i.tth]?.cycle ?? "") : q.serie ? "selon la demande client" : "")}
      ${i.tth !== "none" ? field("Poids traité", select("p.tthMode", i.tthMode, [["scie", "Pièce seule (masselottes sciées avant)"], ["masselotte", "Pièce avec masselottes (grappe)"]])) : ""}
      ${field("Noyaux sable", checkbox("p.noyaux", i.noyaux, "oui"))}
      ${field("Tribofinition", checkbox("p.tribo", i.tribo, "oui"))}
      ${field("Redressage", checkbox("p.redressage", i.redressage, "oui"))}
    </div>
    ${i.noyaux ? `<p class="small">Noyaux : voir la carte « Noyaux et boîtes à noyau » ci-dessous.</p>` : ""}`;
}

/** The sand cores of a piece and their core boxes. */
function coresFields(r) {
  const cores = r.inputs.cores ?? [];
  const sc = settings.cores;
  const rows = cores
    .map((c, i) => {
      const box = coreBoxCost(c, sc);
      const auto = box.size;
      return `<tr>
        <td>${input(`p.cores.${i}.nom`, c.nom, { kind: "text", width: "110px" })}</td>
        <td class="num">${input(`p.cores.${i}.masse`, c.masse, { min: 0, width: "70px" })}</td>
        <td class="num">${input(`p.cores.${i}.qte`, c.qte, { min: 0, step: 1, width: "50px" })}</td>
        <td class="num">${["L", "l", "h"].map((k) => input(`p.cores.${i}.${k}`, c[k], { min: 0, width: "64px", placeholder: nf(auto[k], 0) })).join(" ")}</td>
        <td>${select(`p.cores.${i}.type`, c.type ?? 0, sc.types.map((t, j) => [j, `${t.label} (${nf(t.prixKg, 2)} €/kg)`]), { kind: "num" })}</td>
        <td class="num">${input(`p.cores.${i}.tiroirs`, c.tiroirs, { min: 0, step: 1, width: "50px" })}</td>
        <td>${select(`p.cores.${i}.complexite`, c.complexite, Object.keys(sc.etude))}</td>
        <td class="num">${nf(box.kg, 0)} kg</td>
        <td class="num">${eur(box.total, 0)}</td>
        <td><button type="button" class="small" data-action="remove-core" data-index="${i}">×</button></td>
      </tr>`;
    })
    .join("");
  const per = coresPerPiece(cores, settings.operations.ASN);
  return `<section class="ccard"><h3>Noyaux et boîtes à noyau — ${esc(r.piece.name)}</h3>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Noyau</th><th class="num">Sable (kg)</th><th class="num">Qté / pièce</th><th class="num">Boîte L × l × h (mm)</th><th>Type de boîte</th><th class="num">Tiroirs</th><th>Complexité</th><th class="num">Poids boîte</th><th class="num">Prix boîte</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p><button type="button" class="small" data-action="add-core">Ajouter un noyau</button></p>
    <p class="small muted">Par pièce : ${nf(per.sable, 3)} kg de sable, noyautage ${nf(per.cycle, 0)} s (centre ASN). Boîte vide = estimée d'après la masse du noyau (sable ${nf(sc.sableDensite, 2)} kg/dm³ + ${nf(sc.paroi, 0)} mm de paroi). Prix des boîtes : méthode de l'onglet « 4- Outillage » (BAN) de la demande client, ajoutés à l'outillage (taux et heures dans Paramètres).</p></section>`;
}

function castingCard(r) {
  const casting = Object.keys(settings.processes).filter((code) => base.centres.some((x) => x.code === code));
  const i = r.inputs;
  const routeCode = r.route?.process;
  const e = r.estimated;
  const locked = i.procede === "auto";
  const cycleOptions = [[" ", `Estimé${e ? ` (${nf(e.cycle, 0)} s)` : ""}`], ...[20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 420, 480, 600, 900].map((v) => [v, `${v} s`])];
  if (i.cycle > 0 && !cycleOptions.some(([v]) => Number(v) === i.cycle)) cycleOptions.push([i.cycle, `${i.cycle} s`]);
  const empreintesOptions = [[" ", `Estimé${e ? ` (${e.parCycle})` : ""}`], ...[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)])];
  const mamOptions = [[" ", `Estimée${e ? ` (${nf(e.miseAuMille, 2)})` : ""}`], ...[1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.2, 2.5].map((n) => [n, nf(n, 2)])];
  const mam = e?.miseAuMilleDetail;
  const mamDetail = mam
    ? `<details class="small"><summary>Estimation de la mise au mille : ${nf(mam.value, 2)} (rendement ${pct(mam.rendement, 0)})</summary>
        <ul>${mam.terms.map((t) => `<li>${esc(t.label)}${t.value === null ? "" : ` : ${t.value >= 0 && !t.label.startsWith("rendement") ? "+" : ""}${pct(t.value, 1)}`}</li>`).join("")}</ul>
        <p class="muted">Mise au mille = 1 / rendement. ${mam.estimated ? "Ordre de grandeur à partir de la géométrie : coefficients par îlot dans Paramètres." : "Calculez les épaisseurs pour l'estimer à partir de la géométrie."}</p></details>`
    : "";
  return `<section class="ccard">
      <h3>Paramètres de coulée — ${esc(r.piece.name)}</h3>
      <div class="cfields">
        ${field("Procédé / îlot", select("p.procede", i.procede, [["auto", "Automatique (meilleure solution)"], ...casting.map((code) => [code, `${code} — ${settings.processes[code].famille}`])]))}
        ${field("Finition", select("p.finition", i.finition, [["auto", "Automatique"], ...(routeCode ? settings.processes[routeCode].finitions.map((f) => [f, `${f} — ${settings.operations[f]?.label ?? f}`]) : [])]))}
        ${field("Fonctionnement", locked ? `<output>${esc(r.finalRates?.get(routeCode)?.mode ?? "—")}</output>` : select("p.mode", i.mode ?? "", [["", `Paramètre (${esc(settings.modes[routeCode] ?? base.centres.find((x) => x.code === routeCode)?.defaultMode ?? "")})`], ...MODES.map((m) => [m, m])], { kind: "nullraw" }), locked ? "choisissez un îlot pour le modifier" : "")}
        ${field("Temps de cycle", locked ? `<output>${e ? `${nf(e.cycle, 0)} s (estimé)` : "—"}</output>` : select("p.cycle", i.cycle ?? " ", cycleOptions, { kind: "num" }))}
        ${field("Empreintes / pièces par cycle", locked ? `<output>${e?.parCycle ?? "—"}</output>` : select("p.empreintes", i.empreintes ?? " ", empreintesOptions, { kind: "num" }))}
        ${field("Mise au mille (kg coulé / kg pièce)", locked ? `<output>${e ? nf(e.miseAuMille, 2) : "—"}</output>` : select("p.miseAuMille", i.miseAuMille ?? " ", mamOptions, { kind: "num" }))}
        ${field("TRS de l'îlot", `<output>${routeCode ? pct(settings.trs[routeCode] ?? 0, 0) : "—"}</output>`, "modifiable dans Paramètres")}
      </div>
      ${mamDetail}
    </section>`;
}

/** Tooling of the route retained: the in-house steel die, line by line, or the price of the island. */
function toolingCard(r) {
  const route = r?.route;
  if (!route) return "";
  const t = route.tooling;
  const total = c => eur(c, 0);
  const amortised = r.final && r.part.volumeTotal > 0 ? route.outillage / r.part.volumeTotal : null;
  const rows = t
    ? t.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="muted small">${esc(l.detail)}</td><td class="num">${total(l.value)}</td></tr>`).join("")
    : `<tr><td>Outillage ${esc(route.famille)}</td><td class="muted small">prix de l'îlot (Paramètres)</td><td class="num">${total(route.outillageEstime)}</td></tr>`;
  return `<section class="ccard">
      <h3>Outillage — ${t ? "coquille acier réalisée sur place" : esc(route.famille)}</h3>
      <div class="cscroll"><table class="ctable">
        <tbody>${rows}</tbody>
        <tfoot><tr><td><strong>Total estimé</strong></td><td class="muted small">${t ? `${t.cavities} empreinte${t.cavities > 1 ? "s" : ""} — CNC ${nf(t.hours.cnc, 1)} h, FAO ${nf(t.hours.programmation, 1)} h, montage ${nf(t.hours.montage, 1)} h` : ""}</td><td class="num"><strong>${total(route.outillageEstime)}</strong></td></tr></tfoot>
      </table></div>
      <div class="cfields">
        ${field("Prix d'outillage retenu (€)", input("p.outillagePrix", r.inputs.outillagePrix, { min: 0, placeholder: nf(route.outillageEstime, 0) }), "vide = estimation")}
        ${q.outillageInclus === false
          ? field("Vendu à part", `<output>${eur(route.outillage * (1 + (q.margeOutillage || 0)), 0)} HT</output>`, "non compris dans le prix pièce (voir le détail du chiffrage)")
          : field("Amorti par pièce", `<output>${amortised === null ? "—" : eur(amortised, 3)}</output>`, `sur ${nf(r.part.volumeTotal, 0)} pièces du programme, compris dans le prix pièce`)}
      </div>
      ${t ? `<p class="small muted">Estimation à partir du modèle 3D : blocs = encombrement de la pièce + parois, ébauche = volume des empreintes, finition = leur surface (+ ${pct(settings.tooling.alimentation, 0)} pour l'alimentation). Taux, vitesses et temps de montage dans Paramètres.</p>` : ""}
      ${route.boxes.length ? `<h4>Boîtes à noyau</h4>
      <div class="cscroll"><table class="ctable">
        <tbody>${route.boxes
          .map((b) => `<tr class="sub"><td colspan="2"><strong>${esc(b.core.nom)}</strong> — boîte ${nf(b.kg, 0)} kg${b.size.auto ? " (dimensions estimées)" : ""}</td><td class="num">${total(b.total)}</td></tr>${b.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="muted small">${esc(l.detail)}</td><td class="num">${total(l.value)}</td></tr>`).join("")}`)
          .join("")}</tbody>
        <tfoot><tr><td><strong>Total outillage</strong></td><td class="muted small">moule ${total(route.outillageMoule)} + boîtes à noyau ${total(route.outillage - route.outillageMoule)}</td><td class="num"><strong>${total(route.outillage)}</strong></td></tr></tfoot>
      </table></div>` : ""}
    </section>`;
}

function solutionsCard(r) {
  if (!(r?.part.poids > 0)) {
    return `<section class="ccard"><h3>Solutions de fabrication</h3><p>Ouvrez un modèle 3D dans l'onglet Analyse 3D, ou saisissez le poids de la pièce.</p></section>`;
  }
  const missingThickness = !r.part.toileMini;
  const rows = r.best
    .map((x, i) => {
      const retained = r.route && x.process === r.route.process && x.finition === r.route.finition;
      return `<tr class="${retained ? "retained" : ""}">
        <td>${i + 1}</td>
        <td><strong>${esc(x.process)}</strong> ${esc(x.famille)}</td>
        <td>${esc(settings.operations[x.finition]?.label ?? x.finition)}</td>
        <td class="num">${nf(x.cycle, 0)} s × ${x.parCycle}</td>
        <td class="num">${nf(x.miseAuMille, 2)}</td>
        <td class="num">${eur(x.result.pri)}</td>
        <td class="num">${eur(x.outillagePiece)}</td>
        <td class="num">${eur(x.result.years[0]?.prixVente)}</td>
        <td class="num">${nf(x.qualite, 1)} / 10</td>
        <td class="num"><strong>${nf(x.ratio * 100, 1)}</strong></td>
        <td class="small">${x.warnings.map(esc).join("<br>")}</td>
        <td>${retained ? "✓ retenue" : `<button type="button" class="small" data-action="retain" data-process="${esc(x.process)}" data-finition="${esc(x.finition)}">Retenir</button>`}</td>
      </tr>`;
    })
    .join("");
  const rejectedByProcess = new Map();
  for (const x of r.ranked.filter((y) => !y.feasible)) if (!rejectedByProcess.has(x.process)) rejectedByProcess.set(x.process, x);
  return `<section class="ccard">
    <h3>Les 3 meilleures solutions (rapport qualité / prix) — ${esc(r.piece.name)}</h3>
    ${missingThickness ? `<p class="cmsg warn">Toile mini inconnue : calculez les épaisseurs (onglet Analyse 3D) ou saisissez-la, sinon la faisabilité des procédés n'est pas vérifiée.</p>` : ""}
    ${r.best.length ? `<div class="cscroll"><table class="ctable">
      <thead><tr><th>#</th><th>Îlot</th><th>Finition</th><th class="num">Cycle</th><th class="num">Mise au mille</th><th class="num">PRI / pièce</th><th class="num">Outillage / pièce</th><th class="num">Prix de vente</th><th class="num">Qualité</th><th class="num">Qualité / prix</th><th>Alertes</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : "<p>Aucun îlot ne convient à cette pièce (voir ci-dessous).</p>"}
    ${r.inputs.procede !== "auto" ? `<p><button type="button" class="small" data-action="auto">Revenir au choix automatique</button></p>` : ""}
    ${rejectedByProcess.size ? `<details><summary>Îlots écartés (${rejectedByProcess.size})</summary><ul>${[...rejectedByProcess.values()].map((x) => `<li><strong>${esc(x.process)}</strong> ${esc(x.famille)} : ${x.reasons.map(esc).join(", ")}</li>`).join("")}</ul></details>` : ""}
    <p class="small muted">Qualité /10 : note de l'îlot (Paramètres) moins des pénalités : point chaud au-delà de l'épaisseur maxi de l'îlot, toile proche du minimum, volume faible. Prix = PRI complet + outillage amorti sur le programme. Temps de cycle = base + s/kg × kg coulés par cycle + s/mm² × module V/S² (coefficients dans Paramètres) : estimations à confirmer par les méthodes.</p>
  </section>`;
}

/** Ensemble: one row per piece, with its retained route, and the totals. */
function ensembleCard(c) {
  const rows = c.results
    .map((r) => {
      const f = r.final;
      const y = f?.years[0];
      const casting = r.route?.operations.find((o) => o.code === r.route.process);
      return `<tr>
        <td><strong>${esc(r.piece.name)}</strong></td>
        <td class="num">${nf(r.part.poids, 3)}</td>
        <td>${r.piece.thickness ? esc(thicknessText(r.piece.thickness)) : "—"}</td>
        <td>${r.route ? `<strong>${esc(r.route.process)}</strong> ${esc(r.route.famille)}${r.chosen ? "" : " (auto)"}` : `<span class="muted">${r.part.poids > 0 ? "aucun îlot" : "poids inconnu"}</span>`}</td>
        <td>${r.route ? esc(settings.operations[r.route.finition]?.label ?? r.route.finition) : ""}</td>
        <td class="num">${casting ? `${nf(casting.cycle, 0)} s × ${casting.parCycle}` : ""}</td>
        <td class="num">${r.route ? nf(r.route.miseAuMille, 2) : ""}</td>
        <td class="num">${eur(f?.pri)}</td>
        <td class="num">${eur(y?.prixVente)}</td>
        <td class="num">${pct(y?.margeVaPct)}</td>
        <td><button type="button" class="small" data-action="piece" data-index="${esc(r.piece.index)}">Détailler</button></td>
      </tr>`;
    })
    .join("");
  const e = c.ensemble;
  const y = e.years[0];
  return `<section class="ccard">
    <h3>Chiffrage par pièce</h3>
    <div class="cscroll"><table class="ctable">
      <thead><tr><th>Pièce</th><th class="num">Poids (kg)</th><th>Toile mini</th><th>Îlot</th><th>Finition</th><th class="num">Cycle</th><th class="num">Mise au mille</th><th class="num">PRI</th><th class="num">Prix de vente</th><th class="num">Marge VA</th><th></th></tr></thead>
      <tbody>${rows}
        <tr class="total"><td>Ensemble (${e.count} pièce${e.count > 1 ? "s" : ""} chiffrée${e.count > 1 ? "s" : ""})</td><td class="num">${nf(e.poids, 3)}</td><td colspan="5"></td><td class="num">${eur(e.pri)}</td><td class="num">${eur(y?.prixVente)}</td><td class="num">${pct(y?.margeVaPct)}</td><td></td></tr>
      </tbody></table></div>
    <p class="small muted">Chaque pièce est chiffrée avec sa meilleure solution, ou l'îlot choisi pour elle : « Détailler » ouvre son chiffrage et ses paramètres de coulée.</p>
  </section>`;
}

function ensembleDetailCard(c) {
  const e = c.ensemble;
  const y = e.years[0];
  if (!y) return "";
  const marge = q.marge ?? settings.marge;
  return `<section class="ccard">
    <h3>Prix de l'ensemble (${y.year})</h3>
    <dl class="cstats">
      <dt>VA PRI</dt><dd>${eur(e.va)}</dd>
      <dt>Matière + perte au feu</dt><dd>${eur(e.matiere + e.perteAuFeu)}</dd>
      ${e.outillagesPiece ? `<dt>Outillages amortis</dt><dd>${eur(e.outillagesPiece)}</dd>` : ""}
      <dt>PRI complet${e.outillagesPiece ? " (outillages compris)" : ""}</dt><dd>${eur(e.pri + e.outillagesPiece)}</dd>
      <dt>Matière vendue (VM)</dt><dd>${eur(y.vmVendue)}</dd>
      <dt>VA vendue</dt><dd>${eur(y.vaVendue)}${e.outillagesPiece ? ` <span class="muted small">dont outillages ${eur(e.outillagesPiece / (1 - marge))}</span>` : ""}</dd>
      <dt>Frais de mise en route</dt><dd>${eur(y.miseEnRouteVendue)}</dd>
      <dt>Composants, sous-traitance, emballages</dt><dd>${eur(e.autresVendus)}</dd>
      <dt><strong>Prix de vente complet</strong></dt><dd><strong>${eur(y.prixVente)}</strong>${e.outillagesPiece ? " (outillages compris)" : ""}</dd>
      ${q.outillageInclus === false ? `<dt>Outillages (chiffrés à part)</dt><dd>${eur(e.outillage * (1 + (q.margeOutillage || 0)), 0)} HT</dd>` : ""}
      <dt>Marge sur VA</dt><dd>${eur(y.margeVa)} (${pct(y.margeVaPct)})</dd>
      <dt>Marge totale</dt><dd>${eur(y.margeTotale)} (${pct(y.margeTotalePct)} du prix)</dd>
    </dl>
    ${toolingChoice(c.results)}
    <div class="cfields">
      ${field("VA d'usinage par pièce (€)", input("q.vaUsinage", q.vaUsinage))}
      ${field("Taux de rebut fonderie détecté à l'usinage", input("q.rebutUsinage", q.rebutUsinage, { kind: "pct" }), "%")}
      ${field("Taille de série (pièces)", input("q.tailleSerie", q.tailleSerie, { step: 1, min: 1 }))}
      ${field("Marge sur VA", input("q.marge", marge, { kind: "pct" }), `<button type="button" class="small" data-action="marge-mini">Marge mini (${pct(settings.tauxMini, 0)})</button>`)}
    </div>
  </section>`;
}

/**
 * The tooling in the price: amortised in the piece price (in the value added,
 * with its margin) or sold apart, for the pieces shown.
 */
function toolingChoice(results) {
  const done = results.filter((r) => r.final && r.route);
  if (!done.length) return "";
  const cost = done.reduce((n, r) => n + (r.route.outillage || 0), 0);
  const amortised = done.reduce((n, r) => n + (r.final.outillages || 0), 0);
  const pieces = done[0].part.volumeTotal;
  const marge = q.marge ?? settings.marge;
  const inclus = q.outillageInclus !== false;
  const sale = cost * (1 + (q.margeOutillage || 0));
  return `<h4>Outillage</h4>
    <div class="cfields">
      ${field("Prix de l'outillage", checkbox("q.outillageInclus", inclus, "inclus dans le prix pièce"), inclus ? "amorti sur les pièces du programme" : "décoché : chiffré à part")}
      ${inclus ? "" : field("Marge sur l'outillage", input("q.margeOutillage", q.margeOutillage ?? 0, { kind: "pct" }), "%")}
    </div>
    <p class="small">${
      inclus
        ? `Outillage ${eur(cost, 0)} amorti sur ${nf(pieces, 0)} pièces : <strong>${eur(amortised, 3)} par pièce</strong> en PRI (dans la VA), soit <strong>${eur(amortised / (1 - marge), 3)}</strong> dans le prix de vente avec la marge sur VA.`
        : `<strong>Outillage chiffré à part : ${eur(sale, 0)} HT</strong> (coût ${eur(cost, 0)}${q.margeOutillage ? `, marge ${pct(q.margeOutillage)}` : ""}), non compris dans le prix pièce.`
    }</p>`;
}

function detailCard(r) {
  const f = r?.final;
  if (!f) return "";
  const lines = f.lines
    .map((l) => {
      const op = r.route.operations.find((o) => o.code === l.code) ?? {};
      const rate = r.finalRates.get(l.code);
      const quantity = l.uo === "kgCast" || l.uo === "kgSold" ? `${nf(l.units, 3)} kg` : l.uo === "hour" ? `${nf(l.units * 3600, 1)} s` : `${nf(l.piecesPerHour, 1)} p/h`;
      const detail = op.cycle ? `${nf(op.cycle, 0)} s × ${op.parCycle}${op.trs && l.uo === "pph" ? ` — TRS ${pct(op.trs, 0)}` : ""}` : "";
      return `<tr><td><strong>${esc(l.code)}</strong> ${esc(l.name)}</td><td>${esc(rate?.mode ?? "")}</td><td class="small">${detail}</td><td class="num">${quantity}</td><td class="num">${nf(l.rate, l.uo.startsWith("kg") ? 4 : 2)} €/${UO[l.uo]}</td><td class="num">${eur(l.cost)}</td></tr>`;
    })
    .join("");
  const y = f.years[0];
  const marge = q.marge ?? settings.marge;
  const composants = r.inputs.composants ?? [];
  return `<section class="ccard">
    <h3>Détail du chiffrage — ${esc(r.piece.name)} : ${esc(r.route.process)} ${esc(r.route.famille)}, ${esc(settings.operations[r.route.finition]?.label ?? r.route.finition)}</h3>
    ${r.route.warnings.length || r.route.reasons.length ? `<p class="cmsg warn">${[...r.route.reasons, ...r.route.warnings].map(esc).join(" — ")}</p>` : ""}
    <div class="cscroll"><table class="ctable">
      <thead><tr><th>Centre de profit</th><th>Fonct.</th><th>Cycle</th><th class="num">Quantité</th><th class="num">Taux</th><th class="num">€ / pièce</th></tr></thead>
      <tbody>${lines}
        <tr class="sub"><td colspan="5">VA PRI totale (dont part fixe ${eur(f.fixed)}, corporate ${eur(f.corporate)})</td><td class="num">${eur(f.va)}</td></tr>
        <tr><td colspan="5">Matière (${nf(f.metalAchat, 2)} €/t × ${nf(r.part.poids, 3)} kg)</td><td class="num">${eur(f.matiere)}</td></tr>
        <tr><td colspan="5">Perte au feu (${pct(q.pafAchat)} de ${nf(f.kgCast, 3)} kg coulés, mise au mille ${nf(r.route.miseAuMille, 2)})</td><td class="num">${eur(f.perteAuFeu)}</td></tr>
        <tr><td colspan="5">Sable</td><td class="num">${eur(f.sable)}</td></tr>
        <tr><td colspan="5">Coef de difficulté (${esc(q.coefDifficulte)})</td><td class="num">${eur(f.difficulte)}</td></tr>
        <tr><td colspan="5">Rebuts détectés à l'usinage (${eur(q.vaUsinage, 2)} × ${pct(q.rebutUsinage)})</td><td class="num">${eur(f.usinage)}</td></tr>
        ${f.outillages ? `<tr><td colspan="5">Outillage amorti (${eur(f.outillagesTotal, 0)} / ${nf(r.part.volumeTotal, 0)} pièces)</td><td class="num">${eur(f.outillages)}</td></tr>` : ""}
        <tr class="total"><td colspan="5">PRI complet${f.outillages ? " (outillage compris)" : ""}</td><td class="num">${eur(f.pri + f.outillages)}</td></tr>
      </tbody></table></div>
    <div class="cfields">
      ${field("VA d'usinage (€)", input("q.vaUsinage", q.vaUsinage))}
      ${field("Taux de rebut fonderie détecté à l'usinage", input("q.rebutUsinage", q.rebutUsinage, { kind: "pct" }), "%")}
      ${field("Taille de série (pièces)", input("q.tailleSerie", q.tailleSerie, { step: 1, min: 1 }), `changement de série : ${eur(f.changeoverSeries, 2)} / série`)}
      ${field("Marge sur VA", input("q.marge", marge, { kind: "pct" }), `<button type="button" class="small" data-action="marge-mini">Marge mini (${pct(settings.tauxMini, 0)})</button>`)}
    </div>
    <h4>Composants</h4>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">Prix unitaire (€)</th><th class="num">Marge</th><th></th></tr></thead>
      <tbody>${composants
        .map(
          (x, i) => `<tr><td>${input(`p.composants.${i}.designation`, x.designation, { kind: "text" })}</td><td class="num">${input(`p.composants.${i}.qte`, x.qte, { width: "70px" })}</td><td class="num">${input(`p.composants.${i}.prix`, x.prix, { width: "90px" })}</td><td class="num">${input(`p.composants.${i}.marge`, x.marge, { kind: "pct", width: "70px" })}</td><td><button type="button" class="small" data-action="remove-component" data-index="${i}">×</button></td></tr>`,
        )
        .join("")}</tbody></table></div>
    <p><button type="button" class="small" data-action="add-component">Ajouter un composant</button></p>
    ${toolingChoice([r])}
    <h4>Prix de vente (${y?.year ?? ""})</h4>
    <dl class="cstats">
      <dt>Matière vendue (VM)</dt><dd>${eur(y?.vmVendue)}</dd>
      <dt>VA vendue</dt><dd>${eur(y?.vaVendue)}${f.outillages ? ` <span class="muted small">dont outillage ${eur(f.outillages / (1 - marge))}</span>` : ""}</dd>
      <dt>Frais de mise en route</dt><dd>${eur(y?.miseEnRouteVendue)}</dd>
      <dt>Composants, sous-traitance, emballages</dt><dd>${eur(f.composants.sold + f.sousTraitance.sold + f.emballage.sold)}</dd>
      <dt><strong>Prix de vente complet</strong></dt><dd><strong>${eur(y?.prixVente)}</strong>${f.outillages ? " (outillage compris)" : ""}</dd>
      ${q.outillageInclus === false ? `<dt>Outillage (chiffré à part)</dt><dd>${eur(r.route.outillage * (1 + (q.margeOutillage || 0)), 0)} HT</dd>` : ""}
      <dt>Prix complet PRI</dt><dd>${eur(y?.prixPri)}</dd>
      <dt>Marge sur VA</dt><dd>${eur(y?.margeVa)} (${pct(y?.margeVaPct)})</dd>
      <dt>Marge matière</dt><dd>${eur(y?.margeMatiere)}</dd>
      <dt>Marge totale</dt><dd>${eur(y?.margeTotale)} (${pct(y?.margeTotalePct)} du prix)</dd>
    </dl>
  </section>`;
}

/** Prices of the order quantities: the changeover spread over each one, first year. */
function moqPrices(c) {
  const shown = c.selected === "ensemble" ? c.results.filter((r) => r.final) : c.results.filter((r) => r.piece.key === c.selected && r.final);
  if (!shown.length) return null;
  const at = (tailleSerie) => {
    const ys = shown.map((r) => quote(r.finalRates, base.lists, { ...r.finalInput, tailleSerie }).years[0]);
    const sum = (k) => ys.reduce((a, y) => a + (y[k] || 0), 0);
    const vaVendueTotale = sum("vaVendueTotale");
    return { tailleSerie, prixVente: sum("prixVente"), miseEnRoute: sum("miseEnRouteVendue"), margeVaPct: vaVendueTotale > 0 ? sum("margeVa") / vaVendueTotale : null };
  };
  return { base: at(q.tailleSerie), moqs: (q.moqs ?? []).map(at), shown };
}

function seriesCard(c) {
  const s = q.serie;
  const prices = moqPrices(c);
  // Prototypes: no target price (strategy of the request workbook).
  const target = q.prototype ? null : q.prixCible;
  const gap = (p) => (target > 0 ? `${p > target ? "+" : ""}${eur(p - target, 2)} (${pct(p / target - 1)})` : "—");
  const rows = prices
    ? [{ label: `Taille de série du chiffrage (${nf(q.tailleSerie, 0)})`, ...prices.base }, ...prices.moqs.map((x, i) => ({ label: `MOQ ${i + 1} : ${nf(x.tailleSerie, 0)} pièces`, ...x }))]
        .map((x) => `<tr><td>${x.label}</td><td class="num">${eur(x.miseEnRoute, 3)}</td><td class="num">${eur(x.prixVente, 2)}</td><td class="num">${pct(x.margeVaPct)}</td><td class="num${target > 0 && x.prixVente > target ? " bad" : ""}">${gap(x.prixVente)}</td></tr>`)
        .join("")
    : "";
  // The process asked by the customer (e.g. "CG": gravity die casting) against the islands retained.
  const mismatch = s?.fonderie && prices ? prices.shown.filter((r) => r.route && !r.route.process.toUpperCase().startsWith(s.fonderie.toUpperCase())) : [];
  return `<section class="ccard">
    <h3>${q.prototype ? "Prototypes" : "Commande série"}${c.selected === "ensemble" ? " — ensemble" : ""}</h3>
    ${s ? `<p class="small">${[s.client, s.demande, s.offre && `offre ${s.offre}`, s.fonderie && `fonderie ${s.fonderie}`, s.usinage, s.tth && `TTH ${s.tth}`, s.references > 1 && `${s.references} références dans la demande`].filter(Boolean).map(esc).join(" — ")}</p>` : `<p class="small muted">Importez la demande client (onglet « 1- Données GO NO GO ») pour reprendre les volumes par année, les MOQ et le prix cible, ou saisissez-les ici.</p>`}
    <div class="cfields">
      ${field("Quantités commandées (MOQ)", input("q.moqs", q.moqs ?? [], { kind: "list", placeholder: "1000 ; 500 ; 50" }), "séparées par « ; »")}
      ${field("Prix cible client (€/pièce)", input("q.prixCible", q.prixCible, { min: 0 }), q.prototype ? "non utilisé pour des prototypes" : "")}
      ${field("Taille de série (pièces)", input("q.tailleSerie", q.tailleSerie, { step: 1, min: 1 }), "répartit le changement de série")}
      ${s && (s.elec > 0 || s.gaz > 0) ? checkbox("q.serieEnergie", q.serieEnergie !== false, `Prix de l'énergie de la demande (élec ${nf(s.elec ?? 0, 0)} €/MWh, gaz ${nf(s.gaz ?? 0, 0)} €/MWh)`) : ""}
    </div>
    ${mismatch.length ? `<p class="cmsg warn">La demande indique la fonderie « ${esc(s.fonderie)} » : îlot retenu différent pour ${mismatch.map((r) => `${esc(r.piece.name)} (${esc(r.route.process)})`).join(", ")}.</p>` : ""}
    ${prices ? `<div class="cscroll"><table class="ctable">
      <thead><tr><th>Quantité</th><th class="num">Mise en route / pièce</th><th class="num">Prix de vente ${c.years[0]}</th><th class="num">Marge sur VA</th><th class="num">Écart au prix cible</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="small muted">Prix de la première année : les frais de changement de série (coulée et finition) sont répartis sur la quantité de chaque commande.</p>` : ""}
  </section>`;
}

function projectionCard(c, f) {
  if (!f?.years?.length) return "";
  const head = f.years.map((y) => `<th class="num">${y.year}</th>`).join("");
  const row = (label, fn) => `<tr><td>${label}</td>${f.years.map((y, i) => `<td class="num">${fn(y, i)}</td>`).join("")}</tr>`;
  return `<section class="ccard">
    <h3>Projection annuelle${c.selected === "ensemble" ? " de l'ensemble" : ""}</h3>
    <div class="cscroll"><table class="ctable">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>
        ${row("Volume", (y, i) => input(`q.volumes.${i}`, c.volumes[i], { step: 1, min: 0, width: "90px" }))}
        ${row("PRI", (y) => eur(y.pri))}
        ${row("Prix de vente", (y) => eur(y.prixVente))}
        ${row("Marge sur VA", (y) => pct(y.margeVaPct))}
        ${row("CA", (y) => eur(y.ca, 0))}
        ${row("Marge sur VA annuelle", (y) => eur(y.margeVaAnnuelle, 0))}
      </tbody></table></div>
    <p class="small muted">Hausses annuelles (Paramètres) : masse salariale ${pct(settings.inflation.salaires)}, consommables/entretien/prestations ${pct(settings.inflation.conso)}, électricité ${pct(settings.inflation.elec)}, gaz ${pct(settings.inflation.gaz)}, autres énergies ${pct(settings.inflation.autresEnergies)}.</p>
  </section>`;
}

function renderSettings() {
  const centres = base?.centres ?? [];
  const processes = Object.entries(settings.processes);
  const pnum = (code, key, opts) => input(`s.processes.${code}.${key}`, settings.processes[code][key], opts);
  const trsRows = centres
    .filter((c) => c.uo === "pph")
    .map((c) => `<tr><td><strong>${esc(c.code)}</strong> ${esc(c.name)}</td>
      <td class="num">${input(`s.trs.${c.code}`, settings.trs[c.code] ?? 0.85, { kind: "pct", width: "80px" })}</td>
      <td>${c.source === "modes" ? select(`s.modes.${c.code}`, settings.modes[c.code] ?? c.defaultMode, MODES) : `<span class="muted">${esc(c.source === "reel" ? "Réel" : "fixe")}</span>`}</td></tr>`)
    .join("");
  const processRows = processes
    .map(
      ([code, p]) => `<tr><td><strong>${esc(code)}</strong><br>${input(`s.processes.${code}.famille`, p.famille, { kind: "text" })}</td>
      <td>${pnum(code, "toileMin", { width: "60px" })}</td><td>${pnum(code, "toileMax", { width: "60px" })}</td>
      <td>${pnum(code, "poidsMax", { width: "60px" })}</td><td>${pnum(code, "dimMax", { width: "70px" })}</td>
      <td>${pnum(code, "volumeMin", { width: "80px" })}</td><td>${pnum(code, "empreintesMax", { width: "50px" })}</td>
      <td>${pnum(code, "grappeMax", { width: "60px" })}</td><td>${pnum(code, "miseAuMille", { width: "60px" })}</td>
      <td>${input(`s.processes.${code}.rendement.base`, p.rendement?.base, { kind: "pct", width: "60px" })}</td>
      <td>${input(`s.processes.${code}.rendement.parDoublement`, p.rendement?.parDoublement, { kind: "pct", width: "60px" })}</td>
      <td>${input(`s.processes.${code}.rendement.petitePiece`, p.rendement?.petitePiece, { kind: "pct", width: "60px" })}</td>
      <td>${input(`s.processes.${code}.cycle.base`, p.cycle.base, { width: "60px" })}</td>
      <td>${input(`s.processes.${code}.cycle.parKg`, p.cycle.parKg, { width: "60px" })}</td>
      <td>${input(`s.processes.${code}.cycle.parModule2`, p.cycle.parModule2, { width: "60px" })}</td>
      <td>${pnum(code, "qualite", { width: "50px" })}</td><td>${pnum(code, "outillage", { width: "80px" })}</td>
      <td>${checkbox(`s.processes.${code}.tth`, p.tth, "")}</td><td>${checkbox(`s.processes.${code}.noyaux`, p.noyaux, "")}</td></tr>`,
    )
    .join("");
  const opRows = Object.entries(settings.operations)
    .map(
      ([code, o]) => `<tr><td><strong>${esc(code)}</strong> ${esc(o.label)}</td>
      <td>${input(`s.operations.${code}.base`, o.base, { width: "70px" })}</td>
      <td>${input(`s.operations.${code}.parKg`, o.parKg, { width: "70px" })}</td>
      <td>${o.chargeKg !== undefined ? input(`s.operations.${code}.chargeKg`, o.chargeKg, { width: "70px" }) : input(`s.operations.${code}.parCycle`, o.parCycle, { width: "70px" })}</td></tr>`,
    )
    .join("");
  const densities = Object.entries(settings.densities)
    .map(([a, d]) => field(a, input(`s.densities.${a}`, d, { width: "80px" })))
    .join("");
  const energy = { ...base?.energy, ...settings.energy };
  const tthRows = Object.entries(settings.tth)
    .map(
      ([code, t]) => `<tr><td><strong>${esc(code)}</strong></td><td>${input(`s.tth.${code}.label`, t.label, { kind: "text", width: "320px" })}</td>
      <td>${input(`s.tth.${code}.coef`, t.coef, { width: "70px" })}</td><td>${input(`s.tth.${code}.cycle`, t.cycle, { kind: "text", width: "300px" })}</td></tr>`,
    )
    .join("");
  const tl = settings.tooling;
  const sc = settings.cores;
  const cf = (label, path, value, hint = "", opts = {}) => field(label, input(`s.cores.${path}`, value, opts), hint);
  const bandRows = sc.bandes
    .map((b, i) => `<tr><td class="num">≤ ${nf(b.max, 0)} kg</td>${["ax3", "ax3auto", "ax5", "ax5auto", "tiroir3", "tiroir5", "scan", "ajustage"].map((k) => `<td>${input(`s.cores.bandes.${i}.${k}`, b[k], { width: "56px" })}</td>`).join("")}</tr>`)
    .join("");
  const tf = (label, path, value, hint = "", opts = {}) => field(label, input(`s.tooling.${path}`, value, opts), hint);
  return `<div class="cpage">${messageHtml()}
  <p class="cmsg ok">Les paramètres sont enregistrés automatiquement dans ce navigateur dès qu'ils sont saisis, et retrouvés à la prochaine ouverture de la page.</p>
  ${base ? "" : sourcesCard()}
  <div class="cgrid">
    <section class="ccard">
      <h3>TRS et fonctionnement par centre</h3>
      ${centres.length ? `<table class="ctable compact"><thead><tr><th>Centre</th><th class="num">TRS</th><th>Fonctionnement</th></tr></thead><tbody>${trsRows}</tbody></table>` : "<p>Importez le classeur de chiffrage pour voir les centres.</p>"}
      <p class="small muted">TRS : rendement des machines (pièces/h = 3600 / cycle × pièces par cycle × TRS). Fonctionnement : coûts et heures d'ouverture du centre (feuilles PRI 1x8, 2x8, 3x8, Réel).</p>
    </section>
    <section class="ccard">
      <h3>Marges, inflation, énergie</h3>
      <div class="cfields">
        ${field("Marge sur VA par défaut", input("s.marge", settings.marge, { kind: "pct" }), "%")}
        ${field("Taux de marge mini", input("s.tauxMini", settings.tauxMini, { kind: "pct" }), "%")}
        ${field("Coef de sécurité mise en route", input("s.coefSecurite", settings.coefSecurite, { kind: "pct" }), "%")}
        ${field("Changement de série : heures coulée", input("s.heuresChangementCoulee", settings.heuresChangementCoulee))}
        ${field("Changement de série : heures finition", input("s.heuresChangementFinition", settings.heuresChangementFinition))}
        ${field("Hausse annuelle masse salariale", input("s.inflation.salaires", settings.inflation.salaires, { kind: "pct" }), "%")}
        ${field("Hausse annuelle conso./entretien/prestations", input("s.inflation.conso", settings.inflation.conso, { kind: "pct" }), "%")}
        ${field("Hausse annuelle électricité", input("s.inflation.elec", settings.inflation.elec, { kind: "pct" }), "%")}
        ${field("Hausse annuelle gaz", input("s.inflation.gaz", settings.inflation.gaz, { kind: "pct" }), "%")}
        ${field("Hausse annuelle autres énergies", input("s.inflation.autresEnergies", settings.inflation.autresEnergies, { kind: "pct" }), "%")}
        ${field("Électricité : ancien indice (€/MWh)", input("s.energy.elecAncien", energy.elecAncien ?? null))}
        ${field("Électricité : nouvel indice (€/MWh)", input("s.energy.elecNouveau", energy.elecNouveau ?? null))}
        ${field("Gaz : ancien indice (€/MWh)", input("s.energy.gazAncien", energy.gazAncien ?? null))}
        ${field("Gaz : nouvel indice (€/MWh)", input("s.energy.gazNouveau", energy.gazNouveau ?? null))}
      </div>
    </section>
  </div>
  <section class="ccard">
    <h3>Îlots de coulée et méthodes</h3>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Îlot</th><th>Toile mini (mm)</th><th>Épaisseur maxi (mm)</th><th>Poids maxi (kg)</th><th>Dimension maxi (mm)</th><th>Volume mini /an</th><th>Empreintes maxi</th><th>Grappe maxi (kg)</th><th>Mise au mille par défaut</th><th>Rendement type (%)</th><th>− % par doublement épaisseur maxi / toile</th><th>− % × ln(2 kg / poids)</th><th>Cycle : base (s)</th><th>+ s / kg coulé</th><th>+ s / mm² de module</th><th>Qualité /10</th><th>Outillage (€)</th><th>TTH</th><th>Noyaux</th></tr></thead>
      <tbody>${processRows}</tbody></table></div>
    <p class="small muted">Temps de cycle estimé = base + (s/kg) × kg coulés par cycle + (s/mm²) × module V/S². Mise au mille estimée = 1 / rendement, rendement = rendement type − (% par doublement) × log₂(épaisseur maxi / toile mini) − (%) × ln(2 kg / poids) pour les pièces de moins de 2 kg, borné entre 30 et 95 % (valeur par défaut tant que les épaisseurs ne sont pas calculées). Un îlot est écarté si la toile mini, le poids, la dimension, le traitement thermique ou les noyaux sont hors de ses possibilités. Valeurs de départ à ajuster aux îlots réels.</p>
  </section>
  <section class="ccard">
    <h3>Autres opérations</h3>
    <table class="ctable compact"><thead><tr><th>Opération</th><th>Cycle : base (s)</th><th>+ s / kg pièce</th><th>Pièces par cycle / charge (kg)</th></tr></thead><tbody>${opRows}</tbody></table>
  </section>
  <section class="ccard">
    <h3>Traitements thermiques</h3>
    <table class="ctable compact"><thead><tr><th>Code</th><th>Désignation</th><th>Coût / T6</th><th>Cycle type</th></tr></thead><tbody>${tthRows}</tbody></table>
    <p class="small muted">Le centre TTH du classeur est chiffré au kg pour un T6 : le coût d'un autre traitement = coût T6 × coefficient (surtout le temps de four). Le type est choisi pièce par pièce (menu « Traitement thermique ») ou repris de la demande client.</p>
  </section>
  <section class="ccard">
    <h3>Outillage : coquille acier réalisée sur place</h3>
    <div class="cfields">
      ${field("Estimer les coquilles gravité", checkbox("s.tooling.actif", tl.actif, "îlots « Coquille gravité »"), "sinon : prix de l'îlot")}
      ${tf("Nuance d'acier", "acier.nuance", tl.acier.nuance, "", { kind: "text" })}
      ${tf("Prix de l'acier (€/kg)", "acier.prixKg", tl.acier.prixKg)}
      ${tf("Densité de l'acier", "acier.densite", tl.acier.densite)}
      ${tf("Traitement de l'acier (€/kg)", "acier.traitementKg", tl.acier.traitementKg, "trempe, revenu, nitruration")}
      ${tf("Paroi autour des empreintes (mm)", "bloc.paroi", tl.bloc.paroi)}
      ${tf("Fond de chaque demi-coquille (mm)", "bloc.fond", tl.bloc.fond)}
      ${tf("Entre deux empreintes (mm)", "bloc.entreEmpreintes", tl.bloc.entreEmpreintes)}
      ${tf("Alimentation (jets, masselottes, évents)", "alimentation", tl.alimentation, "% du volume et de la surface des empreintes", { kind: "pct" })}
      ${tf("Taux horaire fraisage CNC (€/h)", "usinage.taux", tl.usinage.taux)}
      ${tf("Dressage des blocs (cm²/h)", "usinage.dressage", tl.usinage.dressage)}
      ${tf("Ébauche (cm³/min)", "usinage.ebauche", tl.usinage.ebauche, "débit de copeaux dans l'acier")}
      ${tf("Finition des empreintes (cm²/h)", "usinage.finition", tl.usinage.finition, "fraise boule")}
      ${tf("Taux horaire programmation FAO (€/h)", "usinage.tauxProgrammation", tl.usinage.tauxProgrammation)}
      ${tf("Programmation : base (h)", "usinage.programmationBase", tl.usinage.programmationBase)}
      ${tf("Programmation : h par dm² d'empreinte", "usinage.programmationParDm2", tl.usinage.programmationParDm2)}
      ${tf("Taux horaire montage / ajustage (€/h)", "montage.taux", tl.montage.taux)}
      ${tf("Montage et assemblage : base (h)", "montage.base", tl.montage.base, "ajustage, éjection, refroidissement, essais")}
      ${tf("Montage : h par empreinte", "montage.parEmpreinte", tl.montage.parEmpreinte)}
      ${tf("Montage : h si noyaux", "montage.parNoyau", tl.montage.parNoyau)}
      ${tf("Composants standard : base (€)", "composants.base", tl.composants.base, "colonnes, bagues, éjecteurs, cartouches")}
      ${tf("Composants standard : par empreinte (€)", "composants.parEmpreinte", tl.composants.parEmpreinte)}
      ${tf("Aléas", "aleas", tl.aleas, "% du total", { kind: "pct" })}
    </div>
    <p class="small muted">Deux demi-coquilles : longueur = plus grande dimension de la pièce + 2 parois, largeur = empreintes côte à côte + parois, hauteur = plus petite dimension + 2 fonds. Ébauche = volume des empreintes (volume de la pièce × empreintes + alimentation) ; finition = leur surface ; programmation selon la surface. Valeurs de départ à ajuster à l'atelier.</p>
  </section>
  <section class="ccard">
    <h3>Noyaux et boîtes à noyau</h3>
    <div class="cfields">
      ${cf("Densité du sable de noyau (kg/dm³)", "sableDensite", sc.sableDensite, "dimension estimée d'une boîte")}
      ${cf("Paroi autour du noyau (mm)", "paroi", sc.paroi)}
      ${sc.types.map((t, i) => cf(`Acier ${t.label} (€/kg)`, `types.${i}.prixKg`, t.prixKg)).join("")}
      ${cf("Usinage 3 axes présentiel (€/h)", "taux.ax3", sc.taux.ax3)}
      ${cf("Usinage 3 axes auto (€/h)", "taux.ax3auto", sc.taux.ax3auto)}
      ${cf("Usinage 5 axes présentiel (€/h)", "taux.ax5", sc.taux.ax5)}
      ${cf("Usinage 5 axes auto (€/h)", "taux.ax5auto", sc.taux.ax5auto)}
      ${cf("FAO (€/h)", "taux.fao", sc.taux.fao)}
      ${cf("Heures de FAO par boîte", "faoHeures", sc.faoHeures)}
      ${cf("Étude (€/h)", "taux.etude", sc.taux.etude)}
      ${Object.keys(sc.etude).map((k) => cf(`Heures d'étude : ${k}`, `etude.${k}`, sc.etude[k])).join("")}
      ${cf("Scan 3D (€/h)", "taux.scan", sc.taux.scan)}
      ${cf("Ajustage / montage (€/h)", "taux.ajustage", sc.taux.ajustage)}
      ${cf("Sous-traitance (STT)", "sousTraitance", sc.sousTraitance, "%", { kind: "pct" })}
      ${cf("Marge sur les boîtes", "marge", sc.marge, "%", { kind: "pct" })}
    </div>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Poids de la boîte</th><th>3 axes (h)</th><th>3 axes auto (h)</th><th>5 axes (h)</th><th>5 axes auto (h)</th><th>Tiroir 3 axes (h)</th><th>Tiroir 5 axes (h)</th><th>Scan (h)</th><th>Ajustage (h)</th></tr></thead>
      <tbody>${bandRows}</tbody></table></div>
    <p class="small muted">Méthode et heures par tranche de poids de l'onglet « 4- Outillage » (section BAN) de la demande client ; les taux horaires de ce modèle de fichier valent 10 €/h (à compléter) : les taux ci-dessus sont des valeurs de départ à ajuster. Noyautage par pièce : centre ASN, cycle = base + s/kg × sable de chaque noyau (Autres opérations).</p>
  </section>
  <section class="ccard">
    <h3>Densités des alliages (g/cm³)</h3>
    <div class="cfields">${densities}</div>
  </section>
  <p class="cactions">
    <button type="button" data-action="export-settings">Exporter les paramètres</button>
    <button type="button" data-action="import-settings">Importer des paramètres…</button>
    <input type="file" data-file="settings" accept=".json" hidden>
    <button type="button" data-action="reset-settings">Paramètres par défaut</button>
  </p>
  </div>`;
}

// --------------------------------------------------------------------------- export

async function exportXlsx() {
  const c = compute();
  const done = c?.results.filter((r) => r.final) ?? [];
  if (!done.length) return;
  const { buildXlsx, STYLE } = await import("../xlsx.js");
  const H = (v) => ({ value: v, style: STYLE.header });
  const P = (v) => (Number.isFinite(v) ? { value: v, style: STYLE.percent } : null);
  const T = (v) => (typeof v === "number" ? { value: v, style: STYLE.totalNumber } : { value: v, style: STYLE.totalText });
  const casting = (r) => r.route?.operations.find((o) => o.code === r.route.process);

  // Synthesis: the quote, one row per piece, the total of the set.
  const synthese = [
    [H("Chiffrage"), null],
    ["Client", q.client], ["Référence", q.reference], ["Désignation", q.designation], ["N° de plan", q.plan],
    ["Date", new Date().toLocaleDateString("fr-FR")], ["Modèle 3D", c.p3d?.file ?? "—"],
    ["Alliage", q.alliage], ["Date d'application des cours", q.month ? monthLabel(q.month) : "—"], ["Typologie de la moyenne", q.typologie], ["Cours utilisé", q.cours],
    ["Cours vente (€/t)", c.sale.cours], ["Premium vente (€/t)", q.premiumVente], ["Cours + P1020 + premium achat (€/t)", (q.coursAchat || 0) + (q.p1020Achat || 0) + (q.premiumAchat || 0)],
    ["Volume annuel", q.volumeAnnuel], ["Durée du programme (ans)", q.annees], ["Marge sur VA", P(q.marge ?? settings.marge)],
    ["Prototype", q.prototype ? "oui (volumes proto, sans prix cible)" : "non"],
    ["Outillage", q.outillageInclus === false ? "chiffré à part (non compris dans le prix pièce)" : "inclus dans le prix pièce (amorti sur le programme)"],
    [],
    ["Pièce", "Poids (kg)", "Toile mini (mm)", "Écritures / détails fins", "Épaisseur maxi (mm)", "Îlot", "Finition", "Fonctionnement", "Cycle (s)", "Pièces / cycle", "TRS", "Mise au mille", "Traitement thermique", "Outillage (€)", "Outillage amorti / pièce (€)", "VA PRI (€)", "Matière + PAF (€)", "PRI complet (€)", "Prix de vente (€)", "Marge sur VA"].map(H),
  ];
  for (const r of c.results) {
    const f = r.final;
    const op = casting(r);
    const t = r.piece.thickness;
    synthese.push([
      r.piece.name, r.part.poids ?? null, r.part.toileMini || null, t?.details ? `(${nf(t.details.min, 2)} mm)` : null, r.part.epaisseurMax || null,
      r.route ? `${r.route.process} — ${r.route.famille}` : "non chiffrée", r.route ? settings.operations[r.route.finition]?.label ?? r.route.finition : null,
      r.route ? r.finalRates.get(r.route.process)?.mode ?? null : null, op?.cycle ?? null, op?.parCycle ?? null, P(op?.trs), r.route?.miseAuMille ?? null,
      r.inputs.tth === "none" ? "aucun" : `${r.inputs.tth}${r.inputs.tthMode === "masselotte" ? " (avec masselottes)" : ""}`, r.route?.outillage ?? null, f?.outillages ?? null,
      f?.va ?? null, f ? f.matiere + f.perteAuFeu : null, f?.pri ?? null, f?.years[0]?.prixVente ?? null, P(f?.years[0]?.margeVaPct),
    ]);
  }
  if (c.results.length > 1) {
    const e = aggregate(done, c.years);
    synthese.push([T("TOTAL ensemble"), T(e.poids), null, null, null, null, null, null, null, null, null, null, null, T(done.reduce((n, r) => n + (r.route?.outillage || 0), 0)), T(e.outillagesPiece), T(e.va), T(e.matiere + e.perteAuFeu), T(e.pri), T(e.years[0]?.prixVente), P(e.years[0]?.margeVaPct)]);
  }
  if (q.outillageInclus === false) {
    const cost = done.reduce((n, r) => n + (r.route?.outillage || 0), 0);
    synthese.push([], [T("Outillage chiffré à part (€ HT)"), T(cost * (1 + (q.margeOutillage || 0)))], ["dont coût", cost], ["Marge sur l'outillage", P(q.margeOutillage || 0)]);
  }

  const gammes = [["Pièce", "Centre", "Nom", "Fonctionnement", "Cycle (s)", "Pièces par cycle", "TRS", "Quantité (UO / pièce)", "Taux (€/UO)", "Coût (€/pièce)"]];
  for (const r of done) {
    for (const l of r.final.lines) {
      const op = r.route.operations.find((o) => o.code === l.code) ?? {};
      gammes.push([r.piece.name, l.code, l.name, r.finalRates.get(l.code)?.mode ?? "", op.cycle ?? null, op.parCycle ?? null, l.uo === "pph" ? op.trs ?? null : null, l.units, l.rate, l.cost]);
    }
  }
  const scope = c.results.length > 1 ? aggregate(done, c.years) : done[0].final;
  const projection = [["Année", "Volume", "PRI (€)", "Prix de vente (€)", "Marge sur VA (%)", "CA (€)", "Marge sur VA annuelle (€)"]];
  for (const y of scope.years) projection.push([y.year, y.volume, y.pri, y.prixVente, y.margeVaPct, y.ca, y.margeVaAnnuelle]);
  const solutions = [["Pièce", "Rang", "Îlot", "Finition", "Cycle (s)", "Pièces par cycle", "Mise au mille", "PRI (€)", "Outillage / pièce (€)", "Qualité /10", "Qualité / prix"]];
  for (const r of done) r.best.forEach((x, i) => solutions.push([r.piece.name, i + 1, `${x.process} — ${x.famille}`, x.finition, x.cycle, x.parCycle, x.miseAuMille, x.result.pri, x.outillagePiece, x.qualite, x.ratio * 100]));

  const outillage = [["Pièce", "Poste", "Détail", "Montant (€)"].map(H)];
  for (const r of done) {
    const t = r.route.tooling;
    if (t) for (const l of t.lines) outillage.push([r.piece.name, l.label, l.detail, l.value]);
    else outillage.push([r.piece.name, `Outillage ${r.route.famille}`, "prix de l'îlot (Paramètres)", r.route.outillageEstime]);
    if (r.inputs.outillagePrix > 0) outillage.push([r.piece.name, "Prix retenu (saisi)", null, r.inputs.outillagePrix]);
    for (const b of r.route.boxes) {
      outillage.push([r.piece.name, `Boîte à noyau — ${b.core.nom}`, `${nf(b.kg, 0)} kg${b.size.auto ? " (dimensions estimées)" : ""}`, null]);
      for (const l of b.lines) outillage.push([r.piece.name, `  ${l.label}`, l.detail, l.value]);
    }
    outillage.push([T(`Total ${r.piece.name}`), null, null, T(r.route.outillage)]);
  }

  const prices = moqPrices(c);
  const serie = [
    [H("Commande série"), null],
    ["Demande client", q.serie?.fileName ?? "—"], ["Client", q.serie?.client ?? q.client], ["N° offre", q.serie?.offre ?? null],
    ["Fonderie demandée", q.serie?.fonderie ?? null], ["Prix cible (€/pièce)", q.prixCible ?? null],
    [],
    ["Année", ...c.years].map(H), ["Volume", ...c.volumes],
    [],
    ["Quantité", "Mise en route / pièce (€)", `Prix de vente ${c.years[0]} (€)`, "Marge sur VA", "Écart au prix cible (€)"].map(H),
  ];
  if (prices) {
    for (const x of [prices.base, ...prices.moqs]) serie.push([x.tailleSerie, x.miseEnRoute, x.prixVente, P(x.margeVaPct), q.prixCible > 0 ? x.prixVente - q.prixCible : null]);
  }

  const bytes = buildXlsx([
    { name: "Synthèse", rows: synthese, widths: [32, 14, 14, 20, 16, 34, 22, 14, 10, 12, 8, 12, 22, 14, 16, 12, 14, 14, 14, 12] },
    { name: "Gammes", rows: gammes, header: true, widths: [28, 10, 34, 14, 12, 14, 10, 18, 14, 14] },
    { name: "Projection", rows: projection, header: true, widths: [10, 12, 14, 18, 16, 16, 22] },
    { name: "Outillage", rows: outillage, widths: [28, 42, 60, 14] },
    { name: "Commande série", rows: serie, widths: [26, 24, 22, 14, 22, 12, 12, 12, 12, 12, 12, 12] },
    { name: "Solutions", rows: solutions, header: true, widths: [28, 8, 40, 10, 12, 14, 12, 12, 18, 12, 14] },
  ]);
  const name = (q.reference || c.p3d?.file?.replace(/\.[^.]+$/, "") || "piece").replace(/[^\w.-]+/g, "_");
  download(`chiffrage_${name}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}
