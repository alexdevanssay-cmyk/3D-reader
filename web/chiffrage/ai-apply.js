// The values of the costing the AI may propose for one piece of the quote
// (task "Chiffrage" of the IA page, web/ai-workspace.js), read and checked
// before a person applies them (ui.js applyAIValues): only the inputs of a
// piece, never a price, a rate, a setting nor a value of the whole quote;
// each number proposed read in the user's messages, the costing trace or the
// analysis of the part sent (never one the model computed); the piece found by
// its name in the trace sent. The model proposes, a person applies: the
// values are then the piece's inputs ("saisie"), marked as applied from the
// AI, and can be undone. Pure functions, no DOM.

import { numbersOf } from "../engine/ai-context.js";

/**
 * Key of a proposal → the input of the piece it sets (q.pieces[key]): its
 * kind, unit and bounds, its label; `ilot`: used only with the island
 * imposed (the values of an estimated route are its own).
 */
export const PROPOSAL_FIELDS = {
  "piece.poids": { champ: "poids", type: "number", unite: "kg", above: 0, label: "poids pièce" },
  "piece.toileMini": { champ: "toileMini", type: "number", unite: "mm", above: 0, label: "toile mini" },
  "piece.epaisseurMax": { champ: "epaisseurMax", type: "number", unite: "mm", above: 0, label: "épaisseur maxi / point chaud" },
  "piece.module": { champ: "moduleMm", type: "number", unite: "mm", above: 0, label: "module V/S" },
  "piece.dimMax": { champ: "dimMax", type: "number", unite: "mm", above: 0, label: "plus grande dimension" },
  "piece.ilot": { champ: "procede", type: "ilot", label: "procédé / îlot" },
  "piece.finition": { champ: "finition", type: "finition", label: "finition" },
  "piece.miseAuMille": { champ: "miseAuMille", type: "number", unite: "kg/kg", min: 1, max: 10, ilot: true, label: "mise au mille" },
  "piece.empreintes": { champ: "empreintes", type: "integer", min: 1, max: 64, ilot: true, label: "empreintes / pièces par cycle" },
  "piece.cycle": { champ: "cycle", type: "number", unite: "s", above: 0, max: 3600, ilot: true, label: "temps de cycle" },
  "piece.mode": { champ: "mode", type: "mode", ilot: true, label: "fonctionnement" },
  "piece.tth": { champ: "tth", type: "tth", label: "traitement thermique" },
  "piece.tthMode": { champ: "tthMode", type: "enum", values: ["scie", "masselotte"], label: "poids traité" },
  "piece.noyaux": { champ: "noyaux", type: "boolean", label: "noyaux sable" },
  "piece.tribo": { champ: "tribo", type: "boolean", label: "tribofinition" },
  "piece.redressage": { champ: "redressage", type: "boolean", label: "redressage" },
  "piece.outillage.tiroirs": { champ: "outillageTiroirs", type: "integer", min: 0, max: 20, label: "tiroirs du moule" },
  "piece.outillage.complexite": { champ: "outillageComplexite", type: "complexite", label: "complexité du moule" },
};

// The keys the model may propose (the schema of the gateway, api/ai.js, lists the same).
export const PROPOSAL_KEYS = Object.keys(PROPOSAL_FIELDS);

// Where a proposed value comes from, as the model says it.
export const PROPOSAL_SOURCES = ["question", "trace", "analyse_3d"];

// The units a value may be written in, by the unit of its input: their factor to it.
const UNITS = {
  kg: { kg: 1, g: 0.001, t: 1000 },
  mm: { mm: 1, cm: 10, m: 1000 },
  s: { s: 1, min: 60, h: 3600 },
  "kg/kg": { "kg/kg": 1 },
};
const UNIT_NAMES = { sec: "s", seconde: "s", secondes: "s", mn: "min", minute: "min", minutes: "min", heure: "h", heures: "h", gramme: "g", grammes: "g", kilo: "kg", kilos: "kg", kilogramme: "kg", kilogrammes: "kg", tonne: "t", tonnes: "t" };
const unitOf = (u) => {
  const s = text(u).toLowerCase().replace(/\s+/g, "");
  return UNIT_NAMES[s] ?? s;
};

const text = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));

