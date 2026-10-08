import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSemantic3D } from "../../web/engine/semantic.js";
import { buildAIContext, compactAIContext } from "../../web/engine/ai-context.js";

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
  assert.deepEqual(feature.radii_mm, [5, 8]);
  // Traceable to its faces and its relation, in the AI context too.
  const relation = result.bodies[0].relations.find(r => r.type === "coaxial_cylinder_step");
  assert.deepEqual(feature.surfaces, [0, 1]);
  assert.deepEqual(feature.evidence, [{ source: "relation", relation_id: relation.relation_id }]);
  assert.equal("relation" in feature, false);
  const context = buildAIContext(result, { task: "feature_analysis" });
  const inContext = context.bodies[0].features.find(f => f.feature_id === feature.feature_id);
  assert.deepEqual(inContext.geometry, { surfaces: [0, 1], radii_mm: [5, 8] });
  assert.equal(inContext.evidence_count, 1);
});

test("many coaxial faces are related to their neighbours along the axis, a few pairwise", () => {
  // A turned shaft of 40 sections (Ø10 / Ø16 alternately) placed from one
  // origin, listed out of order: only their edges tell where each one is.
  const position = (i) => (i * 7) % 40;
  const section = (i) => {
    const r = position(i) % 2 ? 8 : 5, z0 = position(i) * 10, z1 = z0 + 10;
    return { index: i, type: "cylinder", radius_mm: r, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [[r,0,z0,r,0,z0], [r,0,z1,r,0,z1]] };
  };
  // And a counterbored hole along X, split in two halves: three faces, related pairwise.
  const hole = [
    { index: 40, type: "cylinder", radius_mm: 3, axis: [1,0,0], center_mm: [0,100,0], edge_signatures: [] },
    { index: 41, type: "cylinder", radius_mm: 3, axis: [-1,0,0], center_mm: [5,100,0], edge_signatures: [] },
    { index: 42, type: "cylinder", radius_mm: 6, axis: [1,0,0], center_mm: [0,100,0], edge_signatures: [] },
  ];
  const result = buildSemantic3D({
    file: "shaft.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [...Array.from({ length: 40 }, (_, i) => section(i)), ...hole] })],
  });
  const coaxial = result.bodies[0].relations.filter(r => r.type === "coaxial_cylinders" || r.type === "coaxial_cylinder_step");
  const shaft = coaxial.filter(r => r.surfaces[0] < 40);
  assert.equal(shaft.length, 39);
  assert.ok(shaft.every(r => r.type === "coaxial_cylinder_step" && Math.abs(position(r.surfaces[0]) - position(r.surfaces[1])) === 1));
  assert.deepEqual(coaxial.filter(r => r.surfaces[0] >= 40).map(r => [r.type, r.surfaces]), [
    ["coaxial_cylinders", [40, 41]],
    ["coaxial_cylinder_step", [40, 42]],
    ["coaxial_cylinder_step", [41, 42]],
  ]);
  // Features and operations grow with the faces, not with their pairs.
  assert.ok(result.bodies[0].features.length < 4 * 43);
  assert.ok(result.bodies[0].manufacturing.operations.length < 3 * 43);
});

test("a plate with many parallel holes gives one pattern and no pairwise relation", () => {
  const holes = Array.from({ length: 2500 }, (_, i) => ({
    index: i, type: "cylinder", radius_mm: 2, axis: [0,0,1], center_mm: [(i % 50) * 6, Math.floor(i / 50) * 6, 0], edge_signatures: [],
  }));
  const result = buildSemantic3D({
    file: "plate.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ bbox: { min: [0,0,0], max: [300,300,10], size: [300,300,10] }, geometric_surfaces: holes })],
  });
  const plate = result.bodies[0];
  assert.deepEqual(plate.relations, []);
  const patterns = plate.features.filter(f => f.type === "pattern_feature_candidate");
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].surfaces.length, 2500);
  assert.equal(patterns[0].diameter_mm, 4);
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

const SEMANTIC_SOURCE = readFileSync(new URL("../../web/engine/semantic.js", import.meta.url), "utf8");

