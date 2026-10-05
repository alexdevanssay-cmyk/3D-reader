// Costing of a cast part, as the SAB costing workbook does it (sheets
// PRI "Chiffrage" and Chiffrage), recomputed from the data extracted by
// workbook.js and the settings of the page. Pure functions, no DOM.

import { COST_ROWS } from "./workbook.js";

const sum = (values) => values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const idx = Object.fromEntries(COST_ROWS.map((name, i) => [name, i]));

/**
 * Annual costs of each profit centre (PRI "Chiffrage" rows 5 to 17) and its
 * cost per unit of work (row 26, or 33 for the centres costed per kg).
 *
 * settings.modes        {code: "1*8" | "2*8" | "3*8" | "Réel"} (default: the workbook's)
 * settings.evolution    rates of increase (see workbook.js), energy prices
 * settings.annual / invest  per centre overrides of rows 45-51 / 38-42
 *
 * Returns Map code -> {code, name, uo, mode, costs[10], total (row 16),
 * withFees (row 17), fees, units (hours or kg), rate (€/UO), corporateRate,
 * fixedShare (row 20), perUnit: {category: €/UO}}.
 */
export function centreRates(base, settings = {}) {
  const evo = { ...base.evolution, ...settings.evolution };
  const energy = { ...base.energy, ...settings.energy };
  const elec = energy.elecAncien ? energy.elecNouveau / energy.elecAncien - 1 : 0;
  const gaz = energy.gazAncien ? energy.gazNouveau / energy.gazAncien - 1 : 0;

  const rows = base.centres.map((c) => {
    const mode = settings.modes?.[c.code] ?? c.defaultMode;
    const scenario = c.modes[c.source === "reel" ? "Réel" : mode] ?? c.modes["Réel"];
    const annual = { ...c.annual, ...settings.annual?.[c.code] };
    const invest = { ...c.invest, ...settings.invest?.[c.code] };
    const amort = amortization(invest);
    let costs;
    if (c.source === "direct") {
      costs = [...c.direct];
      costs[idx.investissements] = amort;
    } else {
      const b = scenario.costs;
      costs = [
        b[0] * (1 + evo.salaires) + annual.salaires,
        b[1],
        b[2] * (1 + evo.entretien) + annual.entretien,
        b[3] + amort,
        b[4] * (1 + evo.consommables) + annual.consommables,
        b[5] * (1 + elec) + annual.electricite,
        b[6] * (1 + gaz) + annual.gaz,
        b[7] * (1 + evo.autresEnergies) + annual.autresEnergies,
        b[8] * (1 + evo.autres) + annual.prestations,
        b[9] * (1 + evo.autres),
      ];
    }
    const hours = c.fixedHours ?? scenario.hours;
    const kgSold = c.fixedKgSold ?? scenario.kgSold;
    return { c, mode: c.source === "reel" ? "Réel" : mode, costs, total: sum(costs), hours, kgSold };
  });

  // Corporate costs, spread in proportion to the costs of the centres.
  const allTotal = sum(rows.map((r) => r.total));
  const out = new Map();
  for (const r of rows) {
    const fees = allTotal > 0 ? (base.corporate * r.total) / allTotal : 0;
    const withFees = r.total + fees;
    // Unit of work: kg cast (1.8 kg cast per kg sold), kg sold, or hours.
    const units = r.c.uo === "kgCast" ? r.kgSold * 1.8 : r.c.uo === "kgSold" ? r.kgSold : r.hours;
    const per = (v) => (units > 0 ? v / units : 0);
    out.set(r.c.code, {
      code: r.c.code,
      name: r.c.name,
      uo: r.c.uo,
      mode: r.mode,
      costs: r.costs,
      total: r.total,
      withFees,
      fees,
      units,
      hours: r.hours,
      rate: per(withFees),
      corporateRate: per(fees),
      fixedShare: withFees > 0 ? r.c.fixedCost / withFees : 0,
      perUnit: Object.fromEntries(COST_ROWS.map((name, i) => [name, per(r.costs[i])])),
    });
  }
  return out;
}

