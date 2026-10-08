// Traced values of the costing (docs/chiffrage-source-de-verite.md, § 5): each
// output of a quote with its value, where it comes from, its authority in the
// hierarchy of the sources, the confidence it deserves, its deviation from
// the trend, the other sources available, and whether a person must validate
// it. Built after the computation, from the values it used: tracing never
// changes a value. Pure functions, no DOM.
//
// Hierarchy of the sources, decided by the foundry:
//   1. hard            customer order (RFQ imported), values typed in the quote
//   2. hard            current rules: Paramètres, costing workbook, metal indices
//   3. evidence        3D geometry (measured)
//   4. soft_prior      trends (the calibrated settings file): never above 1 or 2
//   5. reasoning_only  the LLM: it explains, it never sets a value; an
//                      estimate of it (the cycle time, ai-cycle.js) enters a
//                      quote only once a person adopts it: then a value typed
//                      in (1), "estimation IA validée"
// Out of the hierarchy: default_code (a neutral value of the code: a
// hypothesis to validate) and calcul (a value derived from others, as
// confident as its weakest input).

import { DEFAULT_TRS } from "./routes.js";
import { bandOf } from "./tooling.js";
import { programmeOf } from "./rfq.js";
import { defaultQuote } from "./store.js";
import { adoptedEstimate } from "./ai-cycle.js";

/**
 * @typedef {Object} ValeurTracee
 * @property {number|string|boolean|null} valeur   unit "%": a fraction (0.12 = 12 %)
 * @property {string} unite
 * @property {{type: string, ref: string, fichier?: string, date?: string, entrees?: string[]}} source
 *           type: a key of SOURCES; entrees: the keys of the inputs of a value computed
 * @property {'hard'|'evidence'|'soft_prior'|'default_code'|'calcul'} autorite
 * @property {1|2|3|4|null} niveau   level in the hierarchy
 * @property {{niveau: 'haute'|'moyenne'|'faible'|'nulle', raison: string}} confiance
 * @property {{tendance, ecart_abs, ecart_rel, seuil, alerte, chemin?}|null} ecart_tendance
 * @property {Array<{source: string, autorite: string, ref: string, valeur: any, ecart_rel: number|null}>} alternatives
 *           the other sources that have a value, not retained
 * @property {string[]} hypotheses
 * @property {Array<{type: string, message: string}>} alertes   type: a key of ALERTES
 * @property {boolean} validation_requise
 */

// The types of source: authority, level, confidence by default.
export const SOURCES = {
  saisie: { autorite: "hard", niveau: 1, confiance: "haute", label: "saisie du devis", raison: "saisie dans le devis" },
  rfq: { autorite: "hard", niveau: 1, confiance: "haute", label: "demande client", raison: "commande du client (demande importée)" },
  ia_validee: { autorite: "hard", niveau: 1, confiance: "moyenne", label: "estimation IA validée", raison: "estimation d'un modèle de langage validée par une personne : à confirmer par une mesure en production" },
  parametres: { autorite: "hard", niveau: 2, confiance: "haute", label: "saisie Paramètres", raison: "saisie dans Paramètres" },
  classeur: { autorite: "hard", niveau: 2, confiance: "haute", label: "classeur", raison: "classeur de chiffrage" },
  indices: { autorite: "hard", niveau: 2, confiance: "haute", label: "indices", raison: "fichier des indices matière" },
  geometrie: { autorite: "evidence", niveau: 3, confiance: "haute", label: "géométrie 3D", raison: "mesure sur le modèle 3D" },
  tendance: { autorite: "soft_prior", niveau: 4, confiance: "moyenne", label: "tendance", raison: "tendance des devis passés (fichier de paramètres calés)" },
  ia: { autorite: "reasoning_only", niveau: 5, confiance: "nulle", label: "IA", raison: "raisonnement d'un modèle de langage : jamais une valeur" },
  defaut_code: { autorite: "default_code", niveau: null, confiance: "faible", label: "défaut du code", raison: "valeur par défaut du code (neutre, à ajuster)" },
  calcul: { autorite: "calcul", niveau: null, confiance: "haute", label: "calcul", raison: "calcul" },
};

// Alerts, and those that ask for a validation by a person (a deviation from
// the trend is shown, not to validate: the current value stays the rule).
export const ALERTES = {
  defaut_code: "défaut du code",
  repli_zero: "repli à 0",
  valeur_manquante: "valeur manquante",
  ecart_tendance: "écart à la tendance",
  divergence: "sources divergentes",
  infaisable: "îlot infaisable",
  saisie_ignoree: "saisie ignorée",
  ecart_demande: "écart à la demande client",
};
const TO_VALIDATE = new Set(["defaut_code", "repli_zero", "valeur_manquante", "divergence", "infaisable", "saisie_ignoree", "ecart_demande"]);

// Deviation from the trend above which an alert is raised (setting seuilTendance).
export const SEUIL_TENDANCE = 0.15;

const LEVELS = ["nulle", "faible", "moyenne", "haute"];
const rank = (level) => LEVELS.indexOf(level);

/** The weakest of the confidence levels. */
export const weakest = (...levels) => levels.filter(Boolean).reduce((a, b) => (rank(b) < rank(a) ? b : a), "haute");

const hasValue = (v) => v !== null && v !== undefined && v !== "" && !(typeof v === "number" && !Number.isFinite(v));
const fr = (v, digits = 3) => v.toLocaleString("fr-FR", { maximumFractionDigits: digits });
const signedPct = (v) => v.toLocaleString("fr-FR", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
const day = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("fr-FR") : "");
const show = (v, unite) => (typeof v !== "number" ? String(v) : unite === "%" ? `${fr(v * 100, 2)} %` : `${fr(v)}${unite ? ` ${unite}` : ""}`);
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const list = (items, max = 6) => `${items.slice(0, max).join(", ")}${items.length > max ? ` et ${items.length - max} autre${items.length - max > 1 ? "s" : ""}` : ""}`;

function alert(t, type, message) {
  if (!t.alertes.some((a) => a.type === type && a.message === message)) t.alertes.push({ type, message });
}

const needsValidation = (t) =>
  t.autorite === "soft_prior" || t.autorite === "default_code" || rank(t.confiance.niveau) <= rank("faible") || t.alertes.some((a) => TO_VALIDATE.has(a.type));

/**
 * A traced value of a source of type `type` (SOURCES). A value of the code
 * by default gets its alert unless the caller gives its own.
 *   opts: {type, unite, ref, fichier, date, entrees, confiance, raison,
 *          hypotheses, alertes, validation (forced)}
 */
export function traced(valeur, { type, unite = "", ref = "", fichier, date, entrees, confiance, raison, hypotheses = [], alertes = [], validation } = {}) {
  const s = SOURCES[type];
  if (!s) throw new Error(`type de source inconnu : ${type}`);
  const t = {
    valeur: hasValue(valeur) ? valeur : null,
    unite,
    source: { type, ref, ...(fichier ? { fichier } : {}), ...(date ? { date } : {}), ...(entrees ? { entrees } : {}) },
    autorite: s.autorite,
    niveau: s.niveau,
    confiance: { niveau: confiance ?? s.confiance, raison: raison ?? s.raison },
    ecart_tendance: null,
    alternatives: [],
    hypotheses: [...hypotheses],
    alertes: alertes.map((a) => ({ ...a })),
    validation_requise: false,
  };
  if (s.autorite === "default_code" && !t.alertes.length) alert(t, "defaut_code", "valeur par défaut du code (neutre) là où une valeur de l'entreprise est attendue");
  t.validation_requise = validation ?? needsValidation(t);
  return t;
}

/** No source has a value: null, confidence nil, an alert. */
export const missing = (unite, message, ref = "aucune source") =>
  traced(null, { type: "defaut_code", unite, ref, confiance: "nulle", raison: "aucune source n'a de valeur", alertes: [{ type: "valeur_manquante", message }] });

/** Deviation of `valeur` from `tendance`: {tendance, ecart_abs, ecart_rel, seuil, alerte}, or null (not numbers). */
export function ecart(valeur, tendance, seuil = SEUIL_TENDANCE) {
  if (typeof valeur !== "number" || typeof tendance !== "number") return null;
  const abs = valeur - tendance;
  const rel = tendance !== 0 ? abs / Math.abs(tendance) : abs === 0 ? 0 : null;
  return { tendance, ecart_abs: abs, ecart_rel: rel, seuil, alerte: rel === null ? abs !== 0 : Math.abs(rel) > seuil + 1e-12 };
}

const relative = (a, b) => (typeof a === "number" && typeof b === "number" ? (b !== 0 ? (a - b) / Math.abs(b) : a === 0 ? 0 : null) : null);
const differs = (a, b, seuil) => {
  if (typeof a === "number" && typeof b === "number") {
    const rel = relative(a, b);
    return rel === null ? a !== b : Math.abs(rel) > seuil + 1e-12;
  }
  return String(a).trim().toLowerCase() !== String(b).trim().toLowerCase();
};