test("feature schema advances with conservative blend/chamfer/pattern candidates", () => {
  const source = SEMANTIC_SOURCE;
  assert.ok(source.includes('FEATURE_SCHEMA_VERSION = "9.0"'));
  assert.ok(source.includes('type:"fillet_feature_candidate"'));
  assert.ok(source.includes('type:"chamfer_feature_candidate"'));
  assert.ok(source.includes('type:"pattern_feature_candidate"'));
  assert.ok(source.includes('needs_topology_confirmation:true'));
});

test("semantic bodies expose analytic relations separately from inferred features", () => {
  const result = buildSemantic3D({
    file: "relations.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [
      { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [] },
      { index: 1, type: "cylinder", radius_mm: 8, diameter_mm: 16, axis: [0,0,1], center_mm: [0,0,5], edge_signatures: [] },
    ] })],
  });
  const semanticBody = result.bodies[0];
  assert.ok(semanticBody.relations.length > 0);
  assert.ok(semanticBody.relations.every(r => /^body-0\/relation-\d+$/.test(r.relation_id) && !("feature_id" in r)));
  assert.ok(semanticBody.features.every(f => /^body-0\/feature-[0-9a-f]{8}$/.test(f.feature_id) && !("relation_id" in f)));
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

test("one pattern per direction and radius: unrelated cylinders are not merged", () => {
  const cylinder = (index, radius_mm, axis, center_mm) => ({ index, type: "cylinder", radius_mm, axis, center_mm, edge_signatures: [] });
  const patterns = (surfaces) => buildSemantic3D({
    file: "patterns.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: surfaces })],
  }).bodies[0].features.filter(f => f.type === "pattern_feature_candidate");
  // Two Ø4 holes along Z and two Ø10 holes along X: two pairs, no pattern.
  assert.deepEqual(patterns([
    cylinder(0, 2, [0,0,1], [0,0,0]), cylinder(1, 2, [0,0,1], [20,0,0]),
    cylinder(2, 5, [1,0,0], [0,50,0]), cylinder(3, 5, [1,0,0], [0,100,0]),
  ]), []);
  // Three of each (one Ø10 axis given the other way): two patterns, each with its own diameter and axis.
  const found = patterns([
    cylinder(0, 2, [0,0,1], [0,0,0]), cylinder(1, 2, [0,0,1], [20,0,0]), cylinder(2, 2, [0,0,1], [40,0,0]),
    cylinder(3, 5, [1,0,0], [0,50,0]), cylinder(4, 5, [-1,0,0], [0,100,0]), cylinder(5, 5, [1,0,0], [0,150,0]),
  ]);
  assert.deepEqual(found.map(p => [p.surfaces, p.diameter_mm, p.subtype]), [
    [[0, 1, 2], 4, "possible_linear_cylindrical_pattern"],
    [[3, 4, 5], 10, "possible_linear_cylindrical_pattern"],
  ]);
  assert.deepEqual(found[0].axes, [[0,0,1], [0,0,1], [0,0,1]]);
  // The sections of one shaft are coaxial, not a repetition.
  assert.deepEqual(patterns([0, 30, 60].map((z, i) => cylinder(i, 5, [0,0,1], [0,0,z]))), []);
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

test("a face on the body's envelope is not a pocket floor: a plain cube has no pocket", () => {
  // A 10 mm cube as cad.js describes it: six planes (normal, point) sharing their edges.
  const P = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
  const edge = (i, j) => [P[i], P[j]].sort((a, b) => a.join(",").localeCompare(b.join(","))).flat();
  const faces = [
    [[0,0,1], [0,0,0], [[0,1],[1,2],[2,3],[3,0]]], [[0,0,1], [0,0,10], [[4,5],[5,6],[6,7],[7,4]]],
    [[0,1,0], [0,0,0], [[0,1],[1,5],[5,4],[4,0]]], [[0,-1,0], [0,10,0], [[3,2],[2,6],[6,7],[7,3]]],
    [[1,0,0], [0,0,0], [[0,3],[3,7],[7,4],[4,0]]], [[1,0,0], [10,5,5], [[1,2],[2,6],[6,5],[5,1]]],
  ];
  const semantic = buildSemantic3D({
    file: "cube.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({
      surface_types: { plane: 6 },
      geometric_surfaces: faces.map(([normal, center_mm, edges], index) => ({ index, type: "plane", normal, center_mm, edge_signatures: edges.map(([i, j]) => edge(i, j)) })),
    })],
  });
  const cube = semantic.bodies[0];
  assert.equal(cube.features.filter(f => f.type === "pocket_feature_candidate").length, 0);
  assert.deepEqual(cube.manufacturing.operations, []);
  assert.equal(cube.foundry.rules.cores, "not_detected");

  // A floor inside the box, between its top and bottom, stays a recess candidate.
  const edgeX = (x) => [x,0,5,x,1,5];
  const recess = buildSemantic3D({
    file: "recess.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [
      { index: 0, type: "plane", normal: [0,0,1], center_mm: [0,0,5], edge_signatures: [edgeX(2), edgeX(4), edgeX(6)] },
      { index: 1, type: "plane", normal: [1,0,0], center_mm: [2,0,0], edge_signatures: [edgeX(2)] },
      { index: 2, type: "plane", normal: [0,1,0], center_mm: [0,1,0], edge_signatures: [edgeX(4)] },
      { index: 3, type: "plane", normal: [1,0,0], center_mm: [6,0,0], edge_signatures: [edgeX(6)] },
    ] })],
  });
  const pocket = recess.bodies[0].features.find(f => f.type === "pocket_feature_candidate");
  assert.equal(pocket?.floor_surface, 0);
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

