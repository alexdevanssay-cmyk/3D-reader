import test from "node:test";
import assert from "node:assert/strict";
import { buildSemantic3D } from "../../web/engine/semantic.js";
import { buildAIContext, compactAIContext } from "../../web/engine/ai-context.js";
import { FOUNDRY_SOURCES, FOUNDRY_SCHEMA_VERSION } from "../../web/engine/foundry-knowledge.js";

function body(overrides = {}) {
  return {
    name: "Casting body",
    method: "brep",
    closed: true,
    volume: 120000,
    area: 24000,
    centroid: [0,0,0],
    bbox: { min: [-50,-40,-20], max: [50,40,20], size: [100,80,40] },
    surface_types: { plane: 4, cylinder: 2, cone: 0, sphere: 0, torus: 0, bspline: 0 },
    mesh: {
      positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      indices: new Uint32Array([0,1,2]),
    },
    geometric_surfaces: [],
    notes: [],
    ...overrides,
  };
}

test("adds conservative foundry intelligence with source metadata", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser", source_unit: "mm",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({
      thickness: { method: "sphere", min: 3, median: 5, max: 10 },
    })],
  });
  const foundry = semantic.bodies[0].foundry;
  assert.equal(foundry.schema_version, FOUNDRY_SCHEMA_VERSION);
  assert.equal(foundry.evidence.thickness.status, "measured");
  assert.equal(foundry.evidence.thickness.max_to_median, 2);
  // The ratio thresholds are 3D Reader heuristics: a review flag, its sources
  // given as background reading, not as the basis of the number.
  const hotspot = foundry.risks.find(r => r.code === "thick_section_hotspot_candidate");
  assert.equal(hotspot.severity, "review");
  assert.deepEqual(hotspot.threshold, { metric: "max_to_median", method: "sphere", value: 1.5, source: "3d_reader_heuristic_unvalidated" });
  assert.deepEqual(hotspot.source_ids, []);
  assert.ok(hotspot.background_source_ids.every(id => FOUNDRY_SOURCES.some(src => src.id === id)));
  const thin = foundry.risks.find(r => r.code === "thin_section_candidate");
  assert.equal(thin.severity, "review");
  assert.equal(thin.threshold.source, "3d_reader_heuristic_unvalidated");
  assert.deepEqual(thin.source_ids, []);
  assert.ok(!foundry.risks.some(r => r.severity === "high" || r.severity === "medium"));
  assert.equal(foundry.rules.filling, "not_simulated");
  assert.equal(foundry.simulation_boundary.solidification, "not_computed");
  assert.ok(foundry.sources.length >= 4);
  assert.ok(foundry.sources.every(s => FOUNDRY_SOURCES.some(src => src.id === s.id)));
});

test("thickness evidence reads each method for its own ratio, whichever method the view shows", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({
      // The view shows the ray method, whose maximum reads the length of the part.
      thickness: { method: "ray", min: 4, median: 5, max: 40, sphere: { min: 3, median: 5, max: 6 }, wall: { min: 4, median: 5, max: 8 } },
    })],
  });
  const t = semantic.bodies[0].foundry.evidence.thickness;
  assert.equal(t.min_mm, 4);
  assert.equal(t.min_method, "wall");
  assert.equal(t.median_mm, 5);
  assert.equal(t.max_mm, 6);
  assert.equal(t.median_max_method, "sphere");
  assert.equal(t.hotspot_method, "sphere");
  assert.equal(t.thin_method, "wall");
  assert.equal(t.max_to_median, 1.2);
  assert.equal(t.min_to_median, 0.8);
  assert.ok(!semantic.bodies[0].foundry.risks.some(r => r.code === "thick_section_hotspot_candidate"));
});

