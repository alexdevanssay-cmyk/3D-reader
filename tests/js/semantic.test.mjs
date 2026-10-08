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
  assert.equal(result.feature_schema_version, "10.0");
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

test("the topology of a mesh whose faces have their own vertices (CAD, STL) is that of its surface", () => {
  // A tetrahedron, each face with its own 3 vertices, plus a triangle with two
  // corners at the same point (as at the pole of a CAD sphere).
  const [a, b, c, d] = [[0,0,0], [1,0,0], [0,1,0], [0,0,1]];
  const triangles = [[a,c,b], [a,b,d], [a,d,c], [b,c,d], [a,a,b]];
  const result = buildSemantic3D({
    bodies: [body({ mesh: { positions: new Float32Array(triangles.flat(2)), indices: Uint32Array.from(triangles.flat(), (_, i) => i) } })],
  });
  assert.deepEqual(result.bodies[0].topology, {
    vertices: 4,
    triangles: 5,
    unique_edges: 6,
    boundary_edges: 0,
    non_manifold_edges: 0,
    degenerate_triangles: 1,
    watertight: true,
  });
  assert.ok(result.bodies[0].features.some(f => f.type === "closed_solid"));
});

test("bodies as the page gives them: topology without a mesh, index in the Reader result", () => {
  // app.js gives the bodies checked (here the second and the fourth of the
  // file) without their meshes, with the topology of each.
  const watertight = { vertices: 8, triangles: 12, unique_edges: 18, boundary_edges: 0, non_manifold_edges: 0, degenerate_triangles: 0, watertight: true };
  const nonManifold = { ...watertight, unique_edges: 19, non_manifold_edges: 1, watertight: false };
  const { mesh, ...meshless } = body();
  const result = buildSemantic3D({
    file: "assembly.step",
    kind: "cad",
    summary: { volume: 2000, bodies: 2 },
    bodies: [
      { ...meshless, source_index: 1, topology: watertight },
      { ...meshless, name: "Bracket", source_index: 3, topology: nonManifold },
    ],
  });
  const [housing, bracket] = result.bodies;
  assert.deepEqual([housing.id, housing.source_index, bracket.id, bracket.source_index], ["body-1", 1, "body-3", 3]);
  assert.deepEqual(housing.topology, watertight);
  assert.ok(housing.features.some(f => f.type === "closed_solid"));
  assert.ok(!housing.manufacturing.dfm_recommendations.some(d => d.code === "non_manifold_geometry"));
  assert.ok(bracket.manufacturing.dfm_recommendations.some(d => d.code === "non_manifold_geometry"));
  // Without an index: the position in the list (a result with all its bodies).
  assert.equal(buildSemantic3D({ bodies: [meshless] }).bodies[0].source_index, 0);
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

test("two boundary circles promote only a cylinder with the material outside it, and never confirm a through hole", () => {
  // Each cylinder bounded by two circles (no seam), long for its diameter: a
  // hole (reversed), a pin or a boss (forward), and orientations not known (an
  // older result: the embind enum as {} or a number).
  const cylinder = (index, orientation) => ({ index, type: "cylinder", radius_mm: 2, axis: [0,0,1], center_mm: [2+2*index,5,5], orientation, wire_count: 1, edge_count: 2, edge_signatures: [] });
  const result = buildSemantic3D({
    bodies: [body({ geometric_surfaces: [cylinder(0, "reversed"), cylinder(1, "forward"), cylinder(2, {}), cylinder(3, 1)] })],
  });
  const candidates = result.bodies[0].features.filter(f => f.type === "cylindrical_feature_candidate");
  assert.deepEqual(candidates.map(f => [f.surface_index, f.subtype, f.confidence]), [
    [0, "possible_through_hole", 0.86],
    [1, "possible_bore", 0.72],
    [2, "possible_bore", 0.72],
    [3, "possible_bore", 0.72],
  ]);
  // Two circles also bound a blind hole: still to be confirmed.
  assert.ok(candidates.every(f => f.needs_topology_confirmation === true && f.status === "provisional"));
});

test("a watertight mesh without analytic surfaces keeps the advice not to assume a process", () => {
  // A tetrahedron from a mesh file: a closed solid, nothing known of how it is made.
  const [a, b, c, d] = [[0,0,0], [1,0,0], [0,1,0], [0,0,1]];
  const triangles = [[a,c,b], [a,b,d], [a,d,c], [b,c,d]];
  const result = buildSemantic3D({
    bodies: [body({
      method: "mesh",
      surface_types: null,
      mesh: { positions: new Float32Array(triangles.flat(2)), indices: Uint32Array.from(triangles.flat(), (_, i) => i) },
    })],
  });
  const [solid] = result.bodies;
  assert.ok(solid.features.some(f => f.type === "closed_solid"));
  assert.deepEqual(solid.manufacturing.dfm_recommendations.map(r => r.code), ["no_machining_feature_detected"]);
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

test("on a long shaft, a shoulder with a chamfer is still a step", () => {
  // Five diameters, a chamfer (a cone) on each shoulder, every face split in
  // two halves: 18 faces on one axis, more than are related pairwise.
  const radii = [5, 7, 9, 7, 5];
  const faces = [];
  const add = (face, z0, z1, r0, r1) => {
    for (const side of [1, -1]) {
      faces.push({ ...face, index: faces.length, axis: [0,0,1], center_mm: [0,0,0], edge_signatures: [[side*r0,0,z0,side*r0,0,z0], [side*r1,0,z1,side*r1,0,z1]] });
    }
  };
  radii.forEach((r, i) => {
    add({ type: "cylinder", radius_mm: r }, 11 * i, 11 * i + 10, r, r);
    if (i + 1 < radii.length) add({ type: "cone", ref_radius_mm: Math.min(r, radii[i + 1]), semi_angle_rad: Math.PI / 4 }, 11 * i + 10, 11 * i + 11, r, radii[i + 1]);
  });
  assert.equal(faces.length, 18);
  const result = buildSemantic3D({
    file: "shaft.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: faces })],
  });
  const relations = result.bodies[0].relations;
  // One step per shoulder, across its chamfer; the two halves of each diameter coaxial.
  assert.deepEqual(relations.filter(r => r.type === "coaxial_cylinder_step").map(r => [r.surfaces, r.radii_mm]), [
    [[1, 4], [5, 7]],
    [[5, 8], [7, 9]],
    [[9, 12], [9, 7]],
    [[13, 16], [7, 5]],
  ]);
  assert.equal(relations.filter(r => r.type === "coaxial_cylinders").length, 5);
  assert.equal(result.bodies[0].features.filter(f => f.subtype === "possible_counterbore_or_coaxial_step" && f.type === "stepped_cylindrical_feature_candidate").length, 4);
});

test("inch dimensions a few bits apart still give coaxial faces and one hole pattern", () => {
  // A counterbored hole at x = 3/8" = 9.525 mm, a rounding boundary of the
  // axis buckets (0.01 mm), its faces' positions given a few bits apart.
  assert.notEqual(0.375 * 25.4, 9.525);
  const counterbore = buildSemantic3D({
    file: "inch.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: [
      { index: 0, type: "cylinder", radius_mm: 3, axis: [0,0,1], center_mm: [9.525, 3.175, 0], edge_signatures: [] },
      { index: 1, type: "cylinder", radius_mm: 5, axis: [0,0,1], center_mm: [0.375 * 25.4, 3.175, 15], edge_signatures: [] },
      { index: 2, type: "cone", ref_radius_mm: 3, semi_angle_rad: 0.78, axis: [0,0,-1], center_mm: [0.375 * 25.4, 3.175, 20], edge_signatures: [] },
    ] })],
  });
  assert.deepEqual(counterbore.bodies[0].relations.map(r => [r.type, r.surfaces]), [
    ["coaxial_cylinder_step", [0, 1]],
    ["coaxial_cylinder_cone", [0, 2]],
    ["coaxial_cylinder_cone", [1, 2]],
  ]);

  // Four 7/32" holes (R 2.778125 mm), two of their radii a bit smaller: one pattern.
  const radii = [2.778125, 2.7781249999999997, 2.778125, 2.7781249999999997];
  const plate = buildSemantic3D({
    file: "inch-plate.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ geometric_surfaces: radii.map((r, i) => ({ index: i, type: "cylinder", radius_mm: r, axis: [0,0,1], center_mm: [10 * i, 0, 0], edge_signatures: [] })) })],
  });
  const patterns = plate.bodies[0].features.filter(f => f.type === "pattern_feature_candidate");
  assert.deepEqual(patterns.map(p => [p.subtype, p.surfaces]), [["possible_linear_cylindrical_pattern", [0, 1, 2, 3]]]);
});

