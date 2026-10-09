// Costing module (web/chiffrage/): reading the costing workbook, cost rates
// of the profit centres, quote of a part, choice of the manufacturing route.
// On a made-up workbook with the layout of the real one (costing-fixture.mjs).
//
//   node --test tests/js/costing.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { readCostingWorkbook, readIndicesWorkbook } from '../../web/chiffrage/workbook.js';
import { centreRates, indexAverage, minimumMargin, quote, saleMetalPrice } from '../../web/chiffrage/model.js';
import { DEFAULT_OPERATIONS, DEFAULT_PROCESSES, DEFAULT_TRS, bestRoutes, buildRoute, castingCycle, cavityChoices, estimateMiseAuMille, rankRoutes } from '../../web/chiffrage/routes.js';
import { readWorkbook } from '../../web/chiffrage/xlsxread.js';
import { filledFields, heatTreatmentOf, orderValues, programmeFor, programmeOf, readSeriesOrder } from '../../web/chiffrage/rfq.js';
import { DEFAULT_TOOLING, cavityFactor, coefOf, estimateTooling, steelToolCost } from '../../web/chiffrage/tooling.js';
import { DEFAULT_CORES, boxSize, coreBoxCost, coresPerPiece } from '../../web/chiffrage/cores.js';
import {
  DEFAULT_DENSITIES, GENERIC_DENSITY, adoptTendance, clearSaisies, clearSetting, clearTendances, currentQuoteTab, defaultQuote, defaultSettings, exportSaisies, importTendances,
  loadQuote, loadSettings, loadSettingsLayers, mergeSettings, migrateSettings, saveBase, saveIndices, saveQuote, setQuoteTab, setSetting, validateTendances,
} from '../../web/chiffrage/store.js';
import { DEMANDE, QUOTE_KEYS, SOURCES, demandeComparee, derive, missing, pieceKeys, resolve, summarize, traced, weakest } from '../../web/chiffrage/provenance.js';
import { MASQUE, checkNumbers, isInternal, maskNumbers, numbersOf, traceForAI } from '../../web/chiffrage/ai-trace.js';
import { anonymizer } from '../../web/engine/ai-context.js';
import { checkProposals, readProposals, sameValue } from '../../web/chiffrage/ai-apply.js';
import {
  seriesOrderWorkbook,
  CENTRES, CORPORATE, DEFAULT_MODES, DIRECT_TRI, EXP_HOURS, HOURS, KG_SOLD, TRI_HOURS, TRI_INVEST,
  baseCost, costingWorkbook, indicesWorkbook, writeWorkbook,
} from './costing-fixture.mjs';

const close = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `${what}: ${actual} instead of ${expected}`);

const { base, indices } = readCostingWorkbook(costingWorkbook(), 'test.xlsm');
const settings = { processes: DEFAULT_PROCESSES, operations: DEFAULT_OPERATIONS, trs: DEFAULT_TRS };

/** Expected annual costs of every centre, straight from the fixture and the rules of PRI "Chiffrage". */
function expectedCosts(modes = {}) {
  return CENTRES.map(([code, , kind], i) => {
    const mode = kind === 'reel' ? 'Réel' : modes[code] ?? DEFAULT_MODES[code] ?? 'Réel';
    let costs;
    if (kind === 'direct') {
      costs = [...DIRECT_TRI];
      costs[3] = TRI_INVEST.structure / TRI_INVEST.duree;
    } else {
      costs = Array.from({ length: 10 }, (_, k) => baseCost(i, k, mode));
      costs[0] *= 1.1; // salaries +10 %
      costs[5] *= 2; // electricity 50 -> 100 €/MWh
    }
    const total = costs.reduce((a, b) => a + b, 0);
    const units = code === 'ASF' ? KG_SOLD * 1.8 : code === 'TTH' ? KG_SOLD : kind === 'direct' ? TRI_HOURS : kind === 'reel' ? EXP_HOURS : HOURS[mode];
    return { code, mode, total, units };
  });
}

describe('costing workbook', () => {
  test('profit centres, units of work, sources of the costs', () => {
    assert.deepEqual(base.centres.map((c) => c.code), CENTRES.map(([code]) => code));
    const by = Object.fromEntries(base.centres.map((c) => [c.code, c]));
    assert.equal(by.ASF.uo, 'kgCast');
    assert.equal(by.TTH.uo, 'kgSold');
    assert.equal(by.EXP.uo, 'hour');
    assert.equal(by.SSP.uo, 'pph');
    assert.equal(by.TRI.source, 'direct');
    assert.equal(by.EXP.source, 'reel');
    assert.equal(by.SSP.source, 'modes');
    assert.equal(by.SSP.defaultMode, '2*8');
    assert.equal(by.CG3.defaultMode, 'Réel');
    assert.equal(by.TRI.fixedHours, TRI_HOURS);
    assert.equal(by.EXP.fixedHours, EXP_HOURS);
    assert.equal(by.SSP.fixedHours, null);
    assert.equal(by.SSP.name, 'Sous Pression');
    assert.equal(base.corporate, CORPORATE);
    assert.deepEqual(base.lists.alliages, ['AS7G03', 'AS9U3']);
    assert.deepEqual(base.lists.coefs.map((c) => c.coef), [-2, 0, 2]);
    assert.equal(base.defaults.marge, 0.12);
    assert.deepEqual(base.defaults.changeover, [{ code: 'CG3', heures: 8 }, { code: 'FCE', heures: 1 }]);
  });

  test('metal price indices: months, series, averaging windows', () => {
    assert.equal(indices.months.length, 12);
    assert.equal(indices.months[0], '2025-01');
    assert.equal(indices.months.at(-1), '2025-12');
    assert.deepEqual(indices.typologies.map((t) => t.name), ['M-1', 'M-1/M-3', 'Année N-1']);
    // M-1/M-3 for June: March, April, May.
    assert.equal(indexAverage(indices, 'LME primary Alloy cash seller', '2025-06', 'M-1/M-3'), 2040);
    assert.equal(indexAverage(indices, 'LME primary Alloy cash seller', '2025-06', 'M-1'), 2050);
    // Not enough months before, or no value: no price.
    assert.equal(indexAverage(indices, 'LME primary Alloy cash seller', '2025-06', 'Année N-1'), null);
    assert.equal(indexAverage(indices, 'MB Free market DIN 226', '2025-09', 'M-1'), null);
    // The P1020 premium is added for the indices of the "Cours avec P1020" list only.
    assert.deepEqual(saleMetalPrice(indices, base.lists, { month: '2025-06', typology: 'M-1/M-3', index: 'LME primary Alloy cash seller' }), { cours: 2040, p1020: 320 });
    assert.deepEqual(saleMetalPrice(indices, base.lists, { month: '2025-04', typology: 'M-1', index: 'MB Free market DIN 226' }), { cours: 1803, p1020: 0 });
  });

  test('a separate prices file replaces the indices of the workbook', () => {
    const other = readIndicesWorkbook(indicesWorkbook(100));
    assert.equal(indexAverage(other, 'LME primary Alloy cash seller', '2025-06', 'M-1/M-3'), 2140);
    assert.throws(() => readIndicesWorkbook(writeWorkbook({ Feuil1: { A1: 1 } })), /Suivi indice/);
  });

  test('another workbook is refused with the missing sheets', () => {
    assert.throws(() => readCostingWorkbook(writeWorkbook({ Feuil1: { A1: 1 } })), /PRI "Chiffrage"/);
    assert.throws(() => readCostingWorkbook(new Uint8Array([1, 2, 3])), /classeur Excel/);
  });

  test('cells: shared strings, numbers, formulas and their cached results', () => {
    const wb = readWorkbook(costingWorkbook());
    const pri = wb.sheet('PRI "Chiffrage"');
    assert.equal(pri.get('D3'), 'DEG');
    assert.equal(wb.formulas('PRI "Chiffrage"').get('O24'), '2*8*228');
    assert.equal(pri.get('O24'), TRI_HOURS);
  });
});

describe('cost rates of the profit centres', () => {
  test('annual costs, corporate share and rate per unit of work', () => {
    const rates = centreRates(base);
    const expected = expectedCosts();
    const sumTotal = expected.reduce((a, e) => a + e.total, 0);
    for (const e of expected) {
      const r = rates.get(e.code);
      const fees = (CORPORATE * e.total) / sumTotal;
      close(r.total, e.total, 1e-12, `${e.code} costs`);
      close(r.fees, fees, 1e-12, `${e.code} corporate`);
      close(r.rate, (e.total + fees) / e.units, 1e-12, `${e.code} rate`);
      close(r.corporateRate, fees / e.units, 1e-12, `${e.code} corporate rate`);
      assert.equal(r.mode, e.mode, e.code);
    }
  });

  test('the working mode changes the costs and the hours of a centre', () => {
    const modes = { SSP: '1*8', CG3: '3*8' };
    const rates = centreRates(base, { modes });
    const expected = expectedCosts(modes);
    const sumTotal = expected.reduce((a, e) => a + e.total, 0);
    for (const code of ['SSP', 'CG3']) {
      const e = expected.find((x) => x.code === code);
      close(rates.get(code).rate, (e.total * (1 + CORPORATE / sumTotal)) / e.units, 1e-12, code);
      assert.equal(rates.get(code).hours, e.units);
    }
  });

  test('energy prices and investments of the settings', () => {
    const rates = centreRates(base, { energy: { elecNouveau: 50 }, invest: { CG3: { structure: 70000, dureeStructure: 7 } } });
    const i = CENTRES.findIndex(([c]) => c === 'CG3');
    // Electricity back to its old price, plus 10 000 € of depreciation a year.
    close(rates.get('CG3').costs[5], baseCost(i, 5, 'Réel'), 1e-12, 'electricity');
    close(rates.get('CG3').costs[3], baseCost(i, 3, 'Réel') + 10000, 1e-12, 'depreciation');
  });
});

describe('quote of a part', () => {
  const rates = centreRates(base);
  const metal = { coursAchat: 2500, p1020Achat: 300, premiumAchat: 350, coursVente: 2040, p1020Vente: 320, premiumVente: 600, pafAchat: 0.06, pafVente: 0.08 };
  const input = {
    poids: 2, miseAuMille: 1.5, sableKg: 0.5, tth: 'scie',
    operations: [
      { code: 'ASF' },
      { code: 'CG3', cycle: 240, parCycle: 2, trs: 0.8 },
      { code: 'FCE', cycle: 60, parCycle: 1, trs: 0.9 },
      { code: 'TTH' },
      { code: 'EXP', cycle: 600, parCycle: 50 },
    ],
    metal, coefDifficulte: 2, vaUsinage: 10, rebutUsinage: 0.02,
    changeover: [{ code: 'CG3', heures: 8 }, { code: 'FCE', heures: 1 }], coefSecurite: 0.1, tailleSerie: 1000, nombrePieces: 10000,
    composants: [{ designation: 'Insert', qte: 2, prix: 0.5, marge: 0.1 }],
    marge: 0.12, evolution: { salaires: 0.015, conso: 0.02 }, years: [2026, 2027], volumes: [5000, 5000],
  };
  const r = quote(rates, base.lists, input);
  const rate = (code) => rates.get(code).rate;

  test('value added per centre: kg, pieces per hour, hours per container', () => {
    const cost = Object.fromEntries(r.lines.map((l) => [l.code, l.cost]));
    close(cost.ASF, rate('ASF') * 3, 1e-12, 'melting: 3 kg cast');
    close(cost.CG3, rate('CG3') / ((3600 / 240) * 2 * 0.8), 1e-12, 'casting: 24 pieces an hour');
    close(cost.FCE, rate('FCE') / ((3600 / 60) * 0.9), 1e-12, 'finishing');
    close(cost.TTH, rate('TTH') * 2, 1e-12, 'heat treatment of the sawn part');
    close(cost.EXP, (rate('EXP') * 600) / 3600 / 50, 1e-12, 'shipping');
    close(r.va, Object.values(cost).reduce((a, b) => a + b, 0), 1e-12, 'VA PRI');
  });

  test('metal, loss on melting, sand, difficulty, machining scrap: the PRI', () => {
    close(r.matiere, (2 * 3150) / 1000, 1e-12, 'metal');
    close(r.perteAuFeu, (0.06 * 3 * 3150) / 1000, 1e-12, 'loss on melting');
    close(r.sable, 0.386 * 0.5, 1e-12, 'sand');
    // Coefficient 2 of the list: 16 % of the loss on melting, 2 % of VA + loss.
    close(r.difficulte, r.perteAuFeu * 0.16 + (r.va + r.perteAuFeu) * 0.02, 1e-12, 'difficulty');
    close(r.usinage, 0.2, 1e-12, 'machining scrap');
    close(r.pri, r.va + r.matiere + r.perteAuFeu + r.sable + r.difficulte + 0.2, 1e-12, 'PRI');
  });

  test('sale price: metal sold, value added with its margin, set-up, components', () => {
    const y = r.years[0];
    const series = (rate('CG3') * 8 + rate('FCE') * 1) * 1.1;
    close(r.changeoverPiece, series / 1000, 1e-12, 'series change per piece');
    close(y.vmVendue, ((2040 + 320 + 600) * 1.08 * 2) / 1000, 1e-12, 'metal sold');
    close(y.vaVendue, y.vaPri / 0.88, 1e-12, 'value added sold');
    close(y.prixVente, y.vmVendue + y.vaVendue + r.changeoverPiece / 0.88 + 2 * 0.5 * 1.1, 1e-12, 'sale price');
    // Margin on value added, set-up costs included (sold with the margin, cost without the safety coefficient).
    const sold = y.vaVendue + r.changeoverPiece / 0.88;
    const cost = y.vaPri + r.changeoverPiece / 1.1;
    close(y.margeVaPct, (sold - cost) / sold, 1e-12, 'margin on VA');
    close(y.ca, 5000 * y.prixVente, 1e-12, 'turnover');
  });

  test('yearly increases: salaries and consumables grow, the sale price stays', () => {
    const [a, b] = r.years;
    close(b.pri - a.pri, (r.bases.salaires * 1.015 * 0.015) + (r.bases.conso * 1.02 * 0.02), 1e-9, 'second year');
    close(a.pri - r.pri, r.bases.salaires * 0.015 + r.bases.conso * 0.02, 1e-9, 'first year');
    close(b.prixVente, a.prixVente, 1e-12, 'price');
  });

  test('minimum margin: the margin that gives the target margin on value added', () => {
    const m = minimumMargin(rates, base.lists, input, 0.1);
    const y = quote(rates, base.lists, { ...input, marge: m }).years[0];
    close(y.margeVaPct, 0.1, 1e-9, 'first year margin');
  });
});

describe('mise au mille from the geometry', () => {
  const p = DEFAULT_PROCESSES.CG3;
  test('thin and thick walls, small parts: lower yield, higher mise au mille', () => {
    const plain = estimateMiseAuMille(p, { poids: 4, toileMini: 6, epaisseurMax: 6 });
    close(plain.rendement, p.rendement.base, 1e-12, 'uniform walls, 4 kg: the typical yield');
    close(plain.value, 1 / p.rendement.base, 1e-12, 'mise au mille');
    const hot = estimateMiseAuMille(p, { poids: 4, toileMini: 5, epaisseurMax: 20 });
    close(hot.rendement, p.rendement.base - 2 * p.rendement.parDoublement, 1e-12, 'two doublings of thickness');
    const small = estimateMiseAuMille(p, { poids: 0.5, toileMini: 5, epaisseurMax: 5 });
    close(small.rendement, p.rendement.base - p.rendement.petitePiece * Math.log(4), 1e-12, 'small part');
    assert.ok(hot.value > plain.value && small.value > plain.value);
  });

  test('yield kept within 30 % .. 95 %, default without wall thickness', () => {
    close(estimateMiseAuMille(p, { poids: 0.01, toileMini: 1, epaisseurMax: 1000 }).rendement, 0.3, 1e-12, 'floor');
    const none = estimateMiseAuMille(p, { poids: 2, toileMini: 0, epaisseurMax: 0 });
    assert.equal(none.estimated, false);
    assert.equal(none.value, p.miseAuMille);
  });
});