/** Planar faces of a plain a × b × c block, with the B-rep edges they share. */
function blockSurfaces([a, b, c]) {
  const edges = [];
  for (const y of [0, b]) for (const z of [0, c]) edges.push({ faces: [`y${y}`, `z${z}`], sig: [0, y, z, a, y, z] });
  for (const x of [0, a]) for (const z of [0, c]) edges.push({ faces: [`x${x}`, `z${z}`], sig: [x, 0, z, x, b, z] });
  for (const x of [0, a]) for (const y of [0, b]) edges.push({ faces: [`x${x}`, `y${y}`], sig: [x, y, 0, x, y, c] });
  return ["x0", `x${a}`, "y0", `y${b}`, "z0", `z${c}`].map((name, index) => (
    { index, type: "plane", edge_signatures: edges.filter(e => e.faces.includes(name)).map(e => e.sig) }
  ));
}

test("a plain block raises no core risk, and gives one setup", () => {
  const semantic = buildSemantic3D({
    file: "block.step", kind: "cad", engine: "browser",
    summary: { volume: 6000, area: 2200, bodies: 1, solids: 1 },
    bodies: [body({
      volume: 6000,
      bbox: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] },
      surface_types: { plane: 6, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0 },
      geometric_surfaces: blockSurfaces([10, 20, 30]),
    })],
  });
  const { foundry, manufacturing_plan: plan } = semantic.bodies[0];
  // Every face of a block passes the planar pocket test: not core evidence.
  assert.equal(foundry.evidence.feature_counts.pocket_candidates, 6);
  assert.ok(!foundry.risks.some(r => r.code === "core_or_undercut_review"));
  assert.equal(foundry.rules.cores, "undetermined_without_concavity_test");
  assert.equal(plan.operation_count, 6);
  assert.equal(plan.setup_count, 1);
});

test("a solid cylinder counts its cylindrical face once", () => {
  const top = [5, 0, 40, 5, 0, 40], bottom = [5, 0, 0, 5, 0, 0];
  const semantic = buildSemantic3D({
    file: "pin.step", kind: "cad", engine: "browser",
    summary: { volume: 3142, area: 1414, bodies: 1, solids: 1 },
    bodies: [body({
      volume: 3142,
      bbox: { min: [-5, -5, 0], max: [5, 5, 40], size: [10, 10, 40] },
      surface_types: { plane: 2, cylinder: 1, cone: 0, sphere: 0, torus: 0, bspline: 0 },
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 5, axis: [0, 0, 1], center_mm: [0, 0, 0], wire_count: 1, edge_count: 3, edge_signatures: [bottom, top, [5, 0, 0, 5, 0, 40]] },
        { index: 1, type: "plane", edge_signatures: [bottom] },
        { index: 2, type: "plane", edge_signatures: [top] },
      ],
    })],
  });
  const foundry = semantic.bodies[0].foundry;
  // A cylinder, a hole and a boss candidate on the same face.
  assert.ok(["cylindrical_feature_candidate", "hole_feature_candidate", "boss_feature_candidate"]
    .every(type => semantic.bodies[0].features.some(f => f.type === type && f.surface_index === 0)));
  assert.deepEqual(foundry.evidence.feature_counts, { cylindrical_opening_or_boss_candidates: 1, pocket_candidates: 0 });
  // Inside and outside are not told apart: a review, never a confirmed core.
  assert.equal(foundry.risks.find(r => r.code === "core_or_undercut_review").severity, "review");
  assert.equal(foundry.rules.cores, "undetermined_without_concavity_test");
});

test("foundry evidence carries the topology computed by the semantic layer", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body()],
  });
  const b = semantic.bodies[0];
  assert.ok(b.topology);
  assert.deepEqual(b.foundry.evidence.topology, b.topology);
});

test("open geometry is a limit of the screen, cited to no foundry source", () => {
  const semantic = buildSemantic3D({
    file: "sheet.step", kind: "cad", engine: "browser",
    summary: { volume: null, area: 24000, bodies: 1, solids: 0 },
    bodies: [body({ closed: false })],
  });
  const open = semantic.bodies[0].foundry.risks.find(r => r.code === "open_geometry");
  assert.ok(open);
  assert.deepEqual(open.source_ids, []);
});

