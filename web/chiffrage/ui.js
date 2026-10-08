// Costing pages: "Chiffrage" (quote of the part shown in the 3D view) and
// "Paramètres" (TRS, islands, methods, rates of increase). French only: the
// costing follows the SAB costing workbook, in French.

import { MODES, readCostingWorkbook, readIndicesWorkbook } from "./workbook.js";
import { centreRates, indexAverage, quote, saleMetalPrice, solveMargin as minimumMargin } from "./model.js";
import { bestRoutes, buildRoute, rankRoutes } from "./routes.js";
import { estimateTooling } from "./tooling.js";
import { coreBoxCost, coresPerPiece, newCore } from "./cores.js";
import { filledFields, orderValues, programmeFor, programmeOf, readSeriesOrder } from "./rfq.js";
import { ALERTES, SEUIL_TENDANCE, SOURCES as TRACE_SOURCES, demandeComparee, label as traceLabel, summarize, traceEnsemble, tracePiece, traceQuote } from "./provenance.js";
import { compareCycles, countHistory, exportHistory, importHistory, mergeHistory, productionRecord } from "./history.js";
import {
  SIMILAR, adoptEstimate, adoptedEstimate, anonymiseCycleData, cycleData, cycleNumbers, cycleQuestion, cycleText, fitCycleData, forgetAdoption, localCycleRules, readCycleAnswer, recordCycleData, undoAdoption,
} from "./ai-cycle.js";
import { DEFAULT_INTERVAL_S, backtestCsv, backtestItems, backtestReading, backtestRows, fingerprint, leaveOneOut, resultOf, runBacktest, summarizeBacktest } from "./backtest.js";
import { askJSON, numbersLabel, savedAI } from "../ai-workspace.js";
import * as store from "./store.js";

let el = null;
let page = "chiffrage";
let base = store.loadBase();
let indices = store.loadIndices();
// Settings: the effective ones (used everywhere), and their layers (store.js) for the Paramètres page.
let layers = store.loadSettingsLayers(base);
let settings = layers.effective;
let q = store.loadQuote(base, indices);
let message = null; // {kind: "ok" | "error", text}
let thicknessBusy = false;
let traceOpen = false; // detail of the traced values unfolded (card "Traçabilité")

export function mount(targets) {
  el = targets;
  for (const container of Object.values(el)) {
    container.addEventListener("change", onChange);
    container.addEventListener("click", onClick);
    container.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, [data-action]")) pointerDown = true;
    }, true);
    // A file dropped on the row of a data file replaces that file.
    container.addEventListener("dragover", (e) => {
      const zone = e.target.closest?.("[data-drop]");
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      for (const z of container.querySelectorAll(".drop-target")) if (z !== zone) z.classList.remove("drop-target");
      zone.classList.add("drop-target");
    });
    container.addEventListener("dragleave", (e) => {
      const zone = e.target.closest?.("[data-drop]");
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("drop-target");
    });
    container.addEventListener("drop", (e) => {
      const zone = e.target.closest?.("[data-drop]");
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("drop-target");
      const file = e.dataTransfer.files?.[0];
      if (file) importFile({ files: [file], dataset: { file: zone.dataset.drop }, value: "" });
    });
  }
  document.addEventListener("reader3d-part", () => {
    if (!el.chiffrage.hidden) render();
  });
  return { show, setTab, forgetTab };
}

/** The settings resolved again from their layers (after an input, an import, the workbook). */
function reloadSettings() {
  const before = densityOf(q?.alliage);
  layers = store.loadSettingsLayers(base);
  settings = layers.effective;
  if (q && densityOf(q.alliage) !== before) pushMaterial();
}

/** Density of an alloy: the one of Paramètres, else the generic density (alert in the trace). */
const densityOf = (alloy) => settings.densities[alloy] ?? store.GENERIC_DENSITY;

/**
 * The alloy of the quote and its density to the 3D page (mass of the part):
 * one density, the one the costing uses. At each change of the alloy (typed
 * in, customer request) or of its density.
 */
function pushMaterial() {
  if (q.alliage) window.reader3d?.setMaterial?.(q.alliage, densityOf(q.alliage));
}

/** The data files, the settings and the quote read again from this browser's storage (tests). */
export function reload() {
  base = store.loadBase();
  indices = store.loadIndices();
  reloadSettings();
  q = store.loadQuote(base, indices);
}

export function show(name) {
  page = name;
  render();
}

/** The tab `id` of the 3D page is shown: its own quote (the settings and the workbooks are shared). */
export function setTab(id) {
  store.setQuoteTab(id);
  q = store.loadQuote(base, indices);
  message = null;
  render();
}

/** The tab `id` was closed: its quote is forgotten. */
export const forgetTab = (id) => store.forgetQuote(id);

/**
 * An answer of the AI page on the costing (task "Chiffrage") kept with the
 * quote of the tab `tab` of the 3D page: {date, provider, model, question,
 * answer, verified}. A record only: nothing in it is applied to the quote or
 * the settings. The Excel export lists them (sheet "Analyses IA").
 */
export function addAIAnalysis(entry, { tab = store.currentQuoteTab() } = {}) {
  // The quote shown in the Chiffrage page is the one in memory, saved at each change.
  if (el && tab === store.currentQuoteTab()) {
    q.analysesIA = [...(q.analysesIA ?? []), entry];
    store.saveQuote(q);
  } else store.appendToQuote(tab, "analysesIA", entry);
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
const USER_FIELDS = ["client", "reference", "designation", "plan", "volumeAnnuel", "annees", "premiereAnnee", "volumes", "pieces", "pieceFile", "serie", "serieAvant", "serieRetiree", "moqs", "prixCible", "serieEnergie", "outillageInclus", "margeOutillage", "prototype"];
// Inputs of each piece (q.pieces[key]); null: from the 3D model or estimated.
const PIECE_DEFAULTS = {
  poids: null, toileMini: null, epaisseurMax: null, moduleMm: null, dimMax: null,
  tth: null, // heat treatment (code of settings.tth or "none"); null: the one of the customer request, else none
  tthMode: "scie", // weight treated: the piece ("scie": feeders sawn off before) or the casting with its feeders
  noyaux: false, sableKg: 0, tribo: false, redressage: false,
  procede: "auto", finition: "auto", mode: null, cycle: null, empreintes: null, miseAuMille: null,
  outillagePrix: null, // € of the tooling; null: estimated
  outillageTiroirs: null, outillageComplexite: null, // slides and complexity of the die; null: the defaults of the settings
  cores: [], // sand cores (cores.js): {nom, masse kg, qte per piece, L, l, h box mm, type, tiroirs, complexite}
  composants: [],
  cycleReel: null, // real cycle time measured in production (s), to keep in the history (Retour d'expérience); not used by the costing
  estimationCycleIA: null, // the last estimate of the cycle time by the AI for this piece (ai-cycle.js): a proposal
  cycleIA: null, // the estimate used as the cycle typed in ("Utiliser cette valeur"): {date, valeur, avant, estimation}
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
    // Box "Envoyer les pièces similaires de l'historique": a choice of this browser, not of the quote.
    if (target.dataset.pref === "cycle-similar") {
      setSendSimilar(target.checked);
      setTimeout(render, 0);
    }
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
    if (path === "prototype") switchProgramme();
    if (path === "alliage") pushMaterial();
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
    forgetAdoption(piece);
    store.saveQuote(q);
  } else {
    // Paramètres: only the typed values are kept (store.js); an emptied field
    // is not set, the next layer (workbook, trend, default) applies again.
    const refused = store.setSetting(path, value, base);
    if (refused) message = { kind: "error", text: `Valeur refusée (${refused}) : non enregistrée.` };
    reloadSettings();
  }
  setTimeout(render, 0);
}

async function onClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "import-workbook" || action === "import-indices" || action === "import-tendances" || action === "import-rfq" || action === "import-historique") button.parentElement.querySelector("input[data-file]")?.click();
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
    forgetAdoption(piece);
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
      q.margeMini = { valeur: m, tauxMini: settings.tauxMini };
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
    removeSeriesOrder();
    render();
  } else if (action === "restore-before-rfq" || action === "keep-rfq-values") {
    if (action === "restore-before-rfq") restoreBeforeSeriesOrder();
    q.serieRetiree = null;
    store.saveQuote(q);
    render();
  } else if (action === "reset-quote") {
    if (!confirm("Effacer les saisies de ce chiffrage ?")) return;
    store.resetQuote();
    q = store.defaultQuote(base, indices);
    render();
  } else if (action === "clear-saisies") {
    const n = Object.keys(layers.saisies.values).length;
    const t = layers.tendances;
    if (!confirm(`Effacer vos ${n} valeur${n > 1 ? "s" : ""} saisie${n > 1 ? "s" : ""} dans Paramètres ?\n\nSont conservés : ${t ? `les tendances importées (« ${t.fileName} »), ` : ""}le classeur de chiffrage. Chaque valeur effacée reprend celle du classeur, sinon la tendance, sinon la valeur par défaut du code.`)) return;
    store.clearSaisies();
    reloadSettings();
    message = { kind: "ok", text: "Saisies de Paramètres effacées." };
    render();
  } else if (action === "clear-tendances") {
    const t = layers.tendances;
    if (!t || !confirm(`Effacer les tendances importées (« ${t.fileName} », ${store.countValues(t.values)} valeurs) ?\n\nSont conservés : vos saisies de Paramètres et le classeur de chiffrage. Les valeurs qui venaient des tendances reprennent la valeur par défaut du code.`)) return;
    store.clearTendances();
    reloadSettings();
    message = { kind: "ok", text: `Tendances « ${t.fileName} » effacées.` };
    render();
  } else if (action === "adopt-trend") {
    store.adoptTendance(button.dataset.path, base);
    reloadSettings();
    render();
  } else if (action === "export-saisies") {
    download("parametres_saisis.json", new Blob([JSON.stringify(store.exportSaisies(base), null, 2)], { type: "application/json" }));
  } else if (action === "export-tendances") {
    const t = store.exportTendances();
    if (t) download(t.fileName || "tendances.json", new Blob([JSON.stringify(t.values, null, 2)], { type: "application/json" }));
  } else if (action === "show-trace") {
    traceOpen = true;
    render();
    el.chiffrage.querySelector("#ctrace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (action === "toggle-trace") {
    // Clicked before the details element toggles: kept open or closed at the next rendering.
    traceOpen = !button.parentElement.open;
  } else if (action === "save-feedback") {
    saveFeedback();
    render();
  } else if (action === "estimate-cycle") {
    estimateCycle();
  } else if (action === "cancel-cycle") {
    cycleJob?.controller.abort();
  } else if (action === "adopt-cycle") {
    adoptCycle();
    render();
  } else if (action === "undo-cycle") {
    undoCycle();
    render();
  } else if (action === "backtest") {
    startBacktest();
  } else if (action === "cancel-backtest") {
    backtestJob?.controller.abort();
  } else if (action === "export-backtest") {
    const rows = backtestRows(backtestItems(store.loadHistorique()), store.loadBancEssai().resultats, settings);
    // The BOM makes spreadsheet software read the references as UTF-8.
    download("banc_essai_ia.csv", new Blob([`\ufeff${backtestCsv(rows)}`], { type: "text/csv;charset=utf-8" }));
  } else if (action === "clear-backtest") {
    if (backtestJob || !confirm("Effacer les résultats du banc d'essai IA ?\n\nIls ne sont gardés que dans ce navigateur : exportez-les d'abord (CSV) pour les conserver. L'historique, le chiffrage et les paramètres ne changent pas.")) return;
    store.saveBancEssai(null);
    message = { kind: "ok", text: "Résultats du banc d'essai IA effacés." };
    render();
  } else if (action === "export-historique") {
    download("historique_cycles.json", new Blob([JSON.stringify(exportHistory(store.loadHistorique()), null, 2)], { type: "application/json" }));
  } else if (action === "clear-historique") {
    const n = countHistory(store.loadHistorique());
    if (!n.total || !confirm(`Effacer l'historique des temps de cycle (${plural(n.total, "enregistrement")}, dont ${n.production} temps mesuré${n.production > 1 ? "s" : ""} en production) ?\n\nIl n'est gardé que dans ce navigateur : exportez-le d'abord pour le conserver. Le chiffrage et les paramètres ne changent pas.`)) return;
    store.saveHistorique([]);
    message = { kind: "ok", text: "Historique des temps de cycle effacé." };
    render();
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
      reloadSettings();
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
    } else if (target.dataset.file === "tendances") {
      // The calibrated settings file: its own layer, below the typed values and the workbook (store.js).
      const report = store.importTendances(JSON.parse(new TextDecoder().decode(bytes)), file.name);
      reloadSettings();
      message = tendancesMessage(file.name, report);
    } else if (target.dataset.file === "historique") {
      // Cycle times of past quotes and of production: merged into the history of this browser (history.js).
      const { pieces, report } = importHistory(store.loadHistorique(), JSON.parse(new TextDecoder().decode(bytes)));
      message = historyMessage(file.name, report, store.saveHistorique(pieces));
    }
  } catch (err) {
    message = { kind: "error", text: `${file.name} : ${err.message || err}` };
  }
  render();
}

/** The first 8 of `items` as text (`label` of each), and how many others. */
const list = (items, label) => `${items.slice(0, 8).map(label).join(", ")}${items.length > 8 ? ` et ${items.length - 8} autre${items.length > 9 ? "s" : ""}` : ""}`;

// Said when the history could not be written in this browser's storage (store.js keeps it for the visit).
const UNSAVED_HISTORY = " Le stockage de ce navigateur est plein ou bloqué : l'historique n'est gardé que pendant cette visite, exportez-le pour ne pas le perdre.";

/** What an imported trends file brought, and what of it was left out (unknown keys, refused values). */
function tendancesMessage(name, report) {
  let text = `Tendances « ${name} » importées : ${report.count} valeur${report.count > 1 ? "s" : ""}, appliquées là où rien n'est saisi ni lu dans le classeur.`;
  if (report.unknown.length) text += ` Clés inconnues, ignorées : ${list(report.unknown, (u) => `${u.path}${u.suggestion ? ` (vouliez-vous dire « ${u.suggestion} » ?)` : ""}`)}.`;
  if (report.invalid.length) text += ` Valeurs refusées : ${list(report.invalid, (x) => `${x.path || "fichier"} (${x.reason})`)}.`;
  if (report.completed.length) text += ` Lignes de tableau incomplètes, complétées par les valeurs par défaut : ${list(report.completed, (p) => p)}.`;
  return { kind: report.unknown.length || report.invalid.length || report.completed.length ? "warn" : "ok", text };
}

