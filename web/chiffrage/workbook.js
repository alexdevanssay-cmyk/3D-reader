// Extraction of the costing data of the SAB costing workbook (the sheets
// PRI "Réel", PRI 1x8 / 2x8 / 3x8, PRI "Chiffrage", Liste, Suivi indice and
// Chiffrage of the .xlsm), and of the metal price indices of the
// "VALEURS MB LME.xlsx" file (sheet "Suivi indice"). Only the values Excel
// computed are read; the costing itself is recomputed in model.js.
//
// The data stays in the browser of the user (it is confidential): nothing of
// it is part of the published site.

import { columnName, excelDate, parseRef, readWorkbook } from "./xlsxread.js";

export const MODES = ["1*8", "2*8", "3*8", "Réel"];
const SCENARIOS = {
  "1*8": { sheet: "PRI 1x8", cost: 3, label: 17, machines: 18, hours: 19, kgCast: 24, kgSold: 25 },
  "2*8": { sheet: "PRI 2x8", cost: 3, label: 17, machines: 18, hours: 19, kgCast: 24, kgSold: 25 },
  "3*8": { sheet: "PRI 3x8", cost: 3, label: 17, machines: 18, hours: 19, kgCast: 24, kgSold: 25 },
  "Réel": { sheet: 'PRI "Réel"', cost: 3, label: 20, machines: 21, hours: 22, kgCast: 27, kgSold: 28 },
};
const PRI = 'PRI "Chiffrage"';
// Rows of the cost categories in the PRI "Chiffrage" sheet (5 to 14), in this order.
export const COST_ROWS = [
  "salaires", "batiment", "entretien", "investissements", "consommables",
  "electricite", "gaz", "autresEnergies", "prestations", "corporate",
];
// Rows 45 to 51 of PRI "Chiffrage": annual amounts added to some categories.
const ANNUAL_ROWS = { salaires: 45, entretien: 46, consommables: 47, electricite: 48, gaz: 49, autresEnergies: 50, prestations: 51 };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v) => (v === undefined || v === null || typeof v === "object" ? "" : String(v).trim());

/** Read a workbook from bytes; throws a readable error if it is not the costing workbook. */
export function readCostingWorkbook(bytes, fileName = "") {
  const wb = readWorkbook(bytes);
  const missing = [PRI, ...Object.values(SCENARIOS).map((s) => s.sheet), "Liste"].filter((n) => !wb.sheetNames.includes(n));
  if (missing.length) {
    throw new Error(`Ce classeur n'est pas un classeur de chiffrage SAB (onglets absents : ${missing.join(", ")})`);
  }
  const base = extractCostBase(wb);
  base.source = { fileName, importedAt: new Date().toISOString() };
  const indices = wb.sheetNames.includes("Suivi indice") ? extractIndices(wb) : null;
  return { base, indices };
}

/** Read the metal prices file (any workbook with a "Suivi indice" sheet). */
export function readIndicesWorkbook(bytes) {
  const wb = readWorkbook(bytes);
  if (!wb.sheetNames.includes("Suivi indice")) {
    throw new Error(`Onglet « Suivi indice » absent de ce classeur (onglets : ${wb.sheetNames.join(", ")})`);
  }
  return extractIndices(wb);
}

