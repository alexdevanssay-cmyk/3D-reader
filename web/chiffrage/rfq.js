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
const positive = (v) => (num(v) > 0 ? v : null);
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
 *  references, years:[{year, volume}], moqs:[n], targetPrice, elec, gaz, matiere,
 *  poidsBrut, poidsVendu, miseAuMille, rebutUsinage}.
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
    // Values of the part that the costing compares with its own (provenance.js:
    // alternatives, alert beyond a tolerance) but does not apply: whether to
    // apply them is a decision left to the user. null when absent.
    poidsBrut: positive(value(/^poids brut vendu/)),
    ...foundryOf(wb.sheet(FOUNDRY)),
  };
}

/**
 * Weight, mise au mille and machining scrap rate of the foundry quote of the
 * request ("5- Chiffrage Fonderie", labels in column C, values in D):
 * {poidsVendu (kg / piece), miseAuMille (kg cast / kg piece), rebutUsinage
 * (fraction)}, null when absent. A mise au mille of 100 or more is read per
 * 1000 kg (kg cast for a tonne of pieces), a scrap rate above 1 in percent.
 */
function foundryOf(cells) {
  const at = (re) => (cells ? rowOf(cells, re, "C")?.at("D") : undefined);
  const mam = positive(at(/^mise au mille/));
  const scrap = num(at(/^taux de rebuts? (d')?usinage/));
  return {
    poidsVendu: positive(at(/^poids vendu/)),
    miseAuMille: mam === null ? null : mam >= 100 ? mam / 1000 : mam,
    rebutUsinage: scrap === null || scrap < 0 ? null : scrap > 1 ? scrap / 100 : scrap,
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

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pick = (value, options) => options?.find((o) => String(o).toLowerCase() === String(value ?? "").toLowerCase());

/** The volumes of quote `q` ({premiereAnnee, annees, volumes, volumeAnnuel}) are those of `prog` (programmeOf). */
export function sameProgramme(q, prog) {
  if (!prog || q.premiereAnnee !== prog.premiereAnnee || q.annees !== prog.annees) return false;
  const volumes = Array.isArray(q.volumes) && q.volumes.length === q.annees ? q.volumes : Array.from({ length: q.annees }, () => q.volumeAnnuel || 0);
  return volumes.every((v, i) => v === prog.volumes[i]);
}

/**
 * Prototypes (`proto`) or series: the programme of the request for that mode
 * goes into quote `q` only in place of volumes that came from the request
 * (its series or prototype volumes); volumes typed in are kept.
 * {programme: to apply, or null; typed: volumes typed in kept, the request's not applied}.
 */
export function programmeFor(q, order, proto) {
  const prog = order ? programmeOf(order, { proto }) : null;
  if (!prog || sameProgramme(q, prog)) return { programme: null, typed: false };
  const fromRequest = [false, true].some((p) => sameProgramme(q, programmeOf(order, { proto: p })));
  return fromRequest ? { programme: prog, typed: false } : { programme: null, typed: true, ignored: prog };
}

/**
 * What a customer request writes into a quote ({field: value}): the
 * identification of the part, the volumes of its programme (the prototype
 * ones for `proto`), its order quantities and the series size, the target
 * price, and the alloy and the metal of its foundry quote when the lists
 * have them. lists: {alliages, typologies, cours} (costing workbook, indices).
 */
export function orderValues(order, lists = {}, { proto = !!order.prototype } = {}) {
  const out = { prototype: !!order.prototype };
  const prog = programmeOf(order, { proto });
  if (prog) Object.assign(out, { premiereAnnee: prog.premiereAnnee, annees: prog.annees, volumes: prog.volumes, volumeAnnuel: prog.pic });
  if (order.moqs.length) {
    out.moqs = order.moqs;
    // The changeover is spread over the largest order quantity, at most a year of production.
    out.tailleSerie = prog ? Math.min(order.moqs[0], prog.pic) : order.moqs[0];
  }
  if (order.targetPrice) out.prixCible = order.targetPrice;
  if (order.client) out.client = order.client;
  // "MZ-0681155 - K.451.256G LABLE PLATE RIGHT": reference, then designation.
  const m = /^(\S+)\s+-\s+(.+)$/.exec(order.reference);
  if (m) [out.reference, out.designation] = [m[1], m[2]];
  else if (order.reference) out.reference = order.reference;
  if (order.plan) out.plan = order.plan;
  // The metal of the foundry quote of the request, as the default of the "Matière" card.
  const metal = order.matiere;
  const alliage = pick(metal?.alliage, lists.alliages) ?? pick(order.alliage, lists.alliages);
  if (alliage) out.alliage = alliage;
  if (metal) {
    const typologie = pick(metal.typologie, lists.typologies);
    const cours = pick(metal.cours, lists.cours);
    if (typologie) out.typologie = typologie;
    if (cours) out.cours = cours;
    if (metal.month) out.month = metal.month;
    for (const k of ["coursAchat", "p1020Achat", "premiumAchat", "premiumVente", "pafAchat", "pafVente"]) if (metal[k] !== null) out[k] = metal[k];
  }
  return out;
}

/** The fields of quote `q` that still hold the value a request gave them (`values`: orderValues). */
export const filledFields = (q, values) => Object.keys(values).filter((k) => same(q[k], values[k]));

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