describe('manufacturing routes', () => {
  const rates = centreRates(base);
  const quoteBase = {
    metal: { coursAchat: 2500, p1020Achat: 300, premiumAchat: 350, coursVente: 2040, p1020Vente: 320, premiumVente: 600, pafAchat: 0.06, pafVente: 0.08 },
    coefDifficulte: 0, vaUsinage: 0, rebutUsinage: 0, changeover: [], marge: 0.12, evolution: {}, years: [2026], volumes: [10000],
  };
  const part = { poids: 1.2, moduleMm: 3, toileMini: 5, epaisseurMax: 10, dimMax: 250, volumeAnnuel: 10000 };

  test('a thin-walled part can only be die cast', () => {
    const ranked = rankRoutes(rates, base.lists, { ...part, toileMini: 2.5, epaisseurMax: 6 }, settings, quoteBase);
    assert.deepEqual([...new Set(ranked.filter((r) => r.feasible).map((r) => r.process))], ['SSP']);
    const gravity = ranked.find((r) => r.process === 'CG3');
    assert.match(gravity.reasons.join(), /toile mini 2,5 mm < 4 mm/);
  });

  test('heat treatment or sand cores: no die casting', () => {
    for (const option of [{ tth: true }, { noyaux: true, sableKg: 0.3 }]) {
      const ranked = rankRoutes(rates, base.lists, { ...part, ...option }, settings, quoteBase);
      assert.ok(ranked.filter((r) => r.process === 'SSP').every((r) => !r.feasible), JSON.stringify(option));
      assert.ok(ranked.some((r) => r.feasible));
    }
    const route = buildRoute('CG3', 'FTR', { ...part, noyaux: true, sableKg: 0.3, tth: true }, settings, rates);
    assert.deepEqual(route.operations.map((o) => o.code), ['ASF', 'ASN', 'CG3', 'DEG', 'FTR', 'TTH', 'GCV', 'EXP']);
  });

  test('a heavy part is out of reach of the small islands', () => {
    const ranked = rankRoutes(rates, base.lists, { ...part, poids: 30, dimMax: 700 }, settings, quoteBase);
    const feasible = new Set(ranked.filter((r) => r.feasible).map((r) => r.process));
    assert.deepEqual([...feasible].sort(), ['BPR', 'CG3']);
  });

  test('the three best solutions: three different islands, by quality / price', () => {
    const ranked = rankRoutes(rates, base.lists, part, settings, quoteBase);
    const best = bestRoutes(ranked, 3);
    assert.equal(best.length, 3);
    assert.equal(new Set(best.map((r) => r.process)).size, 3);
    for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].ratio >= best[i].ratio);
    for (const r of best) close(r.ratio, r.qualite / (r.result.pri + r.outillagePiece), 1e-12, r.process);
  });

  test('cycle time and cavities from the weight cast and the modulus', () => {
    const p = DEFAULT_PROCESSES.CG3;
    const route = buildRoute('CG3', 'FTR', part, settings, rates);
    assert.equal(route.parCycle, 1);
    close(route.cycle, p.cycle.base + p.cycle.parKg * (part.poids * route.miseAuMille) ** p.cycle.exposant + p.cycle.parModule2 * 9, 1e-12, 'cycle');
    // A power law: 200 x (kg cast per cycle)^0.5, 10 kg cast per cycle.
    const power = { ...settings, processes: { ...settings.processes, CG3: { ...p, miseAuMille: 2, cycle: { base: 0, parKg: 200, exposant: 0.5, parModule2: 0 } } } };
    const cg = buildRoute('CG3', 'FTR', { ...part, poids: 5, toileMini: 0, epaisseurMax: 0 }, power, rates);
    close(cg.cycle, 200 * Math.sqrt(10), 1e-9, 'power law cycle');
    // Without an exponent (settings of earlier versions), linear in the weight cast.
    const linear = buildRoute('CG3', 'FTR', part, { ...settings, processes: { ...settings.processes, CG3: { ...p, cycle: { base: 100, parKg: 10, parModule2: 0 } } } }, rates);
    close(linear.cycle, 100 + 10 * part.poids * linear.miseAuMille, 1e-12, 'linear cycle');
    const ssp = buildRoute('SSP', 'FSP', { ...part, poids: 0.5 }, settings, rates);
    assert.equal(ssp.parCycle, 4); // limited by the number of cavities, not by the shot weight
    assert.equal(ssp.operations.find((o) => o.code === 'SSP').trs, DEFAULT_TRS.SSP);
  });

  test('more cavities chosen: a longer cycle for more pieces, so less time per piece; past the island, told', () => {
    const p = DEFAULT_PROCESSES.CG3;
    const estimate = buildRoute('CG3', 'FTR', part, settings, rates);
    assert.deepEqual([estimate.parCycle, estimate.parCycleEstime, estimate.alertesEmpreintes], [1, 1, []]);
    const kgCast = part.poids * estimate.miseAuMille;
    let previous = estimate;
    for (const n of [2, 3, 4]) {
      const r = buildRoute('CG3', 'FTR', part, settings, rates, { empreintes: n });
      const casting = r.operations.find((o) => o.code === 'CG3');
      assert.deepEqual([r.parCycle, r.parCycleEstime, casting.parCycle], [n, 1, n]);
      // The cycle of the cluster of n pieces: the formula of the island for n times the weight cast.
      close(r.cycle, castingCycle(p, kgCast, n, part.moduleMm), 1e-12, `cycle, ${n} cavities`);
      assert.equal(casting.cycle, r.cycle);
      assert.ok(r.cycle > previous.cycle && r.cycle / n < previous.cycle / previous.parCycle, `${n} cavities: a longer cycle, less time per piece`);
      assert.deepEqual(r.alertesEmpreintes, [`${n} empreintes > 1 maxi de l'îlot`]);
      assert.ok(r.warnings.includes(r.alertesEmpreintes[0]) && r.feasible);
      previous = r;
    }
    // The estimate chosen as such: the same route.
    const same = buildRoute('CG3', 'FTR', part, settings, rates, { empreintes: 1 });
    assert.deepEqual([same.cycle, same.outillage, same.warnings], [estimate.cycle, estimate.outillage, estimate.warnings]);
    // Past the cluster of the island.
    const heavy = buildRoute('CG3', 'FTR', { ...part, poids: 40 }, settings, rates, { empreintes: 2 });
    assert.match(heavy.alertesEmpreintes.join(), /^2 empreintes > 1 maxi de l'îlot,grappe [\d,\s\u202f]+ kg > 100 kg maxi$/);
    // The cavities compared in the page: 1 to the maximum of the island (at least 4, at most 8), and those chosen.
    assert.deepEqual(cavityChoices(p, 1), [1, 2, 3, 4]);
    assert.deepEqual(cavityChoices(DEFAULT_PROCESSES.SSP, 4, 6), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(cavityChoices({ ...p, empreintesMax: 12 }, 1).length, 8);
  });
});

describe('series order of a customer request', () => {
  test('volumes per year, order quantities, target price and identification', () => {
    const order = readSeriesOrder(seriesOrderWorkbook(), 'rfq.xlsm');
    assert.equal(order.client, 'ACME RAIL');
    assert.equal(order.reference, 'AB-123 - SUPPORT PLATE');
    assert.equal(order.plan, 'AB-123 ind A');
    assert.equal(order.offre, 'GTEST-CG-2026-00');
    assert.equal(order.fonderie, 'CG');
    assert.deepEqual(order.moqs, [2000, 500, 50]);
    assert.equal(order.targetPrice, 30);
    assert.equal(order.elec, 150);
    assert.equal(order.gaz, 60);
    assert.deepEqual(programmeOf(order), { premiereAnnee: 2027, annees: 4, volumes: [1000, 1500, 1500, 800], pic: 1500 });
    assert.equal(order.prototype, false);
    assert.deepEqual(programmeOf(order, { proto: true }), { premiereAnnee: 2026, annees: 1, volumes: [20], pic: 20 });
    assert.deepEqual(order.matiere, {
      alliage: 'AS9U3', typologie: 'M-1', cours: 'LME primary Alloy cash seller', month: '2026-03',
      coursAchat: 2800, coursVente: 2810, p1020Achat: 400, p1020Vente: 410, premiumAchat: 330, premiumVente: 640, pafAchat: 0.05, pafVente: 0.07,
    });
    // Weights, mise au mille and machining scrap rate: compared with the costing, not applied.
    assert.deepEqual([order.poidsBrut, order.poidsVendu, order.miseAuMille, order.rebutUsinage], [1.25, 1.1, 1.6, 0.03]);
  });

  test('weights, mise au mille and scrap rate: units of the request, absent values', () => {
    // A mise au mille per tonne of pieces, a scrap rate in percent; empty or 0 weights: not given.
    let order = readSeriesOrder(seriesOrderWorkbook({ go: { B62: 0 }, foundry: { D30: 'à définir', D31: 1450, D32: 2.5 } }));
    assert.deepEqual([order.poidsBrut, order.poidsVendu, order.miseAuMille, order.rebutUsinage], [null, null, 1.45, 0.025]);
    // A scrap rate of 0 is a value; labels with "d'usinage".
    order = readSeriesOrder(seriesOrderWorkbook({ foundry: { C32: "Taux de rebut d'usinage", D32: 0 } }));
    assert.equal(order.rebutUsinage, 0);
    // A request without foundry quote: nothing.
    order = readSeriesOrder(writeWorkbook({ '1- Données GO NO GO': { A20: 'Nom du client *', B20: 'X' } }));
    assert.deepEqual([order.poidsBrut, order.poidsVendu, order.miseAuMille, order.rebutUsinage, order.matiere], [null, null, null, null, null]);
  });

  test('what a request fills in a quote, and the fields still holding its values', () => {
    const order = readSeriesOrder(seriesOrderWorkbook(), 'rfq.xlsm');
    const lists = { alliages: base.lists.alliages, typologies: indices.typologies.map((t) => t.name), cours: base.lists.cours };
    const values = orderValues(order, lists);
    assert.deepEqual(values, {
      prototype: false, premiereAnnee: 2027, annees: 4, volumes: [1000, 1500, 1500, 800], volumeAnnuel: 1500, moqs: [2000, 500, 50], tailleSerie: 1500,
      prixCible: 30, client: 'ACME RAIL', reference: 'AB-123', designation: 'SUPPORT PLATE', plan: 'AB-123 ind A',
      alliage: 'AS9U3', typologie: 'M-1', cours: 'LME primary Alloy cash seller', month: '2026-03',
      coursAchat: 2800, p1020Achat: 400, premiumAchat: 330, premiumVente: 640, pafAchat: 0.05, pafVente: 0.07,
    });
    // An alloy out of the list of the workbook: not written (the quote keeps its own).
    assert.equal('alliage' in orderValues({ ...order, alliage: 'AS5Z', matiere: { ...order.matiere, alliage: 'AS5Z' } }, lists), false);
    // Never the weight, the mise au mille or the scrap rate: compared only.
    for (const k of ['poids', 'miseAuMille', 'rebutUsinage', 'poidsBrut', 'poidsVendu']) assert.ok(!(k in values), k);
    const q = { ...defaultQuote(base, indices), ...structuredClone(values) };
    assert.deepEqual(filledFields(q, values), Object.keys(values));
    // Changed since: no longer the request's.
    q.client = 'ACME';
    q.volumes[1] = 1600;
    q.alliage = 'AS7G03';
    assert.deepEqual(filledFields(q, values), Object.keys(values).filter((k) => !['client', 'volumes', 'alliage'].includes(k)));
  });

  test('prototypes or series: only the volumes of the request change, never volumes typed in', () => {
    const order = readSeriesOrder(seriesOrderWorkbook(), 'rfq.xlsm');
    const series = programmeOf(order);
    const proto = programmeOf(order, { proto: true });
    const q = { ...defaultQuote(base, indices), ...orderValues(order) };
    // The series volumes of the request: the prototype ones replace them, and back.
    assert.deepEqual(programmeFor(q, order, true), { programme: proto, typed: false });
    const asProto = { ...q, premiereAnnee: proto.premiereAnnee, annees: proto.annees, volumes: proto.volumes, volumeAnnuel: proto.pic };
    assert.deepEqual(programmeFor(asProto, order, false), { programme: series, typed: false });
    // Already those of the mode: nothing to do.
    assert.deepEqual(programmeFor(q, order, false), { programme: null, typed: false });
    // A volume typed in: kept, the request's not applied.
    const typed = { ...q, volumes: [1000, 1600, 1500, 800] };
    assert.deepEqual(programmeFor(typed, order, true), { programme: null, typed: true, ignored: proto });
    // An annual volume typed in (no volumes per year), another first year: kept too.
    assert.equal(programmeFor({ ...q, volumes: null, volumeAnnuel: 1200 }, order, true).typed, true);
    assert.equal(programmeFor({ ...q, premiereAnnee: 2028 }, order, true).typed, true);
    // The volumes per year saved as the annual volume every year: the request's when they are equal.
    const flat = { ...defaultQuote(base, indices), premiereAnnee: 2026, annees: 1, volumes: null, volumeAnnuel: 20 };
    assert.deepEqual(programmeFor(flat, order, false), { programme: series, typed: false });
    // No request, or no volume of that kind: nothing.
    assert.deepEqual(programmeFor(q, null, true), { programme: null, typed: false });
    const noProto = { ...order, years: order.years.map((y) => ({ ...y, proto: 0 })) };
    assert.deepEqual(programmeFor(q, noProto, true), { programme: null, typed: false });
  });

  test('another workbook is refused with the reason', () => {
    assert.throws(() => readSeriesOrder(costingWorkbook()), /pas une demande client/);
  });

  test('a smaller order quantity carries more changeover per piece', () => {
    const wb = readCostingWorkbook(costingWorkbook());
    const rates = centreRates(wb.base, {});
    const input = (tailleSerie) => ({
      metal: { coursAchat: 2500, p1020Achat: 0, premiumAchat: 0, coursVente: 2500, p1020Vente: 0, premiumVente: 0, pafAchat: 0.06, pafVente: 0.08 },
      poids: 1, miseAuMille: 2, coefDifficulte: 0, vaUsinage: 0, rebutUsinage: 0,
      operations: [], changeover: [{ code: wb.base.centres.find((c) => c.uo === 'pph').code, heures: 8 }], coefSecurite: 0.1,
      tailleSerie, nombrePieces: 5000, composants: [], marge: 0.1, years: [2027], volumes: [5000],
    });
    const big = quote(rates, wb.base.lists, input(2000)).years[0];
    const small = quote(rates, wb.base.lists, input(50)).years[0];
    assert.ok(small.miseEnRouteVendue > big.miseEnRouteVendue * 30, `${small.miseEnRouteVendue} vs ${big.miseEnRouteVendue}`);
    assert.ok(small.prixVente > big.prixVente);
  });
});

describe('in-house gravity die and heat treatments', () => {
  const part = { bboxSize: [200, 120, 60], volume: 400e3, area: 150e3, dimMax: 200, noyaux: false };

  test('the die of the tooling workbook: steel by weight, hours of its band, design and CAM, subcontracting', () => {
    const s = {
      densite: 8,
      coefPoids: [{ max: 100, coef: 1.3 }, { max: 1e9, coef: 1.2 }],
      bandes: [
        { max: 200, ax3: 10, ax3auto: 20, ax5: 3, ax5auto: 4, tiroir3: 1, tiroir5: 2, scan: 5, ajustage: 6 },
        { max: 2000, ax3: 100, ax3auto: 200, ax5: 30, ax5auto: 40, tiroir3: 10, tiroir5: 20, scan: 50, ajustage: 60 },
      ],
      taux: { etude: 1, fao: 2, ax3: 3, ax3auto: 4, ax5: 5, ax5auto: 6, scan: 7, ajustage: 8 },
      sousTraitance: 0.2,
      marge: 0,
    };
    // 500 x 250 x 100 mm of steel at 8: 100 kg bare (coefficient 1.3), 130 kg: first band.
    const r = steelToolCost({ L: 500, l: 250, h: 100, prixKg: 10, typeLabel: 'T', tiroirs: 2, etudeH: 30, faoH: 40 }, s);
    close(r.kg, 130, 1e-9, 'kg');
    const cost = 130 * 10 + (10 * 3 + 20 * 4 + 1 * 3 * 2) + (3 * 5 + 4 * 6 + 2 * 5 * 2) + 40 * 2 + 5 * 7 + 30 * 1 + 6 * 8;
    close(r.total, cost / 0.8, 1e-9, 'total with 20 % subcontracting');
    close(r.suivant, cost / 0.8 - 40 * 2 - 30 * 1, 1e-9, 'next die: without design and CAM');
    // Above the bare weight of the first coefficient: the next one, and the next band.
    const big = steelToolCost({ L: 500, l: 500, h: 100, prixKg: 10, typeLabel: 'T', tiroirs: 0, etudeH: 0, faoH: 0 }, s);
    close(big.kg, 240, 1e-9, 'kg');
    assert.equal(big.band.max, 2000);
    assert.equal(coefOf(s.coefPoids, 100), 1.3);
    assert.equal(coefOf(s.coefPoids, 101), 1.2);
  });

  test('the die of a part: its size plus the margins, more with more cavities', () => {
    const one = estimateTooling(part, 1);
    const two = estimateTooling(part, 2);
    const m = DEFAULT_TOOLING.marges;
    close(one.block.L, 200 + 2 * m.longueur, 1e-9, 'L');
    close(one.block.W, 120 + 2 * m.largeur, 1e-9, 'l');
    close(one.block.H, 60 + 2 * m.hauteur, 1e-9, 'h');
    close(two.block.W, 2 * 120 + m.entreEmpreintes + 2 * m.largeur, 1e-9, 'l, 2 cavities');
    close(one.total, one.lines.reduce((s, l) => s + l.value, 0), 1e-9, 'value');
    assert.ok(two.total > one.total);
    assert.equal(one.tiroirs, DEFAULT_TOOLING.tiroirs);
    const complex = estimateTooling({ ...part, outillageTiroirs: 3, outillageComplexite: 'Compliqué(e)' }, 1);
    assert.equal(complex.tiroirs, 3);
    assert.ok(complex.total > one.total);
  });

  test('more cavities than the island would use: a bigger die, more hours for its cavities; the flat price scaled', () => {
    assert.equal(cavityFactor(2, 2, 0.5), 1);
    close(cavityFactor(3, 1, 0.5), 2, 1e-12, '3 cavities, 1 estimated');
    close(cavityFactor(1, 2, 0.5), 1 / 1.5, 1e-12, '1 cavity, 2 estimated');
    assert.equal(cavityFactor(4, 1, 0), 1);
    // The die of the cavities the island would use: the method of the workbook, as before.
    const two = estimateTooling(part, 2);
    assert.deepEqual([two.facteurEmpreintes, two.empreintesEstimees], [1, 2]);
    assert.equal(estimateTooling(part, 2, DEFAULT_TOOLING, 2).total, two.total);
    // Two cavities where it would put one: the hours of milling, scan and fitting of the cavities, not those of design and CAM.
    const more = estimateTooling(part, 2, DEFAULT_TOOLING, 1);
    close(more.facteurEmpreintes, 1 + DEFAULT_TOOLING.parEmpreinte, 1e-12, 'factor');
    const line = (t, label) => t.lines.find((l) => l.label === label);
    for (const label of ['Usinage 3 axes', 'Usinage 5 axes', 'Scan 3D + rapport', 'Ajustage / montage']) close(line(more, label).value, line(two, label).value * more.facteurEmpreintes, 1e-9, label);
    for (const label of ['FAO', 'Étude']) close(line(more, label).value, line(two, label).value, 1e-12, label);
    assert.match(line(more, 'Ajustage / montage').detail, /^75 h × /, '50 h of the band × 1.5');
    assert.ok(more.total > two.total && two.total > estimateTooling(part, 1).total);
    // Without a share for a cavity: the size of the die only.
    assert.equal(estimateTooling(part, 2, { ...DEFAULT_TOOLING, parEmpreinte: 0 }, 1).total, two.total);

    const settings = { processes: DEFAULT_PROCESSES, operations: DEFAULT_OPERATIONS, trs: DEFAULT_TRS, tooling: DEFAULT_TOOLING };
    const p = { ...part, poids: 1, toileMini: 5, epaisseurMax: 10, moduleMm: 3, volumeAnnuel: 5000, volumeTotal: 25000 };
    const cg = buildRoute('CG3', 'FTR', p, settings, null, { empreintes: 2 });
    assert.equal(cg.outillage, estimateTooling(p, 2, DEFAULT_TOOLING, cg.parCycleEstime).total);
    assert.equal(cg.facteurOutillage, 1);
    close(cg.outillagePiece, cg.outillage / 25000, 1e-12, 'per piece');
    // The flat price of a die casting tool: for the 4 cavities estimated, scaled for 2 or 6.
    const ssp = buildRoute('SSP', 'FSP', p, settings, null);
    assert.deepEqual([ssp.parCycle, ssp.outillage, ssp.facteurOutillage], [4, DEFAULT_PROCESSES.SSP.outillage, 1]);
    for (const n of [2, 6]) {
      const r = buildRoute('SSP', 'FSP', p, settings, null, { empreintes: n });
      close(r.facteurOutillage, (1 + 0.5 * (n - 1)) / (1 + 0.5 * 3), 1e-12, `factor, ${n} cavities`);
      close(r.outillage, DEFAULT_PROCESSES.SSP.outillage * r.facteurOutillage, 1e-9, `flat price, ${n} cavities`);
    }
    assert.equal(buildRoute('SSP', 'FSP', p, { ...settings, tooling: { ...DEFAULT_TOOLING, parEmpreinte: 0 } }, null, { empreintes: 6 }).outillage, DEFAULT_PROCESSES.SSP.outillage);
  });

  test('gravity and low pressure islands get the estimate, the others their price', () => {
    const settings = { processes: DEFAULT_PROCESSES, operations: DEFAULT_OPERATIONS, trs: DEFAULT_TRS, tooling: DEFAULT_TOOLING };
    const p = { ...part, poids: 1, toileMini: 5, epaisseurMax: 10, moduleMm: 3, volumeAnnuel: 5000, volumeTotal: 25000 };
    const cg = buildRoute('CG3', 'FTR', p, settings, null);
    const bp = buildRoute('BPR', 'FTR', p, settings, null);
    const ssp = buildRoute('SSP', 'FSP', p, settings, null);
    assert.ok(cg.tooling && cg.outillage === cg.tooling.total);
    close(cg.outillagePiece, cg.outillage / 25000, 1e-9, 'value');
    assert.ok(bp.tooling && bp.outillage === bp.tooling.total);
    assert.equal(ssp.tooling, null);
    assert.equal(ssp.outillage, DEFAULT_PROCESSES.SSP.outillage);
    const off = buildRoute('CG3', 'FTR', p, { ...settings, tooling: { ...DEFAULT_TOOLING, actif: false } }, null);
    assert.equal(off.outillage, DEFAULT_PROCESSES.CG3.outillage);
  });

  test('heat treatment of the customer request', () => {
    assert.equal(heatTreatmentOf('A définir'), null);
    assert.equal(heatTreatmentOf('TTH T6 + FSW'), 'T6');
    assert.equal(heatTreatmentOf('Traitement thermique'), 'T6');
    assert.equal(heatTreatmentOf('TTH T5'), 'T5');
    assert.equal(heatTreatmentOf('T64'), 'T64');
  });

  test('the TTH line costs the T6 cost times the coefficient of the treatment', () => {
    const wb = readCostingWorkbook(costingWorkbook());
    const rates = centreRates(wb.base, {});
    const tth = [...rates.values()].find((r) => r.uo === 'kgSold');
    assert.ok(tth, 'a TTH centre in the fixture');
    const input = (tthCoef) => ({
      metal: { coursAchat: 2500, p1020Achat: 0, premiumAchat: 0, coursVente: 2500, p1020Vente: 0, premiumVente: 0, pafAchat: 0.06, pafVente: 0.08 },
      poids: 2, miseAuMille: 1.5, tth: 'scie', tthCoef, operations: [{ code: tth.code }], coefDifficulte: 0, marge: 0.1, years: [2027], volumes: [1000],
    });
    const t6 = quote(rates, wb.base.lists, input(1)).lines.find((l) => l.code === tth.code);
    const t5 = quote(rates, wb.base.lists, input(0.4)).lines.find((l) => l.code === tth.code);
    close(t6.units, 2, 1e-12, 'value');
    close(t5.cost, t6.cost * 0.4, 1e-9, 'value');
  });
});