function amortization({ structure = 0, composant = 0, dureeStructure = 0, dureeComposant = 0 }) {
  return (dureeStructure > 0 ? structure / dureeStructure : 0) + (dureeComposant > 0 ? composant / dureeComposant : 0);
}

// --------------------------------------------------------------------------- metal

/**
 * Average of an index over an averaging window (sheet Chiffrage, cell L73):
 * the months `start` .. `end` before the application month (e.g. "M-1/M-3":
 * the three months before). Returns null when a month is missing.
 */
export function indexAverage(indices, seriesName, month, typology) {
  // Excel's MATCH ignores case and the workbook relies on it ("cash" / "CASH").
  const key = (name) => String(name).trim().toLowerCase().replace(/\s+/g, " ");
  const name = Object.keys(indices?.series ?? {}).find((n) => key(n) === key(seriesName));
  const values = name && indices.series[name];
  const t = indices?.typologies?.find((x) => x.name === typology);
  const at = indices?.months?.indexOf(month) ?? -1;
  if (!values || !t || at < 0) return null;
  const from = at + Math.min(t.start, t.end);
  const to = at + Math.max(t.start, t.end);
  if (from < 0 || to >= values.length) return null;
  const window = values.slice(from, to + 1);
  if (window.some((v) => v === null)) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** Sale metal price (cells L73 + L74): index average, plus the P1020 premium for the P1020-based indices. */
export function saleMetalPrice(indices, lists, { month, typology, index }) {
  const cours = indexAverage(indices, index, month, typology);
  const withP1020 = lists?.coursP1020?.some((n) => n.toLowerCase() === String(index).toLowerCase());
  const p1020 = withP1020 ? indexAverage(indices, "Prime Mb P1020 €", month, typology) : 0;
  return { cours, p1020 };
}

// --------------------------------------------------------------------------- piece

/**
 * Unit of work consumed by one piece in a centre (column K of Chiffrage):
 * kg for the centres costed per kg, hours per piece for the others.
 *   op: {code, cycle (s), parCycle (pieces per cycle), trs (0..1)}
 *   EXP: cycle = time per container (s), parCycle = pieces per container.
 */
export function unitsPerPiece(rate, op, kg) {
  if (rate.uo === "kgCast") return kg.cast;
  if (rate.uo === "kgSold") return kg.tth;
  if (!(op.cycle > 0) || !(op.parCycle > 0)) return 0;
  if (rate.uo === "hour") return op.cycle / (3600 * op.parCycle);
  const trs = op.trs > 0 ? op.trs : 1;
  const perHour = (3600 / op.cycle) * op.parCycle * trs;
  return perHour > 0 ? 1 / perHour : 0;
}

/**
 * Cost price (PRI) and sale price of a piece, by year: the Chiffrage sheet.
 *
 * q (quote): {
 *   poids (kg, piece as sold), miseAuMille (kg cast per kg of piece), sableKg,
 *   tth: "none" | "scie" | "masselotte" (weight treated: the piece, or the piece with its feeder),
 *   tthCoef: cost of the heat treatment chosen / the reference one (T6) of the TTH centre (default 1),
 *   operations: [{code, cycle, parCycle, trs}],
 *   metal: {coursAchat, p1020Achat, premiumAchat, coursVente, p1020Vente, premiumVente, pafAchat, pafVente},
 *   coefDifficulte, vaUsinage, rebutUsinage,
 *   changeover: [{code, heures}], coefSecurite, tailleSerie, nombrePieces,
 *   outillages: [{designation, qte, prix}], margeOutillages,
 *   composants / sousTraitance / emballageInterne / emballageClient: [{designation, qte, prix, marge}],
 *   marge (on value added), evolution: {salaires, conso, elec, gaz, autresEnergies},
 *   years: [first year...], volumes: [per year], productivite: [{va, ca}] per year (optional)
 * }
 */
export function quote(rates, lists, q) {
  const kgCast = q.poids * q.miseAuMille;
  const kg = { cast: kgCast, tth: q.tth === "scie" ? q.poids : q.tth === "masselotte" ? kgCast : 0 };

  // Value added per centre (column J), corporate share (J87), fixed share (J66).
  const lines = [];
  for (const op of q.operations) {
    const rate = rates.get(op.code);
    if (!rate) continue;
    // The TTH centre is costed for the reference treatment (T6): others cost more or less.
    const units = unitsPerPiece(rate, op, kg) * (rate.uo === "kgSold" ? q.tthCoef ?? 1 : 1);
    if (!(units > 0)) continue;
    lines.push({
      code: op.code,
      name: rate.name,
      uo: rate.uo,
      units,
      piecesPerHour: rate.uo === "pph" ? 1 / units : null,
      rate: rate.rate,
      cost: rate.rate * units,
      corporate: rate.corporateRate * units,
      fixed: rate.rate * units * rate.fixedShare,
      perUnit: rate.perUnit,
    });
  }
  const va = sum(lines.map((l) => l.cost));
  const corporate = sum(lines.map((l) => l.corporate));
  const fixed = sum(lines.map((l) => l.fixed));

  // Metal (J73:J79), sand (J81), difficulty (J83), machining scrap (J84).
  const m = q.metal;
  const metalAchat = m.coursAchat + m.p1020Achat + m.premiumAchat;
  const matiere = (q.poids * metalAchat) / 1000;
  const perteAuFeu = (m.pafAchat * kgCast * metalAchat) / 1000;
  const sable = (0.286 + 0.1) * (q.sableKg || 0);
  const coef = lists.coefs.find((c) => c.coef === Number(q.coefDifficulte)) ?? { perteAuFeu: 0, coutsGlobaux: 0 };
  const difficulte = perteAuFeu * coef.perteAuFeu + (va + perteAuFeu) * coef.coutsGlobaux;
  const usinage = (q.vaUsinage || 0) * (q.rebutUsinage || 0);
  const total = va + matiere + perteAuFeu + sable + difficulte;
  const pri = total + usinage;

  // Series changes (I108:G122): hours of each centre at its hourly cost.
  const changeoverLines = (q.changeover ?? [])
    .map((c) => {
      const rate = rates.get(c.code);
      return rate && rate.uo !== "kgCast" && rate.uo !== "kgSold" ? { ...c, cost: rate.rate * (c.heures || 0) } : null;
    })
    .filter(Boolean);
  const changeoverSeries = sum(changeoverLines.map((c) => c.cost)) * (1 + (q.coefSecurite || 0));
  const changeoverPiece = q.tailleSerie > 0 ? changeoverSeries / q.tailleSerie : 0;

  // Specific investments (tooling), components, subcontracting, packaging.
  const outillagesTotal = sum((q.outillages ?? []).map((o) => (o.qte || 0) * (o.prix || 0)));
  const outillagesPiece = q.nombrePieces > 0 ? outillagesTotal / q.nombrePieces : 0;
  const outillages = outillagesPiece * (1 + (q.margeOutillages || 0));
  const list = (items) => ({
    cost: sum((items ?? []).map((i) => (i.qte || 0) * (i.prix || 0))),
    sold: sum((items ?? []).map((i) => (i.qte || 0) * (i.prix || 0) * (1 + (i.marge || 0)))),
  });
  const composants = list(q.composants);
  const sousTraitance = list(q.sousTraitance);
  const emballage = list([...(q.emballageInterne ?? []), ...(q.emballageClient ?? [])]);

  // Cost categories per piece, for the yearly increases (rows 93 to 102).
  const category = (...names) => sum(lines.map((l) => sum(names.map((n) => l.perUnit[n] * l.units))));
  const bases = {
    salaires: category("salaires"),
    conso: category("entretien", "consommables", "prestations"),
    elec: category("electricite"),
    gaz: category("gaz"),
    autresEnergies: category("autresEnergies"),
  };

  // Sale price of the metal (G133:O133) and per piece (I134).
  const metalVente = (m.coursVente + m.p1020Vente + m.premiumVente) * (1 + m.pafVente);
  const vmVendue = (metalVente * q.poids) / 1000;
  const vmPri = matiere + perteAuFeu;
  const marge = q.marge || 0;

  const years = [];
  const level = Object.fromEntries(Object.keys(bases).map((k) => [k, bases[k]]));
  let increases = 0;
  let vaVendue = null;
  q.years.forEach((year, i) => {
    // Increases of the year: each category grows by its own rate, compounded.
    let increase = 0;
    for (const k of Object.keys(bases)) {
      const step = level[k] * (q.evolution?.[k] || 0);
      level[k] += step;
      increase += step;
    }
    increases += increase;
    const vaPri = va + sable + increases + outillages + difficulte + usinage;
    // Value added sold: margin applied the first year, then productivity gains only.
    const prod = q.productivite?.[i] ?? {};
    const previousPrice = years[i - 1]?.prixVente;
    if (vaVendue === null) vaVendue = vaPri / (1 - marge);
    else if (Number.isFinite(prod.va)) vaVendue *= 1 - prod.va;
    else if (Number.isFinite(prod.ca) && previousPrice) vaVendue -= previousPrice * prod.ca;
    const miseEnRouteVendue = changeoverPiece / (1 - marge);
    const miseEnRoutePri = changeoverPiece / (1 + (q.coefSecurite || 0));
    const vaVendueTotale = vaVendue + miseEnRouteVendue;
    const prixVente = vmVendue + vaVendueTotale + composants.sold + sousTraitance.sold + emballage.sold;
    const vaPriTotale = vaPri + miseEnRoutePri;
    const prixPri = vmPri + vaPriTotale + composants.cost + sousTraitance.cost + emballage.cost;
    const margeMatiere = vmVendue - vmPri;
    const margeAutres = composants.sold - composants.cost + (sousTraitance.sold - sousTraitance.cost) + (emballage.sold - emballage.cost);
    // Margin on value added, set-up costs included (rows 155-156).
    const margeVaPure = vaVendueTotale - vaPriTotale;
    const volume = q.volumes?.[i] || 0;
    years.push({
      year,
      volume,
      pri: pri + increases,
      vaPri,
      vaVendue,
      vaVendueTotale,
      vaPriTotale,
      miseEnRouteVendue,
      miseEnRoutePri,
      vmVendue,
      vmPri,
      prixVente,
      prixPri,
      margeMatiere,
      margeVa: margeVaPure,
      margeVaPct: vaVendueTotale > 0 ? margeVaPure / vaVendueTotale : null,
      margeTotale: margeMatiere + margeVaPure + margeAutres,
      margeTotalePct: prixVente > 0 ? (margeMatiere + margeVaPure + margeAutres) / prixVente : null,
      ca: volume * prixVente,
      margeVaAnnuelle: volume * margeVaPure,
    });
  });

  return {
    kgCast,
    lines,
    va,
    corporate,
    fixed,
    variable: va - fixed,
    metalAchat,
    matiere,
    perteAuFeu,
    sable,
    difficulte,
    usinage,
    total,
    pri,
    changeoverLines,
    changeoverSeries,
    changeoverPiece,
    outillages, // tooling amortised per piece (in the value added: it carries its margin)
    outillagesTotal,
    composants,
    sousTraitance,
    emballage,
    metalVente,
    vmVendue,
    bases,
    years,
  };
}

/**
 * Margin on value added that gives `target` (e.g. 0.10) as the value-added
 * margin of the first year with a volume: the "Calcul mini" macro (goal seek).
 */
export function minimumMargin(rates, lists, q, target) {
  return solveMargin((m) => {
    const r = quote(rates, lists, { ...q, marge: m });
    const y = r.years.find((x) => x.volume > 0) ?? r.years[0];
    return y?.margeVaPct ?? 0;
  }, target);
}

/** The margin m for which evaluate(m) = target (increasing in m), by bisection; null if out of reach. */
export function solveMargin(evaluate, target) {
  let lo = -0.9;
  let hi = 0.95;
  if (evaluate(hi) < target || evaluate(lo) > target) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (evaluate(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
