import test from "node:test";
import assert from "node:assert/strict";
import { buildSemantic3D } from "../../web/engine/semantic.js";
import { buildAIContext } from "../../web/engine/ai-context.js";
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
  assert.ok(foundry.risks.some(r => r.code === "thick_section_hotspot_candidate"));
  assert.equal(foundry.rules.filling, "not_simulated");
  assert.equal(foundry.simulation_boundary.solidification, "not_computed");
  assert.ok(foundry.sources.length >= 4);
  assert.ok(foundry.sources.every(s => FOUNDRY_SOURCES.some(src => src.id === s.id)));
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