/** What an imported history file brought, and what of it was left out (records refused, values and fields ignored). */
function historyMessage(name, report, saved) {
  let text = `Historique « ${name} » importé : ${plural(report.count, "enregistrement")} (${report.added} ajouté${report.added > 1 ? "s" : ""}, ${report.replaced} remplacé${report.replaced > 1 ? "s" : ""} : même référence et même source).`;
  if (report.refused.length) text += ` Enregistrements refusés : ${list(report.refused, (x) => `${x.name} (${x.reasons.join(", ")})`)}.`;
  if (report.ignored.length) text += ` Valeurs ignorées : ${list(report.ignored, (x) => `${x.name} ${x.field} (${x.reason})`)}.`;
  if (report.unknown.length) text += ` Champs inconnus, ignorés : ${list(report.unknown, (k) => k)}.`;
  if (!saved) text += UNSAVED_HISTORY;
  return { kind: report.refused.length || report.ignored.length || report.unknown.length || !saved ? "warn" : "ok", text };
}

/**
 * Prototype or series (the box just ticked or unticked): the volumes of the
 * request for that mode, only in place of volumes that came from the request;
 * volumes typed in are kept, and the message says so.
 */
function switchProgramme() {
  const { programme, typed, ignored } = programmeFor(q, q.serie, q.prototype);
  if (programme) {
    q.premiereAnnee = programme.premiereAnnee;
    q.annees = programme.annees;
    q.volumes = programme.volumes;
    q.volumeAnnuel = programme.pic;
  } else if (typed) {
    message = {
      kind: "warn",
      text: `Volumes saisis conservés : les volumes ${q.prototype ? "proto" : "série"} de la demande client (${plural(ignored.annees, "an")} à partir de ${ignored.premiereAnnee}, ${nf(ignored.volumes.reduce((a, b) => a + b, 0), 0)} pièces) ne les remplacent pas. Réimportez la demande pour les reprendre.`,
    };
  }
}

/** The lists the values of a request are picked in: alloys, typologies, price indices. */
const orderLists = () => ({
  alliages: base?.lists.alliages,
  typologies: indices?.typologies?.length ? indices.typologies.map((t) => t.name) : base?.lists.typologies,
  cours: base?.lists.cours,
});

/**
 * Take the series order of a customer request into the quote (rfq.js:orderValues).
 * The values it replaces are kept as they were before the first request
 * (q.serieAvant), to put them back when the request is removed.
 */
function applySeriesOrder(order) {
  const values = orderValues(order, orderLists());
  const avant = { ...q.serieAvant };
  for (const k of Object.keys(values)) if (!(k in avant)) avant[k] = q[k] ?? null;
  q.serie = order;
  q.serieAvant = avant;
  q.serieRetiree = null;
  Object.assign(q, JSON.parse(JSON.stringify(values)));
  // The same alloy as the material of the 3D analysis (its mass).
  pushMaterial();
}

// Fields of the quote a customer request fills (rfq.js:orderValues), as named in the page.
const ORDER_FIELDS = {
  client: "client", reference: "référence", designation: "désignation", plan: "n° de plan", prototype: "prototype",
  premiereAnnee: "première année", annees: "durée du programme", volumes: "volumes par année", volumeAnnuel: "volume annuel",
  moqs: "MOQ", tailleSerie: "taille de série", prixCible: "prix cible", alliage: "alliage", typologie: "typologie de la moyenne",
  cours: "cours utilisé", month: "date d'application des cours", coursAchat: "cours achat", p1020Achat: "P1020 achat",
  premiumAchat: "premium achat", premiumVente: "premium vente", pafAchat: "perte au feu achat", pafVente: "PAF vendue",
};
const fieldNames = (fields) => fields.map((k) => ORDER_FIELDS[k] ?? k).join(", ");
const ORDER_RANK = Object.keys(ORDER_FIELDS);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * "Retirer": the request is removed. The fields it filled keep their values
 * until the user puts back those of before the import or keeps them
 * (q.serieRetiree, card "Commande série"): never left without a word.
 */
function removeSeriesOrder() {
  const order = q.serie;
  const values = orderValues(order, orderLists(), { proto: q.prototype });
  const avant = q.serieAvant ?? {};
  // Still the request's value, and not the one the field already had before the import.
  const filled = filledFields(q, values)
    .filter((k) => !(k in avant) || !sameJson(avant[k], values[k]))
    .sort((a, b) => ORDER_RANK.indexOf(a) - ORDER_RANK.indexOf(b));
  q.serie = null;
  q.serieAvant = null;
  q.serieRetiree = filled.length
    ? { fileName: order.fileName, fields: Object.fromEntries(filled.map((k) => [k, values[k]])), avant: Object.fromEntries(filled.filter((k) => k in avant).map((k) => [k, avant[k]])) }
    : null;
  store.saveQuote(q);
  // Its heat treatment was the one of the pieces without a choice of their own (pieceInputs): no longer.
  const tth = order.tth ? ` Son traitement thermique (${order.tth}) ne s'applique plus aux pièces sans traitement choisi : choisissez-le pour chaque pièce s'il le faut.` : "";
  message = filled.length
    ? { kind: "warn", text: `Demande client « ${order.fileName} » retirée. Ces champs gardent les valeurs qu'elle avait remplies : ${fieldNames(filled)}. Vérifiez-les, ou remettez les valeurs d'avant l'import (carte « Commande série »).${tth}` }
    : { kind: tth ? "warn" : "ok", text: `Demande client « ${order.fileName} » retirée.${tth}` };
}

/** The fields still holding the values of the request removed (q.serieRetiree). */
const stillFilled = (r) => (r ? filledFields(q, r.fields) : []);

/** The fields the request removed had filled, still with its values: back to those of before the import (else of a new quote). */
function restoreBeforeSeriesOrder() {
  const r = q.serieRetiree;
  const fresh = store.defaultQuote(base, indices);
  for (const k of stillFilled(r)) q[k] = k in (r.avant ?? {}) ? r.avant[k] : fresh[k];
  pushMaterial();
  message = { kind: "ok", text: `Valeurs d'avant l'import de « ${r.fileName} » remises.` };
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

/**
 * Everything the page shows, from the data, the settings and the inputs, with
 * the trace of its values (provenance.js): out.trace for the quote, r.trace
 * for each piece. Exported for the tests. save: false for a computation that
 * must change nothing in this browser's storage (costingSnapshot).
 */
export function compute({ save = true } = {}) {
  if (!base) return null;
  const p3d = window.reader3d?.part?.() ?? null;
  // Another 3D file: the inputs of the pieces of the previous one do not apply.
  const file = p3d?.file ?? null;
  if (file !== (q.pieceFile ?? null)) {
    q.pieceFile = file;
    q.pieces = {};
    if (save) store.saveQuote(q);
  }
  const allPieces = piecesOf(p3d);
  const pieces = selectedPieces(p3d, allPieces);
  if (!pieces.length) return { p3d, allPieces, pieces, selected: null, results: [] };
  const selected = pieces.length > 1 ? "ensemble" : pieces[0].key;
  currentKey = selected === "ensemble" ? currentKey : selected;

  const density = densityOf(q.alliage);
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
  // Where each value comes from: traced after the computation, it changes none of them.
  // The weight and the mise au mille of the customer request: compared with the piece costed alone, else with the set.
  const ctx = { ...traceContext(p3d), demandePiece: pieces.length === 1 };
  common.trace = traceQuote(ctx, common);
  const results = pieces.map((piece) => computePiece(piece, common, ctx));
  const out = { p3d, allPieces, pieces, selected, results, ...common };
  if (selected === "ensemble") {
    out.ensemble = aggregate(results.filter((r) => r.final), years);
    Object.assign(out.trace, traceEnsemble(ctx, results, out.ensemble));
  }
  return out;
}

/** What the traces read: the quote, the data files, the settings and their layers. */
function traceContext(p3d) {
  return { q, base, indices, layers, settings, seuil: settings.seuilTendance ?? SEUIL_TENDANCE, p3dFile: p3d?.file ?? null };
}

/** Quote of one piece: its features, the routes, the retained route and its costing; and their trace (out.trace). */
function computePiece(piece, { density, years, volumes, volumeTotal, metal, energy, rates, trace }, ctx) {
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
    outillageTiroirs: inputs.outillageTiroirs ?? null,
    outillageComplexite: inputs.outillageComplexite || null,
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
  const traced = () => ((out.trace = tracePiece(out, ctx, trace)), out);
  if (!(part.poids > 0)) return traced();

  const ranked = rankRoutes(rates, base.lists, part, settings, quoteBase);
  const best = bestRoutes(ranked, 3);
  out.ranked = ranked;
  out.best = best;

  // The route retained: the best one, or the island chosen in the page.
  const chosen = inputs.procede !== "auto" && settings.processes[inputs.procede] && rates.has(inputs.procede);
  const code = chosen ? inputs.procede : best[0]?.process;
  if (!code) return traced();
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
  route.boxes = part.noyaux ? (inputs.cores ?? []).map((core) => ({ core, ...coreBoxCost(core, settings.cores, settings.tooling) })) : [];
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
            { designation: route.tooling ? (/^Basse pression/i.test(process.famille) ? "Moule basse pression acier réalisé sur place" : "Coquille acier réalisée sur place") : `Outillage ${process.famille}`, qte: 1, prix: route.outillageMoule },
            ...route.boxes.map((b) => ({ designation: `Boîte à noyau — ${b.core.nom}`, qte: 1, prix: b.total })),
          ],
    margeOutillages: 0,
  };
  out.final = quote(finalRates, base.lists, out.finalInput);
  return traced();
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

// --------------------------------------------------------------------------- read-only snapshot (AI page)

/** `o` and everything it holds made read-only. */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * The costing of the quote shown, read only, for the AI page (task
 * "Chiffrage", web/ai-workspace.js): the traced values of the quote and of
 * each piece costed, its three best routes with their reasons, the alerts,
 * and the data files with their dates. A deep-frozen copy, computed on a copy
 * of the quote: nothing is saved and nothing in it leads back to the quote
 * or the settings (the AI explains, it never sets a value). Works without the
 * costing page having been opened: the data files, the settings and the quote
 * of the tab `tab` of the 3D page are then read from this browser's storage.
 * null without a costing workbook.
 *   {devis: {ensemble, trace}, pieces: [{nom, chiffree, trace, routes}],
 *    alertes, resume: {valeurs, a_valider, alertes}, fichiers: {classeur, indices, tendances, rfq},
 *    noms: [{name, label}]}
 * noms: the names of the quote that tell the customer or the part (client,
 * reference, designation, plan, request, cores, components), never sent:
 * the AI page puts their labels in their place in what it sends online.
 */
export function costingSnapshot({ tab } = {}) {
  if (!el) {
    if (tab !== undefined) store.setQuoteTab(tab);
    base = store.loadBase();
    indices = store.loadIndices();
    layers = store.loadSettingsLayers(base);
    settings = layers.effective;
    q = store.loadQuote(base, indices);
  }
  if (!base) return null;
  const [quoteShown, keyShown] = [q, currentKey];
  q = structuredClone(q);
  let c;
  try {
    c = compute({ save: false });
  } finally {
    [q, currentKey] = [quoteShown, keyShown];
  }
  const routes = (r) => {
    const best = r.best ?? [];
    // The island retained when it was chosen in the page outside the three best.
    const shown = r.route && !best.some((b) => b.process === r.route.process) ? [...best, r.route] : best;
    return shown.map((x, i) => ({
      rang: best.includes(x) ? i + 1 : null,
      ilot: x.process,
      famille: x.famille,
      finition: x.finition,
      retenue: x.process === r.route?.process,
      faisable: x.feasible,
      qualite: x.qualite,
      prix: Number.isFinite(x.prix) ? x.prix : null, // PRI + tooling per piece (€): the ranking is by quality / price
      raisons: [...x.reasons, ...x.warnings],
    }));
  };
  const sections = [{ piece: null, trace: c.trace ?? {} }, ...c.results.map((r) => ({ piece: r.piece.name, trace: r.trace ?? {} }))];
  const sum = summarize(sections);
  const file = (name, date, extra = {}) => (name || date ? { nom: name ?? null, date: date ?? null, ...extra } : null);
  const t = layers.tendances;
  return deepFreeze(structuredClone({
    devis: { ensemble: c.selected === "ensemble", trace: c.trace ?? {} },
    pieces: c.results.map((r) => ({ nom: r.piece.name, chiffree: !!r.final, trace: r.trace ?? {}, routes: routes(r) })),
    alertes: sum.alertes,
    resume: { valeurs: sum.valeurs, a_valider: sum.aValider, alertes: sum.alertes.length },
    fichiers: {
      classeur: file(base.source?.fileName, base.source?.importedAt),
      indices: indices ? file(indices.fileName, indices.importedAt, { source: indices.source === "fichier" ? "fichier des cours" : "copie du classeur" }) : null,
      tendances: t ? file(t.fileName, t.importedAt) : null,
      rfq: q.serie ? file(q.serie.fileName, q.serie.importedAt) : null,
    },
    noms: namesOf(q),
  }));
}

/**
 * The names of the quote of the tab `tab` of the 3D page that tell the
 * customer or the part (namesOf), also without a costing workbook: the AI page
 * puts their labels in their place in what it sends online, whatever its task.
 */
export function costingNames({ tab = store.currentQuoteTab() } = {}) {
  return namesOf(el && tab === store.currentQuoteTab() ? q : store.savedQuote(tab) ?? {});
}

