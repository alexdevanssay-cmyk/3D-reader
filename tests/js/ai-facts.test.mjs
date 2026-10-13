// The key facts of the context of a question of the IA page (web/ai-facts.js),
// kept with each answer, and what changed since, told to the model before the
// next question.
//
//   node --test tests/js/ai-facts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { buildSemantic3D } from "../../web/engine/semantic.js";
import { buildAIContext, checkContextNumbers } from "../../web/engine/ai-context.js";
import { CURRENT_DATA, cleanFacts, diffFacts, factChanges, factsOf, lastFacts, updateNote, withNote } from "../../web/ai-facts.js";
import { normalizeConversation } from "../../web/ai-history.js";

/** A body as the Reader gives it (as in foundry.test.mjs), with these changes. */
function body(overrides = {}) {
  return {
    name: "Carter Dupont",
    method: "brep",
    closed: true,
    volume: 120000,
    area: 24000,
    centroid: [0, 0, 0],
    bbox: { min: [-50, -40, -20], max: [50, 40, 20], size: [100, 80, 40] },
    surface_types: { plane: 4, cylinder: 2, cone: 0, sphere: 0, torus: 0, bspline: 0 },
    mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    geometric_surfaces: [],
    notes: [],
    ...overrides,
  };
}

/** The whole AI context of a part of these bodies for the task `task`, as the IA page builds it before its compaction. */
function contextOf(bodies, task = "general") {
  const semantic = buildSemantic3D({ file: "Carter Dupont.step", kind: "cad", engine: "browser", source_unit: "mm", summary: { volume: 120000, area: 24000, bodies: bodies.length, solids: bodies.length }, bodies });
  return buildAIContext(semantic, { task });
}

const THICKNESS = { method: "ray", min: 4, median: 5, max: 40, sphere: { min: 3.04, median: 5.12, max: 12.04 }, wall: { min: 3.24, median: 5, max: 8 } };

/** The parting of a body (web/engine/parting.js, app.js partingExport), with these changes. */
function parting(overrides = {}) {
  return {
    status: "proposed", axis: "Z", direction: [0, 0, 1], source: "face_normals",
    undercut_area_mm2: 840, undercut_share: 0.035, zero_draft_area_mm2: 6400, zero_draft_share: 0.3478,
    projected_area_mm2: 6000, mould_height_mm: 20, parting: { planar: true, kind: "planar", height_range_mm: 0, length_mm: 320, loops: 1, level_mm: 0 },
    draft_angle_deg: 1, candidates: [], sampled: null, method: "line_of_sight_along_draw_direction_uniform_grid",
    ...overrides,
  };
}

const slides = (count, cores = 1, status = "proposed") => ({ status, count, cores, parting_zones: 0, ignored: 0, slides: [], cores_detail: [] });

test("the facts of a context: the wall thickness measured or not, unknown to the task « Features »; no name", () => {
  const before = factsOf(contextOf([body()]));
  assert.deepEqual(before.bodies, ["body-0"]);
  assert.equal(before.body["body-0"].thickness, null, "not measured");
  assert.equal(before.body["body-0"].closed, true);
  assert.equal(before.body["body-0"].volume, 120000);
  const after = factsOf(contextOf([body({ thickness: THICKNESS })]));
  assert.deepEqual(after.body["body-0"].thickness, { min: 3.2, method: "wall", median: 5.1, max: 12 });
  // The task « Features » is given no foundry screen: the thickness is not known there, never compared.
  const features = factsOf(contextOf([body({ thickness: THICKNESS })], "feature_analysis"));
  assert.equal("thickness" in features.body["body-0"], false);
  assert.deepEqual(diffFacts(features, after), []);
  assert.deepEqual(diffFacts(before, features), []);
  // The names of the part and of its bodies are not facts.
  assert.doesNotMatch(JSON.stringify(after), /Carter|Dupont/);
  // No part: no body.
  assert.deepEqual(factsOf({ no_model_loaded: true, bodies: [] }), { version: 1, bodies: [], body: {} });
  assert.equal(factsOf(null), null);
});

test("the wall thickness measured since the last answer: told with its values, in French", () => {
  const before = factsOf(contextOf([body()]));
  const after = factsOf(contextOf([body({ thickness: THICKNESS })]));
  assert.deepEqual(diffFacts(before, after), ["Épaisseurs : maintenant mesurées (mini 3,2 mm, méthode paroi ; médiane 5,1 mm ; maxi 12 mm)"]);
  assert.deepEqual(factChanges(before, after).map((c) => c.label), ["épaisseurs mesurées"]);
  // Measured again, other values: each one changed as "a → b".
  const again = factsOf(contextOf([body({ thickness: { ...THICKNESS, wall: { min: 2.9, median: 5, max: 8 } } })]));
  assert.deepEqual(diffFacts(after, again), ["Épaisseurs : mini 3,2 → 2,9 mm, méthode paroi ; médiane 5,1 mm ; maxi 12 mm"]);
  assert.deepEqual(diffFacts(after, before), ["Épaisseurs : plus mesurées"]);
});