/** Costs, hours and options of the profit centres, lists and default inputs. */
export function extractCostBase(wb) {
  const pri = wb.sheet(PRI);
  const priF = wb.formulas(PRI);
  const at = (cells, col, row) => cells?.get(`${col}${row}`);

  const centres = [];
  for (let c = 1; c <= 22; c++) {
    const col = columnName(c); // B .. W
    const code = str(at(pri, col, 3));
    if (!code) continue;
    const f5 = priF.get(`${col}5`) ?? "";
    const source = /\bIF\(/.test(f5) ? "modes" : /PRI "Réel"/.test(f5) ? "reel" : "direct";
    const f24 = priF.get(`${col}24`) ?? "";
    const f31 = priF.get(`${col}31`) ?? "";
    const label = str(at(pri, col, 4)).split("\n")[0].trim();
    const modes = {};
    for (const mode of MODES) {
      const s = SCENARIOS[mode];
      const sheet = wb.sheet(s.sheet);
      modes[mode] = {
        costs: COST_ROWS.map((_, i) => num(at(sheet, col, s.cost + i))),
        label: str(at(sheet, col, s.label)),
        machines: num(at(sheet, col, s.machines)),
        hours: num(at(sheet, col, s.hours)),
        kgSold: num(at(sheet, col, s.kgSold)),
      };
    }
    const rowValues = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => num(at(pri, col, from + i)));
    const unitCell = str(at(pri, col, 26));
    const ptype = str(at(pri, col, 30));
    let uo = "pph";
    // Centres costed per kg: per kg cast (row 30, ASF) or per kg sold (row 31, TTH).
    if (/au kg/i.test(unitCell)) uo = /[A-Z]30\b/.test(priF.get(`${col}33`) ?? "") ? "kgCast" : "kgSold";
    else if (code === "EXP") uo = "hour";
    centres.push({
      col,
      code,
      name: label || code,
      uo,
      unitLabel: ptype,
      source,
      direct: source === "direct" ? rowValues(5, 14) : null,
      fixedHours: /\bIF\(/.test(f24) ? null : num(at(pri, col, 24)),
      fixedKgSold: /\bIF\(/.test(f31) ? null : num(at(pri, col, 31)),
      defaultMode: MODES.includes(str(at(pri, col, 1))) ? str(at(pri, col, 1)) : "Réel",
      fixedCost: num(at(pri, col, 19)),
      modes,
      annual: Object.fromEntries(Object.entries(ANNUAL_ROWS).map(([k, row]) => [k, num(at(pri, col, row))])),
      invest: {
        structure: num(at(pri, col, 38)),
        composant: num(at(pri, col, 39)),
        dureeStructure: num(at(pri, col, 41)),
        dureeComposant: num(at(pri, col, 42)),
      },
    });
  }

  // Spare columns of the workbook without any cost are not profit centres.
  const used = centres.filter((c) => (c.direct ? c.direct.some((v) => v) : Object.values(c.modes).some((m) => m.costs.some((v) => v))));
  centres.length = 0;
  centres.push(...used);

  // Corporate costs spread over the centres (PRI "Chiffrage" AB5:AB14).
  const corporate = Array.from({ length: 10 }, (_, i) => num(at(pri, "AB", 5 + i))).reduce((a, b) => a + b, 0);
  const evolution = {
    consommables: num(at(pri, "B", 55)),
    entretien: num(at(pri, "B", 56)),
    salaires: num(at(pri, "B", 57)),
    autresEnergies: num(at(pri, "B", 60)),
    autres: num(at(pri, "B", 61)),
  };
  const energy = {
    elecAncien: num(at(pri, "C", 58)),
    elecNouveau: num(at(pri, "D", 58)),
    gazAncien: num(at(pri, "C", 59)),
    gazNouveau: num(at(pri, "D", 59)),
  };

  return { centres, corporate, evolution, energy, lists: extractLists(wb), defaults: extractDefaults(wb) };
}

function columnValues(cells, col, from = 2) {
  const out = [];
  for (let row = from; row < 400; row++) {
    const v = cells.get(`${col}${row}`);
    if (v === undefined || v === "") {
      if (out.length && row > from + 40) break;
      continue;
    }
    out.push({ row, value: v });
  }
  return out;
}

function extractLists(wb) {
  const liste = wb.sheet("Liste");
  const values = (col) => columnValues(liste, col).map((x) => x.value).filter((v) => typeof v === "string" || typeof v === "number");
  const coefs = columnValues(liste, "L")
    .filter((x) => typeof x.value === "number")
    .map((x) => ({ coef: x.value, perteAuFeu: num(liste.get(`M${x.row}`)), coutsGlobaux: num(liste.get(`N${x.row}`)) }));
  const emballages = columnValues(liste, "U")
    .filter((x) => typeof x.value === "string")
    .map((x) => ({ name: x.value, prix: num(liste.get(`V${x.row}`)) }));
  return {
    alliages: values("C").map(String),
    coefs,
    typologies: values("AA").map(String),
    cours: values("Y").map(String),
    coursP1020: values("AC").map(String),
    emballages,
    anneePri: num(liste.get("A2")),
  };
}

function extractDefaults(wb) {
  const ch = wb.sheet("Chiffrage");
  if (!ch) return {};
  const v = (ref) => ch.get(ref);
  const n = (ref, fallback = 0) => (typeof v(ref) === "number" ? v(ref) : fallback);
  const changeover = [];
  for (let row = 108; row <= 114; row++) {
    const code = str(v(`D${row}`));
    if (code) changeover.push({ code, heures: n(`G${row}`) });
  }
  const volumes = [];
  for (const col of ["I", "K", "M", "O", "Q", "S", "U", "V", "W", "X", "Y", "Z"]) volumes.push(n(`${col}126`));
  return {
    coursAchat: n("J73"),
    p1020Achat: n("J74"),
    premiumAchat: n("J75"),
    premiumVente: n("L75"),
    pafAchat: n("J78", 0.06),
    pafVente: n("L78", 0.08),
    coefDifficulte: n("H83"),
    vaUsinage: n("D84"),
    rebutUsinage: n("H84"),
    evolutionSalaires: n("G94"),
    evolutionConso: n("G96"),
    evolutionElec: n("G98"),
    evolutionGaz: n("G100"),
    evolutionAutresEnergies: n("G102"),
    coefSecurite: n("G116", 0.1),
    tailleSerie: n("G119"),
    nombrePieces: n("G120"),
    margeComposants: n("Q117", 0.1),
    marge: n("B135"),
    tauxMini: n("AA156", 0.1),
    changeover,
    volumes,
  };
}

/**
 * Metal price indices of a "Suivi indice" sheet: one row per month (column
 * "Mois"), one column per index (header row 1), plus the definitions of the
 * averaging windows (columns Type, Début, Fin: e.g. "M-1/M-3" = months -3 to -1).
 */
export function extractIndices(wb) {
  const cells = wb.sheet("Suivi indice");
  const headers = new Map(); // name -> column letter
  for (const [ref, value] of cells) {
    const { col, row } = parseRef(ref);
    if (row === 1 && typeof value === "string" && value.trim()) headers.set(value.trim(), columnName(col));
  }
  const monthCol = headers.get("Mois");
  if (!monthCol) throw new Error("Colonne « Mois » absente de l'onglet « Suivi indice »");
  const rows = [];
  for (let row = 2; row < 2000; row++) {
    const m = cells.get(`${monthCol}${row}`);
    if (typeof m !== "number") {
      if (rows.length && row > rows.at(-1).row + 5) break;
      continue;
    }
    const d = excelDate(m);
    rows.push({ row, month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` });
  }
  const series = {};
  for (const [name, col] of headers) {
    if (["Type", "Début", "Fin", "Mois"].includes(name) || /^Column\d+$/.test(name)) continue;
    const values = rows.map((r) => {
      const v = cells.get(`${col}${r.row}`);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    if (values.some((v) => v !== null)) series[name] = values;
  }
  const typologies = [];
  const typeCol = headers.get("Type");
  const startCol = headers.get("Début");
  const endCol = headers.get("Fin");
  if (typeCol && startCol && endCol) {
    for (let row = 2; row < 200; row++) {
      const name = str(cells.get(`${typeCol}${row}`));
      if (!name) continue;
      const start = cells.get(`${startCol}${row}`);
      const end = cells.get(`${endCol}${row}`);
      if (typeof start === "number" && typeof end === "number") typologies.push({ name, start, end });
    }
  }
  return { months: rows.map((r) => r.month), series, typologies };
}
