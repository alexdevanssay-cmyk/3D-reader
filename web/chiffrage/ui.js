// Costing pages: "Chiffrage" (quote of the part shown in the 3D view) and
// "Paramètres" (TRS, islands, methods, rates of increase). French only: the
// costing follows the SAB costing workbook, in French.

import { MODES, readCostingWorkbook, readIndicesWorkbook } from "./workbook.js";
import { centreRates, indexAverage, minimumMargin, quote, saleMetalPrice } from "./model.js";
import { bestRoutes, buildRoute, rankRoutes } from "./routes.js";
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
const USER_FIELDS = ["client", "reference", "designation", "plan", "poids", "toileMini", "epaisseurMax", "moduleMm", "dimMax", "volumeAnnuel", "annees", "premiereAnnee", "volumes", "tth", "noyaux", "sableKg", "tribo", "redressage"];
const UO = { kgCast: "kg coulé", kgSold: "kg", pph: "h", hour: "h" };

// Form fields. data-bind: "q.<path>" (quote) or "s.<path>" (settings);
// data-kind: num (number, empty = null), pct (percent shown, ratio stored), text, bool, raw (select value).
function input(bind, value, { kind = "num", step = "any", min, placeholder = "", width } = {}) {
  const shown = value === null || value === undefined ? "" : kind === "pct" ? +(value * 100).toFixed(4) : value;
  const type = kind === "text" ? "text" : "number";
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
  if (scope === "q") {
    // Editing the volume of one year: the list of the per-year volumes starts from the annual volume.
    if (path.startsWith("volumes.") && (!Array.isArray(q.volumes) || q.volumes.length !== q.annees)) {
      q.volumes = Array.from({ length: q.annees }, () => q.volumeAnnuel || 0);
    }
    setPath(q, path, value);
    // A new annual volume or programme length resets the per-year volumes.
    if (path === "volumeAnnuel" || path === "annees") q.volumes = null;
    if (path === "procede") {
      q.finition = "auto";
      q.cycle = q.empreintes = q.miseAuMille = q.mode = null;
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
  if (action === "import-workbook" || action === "import-indices" || action === "import-settings") button.parentElement.querySelector("input[data-file]")?.click();
  else if (action === "thickness") {
    thicknessBusy = true;
    render();
    try {
      await window.reader3d?.computeThickness?.();
    } finally {
      thicknessBusy = false;
      render();
    }
  } else if (action === "retain") {
    q.procede = button.dataset.process;
    q.finition = button.dataset.finition;
    q.cycle = q.empreintes = q.miseAuMille = q.mode = null;
    store.saveQuote(q);
    render();
  } else if (action === "auto") {
    q.procede = q.finition = "auto";
    q.cycle = q.empreintes = q.miseAuMille = q.mode = null;
    store.saveQuote(q);
    render();
  } else if (action === "marge-mini") {
    const c = compute();
    if (!c?.final) return;
    const m = minimumMargin(c.finalRates, base.lists, c.finalInput, settings.tauxMini);
    if (m === null) message = { kind: "error", text: "Pas de marge qui donne ce taux mini." };
    else {
      q.marge = m;
      store.saveQuote(q);
      message = { kind: "ok", text: `Marge sur VA fixée à ${pct(m, 2)} : marge sur VA de la première année = ${pct(settings.tauxMini)}.` };
    }
    render();
  } else if (action === "add-component") {
    q.composants = [...(q.composants ?? []), { designation: "", qte: 1, prix: 0, marge: 0.1 }];
    store.saveQuote(q);
    render();
  } else if (action === "remove-component") {
    q.composants = q.composants.filter((_, i) => i !== Number(button.dataset.index));
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

/** Everything the page shows, from the data, the settings and the inputs. */
function compute() {
  if (!base) return null;
  const p3d = window.reader3d?.part?.() ?? null;
  const density = settings.densities[q.alliage] ?? 2.7;
  const auto = {
    poids: p3d?.volume ? (p3d.volume / 1e6) * density : null,
    toileMini: p3d?.thickness?.min ?? null,
    epaisseurMax: p3d?.thickness?.max ?? null,
    moduleMm: p3d?.volume && p3d?.area ? p3d.volume / p3d.area : null,
    dimMax: p3d ? Math.max(...p3d.bboxSize) : null,
  };
  const value = (k) => q[k] ?? auto[k];
  const years = Array.from({ length: Math.max(1, q.annees || 1) }, (_, i) => (q.premiereAnnee || new Date().getFullYear()) + i);
  const volumes = Array.isArray(q.volumes) && q.volumes.length === years.length ? q.volumes : years.map(() => q.volumeAnnuel || 0);
  const volumeTotal = volumes.reduce((a, b) => a + (b || 0), 0);
  const part = {
    poids: value("poids"),
    toileMini: value("toileMini") ?? 0,
    epaisseurMax: value("epaisseurMax") ?? 0,
    moduleMm: value("moduleMm") ?? 0,
    dimMax: value("dimMax") ?? 0,
    volumeAnnuel: q.volumeAnnuel || 0,
    volumeTotal,
    tth: q.tth !== "none",
    noyaux: !!q.noyaux,
    sableKg: q.sableKg || 0,
    tribo: !!q.tribo,
    redressage: !!q.redressage,
  };
  const sale = indices ? saleMetalPrice(indices, base.lists, { month: q.month, typology: q.typologie, index: q.cours }) : { cours: null, p1020: null };
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
  const quoteBase = {
    metal,
    coefDifficulte: q.coefDifficulte,
    vaUsinage: q.vaUsinage,
    rebutUsinage: q.rebutUsinage,
    changeover: [],
    coefSecurite: settings.coefSecurite,
    tailleSerie: q.tailleSerie,
    nombrePieces: volumeTotal,
    composants: q.composants,
    marge: q.marge ?? settings.marge,
    evolution: settings.inflation,
    years,
    volumes,
    tth: q.tth,
  };
  const out = { p3d, auto, part, sale, metal, years, volumes, volumeTotal, density };
  if (!(part.poids > 0)) return out;

  const energy = Object.fromEntries(Object.entries(settings.energy ?? {}).filter(([, v]) => Number.isFinite(v)));
  const rates = centreRates(base, { modes: settings.modes, energy });
  const ranked = rankRoutes(rates, base.lists, part, settings, quoteBase);
  const best = bestRoutes(ranked, 3);
  out.rates = rates;
  out.ranked = ranked;
  out.best = best;

  // The route retained: the best one, or the island chosen in the page.
  let code = q.procede !== "auto" && settings.processes[q.procede] && rates.has(q.procede) ? q.procede : best[0]?.process;
  if (!code) return out;
  const process = settings.processes[code];
  const finition =
    q.finition !== "auto" && process.finitions.includes(q.finition)
      ? q.finition
      : ranked.find((r) => r.process === code && r.feasible)?.finition ?? ranked.find((r) => r.process === code)?.finition ?? process.finitions[0];
  const finalRates = q.procede !== "auto" && q.mode ? centreRates(base, { modes: { ...settings.modes, [code]: q.mode }, energy }) : rates;
  const route = buildRoute(code, finition, part, settings, finalRates);
  const estimated = { cycle: route.cycle, parCycle: route.parCycle, miseAuMille: route.miseAuMille };
  if (q.procede !== "auto") {
    const casting = route.operations.find((o) => o.code === code);
    if (q.cycle > 0) casting.cycle = q.cycle;
    if (q.empreintes > 0) casting.parCycle = q.empreintes;
    if (q.miseAuMille > 0) route.miseAuMille = q.miseAuMille;
  }
  const finalInput = {
    ...quoteBase,
    poids: part.poids,
    miseAuMille: route.miseAuMille,
    sableKg: route.sableKg,
    tth: part.tth ? (q.tth === "masselotte" ? "masselotte" : "scie") : "none",
    operations: route.operations,
    changeover: [
      { code, heures: settings.heuresChangementCoulee },
      { code: finition, heures: settings.heuresChangementFinition },
    ],
    outillages: [{ designation: `Outillage ${process.famille}`, qte: 1, prix: process.outillage }],
    margeOutillages: 0,
  };
  out.route = route;
  out.estimated = estimated;
  out.finalRates = finalRates;
  out.finalInput = finalInput;
  out.final = quote(finalRates, base.lists, finalInput);
  return out;
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
  const thicknessText = c.p3d?.thickness
    ? `${nf(c.p3d.thickness.min, 2)} mm`
    : c.p3d
      ? `<button type="button" class="small" data-action="thickness"${thicknessBusy ? " disabled" : ""}>${thicknessBusy ? "Calcul…" : "Calculer les épaisseurs"}</button>`
      : "—";
  const casting = Object.keys(settings.processes).filter((code) => c.rates?.has(code) ?? base.centres.some((x) => x.code === code));
  const routeCode = c.route?.process;
  const cycleOptions = [[" ", `Estimé${c.estimated ? ` (${nf(c.estimated.cycle, 0)} s)` : ""}`], ...[20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 420, 480, 600, 900].map((s) => [s, `${s} s`])];
  if (q.cycle > 0 && !cycleOptions.some(([v]) => Number(v) === q.cycle)) cycleOptions.push([q.cycle, `${q.cycle} s`]);
  const empreintesOptions = [[" ", `Estimé${c.estimated ? ` (${c.estimated.parCycle})` : ""}`], ...[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)])];
  const mamOptions = [[" ", `Estimée${c.estimated ? ` (${nf(c.estimated.miseAuMille, 2)})` : ""}`], ...[1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.2, 2.5].map((n) => [n, nf(n, 2)])];
  const locked = q.procede === "auto";

  return `<div class="cpage">${messageHtml()}
  <div class="cgrid">
    ${sourcesCard()}
    <section class="ccard">
      <h3>Pièce</h3>
      <div class="cfields">
        ${field("Client", input("q.client", q.client, { kind: "text" }))}
        ${field("Référence", input("q.reference", q.reference, { kind: "text" }))}
        ${field("Désignation", input("q.designation", q.designation, { kind: "text" }))}
        ${field("N° de plan", input("q.plan", q.plan, { kind: "text" }))}
      </div>
      <p class="small muted">Modèle 3D : ${c.p3d ? `<strong>${esc(c.p3d.file)}</strong> — volume ${nf(c.p3d.volume / 1000, 2)} cm³, toile mini ${thicknessText}` : "aucun (ouvrez un fichier dans l'onglet Analyse 3D, ou saisissez les valeurs)"}</p>
      <div class="cfields">
        ${field("Alliage", select("q.alliage", q.alliage, lists.alliages), `densité ${nf(c.density, 2)}`)}
        ${field("Poids pièce (kg)", input("q.poids", q.poids, { placeholder: c.auto.poids ? nf(c.auto.poids, 3) : "à saisir" }), "vide = volume × densité")}
        ${field("Toile mini (mm)", input("q.toileMini", q.toileMini, { placeholder: c.auto.toileMini ? nf(c.auto.toileMini, 2) : "" }))}
        ${field("Épaisseur maxi / point chaud (mm)", input("q.epaisseurMax", q.epaisseurMax, { placeholder: c.auto.epaisseurMax ? nf(c.auto.epaisseurMax, 2) : "" }))}
        ${field("Module V/S (mm)", input("q.moduleMm", q.moduleMm, { placeholder: c.auto.moduleMm ? nf(c.auto.moduleMm, 2) : "" }), "fixe le temps de solidification")}
        ${field("Plus grande dimension (mm)", input("q.dimMax", q.dimMax, { placeholder: c.auto.dimMax ? nf(c.auto.dimMax, 0) : "" }))}
        ${field("Volume annuel (pièces)", input("q.volumeAnnuel", q.volumeAnnuel, { step: 1, min: 0 }))}
        ${field("Durée du programme", select("q.annees", q.annees, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((n) => [n, `${n} an${n > 1 ? "s" : ""}`]), { kind: "num" }))}
        ${field("Première année", select("q.premiereAnnee", q.premiereAnnee, Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 1 + i), { kind: "num" }))}
        ${field("Traitement thermique", select("q.tth", q.tth, [["none", "Aucun"], ["scie", "Oui, pièce sciée"], ["masselotte", "Oui, avec masselotte"]]))}
        ${field("Noyaux sable", checkbox("q.noyaux", q.noyaux, "oui"))}
        ${q.noyaux ? field("Sable par pièce (kg)", input("q.sableKg", q.sableKg, { min: 0 })) : ""}
        ${field("Tribofinition", checkbox("q.tribo", q.tribo, "oui"))}
        ${field("Redressage", checkbox("q.redressage", q.redressage, "oui"))}
      </div>
    </section>

    <section class="ccard">
      <h3>Matière</h3>
      <div class="cfields">
        ${field("Date d'application", months.length ? select("q.month", q.month, [...months].reverse().map((m) => [m, monthLabel(m)])) : "<em>importez les indices</em>")}
        ${field("Typologie de la moyenne", select("q.typologie", q.typologie, typologies))}
        ${field("Cours utilisé", select("q.cours", q.cours, lists.cours))}
        ${field("Cours vente (€/t)", `<output>${c.sale.cours === null ? "indisponible" : nf(c.sale.cours, 2)}</output>`, c.sale.cours === null ? "mois absent du fichier des indices" : "moyenne des indices")}
        ${field("Prime P1020 vente (€/t)", `<output>${nf(c.sale.p1020 ?? 0, 2)}</output>`)}
        ${field("Premium vente (€/t)", input("q.premiumVente", q.premiumVente))}
        ${field("PAF vendue", input("q.pafVente", q.pafVente, { kind: "pct" }), "%")}
        ${field("Cours achat (€/t)", input("q.coursAchat", q.coursAchat))}
        ${field("P1020 achat (€/t)", input("q.p1020Achat", q.p1020Achat))}
        ${field("Premium achat (€/t)", input("q.premiumAchat", q.premiumAchat))}
        ${field("Perte au feu achat", input("q.pafAchat", q.pafAchat, { kind: "pct" }), "%")}
      </div>
    </section>

    <section class="ccard">
      <h3>Paramètres de coulée</h3>
      <div class="cfields">
        ${field("Procédé / îlot", select("q.procede", q.procede, [["auto", "Automatique (meilleure solution)"], ...casting.map((code) => [code, `${code} — ${settings.processes[code].famille}`])]))}
        ${field("Finition", select("q.finition", q.finition, [["auto", "Automatique"], ...(routeCode ? settings.processes[routeCode].finitions.map((f) => [f, `${f} — ${settings.operations[f]?.label ?? f}`]) : [])]))}
        ${field("Fonctionnement", locked ? `<output>${esc(c.finalRates?.get(routeCode)?.mode ?? "—")}</output>` : select("q.mode", q.mode ?? "", [["", `Paramètre (${esc(settings.modes[routeCode] ?? base.centres.find((x) => x.code === routeCode)?.defaultMode ?? "")})`], ...MODES.map((m) => [m, m])], { kind: "nullraw" }), locked ? "choisissez un îlot pour le modifier" : "")}
        ${field("Temps de cycle", locked ? `<output>${c.estimated ? `${nf(c.estimated.cycle, 0)} s (estimé)` : "—"}</output>` : select("q.cycle", q.cycle ?? " ", cycleOptions, { kind: "num" }))}
        ${field("Empreintes / pièces par cycle", locked ? `<output>${c.estimated?.parCycle ?? "—"}</output>` : select("q.empreintes", q.empreintes ?? " ", empreintesOptions, { kind: "num" }))}
        ${field("Mise au mille (kg coulé / kg pièce)", locked ? `<output>${c.estimated ? nf(c.estimated.miseAuMille, 2) : "—"}</output>` : select("q.miseAuMille", q.miseAuMille ?? " ", mamOptions, { kind: "num" }))}
        ${field("Coef de difficulté", select("q.coefDifficulte", q.coefDifficulte, lists.coefs.map((x) => [x.coef, String(x.coef)]), { kind: "num" }))}
        ${field("TRS de l'îlot", `<output>${routeCode ? pct(settings.trs[routeCode] ?? 0, 0) : "—"}</output>`, "modifiable dans Paramètres")}
      </div>
    </section>
  </div>

  ${solutionsCard(c)}
  ${detailCard(c)}
  ${projectionCard(c)}
  <p class="cactions">
    <button type="button" data-action="export-xlsx"${c.final ? "" : " disabled"}>Exporter le chiffrage (Excel)</button>
    <button type="button" data-action="reset-quote">Nouveau chiffrage</button>
  </p>
  </div>`;
}

function solutionsCard(c) {
  if (!(c.part.poids > 0)) {
    return `<section class="ccard"><h3>Solutions de fabrication</h3><p>Ouvrez un modèle 3D dans l'onglet Analyse 3D, ou saisissez le poids de la pièce.</p></section>`;
  }
  const missingThickness = !c.part.toileMini;
  const rows = c.best
    .map((r, i) => {
      const retained = c.route && r.process === c.route.process && r.finition === c.route.finition;
      return `<tr class="${retained ? "retained" : ""}">
        <td>${i + 1}</td>
        <td><strong>${esc(r.process)}</strong> ${esc(r.famille)}</td>
        <td>${esc(settings.operations[r.finition]?.label ?? r.finition)}</td>
        <td class="num">${nf(r.cycle, 0)} s × ${r.parCycle}</td>
        <td class="num">${eur(r.result.pri)}</td>
        <td class="num">${eur(r.outillagePiece)}</td>
        <td class="num">${eur(r.result.years[0]?.prixVente)}</td>
        <td class="num">${nf(r.qualite, 1)} / 10</td>
        <td class="num"><strong>${nf(r.ratio * 100, 1)}</strong></td>
        <td class="small">${r.warnings.map(esc).join("<br>")}</td>
        <td>${retained ? "✓ retenue" : `<button type="button" class="small" data-action="retain" data-process="${esc(r.process)}" data-finition="${esc(r.finition)}">Retenir</button>`}</td>
      </tr>`;
    })
    .join("");
  const rejected = c.ranked.filter((r) => !r.feasible);
  const rejectedByProcess = new Map();
  for (const r of rejected) if (!rejectedByProcess.has(r.process)) rejectedByProcess.set(r.process, r);
  return `<section class="ccard">
    <h3>Les 3 meilleures solutions (rapport qualité / prix)</h3>
    ${missingThickness ? `<p class="cmsg warn">Toile mini inconnue : calculez les épaisseurs (onglet Analyse 3D) ou saisissez-la, sinon la faisabilité des procédés n'est pas vérifiée.</p>` : ""}
    ${c.best.length ? `<div class="cscroll"><table class="ctable">
      <thead><tr><th>#</th><th>Îlot</th><th>Finition</th><th class="num">Cycle</th><th class="num">PRI / pièce</th><th class="num">Outillage / pièce</th><th class="num">Prix de vente</th><th class="num">Qualité</th><th class="num">Qualité / prix</th><th>Alertes</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : "<p>Aucun îlot ne convient à cette pièce (voir ci-dessous).</p>"}
    ${q.procede !== "auto" ? `<p><button type="button" class="small" data-action="auto">Revenir au choix automatique</button></p>` : ""}
    ${rejectedByProcess.size ? `<details><summary>Îlots écartés (${rejectedByProcess.size})</summary><ul>${[...rejectedByProcess.values()].map((r) => `<li><strong>${esc(r.process)}</strong> ${esc(r.famille)} : ${r.reasons.map(esc).join(", ")}</li>`).join("")}</ul></details>` : ""}
    <p class="small muted">Qualité /10 : note de l'îlot (Paramètres) moins des pénalités : point chaud au-delà de l'épaisseur maxi de l'îlot, toile proche du minimum, volume faible. Prix = PRI complet + outillage amorti sur le programme. Temps de cycle estimés à partir du poids coulé et du module V/S : à confirmer par les méthodes.</p>
  </section>`;
}

function detailCard(c) {
  const f = c.final;
  if (!f) return "";
  const lines = f.lines
    .map((l) => {
      const op = c.route.operations.find((o) => o.code === l.code) ?? {};
      const rate = c.finalRates.get(l.code);
      const quantity = l.uo === "kgCast" || l.uo === "kgSold" ? `${nf(l.units, 3)} kg` : l.uo === "hour" ? `${nf(l.units * 3600, 1)} s` : `${nf(l.piecesPerHour, 1)} p/h`;
      const detail = op.cycle ? `${nf(op.cycle, 0)} s × ${op.parCycle}${op.trs && l.uo === "pph" ? ` — TRS ${pct(op.trs, 0)}` : ""}` : "";
      return `<tr><td><strong>${esc(l.code)}</strong> ${esc(l.name)}</td><td>${esc(rate?.mode ?? "")}</td><td class="small">${detail}</td><td class="num">${quantity}</td><td class="num">${nf(l.rate, l.uo.startsWith("kg") ? 4 : 2)} €/${UO[l.uo]}</td><td class="num">${eur(l.cost)}</td></tr>`;
    })
    .join("");
  const y = f.years[0];
  const marge = q.marge ?? settings.marge;
  return `<section class="ccard">
    <h3>Détail du chiffrage — ${esc(c.route.process)} ${esc(c.route.famille)}, ${esc(settings.operations[c.route.finition]?.label ?? c.route.finition)}</h3>
    ${c.route.warnings.length || c.route.reasons.length ? `<p class="cmsg warn">${[...c.route.reasons, ...c.route.warnings].map(esc).join(" — ")}</p>` : ""}
    <div class="cscroll"><table class="ctable">
      <thead><tr><th>Centre de profit</th><th>Fonct.</th><th>Cycle</th><th class="num">Quantité</th><th class="num">Taux</th><th class="num">€ / pièce</th></tr></thead>
      <tbody>${lines}
        <tr class="sub"><td colspan="5">VA PRI totale (dont part fixe ${eur(f.fixed)}, corporate ${eur(f.corporate)})</td><td class="num">${eur(f.va)}</td></tr>
        <tr><td colspan="5">Matière (${nf(f.metalAchat, 2)} €/t × ${nf(c.part.poids, 3)} kg)</td><td class="num">${eur(f.matiere)}</td></tr>
        <tr><td colspan="5">Perte au feu (${pct(q.pafAchat)} de ${nf(f.kgCast, 3)} kg coulés)</td><td class="num">${eur(f.perteAuFeu)}</td></tr>
        <tr><td colspan="5">Sable</td><td class="num">${eur(f.sable)}</td></tr>
        <tr><td colspan="5">Coef de difficulté (${esc(q.coefDifficulte)})</td><td class="num">${eur(f.difficulte)}</td></tr>
        <tr><td colspan="5">Rebuts détectés à l'usinage (${eur(q.vaUsinage, 2)} × ${pct(q.rebutUsinage)})</td><td class="num">${eur(f.usinage)}</td></tr>
        <tr class="total"><td colspan="5">PRI complet</td><td class="num">${eur(f.pri)}</td></tr>
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
      <tbody>${(q.composants ?? [])
        .map(
          (x, i) => `<tr><td>${input(`q.composants.${i}.designation`, x.designation, { kind: "text" })}</td><td class="num">${input(`q.composants.${i}.qte`, x.qte, { width: "70px" })}</td><td class="num">${input(`q.composants.${i}.prix`, x.prix, { width: "90px" })}</td><td class="num">${input(`q.composants.${i}.marge`, x.marge, { kind: "pct", width: "70px" })}</td><td><button type="button" class="small" data-action="remove-component" data-index="${i}">×</button></td></tr>`,
        )
        .join("")}</tbody></table></div>
    <p><button type="button" class="small" data-action="add-component">Ajouter un composant</button></p>
    <h4>Prix de vente (${y?.year ?? ""})</h4>
    <dl class="cstats">
      <dt>Matière vendue (VM)</dt><dd>${eur(y?.vmVendue)}</dd>
      <dt>VA vendue</dt><dd>${eur(y?.vaVendue)}</dd>
      <dt>Frais de mise en route</dt><dd>${eur(y?.miseEnRouteVendue)}</dd>
      <dt>Composants, sous-traitance, emballages</dt><dd>${eur(f.composants.sold + f.sousTraitance.sold + f.emballage.sold)}</dd>
      <dt><strong>Prix de vente complet</strong></dt><dd><strong>${eur(y?.prixVente)}</strong></dd>
      <dt>Prix complet PRI</dt><dd>${eur(y?.prixPri)}</dd>
      <dt>Marge sur VA</dt><dd>${eur(y?.margeVa)} (${pct(y?.margeVaPct)})</dd>
      <dt>Marge matière</dt><dd>${eur(y?.margeMatiere)}</dd>
      <dt>Marge totale</dt><dd>${eur(y?.margeTotale)} (${pct(y?.margeTotalePct)} du prix)</dd>
    </dl>
  </section>`;
}

function projectionCard(c) {
  const f = c.final;
  if (!f) return "";
  const head = f.years.map((y) => `<th class="num">${y.year}</th>`).join("");
  const row = (label, fn) => `<tr><td>${label}</td>${f.years.map((y, i) => `<td class="num">${fn(y, i)}</td>`).join("")}</tr>`;
  return `<section class="ccard">
    <h3>Projection annuelle</h3>
    <div class="cscroll"><table class="ctable">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>
        ${row("Volume (pièces)", (y, i) => input(`q.volumes.${i}`, c.volumes[i], { step: 1, min: 0, width: "90px" }))}
        ${row("PRI pièce", (y) => eur(y.pri))}
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
      <thead><tr><th>Îlot</th><th>Toile mini (mm)</th><th>Épaisseur maxi (mm)</th><th>Poids maxi (kg)</th><th>Dimension maxi (mm)</th><th>Volume mini /an</th><th>Empreintes maxi</th><th>Grappe maxi (kg)</th><th>Mise au mille</th><th>Cycle : base (s)</th><th>+ s / kg coulé</th><th>+ s / mm² de module</th><th>Qualité /10</th><th>Outillage (€)</th><th>TTH</th><th>Noyaux</th></tr></thead>
      <tbody>${processRows}</tbody></table></div>
    <p class="small muted">Temps de cycle estimé = base + (s/kg) × kg coulés par cycle + (s/mm²) × module V/S². Un îlot est écarté si la toile mini, le poids, la dimension, le traitement thermique ou les noyaux sont hors de ses possibilités. Valeurs de départ à ajuster aux îlots réels.</p>
  </section>
  <section class="ccard">
    <h3>Autres opérations</h3>
    <table class="ctable compact"><thead><tr><th>Opération</th><th>Cycle : base (s)</th><th>+ s / kg pièce</th><th>Pièces par cycle / charge (kg)</th></tr></thead><tbody>${opRows}</tbody></table>
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
  if (!c?.final) return;
  const { buildXlsx } = await import("../xlsx.js");
  const f = c.final;
  const y = f.years[0];
  const devis = [
    ["Client", q.client], ["Référence", q.reference], ["Désignation", q.designation], ["N° de plan", q.plan],
    ["Date", new Date().toLocaleDateString("fr-FR")],
    ["Alliage", q.alliage], ["Poids pièce (kg)", c.part.poids], ["Toile mini (mm)", c.part.toileMini || null], ["Épaisseur maxi (mm)", c.part.epaisseurMax || null],
    ["Îlot de coulée", `${c.route.process} — ${c.route.famille}`], ["Finition", settings.operations[c.route.finition]?.label ?? c.route.finition],
    ["Fonctionnement", c.finalRates.get(c.route.process)?.mode ?? ""],
    ["Temps de cycle (s)", c.route.operations.find((o) => o.code === c.route.process)?.cycle], ["Pièces par cycle", c.route.operations.find((o) => o.code === c.route.process)?.parCycle],
    ["Mise au mille", c.route.miseAuMille], ["Cours vente (€/t)", c.sale.cours], ["Date d'application", q.month], ["Typologie", q.typologie], ["Cours utilisé", q.cours],
    ["VA PRI (€)", f.va], ["Matière (€)", f.matiere], ["Perte au feu (€)", f.perteAuFeu], ["PRI complet (€)", f.pri],
    ["Prix de vente complet (€)", y?.prixVente], ["Marge sur VA (%)", y?.margeVaPct], ["Marge totale (€)", y?.margeTotale],
  ];
  const gamme = [["Centre", "Nom", "Fonctionnement", "Cycle (s)", "Pièces par cycle", "TRS", "Quantité (UO / pièce)", "Taux (€/UO)", "Coût (€/pièce)"]];
  for (const l of f.lines) {
    const op = c.route.operations.find((o) => o.code === l.code) ?? {};
    gamme.push([l.code, l.name, c.finalRates.get(l.code)?.mode ?? "", op.cycle ?? null, op.parCycle ?? null, op.trs ?? null, l.units, l.rate, l.cost]);
  }
  const projection = [["Année", "Volume", "PRI (€)", "Prix de vente (€)", "Marge sur VA (%)", "CA (€)"]];
  for (const yr of f.years) projection.push([yr.year, yr.volume, yr.pri, yr.prixVente, yr.margeVaPct, yr.ca]);
  const solutions = [["Rang", "Îlot", "Finition", "Cycle (s)", "Pièces par cycle", "PRI (€)", "Outillage / pièce (€)", "Qualité /10", "Qualité / prix"]];
  c.best.forEach((r, i) => solutions.push([i + 1, `${r.process} — ${r.famille}`, r.finition, r.cycle, r.parCycle, r.result.pri, r.outillagePiece, r.qualite, r.ratio * 100]));
  const bytes = buildXlsx([
    { name: "Devis", rows: devis, widths: [32, 40] },
    { name: "Gamme", rows: gamme, header: true, widths: [10, 34, 14, 12, 14, 10, 18, 14, 14] },
    { name: "Projection", rows: projection, header: true, widths: [10, 12, 14, 18, 16, 16] },
    { name: "Solutions", rows: solutions, header: true, widths: [8, 40, 10, 12, 14, 12, 18, 12, 14] },
  ]);
  const name = (q.reference || "piece").replace(/[^\w.-]+/g, "_");
  download(`chiffrage_${name}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}