test("a plate with 6,000 parallel holes gives one pattern and no pairwise relation, in less than 5 s", () => {
  // Every pair tested and stored took about 15 s and 1.5 GB of heap.
  const holes = Array.from({ length: 6000 }, (_, i) => ({
    index: i, type: "cylinder", radius_mm: 2, axis: [0,0,1], center_mm: [(i % 100) * 6, Math.floor(i / 100) * 6, 0], edge_signatures: [],
  }));
  const start = performance.now();
  const result = buildSemantic3D({
    file: "plate.step", kind: "cad", engine: "browser",
    summary: { volume: 1000, area: 600, bodies: 1, solids: 1 },
    bodies: [body({ bbox: { min: [0,0,0], max: [600,360,10], size: [600,360,10] }, geometric_surfaces: holes })],
  });
  const elapsed = performance.now() - start;
  const plate = result.bodies[0];
  assert.deepEqual(plate.relations, []);
  const patterns = plate.features.filter(f => f.type === "pattern_feature_candidate");
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].surfaces.length, 6000);
  assert.equal(patterns[0].diameter_mm, 4);
  assert.ok(elapsed < 5000, `${elapsed.toFixed(0)} ms`);
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
  assert.ok(source.includes('FEATURE_SCHEMA_VERSION = "10.0"'));
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
  const blockSemantic = (cylinder) => buildSemantic3D({
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
  });
  const block = (cylinder) => blockSemantic(cylinder).bodies[0];
  const roundedSemantic = blockSemantic({index:0,type:"cylinder",radius_mm:5,axis:[0,0,1],center_mm:[95,95,0],wire_count:1,edge_count:4,edge_signatures:[lineX,arcTop,lineY,arcBottom]});
  const rounded = roundedSemantic.bodies[0];
  const onFace = rounded.features.filter(f=>f.surface_index===0).map(f=>`${f.type}/${f.subtype ?? ""}`);
  assert.deepEqual(onFace, ["fillet_feature_candidate/possible_cylindrical_fillet_or_blend", "cylindrical_boundary_relation/"]);
  assert.equal(rounded.features.find(f=>f.type==="fillet_feature_candidate").radius_mm, 5);
  assert.deepEqual(rounded.manufacturing.operations.map(o=>o.operation), ["fillet_or_blend_finishing"]);
  assert.equal(rounded.foundry.rules.cores, "not_detected");

  // Features grouped by type (a compacted AI context): the fillet is R5, no Ø10.
  const context = buildAIContext(roundedSemantic, { task: "feature_analysis" });
  const compact = compactAIContext(context, { maxChars: JSON.stringify(compactAIContext(context, { maxChars: Infinity })).length - 1 });
  assert.equal(compact.compaction.level, 2);
  const fillets = compact.bodies[0].feature_groups.find(g => g.type === "fillet_feature_candidate");
  assert.deepEqual(fillets.radii_mm, [5]);
  assert.equal("diameters_mm" in fillets, false);

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
      // As the Reader exports it (app.js thicknessExport).
      thickness:{method:"wall",min:3,median:4,max:5},
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
  assert.equal(manufacturing.functional_thickness.source,"reader_wall_thickness");
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

