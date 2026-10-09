// Choice of the manufacturing route of a cast part: casting island (die
// casting, low pressure, gravity die casting chantiers) and finishing method,
// with the operations around them. Every feasible route is costed with the
// costing model, then ranked by quality / price.
//
// The capabilities of the islands and the cycle-time coefficients below are
// starting values: they are settings of the page (Paramètres), meant to be
// adjusted to the real islands of the foundry, or imported from a settings
// file calibrated on the foundry's own quotes (kept out of this public code).
//   casting cycle = base + parKg × (kg cast per cycle)^exposant + parModule2 × module²

import { quote } from "./model.js";
import { cavityFactor, estimateTooling, isGravityDie } from "./tooling.js";

// Casting islands (codes of the profit centres of the workbook).
export const DEFAULT_PROCESSES = {
  SSP: {
    famille: "Sous pression",
    toileMin: 1, toileMax: 8, poidsMax: 12, dimMax: 600, volumeMin: 5000,
    empreintesMax: 4, grappeMax: 15, miseAuMille: 1.3, qualite: 6,
    tth: false, noyaux: false, finitions: ["FSP"], outillage: 60000,
    rendement: { base: 0.75, parDoublement: 0.03, petitePiece: 0.04 },
    cycle: { base: 25, parKg: 3, exposant: 1, parModule2: 3 },
  },
  BPR: {
    famille: "Basse pression",
    toileMin: 3, toileMax: 25, poidsMax: 40, dimMax: 800, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 60, miseAuMille: 1.25, qualite: 9,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 35000,
    rendement: { base: 0.88, parDoublement: 0.04, petitePiece: 0.03 },
    cycle: { base: 120, parKg: 4, exposant: 1, parModule2: 12 },
  },
  CG1: {
    famille: "Coquille gravité (DFP5 New look)",
    toileMin: 3.5, toileMax: 30, poidsMax: 25, dimMax: 600, volumeMin: 1000,
    empreintesMax: 2, grappeMax: 50, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    rendement: { base: 0.68, parDoublement: 0.06, petitePiece: 0.04 },
    cycle: { base: 90, parKg: 6, exposant: 1, parModule2: 10 },
  },
  CG2: {
    famille: "Coquille gravité (Gauss 2)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    rendement: { base: 0.68, parDoublement: 0.06, petitePiece: 0.04 },
    cycle: { base: 80, parKg: 6, exposant: 1, parModule2: 10 },
  },
  CG4: {
    famille: "Coquille gravité (SAB Auto)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    rendement: { base: 0.68, parDoublement: 0.06, petitePiece: 0.04 },
    cycle: { base: 80, parKg: 6, exposant: 1, parModule2: 10 },
  },
  CG5: {
    famille: "Coquille gravité (Gauss 1)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    rendement: { base: 0.68, parDoublement: 0.06, petitePiece: 0.04 },
    cycle: { base: 80, parKg: 6, exposant: 1, parModule2: 10 },
  },
  CG3: {
    famille: "Coquille gravité (traditionnel)",
    toileMin: 4, toileMax: 40, poidsMax: 60, dimMax: 1000, volumeMin: 0,
    empreintesMax: 1, grappeMax: 100, miseAuMille: 1.8, qualite: 7.5,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 10000,
    rendement: { base: 0.6, parDoublement: 0.06, petitePiece: 0.04 },
    cycle: { base: 150, parKg: 10, exposant: 1, parModule2: 12 },
  },
};

// Heat treatments: the TTH centre of the workbook is costed per kg for the
// reference treatment (T6); coef = cost of the treatment / cost of a T6
// (mostly the time in the furnaces). Starting values, settings of the page.
export const DEFAULT_TTH = {
  T6: { label: "T6 — mise en solution, trempe, revenu", coef: 1, cycle: "≈ 8 h à 535 °C, trempe eau, 6 h à 160 °C" },
  T64: { label: "T64 — mise en solution, trempe, sous-revenu", coef: 0.95, cycle: "≈ 8 h à 535 °C, trempe eau, 4 h à 150 °C" },
  T7: { label: "T7 — mise en solution, trempe, sur-revenu", coef: 1.1, cycle: "≈ 8 h à 535 °C, trempe eau, 8 h à 200 °C" },
  T4: { label: "T4 — mise en solution, trempe, maturation", coef: 0.75, cycle: "≈ 8 h à 535 °C, trempe eau, maturation à l'ambiante" },
  T5: { label: "T5 — revenu seul (vieillissement artificiel)", coef: 0.4, cycle: "≈ 6 h à 200 °C" },
  STAB: { label: "Stabilisation / détensionnement", coef: 0.3, cycle: "≈ 4 h à 250 °C" },
};