describe('sand cores and core boxes', () => {
  test('the box of the workbook method: the method and rates of the dies, its own design and CAM hours', () => {
    const core = { nom: 'N1', masse: 1, qte: 2, L: 300, l: 200, h: 150, type: 1, tiroirs: 1, complexite: 'Moyen' };
    const box = coreBoxCost(core, DEFAULT_CORES, DEFAULT_TOOLING);
    const same = steelToolCost({ L: 300, l: 200, h: 150, prixKg: DEFAULT_CORES.types[1].prixKg, typeLabel: '', tiroirs: 1, etudeH: DEFAULT_CORES.etude.Moyen, faoH: DEFAULT_CORES.fao.Moyen }, { ...DEFAULT_TOOLING, sousTraitance: DEFAULT_CORES.sousTraitance, marge: DEFAULT_CORES.marge });
    close(box.kg, same.kg, 1e-12, 'kg');
    close(box.total, same.total, 1e-9, 'total');
    // Complexity of an earlier version: the most complex one.
    close(coreBoxCost({ ...core, complexite: 'Très compliqué(e)' }).total, coreBoxCost({ ...core, complexite: 'Compliqué(e)' }).total, 1e-9, 'old complexity');
  });

  test('without dimensions, the box is sized from the sand of the core', () => {
    const size = boxSize({ masse: 1.6 }, DEFAULT_CORES); // 1 dm³: a 100 mm cube, plus 2 walls
    close(size.L, 100 + 2 * DEFAULT_CORES.paroi, 1e-9, 'L');
    assert.equal(size.auto, true);
  });

  test('sand and core-making time per piece', () => {
    const per = coresPerPiece([{ masse: 0.5, qte: 2 }, { masse: 1, qte: 1 }], { base: 40, parKg: 10 });
    close(per.sable, 2, 1e-12, 'sand');
    close(per.cycle, 2 * (40 + 5) + (40 + 10), 1e-12, 'cycle');
  });
});

describe('settings files', () => {
  test('a partial settings file changes only what it holds', () => {
    const settings = defaultSettings(null);
    settings.marge = 0.2;
    const merged = mergeSettings(settings, {
      processes: { CG3: { cycle: { base: 0, parKg: 100, exposant: 0.5 } } },
      tooling: { taux: { ax3: 99 }, coefPoids: [{ max: 1e9, coef: 1.4 }] },
    });
    assert.equal(merged.marge, 0.2);
    assert.deepEqual(merged.processes.CG3.cycle, { base: 0, parKg: 100, exposant: 0.5, parModule2: settings.processes.CG3.cycle.parModule2 });
    assert.equal(merged.processes.CG3.famille, settings.processes.CG3.famille);
    assert.equal(merged.tooling.taux.ax3, 99);
    assert.equal(merged.tooling.taux.ax5, settings.tooling.taux.ax5);
    assert.deepEqual(merged.tooling.coefPoids, [{ max: 1e9, coef: 1.4 }]);
    assert.deepEqual(settings.tooling.taux, DEFAULT_TOOLING.taux, 'the current settings are not changed');
  });
});

// --------------------------------------------------------------------------- settings layers (store.js)

// The settings are kept in localStorage: an in-memory one for these tests.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};
const V1 = 'reader3d.chiffrage.settings.v1';
const V2 = 'reader3d.chiffrage.settings.v2';

// The settings rules of version 1 (one saved object, merged over the
// defaults), kept here as the reference of the non-regression tests.
function v1Defaults(base) {
  const d = base?.defaults ?? {};
  return {
    trs: { ...DEFAULT_TRS }, modes: {}, processes: structuredClone(DEFAULT_PROCESSES), operations: structuredClone(DEFAULT_OPERATIONS),
    densities: { ...DEFAULT_DENSITIES }, tooling: structuredClone(DEFAULT_TOOLING), tth: defaultSettings(null).tth, cores: structuredClone(DEFAULT_CORES),
    inflation: { salaires: d.evolutionSalaires ?? 0.015, conso: d.evolutionConso ?? 0.02, elec: d.evolutionElec ?? 0, gaz: d.evolutionGaz ?? 0, autresEnergies: d.evolutionAutresEnergies ?? 0.03 },
    energy: null, marge: d.marge ?? 0.12, tauxMini: d.tauxMini ?? 0.1, coefSecurite: d.coefSecurite ?? 0.1,
    heuresChangementCoulee: d.changeover?.[0]?.heures ?? 8, heuresChangementFinition: d.changeover?.[1]?.heures ?? 1,
  };
}
function v1Load(base, saved) {
  const defaults = v1Defaults(base);
  if (!saved) return defaults;
  const merged = { ...defaults, ...saved };
  for (const key of ['trs', 'modes', 'densities', 'inflation']) merged[key] = { ...defaults[key], ...saved[key] };
  merged.cores = { ...defaults.cores, ...saved.cores };
  for (const k of ['etude', 'fao']) merged.cores[k] = { ...defaults.cores[k], ...saved.cores?.[k] };
  merged.tth = { ...defaults.tth };
  for (const [code, value] of Object.entries(saved.tth ?? {})) merged.tth[code] = { ...defaults.tth[code], ...value };
  merged.tooling = { ...defaults.tooling, ...saved.tooling };
  for (const [k, v] of Object.entries(defaults.tooling)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merged.tooling[k] = { ...v, ...saved.tooling?.[k] };
    else if (Array.isArray(v) && !Array.isArray(saved.tooling?.[k])) merged.tooling[k] = v;
  }
  for (const key of ['processes', 'operations']) {
    merged[key] = { ...defaults[key] };
    for (const [code, value] of Object.entries(saved[key] ?? {})) merged[key][code] = { ...defaults[key][code], ...value, cycle: { ...defaults[key][code]?.cycle, ...value.cycle }, rendement: { ...defaults[key][code]?.rendement, ...value.rendement } };
  }
  return merged;
}

/** Everything the settings change in a quote of the fixture, as ui.js:compute does it. */
function pricesOf(s) {
  const energy = Object.fromEntries(Object.entries(s.energy ?? {}).filter(([, v]) => Number.isFinite(v)));
  const rates = centreRates(base, { modes: s.modes, energy });
  const metal = { coursAchat: 2500, p1020Achat: 300, premiumAchat: 350, coursVente: 2040, p1020Vente: 320, premiumVente: 600, pafAchat: 0.06, pafVente: 0.08 };
  const quoteBase = {
    metal, coefDifficulte: 2, vaUsinage: 10, rebutUsinage: 0.02, coefSecurite: s.coefSecurite, tailleSerie: 1000, nombrePieces: 50000,
    changeover: [{ code: 'CG3', heures: s.heuresChangementCoulee }, { code: 'FCE', heures: s.heuresChangementFinition }],
    marge: s.marge, evolution: s.inflation, years: [2026, 2027], volumes: [10000, 10000], tth: 'scie', tthCoef: s.tth.T5.coef,
  };
  const part = { poids: 1.2, moduleMm: 3, toileMini: 5, epaisseurMax: 10, dimMax: 250, bboxSize: [250, 120, 60], volumeAnnuel: 10000, volumeTotal: 50000, tth: true, noyaux: true, sableKg: 0.3 };
  const routes = rankRoutes(rates, base.lists, part, s, quoteBase).map((r) => [r.process, r.finition, r.feasible, r.cycle, r.miseAuMille, r.outillage, r.result.pri, r.result.years.map((y) => y.prixVente)]);
  const box = coreBoxCost({ masse: 1, qte: 1, type: 1, complexite: 'Moyen' }, s.cores, s.tooling).total;
  return { routes, box, density: s.densities.AS7G03 };
}

