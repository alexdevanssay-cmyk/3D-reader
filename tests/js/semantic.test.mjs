import test from "node:test";
import assert from "node:assert/strict";
import { buildSemantic3D } from "../../web/engine/semantic.js";
import { buildAIContext } from "../../web/engine/ai-context.js";

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
  assert.equal(result.feature_schema_version, "9.0");
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
  assert.ok(source.includes('FEATURE_SCHEMA_VERSION = "9.0"'));
  assert.ok(source.includes('type:"fillet_feature_candidate"'));
  assert.ok(source.includes('type:"chamfer_feature_candidate"'));
  assert.ok(source.includes('type:"pattern_feature_candidate"'));
  assert.ok(source.includes('needs_topology_confirmation:true'));
});

test("semantic bodies expose analytic relations separately from inferred features", () => {
  const source = "web/engine/semantic.js";
  assert.ok(source.includes("relations:surfaceRelations("));
  assert.ok(source.includes("features:featureCandidates(body,topo,"));
});


test("links inferred features to stable analytic relation evidence", () => {
  const result = buildSemantic3D({
    file: "linked.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        {
          index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10,
          axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [],
        },
        {
          index: 1, type: "cone", ref_radius_mm: 5, semi_angle_rad: 0.2,
          axis: [0,0,1], center_mm: [0,0,2], edge_signatures: [],
        },
      ],
    })],
  });
  const relation = result.bodies[0].relations.find(
    r => r.type === "coaxial_cylinder_cone",
  );
  const feature = result.bodies[0].features.find(
    f => f.type === "tapered_feature_candidate",
  );
  assert.ok(relation?.relation_id);
  assert.deepEqual(feature?.evidence, [
    { source: "relation", relation_id: relation.relation_id },
  ]);
});

test("detects repeated equal-radius parallel cylinders as a provisional pattern", () => {
  const cylinders = [0, 20, 40].map((x, index) => ({
    index,
    type: "cylinder",
    radius_mm: 2,
    diameter_mm: 4,
    axis: [0,0,1],
    center_mm: [x,0,0],
    edge_signatures: [],
  }));
  const result = buildSemantic3D({
    file: "pattern.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: cylinders })],
  });
  const pattern = result.bodies[0].features.find(
    f => f.type === "pattern_feature_candidate",
  );
  assert.ok(pattern);
  assert.equal(pattern.subtype, "possible_linear_cylindrical_pattern");
  assert.deepEqual(pattern.surfaces, [0, 1, 2]);
  assert.equal(pattern.needs_topology_confirmation, true);
});


test("detects a conservative pocket candidate from a planar floor and shared neighbors", () => {
  const edge = (x) => [x,0,0,x,1,0];
  const result = buildSemantic3D({
    file: "pocket.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "plane", edge_signatures: [edge(0), edge(1), edge(2)] },
        { index: 1, type: "plane", edge_signatures: [edge(0)] },
        { index: 2, type: "cylinder", radius_mm: 4, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [edge(1)] },
        { index: 3, type: "plane", edge_signatures: [edge(2)] },
      ],
    })],
  });
  const pocket = result.bodies[0].features.find(f => f.type === "pocket_feature_candidate");
  assert.ok(pocket);
  assert.equal(pocket.subtype, "possible_pocket_or_recess");
  assert.equal(pocket.needs_topology_confirmation, true);
  assert.deepEqual(pocket.wall_surfaces, [1, 2, 3]);
});

test("keeps cylindrical boss detection explicitly ambiguous with bore intent", () => {
  const shared = [0,0,0, 1,0,0];
  const result = buildSemantic3D({
    file: "boss.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 6, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [shared] },
        { index: 1, type: "plane", edge_signatures: [shared] },
      ],
    })],
  });
  const boss = result.bodies[0].features.find(f => f.type === "boss_feature_candidate");
  assert.ok(boss);
  assert.equal(boss.subtype, "possible_cylindrical_boss_or_bore");
  assert.equal(boss.needs_topology_confirmation, true);
});