/**
 * The value retained among `candidates` (traced values, in the order of the
 * registry: most authoritative first, so that the first one with a value is
 * the one the costing used): the first one with a value, except
 * that a trend (soft_prior) never wins over a hard candidate that has one,
 * and an answer of the LLM (reasoning_only) is never retained. The other
 * candidates with a value are kept as alternatives; a trend among them gives
 * ecart_tendance (alert above `seuil`); a candidate `comparer` accepts (by
 * default: hard or evidence) that differs by more than `seuil` gives a
 * "sources divergentes" alert. null when no candidate has a value.
 */
export function resolve(candidates, { seuil = SEUIL_TENDANCE, comparer = (c) => c.autorite === "hard" || c.autorite === "evidence" } = {}) {
  const usable = candidates.filter((c) => c && c.autorite !== "reasoning_only" && hasValue(c.valeur));
  let chosen = usable[0];
  const hard = chosen?.autorite === "soft_prior" ? usable.find((c) => c.autorite === "hard") : null;
  if (hard) chosen = hard;
  if (!chosen) return null;
  const t = { ...chosen, alternatives: [...chosen.alternatives], hypotheses: [...chosen.hypotheses], alertes: chosen.alertes.map((a) => ({ ...a })) };
  // Not expected (the layers of store.js keep a trend below a current value): said if it happens.
  if (hard) alert(t, "divergence", `tendance ${show(usable[0].valeur, usable[0].unite)} écartée : une tendance ne remplace jamais une valeur actuelle`);
  for (const c of usable) {
    if (c === chosen) continue;
    const gap = relative(t.valeur, c.valeur);
    t.alternatives.push({ source: c.source.type, autorite: c.autorite, ref: c.source.ref, valeur: c.valeur, ecart_rel: gap });
    if (c.autorite === "soft_prior") t.ecart_tendance ??= ecart(t.valeur, c.valeur, seuil);
    else if (comparer(c) && differs(t.valeur, c.valeur, seuil)) {
      alert(t, "divergence", `${c.source.ref || SOURCES[c.source.type].label} = ${show(c.valeur, c.unite)}${gap !== null ? ` (écart ${signedPct(gap)})` : ""}`);
    }
  }
  const e = t.ecart_tendance;
  if (e?.alerte) alert(t, "ecart_tendance", `${e.ecart_rel === null ? "écart" : `écart de ${signedPct(e.ecart_rel)}`} à la tendance (${show(e.tendance, t.unite)}), au-delà du seuil de ${signedPct(seuil).replace("+", "")}`);
  t.validation_requise ||= needsValidation(t);
  return t;
}

const WEAKEST = "entrée la plus faible : ";

/**
 * A value computed from others (`entrees`: {key: traced value}): source
 * "calcul" with the keys of its inputs, the confidence of the weakest input
 * (or `plafond` [level, reason] when lower: an estimate), a validation when
 * one of the inputs needs one. The reason follows the weakest inputs down to
 * the first one that is not computed ("piece.va ← parametres.operations (…)").
 */
export function derive(valeur, { entrees = {}, plafond = null, ...opts } = {}) {
  const inputs = Object.entries(entrees).filter(([, t]) => t);
  let [level, raison] = plafond ?? ["haute", "calcul exact à partir d'entrées en confiance haute"];
  for (const [cle, t] of inputs) {
    if (rank(t.confiance.niveau) >= rank(level)) continue;
    const below = t.confiance.raison;
    [level, raison] = [t.confiance.niveau, `${WEAKEST}${cle}${below.startsWith(WEAKEST) ? ` ← ${below.slice(WEAKEST.length)}` : ` (${below})`}`];
  }
  const t = traced(valeur, { type: "calcul", ...opts, entrees: inputs.map(([cle]) => cle), confiance: level, raison });
  t.validation_requise ||= inputs.some(([, x]) => x.validation_requise);
  return t;
}

/**
 * A setting (path "trs.CG3") traced from the layers of store.js: typed in
 * Paramètres, workbook, trend or default of the code; the trend, when a
 * current value is above it, as an alternative with its deviation. A value
 * typed in that may be a trend (taken over from the previous version, which
 * mixed inputs and the calibrated file; a trend adopted over the workbook):
 * to validate, with the workbook's value it is above as an alternative.
 *   ctx: {layers, base, seuil}
 */
export function fromSetting(ctx, path, { unite = "", hypotheses = [] } = {}) {
  const { layers, base } = ctx;
  const p = layers.provenance(path);
  const ref = `settings.${path}`;
  const t = layers.tendances;
  const fichier = base?.source?.fileName;
  const known = (v) => hasValue(v) && typeof v !== "object";
  const notUsed = p.trendIgnored ? ["tableau du fichier de tendances non utilisé ici : une ligne en est saisie dans Paramètres, sur un tableau d'un autre nombre de lignes"] : [];
  const adopted = p.source === "saisie" && p.from === "tendance";
  const migrated = p.source === "saisie" && p.migrated && !adopted;
  const instead = known(p.classeur) ? ` à la place de la valeur du classeur (${show(p.classeur, unite)})` : "";
  const typed = () => {
    if (adopted) {
      const what = `tendance${p.fileName ? ` du fichier « ${p.fileName} »` : ""} adoptée dans Paramètres${p.date ? ` le ${day(p.date)}` : ""}${instead}`;
      return traced(p.value, { type: "parametres", unite, ref, date: p.date, raison: what, hypotheses: [...hypotheses, what], validation: true });
    }
    if (migrated) {
      return traced(p.value, {
        type: "parametres", unite, ref, date: p.date, confiance: "moyenne", raison: "reprise de la version précédente : saisie ou fichier calé, indiscernables",
        hypotheses: [...hypotheses, "reprise des paramètres enregistrés par la version précédente"], validation: true,
      });
    }
    return traced(p.value, { type: "parametres", unite, ref, date: p.date, raison: `saisie dans Paramètres${p.date ? ` le ${day(p.date)}` : ""}`, hypotheses: [...hypotheses, ...notUsed] });
  };
  const chosen = {
    saisie: typed,
    classeur: () => traced(p.value, { type: "classeur", unite, ref, fichier: p.fileName ?? fichier, date: base?.source?.importedAt, hypotheses: [...hypotheses, ...notUsed] }),
    tendance: () => traced(p.value, { type: "tendance", unite, ref, fichier: p.fileName, date: p.date, hypotheses }),
    defaut: () => traced(p.value, { type: "defaut_code", unite, ref, hypotheses: [...hypotheses, ...notUsed] }),
  }[p.source]();
  const trend = p.source !== "tendance" && hasValue(p.trend) ? traced(p.trend, { type: "tendance", unite, ref, fichier: t?.fileName, date: t?.importedAt }) : null;
  const workbook = (adopted || migrated) && known(p.classeur) ? traced(p.classeur, { type: "classeur", unite, ref: `classeur : ${path}`, fichier, date: base?.source?.importedAt }) : null;
  const out = resolve([chosen, trend, workbook], { seuil: ctx.seuil }) ?? chosen;
  // Taken over, the same value as the trend: it came from the calibrated file, most likely, and is now above the workbook.
  if (migrated && hasValue(p.trend) && (typeof p.value === "object" ? JSON.stringify(p.trend) === JSON.stringify(p.value) : same(p.trend, p.value))) {
    alert(out, "divergence", `valeur reprise de la version précédente égale à la tendance${t?.fileName ? ` « ${t.fileName} »` : ""} : sans doute venue du fichier de paramètres calés, elle passe avant ${known(p.classeur) ? `le classeur (${show(p.classeur, unite)})` : "le classeur"} ; effacez-la dans Paramètres si c'est le cas`);
    out.validation_requise = true;
  }
  return out;
}

/**
 * The settings used by an estimate (the cycle coefficients of an island, the
 * rates and hours of the dies...), as one traced value: how many come from
 * each layer, the weakest one, the defaults of the code and the trends
 * exceeded among them.
 */