// Other operations: cycle = base + parKg × (piece weight)^exposant (s), pieces per cycle;
// noyautage: base + parKg × kg of sand, per core.
export const DEFAULT_OPERATIONS = {
  ASN: { label: "Noyautage", base: 40, parKg: 10, exposant: 1, parCycle: 1 },
  DEG: { label: "Dégotage", base: 20, parKg: 5, exposant: 1, parCycle: 1 },
  FSP: { label: "Finition sous pression", base: 15, parKg: 4, exposant: 1, parCycle: 1 },
  FCE: { label: "Finition cellules", base: 30, parKg: 6, exposant: 1, parCycle: 1, volumeMin: 3000 },
  FTR: { label: "Finition traditionnelle", base: 60, parKg: 15, exposant: 1, parCycle: 1 },
  TRI: { label: "Tribofinition", base: 1200, parKg: 0, exposant: 1, parCycle: 0, chargeKg: 60 },
  RED: { label: "Redressage", base: 30, parKg: 5, exposant: 1, parCycle: 1 },
  GCV: { label: "Grenaillage / contrôle visuel", base: 10, parKg: 2, exposant: 1, parCycle: 1 },
  EXP: { label: "Expédition", base: 600, parKg: 0, exposant: 1, parCycle: 0, chargeKg: 250, maxPieces: 500 },
};

export const DEFAULT_TRS = {
  SSP: 0.8, BPR: 0.8, CG1: 0.8, CG2: 0.8, CG4: 0.8, CG5: 0.8, CG3: 0.75,
  ASN: 0.85, DEG: 0.9, FSP: 0.85, FCE: 0.85, FTR: 0.9, TRI: 0.9, RED: 0.9, GCV: 0.9,
};

// Weight below which a part is "small": its gating system weighs relatively more.
const POIDS_REFERENCE = 2;

/**
 * Order of magnitude of the "mise au mille" (kg cast per kg of part) from the
 * geometry: 1 / yield, the yield (part / cast weight) being the typical yield
 * of the island,
 *  - minus parDoublement for each doubling of the ratio thickest / thinnest
 *    wall (hot spots to feed: more and bigger feeders),
 *  - minus petitePiece times ln(2 kg / weight) for parts under 2 kg (runners
 *    and overflows weigh relatively more),
 * the yield kept between 30 % and 95 %. Without wall thickness (not computed),
 * the island's default mise au mille. Returns {value, rendement, terms[]}.
 */
export function estimateMiseAuMille(p, part) {
  const r = p.rendement;
  if (!r || !(part.poids > 0) || !(part.toileMini > 0) || !(part.epaisseurMax > 0)) {
    return { value: p.miseAuMille, rendement: 1 / p.miseAuMille, terms: [{ label: "valeur par défaut de l'îlot", value: null }], estimated: false };
  }
  const doublings = Math.max(0, Math.log2(part.epaisseurMax / part.toileMini));
  const small = Math.max(0, Math.log(POIDS_REFERENCE / part.poids));
  const terms = [
    { label: "rendement type de l'îlot", value: r.base },
    { label: `épaisseurs hétérogènes (point chaud ${fmt(part.epaisseurMax)} / toile ${fmt(part.toileMini)} mm)`, value: -r.parDoublement * doublings },
    { label: `petite pièce (${fmt(part.poids)} kg < ${POIDS_REFERENCE} kg)`, value: -r.petitePiece * small },
  ].filter((t) => t.value !== 0 || t.label.startsWith("rendement"));
  const rendement = Math.min(0.95, Math.max(0.3, terms.reduce((a, t) => a + t.value, 0)));
  return { value: 1 / rendement, rendement, terms, estimated: true };
}

/** Pieces per cycle of island `p` for `kgCast` kg cast per piece: as many as its cluster takes, within its cavities. */
export function piecesPerCycle(p, kgCast) {
  return Math.max(1, Math.min(p.empreintesMax, Math.floor(p.grappeMax / Math.max(kgCast, 1e-9))));
}

