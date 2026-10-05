// The series order of a customer request (RFQ / GO NO GO workbook, such as
// "GSAB…-CG-2026-00 - CLIENT - RFQ … .xlsm"): volumes per year, order
// quantities (MOQ), target price and the identification of the part. Read in
// the browser like the other workbooks: nothing of it is published.

import { columnName, parseRef, readWorkbook } from "./xlsxread.js";

const SHEET = "1- Données GO NO GO";
const DATA = "3- Données de chiffrages";

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
  const years = [];
  if (yearsRow && volumesRow) {
    for (let c = 8; c < 60; c++) {
      const name = columnName(c);
      const year = num(yearsRow.at(name));
      if (year === null) continue;
      years.push({ year, volume: num(volumesRow.at(name)) ?? 0 });
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
  return {
    fileName,
    importedAt: new Date().toISOString(),
    client: str(value(/^nom du client/)),
    demande: str(value(/^reference de la demande client/)),
    reference: refDes,
    plan: str(value(/^plan 2d/, "C")) || str(value(/^plan 3d/, "C")),
    offre: str(dataValue(/^n° offre/)),
    alliage: str(value(/^alliage/)),
    fonderie: str(value(/^fonderie/)),
    usinage: str(value(/^usinage/)),
    references: num(value(/^nombre total de reference/)),
    years,
    moqs: [...new Set(moqs)].sort((a, b) => b - a),
    targetPrice: num(value(/^target price/)),
    elec: num(dataValue(/^electricite/)),
    gaz: num(dataValue(/^gaz/)),
  };
}

/** The volumes of the programme: first year with a volume, number of years, volume of each year. */
export function programmeOf(order) {
  const active = order.years.filter((y) => y.volume > 0);
  if (!active.length) return null;
  const first = active[0].year;
  const last = active.at(-1).year;
  const volumes = order.years.filter((y) => y.year >= first && y.year <= last).map((y) => y.volume);
  return { premiereAnnee: first, annees: volumes.length, volumes, pic: Math.max(...volumes) };
}