export function settingsGroup(ctx, paths, { label: what, ref }) {
  const items = [...new Set(paths)].map((path) => [path, fromSetting(ctx, path)]).filter(([, t]) => t.valeur !== null);
  const of = (type) => items.filter(([, t]) => t.source.type === type).map(([path]) => path);
  const order = ["defaut_code", "tendance", "classeur", "parametres"]; // the weakest layer present is the source of the group
  const type = order.find((x) => of(x).length) ?? "parametres";
  const counts = order.filter((x) => of(x).length).map((x) => `${of(x).length} ${SOURCES[x].label}`);
  const level = weakest(...items.map(([, t]) => t.confiance.niveau));
  const weak = items.find(([, t]) => t.confiance.niveau === level);
  const defaults = of("defaut_code");
  const file = { classeur: [ctx.base?.source?.fileName, ctx.base?.source?.importedAt], tendance: [ctx.layers.tendances?.fileName, ctx.layers.tendances?.importedAt] }[type] ?? [];
  const t = traced(items.length, {
    type,
    unite: "valeurs",
    ref,
    fichier: file[0],
    date: file[1],
    confiance: level,
    raison: level === "haute" || !weak ? "valeurs saisies dans Paramètres ou lues dans le classeur" : `la plus faible : ${weak[0]} (${weak[1].confiance.raison})`,
    hypotheses: [`${what} : ${counts.join(", ") || "aucune valeur"}`],
    alertes: defaults.length ? [{ type: "defaut_code", message: `${plural(defaults.length, "valeur")} par défaut du code (neutres, à ajuster) : ${list(defaults)}` }] : [],
  });
  const gaps = items.filter(([, x]) => x.ecart_tendance && x.ecart_tendance.ecart_rel !== null).sort(([, a], [, b]) => Math.abs(b.ecart_tendance.ecart_rel) - Math.abs(a.ecart_tendance.ecart_rel));
  if (gaps.length) t.ecart_tendance = { ...gaps[0][1].ecart_tendance, chemin: gaps[0][0] };
  const over = gaps.filter(([, x]) => x.ecart_tendance.alerte);
  if (over.length) alert(t, "ecart_tendance", `écart à la tendance au-delà du seuil : ${list(over.map(([path, x]) => `${path} (${signedPct(x.ecart_tendance.ecart_rel)})`))}`);
  t.validation_requise = items.some(([, x]) => x.validation_requise);
  return t;
}

// --------------------------------------------------------------------------- values of the customer request

// Values of the customer request (rfq.js, q.serie) that the costing compares
// with the values it uses, without applying them: whether to apply them is a
// decision left to the user (the weight stays the one typed in or measured,
// the mise au mille the one typed in or estimated, the scrap rate the one of
// the quote). grandeur: the value compared; tolerance: relative deviation
// above which an alert is raised.
export const DEMANDE = [
  { field: "poidsBrut", grandeur: "poids", unite: "kg", tolerance: 0.1, label: "Poids brut vendu", ref: "demande client : Poids Brut vendu (1- Données GO NO GO)" },
  { field: "poidsVendu", grandeur: "poids", unite: "kg", tolerance: 0.1, label: "Poids vendu par pièce", ref: "demande client : Poids vendu (5- Chiffrage Fonderie)" },
  { field: "miseAuMille", grandeur: "miseAuMille", unite: "kg/kg", tolerance: 0.1, label: "Mise au mille", ref: "demande client : Mise au mille (5- Chiffrage Fonderie)" },
  { field: "rebutUsinage", grandeur: "rebutUsinage", unite: "%", tolerance: 0.1, label: "Taux de rebuts usinage", ref: "demande client : Taux de rebuts usinage (5- Chiffrage Fonderie)" },
];

/**
 * The values of the request `serie` compared with those used (`utilises`:
 * {poids, miseAuMille, rebutUsinage}, missing or null when unknown):
 * [{...DEMANDE entry, valeur (of the request), utilise, ecart_rel (of the
 * value used from the request's), alerte (beyond the tolerance)}].
 */
export function demandeComparee(serie, utilises = {}) {
  return DEMANDE.filter((d) => hasValue(serie?.[d.field])).map((d) => {
    const valeur = serie[d.field];
    const utilise = hasValue(utilises[d.grandeur]) ? utilises[d.grandeur] : null;
    return { ...d, valeur, utilise, ecart_rel: relative(utilise, valeur), alerte: utilise !== null && differs(utilise, valeur, d.tolerance) };
  });
}

/**
 * The values of the request for `grandeur` added to the trace `t` as
 * alternatives (source "rfq", hard), with an "écart à la demande client"
 * alert when the value used differs by more than the tolerance. Not applied:
 * t keeps its value.
 */
function compareDemande(t, serie, grandeur) {
  for (const d of demandeComparee(serie, { [grandeur]: t.valeur }).filter((x) => x.grandeur === grandeur)) {
    t.alternatives.push({ source: "rfq", autorite: SOURCES.rfq.autorite, ref: d.ref, valeur: d.valeur, ecart_rel: d.ecart_rel });
    if (d.alerte) {
      const gap = d.ecart_rel === null ? "" : ` (écart de ${signedPct(d.ecart_rel)})`;
      alert(t, "ecart_demande", `${d.label} de la demande client ${show(d.valeur, d.unite)}, valeur utilisée ${show(t.valeur, d.unite)}${gap} : au-delà de la tolérance de ${signedPct(d.tolerance).replace("+", "")}, valeur de la demande non appliquée`);
    }
  }
  t.validation_requise ||= needsValidation(t);
  return t;
}

// --------------------------------------------------------------------------- registry

// The traced keys, their label and the outputs every quote must trace. The
// keys "centre.<code>.*" are those of the casting island retained.
const LABELS = {
  "devis.alliage": "Alliage",
  "devis.densite": "Densité de l'alliage",
  "devis.volumeTotal": "Volume du programme",
  "devis.tailleSerie": "Taille de série",
  "devis.marge": "Marge sur VA",
  "devis.energie.elec": "Électricité : nouvel indice",
  "devis.energie.gaz": "Gaz : nouvel indice",
  "devis.metal.coursVente": "Cours de vente",
  "devis.metal.p1020Vente": "Prime P1020 vente",
  "devis.metal.premiumVente": "Premium vente",
  "devis.metal.pafVente": "PAF vendue",
  "devis.metal.prixVente": "Prix du métal vendu",
  "devis.metal.coursAchat": "Cours achat",
  "devis.metal.p1020Achat": "P1020 achat",
  "devis.metal.premiumAchat": "Premium achat",
  "devis.metal.prixAchat": "Prix d'achat du métal",
  "devis.metal.pafAchat": "Perte au feu achat",
  "devis.coefDifficulte": "Coef de difficulté",
  "devis.vaUsinage": "VA d'usinage",
  "devis.rebutUsinage": "Rebut fonderie détecté à l'usinage",
  "parametres.tauxMini": "Paramètres : taux de marge mini",
  "parametres.prix": "Paramètres : mise en route et hausses annuelles",
  "ensemble.poids": "Poids de l'ensemble",
  "ensemble.miseAuMille": "Mise au mille de l'ensemble",
  "ensemble.prix.vente": "Prix de vente de l'ensemble",
  "piece.volume3d": "Volume du corps (3D)",
  "piece.poids": "Poids pièce",
  "piece.toileMini": "Toile mini",
  "piece.epaisseurMax": "Épaisseur maxi / point chaud",
  "piece.module": "Module V/S",
  "piece.dimMax": "Plus grande dimension",
  "piece.ilot": "Îlot de coulée",
  "piece.miseAuMille": "Mise au mille",
  "piece.miseAuMille.estimee": "Mise au mille estimée (non retenue)",
  "piece.kgCast": "Poids coulé par pièce",
  "piece.empreintes": "Empreintes / pièces par cycle",
  "piece.empreintes.estimee": "Empreintes estimées (non retenues)",
  "piece.cycle": "Temps de cycle de coulée",
  "piece.va": "VA PRI des centres",
  "piece.outillage.moule": "Outillage : moule",
  "piece.outillage.total": "Outillage total",
  "piece.prix.pri": "PRI (hors outillage)",
  "piece.prix.vente": "Prix de vente unitaire",
  "parametres.miseAuMille": "Paramètres : rendement de l'îlot",
  "parametres.empreintes": "Paramètres : empreintes et grappe de l'îlot",
  "parametres.cycle": "Paramètres : cycle de coulée de l'îlot",
  "parametres.operations": "Paramètres : autres opérations de la gamme",
  "parametres.outillage": "Paramètres : outillage (moules)",
  "parametres.noyaux": "Paramètres : boîtes à noyau",
};

/** Label of a traced key. */
export function label(cle) {
  const m = /^centre\.([^.]+)\.(trs|mode|taux)$/.exec(cle);
  if (m) return `${{ trs: "TRS", mode: "Fonctionnement", taux: "Taux" }[m[2]]} du centre ${m[1]}`;
  return LABELS[cle] ?? cle;
}

// The outputs every quote traces: of the quote, and of each piece costed
// (`code`: its casting island).
export const QUOTE_KEYS = [
  "devis.alliage", "devis.densite", "devis.volumeTotal", "devis.tailleSerie", "devis.marge", "devis.energie.elec", "devis.energie.gaz",
  "devis.metal.coursVente", "devis.metal.p1020Vente", "devis.metal.premiumVente", "devis.metal.pafVente", "devis.metal.prixVente",
  "devis.metal.coursAchat", "devis.metal.p1020Achat", "devis.metal.premiumAchat", "devis.metal.prixAchat", "devis.metal.pafAchat",
  "devis.coefDifficulte", "devis.vaUsinage", "devis.rebutUsinage", "parametres.prix",
];
export const pieceKeys = (code) => [
  "piece.poids", "piece.toileMini", "piece.epaisseurMax", "piece.module", "piece.dimMax", "piece.ilot", "piece.miseAuMille", "piece.kgCast",
  "piece.empreintes", "piece.cycle", `centre.${code}.mode`, `centre.${code}.trs`, `centre.${code}.taux`, "piece.va",
  "piece.outillage.total", "piece.prix.pri", "piece.prix.vente",
];

