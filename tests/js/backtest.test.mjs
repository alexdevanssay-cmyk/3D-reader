// Backtest of the AI on the history of cycle times (web/chiffrage/backtest.js):
// the records run, leave one out, the data of a record for the AI; the
// scheduler with a fake AI and a fake clock (pace from the quota of the
// gateway, stop on a refusal for quota, resume where it stopped, cancel);
// the results against the formula, their summary, reading and CSV; the
// request without the local fallback (ai-workspace.js askJSON). Made-up
// settings and records only.
//
//   node --test tests/js/backtest.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_INTERVAL_S, MIN_INTERVAL_S, backtestCsv, backtestItems, backtestKey, backtestReading, backtestRows, duration, fingerprint, leaveOneOut, nextPace, resultOf, runBacktest,
  summarizeBacktest,
} from '../../web/chiffrage/backtest.js';
import { anonymiseCycleData, cycleQuestion, fitCycleData, recordCycleData } from '../../web/chiffrage/ai-cycle.js';
import { formulaCycle } from '../../web/chiffrage/history.js';

// This browser's storage, for askJSON (the choices of the IA page).
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

// Made-up settings: one island, without the estimate of the mise au mille (its own value is used).
const SETTINGS = { processes: { CG3: { famille: 'Coquille essai', cycle: { base: 100, parKg: 10, exposant: 1, parModule2: 2 }, miseAuMille: 1.5, empreintesMax: 2, grappeMax: 10 } } };

/** Made-up records of the history. */
const record = (over) => ({
  ref: 'T-ALPHA', fichier_3d: 'alpha_secret.stp', source: 'devis', ilot: 'CG3', temps_cycle_s: 200, pieces_par_cycle: 1, trs: 0.8, poids_kg: 2, module_mm: 4,
  volume_cm3: 740, surface_cm2: 1800, encombrement_mm: [160, 90, 40], noyaux: false, sable_kg: null, serie: 500, mise_au_mille: 1.5, ...over,
});
const HISTORY = [
  record(),
  record({ ref: 'T-BRAVO', source: 'production', temps_cycle_s: 150, pieces_par_cycle: 2, poids_kg: 1, module_mm: 3 }),
  record({ source: 'production', temps_cycle_s: 190 }), // the same part as T-ALPHA, measured
  record({ ref: 'T-DELTA', ilot: 'BPR', temps_cycle_s: 120, poids_kg: 3, module_mm: 5 }), // an island not in the settings
  record({ ref: 'T-ECHO', temps_cycle_s: 60, poids_kg: 0.5, module_mm: null }), // no modulus: not run
];

