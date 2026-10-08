// History of cycle times (web/chiffrage/history.js): import of a history
// file, merge by reference and source, export, counts, the real times
// measured in production against the estimates, similar parts; kept in this
// browser (store.js). Made-up records only.
//
//   node --test tests/js/history.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SCHEMA, checkRecord, compareCycles, countHistory, exportHistory, formulaCycle, importHistory, mergeHistory, productionRecord, similarParts, validateHistory,
} from '../../web/chiffrage/history.js';
import { DEFAULT_OPERATIONS, DEFAULT_PROCESSES, DEFAULT_TRS, buildRoute, estimateMiseAuMille } from '../../web/chiffrage/routes.js';
import { loadHistorique, resolveSettings, saveHistorique } from '../../web/chiffrage/store.js';

const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} instead of ${expected}`);

/** A made-up record with every field of the format, as a history file holds them. */
const record = (over = {}) => ({
  ref: 'REF-A', fichier_3d: 'piece_a.stp', source: 'devis', ilot: 'CG3', temps_cycle_s: 200, pieces_par_cycle: 1, trs: 0.8,
  poids_kg: 2.5, module_mm: 4.5, volume_cm3: 925.9, surface_cm2: 2057.6, encombrement_mm: [210.5, 120.25, 80], noyaux: false,
  sable_kg: null, serie: 1000, mise_au_mille: 1.6, ...over,
});
const file = (pieces) => ({ schema: SCHEMA, version: 1, description: 'Historique de test.', pieces });

describe('history file: format, validation, merge, export', () => {
  test('the format of the file: every field kept, in its order, unknown fields ignored', () => {
    const pieces = [
      record(),
      record({ ref: 'REF-B', fichier_3d: null, ilot: 'SSP', temps_cycle_s: 45, pieces_par_cycle: 4, module_mm: null, volume_cm3: null, surface_cm2: null, encombrement_mm: null, mise_au_mille: null }),
      record({ ref: 'REF-C', ilot: 'BPR', noyaux: true, sable_kg: 0.75, couleur: 'rouge' }),
    ];
    const v = validateHistory(file(pieces));
    assert.deepEqual(v.refused, []);
    assert.deepEqual(v.ignored, []);
    assert.deepEqual(v.unknown, ['couleur']);
    assert.equal(v.pieces.length, 3);
    for (const [i, raw] of pieces.entries()) {
      const { couleur, ...known } = raw;
      assert.deepEqual(v.pieces[i], known, raw.ref);
      assert.deepEqual(Object.keys(v.pieces[i]), Object.keys(known), 'the order of the file');
    }
    // The fields of a record of this page, and an estimate of the AI, kept when set.
    const extra = checkRecord(record({ toile_mini_mm: 3.5, epaisseur_max_mm: 12, date: '2026-05-04T08:00:00.000Z', note: 'moule neuf', estimation_ia: { temps_cycle_s: 190, modele: 'test', reponse: 'x' } })).record;
    assert.deepEqual([extra.toile_mini_mm, extra.epaisseur_max_mm, extra.date, extra.note], [3.5, 12, '2026-05-04T08:00:00.000Z', 'moule neuf']);
    assert.deepEqual(extra.estimation_ia, { temps_cycle_s: 190, modele: 'test' });
    assert.equal('note' in v.pieces[0], false, 'not written when not set');
  });

  test('records refused with their reason; a wrong optional value left out, the record kept', () => {
    const v = validateHistory(file([
      record({ ref: 'SANS-ILOT', ilot: undefined }),
      record({ ref: 'CYCLE-NUL', temps_cycle_s: 0 }),
      record({ ref: 'POIDS-TEXTE', poids_kg: '2,5' }),
      record({ ref: 'SOURCE', source: 'mesure' }),
      'pas un objet',
      record({ ref: 'TRS-POURCENT', trs: 85, module_mm: 0, encombrement_mm: [100, 50], noyaux: 'oui' }),
      { ilot: 'CG3', temps_cycle_s: 100, poids_kg: 1 },
    ]));
    assert.deepEqual(v.refused, [
      { name: 'SANS-ILOT', reasons: ['ilot manquant'] },
      { name: 'CYCLE-NUL', reasons: ['temps_cycle_s : nombre > 0 attendu'] },
      { name: 'POIDS-TEXTE', reasons: ['poids_kg : nombre > 0 attendu'] },
      { name: 'SOURCE', reasons: ['source « mesure » inconnue (devis ou production)'] },
      { name: 'n° 5', reasons: ['enregistrement (objet JSON) attendu'] },
    ]);
    assert.deepEqual(v.ignored, [
      { name: 'TRS-POURCENT', field: 'trs', reason: 'TRS entre 0 et 1 attendu (0,85 pour 85 %)' },
      { name: 'TRS-POURCENT', field: 'module_mm', reason: '0 lu comme inconnu' },
      { name: 'TRS-POURCENT', field: 'encombrement_mm', reason: 'trois dimensions > 0 attendues' },
      { name: 'TRS-POURCENT', field: 'noyaux', reason: 'vrai / faux attendu' },
    ]);
    assert.deepEqual(v.pieces.map((r) => [r.ref, r.trs, r.module_mm, r.encombrement_mm, r.noyaux]), [['TRS-POURCENT', null, null, null, null], [null, null, null, null, null]]);
    // Without a source: a time of a quote, never taken for a measured one.
    assert.equal(v.pieces[1].source, 'devis');
  });

  test('not a history file, another version, no valid record: refused, nothing changed', () => {
    assert.throws(() => validateHistory({ trs: { CG3: 0.8 } }), /fichier d'historique attendu \(schema « reader3d-historique-cycles »\)/);
    assert.throws(() => validateHistory([record()]), /fichier d'historique attendu/);
    assert.throws(() => validateHistory({ schema: SCHEMA, version: 2, pieces: [] }), /version 2 non prise en charge/);
    assert.throws(() => validateHistory({ schema: SCHEMA, version: 1, pieces: {} }), /liste « pieces » attendue/);
    const existing = [record()];
    assert.throws(() => importHistory(existing, file([record({ ref: 'X', poids_kg: -1 })])), /aucun enregistrement valable dans ce fichier \(X : poids_kg : nombre > 0 attendu\)/);
    assert.deepEqual(existing, [record()]);
  });

  test('a file imported again replaces its records (same reference and source), never duplicates them', () => {
    const first = importHistory([], file([record(), record({ ref: 'REF-B', ilot: 'SSP' }), record({ ref: null, temps_cycle_s: 150 })]));
    assert.deepEqual([first.report.count, first.report.added, first.report.replaced, first.pieces.length], [3, 3, 0, 3]);
    const again = importHistory(first.pieces, file([record({ temps_cycle_s: 210 }), record({ ref: 'REF-B', ilot: 'SSP' }), record({ ref: null, temps_cycle_s: 150 })]));
    assert.deepEqual([again.report.added, again.report.replaced, again.pieces.length], [0, 3, 3]);
    assert.equal(again.pieces[0].temps_cycle_s, 210, 'replaced in place');
    // The same reference measured in production: another record.
    const measured = mergeHistory(again.pieces, [checkRecord(record({ source: 'production', temps_cycle_s: 230 })).record]);
    assert.deepEqual([measured.added, measured.replaced, measured.pieces.length], [1, 0, 4]);
    // Twice the same reference in a file: the last one.
    const twice = importHistory([], file([record(), record({ temps_cycle_s: 222 })]));
    assert.deepEqual(twice.pieces.map((r) => r.temps_cycle_s), [222]);
  });

  test('export: the format of the import, read back the same', () => {
    const pieces = importHistory([], file([record(), record({ ref: 'P', source: 'production', date: '2026-06-01T10:00:00.000Z' })])).pieces;
    const out = JSON.parse(JSON.stringify(exportHistory(pieces)));
    assert.equal(out.schema, 'reader3d-historique-cycles');
    assert.equal(out.version, 1);
    assert.match(out.description, /confidentielles/);
    assert.deepEqual(validateHistory(out).pieces, pieces);
  });

  test('counts by source and by island', () => {
    const pieces = importHistory([], file([
      record(), record({ ref: 'B', ilot: 'CG10' }), record({ ref: 'C', ilot: 'CG2', source: 'production' }), record({ ref: 'D', ilot: 'CG2' }), record({ ref: 'A', source: 'production' }),
    ])).pieces;
    assert.deepEqual(countHistory(pieces), {
      total: 5, devis: 3, production: 2,
      ilots: [{ ilot: 'CG2', devis: 1, production: 1 }, { ilot: 'CG3', devis: 1, production: 1 }, { ilot: 'CG10', devis: 1, production: 0 }],
    });
    assert.deepEqual(countHistory([]), { total: 0, devis: 0, production: 0, ilots: [] });
  });
});

describe('real cycle times against the estimates', () => {
  const settings = { processes: DEFAULT_PROCESSES, operations: DEFAULT_OPERATIONS, trs: DEFAULT_TRS };

  test('the formula of routes.js, with the mise au mille and pieces per cycle of the record, else those estimated for the island', () => {
    const p = DEFAULT_PROCESSES.CG3;
    const r = checkRecord(record()).record;
    close(formulaCycle(r, settings), p.cycle.base + p.cycle.parKg * (2.5 * 1.6 * 1) ** p.cycle.exposant + p.cycle.parModule2 * 4.5 ** 2, 'with the values of the record');
    // Without them: the estimates of a route of the same part (routes.js:buildRoute).
    const part = { poids: 2.5, moduleMm: 4.5, toileMini: 4, epaisseurMax: 16, dimMax: 200 };
    const route = buildRoute('CG2', 'FCE', part, settings, null);
    const bare = checkRecord(record({ ilot: 'CG2', mise_au_mille: null, pieces_par_cycle: null, toile_mini_mm: 4, epaisseur_max_mm: 16 })).record;
    close(formulaCycle(bare, settings), route.cycle, 'the cycle of the route');
    assert.ok(estimateMiseAuMille(DEFAULT_PROCESSES.CG2, part).estimated);
    // Module unknown: 0, as in the quote. An island out of the settings: no estimate.
    const noModule = checkRecord(record({ module_mm: null })).record;
    close(formulaCycle(noModule, settings), p.cycle.base + p.cycle.parKg * 4, 'no module');
    assert.equal(formulaCycle(checkRecord(record({ ilot: 'XYZ' })).record, settings), null);
  });

  test('relative error of each estimate, mean absolute error per island; the trend only for the islands of the trends file', () => {
    // Coefficients of test: CG3 cycle = 100 + 20 × kg cast per cycle, nothing for the modulus.
    const s = resolveSettings({ saisies: Object.fromEntries(Object.entries({ base: 100, parKg: 20, exposant: 1, parModule2: 0 }).map(([k, v]) => [`processes.CG3.cycle.${k}`, { value: v }])) });
    const trendOnly = resolveSettings({ tendances: { processes: { CG3: { cycle: { base: 50, parKg: 25, parModule2: 0 } } } } });
    const trend = { ...trendOnly, processes: { CG3: trendOnly.processes.CG3 } };
    const pieces = importHistory([], file([
      record({ ref: 'P1', source: 'production', poids_kg: 2, mise_au_mille: 1.5, temps_cycle_s: 200 }), // formula 160, trend 125
      record({ ref: 'P2', source: 'production', poids_kg: 4, mise_au_mille: 1.25, temps_cycle_s: 160, estimation_ia: { temps_cycle_s: 176 } }), // formula 200, trend 175
      record({ ref: 'P3', source: 'production', ilot: 'SSP', poids_kg: 0.5, pieces_par_cycle: 2, mise_au_mille: 1, module_mm: null, temps_cycle_s: 40 }),
      record({ ref: 'D1', source: 'devis', temps_cycle_s: 999 }),
    ])).pieces;
    const cmp = compareCycles(pieces, s, trend);
    assert.deepEqual(cmp.rows.map((x) => x.record.ref), ['P1', 'P2', 'P3'], 'the times measured in production only');
    const [p1, p2, p3] = cmp.rows;
    close(p1.formule.valeur, 160, 'P1 formula');
    close(p1.formule.ecart, -0.2, 'P1 error');
    close(p1.tendance.valeur, 125, 'P1 trend');
    close(p1.tendance.ecart, -0.375, 'P1 trend error');
    assert.equal(p1.ia, null);
    close(p2.formule.ecart, 0.25, 'P2 error');
    close(p2.tendance.ecart, 15 / 160, 'P2 trend error');
    close(p2.ia.ecart, 0.1, 'P2 AI error');
    const ssp = DEFAULT_PROCESSES.SSP.cycle;
    close(p3.formule.valeur, ssp.base + ssp.parKg * (0.5 * 2) ** ssp.exposant, 'P3 formula');
    assert.equal(p3.tendance, null, 'no trend for SSP');
    const cg3 = cmp.ilots.find((x) => x.ilot === 'CG3');
    assert.equal(cg3.n, 2);
    close(cg3.formule.emap, (0.2 + 0.25) / 2, 'CG3 mean error');
    close(cg3.tendance.emap, (0.375 + 15 / 160) / 2, 'CG3 trend mean error');
    assert.deepEqual(cg3.ia, { n: 1, emap: cg3.ia.emap });
    close(cg3.ia.emap, 0.1, 'CG3 AI mean error');
    assert.deepEqual(cmp.ilots.map((x) => x.ilot), ['CG3', 'SSP']);
    assert.equal(cmp.total.n, 3);
    assert.equal(cmp.total.formule.n, 3);
    // Without trends file.
    assert.ok(compareCycles(pieces, s).rows.every((x) => x.tendance === null));
    assert.deepEqual(compareCycles([], s), { rows: [], ilots: [], total: { ilot: null, n: 0, formule: null, tendance: null, ia: null } });
  });

  test('the record "production" of a piece of the quote: its geometry, the island, cavities, TRS and mise au mille of the quote', () => {
    const r = {
      piece: { name: 'Pièce', volume: 450000, area: 90000, bboxSize: [200, 120, 60] },
      part: { poids: 1.2, moduleMm: 5, toileMini: 4, epaisseurMax: 12, noyaux: true, sableKg: 0.3 },
      route: { process: 'CG3', miseAuMille: 1.7, operations: [{ code: 'ASF' }, { code: 'CG3', cycle: 240, parCycle: 2, trs: 0.75 }, { code: 'FTR', cycle: 80, parCycle: 1 }] },
    };
    const rec = productionRecord(r, { ref: 'REF-1', tempsCycle: 255, fichier: 'piece.step', serie: 500, date: '2026-07-01T09:00:00.000Z' });
    assert.deepEqual(rec, {
      ref: 'REF-1', fichier_3d: 'piece.step', source: 'production', ilot: 'CG3', temps_cycle_s: 255, pieces_par_cycle: 2, trs: 0.75, poids_kg: 1.2,
      module_mm: 5, volume_cm3: 450, surface_cm2: 900, encombrement_mm: [200, 120, 60], noyaux: true, sable_kg: 0.3, serie: 500, mise_au_mille: 1.7,
      toile_mini_mm: 4, epaisseur_max_mm: 12, date: '2026-07-01T09:00:00.000Z',
    });
    // A part typed in, without 3D model nor wall thickness.
    const typed = productionRecord({ ...r, piece: { name: 'Pièce', volume: null, area: null, bboxSize: null }, part: { poids: 1.2, moduleMm: 0, toileMini: 0, epaisseurMax: 0, noyaux: false, sableKg: 0 } }, { ref: 'REF-2', tempsCycle: 100 });
    assert.deepEqual([typed.module_mm, typed.volume_cm3, typed.encombrement_mm, typed.sable_kg, typed.noyaux, 'toile_mini_mm' in typed], [null, null, null, null, false, false]);
    assert.ok(!Number.isNaN(Date.parse(typed.date)));
  });
});

describe('similar parts', () => {
  const history = importHistory([], file([
    record({ ref: 'SAME-ISLAND-FAR', ilot: 'CG3', poids_kg: 10, module_mm: 9 }),
    record({ ref: 'OTHER-ISLAND-TWIN', ilot: 'BPR', poids_kg: 2, module_mm: 4 }),
    record({ ref: 'SAME-ISLAND-NEAR', ilot: 'CG3', poids_kg: 2.2, module_mm: 4.2 }),
    record({ ref: 'SAME-ISLAND-CORES', ilot: 'CG3', poids_kg: 2.2, module_mm: 4.2, noyaux: true }),
    record({ ref: 'SAME-ISLAND-NO-MODULE', ilot: 'CG3', poids_kg: 2.2, module_mm: null }),
  ])).pieces;
  const part = { ilot: 'CG3', poids_kg: 2, module_mm: 4, noyaux: false };

  test('same island first, then the nearest weight (log scale), modulus and cores', () => {
    const before = JSON.stringify(history);
    const similar = similarParts(history, part);
    assert.deepEqual(similar.map((x) => x.record.ref), ['SAME-ISLAND-NEAR', 'SAME-ISLAND-NO-MODULE', 'SAME-ISLAND-CORES', 'SAME-ISLAND-FAR', 'OTHER-ISLAND-TWIN']);
    assert.equal(JSON.stringify(history), before, 'the history is not changed');
    assert.ok(similar.every((x) => x.score > 0 && x.score <= 1));
    assert.equal(similar.at(-1).score, 1, 'a twin on another island still has the best score');
    close(similar[0].score, 1 / (1 + Math.log2(1.1) + 0.1), 'score of the nearest');
    assert.equal(similar[0].reason, 'même îlot (CG3) ; poids 2,2 kg (× 1,1) ; module 4,2 mm (+0,2 mm) ; sans noyau, comme la pièce');
    assert.equal(similar[1].reason, 'même îlot (CG3) ; poids 2,2 kg (× 1,1) ; module inconnu ; sans noyau, comme la pièce');
    assert.match(similar[2].reason, /avec noyaux, pas la pièce$/);
    assert.match(similar.at(-1).reason, /^autre îlot \(BPR\)/);
  });

  test('the weight on a log scale: twice as heavy as far as half as heavy; k records at most', () => {
    const pair = importHistory([], file([record({ ref: 'HALF', poids_kg: 1, module_mm: null }), record({ ref: 'DOUBLE', poids_kg: 4, module_mm: null })])).pieces;
    const [a, b] = similarParts(pair, { poids_kg: 2 });
    close(a.score, b.score, 'same distance');
    close(a.score, 0.5, 'one doubling');
    assert.equal(similarParts(history, part, { k: 2 }).length, 2);
    assert.deepEqual(similarParts([], part), []);
    // Without an island for the part: the score only.
    assert.equal(similarParts(history, { poids_kg: 2, module_mm: 4 })[0].record.ref, 'OTHER-ISLAND-TWIN');
  });
});

describe('history kept in this browser (store.js)', () => {
  const storage = new Map();
  const memory = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => void storage.set(k, String(v)),
    removeItem: (k) => void storage.delete(k),
  };

  test('saved under its key, read back; erased; storage blocked: kept for this visit', () => {
    const saved = globalThis.localStorage;
    globalThis.localStorage = memory;
    try {
      assert.deepEqual(loadHistorique(), []);
      const pieces = importHistory([], file([record()])).pieces;
      assert.equal(saveHistorique(pieces), true);
      assert.deepEqual(JSON.parse(storage.get('reader3d.chiffrage.historique.v1')), { pieces });
      assert.deepEqual(loadHistorique(), pieces);
      saveHistorique([]);
      assert.equal(storage.has('reader3d.chiffrage.historique.v1'), false);
      assert.deepEqual(loadHistorique(), []);
      memory.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      assert.equal(saveHistorique(pieces), false);
      assert.deepEqual(loadHistorique(), pieces, 'for this visit');
    } finally {
      globalThis.localStorage = saved;
    }
  });
});
