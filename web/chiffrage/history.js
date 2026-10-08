// History of casting cycle times: the times of past quotes (source "devis")
// and the times measured in production (source "production", the "Retour
// d'expérience" of the Chiffrage page). Kept in this browser (store.js),
// imported and exported as a JSON file
//   {schema: "reader3d-historique-cycles", version: 1, pieces: [record...]}
// record: {ref, fichier_3d, source, ilot, temps_cycle_s, pieces_par_cycle,
//          trs, poids_kg, module_mm, volume_cm3, surface_cm2, encombrement_mm,
//          noyaux, sable_kg, serie, mise_au_mille, date?, note?,
//          toile_mini_mm?, epaisseur_max_mm?, estimation_ia?}
// A reference to compare the estimates with: nothing of it is applied to a
// quote or to the settings, and nothing is sent anywhere.

import { castingCycle, estimateMiseAuMille, piecesPerCycle } from "./routes.js";

export const SCHEMA = "reader3d-historique-cycles";
export const VERSION = 1;
export const SOURCES = ["devis", "production"];

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const POSITIVE = [isPositive, "nombre > 0 attendu"];
const TEXT = [isText, "texte attendu"];

// The fields of a record, in the order of the file; then those written only when set (OPTIONAL).
const ORDER = ["ref", "fichier_3d", "source", "ilot", "temps_cycle_s", "pieces_par_cycle", "trs", "poids_kg", "module_mm", "volume_cm3", "surface_cm2", "encombrement_mm", "noyaux", "sable_kg", "serie", "mise_au_mille"];
// Fields besides ref, source, ilot, temps_cycle_s and poids_kg: [test, reason of a refused value].
// A refused value is left out (null), the record is kept.
const FIELDS = {
  fichier_3d: TEXT,
  pieces_par_cycle: [(v) => Number.isInteger(v) && v >= 1, "nombre entier ≥ 1 attendu"],
  trs: [(v) => isPositive(v) && v <= 1, "TRS entre 0 et 1 attendu (0,85 pour 85 %)"],
  module_mm: POSITIVE,
  volume_cm3: POSITIVE,
  surface_cm2: POSITIVE,
  encombrement_mm: [(v) => Array.isArray(v) && v.length === 3 && v.every(isPositive), "trois dimensions > 0 attendues"],
  noyaux: [(v) => typeof v === "boolean", "vrai / faux attendu"],
  sable_kg: [(v) => typeof v === "number" && Number.isFinite(v) && v >= 0, "nombre ≥ 0 attendu"],
  serie: POSITIVE,
  mise_au_mille: POSITIVE,
};
const OPTIONAL = {
  toile_mini_mm: POSITIVE,
  epaisseur_max_mm: POSITIVE,
  date: [(v) => isText(v) && !Number.isNaN(Date.parse(v)), "date attendue (AAAA-MM-JJ)"],
  note: TEXT,
  // The estimate of the AI for this record, once a person validated it (step of the AI page).
  estimation_ia: [(v) => isPlain(v) && isPositive(v.temps_cycle_s), "{temps_cycle_s > 0} attendu"],
};
const KNOWN = new Set([...ORDER, ...Object.keys(OPTIONAL)]);

/**
 * One record of a history file checked: {record (null: refused), errors[],
 * ignored: [{field, reason}], unknown: [field]}. Refused without an island, a
 * cycle time or a weight above 0, or with an unknown source; a missing source
 * is "devis" (a time of a past quote, never taken for a measured one).
 */