/** The numbers of cavities to compare on island `p`: 1 to its maximum, at least 4 and at most 8, and the `counts` estimated or chosen. */
export function cavityChoices(p, ...counts) {
  const max = Math.max(Math.min(8, Math.max(4, p.empreintesMax || 1)), ...counts.filter((n) => n > 0).map(Math.round));
  return Array.from({ length: max }, (_, i) => i + 1);
}

/** Casting cycle (s) of island `p`: `parCycle` pieces of `kgCast` kg cast each, a modulus of `moduleMm` (unknown: 0). */
export function castingCycle(p, kgCast, parCycle, moduleMm) {
  return p.cycle.base + p.cycle.parKg * (kgCast * parCycle) ** (p.cycle.exposant ?? 1) + (p.cycle.parModule2 || 0) * (moduleMm || 0) ** 2;
}

/**
 * Operations and parameters of one route.
 *   part: {poids, moduleMm (volume / area), toileMini, epaisseurMax, dimMax,
 *          volumeAnnuel, tth, noyaux, tribo, redressage, sableKg;
 *          bboxSize, volume, area: for the estimate of a gravity die}
 *   settings: {processes, operations, trs, tooling}
 *   options.empreintes: cavities chosen in the page, in place of the estimate:
 *          the cycle is that of their cluster, the tool is priced for them
 * Returns {process, finition, operations, miseAuMille, parCycle, parCycleEstime
 *          (the estimate), cycle, sableKg, feasible, reasons[], warnings[],
 *          alertesEmpreintes[] (the cavities chosen past the island's limits, also
 *          in warnings), qualite, outillage (€), facteurOutillage (flat price of
 *          the island × it), tooling (estimate of the in-house die, or null),
 *          outillagePiece}.
 */
export function buildRoute(code, finition, part, settings, rates, { empreintes = null } = {}) {
  const p = settings.processes[code];
  const ops = settings.operations;
  const trs = (c) => settings.trs?.[c] ?? DEFAULT_TRS[c] ?? 0.85;
  const reasons = [];
  const warnings = [];
  let qualite = p.qualite;

  if (part.toileMini > 0 && part.toileMini < p.toileMin) reasons.push(`toile mini ${fmt(part.toileMini)} mm < ${fmt(p.toileMin)} mm`);
  if (part.poids > p.poidsMax) reasons.push(`poids ${fmt(part.poids)} kg > ${fmt(p.poidsMax)} kg`);
  if (part.dimMax > p.dimMax) reasons.push(`encombrement ${fmt(part.dimMax)} mm > ${fmt(p.dimMax)} mm`);
  if (part.tth && !p.tth) reasons.push("traitement thermique impossible");
  if (part.noyaux && !p.noyaux) reasons.push("noyaux sable impossibles");
  if (part.epaisseurMax > p.toileMax) {
    warnings.push(`point chaud ${fmt(part.epaisseurMax)} mm > ${fmt(p.toileMax)} mm : risque de retassure`);
    qualite -= code === "SSP" ? 2 : 1;
  }
  if (part.toileMini > 0 && part.toileMini < p.toileMin + 1 && !reasons.length) {
    warnings.push("toile proche du minimum : remplissage délicat");
    qualite -= 0.5;
  }
  if (part.volumeAnnuel > 0 && part.volumeAnnuel < p.volumeMin) {
    warnings.push(`volume annuel ${part.volumeAnnuel} < ${p.volumeMin} conseillé`);
    qualite -= 0.5;
  }
  if (finition === "FCE" && part.volumeAnnuel > 0 && part.volumeAnnuel < (ops.FCE.volumeMin ?? 0)) {
    warnings.push("finition cellules peu rentable sur ce volume");
  }

  const mam = estimateMiseAuMille(p, part);
  const miseAuMille = mam.value;
  const kgCast = part.poids * miseAuMille;
  const parCycleEstime = piecesPerCycle(p, kgCast);
  // Cavities chosen: more pieces per cycle for a cycle a little longer (more metal cast at once).
  const parCycle = empreintes > 0 ? Math.max(1, Math.round(empreintes)) : parCycleEstime;
  const alertesEmpreintes = [];
  if (parCycle > p.empreintesMax) alertesEmpreintes.push(`${parCycle} empreintes > ${p.empreintesMax} maxi de l'îlot`);
  if (parCycle > parCycleEstime && kgCast * parCycle > p.grappeMax) alertesEmpreintes.push(`grappe ${fmt(kgCast * parCycle)} kg > ${fmt(p.grappeMax)} kg maxi`);
  warnings.push(...alertesEmpreintes);
  const cycle = castingCycle(p, kgCast, parCycle, part.moduleMm);
  const simple = (c) => ({ code: c, cycle: ops[c].base + ops[c].parKg * part.poids ** (ops[c].exposant ?? 1), parCycle: ops[c].parCycle || 1, trs: trs(c) });
  const batch = (c) => {
    const o = ops[c];
    const n = Math.max(1, Math.min(o.maxPieces ?? Infinity, Math.floor(o.chargeKg / Math.max(part.poids, 1e-9))));
    return { code: c, cycle: o.base, parCycle: n, trs: trs(c) };
  };

  const operations = [{ code: "ASF" }];
  // Core making: the time of the cores of the piece (cores.js) when they are described.
  if (part.noyaux) operations.push(part.noyauxCycle > 0 ? { code: "ASN", cycle: part.noyauxCycle, parCycle: 1, trs: trs("ASN") } : simple("ASN"));
  operations.push({ code, cycle, parCycle, trs: trs(code) });
  if (part.noyaux) operations.push(simple("DEG"));
  operations.push(simple(finition));
  if (part.tth) operations.push({ code: "TTH" });
  if (part.redressage) operations.push(simple("RED"));
  if (part.tribo) operations.push(batch("TRI"));
  operations.push(simple("GCV"));
  operations.push(batch("EXP"));

  // Centres missing from the workbook make the route impossible to cost.
  const missing = operations.map((o) => o.code).filter((c) => rates && !rates.has(c));
  if (missing.length) reasons.push(`centre absent du classeur : ${missing.join(", ")}`);

  const total = part.volumeTotal > 0 ? part.volumeTotal : part.volumeAnnuel > 0 ? part.volumeAnnuel * 5 : 0;
  // Gravity dies made in-house: estimated from the part; other tools: the price
  // of the island, for the cavities it would use, scaled for those chosen.
  const tooling = settings.tooling?.actif && isGravityDie(p) ? estimateTooling(part, parCycle, settings.tooling, parCycleEstime) : null;
  const facteurOutillage = tooling ? 1 : cavityFactor(parCycle, parCycleEstime, settings.tooling?.parEmpreinte);
  const outillage = tooling ? tooling.total : p.outillage * facteurOutillage;
  return {
    process: code,
    famille: p.famille,
    finition,
    operations,
    miseAuMille,
    miseAuMilleDetail: mam,
    parCycle,
    parCycleEstime,
    cycle,
    sableKg: part.noyaux ? part.sableKg || 0 : 0,
    feasible: reasons.length === 0,
    reasons,
    warnings,
    alertesEmpreintes,
    qualite: Math.max(0, Math.min(10, qualite)),
    outillage,
    facteurOutillage,
    tooling,
    outillagePiece: total > 0 ? outillage / total : 0,
  };
}