/**
 * Counts of traced values: sections [{piece (name, or null for the quote),
 * trace}] -> {valeurs, aValider, aValiderCalcul (computed from values to
 * validate), alertes: [{cle, label, type, message, pieces}], occurrences}.
 * An alert repeated by several pieces (a setting of their island...) counts
 * once, with the names of the pieces (none: an alert of the quote);
 * occurrences: the alerts of every piece.
 */
export function summarize(sections) {
  const out = { valeurs: 0, aValider: 0, aValiderCalcul: 0, alertes: [], occurrences: 0 };
  const groups = new Map();
  for (const { piece, trace } of sections) {
    for (const [cle, t] of Object.entries(trace ?? {})) {
      out.valeurs++;
      if (t.validation_requise) out.aValider++;
      if (t.validation_requise && t.source.type === "calcul") out.aValiderCalcul++;
      for (const a of t.alertes) {
        out.occurrences++;
        const id = `${cle}|${a.type}|${a.message}`;
        if (!groups.has(id)) groups.set(id, { cle, label: label(cle), ...a, pieces: [] });
        if (piece !== null && piece !== undefined) groups.get(id).pieces.push(piece);
      }
    }
  }
  out.alertes = [...groups.values()];
  return out;
}

// --------------------------------------------------------------------------- traces of a quote

// Values of the quote copied from the workbook when the quote was created:
// cells of the last quote saved in its Chiffrage sheet, historical values.
const CELLS = {
  coursAchat: "J73", p1020Achat: "J74", premiumAchat: "J75", premiumVente: "L75", pafAchat: "J78", pafVente: "L78",
  coefDifficulte: "H83", vaUsinage: "D84", rebutUsinage: "H84", tailleSerie: "G119",
};

const same = (a, b) => hasValue(a) && hasValue(b) && (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) : String(a).trim().toLowerCase() === String(b).trim().toLowerCase());

/** Where a field of the quote comes from: the customer request, the workbook, the code; else typed in. */
function originOf(value, candidates, typed) {
  const chosen = candidates.find((c) => c && same(c.valeur, value)) ?? (hasValue(value) ? typed() : null);
  return chosen ? [chosen, ...candidates.filter((c) => c && c !== chosen)] : candidates;
}

function rfqTraced(q, valeur, unite, field) {
  return hasValue(valeur) ? traced(valeur, { type: "rfq", unite, ref: `demande client : ${field}`, fichier: q.serie?.fileName, date: q.serie?.importedAt }) : null;
}

function workbookTraced(base, field, unite) {
  const v = base?.defaults?.[field];
  if (!hasValue(v) || !CELLS[field]) return null;
  return traced(v, {
    type: "classeur", unite, ref: `classeur : Chiffrage!${CELLS[field]}`, fichier: base.source?.fileName, date: base.source?.importedAt,
    confiance: "moyenne", raison: "dernier devis enregistré dans le classeur : valeur historique, reprise à la création du devis", validation: true,
  });
}

/**
 * A field of the quote (q[field], traced as `cle`), `used` the value the
 * costing took (`|| 0`): from the request (metal of its foundry quote), the
 * workbook (historical) or typed in; empty: 0.
 */
function quoteField(ctx, cle, field, used, { unite, zero = null }) {
  const { q, base, seuil } = ctx;
  const candidates = originOf(q[field], [rfqTraced(q, q.serie?.matiere?.[field], unite, label(cle)), workbookTraced(base, field, unite)], () => traced(q[field], { type: "saisie", unite, ref: `q.${field}` }));
  const t = resolve(candidates, { seuil, comparer: (c) => c.source.type === "rfq" });
  if (!t || !hasValue(q[field])) {
    return traced(used, { type: "defaut_code", unite, ref: `ui.js:compute (q.${field} vide → 0)`, confiance: "nulle", raison: "champ vide : 0 utilisé", alertes: [{ type: "repli_zero", message: `${label(cle)} vide : 0 utilisé` }] });
  }
  t.valeur = used;
  if (zero && used === 0) {
    alert(t, "repli_zero", zero);
    t.confiance = { niveau: "nulle", raison: zero };
    t.validation_requise = true;
  }
  return t;
}

/**
 * Traces of the values of the whole quote (keys "devis.*").
 *   ctx: {q, base, indices, layers, settings, seuil}
 *   c: what ui.js:compute uses: {density, volumes, volumeTotal, sale, metal, energy}
 */