export function checkRecord(raw) {
  if (!isPlain(raw)) return { record: null, errors: ["enregistrement (objet JSON) attendu"], ignored: [], unknown: [] };
  const errors = [];
  const ignored = [];
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k));
  const given = (k) => raw[k] !== null && raw[k] !== undefined;
  const ref = typeof raw.ref === "number" && Number.isFinite(raw.ref) ? String(raw.ref) : isText(raw.ref) ? raw.ref.trim() : null;
  if (given("ref") && ref === null) ignored.push({ field: "ref", reason: "texte attendu" });
  const source = given("source") ? raw.source : "devis";
  if (!SOURCES.includes(source)) errors.push(`source « ${source} » inconnue (devis ou production)`);
  if (!isText(raw.ilot)) errors.push(given("ilot") ? "ilot : texte attendu" : "ilot manquant");
  for (const k of ["temps_cycle_s", "poids_kg"]) if (!isPositive(raw[k])) errors.push(given(k) ? `${k} : nombre > 0 attendu` : `${k} manquant`);
  if (errors.length) return { record: null, errors, ignored, unknown };

  const take = (k, [test, reason]) => {
    if (!given(k)) return null;
    if (test(raw[k])) return typeof raw[k] === "string" ? raw[k].trim() : structuredClone(raw[k]);
    ignored.push({ field: k, reason: raw[k] === 0 ? "0 lu comme inconnu" : reason });
    return null;
  };
  const checked = { ref, source, ilot: raw.ilot.trim(), temps_cycle_s: raw.temps_cycle_s, poids_kg: raw.poids_kg };
  for (const [k, rule] of Object.entries(FIELDS)) checked[k] = take(k, rule);
  const record = Object.fromEntries(ORDER.map((k) => [k, checked[k]]));
  for (const [k, rule] of Object.entries(OPTIONAL)) {
    const v = take(k, rule);
    if (v !== null) record[k] = v;
  }
  if (record.estimation_ia) {
    const e = record.estimation_ia;
    record.estimation_ia = { temps_cycle_s: e.temps_cycle_s, ...Object.fromEntries(["fournisseur", "modele", "date"].filter((k) => isText(e[k])).map((k) => [k, e[k]])) };
  }
  return { record, errors, ignored, unknown };
}

/** How a record is named in a report: its reference, else its rank in the file. */
const nameOf = (raw, i) => (isText(raw?.ref) || typeof raw?.ref === "number" ? String(raw.ref).trim() : `n° ${i + 1}`);

/**
 * A history file checked: {pieces (the records kept), refused: [{name,
 * reasons}], ignored: [{name, field, reason}], unknown: [field]}. Throws when
 * it is not a history file of this version.
 */
export function validateHistory(json) {
  if (!isPlain(json) || json.schema !== SCHEMA) throw new Error(`fichier d'historique attendu (schema « ${SCHEMA} »)`);
  if (json.version !== VERSION) throw new Error(`version ${json.version ?? "absente"} non prise en charge (version ${VERSION} attendue)`);
  if (!Array.isArray(json.pieces)) throw new Error("liste « pieces » attendue");
  const pieces = [];
  const refused = [];
  const ignored = [];
  const unknown = new Set();
  json.pieces.forEach((raw, i) => {
    const c = checkRecord(raw);
    for (const k of c.unknown) unknown.add(k);
    for (const x of c.ignored) ignored.push({ name: nameOf(raw, i), ...x });
    if (c.record) pieces.push(c.record);
    else refused.push({ name: nameOf(raw, i), reasons: c.errors });
  });
  return { pieces, refused, ignored, unknown: [...unknown] };
}

/** The key that merges two records: same reference and same source (none without a reference). */
const keyOf = (r) => (r.ref ? `${r.source}\u0000${r.ref}` : null);

/**
 * `incoming` records merged into `existing` (neither changed): a record of
 * the same reference and source replaces the one in place; a record without a
 * reference is added unless the same one is there. Returns {pieces, added, replaced}.
 */
export function mergeHistory(existing, incoming) {
  const pieces = [...existing];
  const index = new Map(pieces.map((r, i) => [keyOf(r), i]).filter(([k]) => k));
  let added = 0;
  let replaced = 0;
  for (const r of incoming) {
    const k = keyOf(r);
    const at = k ? index.get(k) : pieces.findIndex((x) => !x.ref && JSON.stringify(x) === JSON.stringify(r));
    if (at !== undefined && at >= 0) {
      pieces[at] = r;
      replaced++;
    } else {
      if (k) index.set(k, pieces.length);
      pieces.push(r);
      added++;
    }
  }
  return { pieces, added, replaced };
}

/**
 * Import of a history file into the records `existing`: {pieces, report:
 * {count, added, replaced, refused, ignored, unknown}}. Throws when the file
 * has no valid record (nothing is changed).
 */