/** The names of quote `q` that tell the customer or the part, each with its neutral label (costingSnapshot noms). */
function namesOf(q) {
  const s = q.serie ?? {};
  const pieces = Object.values(q.pieces ?? {});
  return [
    ...[[q.client, "Client"], [s.client, "Client"], [q.reference, "Référence"], [q.designation, "Désignation"], [s.reference, "Référence"],
      [q.plan, "Plan"], [s.plan, "Plan"], [s.demande, "Demande"], [s.offre, "Offre"], [s.gsab, "Numéro de dossier"]],
    ...[...new Set(pieces.flatMap((p) => p.cores ?? []).map((c) => c?.nom))].map((n, i) => [n, `Noyau ${i + 1}`]),
    ...[...new Set([...(q.composants ?? []), ...pieces.flatMap((p) => p.composants ?? [])].map((c) => c?.designation))].map((n, i) => [n, `Composant ${i + 1}`]),
  ].filter(([name]) => typeof name === "string" && name.trim()).map(([name, label]) => ({ name: name.trim(), label }));
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
    <div class="crow" data-drop="workbook" title="Glissez un classeur ici pour le remplacer"><span>Classeur de chiffrage :</span> <strong>${base ? `${esc(base.source?.fileName)} — importé le ${dateLabel(base.source?.importedAt)}` : "aucun"}</strong>
      <button type="button" class="small" data-action="import-workbook">Importer le classeur…</button>
      <input type="file" data-file="workbook" accept=".xlsm,.xlsx" hidden></div>
    <div class="crow" data-drop="indices" title="Glissez un fichier d'indices ici pour le remplacer"><span>Indices matière :</span> <strong>${indicesInfo}</strong>
      <button type="button" class="small" data-action="import-indices">Importer les indices…</button>
      <input type="file" data-file="indices" accept=".xlsx,.xlsm" hidden></div>
    <div class="crow" data-drop="rfq" title="Glissez une demande client ici pour la remplacer"><span>Commande série :</span> <strong>${q.serie ? `${esc(q.serie.fileName)} — importée le ${dateLabel(q.serie.importedAt)}` : "aucune"}</strong>
      <button type="button" class="small" data-action="import-rfq">Importer la demande client…</button>
      <input type="file" data-file="rfq" accept=".xlsm,.xlsx" hidden>${q.serie ? ` <button type="button" class="small" data-action="remove-rfq">Retirer</button>` : ""}</div>
    <p class="muted small">Glissez-déposez un fichier sur sa ligne pour le remplacer. Les fichiers sont lus dans ce navigateur et mémorisés sur ce poste : rien n'est envoyé sur Internet.
      Indices : fichier Excel avec un onglet « Suivi indice » (comme VALEURS MB LME.xlsx) ; réimportez-le après chaque mise à jour des cours.</p>
  </section>`;
}

function renderQuote() {
  if (!base) {
    return `<div class="cpage">${messageHtml()}${sourcesCard()}
      <section class="ccard"><h3>Chiffrage de pièce</h3>
      <p>Importez d'abord le classeur de chiffrage (.xlsm) : les coûts des centres de profit, les listes (alliages, coefficients, cours) et les valeurs par défaut en sont tirés.</p></section>
      ${historyCard()}</div>`;
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
      <p>Aucune pièce sélectionnée : cochez au moins un corps fermé dans la liste des corps de la page Analyse 3D, ou choisissez une pièce ci-dessus.</p></section></div>
      ${historyCard()}</div>`;
  }

  const sections = traceSections(c);
  const traces = summarize(sections);
  return `<div class="cpage">${messageHtml()}
  ${traceBanner(traces)}
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

  ${ensemble ? "" : cycleCard(r)}
  ${!ensemble && r?.inputs.noyaux ? coresFields(r) : ""}
  ${ensemble ? ensembleCard(c) : solutionsCard(r)}
  ${ensemble ? ensembleDetailCard(c) : detailCard(r)}
  ${seriesCard(c)}
  ${projectionCard(c, ensemble ? c.ensemble : r?.final)}
  ${traceCard(sections, traces)}
  ${ensemble ? "" : feedbackCard(c, r)}
  ${historyCard()}
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
      ${field("Traitement thermique", select("p.tth", i.tth, [["none", "Aucun"], ...Object.entries(settings.tth).map(([code, t]) => [code, t.label])]), tthHint(r))}
      ${i.tth !== "none" ? field("Poids traité", select("p.tthMode", i.tthMode, [["scie", "Pièce seule (masselottes sciées avant)"], ["masselotte", "Pièce avec masselottes (grappe)"]])) : ""}
      ${field("Noyaux sable", checkbox("p.noyaux", i.noyaux, "oui"))}
      ${field("Tribofinition", checkbox("p.tribo", i.tribo, "oui"))}
      ${field("Redressage", checkbox("p.redressage", i.redressage, "oui"))}
    </div>
    ${i.noyaux ? `<p class="small">Noyaux : voir la carte « Noyaux et boîtes à noyau » ci-dessous.</p>` : ""}`;
}

/** Under the heat treatment: its cycle; and "selon la demande client" only when it comes from the request (nothing chosen for the piece). */
function tthHint(r) {
  const i = r.inputs;
  const fromRequest = q.serie && (q.pieces?.[r.piece.key]?.tth ?? null) === null;
  return [
    i.tth !== "none" ? esc(settings.tth[i.tth]?.cycle ?? "") : "",
    fromRequest ? (q.serie.tth ? "selon la demande client" : "aucun dans la demande client") : "",
  ].filter(Boolean).join(" — ");
}