test("the parting: its direction and how it was defined, the slides counted", () => {
  const proposed = factsOf(contextOf([body({ parting: parting(), slides: slides(2) })]));
  assert.deepEqual(proposed.body["body-0"].parting, { status: "proposed", axis: "Z", origin: "proposed", planar: true, undercut: 3.5 });
  // Drawn by hand along X.
  const drawn = factsOf(contextOf([body({ parting: parting({ status: "manual", source: "drawn", axis: "X", direction: [1, 0, 0], drawn: { loops: 1, segments: [] } }), slides: slides(2) })]));
  assert.deepEqual(diffFacts(proposed, drawn), ["Plan de joint : direction Z → X (dessiné à la main)"]);
  // A candidate chosen, the same direction; its planar line and its undercuts changed.
  const candidate = factsOf(contextOf([body({ parting: parting({ status: "manual", source: "candidate", undercut_share: 0.012, parting: { planar: false, kind: "stepped", height_range_mm: 20, length_mm: 360, loops: 1, levels_mm: [0, 20] } }), slides: slides(2) })]));
  assert.deepEqual(diffFacts(proposed, candidate), ["Plan de joint : proposé → candidat choisi (direction Z) ; ligne plane → non plane ; contre-dépouilles 3,5 % → 1,2 %"]);
  // The task « Features » does not tell how a manual one was defined: not a change.
  const features = factsOf(contextOf([body({ parting: parting({ status: "manual", source: "candidate", undercut_share: 0.012, parting: { planar: false, kind: "stepped", height_range_mm: 20, length_mm: 360, loops: 1, levels_mm: [0, 20] } }), slides: slides(2) })], "feature_analysis"));
  assert.equal(features.body["body-0"].parting.origin, null);
  assert.deepEqual(diffFacts(candidate, features), []);
  // None before.
  assert.deepEqual(diffFacts(factsOf(contextOf([body()])), proposed), [
    "Plan de joint : maintenant défini (direction Z, proposé, ligne plane, contre-dépouilles 3,5 %)",
    "Tiroirs : maintenant calculés (2 tiroirs, 1 noyau probable)",
  ]);
  // The slides: 2 → 3, then edited by hand.
  const three = factsOf(contextOf([body({ parting: parting(), slides: slides(3) })]));
  assert.deepEqual(diffFacts(proposed, three), ["Tiroirs : 2 → 3"]);
  assert.deepEqual(factChanges(proposed, three).map((c) => c.label), ["tiroirs"]);
  assert.deepEqual(diffFacts(three, factsOf(contextOf([body({ parting: parting(), slides: slides(3, 0, "manual") })]))), ["Tiroirs : noyaux probables 1 → 0 ; modifiés à la main"]);
  // Still being computed: then computed.
  assert.deepEqual(diffFacts(factsOf(contextOf([body({ parting: parting(), slides: { status: "computing" } })])), three), ["Tiroirs : maintenant calculés (3 tiroirs, 1 noyau probable)"]);
});

test("the bodies sent: their count and which, a part loaded since a question without one", () => {
  const one = factsOf(contextOf([body()]));
  const three = factsOf(contextOf([body(), body({ name: "Vis" }), body({ name: "Couvercle" })]));
  assert.deepEqual(diffFacts(one, three), ["Corps envoyés : 1 → 3 (body-0, body-1, body-2)"]);
  assert.deepEqual(diffFacts(factsOf({ no_model_loaded: true, bodies: [] }), one), ["Corps envoyés : 0 → 1 (body-0)"]);
  assert.deepEqual(diffFacts(one, factsOf({ no_model_loaded: true, bodies: [] })), ["Corps envoyés : 1 → 0"]);
  // Another body selected: the same count, other ids.
  const other = { ...one, bodies: ["body-1"], body: { "body-1": one.body["body-0"] } };
  assert.deepEqual(diffFacts(one, other), ["Corps envoyés : body-0 → body-1"]);
  // Several bodies: each change under its body's id.
  const measured = factsOf(contextOf([body(), body({ name: "Vis", thickness: THICKNESS }), body({ name: "Couvercle" })]));
  assert.deepEqual(diffFacts(three, measured), ["Épaisseurs (body-1) : maintenant mesurées (mini 3,2 mm, méthode paroi ; médiane 5,1 mm ; maxi 12 mm)"]);
});