describe('the records run and the data sent', () => {
  test('the records with a weight and a modulus, keyed by source and reference; a result valid while its values do not change', () => {
    const items = backtestItems(HISTORY);
    assert.deepEqual(items.map((x) => x.key), ['devis|T-ALPHA', 'production|T-BRAVO', 'production|T-ALPHA', 'devis|T-DELTA']);
    assert.equal(items[0].record, HISTORY[0]);
    const noRef = record({ ref: null });
    assert.equal(backtestKey(noRef), `devis|${JSON.stringify(noRef)}`);
    const results = { 'devis|T-ALPHA': { empreinte: fingerprint(HISTORY[0]), estimation_s: 210 } };
    assert.equal(resultOf(results, items[0]).estimation_s, 210);
    assert.equal(resultOf(results, items[1]), null);
    // The record changed since (another time, another weight...): estimated again.
    assert.equal(resultOf(results, { key: 'devis|T-ALPHA', record: record({ temps_cycle_s: 205 }) }), null);
    assert.equal(resultOf(results, { key: 'devis|T-ALPHA', record: record({ module_mm: 4.5 }) }), null);
    assert.equal(resultOf(results, { key: 'devis|T-ALPHA', record: record({ note: 'autre' }) }).estimation_s, 210, 'a note changes nothing');
  });

  test('leave one out: neither the record nor another of its reference (the same part, of the other source)', () => {
    assert.deepEqual(leaveOneOut(HISTORY, HISTORY[0]).map((x) => `${x.source}|${x.ref}`), ['production|T-BRAVO', 'devis|T-DELTA', 'devis|T-ECHO']);
    assert.deepEqual(leaveOneOut(HISTORY, HISTORY[1]).length, 4);
    // Without a reference: only itself.
    const a = record({ ref: null, temps_cycle_s: 111 });
    const b = record({ ref: null, temps_cycle_s: 222 });
    assert.deepEqual(leaveOneOut([a, b, HISTORY[1]], structuredClone(a)), [b, HISTORY[1]]);
  });

  test('the data of a record: as for a piece of the quote, without its own time; the formula and its terms; the similar parts without it', () => {
    const x = HISTORY[0];
    const trend = { processes: { CG3: { ...SETTINGS.processes.CG3, cycle: { base: 90, parKg: 10, exposant: 1, parModule2: 2 } } } };
    const data = recordCycleData(x, { settings: SETTINGS, history: leaveOneOut(HISTORY, x), trend });
    assert.deepEqual(data.piece, {
      nom: 'T-ALPHA', poids_kg: 2, poids_source: 'historique', module_mm: 4, plus_grande_dimension_mm: 160, encombrement_mm: [160, 90, 40], volume_cm3: 740, surface_cm2: 1800, noyaux: false,
    });
    assert.deepEqual(data.coulee, { ilot: 'CG3', libelle: 'Coquille essai', mise_au_mille: 1.5, kg_coules_par_piece: 3, pieces_par_cycle: 1, kg_coules_par_cycle: 3, serie: 500 });
    // 100 + 10 × (2 kg × 1,5 × 1) + 2 × 4² = 162 s: history.js formulaCycle, with its terms.
    assert.equal(formulaCycle(x, SETTINGS), 162);
    assert.deepEqual([data.formule.valeur_s, data.formule.termes_s], [162, { base: 100, poids: 30, module: 32 }]);
    assert.deepEqual(data.tendance, { valeur_s: 152, ecart_formule_pct: Number(((10 / 152) * 100).toPrecision(6)) });
    // Its own time is never sent: no cycle of a quote, no similar part of its reference.
    assert.equal('cycle_devis' in data, false);
    assert.deepEqual(data.pieces_similaires.map((s) => [s.ref, s.source, s.temps_cycle_s]), [['T-BRAVO', 'production', 150], ['T-ECHO', 'devis', 60], ['T-DELTA', 'devis', 120]]);
    assert.doesNotMatch(JSON.stringify(data), /"temps_cycle_s":(200|190)\b|alpha_secret/);
    assert.equal(cycleQuestion(data), "Estime le temps de cycle de coulée de cette pièce sur l'îlot CG3 (Coquille essai).");
    // Anonymised for the gateway: the reference of the record and those of the history replaced.
    const a = anonymiseCycleData(data, { file: x.fichier_3d });
    assert.equal(a.data.piece.nom, 'Pièce');
    assert.deepEqual(a.data.pieces_similaires.map((s) => s.ref), ['Historique 1', 'Historique 2', 'Historique 3']);
    assert.doesNotMatch(JSON.stringify(a.data), /T-(ALPHA|BRAVO|DELTA|ECHO)/);

    // Pieces per cycle and mise au mille unknown: the island's estimates, as the formula of the history.
    const bare = recordCycleData(record({ pieces_par_cycle: null, mise_au_mille: null }), { settings: SETTINGS });
    assert.deepEqual([bare.coulee.mise_au_mille, bare.coulee.pieces_par_cycle, bare.formule.valeur_s], [1.5, 2, 100 + 10 * 6 + 32]);
    assert.equal('pieces_similaires' in bare, false);
    // An island not in the settings: no formula, the question without its label; still within a small budget.
    const other = recordCycleData(HISTORY[3], { settings: SETTINGS, history: leaveOneOut(HISTORY, HISTORY[3]) });
    assert.equal('formule' in other, false);
    assert.deepEqual(other.coulee, { ilot: 'BPR', mise_au_mille: 1.5, kg_coules_par_piece: 4.5, pieces_par_cycle: 1, kg_coules_par_cycle: 4.5, serie: 500 });
    assert.equal(cycleQuestion(other), "Estime le temps de cycle de coulée de cette pièce sur l'îlot BPR.");
    const small = fitCycleData(other, 300);
    assert.equal(small.compaction.niveau, 5);
    assert.equal('pieces_similaires' in small, false);
  });
});