/**
 * All the routes of the islands present in the workbook, costed and ranked:
 * feasible routes first, by quality / price (price = PRI + tooling per piece).
 *   quoteBase: the other inputs of the quote (metal, margins, volumes...).
 */
export function rankRoutes(rates, lists, part, settings, quoteBase) {
  const routes = [];
  for (const code of Object.keys(settings.processes)) {
    if (!rates.has(code)) continue;
    for (const finition of settings.processes[code].finitions) {
      if (!rates.has(finition)) continue;
      const route = buildRoute(code, finition, part, settings, rates);
      const q = quote(rates, lists, {
        ...quoteBase,
        poids: part.poids,
        miseAuMille: route.miseAuMille,
        sableKg: route.sableKg,
        tth: part.tth ? quoteBase.tth && quoteBase.tth !== "none" ? quoteBase.tth : "scie" : "none",
        operations: route.operations,
      });
      route.result = q;
      route.prix = q.pri + route.outillagePiece;
      route.ratio = route.prix > 0 ? route.qualite / route.prix : 0;
      routes.push(route);
    }
  }
  routes.sort((a, b) => (a.feasible !== b.feasible ? (a.feasible ? -1 : 1) : b.ratio - a.ratio));
  return routes;
}

function fmt(v) {
  return Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

/** The best route of each island, the `count` best islands first (feasible ones only). */
export function bestRoutes(ranked, count = 3) {
  const seen = new Set();
  const out = [];
  for (const r of ranked) {
    if (!r.feasible || seen.has(r.process)) continue;
    seen.add(r.process);
    out.push(r);
    if (out.length === count) break;
  }
  return out;
}