describe('settings layers: typed values, workbook, trends, defaults', () => {
  const typedOnly = () => Object.fromEntries(Object.entries(JSON.parse(storage.get(V2)).values).map(([k, e]) => [k, e.value]));

  test('nothing saved: the defaults and the workbook, the same prices as before', () => {
    storage.clear();
    const s = loadSettings(base);
    assert.deepEqual(s, defaultSettings(base));
    assert.deepEqual(pricesOf(s), pricesOf(v1Load(base, null)));
    const layers = loadSettingsLayers(base);
    assert.equal(layers.provenance('trs.CG3').source, 'defaut');
    assert.equal(layers.provenance('marge').source, 'classeur');
    assert.equal(layers.provenance('energy.elecNouveau').source, 'classeur');
  });

  test('a TRS typed in, then a trends file: the typed value stays, the trend is shown beside it', () => {
    storage.clear();
    assert.equal(setSetting('trs.CG3', 0.6, base), null);
    const report = importTendances({ trs: { CG3: 0.7, SSP: 0.5 } }, 'tendances.json');
    assert.equal(report.count, 2);
    const layers = loadSettingsLayers(base);
    assert.equal(layers.effective.trs.CG3, 0.6);
    assert.deepEqual(pick(layers.provenance('trs.CG3'), ['source', 'value', 'trend']), { source: 'saisie', value: 0.6, trend: 0.7 });
    // Where nothing is typed, the trend.
    assert.equal(layers.effective.trs.SSP, 0.5);
    assert.deepEqual(pick(layers.provenance('trs.SSP'), ['source', 'fileName']), { source: 'tendance', fileName: 'tendances.json' });
  });

  test('a trends file, then a TRS typed in: the typed value wins too', () => {
    storage.clear();
    importTendances({ trs: { CG3: 0.7 } }, 'tendances.json');
    assert.equal(loadSettings(base).trs.CG3, 0.7);
    setSetting('trs.CG3', 0.6, base);
    assert.equal(loadSettings(base).trs.CG3, 0.6);
    // A new trends file replaces the trends, never the typed value.
    importTendances({ trs: { CG3: 0.65 } }, 'tendances 2.json');
    assert.equal(loadSettings(base).trs.CG3, 0.6);
    assert.equal(loadSettingsLayers(base).provenance('trs.CG3').trend, 0.65);
    assert.deepEqual(typedOnly(), { 'trs.CG3': 0.6 }, 'only what was typed is saved');
  });

  test('the workbook above the trends, the trends above the code', () => {
    storage.clear();
    importTendances({ marge: 0.3, coefSecurite: 0.2, processes: { CG3: { cycle: { base: 111 } } } }, 't.json');
    let layers = loadSettingsLayers(base);
    assert.equal(layers.effective.marge, base.defaults.marge);
    assert.deepEqual(pick(layers.provenance('marge'), ['source', 'trend']), { source: 'classeur', trend: 0.3 });
    assert.equal(layers.effective.processes.CG3.cycle.base, 111);
    assert.equal(layers.effective.processes.CG3.cycle.parKg, DEFAULT_PROCESSES.CG3.cycle.parKg);
    // Without a workbook, the trend.
    assert.equal(loadSettings(null).marge, 0.3);
    // A re-imported workbook is taken into account at the next loading.
    const other = { ...base, defaults: { ...base.defaults, marge: 0.15 } };
    assert.equal(loadSettings(other).marge, 0.15);
    // "Adopter la tendance" where the workbook has a value: the trend is typed in.
    adoptTendance('marge', base);
    layers = loadSettingsLayers(base);
    assert.equal(layers.effective.marge, 0.3);
    assert.equal(layers.provenance('marge').source, 'saisie');
  });

  test('"Adopter la tendance" removes the typed value', () => {
    storage.clear();
    importTendances({ trs: { CG3: 0.7 } }, 't.json');
    setSetting('trs.CG3', 0.6, base);
    adoptTendance('trs.CG3', base);
    const layers = loadSettingsLayers(base);
    assert.equal(layers.effective.trs.CG3, 0.7);
    assert.equal(layers.provenance('trs.CG3').source, 'tendance');
    assert.deepEqual(typedOnly(), {});
  });

  test('an emptied field is not set: the next layer, never 0; a 0 typed in stays 0', () => {
    storage.clear();
    importTendances({ trs: { CG3: 0.7 } }, 't.json');
    setSetting('trs.CG3', 0.6, base);
    setSetting('trs.CG3', null, base);
    assert.equal(loadSettings(base).trs.CG3, 0.7, 'the trend');
    clearTendances();
    assert.equal(loadSettings(base).trs.CG3, DEFAULT_TRS.CG3, 'the default');
    for (const path of ['marge', 'coefSecurite', 'heuresChangementCoulee', 'inflation.salaires', 'processes.CG3.rendement.base', 'processes.CG3.miseAuMille', 'operations.TRI.chargeKg', 'tooling.tiroirs']) {
      setSetting(path, 0.5, base);
      setSetting(path, null, base);
      const value = path.split('.').reduce((o, k) => o[k], loadSettings(base));
      assert.equal(value, path.split('.').reduce((o, k) => o[k], defaultSettings(base)), path);
    }
    setSetting('processes.CG3.famille', 'Coquille', base);
    setSetting('processes.CG3.famille', '', base);
    assert.equal(loadSettings(base).processes.CG3.famille, DEFAULT_PROCESSES.CG3.famille);
    // 0 typed in: kept where it has a meaning, refused where it has none.
    assert.equal(setSetting('marge', 0, base), null);
    assert.equal(loadSettings(base).marge, 0);
    assert.equal(loadSettingsLayers(base).provenance('marge').source, 'saisie');
    for (const path of ['trs.CG3', 'densities.AS7G03', 'operations.TRI.chargeKg', 'processes.CG3.miseAuMille']) {
      assert.ok(setSetting(path, 0, base), path);
      assert.ok(path.split('.').reduce((o, k) => o[k], loadSettings(base)) > 0, path);
    }
    // The share of a cavity: 0 (the size of the die only) kept, a negative one refused.
    assert.equal(setSetting('tooling.parEmpreinte', -0.2, base), "part d'une empreinte positive ou nulle");
    assert.equal(setSetting('tooling.parEmpreinte', 0, base), null);
    assert.equal(loadSettings(base).tooling.parEmpreinte, 0);
    setSetting('tooling.parEmpreinte', null, base);
    assert.deepEqual(typedOnly(), { marge: 0 });
  });

  test('a typed value in a table row, exported as a settings file', () => {
    storage.clear();
    setSetting('tooling.bandes.3.ax3', 70, base);
    setSetting('trs.CG3', 0.6, base);
    const s = loadSettings(base);
    assert.equal(s.tooling.bandes[3].ax3, 70);
    assert.deepEqual(s.tooling.bandes[2], DEFAULT_TOOLING.bandes[2]);
    const file = exportSaisies(base);
    assert.deepEqual(file, { tooling: { bandes: { 3: { ax3: 70 } } }, trs: { CG3: 0.6 } });
    // The export imported as trends: the same values.
    storage.clear();
    const report = importTendances(JSON.parse(JSON.stringify(file)), 'saisies.json');
    const t = loadSettings(base);
    assert.equal(t.tooling.bandes[3].ax3, 70);
    assert.deepEqual(t.tooling.bandes[4], DEFAULT_TOOLING.bandes[4]);
    // Only the values of the file are trends: the other rows of the table, and of row 3, stay the defaults of the code.
    assert.equal(report.count, 2);
    const layers = loadSettingsLayers(base);
    assert.equal(layers.provenance('tooling.bandes.0.ax3').source, 'defaut');
    assert.equal(layers.provenance('tooling.bandes.9.scan').source, 'defaut');
    assert.equal(layers.provenance('tooling.bandes.3.ax5').source, 'defaut');
    assert.deepEqual(pick(layers.provenance('tooling.bandes.3.ax3'), ['source', 'fileName']), { source: 'tendance', fileName: 'saisies.json' });
  });

  test('a row typed in a table: never moved to another row by a trends table of another length', () => {
    storage.clear();
    const last = DEFAULT_TOOLING.bandes.length - 1;
    setSetting(`tooling.bandes.${last}.ax3`, 77, base);
    // No trends: the value typed in, the same prices as the settings of version 1 with it.
    const typed = v1Load(base, null);
    typed.tooling.bandes[last].ax3 = 77;
    assert.deepEqual(pricesOf(loadSettings(base)), pricesOf(typed));
    // A shorter table in the trends (made-up bands): the table of the code where a row of it is typed in, said.
    const shorter = { tooling: { bandes: [{ max: 100, ax3: 11 }, { max: 1000, ax3: 11 }, { max: 1e9, ax3: 11 }] } };
    const report = importTendances(shorter, 'courtes.json');
    assert.deepEqual(report.warnings.map((w) => w.path), ['tooling.bandes']);
    assert.match(report.warnings[0].reason, new RegExp(`^3 lignes au lieu de ${last + 1} : le tableau par défaut est gardé`));
    let layers = loadSettingsLayers(base);
    assert.equal(layers.effective.tooling.bandes.length, last + 1);
    assert.equal(layers.effective.tooling.bandes[last].ax3, 77);
    assert.deepEqual(layers.effective.tooling.bandes[0], DEFAULT_TOOLING.bandes[0]);
    assert.deepEqual([layers.ignored, layers.unapplied], [['tooling.bandes'], []]);
    assert.deepEqual(pick(layers.provenance(`tooling.bandes.${last}.ax3`), ['source', 'value', 'trend', 'trendIgnored']), { source: 'saisie', value: 77, trend: undefined, trendIgnored: true });
    assert.deepEqual(pick(layers.provenance('tooling.bandes.0.ax3'), ['source', 'trendIgnored']), { source: 'defaut', trendIgnored: true });
    assert.deepEqual(pricesOf(layers.effective), pricesOf(typed), 'the trend changes nothing there');
    // A longer one: the same.
    importTendances({ tooling: { bandes: Array.from({ length: last + 3 }, (_, i) => ({ max: (i + 1) * 100, ax3: 5 })) } }, 'longues.json');
    layers = loadSettingsLayers(base);
    assert.deepEqual([layers.effective.tooling.bandes.length, layers.effective.tooling.bandes[last].ax3, layers.ignored], [last + 1, 77, ['tooling.bandes']]);
    // The trends' table used where no row of it is typed in.
    clearSetting(`tooling.bandes.${last}.ax3`, base);
    layers = loadSettingsLayers(base);
    assert.deepEqual([layers.effective.tooling.bandes.length, layers.ignored, layers.provenance('tooling.bandes.0.ax3').source], [last + 3, [], 'tendance']);
    // A row typed in that table: kept on it; the trends erased, not applied to the row of the same number of the code's table.
    setSetting(`tooling.bandes.${last + 2}.ax3`, 33, base);
    layers = loadSettingsLayers(base);
    assert.deepEqual([layers.effective.tooling.bandes[last + 2].ax3, layers.unapplied], [33, []]);
    clearTendances();
    layers = loadSettingsLayers(base);
    assert.deepEqual([layers.effective.tooling.bandes.length, layers.unapplied], [last + 1, [`tooling.bandes.${last + 2}.ax3`]]);
    assert.equal(layers.provenance(`tooling.bandes.${last + 2}.ax3`).unapplied, true);
    assert.deepEqual(pricesOf(layers.effective), pricesOf(v1Load(base, null)));
  });

  test('migration of the saved settings of version 1: only the choices, the same prices', () => {
    storage.clear();
    // Version 1 saved the whole object at the first change (here: the defaults of the workbook, and a few inputs).
    const saved = v1Load(base, null);
    saved.trs.CG3 = 0.6;
    saved.processes.CG3.cycle.base = 120;
    saved.operations.FCE.parKg = 9;
    saved.tooling.taux.ax3 = 99;
    saved.tooling.bandes[0].ajustage = 40;
    saved.tooling.coefPoids = [{ max: 100, coef: 1.3 }, { max: 1e9, coef: 1.25 }];
    saved.modes = { SSP: '1*8', CG4: '2*8' };
    saved.energy = { elecNouveau: 60 };
    saved.densities.AS7G03 = 2.7;
    saved.cores.marge = 0.05;
    saved.tth.T5.coef = 0.5;
    saved.evolution = { salaires: 0.2 }; // a key of an older version: kept
    storage.set(V1, JSON.stringify(saved));
    const s = loadSettings(base);
    assert.deepEqual(pricesOf(s), pricesOf(v1Load(base, saved)));
    assert.deepEqual(Object.keys(typedOnly()).sort(), [
      'cores.marge', 'densities.AS7G03', 'energy.elecNouveau', 'evolution.salaires', 'modes.SSP', 'operations.FCE.parKg',
      'processes.CG3.cycle.base', 'tooling.bandes.0.ajustage', 'tooling.coefPoids', 'tooling.taux.ax3', 'trs.CG3', 'tth.T5.coef',
    ]);
    const layers = loadSettingsLayers(base);
    assert.deepEqual(pick(layers.provenance('tooling.coefPoids.1.coef'), ['source', 'migrated']), { source: 'saisie', migrated: true });
    assert.equal(layers.provenance('tooling.coefPoids.1.max').source, 'saisie');
    assert.ok(layers.saisies.migratedAt);
    assert.ok(storage.has(V1), 'the settings of version 1 are kept as they were (backup)');
    // Emptying a value of a table saved whole: the value below comes back, not NaN.
    clearSetting('tooling.coefPoids.0.coef', base);
    assert.equal(loadSettings(base).tooling.coefPoids[0].coef, DEFAULT_TOOLING.coefPoids[0].coef);
    assert.equal(loadSettings(base).tooling.coefPoids[1].coef, 1.25);
    // Migrated once; erasing the typed values does not bring them back.
    setSetting('marge', 0.2, base);
    assert.equal(loadSettings(base).marge, 0.2);
    clearSaisies();
    assert.ok(!storage.has(V1));
    assert.deepEqual(loadSettings(base), defaultSettings(base));
  });

  test('migration: defaults and emptied fields of version 1 are not choices', () => {
    // A workbook whose values differ from the defaults of the code (made-up values).
    const other = { ...base, defaults: { ...base.defaults, evolutionSalaires: 0.025, marge: 0.2 } };
    const saved = v1Load(null, null); // saved before the workbook was imported: the defaults of the code
    saved.coefSecurite = null; // a field emptied in version 1 (it counted as 0)
    saved.trs.CG3 = null;
    const values = migrateSettings(saved, other);
    assert.deepEqual(values, {});
    storage.clear();
    storage.set(V1, JSON.stringify(saved));
    const s = loadSettings(other);
    assert.equal(s.inflation.salaires, 0.025, 'the workbook, no longer the default of the code saved');
    assert.equal(s.marge, 0.2);
    assert.equal(s.coefSecurite, base.defaults.coefSecurite);
    assert.equal(s.trs.CG3, DEFAULT_TRS.CG3);
  });

  test('trends file: unknown and misspelled keys reported and ignored, partial tables without NaN', () => {
    const { values, report } = validateTendances({
      procceses: { CG3: { qualite: 9 } },
      processes: { CG3: { cycle: { bse: 50, parKg: 7 }, finitions: ['FCE', 'XYZ'] }, CG9: { qualite: 1 } },
      trs: { CG3: 85, NEW: 0.9 },
      marge: '0,15',
      tooling: { bandes: [{ max: 150, ax3: 12 }, { max: 2000, ax3: 30, scan: 3 }], taux: { ax3: 90 } },
      tth: { T61: { label: 'T61', coef: 1.05 }, T62: { label: 'sans coefficient' } },
      densities: { AS21: 2.71 },
      _commentaire: 'calé sur les devis',
    });
    assert.deepEqual(report.unknown, [
      { path: 'procceses', suggestion: 'processes' },
      { path: 'processes.CG3.cycle.bse', suggestion: 'base' },
      { path: 'processes.CG9', suggestion: 'CG1' },
    ]);
    assert.deepEqual(report.invalid.map((x) => x.path), ['processes.CG3.finitions', 'trs.CG3', 'marge', 'tth.T62']);
    assert.equal(values.procceses, undefined);
    assert.deepEqual(values.processes.CG3, { cycle: { parKg: 7 }, finitions: ['FCE'] });
    assert.deepEqual(values.trs, { NEW: 0.9 });
    assert.equal(values.marge, undefined);
    assert.deepEqual(values.tth.T61, { label: 'T61', coef: 1.05, cycle: '' });
    assert.ok(report.completed.includes('tooling.bandes.0.ax5'));
    assert.equal(report.count, countLeaves(values) - report.completed.length, 'the values of the file, not those completed by the defaults');
    // Applied: every value of the tables is a number, the die and the core box are costed.
    storage.clear();
    importTendances({ tooling: { bandes: [{ max: 150, ax3: 12 }], coefPoids: [{ coef: 1.3 }] }, cores: { types: [{ prixKg: 9 }] } }, 't.json');
    const s = loadSettings(base);
    for (const row of [...s.tooling.bandes, ...s.tooling.coefPoids, ...s.cores.types]) for (const v of Object.values(row)) assert.ok(typeof v === 'string' || Number.isFinite(v), JSON.stringify(row));
    assert.ok(Number.isFinite(estimateTooling({ bboxSize: [200, 120, 60], dimMax: 200 }, 2, s.tooling).total));
    assert.ok(Number.isFinite(coreBoxCost({ masse: 1, qte: 1, type: 0, complexite: 'Moyen' }, s.cores, s.tooling).total));
    assert.equal(loadSettingsLayers(base).provenance('tooling.bandes.0.ax3').source, 'tendance');
    assert.equal(loadSettingsLayers(base).provenance('tooling.bandes.0.ax5').source, 'defaut', 'completed, not from the file');
  });

  test('the threshold of the alerts on the trend is not set by a trends file', () => {
    const { values, report } = validateTendances({ seuilTendance: 10, trs: { CG3: 0.3 } });
    assert.deepEqual(report.unknown, [{ path: 'seuilTendance', suggestion: null }]);
    assert.deepEqual(values, { trs: { CG3: 0.3 } });
    // Trends saved before: the threshold left out when they are read.
    storage.clear();
    storage.set('reader3d.chiffrage.tendances.v1', JSON.stringify({ fileName: 'ancien.json', importedAt: '2026-01-01T00:00:00.000Z', values: { seuilTendance: 10, trs: { CG3: 0.3 } }, completed: [] }));
    const layers = loadSettingsLayers(base);
    assert.equal(layers.effective.seuilTendance, defaultSettings(base).seuilTendance);
    assert.equal(layers.provenance('seuilTendance').source, 'defaut');
    assert.deepEqual(layers.tendances.values, { trs: { CG3: 0.3 } });
  });

  test('a file without any known value is refused and the trends are kept', () => {
    storage.clear();
    importTendances({ trs: { CG3: 0.7 } }, 't.json');
    assert.throws(() => importTendances({ client: 'ACME', poids: 2 }, 'devis.json'), /aucune valeur de paramètre reconnue.*client/);
    assert.throws(() => importTendances([1, 2], 'liste.json'), /aucune valeur/);
    assert.equal(loadSettings(base).trs.CG3, 0.7);
  });

  test('storage blocked: the typed values work for this visit', () => {
    storage.clear();
    const { setItem } = globalThis.localStorage;
    globalThis.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      setSetting('trs.CG3', 0.6, base);
      assert.equal(loadSettings(base).trs.CG3, 0.6);
    } finally {
      globalThis.localStorage.setItem = setItem;
      clearSaisies();
    }
    assert.equal(loadSettings(base).trs.CG3, DEFAULT_TRS.CG3);
  });
});

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

function countLeaves(o) {
  if (Array.isArray(o)) return o.some((x) => x && typeof x === 'object') ? o.reduce((n, x) => n + countLeaves(x), 0) : 1;
  if (o && typeof o === 'object') return Object.values(o).reduce((n, x) => n + countLeaves(x), 0);
  return 1;
}

// --------------------------------------------------------------------------- traced values (provenance.js)

// The Chiffrage page computes and traces the quote (ui.js:compute): loaded
// here with the storage above and a window without 3D model (or a stub of one).
let ui;
const PART = { poids: 1.2, toileMini: 5, epaisseurMax: 10, moduleMm: 3, dimMax: 250 };
const ORDER = readSeriesOrder(seriesOrderWorkbook(), 'RFQ.xlsm');
const PARTS_3D = [
  { index: 0, name: 'A', closed: true, volume: 450000, area: 90000, bboxSize: [200, 120, 60], thickness: { min: 5, max: 12, detected: 5 } },
  { index: 1, name: 'B', closed: true, volume: 120000, area: 30000, bboxSize: [80, 60, 40], thickness: { min: 4, max: 6, detected: 4 } },
  { index: 2, name: 'C', closed: true, volume: 30000, area: 15000, bboxSize: [60, 30, 20], thickness: null },
];

/**
 * ui.js:compute() on the fixture: the quote `quote` (pieces: the inputs of
 * each piece, by default the part typed in), the 3D model `p3d` ({file, parts,
 * selected}) if any, the settings and trends set by `setup`.
 */
function computed({ quote = {}, p3d = null, setup = () => {}, workbook = base } = {}) {
  storage.clear();
  saveBase(workbook);
  saveIndices({ ...indices, source: 'classeur', fileName: 'test.xlsm', importedAt: workbook.source.importedAt });
  setup();
  saveQuote({ ...defaultQuote(workbook, indices), pieces: { manuel: PART }, pieceFile: p3d?.file ?? null, ...quote });
  globalThis.window.reader3d = p3d ? { part: () => p3d } : undefined;
  ui.reload();
  return ui.compute();
}

// Every trace of a quote: [key, trace, section] (section: the quote or a piece).
const allTraces = (c) => [c.trace, ...c.results.map((r) => r.trace)].flatMap((T) => Object.entries(T ?? {}).map(([k, t]) => [k, t, T]));
const AUTHORITIES = ['hard', 'evidence', 'soft_prior', 'default_code', 'calcul'];
const LEVELS = ['haute', 'moyenne', 'faible', 'nulle'];