test("functional thickness is the Reader's thinnest wall, as in the foundry evidence", () => {
  const result = buildSemantic3D({
    file:"thin.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ thickness:{method:"sphere",min:1.2,median:3,max:4} })],
  });
  const {manufacturing, foundry}=result.bodies[0];
  assert.equal(manufacturing.functional_thickness.status,"measured");
  assert.equal(manufacturing.functional_thickness.minimum_wall_thickness_mm,1.2);
  assert.equal(manufacturing.functional_thickness.minimum_wall_thickness_mm,foundry.evidence.thickness.min_mm);
  assert.ok(manufacturing.dfm_recommendations.some(d=>d.code==="thin_wall"));
  // Not computed: undetermined, no thin wall.
  const none=buildSemantic3D({ file:"none.step", kind:"cad", engine:"browser", summary:{volume:1000,area:600,bodies:1,solids:1}, bodies:[body()] });
  assert.equal(none.bodies[0].manufacturing.functional_thickness.status,"undetermined");
  assert.ok(!none.bodies[0].manufacturing.dfm_recommendations.some(d=>d.code==="thin_wall"));
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

test("V6 planning puts the operations without a tool axis in one setup", () => {
  // Three coaxial cylinders: three drillings along Z, three counterbore
  // candidates without an axis of their own (a relation and the stepped
  // feature it stands for share one operation).
  const result = buildSemantic3D({
    file:"shaft.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:[5,8,11].map((r,index)=>(
      {index,type:"cylinder",radius_mm:r,axis:[0,0,1],center_mm:[0,0,5*index],edge_signatures:[]}
    )) })],
  });
  const plan=result.bodies[0].manufacturing_plan;
  assert.equal(plan.operation_count,6);
  assert.equal(plan.setup_count,2);
  assert.deepEqual(plan.setups.map(s=>s.compatibility).sort(),["axis_unknown","common_tool_axis"]);
  assert.equal(plan.setups.find(s=>!s.tool_axis).operation_ids.length,3);
  assert.ok(plan.planned_order.every(step=>plan.setups.some(s=>s.setup_id===step.setup_id && s.operation_ids.includes(step.operation_id))));
});

