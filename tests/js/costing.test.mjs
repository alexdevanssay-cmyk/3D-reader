// Costing module (web/chiffrage/): reading the costing workbook, cost rates
// of the profit centres, quote of a part, choice of the manufacturing route.
// On a made-up workbook with the layout of the real one (costing-fixture.mjs).
//
//   node --test tests/js/costing.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readCostingWorkbook, readIndicesWorkbook } from '../../web/chiffrage/workbook.js';
import { centreRates, indexAverage, minimumMargin, quote, saleMetalPrice } from '../../web/chiffrage/model.js';
import { DEFAULT_OPERATIONS, DEFAULT_PROCESSES, DEFAULT_TRS, bestRoutes, buildRoute, estimateMiseAuMille, rankRoutes } from '../../web/chiffrage/routes.js';
import { readWorkbook } from '../../web/chiffrage/xlsxread.js';
import { heatTreatmentOf, programmeOf, readSeriesOrder } from '../../web/chiffrage/rfq.js';
import { DEFAULT_TOOLING, estimateTooling } from '../../web/chiffrage/tooling.js';
import { DEFAULT_CORES, boxSize, coreBoxCost, coresPerPiece } from '../../web/chiffrage/cores.js';
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
    close(route.cycle, p.cycle.base + p.cycle.parKg * part.poids * route.miseAuMille + p.cycle.parModule2 * 9, 1e-12, 'cycle');
    const ssp = buildRoute('SSP', 'FSP', { ...part, poids: 0.5 }, settings, rates);
    assert.equal(ssp.parCycle, 4); // limited by the number of cavities, not by the shot weight
    assert.equal(ssp.operations.find((o) => o.code === 'SSP').trs, DEFAULT_TRS.SSP);
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

  test('the die: steel of the blocks, milling, assembly, more with more cavities', () => {
    const one = estimateTooling(part, 1);
    const two = estimateTooling(part, 2);
    // Blocks 320 x 240 x 160 mm of steel at 7.85: 96.5 kg.
    close(one.block.kg, (320 * 240 * 160 * 7.85) / 1e6, 1e-9, 'value');
    assert.ok(one.lines.some((l) => /Acier/.test(l.label)));
    assert.ok(one.lines.some((l) => /Fraisage CNC — ébauche/.test(l.label)));
    assert.ok(one.lines.some((l) => /Montage/.test(l.label)));
    close(one.total, one.lines.reduce((s, l) => s + l.value, 0), 1e-9, 'value');
    assert.ok(two.total > one.total * 1.3, `${two.total} vs ${one.total}`);
    assert.ok(two.hours.cnc > one.hours.cnc);
  });

  test('gravity die islands get the estimate, the others their price', () => {
    const settings = { processes: DEFAULT_PROCESSES, operations: DEFAULT_OPERATIONS, trs: DEFAULT_TRS, tooling: DEFAULT_TOOLING };
    const p = { ...part, poids: 1, toileMini: 5, epaisseurMax: 10, moduleMm: 3, volumeAnnuel: 5000, volumeTotal: 25000 };
    const cg = buildRoute('CG3', 'FTR', p, settings, null);
    const bp = buildRoute('BPR', 'FTR', p, settings, null);
    assert.ok(cg.tooling && cg.outillage === cg.tooling.total);
    close(cg.outillagePiece, cg.outillage / 25000, 1e-9, 'value');
    assert.equal(bp.tooling, null);
    assert.equal(bp.outillage, DEFAULT_PROCESSES.BPR.outillage);
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
  test('the box of the workbook method: steel by weight, hours of its weight band, subcontracting', () => {
    const core = { nom: 'N1', masse: 1, qte: 2, L: 300, l: 200, h: 150, type: 0, tiroirs: 1, complexite: 'Moyen' };
    const box = coreBoxCost(core, DEFAULT_CORES);
    const kg = (300 * 200 * 150 * 7.8) / 1e6; // 70.2 kg: band <= 200 kg
    close(box.kg, kg, 1e-12, 'kg');
    const t = DEFAULT_CORES.taux;
    const cost = kg * 8 + (50 * t.ax3 + 50 * t.ax3auto + 5 * t.ax3) + (5 * t.ax5 + 5 * t.ax5auto + 5 * t.ax5) + 8 * t.fao + 60 * t.etude + 5 * t.scan + 50 * t.ajustage;
    close(box.total, cost / 0.9, 1e-9, 'total with 10 % subcontracting');
  });

  test('without dimensions, the box is sized from the sand of the core', () => {
    const size = boxSize({ masse: 1.6 }, DEFAULT_CORES); // 1 dm³: a 100 mm cube, plus 2 x 50 mm
    close(size.L, 200, 1e-9, 'L');
    assert.equal(size.auto, true);
  });

  test('sand and core-making time per piece', () => {
    const per = coresPerPiece([{ masse: 0.5, qte: 2 }, { masse: 1, qte: 1 }], { base: 40, parKg: 10 });
    close(per.sable, 2, 1e-12, 'sand');
    close(per.cycle, 2 * (40 + 5) + (40 + 10), 1e-12, 'cycle');
  });
});
