// The slides (« tiroirs ») of the 3D analysis in the costing
// (web/chiffrage/slides3d.js, provenance.js, ui.js) and in the semantic
// contract, the foundry screen and the AI context: the count per part × the
// cavities proposed under « Tiroirs du moule », used only by a person, traced
// « analyse 3D validée »; a change of the analysis since shown, never
// applied; a value typed never replaced. On the made-up workbook of
// costing-fixture.mjs and a 3D part stub.
//
//   node --test tests/js/slides-costing.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { readCostingWorkbook } from '../../web/chiffrage/workbook.js';
import { defaultQuote, loadQuote, saveBase, saveIndices, saveQuote } from '../../web/chiffrage/store.js';
import { SOURCES } from '../../web/chiffrage/provenance.js';
import { checkProposals } from '../../web/chiffrage/ai-apply.js';
import {
  adoptSlides, adoptedMessage, adoptionOf, forgetSlidesAdoption, partingText, slideName, slidesLineModel, slidesProposal, undoSlides, undoneMessage,
} from '../../web/chiffrage/slides3d.js';
import { buildSemantic3D } from '../../web/engine/semantic.js';
import { buildAIContext, compactAIContext } from '../../web/engine/ai-context.js';
import { FOUNDRY_SOURCES } from '../../web/engine/foundry-knowledge.js';
import { evaluateParting } from '../../web/engine/parting.js';
import { analyseSlides, effectiveSlides, prepareSlides, slideExport, undercutMask } from '../../web/engine/slides.js';
import { costingWorkbook } from './costing-fixture.mjs';
import { voxels } from './meshes.mjs';

// The quote is kept in localStorage: an in-memory one.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { base, indices } = readCostingWorkbook(costingWorkbook(), 'test.xlsm');
const DATE = '2026-10-13T09:00:00.000Z';
const KEY = '0:A';

/** The brief of the 3D page (app.js slidesBrief): 2 slides, a probable core, the proposed parting line Z. */
const BRIEF = {
  status: 'ready', count: 2, cores: 1, parting_zones: 0, ignored: 0, warnings: [], signature: 's1:4800:96:0a1b2c3d#5e6f7a8b', edited: false,
  parting: { axis: 'Z', status: 'proposed', source: null },
  slides: [{ id: 'T1', axis: 'Y', reference_axis: '+Y', stroke_mm: 15 }, { id: 'T2', axis: '-X', reference_axis: '-X', stroke_mm: 25 }],
};
const p3d = (slides = BRIEF) => ({
  file: 'slides.step',
  parts: [{ index: 0, name: 'A', closed: true, volume: 30000, area: 15000, bboxSize: [60, 30, 20], thickness: null, ...(slides ? { slides } : {}) }],
  selected: [0],
});

let ui;

/** ui.js:compute() on the fixture: the inputs of piece A, the 3D part. */
function computed(piece, part = p3d()) {
  storage.clear();
  saveBase(base);
  saveIndices({ ...indices, source: 'classeur', fileName: 'test.xlsm', importedAt: base.source.importedAt });
  saveQuote({ ...defaultQuote(base, indices), pieces: { [KEY]: piece }, pieceFile: part.file });
  globalThis.window.reader3d = { part: () => part };
  ui.reload();
  const c = ui.compute();
  return c.results.find((r) => r.piece.key === KEY);
}

const divergences = (t) => t.alertes.filter((a) => a.type === 'divergence').map((a) => a.message);