describe('the pace', () => {
  test('20 s between two requests until the quota is known; then as many a minute as its tokens allow, never under 6 s', () => {
    assert.deepEqual([DEFAULT_INTERVAL_S, MIN_INTERVAL_S], [20, 6]);
    assert.deepEqual(nextPace({ quota: null, usage: null }), { interval: 20_000, tokens: null, wait: 0 });
    // 4,000 tokens a request, 8,000 a minute (Groq's free plan): one request every 34.5 s (15 % of room).
    const pace = nextPace({ quota: { tokens_limit_minute: 8000, tokens_remaining_minute: 6000, reset_tokens: '15s' }, usage: { total_tokens: 4000 } });
    assert.deepEqual(pace, { interval: 34_500, tokens: 4000, wait: 0 });
    // Fewer tokens left in the minute than a request takes: until they are back.
    assert.deepEqual(nextPace({ quota: { tokens_limit_minute: 8000, tokens_remaining_minute: 3000, reset_tokens: '22.5s' }, usage: { total_tokens: 3000 } }, pace), { interval: 34_500, tokens: 4000, wait: 22_500 });
    // A larger plan: the fastest pace of the gateway (two requests to it an estimate, 20 a minute).
    assert.equal(nextPace({ quota: { tokens_limit_minute: 250_000, tokens_remaining_minute: 240_000 }, usage: { total_tokens: 4000 } }).interval, 6000);
    // No usage given: what the minute lost with the first request.
    assert.deepEqual(nextPace({ quota: { tokens_limit_minute: 8000, tokens_remaining_minute: 3200 } }), { interval: 41_400, tokens: 4800, wait: 0 });
    // The durations of the rate-limit headers.
    assert.deepEqual(['7.66s', '2m59.5s', '1h2m', '250ms', '12', 30, '', null, 'bientôt'].map(duration), [7.66, 179.5, 3720, 0.25, 12, 30, null, null, null]);
  });
});

/** A fake clock: `now`, and a sleep that only moves it (an AbortError when the signal aborted). */
function clock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => void (t += ms),
    sleeps,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new DOMException('annulé', 'AbortError');
      sleeps.push(ms);
      t += ms;
    },
  };
}

/** A fake AI: each request takes 2 s; `answers[n]` (n: the request) gives its answer or throws; the records asked are listed. */
function fakeAI(c, answers = []) {
  const asked = [];
  const estimate = async (item, signal) => {
    asked.push(item.key);
    c.advance(2000);
    const answer = answers[asked.length - 1];
    if (typeof answer === 'function') return answer(item, signal);
    return {
      result: { empreinte: fingerprint(item.record), estimation_s: item.record.temps_cycle_s * 1.1, fourchette_s: [item.record.temps_cycle_s, item.record.temps_cycle_s * 1.2], confiance: 'moyenne' },
      quota: { tokens_limit_minute: 8000, tokens_remaining_minute: 6000, reset_tokens: '20s', requests_remaining_day: 900 },
      usage: { total_tokens: 4000 },
      ...answer,
    };
  };
  return { asked, estimate };
}

const quotaError = (retryAfter) => Object.assign(new Error(`Quota de Groq (offre gratuite) atteint. Réessayez dans ${retryAfter} s.`), { status: 429, retryAfter });