export function importHistory(existing, json) {
  const v = validateHistory(json);
  if (!v.pieces.length) {
    const why = v.refused.slice(0, 5).map((x) => `${x.name} : ${x.reasons.join(", ")}`).join(" ; ");
    throw new Error(`aucun enregistrement valable dans ce fichier${why ? ` (${why})` : ""}`);
  }
  const { pieces, added, replaced } = mergeHistory(existing, v.pieces);
  return { pieces, report: { count: v.pieces.length, added, replaced, refused: v.refused, ignored: v.ignored, unknown: v.unknown } };
}

/** The records as a history file, the format of the import. */
export function exportHistory(pieces) {
  return {
    schema: SCHEMA,
    version: VERSION,
    description: "Historique des temps de cycle exporté de 3D Reader. source « devis » : temps chiffrés dans des devis ; « production » : temps mesurés. Données confidentielles : ne pas publier.",
    pieces,
  };
}

/** Number of records by source, and by island: {total, devis, production, ilots: [{ilot, devis, production}]} (islands in order). */
export function countHistory(pieces) {
  const by = new Map();
  const out = { total: pieces.length, devis: 0, production: 0, ilots: [] };
  for (const r of pieces) {
    out[r.source]++;
    if (!by.has(r.ilot)) by.set(r.ilot, { ilot: r.ilot, devis: 0, production: 0 });
    by.get(r.ilot)[r.source]++;
  }
  out.ilots = [...by.values()].sort((a, b) => a.ilot.localeCompare(b.ilot, "fr", { numeric: true }));
  return out;
}

/**
 * The casting cycle (s) the formula of routes.js gives for record `r` with
 * the settings `settings`: its weight, modulus (unknown: 0, as in the quote),
 * mise au mille and pieces per cycle; the island's estimates of these when the
 * record has none. null when the island is not in the settings.
 */
export function formulaCycle(r, settings) {
  const p = settings?.processes?.[r.ilot];
  if (!p?.cycle) return null;
  const miseAuMille = r.mise_au_mille ?? estimateMiseAuMille(p, { poids: r.poids_kg, toileMini: r.toile_mini_mm ?? 0, epaisseurMax: r.epaisseur_max_mm ?? 0 }).value;
  const kgCast = r.poids_kg * miseAuMille;
  const cycle = castingCycle(p, kgCast, r.pieces_par_cycle ?? piecesPerCycle(p, kgCast), r.module_mm);
  return Number.isFinite(cycle) ? cycle : null;
}

/** Mean absolute relative error of the estimates `items` ({ecart}) that have one: {n, emap}, or null. */
function meanError(items) {
  const gaps = items.filter((x) => x).map((x) => Math.abs(x.ecart));
  return gaps.length ? { n: gaps.length, emap: gaps.reduce((a, b) => a + b, 0) / gaps.length } : null;
}

/**
 * The real cycle times (records "production") against the estimates: the
 * formula with the settings `settings` (recomputed), with the settings of the
 * trends `trend` (null: no trends file; an island it has no cycle for: null),
 * and the estimate of the AI kept with the record. Each estimate with its
 * relative error (estimate − real) / real.
 *   {rows: [{record, formule, tendance, ia}], ilots: [{ilot, n, formule, tendance, ia}], total}
 *   estimate: {valeur, ecart} or null; in ilots and total: {n, emap} (mean absolute error) or null.
 */
export function compareCycles(pieces, settings, trend = null) {
  const estimate = (valeur, real) => (isPositive(valeur) ? { valeur, ecart: (valeur - real) / real } : null);
  const rows = pieces
    .filter((r) => r.source === "production")
    .map((record) => ({
      record,
      formule: estimate(formulaCycle(record, settings), record.temps_cycle_s),
      tendance: trend ? estimate(formulaCycle(record, trend), record.temps_cycle_s) : null,
      ia: estimate(record.estimation_ia?.temps_cycle_s, record.temps_cycle_s),
    }));
  const summary = (ilot, rs) => ({ ilot, n: rs.length, ...Object.fromEntries(["formule", "tendance", "ia"].map((k) => [k, meanError(rs.map((x) => x[k]))])) });
  const islands = [...new Set(rows.map((x) => x.record.ilot))].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  return { rows, ilots: islands.map((i) => summary(i, rows.filter((x) => x.record.ilot === i))), total: summary(null, rows) };
}

