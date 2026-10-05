// Choice of the manufacturing route of a cast part: casting island (die
// casting, low pressure, gravity die casting chantiers) and finishing method,
// with the operations around them. Every feasible route is costed with the
// costing model, then ranked by quality / price.
//
// The capabilities of the islands and the cycle-time coefficients below are
// starting values: they are settings of the page (Paramètres), meant to be
// adjusted to the real islands of the foundry.

import { quote } from "./model.js";

// Casting islands (codes of the profit centres of the workbook).
export const DEFAULT_PROCESSES = {
  SSP: {
    famille: "Sous pression",
    toileMin: 1, toileMax: 8, poidsMax: 12, dimMax: 600, volumeMin: 5000,
    empreintesMax: 4, grappeMax: 15, miseAuMille: 1.3, qualite: 6,
    tth: false, noyaux: false, finitions: ["FSP"], outillage: 60000,
    cycle: { base: 25, parKg: 3, parModule2: 3 },
  },
  BPR: {
    famille: "Basse pression",
    toileMin: 3, toileMax: 25, poidsMax: 40, dimMax: 800, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 60, miseAuMille: 1.25, qualite: 9,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 35000,
    cycle: { base: 120, parKg: 4, parModule2: 12 },
  },
  CG1: {
    famille: "Coquille gravité (DFP5 New look)",
    toileMin: 3.5, toileMax: 30, poidsMax: 25, dimMax: 600, volumeMin: 1000,
    empreintesMax: 2, grappeMax: 50, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    cycle: { base: 90, parKg: 6, parModule2: 10 },
  },
  CG2: {
    famille: "Coquille gravité (Gauss 2)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    cycle: { base: 80, parKg: 6, parModule2: 10 },
  },
  CG4: {
    famille: "Coquille gravité (SAB Auto)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    cycle: { base: 80, parKg: 6, parModule2: 10 },
  },
  CG5: {
    famille: "Coquille gravité (Gauss 1)",
    toileMin: 3.5, toileMax: 30, poidsMax: 15, dimMax: 450, volumeMin: 2000,
    empreintesMax: 2, grappeMax: 30, miseAuMille: 1.6, qualite: 8,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 20000,
    cycle: { base: 80, parKg: 6, parModule2: 10 },
  },
  CG3: {
    famille: "Coquille gravité (traditionnel)",
    toileMin: 4, toileMax: 40, poidsMax: 60, dimMax: 1000, volumeMin: 0,
    empreintesMax: 1, grappeMax: 100, miseAuMille: 1.8, qualite: 7.5,
    tth: true, noyaux: true, finitions: ["FCE", "FTR"], outillage: 10000,
    cycle: { base: 150, parKg: 10, parModule2: 12 },
  },
};

// Other operations: cycle = base + parKg * piece weight (s), pieces per cycle.
export const DEFAULT_OPERATIONS = {
  ASN: { label: "Noyautage", base: 40, parKg: 10, parCycle: 1 },
  DEG: { label: "Dégotage", base: 20, parKg: 5, parCycle: 1 },
  FSP: { label: "Finition sous pression", base: 15, parKg: 4, parCycle: 1 },
  FCE: { label: "Finition cellules", base: 30, parKg: 6, parCycle: 1, volumeMin: 3000 },
  FTR: { label: "Finition traditionnelle", base: 60, parKg: 15, parCycle: 1 },
  TRI: { label: "Tribofinition", base: 1200, parKg: 0, parCycle: 0, chargeKg: 60 },
  RED: { label: "Redressage", base: 30, parKg: 5, parCycle: 1 },
  GCV: { label: "Grenaillage / contrôle visuel", base: 10, parKg: 2, parCycle: 1 },
  EXP: { label: "Expédition", base: 600, parKg: 0, parCycle: 0, chargeKg: 250, maxPieces: 500 },
};

export const DEFAULT_TRS = {
  SSP: 0.8, BPR: 0.8, CG1: 0.8, CG2: 0.8, CG4: 0.8, CG5: 0.8, CG3: 0.75,
  ASN: 0.85, DEG: 0.9, FSP: 0.85, FCE: 0.85, FTR: 0.9, TRI: 0.9, RED: 0.9, GCV: 0.9,
};

/**
 * Operations and parameters of one route.
 *   part: {poids, moduleMm (volume / area), toileMini, epaisseurMax, dimMax,
 *          volumeAnnuel, tth, noyaux, tribo, redressage, sableKg}
 *   settings: {processes, operations, trs}
 * Returns {process, finition, operations, miseAuMille, parCycle, cycle, sableKg,
 *          feasible, reasons[], warnings[], qualite, outillagePiece}.
 */
export function buildRoute(code, finition, part, settings, rates) {
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

  const miseAuMille = p.miseAuMille;
  const kgCast = part.poids * miseAuMille;
  const parCycle = Math.max(1, Math.min(p.empreintesMax, Math.floor(p.grappeMax / Math.max(kgCast, 1e-9))));
  const cycle = p.cycle.base + p.cycle.parKg * kgCast * parCycle + p.cycle.parModule2 * (part.moduleMm || 0) ** 2;
  const simple = (c) => ({ code: c, cycle: ops[c].base + ops[c].parKg * part.poids, parCycle: ops[c].parCycle || 1, trs: trs(c) });
  const batch = (c) => {
    const o = ops[c];
    const n = Math.max(1, Math.min(o.maxPieces ?? Infinity, Math.floor(o.chargeKg / Math.max(part.poids, 1e-9))));
    return { code: c, cycle: o.base, parCycle: n, trs: trs(c) };
  };

  const operations = [{ code: "ASF" }];
  if (part.noyaux) operations.push(simple("ASN"));
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
  return {
    process: code,
    famille: p.famille,
    finition,
    operations,
    miseAuMille,
    parCycle,
    cycle,
    sableKg: part.noyaux ? part.sableKg || 0 : 0,
    feasible: reasons.length === 0,
    reasons,
    warnings,
    qualite: Math.max(0, Math.min(10, qualite)),
    outillagePiece: total > 0 ? p.outillage / total : 0,
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