test("emits provisional fillet and chamfer candidates from analytic adjacency", () => {
  const e0=[0,0,0,1,0,0], e1=[0,1,0,1,1,0], e2=[0,2,0,1,2,0];
  const result = buildSemantic3D({
    file:"transitions.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:[
      {index:0,type:"torus",minor_radius_mm:2,edge_signatures:[e0,e1]},
      {index:1,type:"plane",edge_signatures:[e0]},
      {index:2,type:"cylinder",radius_mm:8,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e1]},
      {index:3,type:"cone",semi_angle_rad:0.2,ref_radius_mm:8,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e2,e0]},
      {index:4,type:"plane",edge_signatures:[e2]},
      {index:5,type:"cylinder",radius_mm:9,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e0]},
    ]})],
  });
  const features=result.bodies[0].features;
  assert.ok(features.some(f=>f.type==="fillet_feature_candidate" && f.needs_topology_confirmation));
  assert.ok(features.some(f=>f.type==="chamfer_feature_candidate" && f.needs_topology_confirmation));
});

test("adds V4 evidence quality metadata and stable feature ids", () => {
  const result = buildSemantic3D({
    file: "evidence.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      geometric_surfaces: [
        { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0],
          edge_signatures: [[0,0,0,1,0,0],[0,0,0,0,1,0]], wire_count: 2, edge_count: 2 },
        { index: 1, type: "plane", edge_signatures: [[0,0,0,1,0,0]] },
        { index: 2, type: "plane", edge_signatures: [[0,0,0,0,1,0]] },
      ],
    })],
  });
  const bodyResult = result.bodies[0];
  assert.ok(bodyResult.features.length > 0);
  assert.ok(bodyResult.features.every(f => typeof f.feature_id === "string"));
  assert.ok(bodyResult.features.every(f => ["evidenced", "provisional"].includes(f.status)));
  assert.equal(bodyResult.quality.evidence.relation_count, bodyResult.relations.length);
  assert.equal(bodyResult.quality.evidence.feature_count, bodyResult.features.length);
  assert.equal(bodyResult.quality.evidence.confidence_policy,
    "geometric_evidence_does_not_prove_design_intent");
  assert.equal(bodyResult.quality.evidence.validation_error_count, 0);
  assert.ok(bodyResult.features.every(f => /^feature-[0-9a-f]{8}$/.test(f.feature_id)));
  assert.ok(bodyResult.features.every(f => Number.isFinite(f.confidence) && f.confidence >= 0 && f.confidence <= 1));
  assert.ok(bodyResult.features.every(f => typeof f.method === "string" && f.method.length > 0));
  assert.ok(bodyResult.features.every(f => f.status !== "provisional" || f.needs_topology_confirmation === true));
  assert.ok(bodyResult.features.every(f => f.evidence_count === f.evidence.length));
});


test("adds V5 manufacturing semantics with process, setup, sequence and DFM metadata", () => {
  const result = buildSemantic3D({
    file:"manufacturing.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({
      geometric_surfaces:[
        {index:0,type:"cylinder",radius_mm:5,diameter_mm:10,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[[0,0,0,1,0,0],[0,0,0,0,1,0]],wire_count:2,edge_count:2},
        {index:1,type:"plane",edge_signatures:[[0,0,0,1,0,0]]},
        {index:2,type:"plane",edge_signatures:[[0,0,0,0,1,0]]},
      ],
      min_thickness_mm:3,
    })],
  });
  const manufacturing=result.bodies[0].manufacturing;
  assert.equal(manufacturing.schema_version,"1.0");
  assert.ok(manufacturing.process_candidates.includes("drilling"));
  assert.ok(manufacturing.operations.length>0);
  assert.ok(manufacturing.sequence.length===manufacturing.operations.length);
  assert.equal(manufacturing.sequence[0].depends_on.length,0);
  assert.ok(manufacturing.operations.every(o=>o.accessibility.status==="candidate_only"));
  assert.equal(manufacturing.functional_thickness.minimum_wall_thickness_mm,3);
  assert.equal(manufacturing.functional_thickness.status,"measured");
  assert.ok(Array.isArray(manufacturing.dfm_recommendations));
  assert.equal(result.manufacturing_schema_version,"1.0");
});