test("a rounded edge is a fillet, not a hole, a bore or a boss", () => {
  // 100 x 100 x 10 block, its vertical edge at x = y = 100 rounded R5: a quarter
  // cylinder (no seam) tangent to the side planes x = 100 and y = 100.
  const lineX=[100,95,0,100,95,10], lineY=[95,100,0,95,100,10], arcBottom=[100,95,0,95,100,0], arcTop=[100,95,10,95,100,10];
  const block = (cylinder) => buildSemantic3D({
    file:"rounded.step", kind:"cad", engine:"browser",
    summary:{volume:99000,area:24000,bodies:1,solids:1},
    bodies:[body({
      bbox:{min:[0,0,0],max:[100,100,10],size:[100,100,10]},
      geometric_surfaces:[
        cylinder,
        {index:1,type:"plane",normal:[1,0,0],center_mm:[100,0,0],edge_signatures:[lineX]},
        {index:2,type:"plane",normal:[0,1,0],center_mm:[0,100,0],edge_signatures:[lineY]},
        {index:3,type:"plane",normal:[0,0,1],center_mm:[0,0,0],edge_signatures:[arcBottom]},
        {index:4,type:"plane",normal:[0,0,1],center_mm:[0,0,10],edge_signatures:[arcTop]},
      ],
    })],
  }).bodies[0];
  const rounded = block({index:0,type:"cylinder",radius_mm:5,axis:[0,0,1],center_mm:[95,95,0],wire_count:1,edge_count:4,edge_signatures:[lineX,arcTop,lineY,arcBottom]});
  const onFace = rounded.features.filter(f=>f.surface_index===0).map(f=>`${f.type}/${f.subtype ?? ""}`);
  assert.deepEqual(onFace, ["fillet_feature_candidate/possible_cylindrical_fillet_or_blend", "cylindrical_boundary_relation/"]);
  assert.equal(rounded.features.find(f=>f.type==="fillet_feature_candidate").radius_mm, 5);
  assert.deepEqual(rounded.manufacturing.operations.map(o=>o.operation), ["fillet_or_blend_finishing"]);
  assert.equal(rounded.foundry.rules.cores, "not_detected");

  // A full turn (its seam edge met twice) is not a blend, whatever its neighbours.
  const seam=[100,95,0,100,95,10];
  const turn = block({index:0,type:"cylinder",radius_mm:5,axis:[0,0,1],center_mm:[95,95,0],wire_count:1,edge_count:4,edge_signatures:[arcTop,seam,arcBottom,seam]});
  assert.ok(turn.features.some(f=>f.type==="hole_feature_candidate" && f.surface_index===0));
  assert.ok(!turn.features.some(f=>f.subtype==="possible_cylindrical_fillet_or_blend"));
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
  assert.ok(bodyResult.features.every(f => /^body-0\/feature-[0-9a-f]{8}$/.test(f.feature_id)));
  assert.ok(bodyResult.features.every(f => Number.isFinite(f.confidence) && f.confidence >= 0 && f.confidence <= 1));
  assert.ok(bodyResult.features.every(f => typeof f.method === "string" && f.method.length > 0));
  assert.ok(bodyResult.features.every(f => f.status !== "provisional" || f.needs_topology_confirmation === true));
  assert.ok(bodyResult.features.every(f => f.evidence_count === f.evidence.length));
});