describe('the slides of the 3D analysis in the costing', () => {
  before(async () => {
    globalThis.window ??= { addEventListener() {} };
    ui = await import('../../web/chiffrage/ui.js');
  });

  test('CG3, nothing typed: the default used, the 3D count beside it, to validate; « Utiliser 2 tiroirs »', () => {
    const r = computed({ procede: 'CG3' });
    assert.ok(r.route.tooling, 'an in-house die');
    const t = r.trace['piece.outillage.tiroirs'];
    assert.equal(t.valeur, 0);
    assert.ok(['parametres', 'classeur', 'defaut_code'].includes(t.source.type), t.source.type);
    assert.deepEqual(t.alternatives.filter((a) => a.source === 'geometrie').map((a) => [a.valeur, a.ref]), [[2, 'analyse 3D : 2 tiroirs par pièce (non validés)']]);
    assert.deepEqual(divergences(t), ["l'analyse 3D propose 2 tiroirs (2 par pièce) : « Utiliser » dans la carte Outillage"]);
    assert.equal(t.validation_requise, true);
    // The die's estimate: the slides from the settings, as before (not an input of their own).
    const mould = r.trace['piece.outillage.total'];
    assert.ok(!mould.source.entrees.includes('piece.outillage.tiroirs'));
    assert.ok(mould.hypotheses.some((h) => h.startsWith('0 tiroir (par défaut)')), mould.hypotheses.join(' | '));
    const line = slidesLineModel(r);
    assert.equal(line.text, 'Analyse 3D : 2 tiroirs par pièce (T1 +Y, course 15 mm ; T2 −X, course 25 mm), plan de joint Z proposé ; 1 noyau probable (non compté). La case « Noyaux sable » n\'est pas cochée.');
    // « Noyaux sable » ticked: nothing more said (and never ticked from here).
    assert.equal(slidesLineModel(computed({ procede: 'CG3', noyaux: true })).text, 'Analyse 3D : 2 tiroirs par pièce (T1 +Y, course 15 mm ; T2 −X, course 25 mm), plan de joint Z proposé ; 1 noyau probable (non compté).');
    assert.deepEqual(line.buttons, [{ action: 'use-slides-3d', label: 'Utiliser 2 tiroirs' }]);
    assert.equal(line.warn, false);
    // Never applied by itself.
    assert.equal(r.inputs.outillageTiroirs, null);
    assert.equal(r.route.tooling.tiroirs, 0);
  });

  test('CG1 with 2 cavities: used, 4 slides for the die, traced « analyse 3D validée »; the same die as 4 typed', () => {
    let r = computed({ procede: 'CG1', empreintes: 2 });
    const proposal = slidesProposal(r.piece, r.route);
    assert.deepEqual([proposal.status, proposal.perPart, proposal.cavities, proposal.value], ['ready', 2, 2, 4]);
    assert.deepEqual(slidesLineModel(r).buttons, [{ action: 'use-slides-3d', label: 'Utiliser 4 tiroirs (2 × 2 empreintes)' }]);
    const piece = { procede: 'CG1', empreintes: 2 };
    const record = adoptSlides(piece, r.inputs, proposal, DATE);
    assert.equal(piece.outillageTiroirs, 4);
    assert.deepEqual({ ...record, slides: record.slides.map((s) => s.nom) }, {
      date: DATE, valeur: 4, parPiece: 2, empreintes: 2, avant: null, signature: BRIEF.signature, parting: BRIEF.parting, slides: ['+Y', '−X'], cores: 1,
    });
    assert.equal(adoptedMessage(record), 'Tiroirs du moule : 4, analyse 3D validée (T1 +Y, T2 −X ; 2 × 2 empreintes). Avant : vide (défaut 0). « Ne plus utiliser l\'analyse 3D » revient à la valeur d\'avant.');

    r = computed(piece);
    assert.equal(r.inputs.outillageTiroirs, 4);
    assert.equal(r.route.tooling.tiroirs, 4);
    const t = r.trace['piece.outillage.tiroirs'];
    assert.deepEqual([t.valeur, t.source.type, SOURCES[t.source.type].label, t.autorite, t.niveau, t.confiance.niveau], [4, 'geometrie_validee', 'analyse 3D validée', 'hard', 1, 'moyenne']);
    assert.equal(t.source.date, DATE);
    assert.deepEqual(t.hypotheses, ['analyse 3D du 13/10/2026 : 2 tiroirs par pièce × 2 empreintes (T1 +Y, T2 −X)', 'plan de joint Z proposé']);
    assert.deepEqual(divergences(t), []);
    assert.deepEqual(t.alternatives.filter((a) => a.source === 'geometrie'), [], 'the same count: no alternative');
    const mould = r.trace['piece.outillage.total'];
    assert.ok(mould.source.entrees.includes('piece.outillage.tiroirs'));
    assert.ok(mould.hypotheses.some((h) => h.startsWith('4 tiroirs (analyse 3D validée)')), mould.hypotheses.join(' | '));
    assert.equal(adoptionOf(r.inputs, slidesProposal(r.piece, r.route)).adopted, true);
    assert.equal(slidesLineModel(r).text, '4 tiroirs : analyse 3D validée le 13/10/2026 (2 par pièce × 2 empreintes, plan de joint Z proposé). 1 noyau probable selon l\'analyse 3D : la case « Noyaux sable » n\'est pas cochée.');
    assert.deepEqual(slidesLineModel(r).buttons, [{ action: 'undo-slides-3d', label: 'Ne plus utiliser l\'analyse 3D' }]);
    // The same die as 4 slides typed.
    const typed = computed({ procede: 'CG1', empreintes: 2, outillageTiroirs: 4 });
    assert.equal(r.route.outillageEstime, typed.route.outillageEstime);
    assert.equal(typed.trace['piece.outillage.tiroirs'].source.type, 'saisie');

    // The analysis changes since (another definition: 1 slide per part): the value stays 4, shown stale.
    const changed = { ...BRIEF, count: 1, cores: 0, signature: 's1:4800:40:99999999#5e6f7a8b', slides: [BRIEF.slides[0]] };
    r = computed(piece, p3d(changed));
    assert.equal(r.inputs.outillageTiroirs, 4);
    assert.equal(r.route.tooling.tiroirs, 4);
    const now = slidesProposal(r.piece, r.route);
    assert.deepEqual(adoptionOf(r.inputs, now), { record: piece.tiroirs3D, adopted: true, stale: true });
    const stale = r.trace['piece.outillage.tiroirs'];
    assert.equal(stale.valeur, 4);
    assert.deepEqual(divergences(stale), ['analyse 3D modifiée depuis la validation du 13/10/2026 : elle propose maintenant 2 tiroirs (4 validés)']);
    assert.equal(stale.validation_requise, true);
    assert.deepEqual(stale.alternatives.filter((a) => a.source === 'geometrie').map((a) => a.valeur), [2]);
    const line = slidesLineModel(r);
    assert.equal(line.warn, true);
    assert.equal(line.text, 'L\'analyse 3D propose maintenant 2 tiroirs (validés : 4 le 13/10/2026) : plan de joint, tiroirs ou empreintes modifiés depuis. La valeur reste 4.');
    assert.deepEqual(line.buttons.map((b) => b.label), ['Utiliser 2 tiroirs (1 × 2 empreintes)', 'Garder 4']);
    // Used again: the value before the first use kept.
    const again = adoptSlides(piece, r.inputs, now, DATE);
    assert.deepEqual([piece.outillageTiroirs, again.avant, again.parPiece], [2, null, 1]);
  });

  test('a value typed afterwards: the record dropped, a value typed in, the 3D count beside it without alert; never replaced', () => {
    let r = computed({ procede: 'CG3' });
    const piece = { procede: 'CG3' };
    adoptSlides(piece, r.inputs, slidesProposal(r.piece, r.route), DATE);
    // As ui.js onChange: the input written, then the adoptions that no longer hold forgotten.
    piece.outillageTiroirs = 3;
    forgetSlidesAdoption(piece);
    assert.equal(piece.tiroirs3D, undefined);
    r = computed(piece);
    const t = r.trace['piece.outillage.tiroirs'];
    assert.deepEqual([t.valeur, t.source.type], [3, 'saisie']);
    assert.deepEqual(t.alternatives.filter((a) => a.source === 'geometrie').map((a) => a.valeur), [2]);
    assert.deepEqual(divergences(t), [], 'a person decided: no alert');
    assert.equal(slidesLineModel(r).text.split('. ')[0], 'Analyse 3D : 2 tiroirs par pièce (T1 +Y, course 15 mm ; T2 −X, course 25 mm), plan de joint Z proposé (saisi : 3) ; 1 noyau probable (non compté)');
    assert.equal(r.route.tooling.tiroirs, 3);
    // Typed the count of the analysis: conform, nothing to click.
    r = computed({ procede: 'CG3', outillageTiroirs: 2 });
    assert.deepEqual([slidesLineModel(r).text.split('. ')[0], slidesLineModel(r).buttons], ['Conforme à l\'analyse 3D (2 tiroirs par pièce)', []]);
  });

  test('« Ne plus utiliser l\'analyse 3D »: the value before back (empty: the default), the record gone; « Garder »: a value typed', () => {
    let r = computed({ procede: 'CG3' });
    const piece = { procede: 'CG3' };
    adoptSlides(piece, r.inputs, slidesProposal(r.piece, r.route), DATE);
    const record = undoSlides(piece);
    assert.deepEqual(piece, { procede: 'CG3' });
    assert.equal(undoneMessage(record), 'Tiroirs du moule : retour à la valeur par défaut.');
    // Over a value typed before: that value back.
    const typed = { procede: 'CG3', outillageTiroirs: 1 };
    r = computed(typed);
    adoptSlides(typed, r.inputs, slidesProposal(r.piece, r.route), DATE);
    assert.equal(typed.outillageTiroirs, 2);
    assert.equal(undoneMessage(undoSlides(typed)), 'Tiroirs du moule : retour à 1.');
    assert.deepEqual(typed, { procede: 'CG3', outillageTiroirs: 1 });
    // Kept (« Garder »): the record gone, the value a plain input.
    adoptSlides(typed, r.inputs, slidesProposal(r.piece, r.route), DATE);
    delete typed.tiroirs3D;
    r = computed(typed);
    assert.equal(r.trace['piece.outillage.tiroirs'].source.type, 'saisie');
  });

  test('another count applied from the AI over the one validated, then that application undone: « analyse 3D validée » again', () => {
    let r = computed({ procede: 'CG3' });
    const piece = { procede: 'CG3' };
    const record = adoptSlides(piece, r.inputs, slidesProposal(r.piece, r.route), DATE);
    r = computed(piece);
    assert.equal(r.trace['piece.outillage.tiroirs'].source.type, 'geometrie_validee');
    const target = { tab: 1, file: 'slides.step', key: KEY };
    const done = ui.applyAIValues(target, [{ cle: 'piece.outillage.tiroirs', valeur: 3 }], { date: DATE, message: 'm1' });
    assert.deepEqual(done.applied.map((x) => [x.champ, x.avant, x.apres]), [['outillageTiroirs', 2, 3]]);
    let saved = loadQuote(base, indices).pieces[KEY];
    assert.deepEqual([saved.outillageTiroirs, saved.tiroirs3D], [3, undefined]);
    assert.equal(ui.compute().results.find((x) => x.piece.key === KEY).trace['piece.outillage.tiroirs'].source.type, 'ia_appliquee');
    // Undone: the count validated back, and its record with it.
    assert.deepEqual(ui.undoAIValues(target, { message: 'm1' }).undone.map((x) => [x.champ, x.avant, x.apres]), [['outillageTiroirs', 3, 2]]);
    saved = loadQuote(base, indices).pieces[KEY];
    assert.deepEqual([saved.outillageTiroirs, saved.tiroirs3D, saved.valeursIA], [2, record, undefined]);
    r = ui.compute().results.find((x) => x.piece.key === KEY);
    assert.equal(r.trace['piece.outillage.tiroirs'].source.type, 'geometrie_validee');
    assert.deepEqual(slidesLineModel(r).buttons, [{ action: 'undo-slides-3d', label: 'Ne plus utiliser l\'analyse 3D' }]);
    // Applied twice, the second undone: the count validated back too, with its record.
    ui.applyAIValues(target, [{ cle: 'piece.outillage.tiroirs', valeur: 3 }], { date: DATE, message: 'm2' });
    ui.applyAIValues(target, [{ cle: 'piece.outillage.tiroirs', valeur: 5 }], { date: DATE, message: 'm3' });
    assert.deepEqual(ui.undoAIValues(target, { message: 'm3' }).undone.map((x) => [x.champ, x.avant, x.apres]), [['outillageTiroirs', 5, 2]]);
    saved = loadQuote(base, indices).pieces[KEY];
    assert.deepEqual([saved.outillageTiroirs, saved.tiroirs3D], [2, record]);
  });

  test('0 slide: conform to the default; a value typed or another default: « Utiliser 0 tiroir »', () => {
    const none = { ...BRIEF, count: 0, cores: 0, parting_zones: 1, slides: [] };
    let r = computed({ procede: 'CG3' }, p3d(none));
    let line = slidesLineModel(r);
    assert.equal(line.text, 'Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé : conforme à la valeur par défaut. 0 tiroir : les contre-dépouilles sont des noyaux probables, des détails ignorés ou à reprendre au plan de joint.');
    assert.deepEqual(line.buttons, []);
    assert.deepEqual(divergences(r.trace['piece.outillage.tiroirs']), []);
    // A closed cavity: the count conform, then the probable core.
    line = slidesLineModel(computed({ procede: 'CG3' }, p3d({ ...none, cores: 1, parting_zones: 0 })));
    assert.equal(line.text.split('. ')[0], 'Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé : conforme à la valeur par défaut ; 1 noyau probable (non compté)');
    r = computed({ procede: 'CG3', outillageTiroirs: 2 }, p3d(none));
    line = slidesLineModel(r);
    assert.match(line.text, /^Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé \(saisi : 2\)\./);
    assert.deepEqual(line.buttons, [{ action: 'use-slides-3d', label: 'Utiliser 0 tiroir' }]);
    r = computed({ procede: 'CG3' }, p3d(none));
    assert.match(slidesLineModel(r, { defaut: 1 }).text, /^Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé \(par défaut : 1\)\./);
  });

  test('the analysis computing, failed, or no parting line; more than 4 slides; a partial analysis', () => {
    assert.equal(slidesLineModel(computed({ procede: 'CG3' }, p3d({ status: 'computing' }))).text, 'Analyse 3D des tiroirs en cours…');
    assert.equal(slidesLineModel(computed({ procede: 'CG3' }, p3d({ status: 'error', message: 'out of memory' }))).text, 'Analyse 3D des tiroirs impossible : out of memory.');
    assert.equal(slidesLineModel(computed({ procede: 'CG3' }, p3d({ status: 'none' }))).text, 'Pas d\'analyse 3D des tiroirs : plan de joint non calculé pour ce corps (page Analyse 3D).');
    const r = computed({ procede: 'CG3' }, p3d({ status: 'computing' }));
    assert.deepEqual(r.trace['piece.outillage.tiroirs'].alternatives.filter((a) => a.source === 'geometrie'), []);
    const many = { ...BRIEF, count: 5, cores: 0, warnings: ['many_slides', 'capped'], slides: [1, 2, 3, 4, 5].map((n) => ({ id: `T${n}`, axis: 'Y', reference_axis: '+Y', stroke_mm: 10 })) };
    const line = slidesLineModel(computed({ procede: 'CG3' }, p3d(many)));
    assert.equal(line.warn, true);
    assert.match(line.text, /\. Plus de 4 tiroirs : revoir la direction de démoulage, ou des noyaux\. \(analyse partielle\)$/);
  });

  test('no in-house die (island SSP): no slides traced, nothing proposed', () => {
    const r = computed({ procede: 'SSP' });
    assert.equal(r.route.tooling, null);
    assert.equal(slidesProposal(r.piece, r.route), null);
    assert.equal(slidesLineModel(r), null);
    assert.ok(!('piece.outillage.tiroirs' in r.trace));
  });

  test('without slides in the 3D part: the trace as before (no key of its own, the die from the settings)', () => {
    const r = computed({ procede: 'CG3' }, p3d(null));
    assert.ok(!('piece.outillage.tiroirs' in r.trace));
    const mould = r.trace['piece.outillage.total'];
    assert.ok(!mould.source.entrees.includes('piece.outillage.tiroirs'));
    assert.ok(mould.hypotheses.some((h) => h.startsWith('0 tiroir (par défaut)')));
    // The same confidence and validation as with a count of the analysis equal to the default.
    const same = computed({ procede: 'CG3' }, p3d({ ...BRIEF, count: 0, cores: 0, slides: [] }))?.trace['piece.outillage.total'];
    assert.deepEqual([same.confiance, same.validation_requise], [mould.confiance, mould.validation_requise]);
    assert.equal(slidesProposal({ slides: undefined }, r.route).status, 'none');
  });

  test('the AI: the die\'s count from analyse_3d, the part\'s × its cavities in the trace (0 too), or from the trace; another refused', () => {
    const proposal = (valeur, source = 'analyse_3d') => ({ piece: 'A', index: 0, cle: 'piece.outillage.tiroirs', champ: 'outillageTiroirs', valeur, unite: '', source, justification: '', refus: null });
    const cavities = (n) => ({ pieces: [{ nom: 'A', valeurs: { 'piece.empreintes': { valeur: n } } }] });
    const sent = (count, n = 1) => ({ bodies: [{ slides: { status: 'proposed', count } }], costing_trace: cavities(n) });
    const absent = 'mesure absente de l\'analyse de la pièce pour cette clé';
    assert.deepEqual(checkProposals([proposal(2)], sent(2)).map((p) => [p.valeur, p.refus]), [[2, null]]);
    assert.deepEqual(checkProposals([proposal(0)], sent(0)).map((p) => [p.valeur, p.refus]), [[0, null]]);
    assert.deepEqual(checkProposals([proposal(3)], sent(2)).map((p) => p.refus), [absent]);
    // 2 cavities: 4 slides for the die; the part's 2 is not the die's.
    assert.deepEqual(checkProposals([proposal(4), proposal(2)], sent(2, 2)).map((p) => [p.valeur, p.refus]), [[4, null], [2, absent]]);
    // The cavities not in the trace sent (compacted): no count of the die from the analysis.
    assert.deepEqual(checkProposals([proposal(2)], { bodies: [{ slides: { status: 'proposed', count: 2 } }] }).map((p) => p.refus), [absent]);
    // The die's count: the alternative of the trace sent.
    const trace = { pieces: [{ nom: 'A', valeurs: { 'piece.outillage.tiroirs': { valeur: 0, autres_sources: [{ source: 'géométrie 3D', valeur: 4 }] } } }] };
    assert.deepEqual(checkProposals([proposal(4, 'trace')], { ...sent(2), costing_trace: trace }).map((p) => [p.valeur, p.refus]), [[4, null]]);
  });

  test('names: a pull direction, the parting line', () => {
    assert.equal(slideName({ reference_axis: '+Y' }), '+Y');
    assert.equal(slideName({ reference_axis: '+Y', angle_deg: 30 }), '+Y +30°');
    assert.equal(slideName({ reference_axis: '-X', angle_deg: -12.5 }), '−X −12,5°');
    assert.equal(slideName({ reference_axis: '+Y', tilt_deg: 20, tilt_up: true }), '+Y, incliné de 20° vers le haut');
    assert.equal(slideName({ reference_axis: '+Y', angle_deg: 30, tilt_deg: 20, tilt_up: false }), '+Y +30°, incliné de 20° vers le bas');
    assert.equal(partingText({ axis: 'Z', status: 'proposed' }), 'plan de joint Z proposé');
    assert.equal(partingText({ axis: 'X', status: 'manual', source: 'candidate' }), 'plan de joint X défini à la main');
    assert.equal(partingText({ axis: 'Z', status: 'manual', source: 'drawn' }), 'plan de joint dessiné à la main');
  });
});