describe('traced values of a quote (provenance.js)', () => {
  before(async () => {
    globalThis.window ??= { addEventListener() {} };
    ui = await import('../../web/chiffrage/ui.js');
  });

  test('resolve: the first value in the order of the registry, a trend never above a current value, never the AI', () => {
    const typed = traced(0.6, { type: 'parametres', unite: '%', ref: 'settings.trs.CG3' });
    const trend = traced(0.7, { type: 'tendance', unite: '%', ref: 'settings.trs.CG3' });
    const ai = traced(0.9, { type: 'ia', unite: '%', ref: 'réponse du modèle' });
    let t = resolve([ai, traced('', { type: 'saisie' }), traced(Number.NaN, { type: 'rfq' }), typed, trend]);
    assert.deepEqual([t.valeur, t.autorite, t.niveau, t.source.type], [0.6, 'hard', 2, 'parametres']);
    assert.deepEqual(t.alternatives.map((a) => [a.source, a.valeur]), [['tendance', 0.7]], 'the AI is not even an alternative');
    close(t.ecart_tendance.ecart_rel, -1 / 7, 1e-12, 'deviation from the trend');
    assert.equal(t.ecart_tendance.tendance, 0.7);
    assert.equal(t.ecart_tendance.alerte, false, '14 % < 15 %');
    assert.deepEqual(t.alertes, []);
    assert.equal(t.validation_requise, false);
    t = resolve([typed, trend], { seuil: 0.1 });
    assert.equal(t.ecart_tendance.alerte, true);
    assert.deepEqual(t.alertes.map((a) => a.type), ['ecart_tendance']);
    // A trend first in the list never wins over a hard value.
    t = resolve([trend, typed]);
    assert.deepEqual([t.valeur, t.autorite], [0.6, 'hard']);
    assert.ok(t.alertes.some((a) => a.type === 'divergence'));
    // Only a trend: retained, a soft prior to validate. Only the AI: nothing.
    t = resolve([null, trend]);
    assert.deepEqual([t.valeur, t.autorite, t.niveau, t.validation_requise], [0.7, 'soft_prior', 4, true]);
    assert.equal(resolve([ai]), null);
    // A default of the code: a hypothesis to validate, with its alert.
    t = traced(0.75, { type: 'defaut_code', unite: '%', ref: 'routes.js:DEFAULT_TRS.CG3' });
    assert.deepEqual([t.autorite, t.niveau, t.validation_requise, t.alertes.map((a) => a.type)], ['default_code', null, true, ['defaut_code']]);
    // Divergent current sources: the weight typed in and the one measured.
    t = resolve([traced(1.2, { type: 'saisie', unite: 'kg', ref: 'q.poids' }), traced(1.5, { type: 'geometrie', unite: 'kg', ref: '3D' })]);
    assert.equal(t.valeur, 1.2);
    assert.deepEqual(t.alertes.map((a) => a.type), ['divergence']);
    assert.equal(t.validation_requise, true);
  });

  test('a computed value: the confidence of its weakest input, a validation when an input needs one', () => {
    const a = traced(2, { type: 'saisie', ref: 'a' });
    const b = traced(3, { type: 'tendance', ref: 'b' });
    const x = derive(6, { ref: 'a × b', entrees: { a, b } });
    assert.deepEqual([x.source.type, x.autorite, x.niveau, x.source.entrees], ['calcul', 'calcul', null, ['a', 'b']]);
    assert.deepEqual([x.confiance.niveau, x.validation_requise], ['moyenne', true]);
    const y = derive(8, { ref: 'x + a', entrees: { x, a } });
    assert.equal(y.confiance.niveau, 'moyenne');
    assert.match(y.confiance.raison, /^entrée la plus faible : x ← b \(/);
    assert.deepEqual(derive(2, { entrees: { a } }).confiance.niveau, 'haute');
    assert.equal(derive(2, { entrees: { a }, plafond: ['moyenne', 'estimation'] }).confiance.niveau, 'moyenne');
    assert.equal(derive(0, { entrees: { a, m: missing('', 'manque') } }).confiance.niveau, 'nulle');
    assert.equal(weakest('haute', 'faible', 'moyenne'), 'faible');
  });

  test('every output of the registry is traced, completely, on the fixture', () => {
    const scenarios = {
      auto: computed(),
      chosen: computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 300, empreintes: 2, miseAuMille: 1.5, mode: '1*8', outillagePrix: 15000 } } } }),
      cycleOnly: computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', miseAuMille: 1.5, empreintes: 2 } } } }),
      cavities: computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', empreintes: 3, outillagePrix: 18000 } } } }),
      cavitiesFlat: computed({ quote: { pieces: { manuel: { ...PART, procede: 'SSP', empreintes: 2 } } } }),
      cores: computed({ quote: { pieces: { manuel: { ...PART, procede: 'BPR', noyaux: true, cores: [{ nom: 'N1', masse: 0.6, qte: 2, type: 1, complexite: 'Simple' }], tth: 'T6' } } } }),
      set: computed({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } }),
      request: computed({ quote: { serie: ORDER } }),
      setRequest: computed({ quote: { serie: ORDER }, p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } }),
    };
    for (const [name, c] of Object.entries(scenarios)) {
      for (const key of QUOTE_KEYS) assert.ok(c.trace[key], `${name}: ${key}`);
      assert.ok(c.results.length && c.results.every((r) => r.final), name);
      for (const r of c.results) for (const key of pieceKeys(r.route.process)) assert.ok(r.trace[key], `${name}, ${r.piece.name}: ${key}`);
      for (const [key, t, T] of allTraces(c)) {
        const what = `${name}: ${key}`;
        assert.ok(t.valeur !== undefined && typeof t.unite === 'string', what);
        assert.ok(SOURCES[t.source.type] && t.source.type !== 'ia', what);
        assert.ok(typeof t.source.ref === 'string' && t.source.ref, what);
        assert.ok(AUTHORITIES.includes(t.autorite), what);
        assert.equal(t.niveau, SOURCES[t.source.type].niveau, what);
        assert.ok(LEVELS.includes(t.confiance.niveau) && t.confiance.raison, what);
        assert.ok(t.ecart_tendance === null || (typeof t.ecart_tendance.tendance === 'number' && 'ecart_rel' in t.ecart_tendance && typeof t.ecart_tendance.alerte === 'boolean'), what);
        assert.ok(Array.isArray(t.alternatives) && t.alternatives.every((a) => SOURCES[a.source] && 'valeur' in a), what);
        assert.ok(Array.isArray(t.hypotheses) && Array.isArray(t.alertes) && typeof t.validation_requise === 'boolean', what);
        // A computed value names its inputs, each one traced (in its piece or in the quote).
        if (t.source.type === 'calcul') {
          assert.ok(t.source.entrees.length, what);
          for (const e of t.source.entrees) {
            // A value of the set names the values of its pieces "<key> [<piece>]".
            const ofPiece = /^(piece\.[\w.]+) \[(.+)\]$/.exec(e);
            assert.ok(T[e] ?? c.trace[e] ?? (key.startsWith('ensemble.') && ofPiece && c.results.find((r) => r.piece.name === ofPiece[2])?.trace[ofPiece[1]]), `${what}: input ${e}`);
          }
        }
      }
    }
    // An island chosen with its cycle only estimated: the estimate of the cavities it uses is traced too.
    const r = scenarios.cycleOnly.results[0];
    assert.deepEqual([r.trace['piece.cycle'].source.type, r.trace['piece.empreintes'].source.type], ['calcul', 'saisie']);
    assert.ok(r.trace['piece.empreintes.estimee'] && r.trace['piece.miseAuMille.estimee'] && r.trace['parametres.cycle']);
    assert.equal(scenarios.chosen.results[0].trace['parametres.cycle'], undefined, 'the cycle typed in: its coefficients are not used');
    // Cavities typed in: the cycle estimated for their cluster; the estimated ones, not retained, still price the tool unless it is typed in.
    for (const [name, estimee] of [['cavities', false], ['cavitiesFlat', true]]) {
      const T = scenarios[name].results[0].trace;
      assert.equal(T['piece.empreintes'].source.type, 'saisie', name);
      assert.ok(T['piece.cycle'].source.entrees.includes('piece.empreintes') && !T['piece.cycle'].source.entrees.includes('piece.empreintes.estimee'), name);
      assert.match(T['piece.cycle'].hypotheses.join(), /cycle de la grappe des \d empreintes saisies/, name);
      assert.equal(!!T['piece.empreintes.estimee'], estimee, name);
    }
    const flat = scenarios.cavitiesFlat.results[0].trace['piece.outillage.total'];
    assert.deepEqual([flat.source.type, flat.source.ref], ['calcul', 'routes.js:buildRoute (forfait de l\'îlot × empreintes)']);
    assert.ok(flat.source.entrees.includes('piece.empreintes.estimee') && flat.source.entrees.includes('parametres.outillage'));
    assert.match(flat.hypotheses.join(), /prix forfaitaire de l'îlot SSP × 0,6 : 2 empreintes au lieu de 4 estimées/);
  });

  test('more cavities: the quote of each number of cavities, as "Retenir" makes it', () => {
    const c = computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 300, outillagePrix: 15000 } } } });
    const r = c.results[0];
    const rows = ui.cavityRows(c, r);
    assert.deepEqual(rows.map((x) => x.n), [1, 2, 3, 4]);
    // The row retained is the quote as it is (its cycle and tool typed in); the others are estimated.
    assert.equal(rows[0].r, r);
    const p = DEFAULT_PROCESSES.CG3;
    const kgCast = PART.poids * r.estimated.miseAuMille;
    for (const { n, r: x } of rows.slice(1)) {
      const casting = x.route.operations.find((o) => o.code === 'CG3');
      assert.deepEqual([x.inputs.procede, x.inputs.empreintes, x.inputs.cycle, x.inputs.outillagePrix, casting.parCycle], ['CG3', n, null, null, n]);
      close(casting.cycle, castingCycle(p, kgCast, n, PART.moduleMm), 1e-12, `cycle, ${n} cavities`);
      assert.equal(x.route.outillageMoule, x.route.tooling.total);
    }
    // More cavities: less time per piece, a dearer die; nothing saved.
    const perPiece = rows.slice(1).map(({ n, r: x }) => x.route.operations.find((o) => o.code === 'CG3').cycle / n);
    const moulds = rows.slice(1).map(({ r: x }) => x.route.outillageMoule);
    assert.ok(perPiece.every((v, i) => i === 0 || v < perPiece[i - 1]), String(perPiece));
    assert.ok(moulds.every((v, i) => i === 0 || v > moulds[i - 1]), String(moulds));
    assert.deepEqual(loadQuote(base, indices).pieces.manuel, { ...PART, procede: 'CG3', cycle: 300, outillagePrix: 15000 });
    // In automatic mode, the island of the best route.
    const auto = computed();
    const best = auto.results[0].route;
    const autoRows = ui.cavityRows(auto, auto.results[0]);
    assert.ok(autoRows.length >= 4 && autoRows.every(({ n, r: x }) => x.route.process === best.process && x.route.parCycle === n));
    assert.equal(autoRows.find(({ n }) => n === best.parCycle).r, auto.results[0]);
  });

  test('the traces describe the values computed and change none of them', () => {
    for (const c of [computed(), computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 300, empreintes: 2, miseAuMille: 1.5, outillagePrix: 15000 } } } }), computed({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1] } })]) {
      const T = c.trace;
      assert.equal(T['devis.densite'].valeur, c.density);
      assert.equal(T['devis.volumeTotal'].valeur, c.volumeTotal);
      assert.equal(T['devis.metal.coursVente'].valeur, c.metal.coursVente);
      close(T['devis.metal.prixVente'].valeur, (c.metal.coursVente + c.metal.p1020Vente + c.metal.premiumVente) * (1 + c.metal.pafVente), 1e-12, 'sale metal');
      for (const r of c.results) {
        const casting = r.route.operations.find((o) => o.code === r.route.process);
        const P = r.trace;
        const code = r.route.process;
        assert.equal(T['devis.marge'].valeur, r.finalInput.marge);
        assert.equal(T['devis.tailleSerie'].valeur, r.finalInput.tailleSerie);
        assert.equal(T['devis.metal.prixAchat'].valeur, r.final.metalAchat);
        assert.deepEqual(
          [P['piece.poids'].valeur, P['piece.ilot'].valeur, P['piece.miseAuMille'].valeur, P['piece.kgCast'].valeur, P['piece.empreintes'].valeur, P['piece.cycle'].valeur],
          [r.part.poids, code, r.route.miseAuMille, r.final.kgCast, casting.parCycle, casting.cycle],
        );
        assert.deepEqual(
          [P[`centre.${code}.trs`].valeur, P[`centre.${code}.taux`].valeur, P[`centre.${code}.mode`].valeur, P['piece.va'].valeur, P['piece.outillage.total'].valeur, P['piece.prix.pri'].valeur, P['piece.prix.vente'].valeur],
          [casting.trs, r.finalRates.get(code).rate, r.finalRates.get(code).mode, r.final.va, r.route.outillage, r.final.pri, r.final.years[0].prixVente],
        );
      }
      if (c.ensemble) assert.equal(T['ensemble.prix.vente'].valeur, c.ensemble.years[0].prixVente);
    }
  });

  test('non-regression: the prices of the fixture are those computed before the traces', () => {
    // [PRI, sale price of the first year] of each piece, and of the set: ui.js:compute of the
    // previous version (settings layers), on the same quotes of the made-up workbook.
    const quotes = {
      auto: [{}, [[20.75780697404318, 26.46674353599491]]],
      weightOnly: [{ quote: { pieces: { manuel: { poids: 2.5 } } } }, [[26.277257213553643, 32.38843564494282]]],
      chosen: [{ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 300, empreintes: 2, miseAuMille: 1.5, mode: '1*8', outillagePrix: 15000 } } } }, [[35.28293020434457, 44.659882872969575]]],
      options: [{ quote: { tailleSerie: 0, outillageInclus: false, margeOutillage: 0.1, marge: 0.2, pieces: { manuel: { poids: 3, toileMini: 6, epaisseurMax: 20, moduleMm: 5, dimMax: 300, tth: 'T6', tthMode: 'masselotte', noyaux: true, cores: [{ nom: 'N1', masse: 0.6, qte: 2, type: 1, complexite: 'Simple' }], tribo: true, redressage: true, composants: [{ designation: 'x', qte: 2, prix: 1.5, marge: 0.1 }] } } } }, [[65.1473914433648, 82.56064146233092]]],
      // The request has a weight, a mise au mille and a scrap rate of its own: compared, never applied (same prices).
      rfq: [{ quote: { serie: ORDER, alliage: 'AS9U3', month: ORDER.matiere.month, coursAchat: 2800, moqs: ORDER.moqs, tailleSerie: 1500, volumes: [1000, 1500, 1500, 800], annees: 4, premiereAnnee: 2027, volumeAnnuel: 1500 } }, [[28.166450045385446, 40.044076231320005]]],
      noSalePrice: [{ quote: { month: '2031-01', coursAchat: null, premiumVente: null, pafVente: null } }, [[7.003774744773435, 10.541749447754384]]],
      infeasible: [{ quote: { pieces: { manuel: { ...PART, toileMini: 2, procede: 'CG3', outillagePrix: 0 } } } }, [[52.14792795076022, 63.504747039077316]]],
      set: [{ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } }, [[11.091035960092366, 15.438109167927696], [5.977220337898361, 10.127444309780895], [4.216476889965296, 8.26811384620635]], 33.83366732391494],
    };
    const settingsAndTrends = () => {
      setSetting('trs.CG3', 0.6, base);
      setSetting('trs.CG4', 0.7, base);
      importTendances({ trs: { CG3: 0.7, SSP: 0.5, CG4: 0.9 }, marge: 0.3, densities: { AS7G03: 2.7 }, processes: { CG4: { cycle: { base: 70 } } }, tooling: { taux: { ax3: 90 } } }, 't.json');
      setSetting('energy.elecNouveau', 0, base);
      setSetting('seuilTendance', 0.05, base);
    };
    const withSettings = {
      auto: [{ setup: settingsAndTrends }, [[20.580820346729986, 26.203069487255032]]],
      chosen: [{ setup: settingsAndTrends, quote: quotes.chosen[0].quote }, [[35.12646183578544, 43.7969838525228]]],
      set: [{ setup: settingsAndTrends, p3d: quotes.set[0].p3d }, [[11.00412473199484, 15.004779983792963], [5.8556538799771385, 9.654205730135697], [3.9162006318333185, 7.588855165018256]], 32.24784087894692],
    };
    for (const [name, [args, expected, set]] of [...Object.entries(quotes), ...Object.entries(withSettings).map(([n, x]) => [`${n} (settings and trends)`, x])]) {
      const c = computed(args);
      assert.equal(c.results.length, expected.length, name);
      c.results.forEach((r, i) => {
        close(r.final.pri, expected[i][0], 1e-12, `${name}: PRI of ${r.piece.name}`);
        close(r.final.years[0].prixVente, expected[i][1], 1e-12, `${name}: price of ${r.piece.name}`);
      });
      if (set) close(c.ensemble.years[0].prixVente, set, 1e-12, `${name}: price of the set`);
    }
  });

  test('a TRS typed in Paramètres beats the trend, either order: hard, with its deviation from the trend', () => {
    const quote = { pieces: { manuel: { ...PART, procede: 'CG3' } } };
    const trs = (setup) => {
      const c = computed({ quote, setup });
      return [c.results[0].trace['centre.CG3.trs'], c.results[0].final.years[0].prixVente];
    };
    const typeIn = () => setSetting('trs.CG3', 0.6, base);
    const importTrend = () => importTendances({ trs: { CG3: 0.7 } }, 'tendances.json');
    const [first, price] = trs(() => (typeIn(), importTrend()));
    const [then, priceThen] = trs(() => (importTrend(), typeIn()));
    const [alone, priceAlone] = trs(typeIn);
    for (const t of [first, then]) {
      assert.deepEqual([t.valeur, t.autorite, t.niveau, t.source.type, t.source.ref], [0.6, 'hard', 2, 'parametres', 'settings.trs.CG3']);
      assert.ok(t.source.date);
      assert.deepEqual(t.alternatives.map((a) => [a.source, a.valeur]), [['tendance', 0.7]]);
      assert.equal(t.ecart_tendance.tendance, 0.7);
      close(t.ecart_tendance.ecart_rel, -1 / 7, 1e-12, 'deviation');
      assert.equal(t.ecart_tendance.alerte, false);
      assert.deepEqual([t.confiance.niveau, t.validation_requise, t.alertes], ['haute', false, []]);
    }
    assert.equal(alone.ecart_tendance, null);
    assert.equal(price, priceAlone, 'the trend changes nothing');
    assert.equal(priceThen, priceAlone);
    // Beyond the threshold set in Paramètres: an alert.
    const [over] = trs(() => (typeIn(), importTrend(), setSetting('seuilTendance', 0.1, base)));
    assert.equal(over.ecart_tendance.alerte, true);
    assert.deepEqual(over.alertes.map((a) => a.type), ['ecart_tendance']);
    // Nothing typed in: the trend, a soft prior to validate; no trend either: the default of the code, with its alert.
    const [trend] = trs(importTrend);
    assert.deepEqual([trend.valeur, trend.autorite, trend.niveau, trend.source.fichier, trend.validation_requise], [0.7, 'soft_prior', 4, 'tendances.json', true]);
    const [code] = trs(() => {});
    assert.deepEqual([code.valeur, code.autorite, code.validation_requise, code.alertes.map((a) => a.type)], [DEFAULT_TRS.CG3, 'default_code', true, ['defaut_code']]);
  });

  test('a trends file does not set the threshold of the deviations from it: the alert stays', () => {
    const quote = { pieces: { manuel: { ...PART, procede: 'CG3' } } };
    const c = computed({ quote, setup: () => (setSetting('trs.CG3', 0.9, base), importTendances({ seuilTendance: 10, trs: { CG3: 0.3 } }, 't.json')) });
    const t = c.results[0].trace['centre.CG3.trs'];
    assert.equal(t.valeur, 0.9);
    assert.equal(t.ecart_tendance.alerte, true);
    assert.equal(t.ecart_tendance.seuil, defaultSettings(base).seuilTendance);
    assert.ok(t.alertes.some((a) => a.type === 'ecart_tendance'));
  });

  test('settings of version 1 equal to the trends imported since: to validate, said above the workbook, the same prices', () => {
    // The calibrated file imported by the previous version (made-up values): merged into its settings, then imported again as trends.
    const calibrated = { marge: 0.33, trs: { CG3: 0.55 } };
    const quote = { pieces: { manuel: { ...PART, procede: 'CG3' } } };
    const c = computed({ quote, setup: () => (storage.set(V1, JSON.stringify(calibrated)), importTendances(calibrated, 'cale.json')) });
    const layers = loadSettingsLayers(base);
    assert.deepEqual(pick(layers.provenance('marge'), ['source', 'migrated', 'trend', 'classeur']), { source: 'saisie', migrated: true, trend: 0.33, classeur: base.defaults.marge });
    const typed = computed({ quote, setup: () => (setSetting('marge', 0.33, base), setSetting('trs.CG3', 0.55, base)) });
    assert.equal(c.results[0].final.years[0].prixVente, typed.results[0].final.years[0].prixVente, 'nothing changes in the price');
    const marge = c.trace['devis.marge'];
    assert.deepEqual([marge.valeur, marge.source.type, marge.confiance.niveau, marge.validation_requise], [0.33, 'parametres', 'moyenne', true]);
    assert.match(marge.confiance.raison, /reprise de la version précédente : saisie ou fichier calé, indiscernables/);
    assert.ok(marge.alertes.some((a) => a.type === 'divergence' && /égale à la tendance « cale\.json »[\s\S]*passe avant le classeur \(12 %\)/.test(a.message)), JSON.stringify(marge.alertes));
    assert.deepEqual(marge.alternatives.map((a) => [a.source, a.valeur]), [['tendance', 0.33], ['classeur', base.defaults.marge]]);
    const trs = c.results[0].trace['centre.CG3.trs'];
    assert.deepEqual([trs.confiance.niveau, trs.validation_requise], ['moyenne', true]);
    assert.ok(trs.alertes.some((a) => a.type === 'divergence'));
    // Typed in now, the same values: what they were before.
    const now = typed.trace['devis.marge'];
    assert.deepEqual([now.confiance.niveau, now.validation_requise, now.alertes], ['haute', false, []]);
  });

  test('"Adopter la tendance" over the workbook: traced as an adopted trend, to validate, the value of the workbook beside it', () => {
    const c = computed({ setup: () => (importTendances({ marge: 0.3 }, 't.json'), adoptTendance('marge', base)) });
    assert.deepEqual(pick(loadSettingsLayers(base).provenance('marge'), ['source', 'from', 'fileName', 'classeur']), { source: 'saisie', from: 'tendance', fileName: 't.json', classeur: base.defaults.marge });
    const typed = computed({ setup: () => setSetting('marge', 0.3, base) });
    assert.equal(c.results[0].final.years[0].prixVente, typed.results[0].final.years[0].prixVente);
    const t = c.trace['devis.marge'];
    assert.deepEqual([t.valeur, t.source.type, t.validation_requise], [0.3, 'parametres', true]);
    assert.match(t.confiance.raison, /^tendance du fichier « t\.json » adoptée dans Paramètres le \d\d\/\d\d\/\d{4} à la place de la valeur du classeur \(12 %\)$/);
    assert.ok(t.hypotheses.some((h) => /adoptée dans Paramètres/.test(h)));
    assert.ok(t.alternatives.some((a) => a.source === 'classeur' && a.valeur === base.defaults.marge));
    assert.ok(t.alertes.some((a) => a.type === 'divergence'));
  });

  test('"Marge mini": the trace cites the minimum rate the margin was solved for, and says when Paramètres has another one', () => {
    const margeMini = { valeur: 0.2, tauxMini: 0.1 };
    let c = computed({ quote: { marge: 0.2, margeMini }, setup: () => setSetting('tauxMini', 0.12, base) });
    const rate = c.trace['parametres.tauxMini'];
    assert.deepEqual([rate.valeur, rate.source.type, rate.source.ref], [0.1, 'saisie', 'q.margeMini.tauxMini']);
    assert.deepEqual(rate.alternatives.map((a) => [a.source, a.valeur]), [['parametres', 0.12]]);
    const marge = c.trace['devis.marge'];
    assert.equal(marge.valeur, 0.2);
    assert.ok(marge.alertes.some((a) => a.type === 'divergence' && a.message === 'marge mini calculée avec un taux mini de 10 %, Paramètres : 12 % : relancez « Marge mini »'), JSON.stringify(marge.alertes));
    assert.equal(marge.validation_requise, true);
    // The same rate: as before, no alert.
    c = computed({ quote: { marge: 0.2, margeMini: { valeur: 0.2, tauxMini: base.defaults.tauxMini } } });
    assert.equal(c.trace['parametres.tauxMini'].source.type, 'classeur');
    assert.ok(!c.trace['devis.marge'].alertes.some((a) => a.type === 'divergence'));
  });

  test('an alert of the settings shared by the pieces of a set counts once, with the pieces', () => {
    const parts = ['A1', 'A2', 'A3', 'A4'].map((name, index) => ({ ...PARTS_3D[0], index, name }));
    const c = computed({ p3d: { file: 'asm.step', parts, selected: [0, 1, 2, 3] } });
    const sum = summarize([{ piece: null, trace: c.trace }, ...c.results.map((r) => ({ piece: r.piece.name, trace: r.trace }))]);
    const ids = sum.alertes.map((a) => `${a.cle}|${a.type}|${a.message}`);
    assert.equal(new Set(ids).size, ids.length, 'each alert once');
    assert.ok(sum.occurrences > sum.alertes.length);
    assert.equal(sum.occurrences, sum.alertes.reduce((n, a) => n + Math.max(1, a.pieces.length), 0));
    const shared = sum.alertes.find((a) => a.cle === 'parametres.cycle');
    assert.deepEqual(shared.pieces, ['A1', 'A2', 'A3', 'A4']);
    assert.ok(sum.alertes.filter((a) => !a.pieces.length).every((a) => a.cle.startsWith('devis.') || a.cle.startsWith('ensemble.') || a.cle.startsWith('parametres.prix')));
  });

  test('two bodies of the same name: each one in the set, under its own name', () => {
    const parts = [{ ...PARTS_3D[0], name: 'Corps' }, { ...PARTS_3D[2], name: 'Corps' }];
    const c = computed({ p3d: { file: 'asm.step', parts, selected: [0, 2] } });
    const set = c.trace['ensemble.prix.vente'];
    assert.deepEqual(set.source.entrees, ['piece.prix.vente [Corps (corps 1)]', 'piece.prix.vente [Corps (corps 3)]']);
    assert.equal(set.confiance.niveau, weakest(...c.results.map((r) => r.trace['piece.prix.vente'].confiance.niveau)));
    assert.equal(set.validation_requise, c.results.some((r) => r.trace['piece.prix.vente'].validation_requise));
    assert.deepEqual(ui.costingSnapshot().pieces.map((p) => p.nom), ['Corps (corps 1)', 'Corps (corps 3)']);
  });

  test('the cycle of the trend: the coefficients of the trends file, the others those of Paramètres', () => {
    computed({ setup: () => (importTendances({ processes: { CG3: { cycle: { base: 50 } } } }, 't.json'), setSetting('processes.CG3.cycle.parKg', 7, base)) });
    const t = ui.trendSettings();
    assert.deepEqual(t.processes.CG3.cycle, { ...DEFAULT_PROCESSES.CG3.cycle, base: 50, parKg: 7 });
    assert.deepEqual(Object.keys(t.processes), ['CG3']);
    assert.deepEqual(t.coefficients, { CG3: ['base'] });
    computed();
    assert.equal(ui.trendSettings(), null);
  });

  test('no 3D model opened yet (after a reload): the inputs of the pieces of the last one are kept for it', () => {
    computed({ quote: { pieceFile: 'asm.step', pieces: { manuel: PART, '0:A': { cycleReel: 99, cycleIA: { valeur: 120 } } } } });
    const saved = JSON.parse(storage.get('reader3d.chiffrage.quote.v1'));
    assert.equal(saved.pieceFile, 'asm.step');
    assert.deepEqual(saved.pieces['0:A'], { cycleReel: 99, cycleIA: { valeur: 120 } });
    // Another file: they do not apply.
    globalThis.window.reader3d = { part: () => ({ file: 'autre.step', parts: PARTS_3D, selected: [0] }) };
    ui.compute();
    assert.deepEqual(JSON.parse(storage.get('reader3d.chiffrage.quote.v1')).pieces, {});
  });

  test('the confidence of a price is that of its weakest input', () => {
    for (const c of [computed(), computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 300, empreintes: 2, miseAuMille: 1.5 } } } }), computed({ quote: { month: '2031-01' } })]) {
      const r = c.results[0];
      const at = (k) => r.trace[k] ?? c.trace[k];
      for (const key of ['piece.prix.vente', 'piece.prix.pri', 'piece.kgCast', 'devis.metal.prixVente', 'devis.metal.prixAchat']) {
        const t = at(key);
        const inputs = t.source.entrees.map(at);
        assert.equal(t.confiance.niveau, weakest(...inputs.map((x) => x.confiance.niveau)), key);
        assert.equal(t.validation_requise, inputs.some((x) => x.validation_requise), key);
      }
    }
    // The code defaults of the islands make the estimates weak; a price is never above them.
    const r = computed().results[0];
    assert.equal(r.trace['piece.cycle'].confiance.niveau, 'faible');
    assert.equal(r.trace['piece.prix.vente'].confiance.niveau, 'faible');
    assert.match(r.trace['piece.prix.vente'].confiance.raison, /^entrée la plus faible : piece\.prix\.pri ← /);
  });

  test('a missing sale price: 0 used, nil confidence and an alert, down to the price', () => {
    const c = computed({ quote: { month: '2031-01' } });
    const t = c.trace['devis.metal.coursVente'];
    assert.deepEqual([t.valeur, t.autorite, t.confiance.niveau, t.validation_requise], [0, 'default_code', 'nulle', true]);
    assert.deepEqual(t.alertes.map((a) => a.type), ['repli_zero']);
    assert.match(t.alertes[0].message, /cours de vente indisponible.*0 utilisé/);
    assert.equal(c.trace['devis.metal.prixVente'].confiance.niveau, 'nulle');
    const price = c.results[0].trace['piece.prix.vente'];
    assert.deepEqual([price.confiance.niveau, price.validation_requise], ['nulle', true]);
    const sum = summarize([{ piece: null, trace: c.trace }, { piece: 'Pièce', trace: c.results[0].trace }]);
    assert.ok(sum.alertes.some((a) => a.cle === 'devis.metal.coursVente' && a.type === 'repli_zero'));
    assert.ok(sum.aValider >= sum.aValiderCalcul && sum.aValiderCalcul > 0);
    // The indices have the month: their average, no alert.
    const ok = computed().trace['devis.metal.coursVente'];
    assert.deepEqual([ok.source.type, ok.autorite, ok.confiance.niveau, ok.alertes], ['indices', 'hard', 'haute', []]);
    // Month of the customer request, missing from the indices: the request's own sale price.
    const rfq = computed({ quote: { serie: ORDER, month: ORDER.matiere.month } }).trace['devis.metal.coursVente'];
    assert.deepEqual([rfq.valeur, rfq.source.type, rfq.niveau, rfq.source.fichier, rfq.alertes], [ORDER.matiere.coursVente, 'rfq', 1, 'RFQ.xlsm', []]);
  });

  test('a centre without rate, a price typed at 0, an island imposed out of reach: alerts', () => {
    // The CG3 centre without any cost: rate 0.
    const workbook = structuredClone(base);
    const cg3 = workbook.centres.find((x) => x.code === 'CG3');
    for (const m of Object.values(cg3.modes)) m.costs = m.costs.map(() => 0);
    cg3.annual = Object.fromEntries(Object.keys(cg3.annual).map((k) => [k, 0]));
    cg3.invest = { structure: 0, composant: 0, dureeStructure: 0, dureeComposant: 0 };
    const c = computed({ workbook, quote: { pieces: { manuel: { ...PART, procede: 'CG3', outillagePrix: 0 } } } });
    const T = c.results[0].trace;
    assert.deepEqual([T['centre.CG3.taux'].valeur, T['centre.CG3.taux'].confiance.niveau], [0, 'nulle']);
    assert.deepEqual(T['centre.CG3.taux'].alertes.map((a) => a.type), ['repli_zero']);
    assert.ok(T['piece.va'].alertes.some((a) => a.type === 'repli_zero' && /CG3/.test(a.message)));
    assert.equal(T['piece.prix.vente'].confiance.niveau, 'nulle');
    assert.deepEqual(T['piece.outillage.total'].alertes.map((a) => a.type), ['saisie_ignoree']);
    const out = computed({ quote: { pieces: { manuel: { ...PART, toileMini: 2, procede: 'CG3' } } } }).results[0].trace['piece.ilot'];
    assert.deepEqual([out.valeur, out.source.type, out.validation_requise], ['CG3', 'saisie', true]);
    assert.deepEqual(out.alertes.map((a) => a.type), ['infaisable']);
  });

  test('the weight, mise au mille and scrap rate of the customer request: alternatives, an alert beyond the tolerance, never applied', () => {
    const without = { ...ORDER, poidsBrut: null, poidsVendu: null, miseAuMille: null, rebutUsinage: null };
    const prices = (c) => c.results.map((r) => [r.final.pri, r.final.years[0].prixVente, r.part.poids, r.route.miseAuMille, r.final.kgCast]);
    const rfqAlternatives = (t) => t.alternatives.filter((a) => a.source === 'rfq').map((a) => [a.autorite, a.ref, a.valeur]);
    // Within the tolerance (10 %): alternatives (hard), no alert; the value used is the one typed in or estimated.
    let c = computed({ quote: { serie: ORDER } });
    assert.deepEqual(prices(c), prices(computed({ quote: { serie: without } })), 'the values of the request change no value');
    let r = c.results[0];
    assert.deepEqual(rfqAlternatives(r.trace['piece.poids']), [
      ['hard', 'demande client : Poids Brut vendu (1- Données GO NO GO)', 1.25],
      ['hard', 'demande client : Poids vendu (5- Chiffrage Fonderie)', 1.1],
    ]);
    assert.deepEqual([r.trace['piece.poids'].valeur, r.trace['piece.poids'].source.type, r.trace['piece.poids'].alertes], [1.2, 'saisie', []]);
    close(r.trace['piece.poids'].alternatives[1].ecart_rel, 1.2 / 1.1 - 1, 1e-12, 'deviation from the weight sold');
    assert.deepEqual(rfqAlternatives(r.trace['piece.miseAuMille']), [['hard', 'demande client : Mise au mille (5- Chiffrage Fonderie)', 1.6]]);
    assert.equal(r.trace['piece.miseAuMille'].valeur, r.route.miseAuMille);
    assert.ok(Math.abs(r.route.miseAuMille / 1.6 - 1) <= 0.1 && !r.trace['piece.miseAuMille'].alertes.some((a) => a.type === 'ecart_demande'));
    // The scrap rate of the quote (workbook: 2 %) against the request's (3 %): beyond the tolerance.
    const scrap = c.trace['devis.rebutUsinage'];
    assert.deepEqual([scrap.valeur, scrap.source.type, rfqAlternatives(scrap)], [0.02, 'classeur', [['hard', 'demande client : Taux de rebuts usinage (5- Chiffrage Fonderie)', 0.03]]]);
    assert.deepEqual(scrap.alertes.map((a) => a.type), ['ecart_demande']);
    assert.match(scrap.alertes[0].message, /Taux de rebuts usinage de la demande client 3 %, valeur utilisée 2 % \(écart de [-−]33,3\s%\) : au-delà de la tolérance de 10\s%, valeur de la demande non appliquée/);
    assert.equal(r.trace['piece.prix.pri'].validation_requise, true, 'down to the price');
    // The scrap rate of the request typed in: no deviation.
    const same = computed({ quote: { serie: ORDER, rebutUsinage: 0.03 } }).trace['devis.rebutUsinage'];
    assert.deepEqual([same.source.type, same.alertes, same.alternatives.filter((a) => a.source === 'rfq').map((a) => a.ecart_rel)], ['saisie', [], [0]]);

    // Weight beyond the tolerance: an alert for each weight of the request, to validate down to the price; the weight stays the one typed in.
    c = computed({ quote: { serie: ORDER, pieces: { manuel: { ...PART, poids: 1.5 } } } });
    r = c.results[0];
    assert.equal(r.part.poids, 1.5);
    assert.deepEqual(r.trace['piece.poids'].alertes.map((a) => a.type), ['ecart_demande', 'ecart_demande']);
    assert.match(r.trace['piece.poids'].alertes[0].message, /Poids brut vendu de la demande client 1,25 kg, valeur utilisée 1,5 kg \(écart de \+20\s%\)/);
    assert.deepEqual([r.trace['piece.poids'].validation_requise, r.trace['piece.kgCast'].validation_requise, r.trace['piece.prix.vente'].validation_requise], [true, true, true]);

    // Mise au mille typed in (island chosen): 1.5 within 10 % of 1.6, 1.2 beyond; the one typed in is used.
    const mam = (miseAuMille) => computed({ quote: { serie: ORDER, pieces: { manuel: { ...PART, procede: 'CG3', miseAuMille } } } }).results[0];
    r = mam(1.5);
    assert.deepEqual([r.route.miseAuMille, r.trace['piece.miseAuMille'].alertes], [1.5, []]);
    r = mam(1.2);
    assert.deepEqual([r.route.miseAuMille, r.trace['piece.miseAuMille'].alertes.map((a) => a.type)], [1.2, ['ecart_demande']]);
    assert.equal(r.trace['piece.miseAuMille'].source.type, 'saisie');

    // A set of pieces: the request (one part) compared with the set, not with each piece.
    const p3d = { file: 'asm.step', parts: PARTS_3D.slice(0, 2), selected: [0, 1] };
    c = computed({ quote: { serie: ORDER, pieces: {} }, p3d });
    for (const x of c.results) assert.deepEqual([rfqAlternatives(x.trace['piece.poids']), rfqAlternatives(x.trace['piece.miseAuMille'])], [[], []], x.piece.name);
    const weight = c.trace['ensemble.poids'];
    assert.deepEqual([weight.valeur, weight.source.entrees], [c.ensemble.poids, ['piece.poids [A]', 'piece.poids [B]']]);
    assert.deepEqual(rfqAlternatives(weight).map((a) => a[2]), [1.25, 1.1]);
    assert.deepEqual(weight.alertes.map((a) => a.type), ['ecart_demande', 'ecart_demande'], `${c.ensemble.poids} kg`);
    const setMam = c.trace['ensemble.miseAuMille'];
    close(setMam.valeur, c.results.reduce((n, x) => n + x.final.kgCast, 0) / c.ensemble.poids, 1e-12, 'mise au mille of the set');
    assert.deepEqual(rfqAlternatives(setMam).map((a) => a[2]), [1.6]);
    assert.deepEqual(c.trace['ensemble.prix.vente'].source.entrees.slice(-2), ['ensemble.poids', 'ensemble.miseAuMille']);
    assert.equal(c.trace['ensemble.prix.vente'].validation_requise, true);
    assert.deepEqual(prices(c), prices(computed({ quote: { serie: without, pieces: {} }, p3d })));
    // Without those values in the request: no trace of the set's weight.
    assert.equal(computed({ quote: { serie: without, pieces: {} }, p3d }).trace['ensemble.poids'], undefined);
    // The comparison shown in the "Commande série" card.
    assert.deepEqual(demandeComparee(ORDER, { poids: 1.5, rebutUsinage: 0.03 }).map((d) => [d.field, d.utilise, d.alerte]), [
      ['poidsBrut', 1.5, true], ['poidsVendu', 1.5, true], ['miseAuMille', null, false], ['rebutUsinage', 0.03, false],
    ]);
    assert.deepEqual(DEMANDE.map((d) => d.tolerance), [0.1, 0.1, 0.1, 0.1]);
  });

  test('an alloy without density: the generic density, said in the trace; one typed in Paramètres is used', () => {
    const workbook = structuredClone(base);
    workbook.lists.alliages.push('AS5Z');
    const p3d = { file: 'support.step', parts: [PARTS_3D[0]], selected: [0] };
    let c = computed({ workbook, p3d, quote: { alliage: 'AS5Z', pieces: {} } });
    assert.equal(c.density, GENERIC_DENSITY);
    close(c.results[0].part.poids, (PARTS_3D[0].volume / 1e6) * GENERIC_DENSITY, 1e-12, 'weight from the 3D model');
    const t = c.trace['devis.densite'];
    assert.deepEqual([t.valeur, t.autorite, t.validation_requise, t.alertes.map((a) => a.type)], [GENERIC_DENSITY, 'default_code', true, ['defaut_code']]);
    assert.match(t.alertes[0].message, /densité générique 2,7 g\/cm³ : l'alliage AS5Z n'a pas de densité dans Paramètres/);
    assert.equal(c.results[0].trace['piece.poids'].validation_requise, true);
    c = computed({ workbook, p3d, quote: { alliage: 'AS5Z', pieces: {} }, setup: () => setSetting('densities.AS5Z', 2.9, workbook) });
    assert.deepEqual([c.density, c.trace['devis.densite'].source.type, c.trace['devis.densite'].alertes], [2.9, 'parametres', []]);
  });

  test('a 3D model: geometry as evidence, the weight typed in above the one measured, divergent sources', () => {
    const p3d = { file: 'support.step', parts: [PARTS_3D[0]], selected: [0] };
    let r = computed({ p3d, quote: { pieces: {} } }).results[0];
    assert.deepEqual([r.trace['piece.volume3d'].autorite, r.trace['piece.volume3d'].niveau, r.trace['piece.volume3d'].source.fichier], ['evidence', 3, 'support.step']);
    assert.deepEqual([r.trace['piece.toileMini'].source.type, r.trace['piece.toileMini'].valeur], ['geometrie', 5]);
    const weight = r.trace['piece.poids'];
    assert.deepEqual([weight.source.type, weight.source.entrees], ['calcul', ['piece.volume3d', 'devis.densite']]);
    close(weight.valeur, (PARTS_3D[0].volume / 1e6) * DEFAULT_DENSITIES.AS7G03, 1e-12, 'weight from the 3D model');
    assert.notEqual(weight.confiance.niveau, 'haute', 'the 3D model taken as it is: rough or machined not said');
    // Typed in: it wins; 25 % from the 3D weight: divergent sources.
    r = computed({ p3d, quote: { pieces: { '0:A': { poids: 0.9 } } } }).results[0];
    const typed = r.trace['piece.poids'];
    assert.deepEqual([typed.valeur, typed.autorite, typed.source.type], [0.9, 'hard', 'saisie']);
    assert.deepEqual(typed.alternatives.map((a) => a.source), ['calcul']);
    assert.deepEqual(typed.alertes.map((a) => a.type), ['divergence']);
    assert.equal(typed.validation_requise, true);
    // A body without wall thickness: 0 used, said.
    const c = computed({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } });
    const thin = c.results[2].trace['piece.toileMini'];
    assert.deepEqual([thin.valeur, thin.confiance.niveau, thin.alertes.map((a) => a.type)], [0, 'nulle', ['repli_zero']]);
    // The set: computed from the prices of its pieces.
    assert.deepEqual(c.trace['ensemble.prix.vente'].source.entrees, ['piece.prix.vente [A]', 'piece.prix.vente [B]', 'piece.prix.vente [C]']);
  });
});

