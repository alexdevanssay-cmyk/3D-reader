// The costing as the AI page sends it to a language model (task "Chiffrage",
// web/ai-workspace.js), from the read-only snapshot of ui.js:costingSnapshot:
// each traced value reduced to what a model needs to explain it, made
// smaller to fit the window of a local model, its internal amounts masked
// for a model on the Internet (unless the user agrees); and the check of the
// numbers of an answer against what the model was given. The model explains,
// it never sets a value: nothing here leads back to the quote or the
// settings. Pure functions, no DOM.

import { ALERTES, SOURCES, label, pieceKeys } from "./provenance.js";
import { numbersOf, unknownNumbers } from "../engine/ai-context.js";

// How numbers are read in a text, shared with the check of the other tasks of the AI page.
export { numbersOf };

export const MASQUE = "masqué";

// The values of a quote a model needs first (the others are kept while they
// fit), and of each piece: main, short and brief lists (code: its island).
const MAIN_QUOTE = [
  "devis.alliage", "devis.densite", "devis.volumeTotal", "devis.tailleSerie", "devis.marge", "devis.metal.prixVente", "devis.metal.prixAchat", "devis.rebutUsinage",
  "ensemble.poids", "ensemble.miseAuMille", "ensemble.prix.vente",
];
const PIECE_KEYS = {
  main: (code) => pieceKeys(code).filter((k) => !/^piece\.(toileMini|epaisseurMax|module|dimMax)$|\.mode$/.test(k)),
  short: (code) => ["piece.poids", "piece.ilot", "piece.cycle", `centre.${code}.trs`, "piece.va", "piece.outillage.total", "piece.prix.vente"],
  brief: () => ["piece.poids", "piece.ilot", "piece.prix.vente"],
};

/**
 * Internal amounts, masked for the AI gateway unless the user agrees: every
 * amount in euros (rates, costs, prices, metal prices, tooling), the margins,
 * the losses on melting and the TRS of the centres.
 */
export const isInternal = (cle, unite = "") =>
  unite.includes("€") || /^(devis\.marge|parametres\.tauxMini|devis\.metal\.paf(Achat|Vente)|centre\.[^.]+\.(trs|taux))$/.test(cle);

/** The numbers of a text replaced by "…" (the dates kept). */
export function maskNumbers(text) {
  const s = String(text ?? "");
  let out = "";
  let at = 0;
  for (const n of numbersOf(s)) {
    out += `${s.slice(at, n.index)}…`;
    at = n.index + n.texte.length;
  }
  return out + s.slice(at);
}

// --------------------------------------------------------------------------- the trace sent

// Numbers sent with six significant digits (two decimals above 100).
const round = (v) => (typeof v !== "number" || !Number.isFinite(v) ? v ?? null : Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Number(v.toPrecision(6)));
const percent = (v) => (typeof v === "number" && Number.isFinite(v) ? round(v * 100) : null);
const sourceName = (s) => `${SOURCES[s.type]?.label ?? s.type}${s.fichier ? ` « ${s.fichier} »` : ""}`;
// The field of the customer request, the estimate of the AI: by their reference.
const altName = (a) => ((a.source === "rfq" || a.source === "ia") && a.ref ? a.ref : SOURCES[a.source]?.label ?? a.source);

/**
 * One traced value for a model: its value (unit "%": in percent), unit,
 * source, authority, confidence, deviation from the trend, other sources,
 * whether a person must validate it; with `detail`, the file of its source,
 * its label, reference, inputs, the reason of its confidence and its
 * hypotheses. Masked: an internal amount ("masqué"), its deviations kept in
 * percent.
 */