// ---------------------------------------------------------------- semantic contract, foundry screen, AI context

function body(overrides = {}) {
  return {
    name: 'Casting body', method: 'brep', closed: true, volume: 120000, area: 24000, centroid: [0, 0, 0],
    bbox: { min: [-50, -40, -20], max: [50, 40, 20], size: [100, 80, 40] },
    surface_types: { plane: 4, cylinder: 2, cone: 0, sphere: 0, torus: 0, bspline: 0 },
    mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    geometric_surfaces: [], notes: [],
    ...overrides,
  };
}
const PARTING = {
  status: 'proposed', axis: 'Z', direction: [0, 0, 1], source: null, undercut_area_mm2: 850, undercut_share: 0.035, zero_draft_area_mm2: 6400, zero_draft_share: 0.3478,
  projected_area_mm2: 6000, mould_height_mm: 40, parting: { planar: true, kind: 'planar', height_range_mm: 0, length_mm: 360, loops: 1, level_mm: 0 }, draft_angle_deg: 1,
  candidates: [], sampled: null, method: 'line_of_sight_along_draw_direction_uniform_grid',
};
const tags = (extra = {}) => ({ inclined: false, small: false, long_stroke: false, also_by_half: false, partial: null, forced: null, ...extra });
const slide = (id, axis, reference_axis, direction, stroke_mm, extra = {}) => ({
  id, axis, direction, reference_axis, angle_deg: null, tilt_deg: null, zones: [Number(id.slice(1))], area_mm2: 350, depth_mm: stroke_mm - 5, stroke_mm, size_mm: [10, 10], half: 'across', tags: tags(), ...extra,
});
/** The slides of a body as app.js slidesExport gives them. */
function slidesOf(overrides = {}) {
  return {
    version: 1, method: 'lateral_release_lines_of_sight_bvh', status: 'proposed',
    parting: { axis: 'Z', status: 'proposed', source: null, direction: [0, 0, 1] },
    count: 2, cores: 1, parting_zones: 0, ignored: 0,
    slides: [slide('T1', 'Y', '+Y', [0, 1, 0], 15), slide('T2', '-X', '-X', [-1, 0, 0], 25)],
    cores_detail: [{ id: 'N1', area_mm2: 150, centroid_mm: [0, 0, 0], reason: 'enclosed' }],
    parting_detail: [],
    undercut_area_mm2: 850, ignored_area_mm2: 0, not_analysed: { zones: 0, area_mm2: 0 },
    warnings: [], sampled: { scaled: false, split_sampled: 0 }, thresholds: {}, signature: 's1:12:12:00000000#00000000', edited: null,
    ...overrides,
  };
}
const semanticOf = (b) => buildSemantic3D({ file: 'casting.step', kind: 'cad', engine: 'browser', summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 }, bodies: [b] });