// --------------------------------------------------------------------------- the costing read by the AI page

// The AI page (task "Chiffrage") reads a frozen snapshot of the quote
// (ui.js:costingSnapshot), sends it to a model (ai-trace.js:traceForAI) and
// checks the numbers of the answer against it (checkNumbers).
describe('the costing read by the AI page (read only)', () => {
  before(async () => {
    globalThis.window ??= { addEventListener() {} };
    ui ??= await import('../../web/chiffrage/ui.js');
  });

  /** Every object of `o` frozen. */
  const deeplyFrozen = (o) => !(o && typeof o === 'object') || (Object.isFrozen(o) && Object.values(o).every(deeplyFrozen));
  /** ui.js:costingSnapshot() after computed(): storage set up as the Chiffrage page would find it. */
  const snapshotOf = (opts) => {
    const c = computed(opts);
    return [ui.costingSnapshot(), c];
  };

  test('costingSnapshot: the traces of the quote and of its pieces, the best routes, the alerts and the data files', () => {
    const [s, c] = snapshotOf();
    assert.deepEqual(Object.keys(s), ['devis', 'pieces', 'alertes', 'resume', 'fichiers', 'noms']);
    assert.deepEqual(s.noms, [], 'no customer, reference nor designation typed in');
    assert.equal(s.devis.ensemble, false);
    for (const key of QUOTE_KEYS) assert.deepEqual(s.devis.trace[key], c.trace[key], key);
    assert.equal(s.pieces.length, 1);
    const [p] = s.pieces;
    const r = c.results[0];
    assert.deepEqual([p.nom, p.chiffree], ['Pièce', true]);
    assert.deepEqual(p.trace, JSON.parse(JSON.stringify(r.trace)));
    // The values are those of the page: the same prices.
    assert.equal(p.trace['piece.prix.vente'].valeur, r.final.years[0].prixVente);
    assert.equal(p.trace['piece.prix.pri'].valeur, r.final.pri);
    // The three best islands, ranked, the one retained marked, with what the ranking used.
    assert.deepEqual(p.routes.map((x) => [x.rang, x.ilot, x.finition, x.retenue]), r.best.map((b, i) => [i + 1, b.process, b.finition, b.process === r.route.process]));
    assert.ok(p.routes.every((x) => x.faisable && Number.isFinite(x.qualite) && x.prix > 0 && Array.isArray(x.raisons)));
    assert.equal(p.routes.filter((x) => x.retenue).length, 1);
    // The alerts and the counts of the Traçabilité card.
    const sum = summarize([{ piece: null, trace: c.trace }, { piece: 'Pièce', trace: r.trace }]);
    assert.deepEqual(s.alertes, sum.alertes);
    assert.deepEqual(s.resume, { valeurs: sum.valeurs, a_valider: sum.aValider, alertes: sum.alertes.length });
    assert.deepEqual(s.fichiers, {
      classeur: { nom: 'test.xlsm', date: base.source.importedAt },
      indices: { nom: 'test.xlsm', date: base.source.importedAt, source: 'copie du classeur' },
      tendances: null,
      rfq: null,
    });
    // With a customer request and trends: their files and dates.
    const [withFiles] = snapshotOf({ quote: { serie: ORDER }, setup: () => importTendances({ trs: { CG3: 0.7 } }, 'tendances.json') });
    assert.deepEqual([withFiles.fichiers.rfq.nom, withFiles.fichiers.rfq.date], ['RFQ.xlsm', ORDER.importedAt]);
    assert.equal(withFiles.fichiers.tendances.nom, 'tendances.json');
    // A set: every piece, the values of the set with those of the quote.
    const [set, cs] = snapshotOf({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } });
    assert.deepEqual([set.devis.ensemble, set.pieces.map((x) => x.nom)], [true, ['A', 'B', 'C']]);
    assert.equal(set.devis.trace['ensemble.prix.vente'].valeur, cs.ensemble.years[0].prixVente);
  });

  test('costingSnapshot: a frozen copy, computed without saving anything; null without a costing workbook', () => {
    const [s, c] = snapshotOf();
    assert.ok(deeplyFrozen(s));
    assert.throws(() => {
      s.pieces[0].trace['piece.prix.vente'].valeur = 1;
    }, TypeError);
    assert.throws(() => s.alertes.push({}), TypeError);
    assert.throws(() => {
      s.devis.trace['devis.marge'] = null;
    }, TypeError);
    // The page computes the same prices after it.
    const again = ui.compute();
    assert.deepEqual([again.results[0].final.pri, again.results[0].final.years[0].prixVente], [c.results[0].final.pri, c.results[0].final.years[0].prixVente]);

    // Another 3D file than the one of the inputs of the pieces: the snapshot computes without them, and writes nothing.
    computed({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0] }, quote: { pieces: { '0:A': { poids: 9 } } } });
    globalThis.window.reader3d = { part: () => ({ file: 'autre.step', parts: PARTS_3D, selected: [0] }) };
    const before = new Map(storage);
    const writes = [];
    const { setItem, removeItem } = globalThis.localStorage;
    globalThis.localStorage.setItem = (k, v) => (writes.push(k), setItem(k, v));
    globalThis.localStorage.removeItem = (k) => (writes.push(k), removeItem(k));
    let other;
    try {
      other = ui.costingSnapshot();
    } finally {
      Object.assign(globalThis.localStorage, { setItem, removeItem });
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(new Map(storage), before);
    assert.notEqual(other.pieces[0].trace['piece.poids'].valeur, 9, 'the inputs of the other file do not apply');
    assert.equal(other.pieces[0].trace['piece.poids'].source.type, 'calcul');

    // The quote of another tab of the 3D page (a new one: the default quote, no piece weight).
    computed();
    try {
      const tab2 = ui.costingSnapshot({ tab: 2 });
      assert.deepEqual([tab2.pieces[0].chiffree, tab2.pieces[0].trace['piece.poids'].valeur], [false, null]);
      assert.equal(ui.costingSnapshot({ tab: 1 }).pieces[0].trace['piece.poids'].valeur, PART.poids);
    } finally {
      setQuoteTab(1);
    }

    // No costing workbook: nothing to read.
    storage.clear();
    assert.equal(ui.costingSnapshot(), null);
    assert.equal(traceForAI(null), null);
  });

  test('costingSnapshot noms: the names of the quote that tell the customer or the part, replaced by their labels in what is sent online', () => {
    const piece = { ...PART, noyaux: true, cores: [{ nom: 'Noyau central', masse: 0.2, qte: 1 }], composants: [{ designation: 'Insert fileté', qte: 2, prix: 0.1, marge: 0.1 }] };
    const [s] = snapshotOf({ quote: { serie: ORDER, ...orderValues(ORDER), pieces: { manuel: piece } } });
    const labels = Object.fromEntries(s.noms.map((n) => [n.name, n.label]));
    assert.deepEqual(labels, {
      'ACME RAIL': 'Client', 'AB-123': 'Référence', 'SUPPORT PLATE': 'Désignation', 'AB-123 - SUPPORT PLATE': 'Référence', 'AB-123 ind A': 'Plan',
      'Castings 2027': 'Demande', 'GTEST-CG-2026-00': 'Offre', 'Noyau central': 'Noyau 1', 'Insert fileté': 'Composant 1',
    });
    // The piece typed in is named after the designation; the core box after its core: both in the trace.
    const trace = traceForAI(s);
    assert.equal(trace.pieces[0].nom, 'SUPPORT PLATE');
    assert.match(JSON.stringify(trace), /Noyau central/);
    // Online: none of these names, nor the files read (the request's name may tell the customer).
    const context = { source: { file: 'AB-123.step' }, bodies: [], costing_trace: trace };
    const sent = anonymizer(context, s.noms).context(context);
    const text = JSON.stringify(sent);
    for (const name of [...s.noms.map((n) => n.name), 'RFQ.xlsm', 'test.xlsm']) assert.ok(!text.includes(name), name);
    assert.equal(sent.costing_trace.pieces[0].nom, 'Désignation');
    assert.deepEqual([sent.costing_trace.fichiers.classeur.nom, sent.costing_trace.fichiers.rfq.nom], ['classeur de chiffrage', 'demande client']);
    assert.match(text, /boîte à noyau « Noyau 1 »/);
    // The values themselves are those of the trace.
    assert.deepEqual(sent.costing_trace.pieces[0].valeurs['piece.prix.vente'], trace.pieces[0].valeurs['piece.prix.vente']);
  });

  test('costingNames: the names of the quote of a tab, for every task of the AI page, also without a costing workbook', () => {
    const piece = { ...PART, noyaux: true, cores: [{ nom: 'Noyau central', masse: 0.2, qte: 1 }] };
    computed({ quote: { client: 'ACME ESSAI', reference: 'REF-NOMS', pieces: { manuel: piece } } });
    assert.deepEqual(ui.costingNames({ tab: 1 }), ui.costingSnapshot().noms);
    assert.deepEqual(ui.costingNames().map((n) => [n.name, n.label]), [['ACME ESSAI', 'Client'], ['REF-NOMS', 'Référence'], ['Noyau central', 'Noyau 1']]);
    // No costing workbook: no snapshot, the names of the quote still.
    storage.delete('reader3d.chiffrage.base.v1');
    assert.equal(ui.costingSnapshot(), null);
    assert.deepEqual(ui.costingNames({ tab: 1 }).map((n) => n.name), ['ACME ESSAI', 'REF-NOMS', 'Noyau central']);
    // Another tab without a quote: none; the quote read and saved stays the one of the tab shown.
    assert.deepEqual(ui.costingNames({ tab: 2 }), []);
    assert.equal(currentQuoteTab(), 1);
  });

  test('an answer of the AI page kept with the quote of its tab, for the record: nothing else of the quote changes', () => {
    const c = computed();
    const saved = () => JSON.parse(storage.get('reader3d.chiffrage.quote.v1'));
    const before = saved();
    const entry = { date: '2026-10-08T10:00:00.000Z', provider: 'Groq', model: 'openai/gpt-oss-120b', question: 'Pourquoi ce prix ?', answer: 'Le prix vient du cycle.', verified: true };
    ui.addAIAnalysis(entry, { tab: 1 });
    assert.deepEqual(saved().analysesIA, [entry]);
    assert.deepEqual({ ...saved(), analysesIA: before.analysesIA }, before);
    ui.reload();
    assert.deepEqual(ui.compute().results[0].final.years[0].prixVente, c.results[0].final.years[0].prixVente);
    // The quote of another tab: its own list; the first tab's unchanged.
    try {
      ui.addAIAnalysis({ ...entry, question: 'Et le moule ?', verified: false }, { tab: 2 });
      setQuoteTab(2);
      assert.deepEqual(loadQuote(base, indices).analysesIA.map((a) => [a.question, a.verified]), [['Et le moule ?', false]]);
    } finally {
      setQuoteTab(1);
    }
    assert.deepEqual(loadQuote(base, indices).analysesIA.map((a) => a.question), ['Pourquoi ce prix ?']);
    // A new quote has none.
    assert.deepEqual(defaultQuote(base, indices).analysesIA, []);
  });

  test('the trace sent to a model: every value with its source and authority, percentages in percent, nothing more than the snapshot', () => {
    const [s] = snapshotOf({ quote: { serie: ORDER } });
    const t = traceForAI(s);
    assert.equal(t.lecture_seule, true);
    assert.equal(t.compaction, undefined);
    assert.deepEqual(Object.keys(t.devis.valeurs), Object.keys(s.devis.trace));
    assert.deepEqual(Object.keys(t.pieces[0].valeurs), Object.keys(s.pieces[0].trace));
    for (const [cle, v] of [...Object.entries(t.devis.valeurs), ...Object.entries(t.pieces[0].valeurs)]) {
      const x = s.devis.trace[cle] ?? s.pieces[0].trace[cle];
      assert.equal(v.autorite, x.autorite, cle);
      assert.equal(v.confiance, x.confiance.niveau, cle);
      assert.equal(v.a_valider ?? false, x.validation_requise, cle);
      assert.equal(v.ref, x.source.ref, cle);
      if (typeof x.valeur === 'number') close(v.valeur, x.unite === '%' ? x.valeur * 100 : x.valeur, 5e-5, cle); // rounded: 6 significant digits, 2 decimals above 100
    }
    assert.equal(t.devis.valeurs['devis.marge'].valeur, 12);
    assert.deepEqual(t.devis.valeurs['devis.rebutUsinage'].autres_sources.map((a) => [a.valeur, a.ecart_pct]), [[3, -33.3333]]);
    assert.equal(t.alertes.length, s.alertes.length);
    assert.ok(t.alertes.some((a) => a.cle === 'devis.rebutUsinage' && a.type === 'écart à la demande client'));
  });

  test('the trace sent to a local model fits its window: less detail, then the main values only, then fewer pieces', () => {
    const [single] = snapshotOf();
    const [set] = snapshotOf({ p3d: { file: 'asm.step', parts: PARTS_3D, selected: [0, 1, 2] } });
    for (const [s, maxChars] of [[single, 9000], [single, 6000], [set, 12000], [set, 8000], [set, 5000]]) {
      const t = traceForAI(s, { maxChars });
      const size = JSON.stringify(t).length;
      assert.ok(size <= maxChars, `${size} > ${maxChars}`);
      assert.ok(t.compaction.niveau > 1 && t.compaction.omis.length === t.compaction.niveau - 1);
      // The prices and the island of each piece are always there.
      for (const p of t.pieces) for (const key of ['piece.poids', 'piece.ilot', 'piece.prix.vente']) assert.ok(p.valeurs[key], `${maxChars}: ${p.nom} ${key}`);
    }
    // A large assembly: the first pieces only, the others counted.
    const many = { ...set, pieces: Array.from({ length: 40 }, (_, i) => ({ ...set.pieces[i % 3], nom: `Corps ${i}` })) };
    const t = traceForAI(many, { maxChars: 8000 });
    assert.deepEqual([t.pieces.length, t.autres_pieces, t.compaction.niveau], [12, 28, 6]);
  });

  test('the trace sent to the AI gateway: internal amounts masked, sources and relative deviations kept', () => {
    // A TRS typed in Paramètres for every island, a trend above it; the margin of the workbook, a trend above it.
    const islands = Object.keys(DEFAULT_PROCESSES);
    const setup = () => {
      importTendances({ trs: Object.fromEntries(islands.map((k) => [k, 0.7])), marge: 0.3 }, 't.json');
      for (const k of islands) setSetting(`trs.${k}`, 0.6, base);
    };
    const [s] = snapshotOf({ quote: { serie: ORDER }, setup });
    const t = traceForAI(s, { mask: true });
    assert.match(t.masque, /montants internes masqués/);
    const p = t.pieces[0].valeurs;
    const code = p['piece.ilot'].valeur;
    for (const key of ['piece.prix.vente', 'piece.prix.pri', 'piece.va', 'piece.outillage.total', `centre.${code}.taux`, `centre.${code}.trs`]) {
      assert.equal(p[key].valeur, MASQUE, key);
      assert.ok(!('tendance' in (p[key].ecart_tendance ?? {})) && (p[key].autres_sources ?? []).every((a) => !('valeur' in a)), key);
    }
    for (const key of ['devis.marge', 'devis.metal.prixVente', 'devis.metal.coursAchat', 'devis.metal.pafAchat', 'devis.energie.elec']) assert.equal(t.devis.valeurs[key].valeur, MASQUE, key);
    // The trend of the TRS and of the margin: their deviation in percent only.
    assert.ok(Number.isFinite(p[`centre.${code}.trs`].ecart_tendance.ecart_pct));
    assert.ok(Number.isFinite(t.devis.valeurs['devis.marge'].ecart_tendance.ecart_pct));
    // Not internal: weights, island, cycle, volumes.
    for (const key of ['piece.poids', 'piece.ilot', 'piece.cycle', 'piece.kgCast', 'piece.miseAuMille']) assert.notEqual(p[key].valeur, MASQUE, key);
    assert.notEqual(t.devis.valeurs['devis.volumeTotal'].valeur, MASQUE);
    assert.ok(t.pieces[0].routes.every((r) => r.prix === MASQUE));
    // No amount of the quote anywhere in what is sent: a model citing one cannot be verified (amounts
    // with decimals: a whole one, 60 €/MWh, may also be another number of the trace, a yield of 60 %).
    const amounts = [...Object.entries(s.devis.trace), ...Object.entries(s.pieces[0].trace)]
      .filter(([cle, x]) => isInternal(cle, x.unite) && typeof x.valeur === 'number')
      .map(([cle, x]) => [cle, Math.round((x.unite === '%' ? x.valeur * 100 : x.valeur) * 100) / 100])
      .filter(([, v]) => !Number.isInteger(v));
    assert.ok(amounts.length >= 3, String(amounts));
    for (const [cle, v] of amounts) {
      const cited = v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
      assert.equal(checkNumbers(`${cle} vaut ${cited}`, t).verifiee, false, `${cle} = ${cited}`);
      assert.equal(checkNumbers(`${cle} vaut ${cited}`, traceForAI(s)).verifiee, true, `${cle} = ${cited} (unmasked)`);
    }
    assert.equal(maskNumbers('boîte à noyau « N1 » : 1 234,5 € le 08/10/2026 (CG3)'), 'boîte à noyau « N1 » : … € le 08/10/2026 (CG3)');
  });

  test('the numbers of an answer: those of the trace, rounded, verified; any other one makes it "non vérifiée"', () => {
    const [s] = snapshotOf();
    const t = traceForAI(s, { maxChars: 8000 });
    const p = t.pieces[0].valeurs;
    const fr = (v, d) => v.toLocaleString('fr-FR', { maximumFractionDigits: d });
    const good = `1. Le prix de vente (piece.prix.vente) est de ${fr(p['piece.prix.vente'].valeur, 2)} €, soit environ ${fr(Math.round(p['piece.prix.vente'].valeur), 0)} €.
2. Le cycle de ${p['piece.ilot'].valeur} (piece.cycle) est de ${fr(p['piece.cycle'].valeur, 0)} s pour ${p['piece.empreintes'].valeur} empreintes ; marge de ${fr(t.devis.valeurs['devis.marge'].valeur, 1)} % sur la VA.
Le modèle 3D, l'alliage AS7G03, la 2e route, le classeur du 08/10/2026 à 12:30 et les cours M-1/M-3 ne sont pas des valeurs.`;
    assert.deepEqual(checkNumbers(good, t), { verifiee: true, nombres: 5, inconnus: [] });
    // An invented rate, a price computed by the model: not in the trace.
    const bad = `${good}\nAvec un taux de 85 €/h, le prix serait de ${fr(p['piece.prix.vente'].valeur * 1.1, 2)} €.`;
    const check = checkNumbers(bad, t);
    assert.equal(check.verifiee, false);
    assert.deepEqual(check.inconnus, ['85', fr(p['piece.prix.vente'].valeur * 1.1, 2)]);
    // No trace (no costing workbook): every number is unverified; no number, nothing to check.
    assert.deepEqual(checkNumbers('Le prix est de 12 €.', null), { verifiee: false, nombres: 1, inconnus: ['12'] });
    assert.deepEqual(checkNumbers('Aucun classeur importé.', null), { verifiee: true, nombres: 0, inconnus: [] });
    // How numbers are read: French and English forms, thousands, signs; rounding to two significant digits at least.
    assert.deepEqual(numbersOf('1 234,5 € ; -12 % ; 0.75 ; 15 000 pièces ; 3D ; CG3 ; T6 ; P1020 ; 1er').map((n) => [n.valeur, n.tolerance]), [[1234.5, 0.05], [-12, 0.5], [0.75, 0.005], [15000, 500]]);
    assert.equal(checkNumbers('15 000', { v: 15012 }).verifiee, true);
    assert.equal(checkNumbers('15 000', { v: 15600 }).verifiee, false);
    assert.equal(checkNumbers('300 s', { v: 302 }).verifiee, true);
    assert.equal(checkNumbers('10', { v: 14 }).verifiee, false);
  });
});