test("does not invent draft, gating or risering results", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body()],
  });
  const foundry = semantic.bodies[0].foundry;
  assert.equal(foundry.rules.draft, "not_evaluated_without_parting_direction");
  assert.equal(foundry.rules.risering, "not_sized");
  assert.equal(foundry.rules.gating, "not_sized");
  assert.ok(foundry.required_checks.includes("run_fill_and_solidification_simulation_for_advanced_claims"));
});

test("AI context exposes foundry data for manufacturing and general reasoning", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body()],
  });
  const general = buildAIContext(semantic, { task: "general" });
  const manufacturing = buildAIContext(semantic, { task: "manufacturing_analysis" });
  assert.ok(general.bodies[0].foundry);
  assert.ok(manufacturing.bodies[0].foundry);
  assert.equal(manufacturing.reasoning_contract.foundry_geometry_screen_is_not_a_filling_or_solidification_simulation, true);
  assert.equal(manufacturing.foundry_schema_version, "1.0");
});

/** The parting of a body as the Reader gives it (web/engine/parting.js, app.js), with these changes. */
function parting(overrides = {}) {
  const line = { planar: true, kind: "planar", height_range_mm: 0, length_mm: 320, loops: 1, level_mm: 0 };
  return {
    status: "proposed", axis: "Z", direction: [0, 0, 1], source: "face_normals",
    undercut_area_mm2: 0, undercut_share: 0, zero_draft_area_mm2: 6400, zero_draft_share: 0.3478,
    projected_area_mm2: 6000, mould_height_mm: 20, parting: line, draft_angle_deg: 1,
    candidates: [], sampled: null, method: "line_of_sight_along_draw_direction_uniform_grid",
    ...overrides,
  };
}

test("a parting line proposed from the geometry: draft and cores evaluated, the direction still to confirm", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({ parting: parting() })],
  });
  const b = semantic.bodies[0];
  assert.equal(b.parting.status, "proposed");
  const { rules, risks, required_checks: checks, evidence } = b.foundry;
  assert.equal(rules.parting_line, "proposed_from_geometry");
  assert.equal(rules.draft, "evaluated_from_zero_draft_area");
  assert.equal(rules.cores, "no_undercut_for_the_chosen_axis");
  assert.equal(evidence.parting.zero_draft_area_mm2, 6400);
  assert.ok(evidence.confirmed.includes("parting_line_proposed_from_geometry"));
  assert.ok(!checks.includes("select_parting_direction"));
  assert.ok(checks.includes("confirm_proposed_parting_direction"));
  assert.ok(checks.includes("add_or_confirm_draft_on_zero_draft_faces"));
  const draft = risks.find(r => r.code === "zero_draft_faces");
  assert.match(draft.message, /^34,8 % de la surface est à moins de 1°/);
  assert.ok(!risks.some(r => r.code === "undercut_requires_core_or_slide" || r.code === "non_planar_parting_line"));
  for (const r of risks) assert.ok(r.source_ids.every(id => FOUNDRY_SOURCES.some(src => src.id === id)), r.code);
  // The AI context: compact, in every task and compacted.
  const context = buildAIContext(semantic, { task: "general" });
  assert.deepEqual(context.bodies[0].parting, { status: "proposed", axis: "Z", direction: [0, 0, 1], undercut_share: 0, zero_draft_share: 0.3478, planar: true });
  assert.deepEqual(compactAIContext(context, { maxChars: 1 }).bodies[0].parting, context.bodies[0].parting);
});

test("a stepped parting line defined by hand, with undercuts: marked manual, its cores and its line to review", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({ parting: parting({
      status: "manual", axis: "X", direction: [1, 0, 0], undercut_area_mm2: 1200, undercut_share: 0.05,
      parting: { planar: false, kind: "stepped", height_range_mm: 20, length_mm: 360, loops: 1, levels_mm: [0, 20] },
    }) })],
  });
  const { rules, risks, required_checks: checks } = semantic.bodies[0].foundry;
  assert.equal(rules.parting_line, "manual");
  assert.equal(rules.cores, "undercuts_detected");
  assert.ok(checks.includes("validate_manual_parting_line_with_tooling"));
  assert.ok(checks.includes("define_cores_or_slides_for_undercuts"));
  assert.ok(checks.includes("design_non_planar_parting_surface"));
  assert.equal(risks.find(r => r.code === "undercut_requires_core_or_slide").undercut_area_mm2, 1200);
  assert.match(risks.find(r => r.code === "non_planar_parting_line").message, /étagée, sur 20 mm/);
  const context = buildAIContext(semantic, { task: "manufacturing_analysis" });
  assert.deepEqual(context.bodies[0].parting, { status: "manual", axis: "X", direction: [1, 0, 0], undercut_share: 0.05, zero_draft_share: 0.3478, planar: false, kind: "stepped", height_range_mm: 20 });
});