/** A number written by a model: 1.35, "1,35", "1 350". NaN when it is none. */
function numberOf(v) {
  if (typeof v === "number") return v;
  const s = text(v).replace(/[\s  ]/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/**
 * The value of a proposal in the type of its input, or {refus} saying why
 * it cannot be: a number within its bounds, a whole number, yes or no, or a
 * code (checked against the settings when applied).
 */
export function proposalValue(field, raw) {
  if (field.type === "number" || field.type === "integer") {
    const v = numberOf(raw);
    if (!Number.isFinite(v)) return { refus: "pas un nombre" };
    if (field.type === "integer" && !Number.isInteger(v)) return { refus: "nombre entier attendu" };
    if (field.above !== undefined && !(v > field.above)) return { refus: `nombre > ${field.above} attendu` };
    if (field.min !== undefined && v < field.min) return { refus: `nombre ≥ ${field.min} attendu` };
    if (field.max !== undefined && v > field.max) return { refus: `nombre ≤ ${field.max} attendu` };
    return { valeur: v };
  }
  if (field.type === "boolean") {
    const s = text(raw).toLowerCase();
    if (raw === true || ["oui", "true", "vrai"].includes(s)) return { valeur: true };
    if (raw === false || ["non", "false", "faux"].includes(s)) return { valeur: false };
    return { refus: "oui ou non attendu" };
  }
  const s = text(raw);
  if (!s) return { refus: "valeur vide" };
  if (field.type === "enum" && !field.values.includes(s)) return { refus: `${field.values.join(" ou ")} attendu` };
  return { valeur: s };
}

/**
 * The proposals of an answer (analyse_chiffrage.propositions of the gateway,
 * or the JSON block that ends an answer of the local model), read against
 * the trace sent (`trace`, costing_trace): [{piece, index (of the piece in
 * the trace, -1: not found), cle, champ, valeur, unite, source,
 * justification, refus}], at most 20. "centre.<code>.mode" is the piece's
 * fonctionnement, on that island. A proposal with `refus` is shown, never
 * applied.
 */
export function readProposals(list, trace) {
  if (!Array.isArray(list)) return [];
  const pieces = Array.isArray(trace?.pieces) ? trace.pieces : [];
  return list.slice(0, 20).filter((p) => p && typeof p === "object").map((p) => {
    const mode = /^centre\.([^.]+)\.mode$/.exec(text(p.cle));
    const cle = mode ? "piece.mode" : text(p.cle);
    const field = PROPOSAL_FIELDS[cle];
    const piece = text(p.piece);
    let index = pieces.findIndex((x) => x.nom === piece);
    if (index < 0 && pieces.length === 1 && !piece) index = 0;
    // A number in another unit of its kind (g, t, cm, m, min, h): converted to the unit of the input; another unit: refused.
    const unit = unitOf(p.unite);
    const factor = !field?.unite || !unit ? 1 : UNITS[field.unite]?.[unit];
    const written = numberOf(p.valeur);
    const converted = factor !== undefined && Number.isFinite(written) && factor !== 1 ? written * factor : p.valeur;
    const read = !field
      ? { refus: "valeur que l'IA ne peut pas proposer (prix, taux, paramètre ou valeur du devis entier)" }
      : factor === undefined ? { refus: `unité « ${text(p.unite)} » : ${field.unite} attendu` } : proposalValue(field, converted);
    const refus = read.refus ?? (index < 0 ? `pièce « ${piece} » absente du chiffrage envoyé` : null);
    return {
      piece: index >= 0 ? pieces[index].nom : piece,
      index,
      cle,
      ...(field ? { champ: field.champ } : {}),
      valeur: read.refus ? (p.valeur ?? null) : read.valeur,
      // As the model wrote it, for its check against the user's messages.
      ...(Number.isFinite(written) && factor !== undefined && factor !== 1 ? { ecrit: { valeur: written, unite: unit } } : {}),
      ...(mode ? { ilot_mode: mode[1] } : {}),
      unite: field?.unite || text(p.unite) || "",
      source: PROPOSAL_SOURCES.includes(text(p.source)) ? text(p.source) : "",
      justification: text(p.justification),
      refus,
    };
  });
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);

/** A number the user wrote (`said`: numbersOf of their messages), as written or in another unit of the input's kind. */
function fromQuestion(p, field, said) {
  const factors = Object.values(UNITS[field.unite] ?? { "": 1 });
  for (const n of said) {
    for (const f of factors) if (close(n.valeur * f, p.valeur)) return n.valeur * f;
    // Converted by the model from the unit the user wrote in: the number as the model wrote it.
    if (p.ecrit && close(n.valeur, p.ecrit.valeur)) return p.valeur;
  }
  return null;
}

/** The value of the same key for the same piece in the trace sent (its value or another source's), as it was sent. */
function fromTrace(p, trace) {
  const t = trace?.pieces?.[p.index]?.valeurs?.[p.cle];
  const values = [t?.valeur, ...(t?.autres_sources ?? []).map((a) => a.valeur)].filter((v) => typeof v === "number");
  return values.find((v) => sameValue(v, p.valeur)) ?? null;
}

/** The measure of the analysis of the part sent that gives this input (its size, modulus, wall thicknesses), as sent. */
function fromAnalysis(p, sent) {
  const bodies = Array.isArray(sent?.bodies) ? sent.bodies : [];
  const measures = bodies.flatMap((b) => {
    const m = b.metrics ?? {};
    const size = m.bbox_mm?.size ?? m.bbox_size_mm;
    const thickness = b.foundry?.evidence?.thickness ?? b.foundry?.thickness ?? {};
    return {
      "piece.dimMax": Array.isArray(size) ? [Math.max(...size)] : [],
      "piece.module": m.volume_mm3 > 0 && m.surface_area_mm2 > 0 ? [m.volume_mm3 / m.surface_area_mm2] : [],
      "piece.toileMini": [thickness.min_mm, b.manufacturing?.functional_thickness?.minimum_wall_thickness_mm],
      "piece.epaisseurMax": [thickness.max_mm],
    }[p.cle] ?? [];
  }).filter((v) => typeof v === "number" && v > 0);
  // The analysis sent rounds to the thousandth: within half a thousandth, or 0.1 %.
  return measures.find((v) => Math.abs(v - p.valeur) <= Math.max(5e-4, 1e-3 * v)) ?? null;
}

const NOT_FOUND = {
  question: "nombre absent de vos messages",
  trace: "valeur absente de la trace de cette pièce pour cette clé",
  analyse_3d: "mesure absente de l'analyse de la pièce pour cette clé",
};

/**
 * The proposals not refused whose numbers come from the source they claim,
 * for their own key: a number the user wrote in their messages (`asked`, as
 * written or in another unit of the input's kind), the value of that key for
 * that piece in the costing trace sent (`sent.costing_trace`, its value or
 * another source's), or the measure of the part sent that gives that input
 * (size, modulus, wall thicknesses); the value applied is the one found, not
 * the model's. One the model computed, or found elsewhere, is refused. Codes
 * and yes / no are checked when applied.
 */
export function checkProposals(proposals, sent, asked = []) {
  const said = asked.flatMap((q) => numbersOf(q));
  return proposals.map((p) => {
    if (p.refus || typeof p.valeur !== "number") return p;
    const field = PROPOSAL_FIELDS[p.cle];
    const found = p.source === "question" ? fromQuestion(p, field, said)
      : p.source === "trace" ? fromTrace(p, sent?.costing_trace)
        : p.source === "analyse_3d" ? fromAnalysis(p, sent) : null;
    if (found === null) return { ...p, refus: NOT_FOUND[p.source] ?? "source du nombre non indiquée (question, trace ou analyse_3d)" };
    return { ...p, valeur: found };
  });
}

/**
 * Two values of an input equal for an application: numbers within the
 * rounding of the trace sent (ai-trace.js: 6 significant digits, 2 decimals
 * from 100), so that a value read in the trace changes nothing.
 */
export function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const m = Math.max(Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= (m >= 100 ? 0.005 : 5e-6 * Math.max(m, 1e-9)) + 1e-12;
  }
  return (a ?? null) === (b ?? null);
}

/** A value of an input as the page writes it: "1,35 kg", "oui", "CG3". */
export function valueLabel(v, unite = "") {
  if (v === null || v === undefined || v === "") return "vide (valeur du modèle 3D ou estimée)";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "number") return `${v.toLocaleString("fr-FR", { maximumFractionDigits: 4 })}${unite ? ` ${unite}` : ""}`;
  return String(v);
}