export function traceQuote(ctx, c) {
  const { q, base, indices, settings, seuil } = ctx;
  const T = {};
  const fichier = base?.source?.fileName;
  const date = base?.source?.importedAt;
  const serie = q.serie;

  // Alloy: the customer request, the first of the workbook's list (nothing chosen), else typed in.
  const first = base?.lists?.alliages?.[0];
  const firstAlloy = first
    ? traced(first, { type: "classeur", ref: "classeur : Liste (premier alliage)", fichier, date, confiance: "moyenne", raison: "premier alliage de la liste du classeur : aucun choix enregistré", validation: true })
    : traced(defaultQuote(null, null).alliage, { type: "defaut_code", ref: "store.js:defaultQuote" });
  const rfqAlloys = [rfqTraced(q, serie?.matiere?.alliage, "", "alliage (5- Chiffrage Fonderie)"), rfqTraced(q, serie?.alliage, "", "alliage (1- Données GO NO GO)")];
  const alloy = [...rfqAlloys, firstAlloy].find((x) => x && same(x.valeur, q.alliage)) ?? traced(q.alliage, { type: "saisie", ref: "q.alliage" });
  T["devis.alliage"] = resolve([alloy, ...rfqAlloys.filter((x) => x && x !== alloy)], { seuil, comparer: () => true }) ?? missing("", "alliage inconnu");

  // Density: Paramètres (layers), else the generic density of ui.js:compute
  // (also the one of the 3D page: the costing gives it its density).
  T["devis.densite"] = settings.densities?.[q.alliage] !== undefined
    ? fromSetting(ctx, `densities.${q.alliage}`, { unite: "g/cm³" })
    : traced(c.density, {
      type: "defaut_code", unite: "g/cm³", ref: "ui.js:compute (densité générique)", hypotheses: ["poids tiré du volume 3D et masse de la page Analyse 3D calculés avec cette densité"],
      alertes: [{ type: "defaut_code", message: `densité générique ${fr(c.density, 2)} g/cm³ : l'alliage ${q.alliage} n'a pas de densité dans Paramètres (Densités des alliages)` }],
    });

  // Volumes of the programme: the customer request, typed in, or the default of the code.
  const prog = serie ? programmeOf(serie, { proto: q.prototype }) : null;
  const code = defaultQuote(null, null);
  const years = `${plural(c.volumes.length, "an")} à partir de ${c.years?.[0] ?? q.premiereAnnee}`;
  const progTraced = prog ? traced(prog.volumes.reduce((a, b) => a + b, 0), { type: "rfq", unite: "pièces", ref: `demande client : ${q.prototype ? "volumes proto" : "volumes série"}`, fichier: serie.fileName, date: serie.importedAt }) : null;
  let volume;
  if (prog && prog.volumes.length === c.volumes.length && prog.volumes.every((v, i) => v === c.volumes[i])) volume = progTraced;
  else if (Array.isArray(q.volumes) && q.volumes.length === c.volumes.length) volume = traced(c.volumeTotal, { type: "saisie", unite: "pièces", ref: "q.volumes" });
  else if (q.volumeAnnuel === code.volumeAnnuel && q.annees === code.annees) {
    volume = traced(c.volumeTotal, { type: "defaut_code", unite: "pièces", ref: "store.js:defaultQuote", alertes: [{ type: "defaut_code", message: `volume annuel par défaut du code (${fr(code.volumeAnnuel, 0)} par an) : à saisir ou à reprendre de la demande client` }] });
  } else volume = traced(c.volumeTotal, { type: "saisie", unite: "pièces", ref: "q.volumeAnnuel" });
  volume.hypotheses.push(years);
  T["devis.volumeTotal"] = resolve([volume, volume === progTraced ? null : progTraced], { seuil, comparer: () => true });
  if (!(c.volumeTotal > 0)) {
    alert(T["devis.volumeTotal"], "repli_zero", "volume du programme nul : outillage non amorti");
    T["devis.volumeTotal"].confiance = { niveau: "nulle", raison: "volume nul" };
    T["devis.volumeTotal"].validation_requise = true;
  }

  // Series size: the largest order quantity of the request (at most a year), the workbook (historical), the code.
  const moq = serie?.moqs?.length ? traced(prog ? Math.min(serie.moqs[0], prog.pic) : serie.moqs[0], { type: "rfq", unite: "pièces", ref: "demande client : MOQ 1 (au plus une année)", fichier: serie.fileName, date: serie.importedAt }) : null;
  const codeSize = base?.defaults?.tailleSerie ? null : traced(defaultQuote(base, null).tailleSerie, { type: "defaut_code", unite: "pièces", ref: "store.js:defaultQuote" });
  const size = resolve(originOf(q.tailleSerie, [moq, workbookTraced(base, "tailleSerie", "pièces"), codeSize], () => traced(q.tailleSerie, { type: "saisie", unite: "pièces", ref: "q.tailleSerie" })), { seuil, comparer: (x) => x.source.type === "rfq" });
  T["devis.tailleSerie"] = size && q.tailleSerie > 0
    ? size
    : traced(q.tailleSerie ?? 0, { type: "defaut_code", unite: "pièces", ref: "model.js:quote (taille de série vide)", confiance: "nulle", alertes: [{ type: "repli_zero", message: "taille de série vide : changement de série non chiffré" }] });

  // Margin: typed in the quote ("Marge mini": computed), else Paramètres.
  const setting = fromSetting(ctx, "marge", { unite: "%" });
  if (hasValue(q.marge)) {
    const mini = q.margeMini && same(q.margeMini.valeur, q.marge);
    // The minimum rate the margin was solved for; when Paramètres has another one since, that one as an alternative.
    const stale = mini && hasValue(q.margeMini.tauxMini) && !same(q.margeMini.tauxMini, settings.tauxMini);
    if (stale) {
      T["parametres.tauxMini"] = resolve([
        traced(q.margeMini.tauxMini, { type: "saisie", unite: "%", ref: "q.margeMini.tauxMini", raison: "taux mini de Paramètres au moment du calcul de la marge mini" }),
        fromSetting(ctx, "tauxMini", { unite: "%" }),
      ], { seuil, comparer: () => true });
    } else if (mini) T["parametres.tauxMini"] = fromSetting(ctx, "tauxMini", { unite: "%" });
    const typed = mini
      ? derive(q.marge, { unite: "%", ref: "model.js:solveMargin (bouton « Marge mini »)", entrees: { "parametres.tauxMini": T["parametres.tauxMini"] }, hypotheses: [`marge qui donne un taux de marge sur VA de ${show(q.margeMini.tauxMini, "%")} la première année, avec les entrées de ce moment`] })
      : traced(q.marge, { type: "saisie", unite: "%", ref: "q.marge" });
    if (stale) {
      alert(typed, "divergence", `marge mini calculée avec un taux mini de ${show(q.margeMini.tauxMini, "%")}, Paramètres : ${show(settings.tauxMini, "%")} : relancez « Marge mini »`);
      typed.validation_requise = true;
    }
    T["devis.marge"] = resolve([typed, setting], { seuil, comparer: () => false });
  } else T["devis.marge"] = setting;

  // Energy prices: the customer request, else Paramètres or the workbook (model.js:centreRates).
  for (const [kind, name] of [["elec", "Électricité"], ["gaz", "Gaz"]]) {
    const key = `${kind}Nouveau`;
    const fromRfq = serie && q.serieEnergie !== false && serie[kind] > 0;
    const set = Number.isFinite(settings.energy?.[key])
      ? fromSetting(ctx, `energy.${key}`, { unite: "€/MWh" })
      : Number.isFinite(base?.energy?.[key]) ? traced(base.energy[key], { type: "classeur", unite: "€/MWh", ref: `classeur : énergie (${key})`, fichier, date }) : null;
    const t = resolve([fromRfq ? rfqTraced(q, serie[kind], "€/MWh", `prix ${kind === "elec" ? "de l'électricité" : "du gaz"}`) : null, set], { seuil, comparer: () => false })
      ?? missing("€/MWh", `${name} : aucun prix (classeur, Paramètres ou demande client)`);
    const ancien = c.energy?.[`${kind}Ancien`] ?? base?.energy?.[`${kind}Ancien`];
    if (t.valeur === 0 && ancien > 0) {
      alert(t, "repli_zero", `${name} : nouveau prix à 0, les coûts ${kind === "elec" ? "d'électricité" : "de gaz"} des centres sont annulés`);
      t.confiance = { niveau: "nulle", raison: "nouveau prix à 0" };
      t.validation_requise = true;
    }
    T[`devis.energie.${kind}`] = t;
  }

  // Sale metal price: the indices, else the request's own quote for its month, else 0.
  const m = serie?.matiere;
  const indicesFile = indices ? { fichier: indices.fileName, date: indices.importedAt } : {};
  const averaging = `${q.cours}, moyenne ${q.typologie}, ${q.month ?? "mois non choisi"}${indices?.source === "classeur" ? " (copie des indices du classeur)" : ""}`;
  const sale = c.sale;
  const rfqSale = m?.coursVente > 0 && m.month === q.month ? rfqTraced(q, m.coursVente, "€/t", "valeur de référence vente") : null;
  if (sale.source === "demande") {
    T["devis.metal.coursVente"] = resolve([traced(c.metal.coursVente, { type: "rfq", unite: "€/t", ref: "demande client : valeur de référence vente", fichier: serie.fileName, date: serie.importedAt, hypotheses: ["mois absent des indices : valeur de la demande client pour ce mois"] })], { seuil });
  } else if (sale.cours !== null && sale.cours !== undefined) {
    T["devis.metal.coursVente"] = resolve([traced(c.metal.coursVente, { type: "indices", unite: "€/t", ref: "model.js:saleMetalPrice", ...indicesFile, hypotheses: [averaging] }), rfqSale], { seuil });
  } else {
    T["devis.metal.coursVente"] = traced(c.metal.coursVente, {
      type: "defaut_code", unite: "€/t", ref: "ui.js:compute (cours de vente indisponible → 0)", confiance: "nulle", raison: "cours de vente indisponible : 0 utilisé", hypotheses: [averaging],
      alertes: [{ type: "repli_zero", message: `cours de vente indisponible (${indices ? "mois absent du fichier des indices" : "aucun fichier d'indices"}) : 0 utilisé, le prix du métal vendu est faux` }],
    });
  }
  const withP1020 = base?.lists?.coursP1020?.some((n) => n.toLowerCase() === String(q.cours).toLowerCase());
  if (sale.source === "demande") {
    T["devis.metal.p1020Vente"] = hasValue(m?.p1020Vente)
      ? traced(c.metal.p1020Vente, { type: "rfq", unite: "€/t", ref: "demande client : P1020 vente", fichier: serie.fileName, date: serie.importedAt })
      : traced(0, { type: "defaut_code", unite: "€/t", ref: "ui.js:compute (P1020 vente absente → 0)", confiance: "nulle", alertes: [{ type: "repli_zero", message: "prime P1020 vente absente de la demande client : 0 utilisé" }] });
  } else if (hasValue(sale.p1020)) {
    T["devis.metal.p1020Vente"] = withP1020
      ? traced(c.metal.p1020Vente, { type: "indices", unite: "€/t", ref: "model.js:saleMetalPrice (Prime Mb P1020 €)", ...indicesFile, hypotheses: [averaging] })
      : traced(c.metal.p1020Vente, { type: "classeur", unite: "€/t", ref: "classeur : Liste (cours avec P1020)", fichier, date, hypotheses: [`${q.cours} : cours sans prime P1020`] });
  } else {
    T["devis.metal.p1020Vente"] = traced(c.metal.p1020Vente, { type: "defaut_code", unite: "€/t", ref: "ui.js:compute (prime P1020 indisponible → 0)", confiance: "nulle", hypotheses: [averaging], alertes: [{ type: "repli_zero", message: "prime P1020 de vente indisponible : 0 utilisé" }] });
  }
  const metalField = (field, used, opts) => quoteField(ctx, `devis.metal.${field}`, field, used, opts);
  T["devis.metal.premiumVente"] = metalField("premiumVente", c.metal.premiumVente, { unite: "€/t" });
  T["devis.metal.pafVente"] = metalField("pafVente", c.metal.pafVente, { unite: "%" });
  const v = c.metal;
  T["devis.metal.prixVente"] = derive((v.coursVente + v.p1020Vente + v.premiumVente) * (1 + v.pafVente), {
    unite: "€/t", ref: "model.js:quote ((cours + P1020 + premium) × (1 + PAF vendue))",
    entrees: { "devis.metal.coursVente": T["devis.metal.coursVente"], "devis.metal.p1020Vente": T["devis.metal.p1020Vente"], "devis.metal.premiumVente": T["devis.metal.premiumVente"], "devis.metal.pafVente": T["devis.metal.pafVente"] },
  });

  // Purchase metal price: the request, the workbook (last quote saved, not indexed), typed in.
  T["devis.metal.coursAchat"] = metalField("coursAchat", v.coursAchat, { unite: "€/t", zero: "cours d'achat à 0 : matière et perte au feu non chiffrées" });
  T["devis.metal.p1020Achat"] = metalField("p1020Achat", v.p1020Achat, { unite: "€/t" });
  T["devis.metal.premiumAchat"] = metalField("premiumAchat", v.premiumAchat, { unite: "€/t" });
  T["devis.metal.prixAchat"] = derive(v.coursAchat + v.p1020Achat + v.premiumAchat, {
    unite: "€/t", ref: "model.js:quote (cours + P1020 + premium achat)",
    entrees: { "devis.metal.coursAchat": T["devis.metal.coursAchat"], "devis.metal.p1020Achat": T["devis.metal.p1020Achat"], "devis.metal.premiumAchat": T["devis.metal.premiumAchat"] },
  });
  T["devis.metal.pafAchat"] = metalField("pafAchat", v.pafAchat, { unite: "%" });

  // Difficulty and machining scrap: copied from the workbook with the quote, or typed in (model.js:quote).
  T["devis.coefDifficulte"] = quoteField(ctx, "devis.coefDifficulte", "coefDifficulte", Number(q.coefDifficulte) || 0, { unite: "" });
  T["devis.vaUsinage"] = quoteField(ctx, "devis.vaUsinage", "vaUsinage", q.vaUsinage || 0, { unite: "€" });
  T["devis.rebutUsinage"] = compareDemande(quoteField(ctx, "devis.rebutUsinage", "rebutUsinage", q.rebutUsinage || 0, { unite: "%" }), serie, "rebutUsinage");

  // The other settings of the price: set-up of a series and yearly increases (the first year carries one).
  T["parametres.prix"] = settingsGroup(ctx, [
    "coefSecurite", "heuresChangementCoulee", "heuresChangementFinition",
    ...["salaires", "conso", "elec", "gaz", "autresEnergies"].map((k) => `inflation.${k}`),
  ], { label: "mise en route et hausses annuelles", ref: "settings" });
  return T;
}

