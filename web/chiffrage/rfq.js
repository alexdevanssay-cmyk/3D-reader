// The series order of a customer request (RFQ / GO NO GO workbook, such as
// "GSAB…-CG-2026-00 - CLIENT - RFQ … .xlsm"): volumes per year, order
// quantities (MOQ), target price and the identification of the part. Read in
// the browser like the other workbooks: nothing of it is published.

import { columnName, excelDate, parseRef, readWorkbook } from "./xlsxread.js";

const SHEET = "1- Données GO NO GO";
const DATA = "3- Données de chiffrages";
const FOUNDRY = "5- Chiffrage Fonderie";

const str = (v) => (v === undefined || v === null || typeof v === "object" ? "" : String(v).trim());
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLowerCase();

/** Cells of the row whose label (column `labelCol`) matches `re`: {row, at(col)}. */
function rowOf(cells, re, labelCol = "A") {
  for (const [ref, value] of cells) {
    const { row } = parseRef(ref);
    if (/^[A-Z]+/.exec(ref)[0] !== labelCol) continue;
    if (typeof value === "string" && re.test(norm(value))) return { row, at: (col) => cells.get(`${col}${row}`) };
  }
  return null;
}

/**
 * Read the series order of an RFQ workbook. Returns
 * {fileName, importedAt, client, demande, reference, plan, offre, alliage, fonderie, usinage,
 *  references, years:[{year, volume}], moqs:[n], targetPrice, elec, gaz}.
 */
export function readSeriesOrder(bytes, fileName = "") {
  const wb = readWorkbook(bytes);
  const cells = wb.sheet(SHEET);
  if (!cells) {
    throw new Error(`Ce classeur n'est pas une demande client (onglet « ${SHEET} » absent ; onglets : ${wb.sheetNames.join(", ")})`);
  }
  const value = (re, col = "B") => rowOf(cells, re)?.at(col);

  // Volumes: the row "Année" (years) and the row "Volume série", labels in column H.
  const yearsRow = rowOf(cells, /^annee$/, "H");
  const volumesRow = rowOf(cells, /^volume serie/, "H");
  const protoRow = rowOf(cells, /^volume proto/, "H");
  const years = [];
  if (yearsRow && volumesRow) {
    for (let c = 8; c < 60; c++) {
      const name = columnName(c);
      const year = num(yearsRow.at(name));
      if (year === null) continue;
      years.push({ year, volume: num(volumesRow.at(name)) ?? 0, proto: num(protoRow?.at(name)) ?? 0 });
    }
  }
  const moqs = [];
  for (let i = 1; i <= 5; i++) {
    const n = num(value(new RegExp(`^moq ${i}\\b`)));
    if (n > 0) moqs.push(n);
  }
  const data = wb.sheet(DATA);
  const dataValue = (re) => (data ? rowOf(data, re)?.at("B") : undefined);
  const refDes = str(value(/^reference & designation piece/));
  const offre = str(dataValue(/^n° offre/));
  const autres = str(value(/^autres/));
  return {
    fileName,
    importedAt: new Date().toISOString(),
    client: str(value(/^nom du client/)),
    demande: str(value(/^reference de la demande client/)),
    reference: refDes,
    plan: str(value(/^plan 2d/, "C")) || str(value(/^plan 3d/, "C")),
    offre,
    // A prototype request: the rule of the "3- Données de chiffrages" sheet (GSAB number
    // with "-P": prototype volumes, no productivity, no target price), or "Proto: Oui".
    gsab: str(dataValue(/^gsab/)),
    prototype: /-P/i.test(str(dataValue(/^gsab/))) || /^oui/i.test(str(value(/^proto$/))),
    alliage: str(value(/^alliage/)),
    fonderie: str(value(/^fonderie/)),
    usinage: str(value(/^usinage/)),
    autres,
    tth: heatTreatmentOf(autres),
    references: num(value(/^nombre total de reference/)),
    years,
    moqs: [...new Set(moqs)].sort((a, b) => b - a),
    targetPrice: num(value(/^target price/)),
    elec: num(dataValue(/^electricite/)),
    gaz: num(dataValue(/^gaz/)),
    matiere: metalOf(wb.sheet(FOUNDRY)),
  };
}

/**
 * The metal of the foundry quote of the request ("5- Chiffrage Fonderie",
 * labels in column C, values in D): alloy, averaging, price index, month,
 * purchase and sale prices (€/t), loss on melting. null without that sheet;
 * missing values are null.
 */
function metalOf(cells) {
  if (!cells) return null;
  const at = (re) => rowOf(cells, re, "C")?.at("D");
  const date = num(at(/^date de reference/));
  const d = date ? excelDate(date) : null;
  const out = {
    alliage: str(at(/^alliage/)),
    typologie: str(at(/^typologie/)),
    cours: str(at(/^cours utilise/)),
    month: d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null,
    coursAchat: num(at(/^valeur de reference achat/)),
    coursVente: num(at(/^valeur de reference vente/)),
    p1020Achat: num(at(/^p1020 achat/)),
    p1020Vente: num(at(/^p1020 vente/)),
    premiumAchat: num(at(/^premium achat/)),
    premiumVente: num(at(/^premium vente/)),
    pafAchat: num(at(/^paf pri/)),
    pafVente: num(at(/^paf vendue/)),
  };
  return Object.values(out).some((v) => v !== null && v !== "") ? out : null;
}

/**
 * The volumes of the programme: first year with a volume, number of years,
 * volume of each year. proto: the prototype volumes (row "Volume proto").
 */
export function programmeOf(order, { proto = false } = {}) {
  const volumeOf = (y) => (proto ? y.proto ?? 0 : y.volume);
  const active = order.years.filter((y) => volumeOf(y) > 0);
  if (!active.length) return null;
  const first = active[0].year;
  const last = active.at(-1).year;
  const volumes = order.years.filter((y) => y.year >= first && y.year <= last).map(volumeOf);
  return { premiereAnnee: first, annees: volumes.length, volumes, pic: Math.max(...volumes) };
}

/**
 * Heat treatment asked in the "Autres (TTH, FSW...)" field: the code of the
 * treatment (T4, T5, T6, T64, T7), "T6" when only "TTH" / "traitement
 * thermique" is written, null when none ("A définir", "Non"...).
 */
export function heatTreatmentOf(text) {
  const t = norm(text ?? "");
  const code = /\bt\s?(64|4|5|6|7)\b/.exec(t);
  if (code) return `T${code[1]}`;
  if (/stabilis|detension/.test(t)) return "STAB";
  if (/\btth\b|traitement thermique|heat treat/.test(t)) return "T6";
  return null;
}