test("V6 readiness reads the closedness of the semantic body", () => {
  const holed = (closed) => buildSemantic3D({
    file:"hole.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ closed, geometric_surfaces:[
      {index:0,type:"cylinder",radius_mm:2,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[]},
    ] })],
  }).bodies[0].manufacturing_plan.readiness;
  assert.ok(!holed(true).unresolved_constraints.includes("body_not_confirmed_closed"));
  assert.ok(holed(false).unresolved_constraints.includes("body_not_confirmed_closed"));
});

/** A bore (surface 0) along Z with its counterbore (surface 1) and their planar faces. */
function counterboredHole() {
  const e=(z,r)=>[r,0,z,r,0,z];
  return [
    {index:0,type:"cylinder",radius_mm:5,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e(0,5),e(10,5)]},
    {index:1,type:"cylinder",radius_mm:8,axis:[0,0,1],center_mm:[0,0,10],edge_signatures:[e(10,8),e(20,8)]},
    {index:2,type:"plane",edge_signatures:[e(0,5)]},
    {index:3,type:"plane",edge_signatures:[e(10,5),e(10,8)]},
    {index:4,type:"plane",edge_signatures:[e(20,8)]},
  ];
}

test("a counterbore depends on the operations of its bore, in the plan and in the V5 sequence", () => {
  const result = buildSemantic3D({
    file:"counterbore.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:counterboredHole() })],
  });
  const {manufacturing, manufacturing_plan:plan}=result.bodies[0];
  const opById=new Map(manufacturing.operations.map(o=>[o.operation_id,o]));
  const related=plan.dependencies.filter(d=>d.reason==="feature_relation");
  assert.ok(related.length>0);
  for (const d of related) {
    const from=opById.get(d.from), to=opById.get(d.to);
    assert.equal(to.operation,"counterboring_or_boring");
    assert.ok(["drilling","drilling_or_boring","boss_milling_or_bore"].includes(from.operation), from.operation);
    assert.ok(from.surfaces.some(s=>to.surfaces.includes(s)));
  }
  // Every counterbore candidate waits for the drilling of the bore (surface 0).
  for (const op of manufacturing.operations.filter(o=>o.operation==="counterboring_or_boring")) {
    assert.ok(related.some(d=>d.to===op.operation_id && opById.get(d.from).operation.startsWith("drilling") && opById.get(d.from).surfaces.includes(0)));
  }
  // The V5 sequence gives the same dependencies as the plan.
  for (const step of manufacturing.sequence) {
    const expected=[...new Set(plan.dependencies.filter(d=>d.to===step.operation_id).map(d=>d.from))].sort();
    assert.deepEqual([...step.depends_on].sort(),expected);
  }
});