/**
 * Traces of the values of one piece (keys "piece.*", "centre.<code>.*",
 * "parametres.*"): r is the result of ui.js:computePiece, devis the traces
 * of the quote (traceQuote).
 *   ctx: {q, base, layers, settings, seuil, p3dFile}
 */
export function tracePiece(r, ctx, devis) {
  const { q, base, settings, seuil } = ctx;
  const T = {};
  const i = r.inputs;
  const key = r.piece.key;
  const input = (field, unite, extra = {}) => traced(i[field], { type: "saisie", unite, ref: `q.pieces["${key}"].${field}`, ...extra });
  const typed = (field) => i[field] !== null && i[field] !== undefined;
  const geo = (valeur, unite, ref, hypotheses = []) => traced(valeur, { type: "geometrie", unite, ref, fichier: ctx.p3dFile ?? undefined, hypotheses });

  // Weight: typed in, else the volume of the 3D body × the density.
  if (r.piece.volume) T["piece.volume3d"] = geo(r.piece.volume / 1000, "cm³", "app.js:partFeatures (volume du corps fermé)");
  const weight3d = r.auto.poids !== null
    ? derive(r.auto.poids, { unite: "kg", ref: "ui.js:computePiece (volume × densité)", entrees: { "piece.volume3d": T["piece.volume3d"], "devis.densite": devis["devis.densite"] }, plafond: ["moyenne", "modèle 3D pris tel quel : brut ou usiné non précisé"] })
    : null;
  T["piece.poids"] = resolve([typed("poids") ? input("poids", "kg") : null, weight3d], { seuil, comparer: () => true })
    ?? missing("kg", "poids inconnu : ni saisi ni mesuré sur un modèle 3D, la pièce n'est pas chiffrée");
  // The weights of the customer request, compared when the quote is that piece alone (else with the set: traceEnsemble).
  if (ctx.demandePiece) compareDemande(T["piece.poids"], q.serie, "poids");
  if (T["piece.poids"].valeur !== null && !(T["piece.poids"].valeur > 0)) alert(T["piece.poids"], "valeur_manquante", "poids nul : la pièce n'est pas chiffrée");

  // Geometry: typed in, else measured on the 3D model, else 0 (ui.js:computePiece).
  const thick = r.piece.thickness;
  const forced = thick && hasValue(thick.min) && hasValue(thick.detected) && thick.min !== thick.detected;
  const geometry = (k, field, unite, measured, zero) => {
    T[k] = resolve([typed(field) ? input(field, unite) : null, measured], { seuil, comparer: () => false })
      ?? traced(0, { type: "defaut_code", unite, ref: "ui.js:computePiece (inconnu → 0)", confiance: "nulle", raison: "ni saisi ni mesuré : 0 utilisé", alertes: [{ type: "repli_zero", message: zero }] });
  };
  geometry("piece.toileMini", "toileMini", "mm", r.auto.toileMini === null ? null : forced
    ? traced(r.auto.toileMini, { type: "saisie", unite: "mm", ref: "page Analyse 3D : toile mini forcée", hypotheses: [`toile détectée ${fr(thick.detected, 2)} mm`] })
    : geo(r.auto.toileMini, "mm", "app.js:partFeatures (épaisseurs : quantile bas des parois)", thick?.details ? ["écritures et détails fins exclus"] : []),
  "toile mini inconnue : 0, faisabilité des îlots non vérifiée");
  geometry("piece.epaisseurMax", "epaisseurMax", "mm", r.auto.epaisseurMax === null ? null : geo(r.auto.epaisseurMax, "mm", "app.js:partFeatures (épaisseurs : sphère inscrite maxi)"), "épaisseur maxi inconnue : 0, mise au mille par défaut de l'îlot");
  geometry("piece.module", "moduleMm", "mm", r.auto.moduleMm === null ? null : geo(r.auto.moduleMm, "mm", "volume / surface du corps", ["module global du corps, pas celui du point chaud"]), "module inconnu : 0 dans le temps de cycle");
  geometry("piece.dimMax", "dimMax", "mm", r.auto.dimMax === null ? null : geo(r.auto.dimMax, "mm", "app.js:partFeatures (boîte englobante)"), "plus grande dimension inconnue : 0, encombrement non vérifié");
  if (!(r.part.poids > 0)) return T;
  const geomIn = { "piece.poids": T["piece.poids"], "piece.toileMini": T["piece.toileMini"], "piece.epaisseurMax": T["piece.epaisseurMax"], "piece.dimMax": T["piece.dimMax"] };
  const route = r.route;
  if (!route) {
    T["piece.ilot"] = missing("", "aucun îlot ne convient à cette pièce : non chiffrée");
    return T;
  }

  // Island: chosen in the page, else the best quality / price.
  const code = route.process;
  const e = r.estimated;
  const casting = route.operations.find((o) => o.code === code);
  T["piece.ilot"] = r.chosen
    ? input("procede", "", { hypotheses: [`finition ${route.finition}`] })
    : derive(code, { ref: "routes.js:rankRoutes (meilleur rapport qualité / prix)", entrees: geomIn, plafond: ["moyenne", "choix automatique : meilleur rapport qualité / prix estimé"], hypotheses: [`finition ${route.finition}`] });
  if (!route.feasible) alert(T["piece.ilot"], "infaisable", `îlot imposé infaisable : ${route.reasons.join(", ")}`);
  T["piece.ilot"].validation_requise ||= needsValidation(T["piece.ilot"]);

  // Mise au mille, cavities and cycle: typed in (island chosen), else
  // estimated (routes.js:buildRoute). The estimates of the cavities and of the
  // cycle use the estimated mise au mille and cavities, not those typed in: an
  // estimate not retained that another one uses is traced under its own key
  // (".estimee"). The settings of an estimate are traced when it is used.
  const mamTyped = r.chosen && i.miseAuMille > 0;
  const cavitiesTyped = r.chosen && i.empreintes > 0;
  const cycleTyped = r.chosen && i.cycle > 0;
  const shownPct = (v) => `${fr(v * 100, 1)} %`;
  const mamDetail = e.miseAuMilleDetail;
  const mamSettings = mamDetail.estimated
    ? settingsGroup(ctx, ["base", "parDoublement", "petitePiece"].map((k) => `processes.${code}.rendement.${k}`), { label: `rendement de ${code}`, ref: `settings.processes.${code}.rendement` })
    : null;
  if (mamSettings && !(mamTyped && cavitiesTyped && cycleTyped)) T["parametres.miseAuMille"] = mamSettings;
  const mamEstimate = mamDetail.estimated
    ? derive(e.miseAuMille, {
      unite: "kg/kg", ref: "routes.js:estimateMiseAuMille (1 / rendement)",
      entrees: { "piece.poids": T["piece.poids"], "piece.toileMini": T["piece.toileMini"], "piece.epaisseurMax": T["piece.epaisseurMax"], "parametres.miseAuMille": mamSettings },
      plafond: ["moyenne", "ordre de grandeur tiré de la géométrie, à confirmer par les méthodes"], hypotheses: [`rendement ${shownPct(mamDetail.rendement)}`],
    })
    : fromSetting(ctx, `processes.${code}.miseAuMille`, { unite: "kg/kg", hypotheses: ["épaisseurs inconnues : mise au mille par défaut de l'îlot"] });
  T["piece.miseAuMille"] = resolve([mamTyped ? input("miseAuMille", "kg/kg") : null, mamEstimate], { seuil, comparer: () => false });
  if (ctx.demandePiece) compareDemande(T["piece.miseAuMille"], q.serie, "miseAuMille");
  T["piece.kgCast"] = derive(r.final.kgCast, { unite: "kg", ref: "model.js:quote (poids × mise au mille)", entrees: { "piece.poids": T["piece.poids"], "piece.miseAuMille": T["piece.miseAuMille"] } });
  const mamKey = mamTyped ? "piece.miseAuMille.estimee" : "piece.miseAuMille";
  if (mamTyped && !(cavitiesTyped && cycleTyped)) T[mamKey] = { ...mamEstimate, hypotheses: [...mamEstimate.hypotheses, "non retenue : sert à estimer les empreintes et le cycle"] };

  const cavitySettings = settingsGroup(ctx, [`processes.${code}.empreintesMax`, `processes.${code}.grappeMax`], { label: `empreintes et grappe de ${code}`, ref: `settings.processes.${code}` });
  if (!(cavitiesTyped && cycleTyped)) T["parametres.empreintes"] = cavitySettings;
  const cavitiesEstimate = derive(e.parCycle, {
    ref: "routes.js:buildRoute (grappe maxi / kg coulés, au plus les empreintes maxi)",
    entrees: { "piece.poids": T["piece.poids"], [mamKey]: mamEstimate, "parametres.empreintes": cavitySettings },
    hypotheses: mamTyped ? [`kg coulés estimés avec la mise au mille estimée (${fr(e.miseAuMille, 2)}), pas celle saisie`] : [],
  });
  T["piece.empreintes"] = resolve([cavitiesTyped ? input("empreintes", "") : null, cavitiesEstimate], { seuil, comparer: () => false });
  const cavitiesKey = cavitiesTyped ? "piece.empreintes.estimee" : "piece.empreintes";
  if (cavitiesTyped && !cycleTyped) T[cavitiesKey] = { ...cavitiesEstimate, hypotheses: [...cavitiesEstimate.hypotheses, "non retenues : servent à estimer le cycle"] };

  const cycleSettings = settingsGroup(ctx, ["base", "parKg", "exposant", "parModule2"].map((k) => `processes.${code}.cycle.${k}`), { label: `cycle de ${code}`, ref: `settings.processes.${code}.cycle` });
  if (!cycleTyped) T["parametres.cycle"] = cycleSettings;
  const cycleEstimate = derive(e.cycle, {
    unite: "s", ref: "routes.js:buildRoute (base + coef × (kg coulés par cycle)^exposant + s/mm² × module²)",
    entrees: { "piece.poids": T["piece.poids"], [mamKey]: mamEstimate, [cavitiesKey]: cavitiesEstimate, "piece.module": T["piece.module"], "parametres.cycle": cycleSettings },
    plafond: ["moyenne", "estimation à confirmer par les méthodes"],
    hypotheses: mamTyped || cavitiesTyped ? ["cycle estimé avec les empreintes et la mise au mille estimées, pas celles saisies"] : [],
  });
  // The estimate of the AI adopted by a person ("Utiliser cette valeur"): a value typed in, from its own source.
  const ai = cycleTyped ? adoptedEstimate(i, code) : null;
  const e0 = ai?.estimation;
  const range = (x) => (Array.isArray(x.fourchette_s) ? `, fourchette de ${fr(x.fourchette_s[0], 1)} à ${fr(x.fourchette_s[1], 1)} s` : "");
  const typedCycle = ai
    ? traced(i.cycle, {
      type: "ia_validee", unite: "s", ref: `q.pieces["${key}"].cycle (estimation IA)`, date: ai.date,
      raison: `estimation de ${e0.fournisseur ?? "l'IA"}${e0.modele ? ` · ${e0.modele}` : ""} validée par une personne le ${day(ai.date)} : à confirmer par une mesure en production`,
      hypotheses: [
        `estimation IA du ${day(e0.date)} (${[e0.fournisseur, e0.modele].filter(Boolean).join(" · ")}) : ${fr(e0.estimation_s, 1)} s${range(e0)}, confiance ${e0.confiance}`,
        ...(ai.avant?.procede !== code ? [`îlot ${code} imposé avec l'estimation`] : []),
      ],
    })
    : cycleTyped ? input("cycle", "s") : null;
  T["piece.cycle"] = resolve([typedCycle, cycleEstimate], { seuil, comparer: () => false });
  // The last estimate of the AI for this island, not adopted: another source, never the value.
  const proposed = i.estimationCycleIA;
  if (proposed?.ilot === code && proposed.estimation_s > 0 && proposed.date !== e0?.date) {
    T["piece.cycle"].alternatives.push({
      source: "ia", autorite: SOURCES.ia.autorite, valeur: proposed.estimation_s, ecart_rel: relative(T["piece.cycle"].valeur, proposed.estimation_s),
      ref: `estimation IA non validée (${[proposed.fournisseur, proposed.modele, day(proposed.date)].filter(Boolean).join(" · ")}${range(proposed)})`,
    });
  }

  // The casting centre: working mode, TRS, rate.
  const rate = r.finalRates.get(code);
  const fichier = base?.source?.fileName;
  const date = base?.source?.importedAt;
  T[`centre.${code}.mode`] = r.chosen && i.mode
    ? input("mode", "")
    : settings.modes?.[code] !== undefined && settings.modes[code] === rate?.mode
      ? fromSetting(ctx, `modes.${code}`)
      : traced(rate?.mode, { type: "classeur", ref: `classeur : fonctionnement du centre ${code}`, fichier, date });
  T[`centre.${code}.trs`] = settings.trs?.[code] !== undefined
    ? fromSetting(ctx, `trs.${code}`, { unite: "%" })
    : traced(casting.trs, { type: "defaut_code", unite: "%", ref: DEFAULT_TRS[code] !== undefined ? `routes.js:DEFAULT_TRS.${code}` : "routes.js:buildRoute (TRS de repli)" });
  const uo = { pph: "€/h", hour: "€/h", kgCast: "€/kg coulé", kgSold: "€/kg" };
  T[`centre.${code}.taux`] = rate?.rate > 0
    ? derive(rate.rate, {
      unite: uo[rate.uo] ?? "€", ref: "model.js:centreRates", fichier, date,
      entrees: { [`centre.${code}.mode`]: T[`centre.${code}.mode`], "devis.energie.elec": devis["devis.energie.elec"], "devis.energie.gaz": devis["devis.energie.gaz"] },
      hypotheses: [`coûts annuels du classeur en fonctionnement ${rate.mode}, frais corporate répartis au prorata des coûts`],
    })
    : traced(0, { type: "defaut_code", unite: uo[rate?.uo] ?? "€/h", ref: "model.js:centreRates", confiance: "nulle", raison: "taux nul", alertes: [{ type: "repli_zero", message: `centre ${code} ${rate ? "à taux nul" : "absent du classeur"} : coulée chiffrée 0` }] });

  // Value added: the centres of the route, the other operations from Paramètres.
  const paths = [];
  for (const o of route.operations) {
    if (o.code === "ASF" || o.code === "TTH" || o.code === code) continue;
    const op = settings.operations[o.code];
    if (!op) continue;
    if (o.code === "ASN" && r.part.noyauxCycle > 0) paths.push("operations.ASN.base", "operations.ASN.parKg");
    else paths.push(`operations.${o.code}.base`, `operations.${o.code}.parKg`, `operations.${o.code}.exposant`, op.chargeKg !== undefined ? `operations.${o.code}.chargeKg` : `operations.${o.code}.parCycle`);
    if (settings.trs?.[o.code] !== undefined) paths.push(`trs.${o.code}`);
  }
  if (r.part.tth && settings.tth?.[i.tth]) paths.push(`tth.${i.tth}.coef`);
  T["parametres.operations"] = settingsGroup(ctx, paths, { label: `autres opérations (${route.operations.filter((o) => o.code !== code).map((o) => o.code).join(", ")})`, ref: "settings.operations" });
  const unpriced = route.operations.filter((o) => !(r.finalRates.get(o.code)?.rate > 0)).map((o) => o.code);
  T["piece.va"] = derive(r.final.va, {
    unite: "€", ref: "model.js:quote (Σ taux × unités d'œuvre des centres)", fichier, date,
    entrees: { [`centre.${code}.taux`]: T[`centre.${code}.taux`], [`centre.${code}.trs`]: T[`centre.${code}.trs`], "piece.cycle": T["piece.cycle"], "piece.empreintes": T["piece.empreintes"], "piece.kgCast": T["piece.kgCast"], "parametres.operations": T["parametres.operations"] },
    ...(unpriced.length ? { plafond: ["nulle", "centre sans taux"], alertes: [{ type: "repli_zero", message: `${unpriced.length > 1 ? "centres absents du classeur ou à taux nul, chiffrés" : "centre absent du classeur ou à taux nul, chiffré"} 0 : ${unpriced.join(", ")}` }] } : {}),
  });

  // Tooling: the price typed in, else the estimate of the in-house die or the island's price; plus the core boxes.
  const t = route.tooling;
  const tl = settings.tooling;
  let estimate;
  if (t) {
    const band = tl.bandes.indexOf(bandOf(tl.bandes, t.block.kg));
    const toolingSettings = settingsGroup(ctx, [
      "tooling.type", `tooling.types.${tl.types[tl.type] ? tl.type : 0}.prixKg`, "tooling.densite", ...(Array.isArray(tl.coefPoids) ? tl.coefPoids.flatMap((_, k) => [`tooling.coefPoids.${k}.max`, `tooling.coefPoids.${k}.coef`]) : ["tooling.coefPoids"]),
      "tooling.marges.longueur", "tooling.marges.largeur", "tooling.marges.hauteur", ...(t.cavities > 1 ? ["tooling.marges.entreEmpreintes"] : []),
      ...["ax3", "ax3auto", "ax5", "ax5auto", "scan", "ajustage", ...(t.tiroirs ? ["tiroir3", "tiroir5"] : [])].map((k) => `tooling.bandes.${band}.${k}`),
      ...Object.keys(tl.taux).map((k) => `tooling.taux.${k}`), `tooling.etude.${t.complexite}`, `tooling.fao.${t.complexite}`, "tooling.sousTraitance", "tooling.marge",
      ...(typed("outillageTiroirs") ? [] : ["tooling.tiroirs"]), ...(i.outillageComplexite ? [] : ["tooling.complexite"]),
    ], { label: "moule (méthode « Outillage fonderie »)", ref: "settings.tooling" });
    if (!(i.outillagePrix > 0)) T["parametres.outillage"] = toolingSettings;
    estimate = derive(route.outillageEstime, {
      unite: "€", ref: "tooling.js:estimateTooling",
      entrees: { "piece.dimMax": T["piece.dimMax"], "piece.empreintes": T["piece.empreintes"], "parametres.outillage": toolingSettings },
      plafond: ["moyenne", "estimation par la méthode du classeur « Outillage fonderie »"],
      hypotheses: [
        `moule ${fr(t.block.L, 0)} × ${fr(t.block.W, 0)} × ${fr(t.block.H, 0)} mm = encombrement ${r.part.bboxSize?.length === 3 ? "du modèle 3D" : "estimé d'après la plus grande dimension"} + marges`,
        `${plural(t.tiroirs, "tiroir")} (${typed("outillageTiroirs") ? "saisi" : "par défaut"}), complexité ${t.complexite} (${i.outillageComplexite ? "saisie" : "par défaut"})`,
      ],
    });
  } else estimate = fromSetting(ctx, `processes.${code}.outillage`, { unite: "€", hypotheses: [`prix forfaitaire de l'îlot ${code}`] });
  const mould = resolve([i.outillagePrix > 0 ? input("outillagePrix", "€") : null, estimate], { seuil, comparer: () => false });
  if (i.outillagePrix === 0) alert(mould, "saisie_ignoree", "prix d'outillage saisi à 0 ignoré : estimation retenue");
  mould.validation_requise ||= needsValidation(mould);
  if (route.boxes.length) {
    const sc = settings.cores;
    T["parametres.noyaux"] = settingsGroup(ctx, route.boxes.flatMap((b) => [
      `cores.types.${sc.types[b.core.type] ? b.core.type ?? 0 : 0}.prixKg`, `cores.etude.${b.core.complexite in sc.etude ? b.core.complexite : "Compliqué(e)"}`, `cores.fao.${b.core.complexite in sc.etude ? b.core.complexite : "Compliqué(e)"}`,
      "cores.sousTraitance", "cores.marge", ...(b.size.auto ? ["cores.sableDensite", "cores.paroi"] : []),
      "tooling.densite", ...Object.keys(tl.taux).map((k) => `tooling.taux.${k}`), ...["ax3", "ax3auto", "ax5", "ax5auto", "scan", "ajustage"].map((k) => `tooling.bandes.${tl.bandes.indexOf(b.band)}.${k}`),
    ]), { label: `${plural(route.boxes.length, "boîte")} à noyau`, ref: "settings.cores" });
    T["piece.outillage.moule"] = mould;
    T["piece.outillage.total"] = derive(route.outillage, {
      unite: "€", ref: "ui.js:computePiece (moule + boîtes à noyau)", entrees: { "piece.outillage.moule": mould, "parametres.noyaux": T["parametres.noyaux"] },
      hypotheses: route.boxes.map((b) => `boîte à noyau « ${b.core.nom} » : ${fr(b.total, 0)} €${b.size.auto ? " (dimensions estimées)" : ""}`),
    });
  } else T["piece.outillage.total"] = mould;
  if (q.outillageInclus === false) T["piece.outillage.total"].hypotheses.push("chiffré à part : hors prix pièce");

  // Prices: computed (model.js:quote), as confident as their weakest input.
  const f = r.final;
  const y = f.years[0];
  T["piece.prix.pri"] = derive(f.pri, {
    unite: "€", ref: "model.js:quote (VA + matière + perte au feu + sable + difficulté + rebut d'usinage)",
    entrees: {
      "piece.va": T["piece.va"], "piece.poids": T["piece.poids"], "piece.kgCast": T["piece.kgCast"], "devis.metal.prixAchat": devis["devis.metal.prixAchat"], "devis.metal.pafAchat": devis["devis.metal.pafAchat"],
      "devis.coefDifficulte": devis["devis.coefDifficulte"], "devis.vaUsinage": devis["devis.vaUsinage"], "devis.rebutUsinage": devis["devis.rebutUsinage"],
    },
    hypotheses: route.sableKg > 0 ? [`sable : ${fr(route.sableKg, 3)} kg par pièce`] : [],
  });
  T["piece.prix.vente"] = derive(y?.prixVente, {
    unite: "€", ref: "model.js:quote (métal vendu + VA vendue + mise en route + composants)",
    entrees: {
      "piece.prix.pri": T["piece.prix.pri"], "piece.poids": T["piece.poids"], "devis.metal.prixVente": devis["devis.metal.prixVente"], "devis.marge": devis["devis.marge"],
      ...(q.outillageInclus === false ? {} : { "piece.outillage.total": T["piece.outillage.total"] }), "devis.volumeTotal": devis["devis.volumeTotal"], "devis.tailleSerie": devis["devis.tailleSerie"],
      "parametres.prix": devis["parametres.prix"],
    },
    hypotheses: y ? [`première année (${y.year})`] : [],
  });
  return T;
}