test("two features whose 32-bit hashes collide still get distinct ids", () => {
  // The identities of the cylinders of faces 497218 and 1011446 hash to the same value.
  const cylinder = (index, x) => ({ index, type: "cylinder", radius_mm: 1, axis: [0,0,1], center_mm: [x,0,0], edge_signatures: [] });
  const result = buildSemantic3D({
    file: "collision.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [cylinder(497218, 0), cylinder(1011446, 20)] })],
  });
  const ids = result.bodies[0].features.filter(f => f.type === "cylindrical_feature_candidate").map(f => f.feature_id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], "body-0/feature-9694d94b");
  assert.notEqual(ids[1], ids[0]);
  assert.match(ids[1], /^body-0\/feature-[0-9a-f]{8}$/);
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

test("one hole is drilled once: the features reading the same face share its operation", () => {
  const top=[2,0,10,2,0,10], bottom=[2,0,0,2,0,0];
  const result = buildSemantic3D({
    file:"hole.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:[
      // As cad.js gives a full cylinder: one wire, two circles and the seam met twice.
      {index:0,type:"cylinder",radius_mm:2,axis:[0,0,1],center_mm:[0,0,0],wire_count:1,edge_count:4,edge_signatures:[top,[2,0,0,2,0,10],bottom,[2,0,0,2,0,10]]},
      {index:1,type:"plane",normal:[0,0,1],center_mm:[0,0,0],edge_signatures:[bottom]},
      {index:2,type:"plane",normal:[0,0,1],center_mm:[0,0,10],edge_signatures:[top]},
    ] })],
  });
  const {features, manufacturing} = result.bodies[0];
  const cylinder = features.find(f=>f.type==="cylindrical_feature_candidate");
  const hole = features.find(f=>f.type==="hole_feature_candidate");
  assert.equal(cylinder.subtype, "possible_bore");
  // The hole, and the boss it may also be (no inside/outside test), not three operations.
  assert.deepEqual(manufacturing.operations.map(o=>o.operation), ["boss_milling_or_bore", "drilling"]);
  const drilling = manufacturing.operations.find(o=>o.operation==="drilling");
  assert.deepEqual(drilling.feature_ids, [cylinder.feature_id, hole.feature_id]);
  assert.equal(drilling.confidence, Math.max(cylinder.confidence, hole.confidence));
  assert.equal(manufacturing.sequence.length, 2);
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
  // Two drillings of the same precedence on independent axes: no dependency is invented.
  assert.deepEqual(plan.dependencies, []);
  assert.equal(plan.readiness.dependency_count, 0);
  assert.equal(plan.constraints.collision_check,"not_performed");
  assert.equal(plan.constraints.machine_kinematics,"not_analyzed");
  assert.equal(plan.readiness.status,"needs_review");
  assert.ok(plan.readiness.unresolved_constraints.includes("stock_fixture_access_not_verified"));
});