/** The risers and ingate of a body as the Reader gives them (web/engine/feeding.js, app.js), with these changes. */
function feeding(overrides = {}) {
  const riser = (id, zone, position, d, h, sphere, modulus) => ({
    id, zone, position_mm: position, axis: [0, 0, 1], type: "top", open: true, offset: null, source: "proposed",
    diameter_mm: d, height_mm: h, volume_mm3: Math.round((Math.PI * d * d * h) / 4), mass_g: null,
    zone_sphere_mm: sphere, modulus_mm: modulus, riser_modulus_mm: (3 * d) / 14, reason: "isolated_hot_spot_top", why: "…",
  });
  return {
    status: "proposed", version: 1, method: "inscribed_sphere_watershed_modulus", draw_direction: [0, 0, 1], parting_known: true,
    risers: [riser("R1", 0, [52.5, 32.5, 35], 23, 35, 15, 3.93), riser("R2", 1, [10, 30, 20], 17, 26, 12, 3.01)],
    gate: {
      position_mm: [48.75, 60, 0], direction: [0, -1, 0], on_parting_line: true, outer_outline: true, zone: 0,
      wall_sphere_mm: 10.09, thickness_mm: 7, width_mm: 21, length_mm: 31.5, section_mm2: 147, volume_mm3: 4630.5, source: "proposed",
    },
    yield: { value: 0.7739, part_volume_mm3: 65625, risers_volume_mm3: 14541.6, gating_volume_mm3: 4630.5, counted: "part_risers_ingate" },
    hot_spots_without_riser: [],
    zones: [
      { id: 0, sphere_mm: 15, modulus_mm: 3.93, volume_share: 0.8, needs_riser: true, small: false, hot_spot_mm: [52.5, 32.5, 19], necks: [{ zone: 1, sphere_mm: 5 }] },
      { id: 1, sphere_mm: 12, modulus_mm: 3.01, volume_share: 0.2, needs_riser: true, small: false, hot_spot_mm: [10, 30, 10], necks: [{ zone: 0, sphere_mm: 5 }] },
    ],
    ...overrides,
  };
}