/**
 * The name of each piece of `pieces` in the traces: its own, unique; two
 * bodies of the same name (instances of a screw...) with their number.
 */
export function pieceNames(pieces) {
  const count = new Map();
  for (const p of pieces) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  return new Map(pieces.map((p, i) => [p, count.get(p.name) > 1 ? `${p.name} (corps ${Number.isInteger(p.index) ? p.index + 1 : i + 1})` : p.name]));
}

/**
 * Traces of the whole set (keys "ensemble.*"): the pieces costed
 * (ui.js:aggregate), those not costed left out. With a customer request that
 * gives a weight or a mise au mille: the weight and the mise au mille of the
 * set, compared with those of the request (one part: the set costed).
 *   ctx: {q}
 */
export function traceEnsemble(ctx, results, ensemble) {
  const T = {};
  const serie = ctx.q.serie;
  const name = pieceNames(results.map((r) => r.piece));
  const done = results.filter((r) => r.final);
  const left = results.filter((r) => !r.final).map((r) => name.get(r.piece));
  const of = (key) => Object.fromEntries(done.map((r) => [`${key} [${name.get(r.piece)}]`, r.trace?.[key]]));
  const asked = new Set(demandeComparee(serie).map((d) => d.grandeur));
  if (asked.has("poids") || asked.has("miseAuMille")) {
    T["ensemble.poids"] = compareDemande(derive(ensemble.poids, { unite: "kg", ref: "ui.js:aggregate (somme des poids des pièces chiffrées)", entrees: of("piece.poids") }), serie, "poids");
  }
  if (asked.has("miseAuMille")) {
    const kgCast = done.reduce((n, r) => n + (r.final.kgCast || 0), 0);
    T["ensemble.miseAuMille"] = compareDemande(derive(ensemble.poids > 0 ? kgCast / ensemble.poids : null, {
      unite: "kg/kg", ref: "kg coulés des pièces chiffrées / poids de l'ensemble", entrees: { ...of("piece.kgCast"), "ensemble.poids": T["ensemble.poids"] },
    }), serie, "miseAuMille");
  }
  T["ensemble.prix.vente"] = derive(ensemble.years[0]?.prixVente, {
    unite: "€", ref: "ui.js:aggregate (somme des pièces chiffrées)",
    entrees: { ...of("piece.prix.vente"), ...(T["ensemble.poids"] ? { "ensemble.poids": T["ensemble.poids"] } : {}), ...(T["ensemble.miseAuMille"] ? { "ensemble.miseAuMille": T["ensemble.miseAuMille"] } : {}) },
    alertes: left.length ? [{ type: "valeur_manquante", message: `${left.length > 1 ? `${left.length} pièces non chiffrées, exclues` : "pièce non chiffrée, exclue"} de l'ensemble : ${list(left)}` }] : [],
  });
  return T;
}