test("the feeding, the holes, the body closed, its volume and mass", () => {
  const riser = { position_mm: [0, 0, 20], type: "top", diameter_mm: 30, height_mm: 45, zone_sphere_mm: 18, modulus_mm: 4.5 };
  const feeding = (over = {}) => ({ status: "proposed", risers_status: "proposed", risers: [riser], gate: { position_mm: [50, 0, 0], direction: [1, 0, 0], section_mm2: 147, on_parting_line: true }, yield: { value: 0.6 }, ...over });
  const a = factsOf(contextOf([body({ feeding: feeding() })]));
  const b = factsOf(contextOf([body({ feeding: feeding({ status: "manual", risers: [riser, riser], gate: { position_mm: [-50, 0, 0], section_mm2: 147 } }) })]));
  assert.deepEqual(a.body["body-0"].feeding, { status: "proposed", risers: 1, gate: [50, 0, 0] });
  assert.deepEqual(diffFacts(a, b), ["Alimentation : proposée → placée à la main ; masselottes 1 → 2 ; attaque déplacée"]);
  // Holes measured since, the body closed, another volume and mass (another alloy).
  const before = { version: 1, bodies: ["body-0"], body: { "body-0": { holes: { status: "not_measured", through: null, blind: null }, closed: false, volume: 7257.4, mass: 19.6 } } };
  const after = { version: 1, bodies: ["body-0"], body: { "body-0": { holes: { status: "measured", through: 3, blind: 1 }, closed: true, volume: 7300, mass: 1960 } } };
  assert.deepEqual(diffFacts(before, after), [
    "Trous : maintenant mesurés (3 débouchants, 1 borgne)",
    "Corps : maintenant fermé",
    "Volume : 7,257 cm³ → 7,3 cm³",
    "Masse : 19,6 g → 1,96 kg",
  ]);
  // A floating-point rounding is not a change.
  assert.deepEqual(diffFacts(after, { ...after, body: { "body-0": { ...after.body["body-0"], volume: 7300.0004 } } }), []);
});

test("the costing: the island retained, the cycle, the prices when not masked; the workbook imported since", () => {
  const trace = (ilot, cycle, prix = 26.47) => ({
    schema: "3d-reader-costing-trace",
    pieces: [{ nom: "Carter Dupont", chiffree: true, valeurs: { "piece.ilot": { valeur: ilot }, "piece.cycle": { valeur: cycle, unite: "s" }, "piece.prix.pri": { valeur: prix === "masqué" ? "masqué" : 20.1, unite: "€" }, "piece.prix.vente": { valeur: prix, unite: "€" } } }],
    alertes: [],
  });
  const context = (t) => ({ ...contextOf([body()], "manufacturing_analysis"), costing_trace: t });
  const cg3 = factsOf(context(trace("CG3", 45)));
  assert.deepEqual(cg3.costing, { count: 1, pieces: [{ island: "CG3", cycle: 45, pri: 20.1, price: 26.47 }] });
  assert.doesNotMatch(JSON.stringify(cg3), /Carter|Dupont/);
  assert.deepEqual(diffFacts(cg3, factsOf(context(trace("BPR", 45)))), ["Chiffrage : îlot CG3 → BPR"]);
  assert.deepEqual(diffFacts(cg3, factsOf(context(trace("CG3", 50, 27.1)))), ["Chiffrage : cycle 45 s → 50 s ; prix de vente 26,47 € → 27,10 €"]);
  // An internal amount masked (the gateway without the box ticked): unknown, never told.
  const masked = factsOf(context(trace("CG3", 50, "masqué")));
  assert.deepEqual(masked.costing.pieces[0], { island: "CG3", cycle: 50, pri: null, price: null });
  assert.deepEqual(diffFacts(cg3, masked), ["Chiffrage : cycle 45 s → 50 s"]);
  assert.doesNotMatch(diffFacts(cg3, masked).join(), /26,47/);
  // No workbook, then one imported; another task than « Chiffrage »: the costing not compared.
  assert.deepEqual(diffFacts(factsOf(context(null)), cg3), ["Chiffrage : un classeur de chiffrage est maintenant importé (costing_trace)"]);
  assert.deepEqual(diffFacts(factsOf(contextOf([body()], "manufacturing_analysis")), cg3), []);
});