describe('the scheduler, with a fake AI', () => {
  const items = backtestItems(HISTORY);

  test('one request after another, paced by the quota of the gateway; each result given as it comes', async () => {
    const c = clock();
    const ai = fakeAI(c, [
      {}, // 4,000 tokens: 34.5 s from the start of one request to the start of the next
      { quota: { tokens_limit_minute: 8000, tokens_remaining_minute: 1000, reset_tokens: '40s', requests_remaining_day: 899 } }, // the minute spent: 40 s after the answer
      { quota: null, usage: null }, // no quota: the pace of before
    ]);
    const results = {};
    const progress = [];
    const outcome = await runBacktest(items, {
      estimate: ai.estimate, now: c.now, sleep: c.sleep,
      onResult: (item, result) => (results[item.key] = result),
      onProgress: (p) => progress.push([p.done, p.total, p.item.key, p.waitUntil === null ? null : p.waitUntil - c.now()]),
    });
    assert.deepEqual(ai.asked, items.map((x) => x.key));
    assert.deepEqual(c.sleeps, [32_500, 40_000, 32_500]);
    assert.deepEqual(Object.keys(results), items.map((x) => x.key));
    assert.deepEqual({ ...outcome, next: outcome.next - c.now() }, { status: 'done', message: null, retryAfter: null, done: 4, total: 4, next: 32_500 });
    assert.deepEqual(progress, [
      [0, 4, 'devis|T-ALPHA', null],
      [1, 4, 'production|T-BRAVO', 32_500], [1, 4, 'production|T-BRAVO', null],
      [2, 4, 'production|T-ALPHA', 40_000], [2, 4, 'production|T-ALPHA', null],
      [3, 4, 'devis|T-DELTA', 32_500], [3, 4, 'devis|T-DELTA', null],
    ]);
  });

  test('without a quota from the gateway: one request every 20 s; a local AI: no wait at all', async () => {
    const c = clock();
    const none = { quota: null, usage: null };
    await runBacktest(items, { estimate: fakeAI(c, [none, none, none, none]).estimate, now: c.now, sleep: c.sleep });
    assert.deepEqual(c.sleeps, [18_000, 18_000, 18_000]);
    const local = clock();
    const ai = fakeAI(local, Array(4).fill(none));
    const outcome = await runBacktest(items, { estimate: ai.estimate, local: true, notBefore: local.now() + 60_000, now: local.now, sleep: local.sleep });
    assert.deepEqual([local.sleeps, ai.asked.length, outcome.status, outcome.next], [[], 4, 'done', 0]);
  });

  test('a refusal for quota stops the run cleanly; resumed, it waits for the quota and asks only the records left', async () => {
    const c = clock();
    const results = {};
    const onResult = (item, result) => (results[item.key] = result);
    const first = fakeAI(c, [{}, {}, () => { throw quotaError(45); }]);
    const stopped = await runBacktest(items, { estimate: first.estimate, onResult, now: c.now, sleep: c.sleep });
    assert.deepEqual({ ...stopped, next: stopped.next - c.now() }, {
      status: 'quota', message: 'Quota de Groq (offre gratuite) atteint. Réessayez dans 45 s.', retryAfter: 45, done: 2, total: 4, next: 45_000,
    });
    assert.deepEqual(Object.keys(results), ['devis|T-ALPHA', 'production|T-BRAVO']);
    assert.deepEqual(first.asked, ['devis|T-ALPHA', 'production|T-BRAVO', 'production|T-ALPHA']);

    // Resumed (after a reload: the results and the next start kept): the wait of the quota first, then the third record.
    c.sleeps.length = 0;
    const second = fakeAI(c);
    const progress = [];
    const resumed = await runBacktest(items, {
      results: structuredClone(results), notBefore: stopped.next, estimate: second.estimate, onResult, now: c.now, sleep: c.sleep, onProgress: (p) => progress.push(p.done),
    });
    assert.deepEqual(second.asked, ['production|T-ALPHA', 'devis|T-DELTA']);
    assert.deepEqual(c.sleeps, [45_000, 32_500]);
    assert.equal(progress[0], 2, 'the progress counts the records done before');
    assert.deepEqual([resumed.status, resumed.done, resumed.total], ['done', 4, 4]);
    assert.equal(Object.keys(results).length, 4);
    // Nothing left: nothing asked.
    const third = fakeAI(c);
    assert.deepEqual(await runBacktest(items, { results, estimate: third.estimate, now: c.now, sleep: c.sleep }).then((x) => [x.status, x.done]), ['done', 4]);
    assert.deepEqual(third.asked, []);
  });

  test('a request too large for a minute (413) stops the run too', async () => {
    const c = clock();
    const ai = fakeAI(c, [() => { throw Object.assign(new Error('La question et son contexte dépassent la limite de tokens par minute de Groq (offre gratuite).'), { status: 413 }); }]);
    const outcome = await runBacktest(items, { estimate: ai.estimate, now: c.now, sleep: c.sleep, notBefore: 5 });
    assert.deepEqual([outcome.status, outcome.done, outcome.retryAfter, outcome.next], ['quota', 0, null, 5]);
  });

  test('the requests of the day used up: stopped before the next one, until the quota of the day is back', async () => {
    const c = clock();
    const day = { quota: { requests_remaining_day: 0, reset_requests: '2h5m', tokens_limit_minute: 8000, tokens_remaining_minute: 7000 } };
    const ai = fakeAI(c, [day]);
    const outcome = await runBacktest(items, { estimate: ai.estimate, now: c.now, sleep: c.sleep });
    assert.deepEqual({ ...outcome, next: outcome.next - c.now() }, {
      status: 'quota', message: "Plus aucune requête permise aujourd'hui par le quota en ligne.", retryAfter: 7500, done: 1, total: 4, next: 7_500_000,
    });
    assert.equal(ai.asked.length, 1);
    // The last record: nothing more to ask, the run is done.
    const last = clock();
    assert.equal((await runBacktest(items.slice(0, 1), { estimate: fakeAI(last, [day]).estimate, now: last.now, sleep: last.sleep })).status, 'done');
  });

  test('another error stops the run; the record is asked again when it resumes', async () => {
    const c = clock();
    const results = {};
    const ai = fakeAI(c, [{}, () => { throw new Error('La passerelle est injoignable (https://gw.example/api/ai).'); }]);
    const outcome = await runBacktest(items, { estimate: ai.estimate, onResult: (item, r) => (results[item.key] = r), now: c.now, sleep: c.sleep });
    assert.deepEqual([outcome.status, outcome.message, outcome.done], ['error', 'La passerelle est injoignable (https://gw.example/api/ai).', 1]);
    const again = fakeAI(c);
    await runBacktest(items, { results, estimate: again.estimate, now: c.now, sleep: c.sleep });
    assert.equal(again.asked[0], 'production|T-BRAVO');
  });

  test('cancelled: during a request or during the wait (the real wait too); the results kept', async () => {
    const c = clock();
    const controller = new AbortController();
    const results = {};
    const ai = fakeAI(c, [{}, () => {
      controller.abort();
      throw new DOMException('annulé', 'AbortError');
    }]);
    const outcome = await runBacktest(items, { estimate: ai.estimate, signal: controller.signal, onResult: (item, r) => (results[item.key] = r), now: c.now, sleep: c.sleep });
    assert.deepEqual([outcome.status, outcome.done, Object.keys(results)], ['cancelled', 1, ['devis|T-ALPHA']]);
    // The real wait (setTimeout) ends at once when cancelled.
    const waiting = new AbortController();
    const asked = [];
    const started = Date.now();
    const run = runBacktest(items, { estimate: async (item) => asked.push(item), signal: waiting.signal, notBefore: Date.now() + 60_000 });
    setTimeout(() => waiting.abort(), 20);
    assert.equal((await run).status, 'cancelled');
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(asked, []);
  });
});