test("V6 planning links operations of different precedence", () => {
  const result = buildSemantic3D({
    file:"countersink.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:[
      {index:0,type:"cylinder",radius_mm:5,diameter_mm:10,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[]},
      {index:1,type:"cone",ref_radius_mm:5,semi_angle_rad:0.25,axis:[0,0,1],center_mm:[0,0,2],edge_signatures:[]},
    ] })],
  });
  const plan=result.bodies[0].manufacturing_plan;
  assert.ok(plan.dependencies.some(d=>d.reason==="manufacturing_precedence"));
  assert.ok(plan.dependencies.every(d=>d.resolvable));
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

test("feature, relation and operation ids are unique across bodies", () => {
  // Two identical bodies: their surface indices, hence their features, are the same.
  const surfaces = [
    { index: 0, type: "cylinder", radius_mm: 5, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [] },
    { index: 1, type: "cylinder", radius_mm: 8, axis: [0,0,1], center_mm: [0,0,5], edge_signatures: [] },
  ];
  const semantic = buildSemantic3D({
    file: "twins.step", kind: "cad", engine: "browser",
    summary: { volume: 2000, area: 1200, bodies: 2, solids: 2 },
    bodies: [body({ geometric_surfaces: surfaces }), body({ geometric_surfaces: surfaces })],
  });
  const [first, second] = semantic.bodies;
  const unique = (list) => assert.equal(new Set(list).size, list.length);
  unique([...first.features, ...second.features].map(f => f.feature_id));
  unique([...first.relations, ...second.relations].map(r => r.relation_id));
  unique([...first.manufacturing.operations, ...second.manufacturing.operations].map(o => o.operation_id));
  assert.ok(second.features.every(f => f.feature_id.startsWith("body-1/feature-")));
  assert.ok(second.relations.every(r => r.relation_id.startsWith("body-1/relation-")));

  // Focusing on a feature of the first body selects that one only.
  const id = first.features.find(f => f.type === "cylindrical_feature_candidate").feature_id;
  const focused = buildAIContext(semantic, { task: "feature_analysis", featureIds: [id] });
  assert.equal(focused.focus.selected_feature_count, 1);
  assert.deepEqual(focused.bodies.map(b => b.features.map(f => f.feature_id)), [[id], []]);
  assert.ok(!focused.warnings.includes("some_requested_features_not_found"));
  // A missing id is reported, even when the other ids are found.
  const missing = buildAIContext(semantic, { task: "feature_analysis", featureIds: [id, "feature-missing"] });
  assert.equal(missing.focus.selected_feature_count, 1);
  assert.ok(missing.warnings.includes("some_requested_features_not_found"));
  // The same id asked twice is no missing feature.
  const twice = buildAIContext(semantic, { task: "feature_analysis", featureIds: [id, id] });
  assert.ok(!twice.warnings.includes("some_requested_features_not_found"));
});

test("the compacted AI context of a large assembly fits the budget of a local model", () => {
  const count = 300;
  const bodies = Array.from({ length: count }, (_, i) => body({
    name: `Body ${i}`,
    volume: 1000 + i,
    notes: ["Solid rebuilt by sewing the surfaces of the file"],
    geometric_surfaces: [
      { index: 0, type: "cylinder", radius_mm: 5, diameter_mm: 10, axis: [0,0,1], center_mm: [i,0,0], wire_count: 2, edge_count: 2, edge_signatures: [] },
    ],
  }));
  const semantic = buildSemantic3D({
    file: "assembly.step", kind: "cad", engine: "browser", source_unit: "mm",
    summary: { volume: 300000, area: 180000, bodies: count, solids: count },
    bodies,
  });
  const context = buildAIContext(semantic, { task: "manufacturing_analysis" });
  const compact = compactAIContext(context, { maxChars: 12000 });
  assert.ok(JSON.stringify(compact).length <= 12000, `${JSON.stringify(compact).length} characters`);
  assert.equal(compact.compaction.level, 5);
  assert.equal(compact.compaction.original_body_count, count);
  // The largest bodies are listed, the others counted.
  assert.equal(compact.bodies.length + compact.other_bodies.count, count);
  assert.equal(compact.bodies[0].metrics.volume_mm3, 1000 + count - 1);
  assert.ok(compact.warnings.length <= 5);
});