// Similar parts: a distance in "doublings" of the weight. A modulus 2 mm apart
// counts as much as a weight twice (or half) as large, cores on one side only
// as much too; an unknown modulus, half as much.
const MODULE_STEP = 2;
const CORES_MISMATCH = 1;
const UNKNOWN_MODULE = 0.5;
const fr = (v, digits) => v.toLocaleString("fr-FR", { maximumFractionDigits: digits });

/**
 * The `k` records of the history most like the part `part` (fields of a
 * record: ilot, poids_kg, module_mm, noyaux): those of the same island first,
 * then by their score, 1 / (1 + distance), the distance adding the weight
 * ratio on a log scale (|log2|), the difference of modulus and the cores of
 * one side only. Returns [{record, score, reason}], the reason in French.
 */
export function similarParts(history, part, { k = 5 } = {}) {
  const ranked = history.map((record) => {
    const reasons = [];
    let distance = 0;
    const sameIsland = !!part.ilot && record.ilot === part.ilot;
    if (part.ilot) reasons.push(sameIsland ? `même îlot (${record.ilot})` : `autre îlot (${record.ilot})`);
    if (isPositive(part.poids_kg) && isPositive(record.poids_kg)) {
      const ratio = record.poids_kg / part.poids_kg;
      distance += Math.abs(Math.log2(ratio));
      reasons.push(`poids ${fr(record.poids_kg, 3)} kg (× ${fr(ratio, 2)})`);
    }
    if (isPositive(part.module_mm)) {
      if (isPositive(record.module_mm)) {
        const d = record.module_mm - part.module_mm;
        distance += Math.abs(d) / MODULE_STEP;
        reasons.push(`module ${fr(record.module_mm, 2)} mm (${d < 0 ? "−" : "+"}${fr(Math.abs(d), 2)} mm)`);
      } else {
        distance += UNKNOWN_MODULE;
        reasons.push("module inconnu");
      }
    }
    if (typeof part.noyaux === "boolean" && typeof record.noyaux === "boolean") {
      if (record.noyaux !== part.noyaux) distance += CORES_MISMATCH;
      reasons.push(record.noyaux === part.noyaux ? (record.noyaux ? "avec noyaux, comme la pièce" : "sans noyau, comme la pièce") : record.noyaux ? "avec noyaux, pas la pièce" : "sans noyau, la pièce en a");
    }
    return { record, score: 1 / (1 + distance), sameIsland, reason: reasons.join(" ; ") };
  });
  ranked.sort((a, b) => (a.sameIsland !== b.sameIsland ? (a.sameIsland ? -1 : 1) : b.score - a.score));
  return ranked.slice(0, Math.max(0, k)).map(({ record, score, reason }) => ({ record, score, reason }));
}

/**
 * The record "production" of a piece of the quote (ui.js:computePiece result
 * `r`, with its retained route) and its real cycle time `tempsCycle` (s):
 * the geometry of the 3D model or typed in, and the island, pieces per cycle,
 * TRS and mise au mille of the quote. ref: the reference of the quote.
 */
export function productionRecord(r, { ref, tempsCycle, fichier = null, serie = null, date = new Date().toISOString() }) {
  const casting = r.route.operations.find((o) => o.code === r.route.process);
  const { record } = checkRecord({
    ref,
    fichier_3d: fichier,
    source: "production",
    ilot: r.route.process,
    temps_cycle_s: tempsCycle,
    pieces_par_cycle: casting?.parCycle,
    trs: casting?.trs,
    poids_kg: r.part.poids,
    module_mm: r.part.moduleMm || null,
    volume_cm3: r.piece.volume ? r.piece.volume / 1000 : null,
    surface_cm2: r.piece.area ? r.piece.area / 100 : null,
    encombrement_mm: r.piece.bboxSize ?? null,
    noyaux: r.part.noyaux,
    sable_kg: r.part.noyaux ? r.part.sableKg : null,
    serie,
    mise_au_mille: r.route.miseAuMille,
    toile_mini_mm: r.part.toileMini || null,
    epaisseur_max_mm: r.part.epaisseurMax || null,
    date,
  });
  return record;
}