// --------------------------------------------------------------------------- values proposed by the AI, applied by a person

// The task "Chiffrage" of the AI page may propose values of the inputs of a
// piece (ai-apply.js); a person accepts them, ui.js:applyAIValues writes them
// as inputs of that piece, undoAIValues takes them back.
describe('values of a piece proposed by the AI, applied once accepted', () => {
  before(async () => {
    globalThis.window ??= { addEventListener() {} };
    ui ??= await import('../../web/chiffrage/ui.js');
  });

  const trace = { pieces: [{ nom: 'Pièce', valeurs: { 'piece.poids': { valeur: 1.2, unite: 'kg' }, 'piece.empreintes': { valeur: 2 } } }] };
  const sent = { costing_trace: trace, bodies: [] };

  test('read and checked: only the inputs of a piece, each number from the source it claims for its own key, in the unit of the input', () => {
    const read = readProposals([
      { piece: 'Pièce', cle: 'piece.poids', valeur: '1,35', unite: 'kg', source: 'question', justification: 'donné par l\'utilisateur' },
      { piece: 'Pièce', cle: 'piece.prix.vente', valeur: 12, unite: '€', source: 'trace', justification: '' },
      { piece: 'Pièce', cle: 'piece.cycle', valeur: 137, unite: 's', source: 'trace', justification: 'calculé' },
      { piece: 'Autre', cle: 'piece.dimMax', valeur: 250, unite: 'mm', source: 'trace', justification: '' },
      { piece: 'Pièce', cle: 'centre.CG3.mode', valeur: '2*8', unite: '', source: 'question', justification: '' },
      { piece: 'Pièce', cle: 'piece.noyaux', valeur: 'oui', unite: '', source: 'question', justification: '' },
      { piece: 'Pièce', cle: 'piece.empreintes', valeur: 2.5, unite: '', source: 'question', justification: '' },
      'pas un objet',
    ], trace);
    assert.deepEqual(read.map((p) => [p.cle, p.champ ?? null, p.valeur, p.index, p.refus === null]), [
      ['piece.poids', 'poids', 1.35, 0, true],
      ['piece.prix.vente', null, 12, 0, false],
      ['piece.cycle', 'cycle', 137, 0, true],
      ['piece.dimMax', 'dimMax', 250, -1, false],
      ['piece.mode', 'mode', '2*8', 0, true],
      ['piece.noyaux', 'noyaux', true, 0, true],
      ['piece.empreintes', 'empreintes', 2.5, 0, false],
    ]);
    assert.equal(read[4].ilot_mode, 'CG3');
    assert.match(read[1].refus, /prix, taux, paramètre ou valeur du devis entier/);
    assert.match(read[3].refus, /pièce « Autre » absente/);
    assert.equal(read[6].refus, 'nombre entier attendu');
    // 1,35 kg written by the user; 137 s is not the cycle of the trace (computed by the model).
    const checked = checkProposals(read, sent, ['Le poids réel est de 1,35 kg.']);
    assert.equal(checked[0].refus, null);
    assert.equal(checked[2].refus, 'valeur absente de la trace de cette pièce pour cette clé');
    assert.equal(checkProposals(read, sent, [])[0].refus, 'nombre absent de vos messages');
    // Read from the trace sent for the same key: 2 cavities; the weight of the trace is no cavity count.
    const cavities = (valeur, source = 'trace') => checkProposals(readProposals([{ piece: 'Pièce', cle: 'piece.empreintes', valeur, source }], trace), sent, [])[0];
    assert.deepEqual([cavities(2).refus, cavities(2).valeur], [null, 2]);
    assert.equal(cavities(1.2).refus, 'nombre entier attendu');
    assert.match(cavities(2, '').refus, /source du nombre non indiquée/);
    assert.deepEqual(readProposals('rien', trace), []);
  });

  test('a number another source or field gives, or in another unit, is not taken for the one proposed', () => {
    const t = { pieces: [{ nom: 'P', valeurs: { 'piece.poids': { valeur: 2.1, unite: 'kg', autres_sources: [{ source: 'demande client', valeur: 2.05 }] }, 'piece.cycle': { valeur: 302, unite: 's' } } }] };
    const context = { costing_trace: t, bodies: [{ metrics: { bbox_mm: { size: [135, 48, 22] }, volume_mm3: 90000, surface_area_mm2: 30000 } }] };
    const check = (list, asked = []) => checkProposals(readProposals(list.map((p) => ({ piece: 'P', ...p })), t), context, asked).map((p) => [p.cle, p.valeur, p.refus]);
    // The user's units converted: 1350 g → 1,35 kg, 4 min → 240 s; the model may have converted them itself.
    assert.deepEqual(check([{ cle: 'piece.poids', valeur: 1350, unite: 'g', source: 'question' }, { cle: 'piece.cycle', valeur: 4, unite: 'min', source: 'question' }, { cle: 'piece.poids', valeur: 1.35, unite: 'kg', source: 'question' }], ['Le poids réel est de 1350 g et le cycle mesuré est de 4 min']),
      [['piece.poids', 1.35, null], ['piece.cycle', 240, null], ['piece.poids', 1.35, null]]);
    assert.match(readProposals([{ piece: 'P', cle: 'piece.poids', valeur: 3, unite: 'lb', source: 'question' }], t)[0].refus, /unité « lb » : kg attendu/);
    // The trace: the same key of the same piece, its value or another source's, to its rounding only.
    assert.deepEqual(check([{ cle: 'piece.cycle', valeur: 300, source: 'trace' }, { cle: 'piece.poids', valeur: 2.05, source: 'trace' }, { cle: 'piece.cycle', valeur: 302, source: 'trace' }]).map((x) => x[2] === null), [false, true, true]);
    // The analysis of the part: the measure of that input only (135 mm is no weight, 22 mm no cavity count).
    assert.deepEqual(check([{ cle: 'piece.poids', valeur: 13.5, source: 'analyse_3d' }, { cle: 'piece.dimMax', valeur: 135, source: 'analyse_3d' }, { cle: 'piece.module', valeur: 3, source: 'analyse_3d' }, { cle: 'piece.empreintes', valeur: 22, source: 'analyse_3d' }]).map((x) => x[2] === null), [false, true, true, false]);
    // The rounding of the trace: 194,02 sent for 194,0173 is the same value.
    assert.equal(sameValue(194.0173, 194.02), true);
    assert.equal(sameValue(1.234567, 1.23457), true);
    assert.equal(sameValue(1.2345, 1.2346), false);
  });

  test('applied: the inputs of the piece that differ, the island imposed for a value of its route, traced; undone: what was there before', () => {
    const c = computed();
    const r = c.results[0];
    const island = r.route.process;
    const cavities = r.trace['piece.empreintes'].valeur;
    const proposals = [{ cle: 'piece.poids', valeur: 1.35 }, { cle: 'piece.empreintes', valeur: cavities + 1 }, { cle: 'piece.dimMax', valeur: 250 }];
    const target = { tab: 1, file: null, key: 'manuel' };
    // What would change: the weight and the cavities; the largest size is already 250.
    const dry = ui.applyAIValues(target, proposals, {}, { dryRun: true });
    assert.deepEqual(dry.applied.map((x) => [x.champ, x.avant, x.apres]), [['poids', 1.2, 1.35], ['empreintes', cavities, cavities + 1]]);
    assert.deepEqual(dry.same.map((x) => x.champ), ['dimMax']);
    assert.equal(loadQuote(base, indices).pieces.manuel.poids, 1.2, 'a dry run changes nothing');
    // Applied: the inputs written, the island of the route imposed with its finishing, each kept with what was there before.
    const done = ui.applyAIValues(target, proposals, { date: '2026-10-09T10:00:00.000Z', provider: 'Groq', model: 'openai/gpt-oss-120b', message: 'm1' });
    assert.equal(done.saved, true);
    const saved = loadQuote(base, indices);
    const piece = saved.pieces.manuel;
    assert.deepEqual([piece.poids, piece.empreintes, piece.procede, piece.finition, piece.dimMax], [1.35, cavities + 1, island, r.route.finition, 250]);
    assert.deepEqual(Object.fromEntries(Object.entries(piece.valeursIA).map(([k, v]) => [k, [v.avant, v.valeur, v.message]])), {
      procede: [null, island, 'm1'], finition: [null, r.route.finition, 'm1'], poids: [1.2, 1.35, 'm1'], empreintes: [null, cavities + 1, 'm1'],
    });
    assert.deepEqual(saved.analysesIA.map((a) => [a.tache, a.question]), [['application_ia', 'Appliquer les valeurs au chiffrage']]);
    // Traced as a saisie of its own source; the costing uses them.
    const after = ui.compute().results[0];
    assert.deepEqual([after.trace['piece.poids'].valeur, after.trace['piece.poids'].source.type, after.trace['piece.poids'].autorite], [1.35, 'ia_appliquee', 'hard']);
    assert.match(after.trace['piece.poids'].hypotheses.join(), /proposée par Groq · openai\/gpt-oss-120b, acceptée par l'utilisateur/);
    assert.equal(after.trace['piece.empreintes'].valeur, cavities + 1);
    assert.equal(after.chosen, true);
    // Applied again: nothing to change.
    assert.deepEqual(ui.applyAIValues(target, proposals, {}, { dryRun: true }).applied, []);
    // Undone: the weight typed before, the cavities and the island estimated again.
    const undone = ui.undoAIValues({ ...target, name: 'Pièce' }, { message: 'm1' });
    assert.deepEqual(undone.undone.map((x) => x.champ).sort(), ['empreintes', 'finition', 'poids', 'procede']);
    const back = loadQuote(base, indices).pieces.manuel;
    assert.deepEqual([back.poids, back.empreintes, back.procede, back.finition, back.valeursIA], [1.2, undefined, undefined, undefined, undefined]);
    assert.equal(ui.compute().results[0].chosen, false);
    assert.match(ui.undoAIValues(target).error, /Aucune valeur appliquée/);
  });

  test('the island first: refused with the values of its route; another island resets the route typed before; undone only with its route', () => {
    const target = { tab: 1, file: null, key: 'manuel' };
    const stored = () => loadQuote(base, indices).pieces.manuel;
    const setPiece = (over) => {
      const q = loadQuote(base, indices);
      saveQuote({ ...q, pieces: { manuel: { ...q.pieces.manuel, ...over } } });
    };
    // An island refused: the values of its route refused with it, nothing written.
    let c = computed();
    const code = c.results[0].route.process;
    let dry = ui.applyAIValues(target, [{ cle: 'piece.ilot', valeur: 'ZZZ' }, { cle: 'piece.cycle', valeur: 60 }, { cle: 'piece.poids', valeur: 1.35 }], {}, { dryRun: true });
    assert.deepEqual(dry.refused.map((x) => [x.cle, x.refus]), [['piece.ilot', 'îlot « ZZZ » absent du classeur ou de Paramètres'], ['piece.cycle', 'proposée avec un îlot refusé']]);
    assert.deepEqual([dry.applied.map((x) => x.champ), dry.consequences], [['poids'], []]);
    // A value of the route on an automatic piece: the island imposed, said in the consequences.
    dry = ui.applyAIValues(target, [{ cle: 'piece.cycle', valeur: 60 }], {}, { dryRun: true });
    assert.deepEqual(dry.consequences.map((x) => [x.champ, x.avant, x.apres]), [['procede', 'automatique', `${code} imposé`], ['finition', c.results[0].route.finition, `${c.results[0].route.finition} imposée`]]);

    // Another island: the cycle typed for the one before reset (said), the finishing proposed compared with nothing.
    c = computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', finition: 'FTR', cycle: 120 } } } });
    const other = Object.keys(c.results[0].ranked.reduce((m, r) => ({ ...m, [r.process]: 1 }), {})).find((x) => x !== 'CG3' && x.startsWith('CG') && ui.applyAIValues(target, [{ cle: 'piece.ilot', valeur: x }, { cle: 'piece.finition', valeur: 'FTR' }], {}, { dryRun: true }).refused.length === 0);
    dry = ui.applyAIValues(target, [{ cle: 'piece.ilot', valeur: other }, { cle: 'piece.finition', valeur: 'FTR' }], {}, { dryRun: true });
    assert.deepEqual(dry.applied.map((x) => [x.champ, x.avant, x.apres]), [['procede', 'CG3', other], ['finition', null, 'FTR']]);
    assert.deepEqual(dry.consequences.map((x) => [x.champ, x.avant, x.apres]), [['cycle', 120, null]]);
    ui.applyAIValues(target, [{ cle: 'piece.ilot', valeur: other }], { message: 'a' });
    assert.deepEqual([stored().procede, stored().finition, stored().cycle], [other, 'auto', null]);
    // A second answer: a cycle for the new island; undone, back to its estimate, not to the 120 s typed for CG3.
    ui.applyAIValues(target, [{ cle: 'piece.cycle', valeur: 80 }], { message: 'b' });
    assert.equal(stored().cycle, 80);
    ui.undoAIValues(target, { message: 'b' });
    assert.equal(stored().cycle ?? null, null);
    // Another island chosen since by a person: the finishing and the route of the first answer are left as they are.
    setPiece({ procede: 'CG3', finition: 'auto', cycle: null });
    const undone = ui.undoAIValues(target, { message: 'a' });
    assert.deepEqual([stored().procede, stored().finition, stored().cycle ?? null], ['CG3', 'auto', null]);
    assert.ok(undone.kept.includes('procédé / îlot') && undone.kept.includes('finition'));

    // A cycle applied (island imposed), then typed by a person: undone, the island and its cycle stay.
    computed();
    ui.applyAIValues(target, [{ cle: 'piece.cycle', valeur: 60 }], { message: 'c' });
    setPiece({ cycle: 90 });
    const u = ui.undoAIValues(target, { message: 'c' });
    assert.deepEqual([stored().procede, stored().cycle], [code, 90]);
    assert.deepEqual(u.undone, []);
  });

  test('cores added only when the application checks them, taken back with it; an adopted estimate of the cycle back with an undo', () => {
    const target = { tab: 1, file: null, key: 'manuel' };
    const stored = () => loadQuote(base, indices).pieces.manuel;
    // Cores already checked without a core described: another value applied adds none.
    computed({ quote: { pieces: { manuel: { ...PART, noyaux: true, cores: [] } } } });
    ui.applyAIValues(target, [{ cle: 'piece.dimMax', valeur: 260 }], { message: 'd' });
    assert.deepEqual(stored().cores, []);
    // Checked by the application: a first core, removed by the undo.
    computed();
    ui.applyAIValues(target, [{ cle: 'piece.noyaux', valeur: true }], { message: 'e' });
    assert.equal(stored().cores.length, 1);
    ui.undoAIValues(target, { message: 'e' });
    assert.deepEqual([stored().noyaux, stored().cores], [undefined, undefined]);
    // An estimate of the cycle adopted (traced "estimation IA validée"): replaced by the AI's cycle, back with the undo.
    const c = computed({ quote: { pieces: { manuel: { ...PART, procede: 'CG3', cycle: 75, cycleIA: { date: '2026-10-01T00:00:00.000Z', valeur: 75, avant: { procede: 'auto', finition: 'auto', cycle: null }, estimation: { ilot: 'CG3', estimation_s: 75, fournisseur: 'Groq', modele: 'm', date: '2026-10-01T00:00:00.000Z', confiance: 'moyenne' } } } } } });
    assert.equal(c.results[0].trace['piece.cycle'].source.type, 'ia_validee');
    ui.applyAIValues(target, [{ cle: 'piece.cycle', valeur: 60 }], { message: 'f' });
    assert.equal(stored().cycleIA, undefined);
    ui.undoAIValues(target, { message: 'f' });
    assert.deepEqual([stored().cycle, stored().cycleIA?.valeur], [75, 75]);
    assert.equal(ui.compute().results[0].trace['piece.cycle'].source.type, 'ia_validee');
  });

  test('a value changed since by a person is kept when undone; the codes checked against the settings; another 3D model refused', () => {
    computed();
    const target = { tab: 1, file: null, key: 'manuel' };
    ui.applyAIValues(target, [{ cle: 'piece.poids', valeur: 1.35 }, { cle: 'piece.toileMini', valeur: 4 }], { message: 'm2' });
    // The weight typed again since in the page.
    const q = loadQuote(base, indices);
    saveQuote({ ...q, pieces: { manuel: { ...q.pieces.manuel, poids: 1.5 } } });
    const undone = ui.undoAIValues(target, { message: 'm2' });
    assert.deepEqual([undone.undone.map((x) => x.champ), undone.kept], [['toileMini'], ['poids pièce']]);
    assert.deepEqual([loadQuote(base, indices).pieces.manuel.poids, loadQuote(base, indices).pieces.manuel.toileMini], [1.5, 5]);
    // Codes unknown: refused, nothing written.
    const refused = ui.applyAIValues(target, [{ cle: 'piece.ilot', valeur: 'ZZZ' }, { cle: 'piece.mode', valeur: '4*8' }, { cle: 'piece.tth', valeur: 'T99' }], {}, { dryRun: true });
    assert.deepEqual(refused.refused.map((x) => x.cle), ['piece.ilot', 'piece.mode', 'piece.tth']);
    assert.deepEqual(refused.applied, []);
    // The quote of another 3D file: the model of the tab changed since the answer.
    assert.match(ui.applyAIValues({ ...target, file: 'autre.step' }, [{ cle: 'piece.poids', valeur: 1.35 }]).error, /Le modèle 3D de l'onglet a changé/);
    assert.match(ui.applyAIValues({ ...target, key: '0:Absente' }, [{ cle: 'piece.poids', valeur: 1.35 }]).error, /n'est plus chiffrée/);
  });
});
