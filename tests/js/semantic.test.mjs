import test from "node:test";
import assert from "node:assert/strict";
import { buildSemantic3D } from "../../web/engine/semantic.js";

function body(overrides = {}) {
  return {
    name: "Housing",
    method: "brep",
    closed: true,
    volume: 1000,
    area: 600,
    mass: 2.7,
    centroid: [5, 5, 5],
    bbox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] },
    surface_types: { plane: 2, cylinder: 1, cone: 0, sphere: 0, torus: 0, bspline: 0 },
    mesh: {
      positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      indices: new Uint32Array([0,1,2]),
    },
    geometric_surfaces: [],
    notes: [],
    ...overrides,
  };
}

test("builds the versioned semantic contract without changing the raw result", () => {
  const result = buildSemantic3D({
    file: "part.step",
    kind: "cad",
    source_unit: "mm",
    engine: "browser",
    density: 2.7,
    summary: {
      volume: 1000,
      area: 600,
      mass: 2.7,
      centroid: [5, 5, 5],
      bbox: { min: [0,0,0], max: [10,10,10], size: [10,10,10] },
      obb: { size: [10,10,10], volume: 1000 },
      fill_ratio: 1,
      bodies: 1,
      solids: 1,
      open_bodies: 0,
    },
    bodies: [body()],
  });

  assert.equal(result.schema, "3d-semantic-json");
  assert.equal(result.schema_version, "1.0");
  assert.equal(result.feature_schema_version, "6.0");
  assert.equal(result.model.body_count, 1);
  assert.equal(result.bodies[0].metrics.volume_mm3, 1000);
  assert.deepEqual(result.bodies[0].topology, {
    vertices: 3,
    triangles: 1,
    unique_edges: 3,
    boundary_edges: 3,
    non_manifold_edges: 0,
    degenerate_triangles: 0,
    watertight: false,
  });
  assert.equal("positions" in result.bodies[0], false);
  assert.equal("indices" in result.bodies[0], false);
});

test("detects cylindrical passage evidence from shared B-Rep edge signatures", () => {
  const sharedA = [0,0,0, 1,0,0];
  const sharedB = [0,0,0, 0,1,0];
  const result = buildSemantic3D({
    file: "hole.step",
    kind: "cad",
    engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        {
          index: 0,
          type: "cylinder",
          radius_mm: 5,
          diameter_mm: 10,
          axis: [0,0,1],
          center_mm: [0,0,0],
          wire_count: 2,
          edge_count: 2,
          edge_signatures: [sharedA, sharedB],
        },
        {
          index: 1,
          type: "plane",
          center_mm: [0,0,0],
          edge_signatures: [sharedA],
        },
        {
          index: 2,
          type: "plane",
          center_mm: [0,0,10],
          edge_signatures: [sharedB],
        },
      ],
    })],
  });

  const features = result.bodies[0].features;
  const hole = features.find(f => f.type === "hole_feature_candidate");
  assert.ok(hole);
  assert.equal(hole.subtype, "possible_through_hole_or_bore");
  assert.deepEqual(hole.boundary_planes, [1, 2]);
  assert.equal(hole.needs_topology_confirmation, true);

  const relation = features.find(f => f.type === "cylindrical_boundary_relation");
  assert.ok(relation);
  assert.equal(relation.needs_topology_confirmation, false);
});

test("reports coaxial cylinders with different radii as a stepped-feature candidate", () => {
  const result = buildSemantic3D({
    file: "step.step",
    kind: "cad",
    engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [] },
        { index: 1, type: "cylinder", radius_mm: 8, diameter_mm: 16, axis: [0,0,1], center_mm: [0,0,5], edge_signatures: [] },
      ],
    })],
  });

  const feature = result.bodies[0].features.find(
    f => f.type === "stepped_cylindrical_feature_candidate",
  );
  assert.ok(feature);
  assert.equal(feature.subtype, "possible_counterbore_or_coaxial_step");
  assert.deepEqual(feature.relation.radii_mm, [5, 8]);
});

test("emits a provisional tapered-feature candidate from coaxial cylinder/cone evidence", () => {
  const result = buildSemantic3D({
    file: "taper.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [] },
        { index: 1, type: "cone", ref_radius_mm: 5, semi_angle_rad: 0.25, axis: [0,0,1], center_mm: [0,0,2], edge_signatures: [] },
      ],
    })],
  });
  const feature = result.bodies[0].features.find(f => f.type === "tapered_feature_candidate");
  assert.ok(feature);
  assert.equal(feature.subtype, "possible_countersink_or_taper");
  assert.equal(feature.needs_topology_confirmation, true);
});

test("keeps feature intent provisional even when analytic evidence is strong", () => {
  const result = buildSemantic3D({
    file: "bore.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], wire_count: 2, edge_count: 2, edge_signatures: [] },
      ],
    })],
  });
  const candidate = result.bodies[0].features.find(f => f.type === "cylindrical_feature_candidate");
  assert.ok(candidate);
  assert.equal(candidate.needs_topology_confirmation, true);
});

test("feature schema advances with conservative blend/chamfer/pattern candidates", () => {
  const source = "web/engine/semantic.js";
  assert.ok(source.includes('FEATURE_SCHEMA_VERSION = "6.0"'));
  assert.ok(source.includes('type:"fillet_feature_candidate"'));
  assert.ok(source.includes('type:"chamfer_feature_candidate"'));
  assert.ok(source.includes('type:"pattern_feature_candidate"'));
  assert.ok(source.includes('needs_topology_confirmation:true'));
});

test("semantic bodies expose analytic relations separately from inferred features", () => {
  const source = "web/engine/semantic.js";
  assert.ok(source.includes("relations:cylindricalRelations("));
  assert.ok(source.includes("features:featureCandidates(body,topo)"));
});