test("V6 planned order keeps every operation after those it depends on, beside a pocket", () => {
  // The counterbored hole, and a planar pocket candidate (no tool axis) elsewhere on the part.
  const w=(x)=>[x,50,0,x,51,0];
  const result = buildSemantic3D({
    file:"counterbore-pocket.step", kind:"cad", engine:"browser",
    summary:{volume:1000,area:600,bodies:1,solids:1},
    bodies:[body({ geometric_surfaces:[
      ...counterboredHole(),
      {index:5,type:"plane",edge_signatures:[w(0),w(1),w(2)]},
      ...[0,1,2].map(x=>({index:6+x,type:"plane",edge_signatures:[w(x)]})),
    ] })],
  });
  const {manufacturing, manufacturing_plan:plan}=result.bodies[0];
  assert.ok(manufacturing.operations.some(o=>o.operation==="pocket_milling"));
  // The setup without a tool axis comes after the drilling setup.
  assert.deepEqual(plan.setups.map(s=>s.compatibility),["common_tool_axis","axis_unknown"]);
  const step=new Map(plan.planned_order.map(s=>[s.operation_id,s.step]));
  const related=plan.dependencies.filter(d=>d.reason==="feature_relation");
  assert.ok(related.length>0);
  for (const d of related) assert.ok(step.get(d.from)<step.get(d.to), d.from+" -> "+d.to);
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

test("the AI context keeps the geometry of every feature type", () => {
  const e0=[0,0,0,1,0,0], e1=[0,1,0,1,1,0], e2=[0,2,0,1,2,0];
  const semantic = buildSemantic3D({
    file:"features.step", kind:"cad", engine:"browser",
    summary:{volume:100,area:600,bodies:1,solids:1},
    bodies:[body({ volume:100, surface_types:{plane:2,cylinder:7,cone:1,sphere:0,torus:1,bspline:0}, geometric_surfaces:[
      {index:0,type:"torus",minor_radius_mm:2,edge_signatures:[e0,e1]},
      {index:1,type:"plane",edge_signatures:[e0]},
      {index:2,type:"cylinder",radius_mm:8,axis:[0,0,1],center_mm:[0,0,0],wire_count:2,edge_count:2,edge_signatures:[e1]},
      {index:3,type:"cone",semi_angle_rad:0.2,ref_radius_mm:8,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e2,e0]},
      {index:4,type:"plane",edge_signatures:[e2]},
      {index:5,type:"cylinder",radius_mm:9,axis:[0,0,1],center_mm:[0,0,0],edge_signatures:[e0]},
      {index:6,type:"cylinder",radius_mm:8,axis:[0,0,1],center_mm:[0,0,5],edge_signatures:[]},
      ...[20,40,60].map((x,i)=>({index:7+i,type:"cylinder",radius_mm:2,axis:[0,0,1],center_mm:[x,0,0],edge_signatures:[]})),
    ] })],
  });
  const features=semantic.bodies[0].features;
  const context=buildAIContext(semantic,{task:"feature_analysis"});
  const byId=new Map(context.bodies[0].features.map(f=>[f.feature_id,f]));
  for (const type of ["hole_feature_candidate","boss_feature_candidate","chamfer_feature_candidate","tapered_feature_candidate",
    "feature_relation_candidate","stepped_cylindrical_feature_candidate","coaxial_cylindrical_relation","low_fill_ratio_geometry"]) {
    assert.ok(features.some(f=>f.type===type), type);
  }
  // Every numeric field of a feature (dimension, axis, centre, surface index) reaches the model.
  const numeric=(v)=>typeof v==="number" || (Array.isArray(v) && v.length>0 && v.every(x=>x===null || numeric(x)));
  for (const f of features) {
    const geometry=byId.get(f.feature_id).geometry;
    for (const [k,v] of Object.entries(f)) {
      if (k==="confidence" || k==="evidence_count" || !numeric(v)) continue;
      assert.deepEqual(geometry[k],v,`${f.type}.${k}`);
    }
  }
  // Stepped and coaxial features carry the geometry and the id of their relation.
  const relations=new Map(semantic.bodies[0].relations.map(r=>[r.relation_id,r]));
  const stepped=features.filter(f=>["stepped_cylindrical_feature_candidate","coaxial_cylindrical_relation"].includes(f.type));
  assert.ok(stepped.length>0);
  for (const f of stepped) {
    const c=byId.get(f.feature_id);
    const relation=relations.get(f.evidence[0].relation_id);
    assert.deepEqual(c.geometry.surfaces,relation.surfaces);
    for (const k of ["radius_mm","radii_mm","diameter_mm"]) if (f[k]!=null) assert.deepEqual(c.geometry[k],f[k],k);
    assert.deepEqual(c.evidence,[{source:"relation",relation_id:relation.relation_id}]);
    assert.equal(c.evidence_count,1);
  }
  const taper=stepped.find(f=>relations.get(f.evidence[0].relation_id).type==="coaxial_cylinder_cone");
  assert.equal(byId.get(taper.feature_id).geometry.diameter_mm,16);
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

test("the costing trace of the task \"Chiffrage\" is kept whole by the compaction; the geometry has the room it leaves", () => {
  const count = 60;
  const semantic = buildSemantic3D({
    file: "assembly.step", kind: "cad", engine: "browser", source_unit: "mm",
    summary: { volume: 60000, area: 36000, bodies: count, solids: count },
    bodies: Array.from({ length: count }, (_, i) => body({ name: `Body ${i}`, volume: 1000 + i })),
  });
  const context = buildAIContext(semantic, { task: "manufacturing_analysis" });
  // A trace of 6000 characters (ai-trace.js:traceForAI keeps it under 8000 for a local model).
  const valeurs = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`piece.valeur${i}`, { valeur: i + 0.5, unite: "kg", source: "calcul", autorite: "calcul", confiance: "moyenne" }]));
  const costing_trace = { schema: "3d-reader-costing-trace", lecture_seule: true, pieces: [{ nom: "Pièce", valeurs }] };
  const plain = compactAIContext(context, { maxChars: 12000 });
  const compact = compactAIContext({ ...context, costing_trace }, { maxChars: 12000 });
  assert.deepEqual(compact.costing_trace, costing_trace);
  assert.ok(JSON.stringify(compact).length <= 12000, `${JSON.stringify(compact).length} characters`);
  // Less room for the geometry: more compacted, or fewer bodies in detail.
  assert.ok(compact.compaction.level > plain.compaction.level || compact.bodies.length < plain.bodies.length, `level ${compact.compaction.level}, ${compact.bodies.length} bodies`);
});