/** The sand cores of a piece and their core boxes. */
function coresFields(r) {
  const cores = r.inputs.cores ?? [];
  const sc = settings.cores;
  const rows = cores
    .map((c, i) => {
      const box = coreBoxCost(c, sc, settings.tooling);
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
        ${field("TRS de l'îlot", `<output>${routeCode ? pct(r.route.operations.find((o) => o.code === routeCode)?.trs, 0) : "—"}</output>`, "modifiable dans Paramètres")}
      </div>
      ${routeCode ? cycleButton(r) : ""}
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
      <h3>Outillage — ${t ? (/^Basse pression/i.test(route.famille) ? "moule basse pression acier réalisé sur place" : "coquille acier réalisée sur place") : esc(route.famille)}</h3>
      <div class="cscroll"><table class="ctable">
        <tbody>${rows}</tbody>
        <tfoot><tr><td><strong>Total estimé</strong></td><td class="muted small">${t ? `${t.cavities} empreinte${t.cavities > 1 ? "s" : ""}, ${t.tiroirs} tiroir${t.tiroirs > 1 ? "s" : ""}, ${esc(t.complexite)} — outillage suivant ${total(t.suivant)} (sans étude ni FAO)` : ""}</td><td class="num"><strong>${total(route.outillageEstime)}</strong></td></tr></tfoot>
      </table></div>
      <div class="cfields">
        ${t ? field("Tiroirs du moule", input("p.outillageTiroirs", r.inputs.outillageTiroirs, { min: 0, step: 1, placeholder: nf(settings.tooling.tiroirs, 0) }), "vide = valeur par défaut") : ""}
        ${t ? field("Complexité du moule", select("p.outillageComplexite", r.inputs.outillageComplexite ?? "", [["", `par défaut (${settings.tooling.complexite})`], ...Object.keys(settings.tooling.etude).map((k) => [k, k])]), "heures d'étude et de FAO") : ""}
        ${field("Prix d'outillage retenu (€)", input("p.outillagePrix", r.inputs.outillagePrix, { min: 0, placeholder: nf(route.outillageEstime, 0) }), "vide = estimation")}
        ${q.outillageInclus === false
          ? field("Vendu à part", `<output>${eur(route.outillage * (1 + (q.margeOutillage || 0)), 0)} HT</output>`, "non compris dans le prix pièce (voir le détail du chiffrage)")
          : field("Amorti par pièce", `<output>${amortised === null ? "—" : eur(amortised, 3)}</output>`, `sur ${nf(r.part.volumeTotal, 0)} pièces du programme, compris dans le prix pièce`)}
      </div>
      ${t ? `<p class="small muted">Méthode du classeur « Outillage fonderie » : moule ${nf(t.block.L, 0)} × ${nf(t.block.W, 0)} × ${nf(t.block.H, 0)} mm = encombrement de la pièce + marges, poids × coefficient, heures d'usinage, de scan et d'ajustage par tranche de poids, étude et FAO selon la complexité. Taux et tableaux dans Paramètres.</p>` : ""}
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

/**
 * The weight, the mise au mille and the scrap rate of the customer request
 * against those the costing uses (provenance.js:demandeComparee): for the
 * piece shown, or the set. Read from the traces, which carry the same
 * comparison (alternatives, alert beyond the tolerance).
 */
function demandeRows(c) {
  const T = c.selected === "ensemble" ? c.trace : c.results.find((r) => r.piece.key === c.selected)?.trace ?? {};
  const used = (k) => T[`${c.selected === "ensemble" ? "ensemble" : "piece"}.${k}`]?.valeur;
  return demandeComparee(q.serie, { poids: used("poids"), miseAuMille: used("miseAuMille"), rebutUsinage: c.trace["devis.rebutUsinage"]?.valeur });
}

/** A value of the request or of the costing, by its unit. */
const demandeValue = (v, unite) => (v === null || v === undefined ? "—" : unite === "%" ? pct(v, 2) : unite === "kg" ? `${nf(v, 3)} kg` : nf(v, 2));

/** The fields a request removed had filled and that still hold its values: a notice, and the choice. */
function removedOrderNotice() {
  const r = q.serieRetiree;
  const fields = stillFilled(r);
  if (q.serie || !fields.length) return "";
  const back = fields.every((k) => k in (r.avant ?? {}));
  return `<p class="cmsg warn">Demande client « ${esc(r.fileName)} » retirée : ces champs gardent les valeurs qu'elle avait remplies : ${esc(fieldNames(fields))}.
    <button type="button" class="small" data-action="restore-before-rfq">${back ? "Remettre les valeurs d'avant l'import" : "Remettre les valeurs d'avant l'import (sinon celles d'un nouveau chiffrage)"}</button>
    <button type="button" class="small" data-action="keep-rfq-values">Garder ces valeurs</button></p>`;
}

function seriesCard(c) {
  const s = q.serie;
  const prices = moqPrices(c);
  const compared = s ? demandeRows(c) : [];
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
    ${s ? `<p class="small">${[s.client, s.demande, s.offre && `offre ${s.offre}`, s.fonderie && `fonderie ${s.fonderie}`, s.usinage, s.tth && `TTH ${s.tth}`, s.references > 1 && `${s.references} références dans la demande`].filter(Boolean).map(esc).join(" — ")}</p>` : `<p class="small muted">Importez la demande client (onglet « 1- Données GO NO GO ») pour reprendre les volumes par année, les MOQ et le prix cible, ou saisissez-les ici ; son poids, sa mise au mille et son taux de rebut d'usinage sont comparés au chiffrage.</p>`}
    <div class="cfields">
      ${field("Quantités commandées (MOQ)", input("q.moqs", q.moqs ?? [], { kind: "list", placeholder: "1000 ; 500 ; 50" }), "séparées par « ; »")}
      ${field("Prix cible client (€/pièce)", input("q.prixCible", q.prixCible, { min: 0 }), q.prototype ? "non utilisé pour des prototypes" : "")}
      ${field("Taille de série (pièces)", input("q.tailleSerie", q.tailleSerie, { step: 1, min: 1 }), "répartit le changement de série")}
      ${s && (s.elec > 0 || s.gaz > 0) ? checkbox("q.serieEnergie", q.serieEnergie !== false, `Prix de l'énergie de la demande (élec ${nf(s.elec ?? 0, 0)} €/MWh, gaz ${nf(s.gaz ?? 0, 0)} €/MWh)`) : ""}
    </div>
    ${mismatch.length ? `<p class="cmsg warn">La demande indique la fonderie « ${esc(s.fonderie)} » : îlot retenu différent pour ${mismatch.map((r) => `${esc(r.piece.name)} (${esc(r.route.process)})`).join(", ")}.</p>` : ""}
    ${removedOrderNotice()}
    ${compared.length ? `<h4>Données de la demande comparées au chiffrage${c.selected === "ensemble" ? " (ensemble)" : ""}</h4>
      <div class="cscroll"><table class="ctable compact cdemande">
        <thead><tr><th>Donnée de la demande client</th><th class="num">Demande</th><th class="num">Chiffrage</th><th class="num">Écart</th></tr></thead>
        <tbody>${compared.map((d) => `<tr${d.alerte ? ' class="calert"' : ""}><td>${esc(d.label)}</td><td class="num">${demandeValue(d.valeur, d.unite)}</td><td class="num">${demandeValue(d.utilise, d.unite)}</td><td class="num${d.alerte ? " bad" : ""}">${Number.isFinite(d.ecart_rel) ? signedPct(d.ecart_rel) : "—"}${d.alerte ? ` (tolérance ${pct(d.tolerance, 0)})` : ""}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="small muted">Valeurs lues dans la demande client et comparées au chiffrage : elles ne sont pas appliquées automatiquement (les appliquer est une décision à prendre). Le chiffrage garde le poids saisi ou tiré du modèle 3D, la mise au mille saisie ou estimée et le taux de rebut du devis ; un écart au-delà de la tolérance est signalé dans la carte Traçabilité. Pour retenir une valeur de la demande, saisissez-la : poids de la pièce, mise au mille (îlot imposé), taux de rebut détecté à l'usinage.</p>` : ""}
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

// --------------------------------------------------------------------------- estimate of the cycle time by the AI

// Box "Envoyer les pièces similaires de l'historique" (their cycle times are
// confidential): for Ollama, on unless unticked, kept in this browser (nothing
// leaves the site); for the gateway, off unless ticked, for this browser tab
// only (sessionStorage), as the internal amounts of the IA page.
const SIMILAR_KEY = "reader3d.ai.cycleSimilar";
let cycleJob = null; // the estimate in progress: {key (of its piece), tab, file, controller, start}
let cycleError = null; // {key, text}: why the last estimate of the piece `key` failed

const localAI = () => savedAI().provider === "ollama";

function sendSimilar() {
  const local = localAI();
  try {
    return local ? localStorage.getItem(SIMILAR_KEY) !== "0" : sessionStorage.getItem(SIMILAR_KEY) === "1";
  } catch {
    return local; // storage blocked: the default
  }
}

function setSendSimilar(on) {
  try {
    if (localAI()) {
      if (on) localStorage.removeItem(SIMILAR_KEY);
      else localStorage.setItem(SIMILAR_KEY, "0");
    } else if (on) sessionStorage.setItem(SIMILAR_KEY, "1");
    else sessionStorage.removeItem(SIMILAR_KEY);
  } catch {
    // storage blocked: the box is back to its default at the next rendering
  }
}

/** The box "Envoyer les pièces similaires de l'historique", for the AI chosen on the IA page. */
function similarBox() {
  const title = localAI()
    ? "Les pièces les plus semblables de l'historique, avec leur temps de cycle, sont données au modèle local (Ollama) : rien ne quitte le site."
    : "Les pièces les plus semblables de l'historique partent à la passerelle en ligne avec leur temps de cycle, leur poids, leur module, leurs pièces par cycle et leur mise au mille (références anonymisées avec les noms). Décochée par défaut ; cochée, pour cet onglet du navigateur seulement.";
  return `<label class="check small" title="${esc(title)}"><input type="checkbox" data-pref="cycle-similar"${sendSimilar() ? " checked" : ""}> Envoyer les pièces similaires de l'historique${localAI() ? "" : " à la passerelle"}</label>`;
}

/** The AI the estimate is asked of: the one chosen on the IA page. */
function aiChoice() {
  const ai = savedAI();
  return ai.provider === "ollama"
    ? `Ollama local (${esc(ai.ollama.model)})`
    : `passerelle en ligne${ai.gateway.url ? "" : " (adresse à renseigner dans la page IA / analyse)"}${ai.anonymize ? ", noms anonymisés" : ""}`;
}

/** Under the casting parameters: "Estimer le temps de cycle avec l'IA", the box of the similar parts, the AI asked. */
function cycleButton(r) {
  const busy = cycleJob?.key === r.piece.key;
  const n = store.loadHistorique().length;
  const sent = Math.min(n, SIMILAR);
  return `<div class="crow ccycle-ask">
      <button type="button" class="small" data-action="estimate-cycle"${cycleJob || backtestJob ? " disabled" : ""}>Estimer le temps de cycle avec l'IA</button>
      ${busy ? `<span id="ccycle-status" class="small muted" role="status">Estimation en cours…</span> <button type="button" class="small" data-action="cancel-cycle">Annuler</button>` : ""}
      ${similarBox()}
    </div>
    <p class="small muted">IA de la page IA / analyse : ${aiChoice()}. Historique : ${n ? `${plural(n, "enregistrement")}, ${!sendSimilar() ? "non envoyé" : sent > 1 ? `les ${sent} plus semblables envoyés` : "envoyé"}` : "aucun enregistrement"}. Une proposition : rien n'est appliqué sans votre validation.</p>`;
}

/**
 * "Estimer le temps de cycle avec l'IA": the AI of the IA page (the gateway,
 * or Ollama) is given the data of the piece shown (ai-cycle.js cycleData),
 * anonymised for the gateway and within its budget. Its estimate, checked, is
 * kept with the piece (estimationCycleIA) and with the answers of the AI on
 * the quote (q.analysesIA): nothing of it is used before "Utiliser cette
 * valeur".
 */
async function estimateCycle() {
  if (cycleJob || backtestJob) return;
  const c = compute();
  const r = c?.results.find((x) => x.piece.key === c.selected);
  if (!r?.route) return;
  const data = cycleData(r, { settings, history: sendSimilar() ? store.loadHistorique() : [], trend: trendSettings(), serie: q.tailleSerie, volumeAnnuel: q.volumeAnnuel });
  const question = cycleQuestion(data);
  // For the gateway: the names of the quote, of the 3D file and of the body, and the references of the history replaced by labels.
  const names = namesOf(q);
  const file = c.p3d?.file ?? null;
  const label = Number.isInteger(r.piece.index) ? `Corps ${r.piece.index + 1}` : "Pièce";
  const job = { key: r.piece.key, tab: store.currentQuoteTab(), file, controller: new AbortController(), start: Date.now() };
  cycleJob = job;
  cycleError = null;
  const timer = setInterval(() => {
    const status = el?.chiffrage.querySelector("#ccycle-status");
    if (status) status.textContent = `Estimation en cours… ${Math.round((Date.now() - job.start) / 1000)} s`;
  }, 1000);
  render();
  let anonymous = null;
  try {
    const answer = await askJSON("cycle_time", ({ budget, local, anonymize, model }) => {
      anonymous = anonymize ? anonymiseCycleData(data, { file, label, names }) : null;
      return {
        context: fitCycleData(anonymous ? anonymous.data : data, budget),
        question: anonymous ? anonymous.text(question) : question,
        ...(local ? { system: localCycleRules(model) } : {}),
      };
    }, { signal: job.controller.signal });
    const sent = answer.sent.context;
    const estimate = readCycleAnswer(answer.output, sent);
    const unknown = cycleNumbers(estimate, sent, [answer.sent.question]);
    const legend = anonymous ? anonymous.legend(answer.output) : [];
    // The quote it is about: the tab and the 3D file of the question.
    if (store.currentQuoteTab() !== job.tab || (window.reader3d?.part?.()?.file ?? null) !== job.file) {
      message = { kind: "warn", text: "Estimation IA du temps de cycle abandonnée : l'onglet ou le modèle 3D a changé pendant la demande." };
      return;
    }
    const { avertissements, ...rest } = estimate;
    const record = {
      date: new Date().toISOString(),
      fournisseur: answer.provider ?? null,
      modele: answer.model ?? null,
      ilot: data.coulee.ilot,
      ...rest,
      pieces_similaires_utilisees: rest.pieces_similaires_utilisees.map((ref) => (anonymous ? anonymous.ref(ref) : ref)),
      avertissements,
      nombres_inconnus: unknown,
      noms: legend,
      ...(answer.notice ? { repli: answer.notice } : {}),
      // The data it was made with: told when they change, and compared in the card.
      donnees: {
        ilot: data.coulee.ilot, poids_kg: data.piece.poids_kg, module_mm: data.piece.module_mm ?? null, pieces_par_cycle: data.coulee.pieces_par_cycle, noyaux: data.piece.noyaux,
        formule_s: data.formule.valeur_s, tendance_s: data.tendance?.valeur_s ?? null, cycle_devis_s: data.cycle_devis.valeur_s, similaires: sent.pieces_similaires?.length ?? 0,
      },
    };
    pieceStore(job.key).estimationCycleIA = record;
    store.saveQuote(q);
    addAIAnalysis({
      date: record.date, provider: record.fournisseur, model: record.modele, question, tache: "cycle_time", verified: !unknown.length,
      answer: [cycleText(record), legend.length ? `Noms réels : ${legend.map(([l, n]) => `${l} = ${n}`).join(" ; ")}` : ""].filter(Boolean).join("\n\n"),
    });
  } catch (err) {
    cycleError = { key: job.key, text: err?.name === "AbortError" ? "Estimation annulée." : err?.message || String(err) };
  } finally {
    clearInterval(timer);
    cycleJob = null;
    render();
  }
}

/**
 * "Utiliser cette valeur": the estimate of the piece shown becomes its cycle
 * typed in, the input of the casting card (ai-cycle.js adoptEstimate), traced
 * "estimation IA validée" (provenance.js); its island imposed with it.
 */
function adoptCycle() {
  const c = compute();
  const r = c?.results.find((x) => x.piece.key === c.selected);
  const e = r?.inputs.estimationCycleIA;
  // Not for another island nor for data changed since (the button is disabled then).
  if (!e || r.route?.process !== e.ilot || changedSince(e, r).length) return;
  const imposed = r.inputs.procede === e.ilot;
  const valeur = adoptEstimate(pieceStore(r.piece.key), r.inputs, r.route);
  if (valeur === null) return;
  store.saveQuote(q);
  message = {
    kind: "ok",
    text: `Temps de cycle de ${valeur} s utilisé dans le devis : estimation IA validée (${[e.fournisseur, e.modele].filter(Boolean).join(" · ")}), îlot ${e.ilot}${imposed ? "" : " désormais imposé (un temps de cycle est propre à son îlot)"}. « Ne plus utiliser cette valeur », ou « Estimé » dans la liste du temps de cycle, revient à la formule.`,
  };
}

/** "Ne plus utiliser cette valeur": the cycle and the island of before the adoption, when the cycle is still the one adopted. */
function undoCycle() {
  const piece = pieceStore(currentKey);
  if (!undoAdoption(piece)) return;
  store.saveQuote(q);
  message = {
    kind: "ok",
    text: `Estimation IA retirée du devis : ${piece.cycle > 0 ? `temps de cycle saisi avant elle (${piece.cycle} s)` : "temps de cycle estimé par la formule"}${piece.procede === "auto" ? ", îlot choisi automatiquement" : ""}.`,
  };
}

/** The data of the estimate `e` that differ from those of the piece now (its island, weight, modulus, pieces per cycle, cores). */
function changedSince(e, r) {
  const now = cycleData(r, { settings });
  const d = e.donnees ?? {};
  return [["ilot", "îlot", now.coulee.ilot], ["poids_kg", "poids", now.piece.poids_kg], ["module_mm", "module", now.piece.module_mm], ["pieces_par_cycle", "pièces par cycle", now.coulee.pieces_par_cycle], ["noyaux", "noyaux", now.piece.noyaux]]
    .filter(([k, , v]) => (d[k] ?? null) !== (v ?? null))
    .map(([, name]) => name);
}

/**
 * Card "Estimation IA du temps de cycle" of the piece shown: the estimate, its
 * range and confidence, its breakdown, its comparison with the formula, the
 * trend and the similar parts, its hypotheses and points to verify, the
 * numbers it writes that come from none of the data sent; "Utiliser cette
 * valeur", or "Ne plus utiliser cette valeur" once used.
 */
function cycleCard(r) {
  const e = r?.inputs.estimationCycleIA;
  const error = cycleError?.key === r?.piece.key ? cycleError.text : "";
  if (!e && !error) return "";
  const head = `<h3>Estimation IA du temps de cycle — ${esc(r.piece.name)}</h3><p class="ai-label">Proposition IA — rien n'est appliqué sans votre validation</p>${error ? `<p class="cmsg error lines">${esc(error)}</p>` : ""}`;
  if (!e) return `<section class="ccard ccycle-ia" id="ccycle-ia">${head}</section>`;
  const code = r.route?.process;
  // The estimate used in the quote: this one, or an earlier one.
  const used = adoptedEstimate(r.inputs, code);
  const adopted = used?.estimation.date === e.date ? used : null;
  const changed = code === e.ilot ? changedSince(e, r) : [];
  const warnings = [
    ...(code && code !== e.ilot ? [`estimation faite pour l'îlot ${e.ilot}, îlot retenu ${code} : relancez l'estimation pour l'utiliser`] : []),
    ...(changed.length && !adopted ? [`données de la pièce changées depuis l'estimation (${changed.join(", ")}) : relancez l'estimation pour l'utiliser`] : []),
    ...(e.avertissements ?? []),
  ];
  const d = e.donnees ?? {};
  const total = e.decomposition.reduce((n, step) => n + step.secondes, 0);
  const steps = e.decomposition.map((step) => `<tr><td>${esc(step.etape)}</td><td class="num">${sec(step.secondes)}</td><td class="small">${esc(step.justification)}</td></tr>`).join("");
  const c = e.comparaison;
  const compared = [
    ["Formule", d.formule_s > 0 ? sec(d.formule_s) : "", c.formule_commentaire],
    ["Tendance", d.tendance_s > 0 ? sec(d.tendance_s) : "aucune", c.tendance_commentaire],
    ["Pièces semblables", plural(d.similaires ?? 0, "envoyée"), [c.pieces_similaires_commentaire, e.pieces_similaires_utilisees.length ? `utilisées : ${e.pieces_similaires_utilisees.join(", ")}` : ""].filter(Boolean).join(" — ")],
  ].map(([what, value, comment]) => `<li><strong>${what}</strong>${value ? ` (${esc(value)})` : ""} : ${esc(comment || "—")}</li>`).join("");
  const items = (title, list) => (list?.length ? `<h4>${title}</h4><ul class="small">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const unknown = e.nombres_inconnus ?? [];
  const value = Math.round(e.estimation_s);
  const usable = code === e.ilot && !changed.length;
  return `<section class="ccard ccycle-ia" id="ccycle-ia">
    ${head}
    <p class="ccycle-value"><strong>${sec(e.estimation_s)}</strong> par cycle — fourchette de ${sec(e.fourchette_s[0])} à ${sec(e.fourchette_s[1])}, confiance <span class="cconf ${esc(e.confiance)}">${esc(e.confiance)}</span> — îlot ${esc(e.ilot)}</p>
    <p class="small muted">${esc([e.fournisseur, e.modele].filter(Boolean).join(" · "))} · ${dateLabel(e.date)}${e.repli ? ` — ${esc(e.repli)}` : ""}</p>
    ${warnings.length ? `<p class="cmsg warn">${warnings.map(esc).join(" — ")}</p>` : ""}
    <div class="cscroll"><table class="ctable compact ccycle-steps">
      <thead><tr><th>Étape</th><th class="num">Durée</th><th>Justification</th></tr></thead>
      <tbody>${steps}</tbody>
      <tfoot><tr class="total"><td>Total de la décomposition</td><td class="num">${sec(total)}</td><td></td></tr></tfoot>
    </table></div>
    <h4>Comparaison</h4>
    <ul class="small ccycle-compare">${compared}</ul>
    ${items("Hypothèses", e.hypotheses)}
    ${items("À vérifier", e.a_verifier)}
    ${unknown.length ? `<p class="ai-numbers" title="${esc(unknown.join(" ; "))}">${esc(numbersLabel(unknown))} ni de l'estimation</p>` : ""}
    ${e.noms?.length ? `<p class="ai-names">Noms réels : ${esc(e.noms.map(([l, n]) => `${l} = ${n}`).join(" ; "))}</p>` : ""}
    <p class="cactions">${adopted
      ? `<span class="small"><strong>Utilisée dans le devis</strong> : ${sec(adopted.valeur)} depuis le ${dateLabel(adopted.date)}.</span> <button type="button" class="small" data-action="undo-cycle">Ne plus utiliser cette valeur</button>`
      : `<button type="button" class="small" data-action="adopt-cycle"${usable ? "" : " disabled"}>Utiliser cette valeur</button>${used
        ? ` <span class="small">Utilisée dans le devis : ${sec(used.valeur)}, estimation du ${dateLabel(used.estimation.date)} validée le ${dateLabel(used.date)}.</span> <button type="button" class="small" data-action="undo-cycle">Ne plus utiliser cette valeur</button>`
        : ""}`}</p>
    <p class="small muted">« Utiliser cette valeur » met ${value} s dans le temps de cycle de l'îlot ${esc(e.ilot)}${r.inputs.procede === e.ilot ? "" : ", qui devient l'îlot imposé (un temps de cycle est propre à son îlot)"} : une saisie du devis, tracée « estimation IA validée » (carte Traçabilité), qui passe avant la formule et la tendance. « Estimé » dans la liste du temps de cycle, ou « Ne plus utiliser cette valeur », revient à la formule. Non utilisée, l'estimation reste une autre source du temps de cycle dans la trace. Elle est gardée avec le devis et, avec le temps réel mesuré, dans le retour d'expérience.</p>
  </section>`;
}

// --------------------------------------------------------------------------- traceability

/** The traced values shown: those of the quote, and of the pieces shown (one, or every piece of the set). */
function traceSections(c) {
  const shown = c.selected === "ensemble" ? c.results : c.results.filter((r) => r.piece.key === c.selected);
  return [{ piece: null, trace: c.trace }, ...shown.map((r) => ({ piece: r.piece.name, trace: r.trace }))];
}

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const signedPct = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : ""}${pct(v)}` : "");

/** A traced value as text, by its unit ("%": a fraction). */
function traceText(v, unite) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number") return String(v);
  if (unite === "%") return pct(v);
  if (unite === "€") return eur(v, Math.abs(v) >= 1000 ? 0 : 3);
  if (unite === "kg") return `${nf(v, 3)} kg`;
  if (unite === "s") return `${nf(v, 0)} s`;
  if (unite === "pièces") return nf(v, 0);
  if (unite === "valeurs") return plural(v, "valeur");
  if (unite.startsWith("€/kg")) return `${nf(v, 4)} ${unite}`;
  if (!unite) return nf(v, Number.isInteger(v) ? 0 : 2);
  return `${nf(v, 2)} ${unite}`;
}
const traceValue = (v, unite) => esc(traceText(v, unite));

/** "N valeurs à valider / N alertes", at the top of the quote. */
function traceBanner(sum) {
  const alerts = sum.alertes.length;
  return `<p class="cmsg ctrace-banner ${sum.aValider || alerts ? "warn" : "clean"}">Traçabilité : <strong>${plural(sum.aValider, "valeur")} à valider / ${plural(alerts, "alerte")}</strong>
    <button type="button" class="small" data-action="show-trace">Voir le détail</button></p>`;
}

/** The name of another source: the field of the customer request or the estimate of the AI (its reference), else the type of source. */
const altName = (a) => ((a.source === "rfq" || a.source === "ia") && a.ref ? a.ref : TRACE_SOURCES[a.source]?.label ?? a.source);

function traceRow(cle, t) {
  const s = t.source;
  const name = TRACE_SOURCES[s.type]?.label ?? s.type;
  const details = [s.ref && `Référence : ${s.ref}`, s.entrees?.length && `Entrées : ${s.entrees.join(", ")}`].filter(Boolean).join("\n");
  const notes = [
    ...t.alternatives.map((a) => `autre source : ${esc(altName(a))} ${traceValue(a.valeur, t.unite)}${Number.isFinite(a.ecart_rel) ? ` (écart ${signedPct(a.ecart_rel)})` : ""}`),
    ...t.hypotheses.map(esc),
  ];
  const e = t.ecart_tendance;
  return `<tr${t.alertes.length ? ' class="calert"' : ""}>
    <td>${esc(traceLabel(cle))} <small class="muted">${esc(cle)}</small>${t.alertes.map((a) => `<small class="ctrend">${esc(ALERTES[a.type] ?? a.type)} : ${esc(a.message)}</small>`).join("")}</td>
    <td class="num">${traceValue(t.valeur, t.unite)}</td>
    <td title="${esc(details)}">${esc(name)}${s.fichier ? ` « ${esc(s.fichier)} »` : ""}${s.date ? `, ${dateLabel(s.date)}` : ""}${notes.map((n) => `<small class="muted cnote">${n}</small>`).join("")}</td>
    <td>${esc(t.autorite)}${t.niveau ? ` (N${t.niveau})` : ""}</td>
    <td><span class="cconf ${esc(t.confiance.niveau)}">${esc(t.confiance.niveau)}</span><small class="muted cnote">${esc(t.confiance.raison)}</small></td>
    <td class="num${e?.alerte ? " bad" : ""}">${e ? `${signedPct(e.ecart_rel)} <small class="muted">tendance ${traceValue(e.tendance, e.chemin ? "" : t.unite)}${e.chemin ? ` (${esc(e.chemin)})` : ""}</small>` : "—"}</td>
    <td>${t.validation_requise ? "<strong>oui</strong>" : "non"}</td>
  </tr>`;
}

/** Card "Traçabilité": the alerts, and every traced value (collapsible). */
function traceCard(sections, sum) {
  const rows = sections
    .map(({ piece, trace }) => {
      const entries = Object.entries(trace ?? {});
      return entries.length ? `<tr class="sub"><td colspan="7">${piece === null ? "Devis" : `Pièce : ${esc(piece)}`}</td></tr>${entries.map(([cle, t]) => traceRow(cle, t)).join("")}` : "";
    })
    .join("");
  const MAX = 20;
  const alerts = sum.alertes.slice(0, MAX).map((a) => `<li><strong>${esc(a.label)}</strong>${a.piece ? ` (${esc(a.piece)})` : ""} — ${esc(ALERTES[a.type] ?? a.type)} : ${esc(a.message)}</li>`).join("");
  return `<section class="ccard ctrace" id="ctrace">
    <h3>Traçabilité</h3>
    <p class="small">${plural(sum.valeurs, "valeur")} tracée${sum.valeurs > 1 ? "s" : ""} : <strong>${plural(sum.aValider, "valeur")} à valider</strong>${sum.aValiderCalcul ? ` (dont ${sum.aValiderCalcul} calculée${sum.aValiderCalcul > 1 ? "s" : ""} à partir de valeurs à valider)` : ""}, <strong>${plural(sum.alertes.length, "alerte")}</strong>.</p>
    ${alerts ? `<ul class="calerts small">${alerts}${sum.alertes.length > MAX ? `<li>… et ${plural(sum.alertes.length - MAX, "autre alerte")} : voir le détail.</li>` : ""}</ul>` : ""}
    <details${traceOpen ? " open" : ""}><summary data-action="toggle-trace">Détail des valeurs : valeur, source, autorité, confiance, écart à la tendance, validation requise</summary>
      <div class="cscroll"><table class="ctable compact">
        <thead><tr><th>Valeur tracée</th><th class="num">Valeur</th><th>Source</th><th>Autorité</th><th>Confiance</th><th class="num">Écart à la tendance</th><th>Validation requise</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </details>
    <p class="small muted">Ordre des sources : commande client et saisies du devis, puis Paramètres, classeur et indices (hard), puis géométrie 3D (evidence), puis tendances du fichier de paramètres calés (soft_prior), qui ne remplacent jamais une valeur actuelle. Défaut du code : valeur neutre, à remplacer par une valeur de l'entreprise. Une valeur calculée a la confiance de sa plus faible entrée et demande une validation si l'une d'elles en demande une. Écart à la tendance signalé au-delà de ${pct(settings.seuilTendance ?? SEUIL_TENDANCE, 0)} (Paramètres). Une valeur de l'IA n'entre dans le devis que validée par une personne : une saisie du devis, source « estimation IA validée » (temps de cycle) ; non validée, elle n'est qu'une autre source.</p>
  </section>`;
}

// --------------------------------------------------------------------------- history of cycle times

const sec = (v) => (Number.isFinite(v) ? `${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s` : "—");

/** The reference a real cycle time of piece `r` is kept under: the quote's, else the 3D file's; with the piece's name in a model of several. */
function feedbackRef(c, r) {
  const ref = q.reference?.trim() || (c.p3d?.file ?? "").replace(/\.[^.]+$/, "");
  if (!ref) return null;
  return c.allPieces.length > 1 ? `${ref} / ${r.piece.name}` : ref;
}

/** "Enregistrer dans le retour d'expérience": the real cycle time of the piece shown, a record "production" of the history. */
function saveFeedback() {
  const c = compute();
  const r = c?.results.find((x) => x.piece.key === c.selected);
  const ref = r?.route ? feedbackRef(c, r) : null;
  if (!ref || !(r.inputs.cycleReel > 0)) return;
  // The estimate of the AI used in the quote, else the last one for this island: compared with the time measured (Historique).
  const used = adoptedEstimate(r.inputs, r.route.process);
  const e = used ? used.estimation : r.inputs.estimationCycleIA?.ilot === r.route.process ? r.inputs.estimationCycleIA : null;
  const estimation = e?.estimation_s > 0 ? { temps_cycle_s: e.estimation_s, fournisseur: e.fournisseur, modele: e.modele, date: e.date, adoptee: !!used } : null;
  const record = productionRecord(r, { ref, tempsCycle: r.inputs.cycleReel, fichier: c.p3d?.file ?? null, serie: q.tailleSerie || null, estimation });
  const before = store.loadHistorique().find((x) => x.source === "production" && x.ref === ref);
  const saved = store.saveHistorique(mergeHistory(store.loadHistorique(), [record]).pieces);
  pieceStore(currentKey).cycleReel = null;
  store.saveQuote(q);
  message = {
    kind: saved ? "ok" : "warn",
    text: `Temps de cycle réel enregistré dans le retour d'expérience : « ${ref} », ${sec(record.temps_cycle_s)} sur ${record.ilot}${before ? ` (remplace ${sec(before.temps_cycle_s)} sur ${before.ilot}${before.date ? ` du ${dateLabel(before.date)}` : ""})` : ""}. Le chiffrage ne change pas.${saved ? "" : UNSAVED_HISTORY}`,
  };
}

/** Card "Retour d'expérience": the real cycle time of the piece shown, measured in production, kept in the history. */
function feedbackCard(c, r) {
  const route = r?.route;
  if (!route) return "";
  const casting = route.operations.find((o) => o.code === route.process);
  const ref = feedbackRef(c, r);
  const saved = ref ? store.loadHistorique().find((x) => x.source === "production" && x.ref === ref) : null;
  const value = r.inputs.cycleReel;
  const missing = !ref ? "saisissez la référence (carte Pièce)" : !(value > 0) ? "saisissez le temps mesuré" : "";
  return `<section class="ccard" id="cfeedback">
    <h3>Retour d'expérience — ${esc(r.piece.name)}</h3>
    <p class="small">Îlot retenu : <strong>${esc(route.process)}</strong> ${esc(route.famille)} — cycle du chiffrage ${nf(casting.cycle, 0)} s × ${casting.parCycle} (${!(r.chosen && r.inputs.cycle > 0) ? "estimé" : adoptedEstimate(r.inputs, route.process) ? "estimation IA validée" : "saisi"}).</p>
    <div class="cfields">
      ${field("Temps de cycle réel mesuré (s)", input("p.cycleReel", value, { min: 0, placeholder: "mesuré en production" }), `îlot ${esc(route.process)}, ${plural(casting.parCycle, "pièce")} par cycle`)}
    </div>
    <p><button type="button" class="small" data-action="save-feedback"${missing ? " disabled" : ""}>Enregistrer dans le retour d'expérience</button>${missing ? ` <small class="muted">${missing}</small>` : ""}</p>
    ${saved ? `<p class="small">Déjà enregistré pour « ${esc(ref)} » : ${sec(saved.temps_cycle_s)} sur ${esc(saved.ilot)}${saved.date ? ` le ${dateLabel(saved.date)}` : ""}. Un nouvel enregistrement le remplace.</p>` : ""}
    <p class="small muted">Gardé dans l'historique des temps de cycle de ce navigateur (source « production »)${ref ? ` sous la référence « ${esc(ref)} »` : ""}, avec la géométrie de la pièce (poids, module, épaisseurs, encombrement, volume, surface, noyaux) et l'îlot, les pièces par cycle, le TRS et la mise au mille du chiffrage. L'enregistrement n'envoie rien ; comme tout l'historique, il peut partir ensuite à l'IA parmi les pièces semblables (case « Envoyer les pièces similaires de l'historique »). Le temps mesuré ne change ni le chiffrage ni les paramètres.</p>
  </section>`;
}

/** The settings of the trends file over the code's, for the islands it gives cycle coefficients for; null without any. */
function trendSettings() {
  const t = layers.tendances?.values;
  const islands = Object.keys(t?.processes ?? {}).filter((code) => t.processes[code]?.cycle);
  if (!islands.length) return null;
  const s = store.resolveSettings({ tendances: t });
  return { ...s, processes: Object.fromEntries(islands.filter((code) => s.processes[code]).map((code) => [code, s.processes[code]])) };
}

/** The real cycle times measured in production against the estimates (history.js:compareCycles), and the mean errors per island. */
function comparisonHtml(pieces) {
  const trend = trendSettings();
  const cmp = compareCycles(pieces, settings, trend);
  if (!cmp.rows.length) return `<p class="small">Aucun temps mesuré en production : saisissez le temps de cycle réel d'une pièce chiffrée (carte « Retour d'expérience ») pour le comparer aux estimations.</p>`;
  const cols = [["formule", "Formule", "formule"], ...(trend ? [["tendance", "Tendance", "tendance"]] : []), ...(cmp.rows.some((x) => x.ia) ? [["ia", "Estimation IA", "estimation IA"]] : [])];
  const est = (e) => (e ? sec(e.valeur) : "—");
  const rows = cmp.rows
    .map((x) => `<tr><td>${esc(x.record.ref ?? "—")}${x.record.date ? ` <small class="muted">${esc(dateLabel(x.record.date))}</small>` : ""}</td><td>${esc(x.record.ilot)}</td><td class="num">${sec(x.record.temps_cycle_s)}</td>${cols.map(([k]) => `<td class="num">${est(x[k])}</td><td class="num">${x[k] ? signedPct(x[k].ecart) : "—"}</td>`).join("")}</tr>`)
    .join("");
  const summary = [...cmp.ilots, ...(cmp.ilots.length > 1 ? [cmp.total] : [])]
    .map((x) => `<tr${x.ilot === null ? ' class="total"' : ""}><td>${x.ilot === null ? "Tous les îlots" : `<strong>${esc(x.ilot)}</strong>`}</td><td class="num">${x.n}</td>${cols.map(([k]) => `<td class="num">${x[k] ? pct(x[k].emap) : "—"}</td>`).join("")}</tr>`)
    .join("");
  return `<h4>Retour d'expérience : temps mesurés et estimations</h4>
    <div class="cscroll"><table class="ctable compact chisto">
      <thead><tr><th>Référence</th><th>Îlot</th><th class="num">Réel</th>${cols.map(([, label]) => `<th class="num">${label}</th><th class="num">Écart</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="cscroll"><table class="ctable compact chisto-ilots">
      <thead><tr><th>Îlot</th><th class="num">Pièces mesurées</th>${cols.map(([, , label]) => `<th class="num">Écart moyen : ${label}</th>`).join("")}</tr></thead>
      <tbody>${summary}</tbody></table></div>
    <p class="small muted">Formule : temps de cycle de coulée = base + coef × (kg coulés par cycle)^exposant + s/mm² × module², recalculé avec les coefficients actuels de Paramètres, et pour chaque pièce son poids, son module, sa mise au mille et ses pièces par cycle enregistrés (ceux estimés pour l'îlot quand ils manquent ; module inconnu : 0).${trend ? " Tendance : la même formule avec les coefficients du fichier de tendances, pour les îlots qu'il donne." : ""} Écart = (estimation − réel) / réel ; écart moyen = moyenne des écarts en valeur absolue. Rien n'est appliqué au chiffrage ni aux paramètres.</p>`;
}

// --------------------------------------------------------------------------- backtest of the AI on the history

let backtestJob = null; // the run in progress: {controller, done, total, ref (of the record asked), waitUntil (ms) | null, start}

/** Seconds as a French wait: "12 s", "3 min", "2 h 5 min". */
function waitLabel(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Where the run is: the record asked, or the wait before the next request. */
function backtestStatus(job) {
  const at = `Pièce ${Math.min(job.done + 1, job.total)} sur ${job.total}${job.ref ? ` (${job.ref})` : ""}`;
  return job.waitUntil
    ? `${at} : prochaine demande dans ${waitLabel((job.waitUntil - Date.now()) / 1000)}, au rythme du quota en ligne…`
    : `${at} : estimation en cours… ${Math.round((Date.now() - job.start) / 1000)} s`;
}

function showBacktestStatus() {
  const status = el?.chiffrage.querySelector("#cbacktest-status");
  if (status && backtestJob) status.textContent = backtestStatus(backtestJob);
}

/** The card of the history drawn again alone (a result of the backtest): what is being typed in the other cards is kept. */
function refreshHistory() {
  const card = el?.chiffrage.querySelector("#chistorique");
  if (pointerDown) pending = true;
  else if (card && page === "chiffrage") card.outerHTML = historyCard();
}

/**
 * One record of the backtest asked of the AI of the IA page (ai-workspace.js
 * askJSON, never its local fallback: all the answers of a run from the same
 * AI): its data (ai-cycle.js recordCycleData) with the similar parts of the
 * history without it (backtest.js leaveOneOut), anonymised for the gateway as
 * the estimate of a piece. Resolves to {result (kept with the backtest:
 * estimate, range, confidence; or why the answer could not be used: a cut one
 * too, which would be cut again), quota, usage}.
 */
async function estimateRecord(item, signal) {
  const x = item.record;
  const data = recordCycleData(x, { settings, history: sendSimilar() ? leaveOneOut(store.loadHistorique(), x) : [], trend: trendSettings() });
  const question = cycleQuestion(data);
  let built = null;
  let answer;
  try {
    answer = await askJSON("cycle_time", ({ budget, local, anonymize, model }) => {
      const anonymous = anonymize ? anonymiseCycleData(data, { file: x.fichier_3d ?? null }) : null;
      built = {
        context: fitCycleData(anonymous ? anonymous.data : data, budget),
        question: anonymous ? anonymous.text(question) : question,
        ...(local ? { system: localCycleRules(model) } : {}),
      };
      return built;
    }, { signal, fallback: false });
  } catch (err) {
    if (!err?.truncated) throw err;
    const result = { empreinte: fingerprint(x), date: new Date().toISOString(), fournisseur: null, modele: null, similaires: built?.context.pieces_similaires?.length ?? 0, erreur: err.message };
    return { result, quota: null, usage: null };
  }
  const sent = answer.sent.context;
  const result = { empreinte: fingerprint(x), date: new Date().toISOString(), fournisseur: answer.provider ?? null, modele: answer.model ?? null, similaires: sent.pieces_similaires?.length ?? 0 };
  try {
    const e = readCycleAnswer(answer.output, sent);
    Object.assign(result, { estimation_s: e.estimation_s, fourchette_s: e.fourchette_s, confiance: e.confiance });
  } catch (err) {
    result.erreur = err.message;
  }
  return { result, quota: answer.quota, usage: answer.usage };
}

/**
 * "Banc d'essai IA": the records of the history with a weight and a modulus
 * not estimated yet, one after another (backtest.js runBacktest), each result
 * kept in this browser as it comes; stopped on a refusal for quota or an
 * error, resumed where it stopped.
 */
async function startBacktest() {
  if (backtestJob || cycleJob) return;
  const items = backtestItems(store.loadHistorique());
  if (!items.length) return;
  // The gateway: what leaves the browser, said before the run.
  if (!localAI()) {
    const results = store.loadBancEssai().resultats;
    const left = items.filter((item) => !resultOf(results, item)).length;
    const similar = sendSimilar();
    const names = savedAI().anonymize ? "références et noms anonymisés" : "références et noms en clair (case « Anonymiser les noms envoyés en ligne » décochée)";
    if (!confirm(`Banc d'essai avec la passerelle en ligne : ${left > 1 ? `pour chacune des ${left} pièces à estimer` : "pour la pièce à estimer"}, ses données (géométrie, îlot, pièces par cycle, mise au mille, formule, sans son temps de cycle)${similar ? ` et jusqu'à ${SIMILAR} pièces semblables de l'historique avec leur temps de cycle` : ""} partent au fournisseur de la passerelle, ${names}.${similar ? " Sur toute la série, presque tous les temps de cycle de l'historique sont envoyés." : ""} Continuer ?`)) return;
  }
  const banc = store.loadBancEssai();
  const job = { controller: new AbortController(), done: 0, total: items.length, ref: null, waitUntil: null, start: Date.now() };
  backtestJob = job;
  Object.assign(banc, { arret: null, enCours: true });
  store.saveBancEssai(banc);
  const timer = setInterval(showBacktestStatus, 1000);
  render();
  let outcome;
  try {
    outcome = await runBacktest(items, {
      results: banc.resultats,
      local: savedAI().provider === "ollama",
      notBefore: banc.prochaine,
      signal: job.controller.signal,
      estimate: estimateRecord,
      onResult: (item, result) => {
        banc.resultats[item.key] = result;
        store.saveBancEssai(banc);
        refreshHistory();
      },
      onProgress: ({ done, total, item, waitUntil }) => {
        Object.assign(job, { done, total, ref: item.record.ref ?? null, waitUntil, start: Date.now() });
        // The pace kept: a run resumed after a reload waits as this one would have.
        if (waitUntil) store.saveBancEssai(Object.assign(banc, { prochaine: waitUntil }));
        showBacktestStatus();
      },
    });
  } catch (err) {
    outcome = { status: "error", message: err?.message || String(err), retryAfter: null, next: banc.prochaine };
  } finally {
    clearInterval(timer);
    backtestJob = null;
  }
  banc.prochaine = outcome.next;
  banc.enCours = false;
  banc.arret = outcome.status === "done" ? null : { statut: outcome.status, message: outcome.message, date: new Date().toISOString(), reprise: outcome.retryAfter !== null ? outcome.next : null };
  store.saveBancEssai(banc);
  render();
}

/** Why the last run stopped (statut "interrompu": the page was closed during it), and what "Reprendre" does. */
function stopText(arret, left) {
  const resume = `« Reprendre » continue avec ${left > 1 ? `les ${left} pièces restantes` : "la pièce restante"}`;
  if (arret.statut === "cancelled") return `Banc d'essai annulé : les résultats obtenus sont gardés. ${resume}.`;
  if (arret.statut === "interrompu") return `Banc d'essai interrompu : la page a été fermée ou rechargée pendant la série ; les résultats obtenus sont gardés. ${resume}.`;
  const when = arret.reprise > Date.now() ? `, pas avant ${new Date(arret.reprise).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} (le délai du quota)` : "";
  if (arret.statut === "quota") return `Banc d'essai arrêté par le quota en ligne : ${arret.message} ${resume}${when}.`;
  return `Banc d'essai arrêté : ${arret.message} ${resume}, en commençant par la pièce de l'erreur.`;
}

/** Where the cycle coefficients of each island of `codes` in the settings come from (store.js layers): [{code, sources: ["tendance", "defaut"...]}]. */
function cycleSources(codes) {
  return [...new Set(codes)].filter((code) => settings.processes[code]?.cycle).map((code) => ({
    code,
    sources: [...new Set(Object.keys(settings.processes[code].cycle).map((k) => layers.provenance(`processes.${code}.cycle.${k}`).source))],
  }));
}

/**
 * The part "Banc d'essai IA" of the card of the history: the run (progress,
 * cancel, resume), the table of each record with its time, the formula and
 * the estimate of the AI, the mean errors by island and source, the result in
 * plain French, the CSV export.
 */
function backtestHtml(pieces) {
  const items = backtestItems(pieces);
  const banc = store.loadBancEssai();
  const rows = backtestRows(items, banc.resultats, settings);
  const s = summarizeBacktest(rows);
  const job = backtestJob;
  const left = rows.filter((x) => !x.resultat).length;
  const any = rows.some((x) => x.resultat);
  const local = savedAI().provider === "ollama";
  const arret = banc.arret ?? (banc.enCours ? { statut: "interrompu" } : null);
  const stop = job || !left || !arret ? "" : stopText(arret, left);
  const label = job ? "Banc d'essai IA en cours" : !any ? "Banc d'essai IA" : left ? `Reprendre le banc d'essai IA (${plural(left, "pièce")} à estimer)` : "Banc d'essai IA terminé";
  const ia = (x) => {
    if (x.ia) return `${sec(x.ia.valeur)} <small class="muted">(${nf(x.ia.min, 0)}–${nf(x.ia.max, 0)})</small>`;
    if (x.resultat?.erreur) return `<span class="cbacktest-error" title="${esc(x.resultat.erreur)}">réponse inutilisable</span>`;
    return `<span class="muted">${job ? "à estimer" : "—"}</span>`;
  };
  const table = any || job ? `<div class="cscroll"><table class="ctable compact cbacktest">
      <thead><tr><th>Pièce</th><th>Îlot</th><th>Source</th><th class="num">Temps de référence</th><th class="num">Formule</th><th class="num">Écart</th><th class="num">IA (fourchette)</th><th class="num">Écart</th><th>Dans la fourchette</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${esc(x.record.ref ?? "—")}</td><td>${esc(x.record.ilot)}</td><td>${esc(x.record.source)}</td><td class="num">${sec(x.reference)}</td><td class="num">${x.formule ? sec(x.formule.valeur) : "—"}</td><td class="num">${x.formule ? signedPct(x.formule.ecart) : "—"}</td><td class="num">${ia(x)}</td><td class="num">${x.ia ? signedPct(x.ia.ecart) : "—"}</td><td>${x.ia ? (x.ia.dedans ? "oui" : "non") : "—"}</td></tr>`).join("")}</tbody></table></div>` : "";
  const group = (name, x) => `<tr${name === "Toutes les pièces" ? ' class="total"' : ""}><td>${name}</td><td class="num">${x.n}</td><td class="num">${x.formule ? pct(x.formule.emap) : "—"}</td><td class="num">${pct(x.ia.emap)}</td><td class="num">${x.dedans} sur ${x.n}</td></tr>`;
  const summary = s.total.n ? `<div class="cscroll"><table class="ctable compact cbacktest-summary">
      <thead><tr><th>Pièces estimées</th><th class="num">Nombre</th><th class="num">Écart moyen : formule</th><th class="num">Écart moyen : IA</th><th class="num">Dans la fourchette IA</th></tr></thead>
      <tbody>${[
        ...s.ilots.map((x) => group(`Îlot <strong>${esc(x.ilot)}</strong>`, x)),
        ...s.sources.map((x) => group(x.source === "devis" ? "Temps de devis" : "Temps mesurés en production", x)),
        group("Toutes les pièces", s.total),
      ].join("")}</tbody></table></div>` : "";
  // The formula of the trends file was fitted on past quotes: perhaps on these records.
  const coefficients = cycleSources(items.map((x) => x.record.ilot));
  const reading = backtestReading(s, { tendance: coefficients.some((x) => x.sources.includes("tendance")) });
  // The AIs that gave the results (the AI of the IA page may have changed between two runs).
  const ais = new Map();
  for (const x of rows) {
    const name = x.resultat && [x.resultat.fournisseur, x.resultat.modele].filter(Boolean).join(" · ");
    if (name) ais.set(name, (ais.get(name) ?? 0) + 1);
  }
  return `<h4>Banc d'essai IA</h4>
    <div class="crow cbacktest-ask">
      <button type="button" class="small" data-action="backtest"${job || cycleJob || !left ? " disabled" : ""}>${label}</button>
      ${job ? `<span id="cbacktest-status" class="small muted" role="status">${esc(backtestStatus(job))}</span> <button type="button" class="small" data-action="cancel-backtest">Annuler</button>` : ""}
      <button type="button" class="small" data-action="export-backtest"${any ? "" : " disabled"}>Exporter les résultats (CSV)</button>
      <button type="button" class="small" data-action="clear-backtest"${any && !job ? "" : " disabled"}>Effacer les résultats…</button>
      ${similarBox()}
    </div>
    ${stop ? `<p class="cmsg warn lines">${esc(stop)}</p>` : ""}
    ${table}
    ${summary}
    ${reading && any ? `<p class="cbacktest-reading">${esc(reading)}</p>` : ""}
    ${ais.size ? `<p class="small">Réponses de : ${[...ais].map(([name, n]) => `${esc(name)} (${plural(n, "pièce")})`).join(", ")}.</p>` : ""}
    <p class="small muted">Pour chaque enregistrement qui a un poids et un module (${plural(items.length, "pièce")} sur ${pieces.length}) : la formule de l'îlot avec les coefficients actuels de Paramètres${coefficients.length ? ` (source des coefficients du cycle : ${coefficients.map((x) => `${esc(x.code)} ${x.sources.map((k) => SOURCES[k][0]).join(" et ")}`).join(", ")})` : ""}, et l'estimation de l'IA de la page IA / analyse (${aiChoice()}), demandée comme avec « Estimer le temps de cycle avec l'IA » mais sans l'enregistrement : ni son temps, ni lui ou un autre de même référence parmi les pièces semblables${sendSimilar() ? "" : " (case « Envoyer les pièces similaires de l'historique » décochée : aucune n'est envoyée)"}. Écart = (estimation − temps de référence) / temps de référence ; écart moyen = moyenne des écarts en valeur absolue, sur les pièces que l'IA a estimées. ${local
      ? "Ollama local : aucun quota, mais plus lent — de quelques secondes à quelques minutes par pièce selon le PC."
      : `Une demande à la fois, une toutes les ${DEFAULT_INTERVAL_S} s puis au rythme que permet le quota renvoyé par la passerelle (offre gratuite de Groq : 30 requêtes et 8 000 tokens par minute), sans repli sur le modèle local. Un refus pour quota arrête la série : « Reprendre » la continue où elle s'est arrêtée.`} Résultats gardés dans ce navigateur, même après un rechargement ; rien n'est appliqué au chiffrage ni aux paramètres.</p>`;
}

/**
 * Card "Historique des temps de cycle": the records kept in this browser by
 * source and island, their import, export and erasing, the real times
 * measured in production against the estimates, and the backtest of the AI.
 */
function historyCard() {
  const pieces = store.loadHistorique();
  const n = countHistory(pieces);
  return `<section class="ccard" id="chistorique">
    <h3>Historique des temps de cycle</h3>
    <div class="crow" data-drop="historique" title="Glissez un fichier d'historique (.json) ici pour l'importer"><span>Historique :</span> <strong>${n.total ? `${plural(n.total, "enregistrement")} : ${n.devis} temps de devis, ${n.production} temps mesuré${n.production > 1 ? "s" : ""} en production` : "aucun"}</strong>
      <button type="button" class="small" data-action="import-historique">Importer l'historique…</button>
      <input type="file" data-file="historique" accept=".json,application/json" hidden>
      <button type="button" class="small" data-action="export-historique"${n.total ? "" : " disabled"}>Exporter l'historique</button>
      <button type="button" class="small" data-action="clear-historique"${n.total ? "" : " disabled"}>Effacer l'historique…</button></div>
    ${n.ilots.length ? `<div class="cscroll"><table class="ctable compact chisto-count">
      <thead><tr><th>Îlot</th><th class="num">Devis</th><th class="num">Production</th></tr></thead>
      <tbody>${n.ilots.map((x) => `<tr><td><strong>${esc(x.ilot)}</strong>${settings.processes[x.ilot] ? ` ${esc(settings.processes[x.ilot].famille)}` : ""}</td><td class="num">${x.devis}</td><td class="num">${x.production}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${comparisonHtml(pieces)}
    ${backtestHtml(pieces)}
    <p class="small muted">Fichier JSON « reader3d-historique-cycles », version 1 : temps de cycle de devis passés (source « devis ») et temps mesurés en production (source « production »). Un enregistrement de même référence et même source remplace le précédent. L'historique est gardé dans ce navigateur. Il n'est envoyé à l'IA que si la case « Envoyer les pièces similaires de l'historique » est cochée : les ${SIMILAR} enregistrements les plus semblables à la pièce estimée, avec leur temps de cycle, leur poids, leur module, leurs pièces par cycle et leur mise au mille ; pour la passerelle en ligne, la case est décochée par défaut et les références sont anonymisées avec les noms. L'export reprend tout, temps mesurés compris. Données confidentielles : ne pas publier.</p>
  </section>`;
}

// Where each setting comes from (store.js layers): its label, and its letter in the tables.
const SOURCES = { saisie: ["saisie", "S"], classeur: ["classeur", "C"], tendance: ["tendance", "T"], defaut: ["défaut", "D"] };

/**
 * A number of the settings (input "s.<path>"), with where its value comes
 * from and, when a current value (typed, or of the workbook) differs from the
 * trend, the trend, the deviation and "Adopter la tendance".
 *   opts: those of input(), and compact (table cell: the letter of the source).
 */
function sinput(path, value, opts = {}) {
  const p = layers.provenance(path);
  const [label, letter] = SOURCES[p.source];
  const title = {
    saisie: `Saisie du ${dateLabel(p.date)}${p.migrated ? " (reprise des paramètres enregistrés par la version précédente)" : ""}`,
    classeur: `Valeur du classeur de chiffrage${p.fileName ? ` « ${p.fileName} »` : ""}`,
    tendance: `Tendance du fichier « ${p.fileName} », importé le ${dateLabel(p.date)}`,
    defaut: "Valeur par défaut du code (neutre, à ajuster)",
  }[p.source];
  let trend = "";
  if (p.source !== "tendance" && typeof p.trend === "number" && typeof p.value === "number" && p.trend !== p.value) {
    const shown = (v) => (opts.kind === "pct" ? `${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %` : v.toLocaleString("fr-FR", { maximumFractionDigits: 4 }));
    const sign = p.value > p.trend ? "+" : "";
    const gap = p.trend ? `${sign}${pct((p.value - p.trend) / Math.abs(p.trend))}` : `${sign}${shown(p.value - p.trend)}`;
    trend = `<small class="ctrend">tendance ${shown(p.trend)}, écart ${gap} <button type="button" class="small" data-action="adopt-trend" data-path="${esc(path)}">Adopter la tendance</button></small>`;
  }
  return `<span class="cval">${input(`s.${path}`, value, opts)}<span class="csrc ${p.source}" title="${esc(title)}">${opts.compact ? letter : label}</span></span>${trend}`;
}

/** Paramètres: the typed values, the trends file and the workbook, and how they take precedence. */
function settingsSourcesCard() {
  const n = Object.keys(layers.saisies.values).length;
  const t = layers.tendances;
  const plural = (k, word) => `${k} ${word}${k > 1 ? "s" : ""}`;
  const migrated = layers.saisies.migratedAt && n && !t
    ? `<p class="cmsg warn">Les paramètres enregistrés par la version précédente ont été repris comme saisies (${plural(n, "valeur")}) : celles égales aux valeurs par défaut ou du classeur ont été retirées, et les champs qui étaient vides reprennent la source suivante. Si un fichier de paramètres calés avait été importé, ses valeurs font partie de ces saisies : réimportez-le comme tendances, puis effacez les saisies que vous ne voulez pas garder.</p>`
    : "";
  return `<section class="ccard">
    <h3>Origine des paramètres</h3>
    <div class="crow"><span>Mes saisies :</span> <strong>${n ? `${plural(n, "valeur")} saisie${n > 1 ? "s" : ""} dans cette page` : "aucune"}</strong>
      <button type="button" class="small" data-action="export-saisies"${n ? "" : " disabled"}>Exporter mes saisies</button></div>
    <div class="crow" data-drop="tendances" title="Glissez un fichier de paramètres calés (.json) ici pour l'importer comme tendances"><span>Tendances :</span> <strong>${t ? `${esc(t.fileName)} — importé le ${dateLabel(t.importedAt)} — ${plural(store.countValues(t.values), "valeur")}` : "aucune"}</strong>
      <button type="button" class="small" data-action="import-tendances">Importer des tendances (fichier de paramètres calés)…</button>
      <input type="file" data-file="tendances" accept=".json,application/json" hidden>${t ? ` <button type="button" class="small" data-action="export-tendances">Exporter les tendances</button>` : ""}</div>
    ${base ? `<div class="crow"><span>Classeur de chiffrage :</span> <strong>${esc(base.source?.fileName)} — importé le ${dateLabel(base.source?.importedAt)}</strong></div>` : ""}
    ${migrated}
    <div class="cfields">${field("Seuil d'alerte : écart à la tendance", sinput("seuilTendance", settings.seuilTendance, { kind: "pct" }), "% — au-delà, le chiffrage signale l'écart (carte Traçabilité)")}</div>
    <p class="small muted">Chaque valeur vient de la première source qui en a une : <span class="csrc saisie">saisie</span> dans cette page (enregistrée dans ce navigateur dès qu'elle est saisie), puis <span class="csrc classeur">classeur</span> de chiffrage, puis <span class="csrc tendance">tendance</span> du fichier de paramètres calés (une indication tirée des devis passés : elle ne remplace jamais une saisie ni une valeur du classeur), puis <span class="csrc defaut">défaut</span> du code (valeur neutre, à ajuster). Dans les tableaux : S, C, T, D. Un champ vidé n'est plus une saisie : il reprend la valeur de la source suivante (0 ne s'obtient qu'en tapant 0). Quand une valeur s'écarte de la tendance, la tendance et l'écart s'affichent sous le champ, avec « Adopter la tendance ».</p>
    <div class="crow"><span class="small">Paramètres par défaut :</span>
      <button type="button" class="small" data-action="clear-saisies"${n ? "" : " disabled"}>Effacer mes saisies (les tendances restent)…</button>
      <button type="button" class="small" data-action="clear-tendances"${t ? "" : " disabled"}>Effacer les tendances (mes saisies restent)…</button></div>
  </section>`;
}

function renderSettings() {
  const centres = base?.centres ?? [];
  const processes = Object.entries(settings.processes);
  const pnum = (code, key, opts) => sinput(`processes.${code}.${key}`, settings.processes[code][key], { ...opts, compact: true });
  const trsRows = centres
    .filter((c) => c.uo === "pph")
    .map((c) => `<tr><td><strong>${esc(c.code)}</strong> ${esc(c.name)}</td>
      <td class="num">${sinput(`trs.${c.code}`, settings.trs[c.code], { kind: "pct", width: "80px", compact: true, placeholder: "85" })}</td>
      <td>${c.source === "modes" ? select(`s.modes.${c.code}`, settings.modes[c.code] ?? c.defaultMode, MODES) : `<span class="muted">${esc(c.source === "reel" ? "Réel" : "fixe")}</span>`}</td></tr>`)
    .join("");
  const processRows = processes
    .map(
      ([code, p]) => `<tr><td><strong>${esc(code)}</strong><br>${input(`s.processes.${code}.famille`, p.famille, { kind: "text" })}</td>
      <td>${pnum(code, "toileMin", { width: "60px" })}</td><td>${pnum(code, "toileMax", { width: "60px" })}</td>
      <td>${pnum(code, "poidsMax", { width: "60px" })}</td><td>${pnum(code, "dimMax", { width: "70px" })}</td>
      <td>${pnum(code, "volumeMin", { width: "80px" })}</td><td>${pnum(code, "empreintesMax", { width: "50px" })}</td>
      <td>${pnum(code, "grappeMax", { width: "60px" })}</td><td>${pnum(code, "miseAuMille", { width: "60px" })}</td>
      <td>${sinput(`processes.${code}.rendement.base`, p.rendement?.base, { kind: "pct", width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.rendement.parDoublement`, p.rendement?.parDoublement, { kind: "pct", width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.rendement.petitePiece`, p.rendement?.petitePiece, { kind: "pct", width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.cycle.base`, p.cycle.base, { width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.cycle.parKg`, p.cycle.parKg, { width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.cycle.exposant`, p.cycle.exposant ?? 1, { width: "60px", compact: true })}</td>
      <td>${sinput(`processes.${code}.cycle.parModule2`, p.cycle.parModule2, { width: "60px", compact: true })}</td>
      <td>${pnum(code, "qualite", { width: "50px" })}</td><td>${pnum(code, "outillage", { width: "80px" })}</td>
      <td>${checkbox(`s.processes.${code}.tth`, p.tth, "")}</td><td>${checkbox(`s.processes.${code}.noyaux`, p.noyaux, "")}</td></tr>`,
    )
    .join("");
  const opRows = Object.entries(settings.operations)
    .map(
      ([code, o]) => `<tr><td><strong>${esc(code)}</strong> ${esc(o.label)}</td>
      <td>${sinput(`operations.${code}.base`, o.base, { width: "70px", compact: true })}</td>
      <td>${sinput(`operations.${code}.parKg`, o.parKg, { width: "70px", compact: true })}</td>
      <td>${sinput(`operations.${code}.exposant`, o.exposant ?? 1, { width: "60px", compact: true })}</td>
      <td>${o.chargeKg !== undefined ? sinput(`operations.${code}.chargeKg`, o.chargeKg, { width: "70px", compact: true }) : sinput(`operations.${code}.parCycle`, o.parCycle, { width: "70px", compact: true })}</td></tr>`,
    )
    .join("");
  // Every alloy of the settings and of the workbook: one without density gets the generic one (alert in the trace).
  const densities = [...new Set([...Object.keys(settings.densities), ...(base?.lists.alliages ?? [])])]
    .map((a) => field(a, sinput(`densities.${a}`, settings.densities[a], { width: "80px", placeholder: nf(store.GENERIC_DENSITY, 2) }), settings.densities[a] === undefined ? `aucune densité : densité générique ${nf(store.GENERIC_DENSITY, 2)} utilisée` : ""))
    .join("");
  const energy = { ...base?.energy, ...settings.energy };
  const tthRows = Object.entries(settings.tth)
    .map(
      ([code, t]) => `<tr><td><strong>${esc(code)}</strong></td><td>${input(`s.tth.${code}.label`, t.label, { kind: "text", width: "320px" })}</td>
      <td>${sinput(`tth.${code}.coef`, t.coef, { width: "70px", compact: true })}</td><td>${input(`s.tth.${code}.cycle`, t.cycle, { kind: "text", width: "300px" })}</td></tr>`,
    )
    .join("");
  const tl = settings.tooling;
  const sc = settings.cores;
  const cf = (label, path, value, hint = "", opts = {}) => field(label, sinput(`cores.${path}`, value, opts), hint);
  const bandRows = tl.bandes
    .map((b, i) => `<tr><td class="num">≤ ${nf(b.max, 0)} kg</td>${["ax3", "ax3auto", "ax5", "ax5auto", "tiroir3", "tiroir5", "scan", "ajustage"].map((k) => `<td>${sinput(`tooling.bandes.${i}.${k}`, b[k], { width: "56px", compact: true })}</td>`).join("")}</tr>`)
    .join("");
  const tf = (label, path, value, hint = "", opts = {}) => field(label, sinput(`tooling.${path}`, value, opts), hint);
  return `<div class="cpage">${messageHtml()}
  ${base ? "" : sourcesCard()}
  ${settingsSourcesCard()}
  <div class="cgrid">
    <section class="ccard">
      <h3>TRS et fonctionnement par centre</h3>
      ${centres.length ? `<table class="ctable compact"><thead><tr><th>Centre</th><th class="num">TRS</th><th>Fonctionnement</th></tr></thead><tbody>${trsRows}</tbody></table>` : "<p>Importez le classeur de chiffrage pour voir les centres.</p>"}
      <p class="small muted">TRS : rendement des machines (pièces/h = 3600 / cycle × pièces par cycle × TRS). Fonctionnement : coûts et heures d'ouverture du centre (feuilles PRI 1x8, 2x8, 3x8, Réel).</p>
    </section>
    <section class="ccard">
      <h3>Marges, inflation, énergie</h3>
      <div class="cfields">
        ${field("Marge sur VA par défaut", sinput("marge", settings.marge, { kind: "pct" }), "%")}
        ${field("Taux de marge mini", sinput("tauxMini", settings.tauxMini, { kind: "pct" }), "%")}
        ${field("Coef de sécurité mise en route", sinput("coefSecurite", settings.coefSecurite, { kind: "pct" }), "%")}
        ${field("Changement de série : heures coulée", sinput("heuresChangementCoulee", settings.heuresChangementCoulee))}
        ${field("Changement de série : heures finition", sinput("heuresChangementFinition", settings.heuresChangementFinition))}
        ${field("Hausse annuelle masse salariale", sinput("inflation.salaires", settings.inflation.salaires, { kind: "pct" }), "%")}
        ${field("Hausse annuelle conso./entretien/prestations", sinput("inflation.conso", settings.inflation.conso, { kind: "pct" }), "%")}
        ${field("Hausse annuelle électricité", sinput("inflation.elec", settings.inflation.elec, { kind: "pct" }), "%")}
        ${field("Hausse annuelle gaz", sinput("inflation.gaz", settings.inflation.gaz, { kind: "pct" }), "%")}
        ${field("Hausse annuelle autres énergies", sinput("inflation.autresEnergies", settings.inflation.autresEnergies, { kind: "pct" }), "%")}
        ${field("Électricité : ancien indice (€/MWh)", sinput("energy.elecAncien", energy.elecAncien ?? null))}
        ${field("Électricité : nouvel indice (€/MWh)", sinput("energy.elecNouveau", energy.elecNouveau ?? null))}
        ${field("Gaz : ancien indice (€/MWh)", sinput("energy.gazAncien", energy.gazAncien ?? null))}
        ${field("Gaz : nouvel indice (€/MWh)", sinput("energy.gazNouveau", energy.gazNouveau ?? null))}
      </div>
    </section>
  </div>
  <section class="ccard">
    <h3>Îlots de coulée et méthodes</h3>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Îlot</th><th>Toile mini (mm)</th><th>Épaisseur maxi (mm)</th><th>Poids maxi (kg)</th><th>Dimension maxi (mm)</th><th>Volume mini /an</th><th>Empreintes maxi</th><th>Grappe maxi (kg)</th><th>Mise au mille par défaut</th><th>Rendement type (%)</th><th>− % par doublement épaisseur maxi / toile</th><th>− % × ln(2 kg / poids)</th><th>Cycle : base (s)</th><th>+ coef × (kg coulés)^exp.</th><th>exposant</th><th>+ s / mm² de module</th><th>Qualité /10</th><th>Outillage (€)</th><th>TTH</th><th>Noyaux</th></tr></thead>
      <tbody>${processRows}</tbody></table></div>
    <p class="small muted">Temps de cycle estimé = base + coef × (kg coulés par cycle)^exposant + (s/mm²) × module V/S² (exposant 1 : linéaire). Mise au mille estimée = 1 / rendement, rendement = rendement type − (% par doublement) × log₂(épaisseur maxi / toile mini) − (%) × ln(2 kg / poids) pour les pièces de moins de 2 kg, borné entre 30 et 95 % (valeur par défaut tant que les épaisseurs ne sont pas calculées). Un îlot est écarté si la toile mini, le poids, la dimension, le traitement thermique ou les noyaux sont hors de ses possibilités. Valeurs de départ à ajuster aux îlots réels.</p>
  </section>
  <section class="ccard">
    <h3>Autres opérations</h3>
    <table class="ctable compact"><thead><tr><th>Opération</th><th>Cycle : base (s)</th><th>+ coef × (kg pièce)^exp.</th><th>exposant</th><th>Pièces par cycle / charge (kg)</th></tr></thead><tbody>${opRows}</tbody></table>
    <p class="small muted">Cycle = base + coef × (poids de la pièce)^exposant ; noyautage : par noyau, base + coef × kg de sable.</p>
  </section>
  <section class="ccard">
    <h3>Traitements thermiques</h3>
    <table class="ctable compact"><thead><tr><th>Code</th><th>Désignation</th><th>Coût / T6</th><th>Cycle type</th></tr></thead><tbody>${tthRows}</tbody></table>
    <p class="small muted">Le centre TTH du classeur est chiffré au kg pour un T6 : le coût d'un autre traitement = coût T6 × coefficient (surtout le temps de four). Le type est choisi pièce par pièce (menu « Traitement thermique ») ou repris de la demande client.</p>
  </section>
  <section class="ccard">
    <h3>Outillage : coquilles, moules basse pression et boîtes à noyau réalisés sur place</h3>
    <div class="cfields">
      ${field("Estimer les moules", checkbox("s.tooling.actif", tl.actif, "îlots « Coquille gravité » et « Basse pression »"), "sinon : prix de l'îlot")}
      ${field("Type de moule", select("s.tooling.type", tl.type, tl.types.map((t, j) => [j, t.label]), { kind: "num" }))}
      ${tl.types.map((t, i) => tf(`${t.label} (€/kg)`, `types.${i}.prixKg`, t.prixKg)).join("")}
      ${tf("Densité de l'acier", "densite", tl.densite)}
      ${tf("Marge sur la longueur (mm, par côté)", "marges.longueur", tl.marges.longueur, "moule = pièce + 2 marges")}
      ${tf("Marge sur la largeur (mm, par côté)", "marges.largeur", tl.marges.largeur, "empreintes côte à côte")}
      ${tf("Marge sur la hauteur (mm, par côté)", "marges.hauteur", tl.marges.hauteur)}
      ${tf("Entre deux empreintes (mm)", "marges.entreEmpreintes", tl.marges.entreEmpreintes)}
      ${tf("Tiroirs par défaut", "tiroirs", tl.tiroirs, "chaque pièce peut avoir les siens")}
      ${field("Complexité par défaut", select("s.tooling.complexite", tl.complexite, Object.keys(tl.etude)))}
      ${Object.keys(tl.etude).map((k) => tf(`Coquille — heures d'étude : ${k}`, `etude.${k}`, tl.etude[k])).join("")}
      ${Object.keys(tl.fao).map((k) => tf(`Coquille — heures de FAO : ${k}`, `fao.${k}`, tl.fao[k])).join("")}
      ${tf("Étude (€/h)", "taux.etude", tl.taux.etude)}
      ${tf("FAO (€/h)", "taux.fao", tl.taux.fao)}
      ${tf("Usinage 3 axes présentiel (€/h)", "taux.ax3", tl.taux.ax3)}
      ${tf("Usinage 3 axes auto (€/h)", "taux.ax3auto", tl.taux.ax3auto)}
      ${tf("Usinage 5 axes présentiel (€/h)", "taux.ax5", tl.taux.ax5)}
      ${tf("Usinage 5 axes auto (€/h)", "taux.ax5auto", tl.taux.ax5auto)}
      ${tf("Scan 3D + rapport (€/h)", "taux.scan", tl.taux.scan)}
      ${tf("Ajustage / montage (€/h)", "taux.ajustage", tl.taux.ajustage)}
      ${tf("Sous-traitance (STT)", "sousTraitance", tl.sousTraitance, "%", { kind: "pct" })}
      ${tf("Marge sur les moules", "marge", tl.marge, "%", { kind: "pct" })}
    </div>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Poids de l'outillage</th><th>3 axes (h)</th><th>3 axes auto (h)</th><th>5 axes (h)</th><th>5 axes auto (h)</th><th>Tiroir 3 axes (h)</th><th>Tiroir 5 axes (h)</th><th>Scan (h)</th><th>Ajustage (h)</th></tr></thead>
      <tbody>${bandRows}</tbody></table></div>
    <div class="cscroll"><table class="ctable compact">
      <thead><tr><th>Poids du bloc nu jusqu'à (kg)</th><th>Coefficient de poids</th></tr></thead>
      <tbody>${tl.coefPoids.map((c, i) => `<tr><td>${sinput(`tooling.coefPoids.${i}.max`, c.max, { width: "90px", compact: true })}</td><td>${sinput(`tooling.coefPoids.${i}.coef`, c.coef, { width: "70px", compact: true })}</td></tr>`).join("")}</tbody></table></div>
    <p class="small muted">Méthode du classeur « Outillage fonderie » : poids = L × l × h × densité × coefficient (selon le poids du bloc nu), acier = poids × prix au kg du type, usinage 3 et 5 axes (+ tiroirs), scan et ajustage selon la tranche de poids, étude et FAO selon la complexité, puis sous-traitance et marge. L × l × h = encombrement de la pièce + marges. Les boîtes à noyau utilisent les mêmes taux, tranches et coefficients. Valeurs de départ : importez le fichier de paramètres calé sur vos outillages comme tendances (en haut de la page).</p>
  </section>
  <section class="ccard">
    <h3>Noyaux et boîtes à noyau</h3>
    <div class="cfields">
      ${cf("Densité du sable de noyau (kg/dm³)", "sableDensite", sc.sableDensite, "dimension estimée d'une boîte")}
      ${cf("Paroi autour du noyau (mm)", "paroi", sc.paroi)}
      ${sc.types.map((t, i) => cf(`Acier ${t.label} (€/kg)`, `types.${i}.prixKg`, t.prixKg)).join("")}
      ${Object.keys(sc.etude).map((k) => cf(`Boîte — heures d'étude : ${k}`, `etude.${k}`, sc.etude[k])).join("")}
      ${Object.keys(sc.fao).map((k) => cf(`Boîte — heures de FAO : ${k}`, `fao.${k}`, sc.fao[k])).join("")}
      ${cf("Sous-traitance (STT)", "sousTraitance", sc.sousTraitance, "%", { kind: "pct" })}
      ${cf("Marge sur les boîtes", "marge", sc.marge, "%", { kind: "pct" })}
    </div>
    <p class="small muted">Boîtes à noyau : même méthode que les moules (section BAN du classeur « Outillage fonderie »), taux horaires et heures par tranche de poids de la section Outillage. Sans dimensions saisies, une boîte = cube du volume de sable + 2 parois. Noyautage par pièce : centre ASN, cycle = base + s/kg × sable de chaque noyau (Autres opérations).</p>
  </section>
  <section class="ccard">
    <h3>Densités des alliages (g/cm³)</h3>
    <div class="cfields">${densities}</div>
  </section>
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
  const sections = traceSections(c);
  const traces = summarize(sections);
  const status = traces.aValider ? `non validé : ${plural(traces.aValider, "valeur")} à valider, ${plural(traces.alertes.length, "alerte")} (onglet Traçabilité)` : `${plural(traces.alertes.length, "alerte")}, aucune validation requise`;

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
    ["Traçabilité", status],
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
  const compared = q.serie ? demandeRows(c) : [];
  if (compared.length) {
    serie.push([], ["Donnée de la demande client (non appliquée)", "Demande", "Chiffrage", "Écart", "Au-delà de la tolérance"].map(H));
    for (const d of compared) {
      const v = (x) => (d.unite === "%" ? P(x) : x);
      serie.push([d.label, v(d.valeur), v(d.utilise), P(d.ecart_rel), d.alerte ? `oui (tolérance ${pct(d.tolerance, 0)})` : "non"]);
    }
  }

  // Traceability: one row per traced value; the data files and their dates in the header.
  const t = layers.tendances;
  const fileRow = (what, name, date) => [what, name ?? "aucun", date ? dateLabel(date) : null];
  const tracabilite = [
    [H("Traçabilité du chiffrage"), null, null],
    fileRow("Classeur de chiffrage", base.source?.fileName, base.source?.importedAt),
    fileRow("Indices matière", indices ? `${indices.fileName ?? ""} (${indices.source === "fichier" ? "fichier des cours" : "copie du classeur"})` : null, indices?.importedAt),
    fileRow("Tendances (paramètres calés)", t?.fileName, t?.importedAt),
    fileRow("Demande client (RFQ)", q.serie?.fileName, q.serie?.importedAt),
    ["Saisies de Paramètres", plural(Object.keys(layers.saisies.values).length, "valeur")],
    ["Modèle 3D", c.p3d?.file ?? "aucun"],
    ["Date de l'export", new Date().toLocaleString("fr-FR")],
    ["Statut", status],
    ["Seuil d'écart à la tendance", P(settings.seuilTendance ?? SEUIL_TENDANCE)],
    ["Ordre des sources", "commande client et saisies du devis, puis Paramètres, classeur et indices (hard) ; géométrie 3D (evidence) ; tendances (soft_prior), jamais au-dessus d'une valeur actuelle ; défaut du code : hypothèse à valider ; une valeur de l'IA seulement validée par une personne (source « estimation IA validée », une saisie du devis)"],
    ["Confidentialité", "document interne : taux, coûts et marges de l'entreprise"],
    [],
    ["Pièce", "Clé", "Valeur tracée", "Valeur", "Unité", "Source", "Référence", "Fichier", "Date", "Entrées", "Autorité", "Niveau", "Confiance", "Raison", "Tendance", "Écart à la tendance", "Autres sources", "Hypothèses", "Alertes", "Validation requise"].map(H),
  ];
  for (const { piece, trace } of sections) {
    for (const [cle, x] of Object.entries(trace ?? {})) {
      const percent = x.unite === "%";
      const e = x.ecart_tendance;
      tracabilite.push([
        piece ?? "Devis", cle, traceLabel(cle), typeof x.valeur === "number" && percent ? P(x.valeur) : x.valeur, x.unite,
        TRACE_SOURCES[x.source.type]?.label ?? x.source.type, x.source.ref, x.source.fichier ?? null, x.source.date ? dateLabel(x.source.date) : null, x.source.entrees?.join(", ") || null,
        x.autorite, x.niveau, x.confiance.niveau, x.confiance.raison, e ? (percent ? P(e.tendance) : e.tendance) : null, e ? P(e.ecart_rel) : null,
        x.alternatives.map((a) => `${altName(a)} : ${traceText(a.valeur, x.unite)}`).join(" ; ") || null,
        x.hypotheses.join(" ; ") || null, x.alertes.map((a) => `${ALERTES[a.type] ?? a.type} : ${a.message}`).join(" ; ") || null, x.validation_requise ? "oui" : "non",
      ]);
    }
  }

  // The answers of the AI page on this quote, kept for the record: none of their values was applied.
  const analyses = q.analysesIA ?? [];
  const analysesIA = [
    [H("Analyses IA"), null],
    ["Statut", "raisonnements et estimations de l'IA gardés pour mémoire : aucune valeur n'a été appliquée au devis ni aux paramètres sans validation ; une estimation du temps de cycle validée est une saisie du devis (onglet Traçabilité, source « estimation IA validée »)"],
    [],
    ["Date", "Fournisseur", "Modèle", "Question", "Réponse", "Nombres vérifiés"].map(H),
    ...analyses.map((a) => [dateLabel(a.date), a.provider, a.model, a.question, String(a.answer ?? "").slice(0, 32000), a.verified ? "oui" : a.tache === "cycle_time" ? "non : nombres absents des données envoyées" : "non : nombres absents de la trace"]),
  ];

  const bytes = buildXlsx([
    { name: "Synthèse", rows: synthese, widths: [32, 14, 14, 20, 16, 34, 22, 14, 10, 12, 8, 12, 22, 14, 16, 12, 14, 14, 14, 12] },
    { name: "Gammes", rows: gammes, header: true, widths: [28, 10, 34, 14, 12, 14, 10, 18, 14, 14] },
    { name: "Projection", rows: projection, header: true, widths: [10, 12, 14, 18, 16, 16, 22] },
    { name: "Outillage", rows: outillage, widths: [28, 42, 60, 14] },
    { name: "Commande série", rows: serie, widths: [26, 24, 22, 14, 22, 12, 12, 12, 12, 12, 12, 12] },
    { name: "Solutions", rows: solutions, header: true, widths: [28, 8, 40, 10, 12, 14, 12, 12, 18, 12, 14] },
    { name: "Traçabilité", rows: tracabilite, widths: [24, 26, 34, 14, 10, 18, 40, 22, 16, 40, 12, 8, 10, 40, 12, 12, 30, 50, 60, 10] },
    ...(analyses.length ? [{ name: "Analyses IA", rows: analysesIA, widths: [16, 12, 22, 50, 100, 20] }] : []),
  ]);
  const name = (q.reference || c.p3d?.file?.replace(/\.[^.]+$/, "") || "piece").replace(/[^\w.-]+/g, "_");
  download(`chiffrage_${name}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}