test("risers and an ingate proposed from the geometry: located, sized by a heuristic, still to validate", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({ parting: parting(), feeding: feeding() })],
  });
  const b = semantic.bodies[0];
  assert.equal(b.feeding.status, "proposed");
  const { rules, risks, required_checks: checks, evidence, simulation_boundary } = b.foundry;
  assert.equal(rules.risering, "proposed_by_modulus_heuristic");
  assert.equal(rules.gating, "proposed_on_parting_line");
  assert.equal(rules.hot_spots, "located_by_inscribed_sphere_feeding_zones");
  assert.equal(evidence.feeding.riser_count, 2);
  assert.equal(evidence.feeding.zones_needing_riser, 2);
  assert.ok(evidence.confirmed.includes("risers_proposed_from_geometry"));
  assert.ok(evidence.confirmed.includes("gate_on_parting_line"));
  assert.ok(checks.includes("validate_proposed_risers_and_gate_with_solidification_and_flow_analysis"));
  assert.ok(!checks.includes("locate_and_size_risers_after_solidification_analysis"));
  assert.ok(checks.includes("run_fill_and_solidification_simulation_for_advanced_claims"));
  assert.equal(simulation_boundary.riser_design, "heuristic_proposal_not_simulated");
  assert.ok(!risks.some(r => r.code === "hot_spot_without_riser" || r.code === "gate_off_parting_line"));
  // The AI context: each riser where it stands, its kind and size, the hot spot and modulus it feeds.
  const context = buildAIContext(semantic, { task: "general" });
  assert.deepEqual(context.bodies[0].feeding, {
    status: "proposed",
    risers: [
      { position_mm: [52.5, 32.5, 35], type: "top", diameter_mm: 23, height_mm: 35, zone_sphere_mm: 15, modulus_mm: 3.93 },
      { position_mm: [10, 30, 20], type: "top", diameter_mm: 17, height_mm: 26, zone_sphere_mm: 12, modulus_mm: 3.01 },
    ],
    gate: { position_mm: [48.8, 60, 0], direction: [0, -1, 0], section_mm2: 147, on_parting_line: true },
    yield: 0.7739,
  });
  // Compacted: counted, the largest kept.
  const compact = compactAIContext(context, { maxChars: 1 });
  assert.deepEqual(compact.bodies[0].feeding, {
    status: "proposed", riser_count: 2, largest_riser: context.bodies[0].feeding.risers[0],
    gate: { position_mm: [48.8, 60, 0], section_mm2: 147 }, yield: 0.7739,
  });
  assert.ok(compact.compaction.omitted.includes("risers one by one (counted, the largest kept)"));
  // A context that has room: the risers one by one.
  assert.deepEqual(compactAIContext(context, { maxChars: 1e6 }).bodies[0].feeding, context.bodies[0].feeding);
});

test("only the ingate placed by hand: the risers still proposed, the gating by hand", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({ feeding: feeding({ status: "manual", risers_status: "proposed", gate: { ...feeding().gate, source: "manual" } }) })],
  });
  const { rules, evidence } = semantic.bodies[0].foundry;
  assert.equal(rules.risering, "proposed_by_modulus_heuristic");
  assert.equal(rules.gating, "placed_manually");
  assert.equal(evidence.feeding.risers_status, "proposed");
  assert.ok(evidence.confirmed.includes("risers_proposed_from_geometry") && !evidence.confirmed.includes("risers_placed_manually"));
  // The AI context: the definition by hand (the ingate), its risers proposed.
  const context = buildAIContext(semantic, { task: "general" });
  assert.equal(context.bodies[0].feeding.status, "manual");
  assert.equal(context.bodies[0].feeding.risers_status, "proposed");
});

test("a riser deleted by hand: the hot spot left without one is a risk; an ingate off the parting line too", () => {
  const semantic = buildSemantic3D({
    file: "casting.step", kind: "cad", engine: "browser",
    summary: { volume: 120000, area: 24000, bodies: 1, solids: 1 },
    bodies: [body({ feeding: feeding({
      status: "manual",
      risers: feeding().risers.slice(0, 1),
      hot_spots_without_riser: [1],
      gate: { ...feeding().gate, on_parting_line: false, source: "manual" },
    }) })],
  });
  const { rules, risks, required_checks: checks, evidence } = semantic.bodies[0].foundry;
  assert.equal(rules.risering, "placed_manually");
  assert.equal(rules.gating, "placed_manually");
  assert.ok(evidence.confirmed.includes("risers_placed_manually") && !evidence.confirmed.includes("gate_on_parting_line"));
  const hot = risks.find(r => r.code === "hot_spot_without_riser");
  assert.deepEqual(hot.zones, [1]);
  assert.match(hot.message, /^1 zone\(s\) d'alimentation isolée\(s\) .* \(zones 2\) sans masselotte/);
  assert.ok(risks.some(r => r.code === "gate_off_parting_line"));
  for (const r of risks) assert.ok(r.source_ids.every(id => FOUNDRY_SOURCES.some(src => src.id === id)), r.code);
  assert.ok(checks.includes("validate_manual_risers_and_gate_with_solidification_and_flow_analysis"));
  const context = buildAIContext(semantic, { task: "manufacturing_analysis" });
  assert.equal(context.bodies[0].feeding.hot_spots_without_riser, 1);
  assert.equal(context.bodies[0].feeding.status, "manual");
});