test("adds V6 deterministic manufacturing planning with setup grouping and constraints", () => {
  const result = buildSemantic3D({
    file:"plan.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({
      geometric_surfaces:[
        {index:0,type:"cylinder",radius_mm:2,diameter_mm:4,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[]},
        {index:1,type:"cylinder",radius_mm:2,diameter_mm:4,axis:[1,0,0],center_mm:[20,0,0],edge_signatures:[]},
      ],
    })],
  });
  const plan=result.bodies[0].manufacturing_plan;
  assert.equal(plan.schema_version,"1.0");
  assert.equal(result.manufacturing_planning_schema_version,"1.0");
  assert.equal(plan.operation_count,result.bodies[0].manufacturing.operations.length);
  assert.equal(plan.setup_count,2);
  assert.equal(plan.setups.length,2);
  assert.ok(plan.setups.every(s=>s.status==="candidate_with_constraints"));
  assert.ok(plan.setups.every(s=>s.unresolved_constraints.includes("stock_fixture_access_not_verified")));
  assert.equal(plan.planned_order.length,plan.operation_count);
  assert.ok(plan.dependencies.length >= 1);
  assert.equal(plan.constraints.collision_check,"not_performed");
  assert.equal(plan.constraints.machine_kinematics,"not_analyzed");
  assert.equal(plan.readiness.status,"needs_review");
  assert.ok(plan.readiness.unresolved_constraints.includes("stock_fixture_access_not_verified"));
});

test("keeps V6 planning deterministic across repeated semantic builds", () => {
  const input={
    file:"deterministic.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({
      geometric_surfaces:[
        {index:0,type:"cylinder",radius_mm:2,diameter_mm:4,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[]},
        {index:1,type:"cylinder",radius_mm:3,diameter_mm:6,axis:[0,0,1],center_mm:[10,0,0],edge_signatures:[]},
      ],
    })],
  };
  const a=buildSemantic3D(input);
  const b=buildSemantic3D(input);
  assert.deepEqual(a.bodies[0].manufacturing_plan,b.bodies[0].manufacturing_plan);
});


test("builds deterministic V7 AI reasoning context with provenance and uncertainty", () => {
  const semantic = buildSemantic3D({
    file: "ai.step", kind: "cad", engine: "browser", source_unit: "mm",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [
      { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], wire_count: 2, edge_count: 2, edge_signatures: [] },
    ] })],
  });
  const a = buildAIContext(semantic, { task: "manufacturing_analysis" });
  const b = buildAIContext(semantic, { task: "manufacturing_analysis" });
  assert.deepEqual(a, b);
  assert.equal(a.schema, "3d-ai-reasoning-context");
  assert.equal(a.schema_version, "1.0");
  assert.equal(a.task, "manufacturing_analysis");
  assert.equal(a.reasoning_contract.use_only_provided_geometry, true);
  assert.ok(a.bodies[0].features.every(f => "feature_id" in f && "evidence" in f && "status" in f));
  assert.ok(a.uncertainty.provisional_feature_count >= 1);
});

test("supports focused feature reasoning without losing provenance", () => {
  const semantic = buildSemantic3D({
    file: "focus.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [
      { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [] },
    ] })],
  });
  const feature = semantic.bodies[0].features.find(f => f.feature_id);
  const context = buildAIContext(semantic, { task: "feature_analysis", featureIds: [feature.feature_id] });
  assert.deepEqual(context.focus.feature_ids, [feature.feature_id]);
  assert.equal(context.focus.selected_feature_count, 1);
  assert.equal(context.bodies[0].features.length, 1);
  assert.equal(context.bodies[0].features[0].feature_id, feature.feature_id);
  assert.equal(context.bodies[0].features[0].evidence_count, feature.evidence_count);
});