describe('the results', () => {
  const items = backtestItems(HISTORY);
  const kept = (x, over) => ({ empreinte: fingerprint(x), date: '2026-10-08T10:00:00.000Z', fournisseur: 'Groq', modele: 'openai/gpt-oss-120b', similaires: 3, ...over });
  const RESULTS = {
    'devis|T-ALPHA': kept(HISTORY[0], { estimation_s: 210, fourchette_s: [180, 240], confiance: 'moyenne' }),
    'production|T-BRAVO': kept(HISTORY[1], { estimation_s: 120, fourchette_s: [100, 140], confiance: 'faible' }),
    'production|T-ALPHA': kept(HISTORY[2], { estimation_s: 180, fourchette_s: [170, 200], confiance: 'haute' }),
    'devis|T-DELTA': kept(HISTORY[3], { erreur: "Estimation de l'IA inutilisable : pas de fourchette [min, max] en secondes (fourchette_s). Réessayez." }),
  };

  test('each record: its time, the formula with the current settings, the AI and its range, the errors', () => {
    const rows = backtestRows(items, RESULTS, SETTINGS);
    assert.deepEqual(rows.map((x) => [x.key, x.reference, x.formule?.valeur ?? null, x.ia?.valeur ?? null, x.ia?.dedans ?? null]), [
      ['devis|T-ALPHA', 200, 162, 210, true], ['production|T-BRAVO', 150, 148, 120, false], ['production|T-ALPHA', 190, 162, 180, true], ['devis|T-DELTA', 120, null, null, null],
    ]);
    assert.ok(Math.abs(rows[0].formule.ecart - -0.19) < 1e-12 && Math.abs(rows[0].ia.ecart - 0.05) < 1e-12);
    assert.equal(rows[3].resultat.erreur.startsWith("Estimation de l'IA inutilisable"), true);
    // Not estimated yet: no result.
    assert.equal(backtestRows(items, {}, SETTINGS).every((x) => x.ia === null && x.resultat === null && x.formule !== undefined), true);
  });

  test('the mean absolute errors of the formula and of the AI over the same records, by island and by source; the range; read in plain French', () => {
    const s = summarizeBacktest(backtestRows(items, RESULTS, SETTINGS));
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
    const ia = (0.05 + 0.2 + 10 / 190) / 3;
    const formule = (0.19 + 2 / 150 + 28 / 190) / 3;
    assert.deepEqual([s.total.n, s.total.devis, s.total.production, s.total.dedans, s.total.ia.n, s.total.formule.n], [3, 1, 2, 2, 3, 3]);
    near(s.total.ia.emap, ia);
    near(s.total.formule.emap, formule);
    assert.deepEqual(s.ilots.map((x) => [x.ilot, x.n]), [['CG3', 3]]);
    assert.deepEqual(s.sources.map((x) => [x.source, x.n, x.dedans]), [['devis', 1, 1], ['production', 2, 1]]);
    near(s.sources[1].ia.emap, (0.2 + 10 / 190) / 2);
    near(s.sources[1].formule.emap, (2 / 150 + 28 / 190) / 2);
    assert.deepEqual([s.erreurs, s.restantes], [1, 0]);
    assert.equal(backtestReading(s), [
      "Sur 3 pièces chiffrées (1 temps de devis, 2 temps mesurés en production), l'IA s'écarte en moyenne de 10,1 % du temps de référence, la formule de 11,7 %.",
      "Le temps de référence est dans la fourchette de l'IA pour 2 pièces sur 3 (67 %).",
      'Sur les seuls temps mesurés (2) : l\'IA 12,6 %, la formule 8,0 %.',
      "Les temps « devis » sont des estimations des chiffreurs, pas des mesures : l'écart à un temps de devis compare deux estimations ; seuls les temps « production » mesurent l'exactitude.",
      "Si les coefficients de la formule ont été calés sur ces mêmes devis, son écart y est un écart d'ajustement, pas de prévision. L'IA reçoit aussi la valeur de la formule.",
      "Pas d'estimation utilisable pour 1 pièce (voir le tableau).",
    ].join(' '));
    // Coefficients of the trends file (fitted on past quotes): said so.
    assert.match(backtestReading(s, { tendance: true }), /La formule \(coefficients du fichier de tendances\) a pu être calée sur ces mêmes devis : son écart y est alors un écart d'ajustement, pas de prévision\. L'IA reçoit aussi la valeur de la formule\./);
    // Before any estimate, and while some are left.
    assert.equal(backtestReading(summarizeBacktest(backtestRows(items, {}, SETTINGS))), '4 pièces restent à estimer.');
    const one = summarizeBacktest(backtestRows(items, { 'production|T-BRAVO': RESULTS['production|T-BRAVO'] }, SETTINGS));
    assert.equal(backtestReading(one), "Sur 1 pièce chiffrée (1 temps mesuré en production), l'IA s'écarte en moyenne de 20,0 % du temps de référence, la formule de 1,3 %. Le temps de référence est dans la fourchette de l'IA pour 0 pièce sur 1 (0 %). 3 pièces restent à estimer.");
    assert.equal(backtestReading(one, { tendance: true }), backtestReading(one), 'measured times only: no fitting to tell');
  });

  test('exported as CSV for a spreadsheet in French; a reference that looks like a formula is not run', () => {
    const odd = record({ ref: '=HYPERLINK("x")', temps_cycle_s: 100 });
    const rows = backtestRows([...items, { key: backtestKey(odd), record: odd }], RESULTS, SETTINGS);
    const lines = backtestCsv(rows).split('\r\n');
    assert.equal(lines[0], 'reference;ilot;source;temps_reference_s;formule_s;ecart_formule_pct;ia_s;ia_min_s;ia_max_s;ecart_ia_pct;dans_fourchette;confiance;fournisseur;modele;date;erreur');
    assert.equal(lines[1], '"T-ALPHA";"CG3";"devis";200;162;-19;210;180;240;5;oui;"moyenne";"Groq";"openai/gpt-oss-120b";"2026-10-08T10:00:00.000Z";');
    assert.equal(lines[2], '"T-BRAVO";"CG3";"production";150;148;-1,3;120;100;140;-20;non;"faible";"Groq";"openai/gpt-oss-120b";"2026-10-08T10:00:00.000Z";');
    assert.equal(lines[4], '"T-DELTA";"BPR";"devis";120;;;;;;;;;"Groq";"openai/gpt-oss-120b";"2026-10-08T10:00:00.000Z";"Estimation de l\'IA inutilisable : pas de fourchette [min, max] en secondes (fourchette_s). Réessayez."');
    assert.equal(lines[5], '"\'=HYPERLINK(""x"")";"CG3";"devis";100;162;62;;;;;;;;;;');
    assert.equal(lines.at(-1), '');
  });
});