describe('the slides in the semantic contract, the foundry screen and the AI context', () => {
  test('kept beside the parting line; the foundry screen: evidence, rule, risks and checks, sourced', () => {
    const slides = slidesOf();
    const b = semanticOf(body({ parting: PARTING, slides })).bodies[0];
    assert.deepEqual(b.slides, slides);
    const { evidence, rules, risks, required_checks: checks } = b.foundry;
    assert.deepEqual(evidence.slides, {
      status: 'proposed', count: 2, cores: 1, parting_zones: 0, ignored: 0, inclined: 0, long_strokes: 0, max_stroke_mm: 25, enclosed_cavities: 1, edited: false, capped: false,
    });
    assert.equal(rules.slides, 'proposed_from_undercut_regions');
    assert.equal(rules.cores, 'undercuts_detected', 'unchanged');
    assert.ok(evidence.confirmed.includes('slides_grouped_from_undercuts'));
    const by = Object.fromEntries(risks.map((r) => [r.code, r]));
    assert.equal(by.slides_proposed.message, '2 tiroirs proposés (T1 +Y, course 15 mm ; T2 −X, course 25 mm) : à valider avec l\'outillage.');
    assert.equal(by.slides_proposed.severity, 'review');
    assert.equal(by.probable_sand_core.message, '1 zone sans sortie latérale (noyau probable ou usinage) : 150 mm².');
    assert.deepEqual([by.enclosed_cavity.severity, by.enclosed_cavity.message], ['high', 'Cavité fermée sans ouverture (150 mm²) : noyau sans portée, à revoir avec le client.']);
    assert.ok(by.undercut_requires_core_or_slide, 'the risk of the undercuts unchanged');
    assert.ok(!by.many_slides && !by.inclined_slide && !by.long_stroke && !by.undercut_to_rework_at_parting_line);
    for (const r of risks) assert.ok(r.source_ids.every((id) => FOUNDRY_SOURCES.some((s) => s.id === id)), r.code);
    for (const code of ['slides_proposed', 'probable_sand_core', 'enclosed_cavity']) assert.equal(by[code].basis, 'measured_lateral_lines_of_sight');
    assert.ok(checks.includes('validate_slides_with_tooling'));
    assert.ok(checks.includes('confirm_cores_for_unreleasable_undercuts'));
  });

  test('many, inclined, long slides; zones to rework at the parting line; edited by hand; none needed', () => {
    const five = [1, 2, 3, 4, 5].map((n) => slide(`T${n}`, 'Y', '+Y', [0, 1, 0], 10));
    five[1] = slide('T2', '(0, 0.93969, 0.34202)', '+Y', [0, 0.93969, 0.34202], 20, { tilt_deg: 20, tilt_up: true, tags: tags({ inclined: true }) });
    five[2] = slide('T3', 'X', '+X', [1, 0, 0], 135, { tags: tags({ long_stroke: true }) });
    let f = semanticOf(body({ parting: PARTING, slides: slidesOf({ status: 'manual', edited: { zones: 2, slides: 1 }, count: 5, cores: 0, parting_zones: 2, slides: five, cores_detail: [] }) })).bodies[0].foundry;
    const by = Object.fromEntries(f.risks.map((r) => [r.code, r]));
    assert.equal(f.rules.slides, 'edited_manually');
    assert.ok(by.many_slides);
    assert.match(by.inclined_slide.message, /^1 tiroir incliné hors du plan de joint \(T2 : 20°\)/);
    assert.match(by.long_stroke.message, /^Course longue \(T3 : 135 mm\)/);
    assert.match(by.undercut_to_rework_at_parting_line.message, /^2 zones qu'une chape pourrait former/);
    assert.ok(!by.probable_sand_core && !by.enclosed_cavity);
    assert.deepEqual([f.evidence.slides.inclined, f.evidence.slides.long_strokes, f.evidence.slides.max_stroke_mm, f.evidence.slides.edited], [1, 1, 135, true]);
    f = semanticOf(body({ parting: { ...PARTING, undercut_area_mm2: 0, undercut_share: 0 }, slides: slidesOf({ count: 0, cores: 0, slides: [], cores_detail: [] }) })).bodies[0].foundry;
    assert.equal(f.rules.slides, 'none_needed');
    assert.ok(!f.required_checks.includes('validate_slides_with_tooling'));
    // Not computed yet: not evaluated.
    f = semanticOf(body({ parting: PARTING, slides: { status: 'computing' } })).bodies[0].foundry;
    assert.deepEqual([f.rules.slides, f.evidence.slides], ['not_evaluated', { status: 'not_evaluated' }]);
  });

  test('a slide tilted down, as the engine gives it and the page exports it: « vers le bas » in the foundry screen, in the AI context', () => {
    // A block 60 × 40 × 40, a pocket 10 × 10 15 deep into +Y (slides.test.mjs), turned 20° down about X.
    const mesh = voxels((x, y, z) => !(x >= 5 && x < 7 && y >= 5 && z >= 3 && z < 5), [12, 8, 8], { size: 5 });
    const [c, sn] = [Math.cos(-20 * Math.PI / 180), Math.sin(-20 * Math.PI / 180)];
    const P = Float64Array.from(mesh.positions);
    for (let k = 0; k < P.length; k += 3) {
      const [y, z] = [P[k + 1] - 20, P[k + 2] - 20];
      [P[k + 1], P[k + 2]] = [c * y - sn * z + 20, sn * y + c * z + 20];
    }
    const ev = evaluateParting(P, mesh.indices, [0, 0, 1]);
    const analysis = analyseSlides(prepareSlides(P, mesh.indices), { direction: [0, 0, 1], mask: undercutMask({ flags: ev.flags }), flags: ev.flags, side: ev.side });
    const exported = effectiveSlides(analysis).slides.map(slideExport);
    assert.deepEqual(exported.map((x) => [x.id, x.reference_axis, x.tilt_deg, x.tilt_up]), [['T1', '+Y', 20, false]]);
    const semantic = semanticOf(body({ parting: PARTING, slides: slidesOf({ count: 1, cores: 0, slides: exported, cores_detail: [] }) }));
    const risk = semantic.bodies[0].foundry.risks.find((r) => r.code === 'slides_proposed');
    assert.equal(risk.message, '1 tiroir proposé (T1 +Y, incliné de 20° vers le bas, course 20 mm) : à valider avec l\'outillage.');
    assert.deepEqual(buildAIContext(semantic, { task: 'general' }).bodies[0].slides.slides.map((x) => [x.tilt_deg, x.tilt_up]), [[20, false]]);
  });

  test('the AI context: compact, shortened when compacted; without slides, nothing of them', () => {
    const semantic = semanticOf(body({ parting: PARTING, slides: slidesOf() }));
    const context = buildAIContext(semantic, { task: 'general' });
    assert.deepEqual(context.bodies[0].slides, {
      status: 'proposed', count: 2, cores: 1, parting_zones: 0, ignored: 0, edited: false,
      slides: [{ id: 'T1', axis: 'Y', stroke_mm: 15, zones: 1 }, { id: 'T2', axis: '-X', stroke_mm: 25, zones: 1 }],
      cores_detail: [{ id: 'N1', area_mm2: 150, reason: 'enclosed' }],
    });
    assert.ok(context.bodies[0].parting, 'the parting line beside it');
    assert.deepEqual(compactAIContext(context, { maxChars: 1 }).bodies[0].slides, { status: 'proposed', count: 2, cores: 1, parting_zones: 0 });
    assert.deepEqual(buildAIContext(semanticOf(body({ parting: PARTING, slides: { status: 'computing' } })), { task: 'general' }).bodies[0].slides, { status: 'computing' });
    // Without slides: no field of them in the contract nor in the context.
    const plain = semanticOf(body({ parting: PARTING }));
    assert.ok(!('slides' in plain.bodies[0]));
    const ctx = buildAIContext(plain, { task: 'general' });
    assert.ok(!('slides' in ctx.bodies[0]));
    assert.ok(!('slides' in compactAIContext(ctx, { maxChars: 1 }).bodies[0]));
    assert.ok(!plain.bodies[0].foundry.risks.some((r) => ['slides_proposed', 'probable_sand_core', 'enclosed_cavity'].includes(r.code)));
  });
});