test("the note before the question: what changed, else nothing; the data first for a conversation without facts", () => {
  const before = factsOf(contextOf([body()]));
  const after = factsOf(contextOf([body({ thickness: THICKNESS })]));
  const note = updateNote(before, after, true);
  assert.equal(note.text, "MISE À JOUR DE LA PIÈCE depuis ta dernière réponse : Épaisseurs : maintenant mesurées (mini 3,2 mm, méthode paroi ; médiane 5,1 mm ; maxi 12 mm). Les DONNÉES jointes sont l'état actuel de la pièce : elles remplacent ce que tu as écrit avant ; refais ton analyse avec elles.");
  assert.deepEqual(note.labels, ["épaisseurs mesurées"]);
  assert.equal(withNote(note, "le calcul d'ép est fait"), `${note.text}\n\nle calcul d'ép est fait`);
  // Nothing changed: no note, the question as it is.
  assert.deepEqual(diffFacts(after, structuredClone(after)), []);
  assert.equal(updateNote(after, structuredClone(after), true), null);
  assert.equal(withNote(null, "Et ?"), "Et ?");
  // No conversation sent: nothing to correct.
  assert.equal(updateNote(before, after, false), null);
  // A conversation of an earlier version, its answers without facts: the data first, in short.
  assert.deepEqual(updateNote(null, after, true), { text: CURRENT_DATA, lines: [], labels: [] });
  assert.equal(CURRENT_DATA, "Les DONNÉES jointes sont l'état actuel de la pièce ; elles priment sur tes réponses précédentes.");
  // The facts of the last answer that has some.
  const messages = [{ role: "user", content: "Q" }, { role: "assistant", content: "R", facts: before }, { role: "user", content: APPLIED }, { role: "assistant", content: "Valeurs appliquées" }];
  assert.equal(lastFacts(messages), before);
  assert.equal(lastFacts([{ role: "assistant", content: "R" }]), null);
  // The numbers of the note come from the data: an answer that repeats them is not flagged for them.
  const answer = "Les épaisseurs sont maintenant mesurées : mini 3,2 mm.";
  assert.deepEqual(checkContextNumbers(answer, { bodies: [] }).inconnus, ["3,2"]);
  assert.deepEqual(checkContextNumbers(answer, { bodies: [] }, [note.text]).inconnus, []);
});
const APPLIED = "Appliquer les valeurs au chiffrage";

test("facts kept from a file of the network folder: their known fields of their types only; a question's update kept", () => {
  const facts = factsOf(contextOf([body({ thickness: THICKNESS, parting: parting(), slides: slides(2) })]));
  assert.deepEqual(cleanFacts(structuredClone(facts)), facts);
  assert.deepEqual(cleanFacts(JSON.parse(JSON.stringify(facts))), facts);
  const tampered = { version: 1, bodies: ["body-0", 3], body: { "body-0": { thickness: { min: "3", method: "<b>", max: 12, onclick: "x" }, parting: "Z", slides: { count: -1, cores: 1.5 }, closed: "yes", volume: 7 } }, costing: { pieces: [{ island: "CG3", cycle: "45" }, "x"] } };
  assert.deepEqual(cleanFacts(tampered), {
    version: 1, bodies: ["body-0"],
    body: { "body-0": { thickness: { min: null, method: "<b>", median: null, max: 12 }, slides: { status: null, count: null, cores: null }, volume: 7 } },
    costing: { count: 0, pieces: [{ island: "CG3", cycle: null, pri: null, price: null }] },
  });
  assert.equal(cleanFacts({ version: 99, bodies: [] }), null);
  assert.equal(cleanFacts("x"), null);
  // In the history: the facts of an answer and the update of a question, cleaned; a message of before stays as it was.
  const c = normalizeConversation({ id: "c", messages: [
    { id: "1", role: "user", content: "Relance l'analyse", date: "2026-10-09T10:00:00Z", update: { labels: ["épaisseurs mesurées", 3], lines: ["Épaisseurs : maintenant mesurées (mini 3,2 mm)"] } },
    { id: "2", role: "assistant", content: "Mini 3,2 mm.", date: "2026-10-09T10:00:00Z", facts },
    { id: "3", role: "assistant", content: "Avant.", date: "2026-10-09T10:00:00Z", facts: { version: 99 } },
  ] });
  assert.deepEqual(c.messages[0].update, { labels: ["épaisseurs mesurées"], lines: ["Épaisseurs : maintenant mesurées (mini 3,2 mm)"] });
  assert.equal(c.messages[0].content, "Relance l'analyse");
  assert.deepEqual(c.messages[1].facts, facts);
  assert.equal("facts" in c.messages[2], false);
});