describe('the request of the backtest (ai-workspace.js askJSON)', () => {
  test('a refusal for quota is not answered by the local model: it stops the run, with when to ask again; the usage of the gateway given back', async () => {
    const { askJSON } = await import('../../web/ai-workspace.js');
    storage.clear();
    storage.set('reader3d.ai.provider', 'openai');
    storage.set('reader3d.ai.gateway', 'https://gw.example/api/ai');
    globalThis.location = new URL('https://alexdevanssay-cmyk.github.io/3D-reader/');
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const urls = [];
    let post = () => json({ error: 'Quota de Groq (offre gratuite) atteint. Réessayez dans 45 s.', retry_after: 45 }, 429);
    const { fetch } = globalThis;
    globalThis.fetch = async (url, init = {}) => {
      urls.push(String(url));
      if (String(url).includes('11434')) return json({ models: [{ name: 'qwen3:8b' }] });
      return init.method === 'POST' ? post() : json({ provider: 'Groq', context_chars: 9000 });
    };
    const build = () => ({ context: { piece: { nom: 'Pièce' } }, question: 'Estime le temps de cycle.' });
    try {
      // The box "Repli automatique" ticked (by default): a question of the IA page would go to Ollama, not the backtest.
      const err = await askJSON('cycle_time', build, { fallback: false }).catch((e) => e);
      assert.deepEqual([err.message, err.status, err.retryAfter], ['Quota de Groq (offre gratuite) atteint. Réessayez dans 45 s.', 429, 45]);
      assert.ok(urls.every((u) => u.startsWith('https://gw.example')), urls.join());
      const usage = { prompt_tokens: 3100, completion_tokens: 600, total_tokens: 3700 };
      post = () => json({ output: '{}', provider: 'Groq', model: 'openai/gpt-oss-120b', quota: { tokens_limit_minute: 8000 }, usage });
      const out = await askJSON('cycle_time', build, { fallback: false });
      assert.deepEqual([out.usage, out.quota], [usage, { tokens_limit_minute: 8000 }]);
    } finally {
      globalThis.fetch = fetch;
    }
  });
});
