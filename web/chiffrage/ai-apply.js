// The values of the costing the AI may propose for one piece of the quote
// (task "Chiffrage" of the IA page, web/ai-workspace.js), read and checked
// before a person applies them (ui.js applyAIValues): only the inputs of a
// piece, never a price, a rate, a setting nor a value of the whole quote;
// each number proposed read in the user's messages, the costing trace or the
// analysis of the part sent (never one the model computed); the piece found by
// its name in the trace sent. The model proposes, a person applies: the
// values are then the piece's inputs ("saisie"), marked as applied from the
// AI, and can be undone. Pure functions, no DOM.

import { checkContextNumbers } from "../engine/ai-context.js";

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
    const read = field ? proposalValue(field, p.valeur) : { refus: "valeur que l'IA ne peut pas proposer (prix, taux, paramètre ou valeur du devis entier)" };
    const refus = read.refus ?? (index < 0 ? `pièce « ${piece} » absente du chiffrage envoyé` : null);
    return {
      piece: index >= 0 ? pieces[index].nom : piece,
      index,
      cle,
      ...(field ? { champ: field.champ } : {}),
      valeur: read.refus ? (p.valeur ?? null) : read.valeur,
      ...(mode ? { ilot_mode: mode[1] } : {}),
      unite: text(p.unite) || field?.unite || "",
      source: PROPOSAL_SOURCES.includes(text(p.source)) ? text(p.source) : "",
      justification: text(p.justification),
      refus,
    };
  });
}

/**
 * The proposals not refused whose numbers come from the data: each number
 * proposed must be in the user's messages (`asked`), the costing trace or
 * the analysis of the part sent (`sent`, the context of the question), to the
 * rounding it is written with; one the model computed is refused ("nombre
 * absent des données"). Codes and yes / no are checked when applied.
 */
export function checkProposals(proposals, sent, asked = []) {
  return proposals.map((p) => {
    if (p.refus || typeof p.valeur !== "number") return p;
    const { inconnus } = checkContextNumbers(String(p.valeur), sent ?? {}, asked);
    return inconnus.length ? { ...p, refus: "nombre absent des données envoyées et de vos messages" } : p;
  });
}

/** Two values of an input equal for an application: numbers within the rounding of the trace sent (6 significant digits). */
export function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 5e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-9) + 1e-12;
  return (a ?? null) === (b ?? null);
}

/** A value of an input as the page writes it: "1,35 kg", "oui", "CG3". */
export function valueLabel(v, unite = "") {
  if (v === null || v === undefined || v === "") return "vide (valeur du modèle 3D ou estimée)";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "number") return `${v.toLocaleString("fr-FR", { maximumFractionDigits: 4 })}${unite ? ` ${unite}` : ""}`;
  return String(v);
}