function valueForAI(cle, t, { detail, mask }) {
  const pct = t.unite === "%";
  const hidden = mask && isInternal(cle, t.unite);
  const text = (s) => (hidden ? maskNumbers(s) : s);
  const num = (v) => (hidden && v !== null && v !== undefined ? MASQUE : typeof v === "number" && pct ? percent(v) : round(v));
  const out = { valeur: num(t.valeur), ...(t.unite ? { unite: t.unite } : {}), source: detail ? sourceName(t.source) : SOURCES[t.source.type]?.label ?? t.source.type, autorite: t.autorite, confiance: t.confiance.niveau };
  if (detail) {
    out.libelle = label(cle);
    out.ref = t.source.ref;
    if (t.source.entrees?.length) out.entrees = t.source.entrees;
    out.raison = text(t.confiance.raison);
    if (t.hypotheses.length) out.hypotheses = t.hypotheses.map(text);
  }
  const e = t.ecart_tendance;
  if (e) {
    // A group of settings: the deviation of one of them (chemin), an amount of the settings: masked too.
    const masked = hidden || (mask && !!e.chemin);
    out.ecart_tendance = { ...(masked ? {} : { tendance: e.chemin ? round(e.tendance) : num(e.tendance) }), ecart_pct: percent(e.ecart_rel), alerte: e.alerte, ...(e.chemin ? { chemin: e.chemin } : {}) };
  }
  if (t.alternatives.length) out.autres_sources = t.alternatives.map((a) => ({ source: altName(a), ...(hidden ? {} : { valeur: num(a.valeur) }), ecart_pct: percent(a.ecart_rel) }));
  if (t.validation_requise) out.a_valider = true;
  return out;
}

const valuesForAI = (trace, keys, opts) => Object.fromEntries(Object.entries(trace ?? {}).filter(([cle]) => !keys || keys.includes(cle)).map(([cle, t]) => [cle, valueForAI(cle, t, opts)]));

// The levels of detail of the trace sent, the most detailed first, and what each one leaves out.
const LEVELS = [
  { detail: true },
  { omis: "fichiers des sources de chaque valeur, libellés, références, entrées, raisons de la confiance et hypothèses" },
  { keys: "main", message: 120, omis: "valeurs secondaires (seules les principales sont données), raisons du classement des îlots, fin des messages d'alerte longs" },
  { keys: "main", message: 120, alertes: 10, routes: false, omis: "classement des îlots, alertes au-delà des 10 premières" },
  { keys: "short", message: 120, alertes: 8, routes: false, omis: "valeurs des pièces autres que poids, îlot, cycle, TRS, VA, outillage et prix de vente" },
  { keys: "brief", message: 120, alertes: 5, routes: false, pieces: 12, omis: "valeurs des pièces autres que poids, îlot et prix de vente, pièces au-delà des 12 premières (comptées dans autres_pieces)" },
];

/**
 * The costing trace a model is given (context field costing_trace), from a
 * snapshot of ui.js:costingSnapshot; null without one (no costing workbook).
 *   mask: internal amounts masked (isInternal), for the AI gateway;
 *   maxChars: the largest size of its JSON, for a local model: the levels of
 *   LEVELS in turn, until it fits. What was left out is listed in
 *   `compaction`, so that the model knows the trace is partial.
 */
export function traceForAI(snapshot, { mask = false, maxChars = Infinity } = {}) {
  if (!snapshot) return null;
  // An alert shared by several pieces once, with the first of them and how many others.
  const PIECES = 5;
  const alertes = snapshot.alertes.map((a) => ({
    ...(a.pieces?.length ? { pieces: a.pieces.slice(0, PIECES), ...(a.pieces.length > PIECES ? { autres_pieces: a.pieces.length - PIECES } : {}) } : {}),
    cle: a.cle, type: ALERTES[a.type] ?? a.type, message: mask && isInternal(a.cle, unitOf(snapshot, a)) ? maskNumbers(a.message) : a.message,
  }));
  const build = (n) => {
    const level = LEVELS[n];
    const opts = { detail: !!level.detail, mask };
    const routes = (p) => p.routes.map(({ raisons, famille, ...r }) => ({
      ...r, ...(level.keys ? {} : { famille }), prix: mask && r.prix !== null ? MASQUE : round(r.prix), qualite: round(r.qualite), ...(level.keys ? {} : { raisons }),
    }));
    const pieces = snapshot.pieces.slice(0, level.pieces ?? Infinity).map((p) => ({
      nom: p.nom,
      chiffree: p.chiffree,
      valeurs: valuesForAI(p.trace, level.keys ? PIECE_KEYS[level.keys](p.trace["piece.ilot"]?.valeur) : null, opts),
      ...(level.routes === false ? {} : { routes: routes(p) }),
    }));
    const cut = (m) => (level.message && m.length > level.message ? `${m.slice(0, level.message - 1)}…` : m);
    const shown = alertes.slice(0, level.alertes ?? Infinity).map((a) => ({ ...a, message: cut(a.message) }));
    const omis = LEVELS.slice(1, n + 1).map((l) => l.omis);
    return {
      schema: "3d-reader-costing-trace",
      schema_version: "1.0",
      lecture_seule: true,
      note: "Valeurs du devis en cours, chacune avec sa trace (source, autorité, confiance, écart à la tendance, validation requise). Unité « % » : valeur en pourcentage, non en fraction. Aucune valeur n'est appliquée depuis l'IA.",
      ...(mask ? { masque: "montants internes masqués (taux, coûts, prix, marges, pertes au feu, TRS) : seuls leurs sources et leurs écarts relatifs sont donnés" } : {}),
      resume: snapshot.resume,
      fichiers: snapshot.fichiers,
      devis: { ensemble: snapshot.devis.ensemble, valeurs: valuesForAI(snapshot.devis.trace, level.keys ? MAIN_QUOTE : null, opts) },
      pieces,
      ...(snapshot.pieces.length > pieces.length ? { autres_pieces: snapshot.pieces.length - pieces.length } : {}),
      alertes: shown,
      ...(alertes.length > shown.length ? { autres_alertes: alertes.length - shown.length } : {}),
      ...(omis.length ? { compaction: { niveau: n + 1, omis } } : {}),
    };
  };
  let out;
  for (let n = 0; n < LEVELS.length; n++) {
    out = build(n);
    if (JSON.stringify(out).length <= maxChars) break;
  }
  return out;
}

/** The unit of the value an alert is about (of its first piece; none: of the quote). */
function unitOf(snapshot, a) {
  const trace = a.pieces?.length ? snapshot.pieces.find((p) => p.nom === a.pieces[0])?.trace : snapshot.devis.trace;
  return trace?.[a.cle]?.unite ?? "";
}

// --------------------------------------------------------------------------- the check of an answer

// Fields of the trace sent that describe it, not the quote: their numbers are not values.
const ABOUT = new Set(["schema", "schema_version", "note", "masque", "compaction"]);

/** Every number the trace `trace` gives (its values, and the numbers of its texts), as absolute values. */
function knownNumbers(trace) {
  const known = [];
  (function walk(v, pct) {
    if (typeof v === "number" && Number.isFinite(v)) {
      known.push(Math.abs(v));
      if (pct) known.push(Math.abs(v) / 100); // a percentage also written as a fraction
    } else if (typeof v === "string") known.push(...numbersOf(v).map((n) => Math.abs(n.valeur)));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, pct));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (!ABOUT.has(k)) walk(x, pct || v.unite === "%" || k === "ecart_pct");
    }
  })(trace, false);
  return known;
}

/**
 * The numbers of an answer that the trace sent (`trace`, costing_trace) does
 * not give, to its rounding: {verifiee, nombres (count), inconnus (as
 * written)}. One is enough for the answer to be "non vérifiée".
 */
export function checkNumbers(text, trace) {
  const { nombres, inconnus } = unknownNumbers(text, knownNumbers(trace));
  return { verifiee: !inconnus.length, nombres, inconnus };
}
