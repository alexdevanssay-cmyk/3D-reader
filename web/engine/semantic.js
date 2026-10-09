// Semantic intermediate representation for AI reasoning.
//
// V1 deliberately keeps the raw tessellation out of the public semantic payload.
// It derives stable metrology, topology and geometric feature candidates from the
// existing Reader result. CAD surface classes are supplied by cad.js when available.
//
// Contract version: 1.0
import { buildManufacturingPlan, operationDependencyGraph, precedence } from "./manufacturing-plan.js";
import { buildFoundryAnalysis, FOUNDRY_SCHEMA_VERSION, FOUNDRY_KNOWLEDGE_VERSION } from "./foundry-knowledge.js";
import { meshTopology } from "./meshanalysis.js";
import { ANALYSIS_HINTS } from "./analysis-hints.js";

export const SEMANTIC_VERSION = "1.0";

const EPS = 1e-9;
const FEATURE_SCHEMA_VERSION = "10.0";
const MANUFACTURING_PLANNING_SCHEMA_VERSION = "1.0";
const MANUFACTURING_SCHEMA_VERSION = "1.0";
const FOUNDRY_PROFILE = "unspecified";

// Coaxial faces are related pairwise up to this many on one axis line (a
// counterbored hole, a split bore, a small turned part); beyond it, as on a
// long shaft, each face only to its neighbours along the axis, so that
// relations grow linearly.
const COAXIAL_PAIRWISE_LIMIT = 16;

function finite(v) { return typeof v === "number" && Number.isFinite(v); }
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

/**
 * Edge topology of a body's mesh (see meshanalysis.js meshTopology), or null
 * without one. The in-browser engine gives it with each body (body.topology),
 * which the page keeps when it leaves the mesh out.
 */
function topology(body) {
  const m = body.mesh;
  if (!m?.positions || !m?.indices) return null;
  // Far from the origin, float32 does not even resolve the body: its
  // double-precision vertices when kept.
  return meshTopology(ArrayBuffer.isView(m.positions64) ? m.positions64 : m.positions, m.indices);
}

function principalAxes(body) {
  const size = body.bbox?.size ?? [];
  if (size.length!==3) return null;
  const order=[0,1,2].sort((a,b)=>size[b]-size[a]);
  return {
    length_axis: "XYZ"[order[0]],
    width_axis: "XYZ"[order[1]],
    height_axis: "XYZ"[order[2]],
    size_order: order.map(i=>size[i]),
  };
}

function normalizeAxis(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n <= EPS) return null;
  const a = v.map(x => x / n);
  return a;
}

/** Rounded direction of an axis, the same for both senses (first non-zero component positive); null if invalid. */
function directionKey(axis) {
  const a=normalizeAxis(axis);
  if (!a) return null;
  const d=a.map(v=>Math.round(v*1e4));
  const sense=Math.sign(d.find(v=>v!==0));
  return d.map(v=>v*sense).join(",");
}

/**
 * Bucket keys of the line through `point` along `axis`: its direction and the
 * foot of the perpendicular from the origin, rounded (the foot to 0.01 mm).
 * Coaxial faces get the same key whichever point of the axis each was given;
 * the exact coaxiality test (axisDistance) is still made on the pairs related.
 * A foot coordinate on a rounding boundary (9.525 mm = 3/8", give or take a
 * few bits) gives the keys of both sides, so that coaxial faces share one.
 */
function axisLineKeys(axis, point) {
  const a=normalizeAxis(axis);
  if (!a || !Array.isArray(point) || point.length!==3 || !point.every(finite)) return [];
  const t=dot(point,a);
  let keys=[directionKey(a)+"|"];
  for (let i=0;i<3;i++) {
    const v=(point[i]-t*a[i])*1e2;
    const rounded=Math.abs(v-Math.floor(v)-0.5)<=1e-4 ? [Math.floor(v),Math.ceil(v)] : [Math.round(v)];
    keys=keys.flatMap(k=>rounded.map(r=>k+(i ? "," : "")+r));
  }
  return keys;
}

function groupBy(items, key) {
  const groups=new Map();
  for (const item of items) {
    const k=key(item);
    if (k==null) continue;
    const group=groups.get(k);
    if (group) group.push(item);
    else groups.set(k,[item]);
  }
  return groups;
}

/** Position of a face along `axis`: the middle of its B-Rep edge end points, else its axis point. */
function axialPosition(face, axis) {
  let lo=Infinity, hi=-Infinity;
  for (const e of face.edge_signatures ?? []) {
    if (!Array.isArray(e) || e.length!==6 || !e.every(finite)) continue;
    const t0=e[0]*axis[0]+e[1]*axis[1]+e[2]*axis[2], t1=e[3]*axis[0]+e[4]*axis[1]+e[5]*axis[2];
    lo=Math.min(lo,t0,t1);
    hi=Math.max(hi,t0,t1);
  }
  return lo<=hi ? (lo+hi)/2 : dot(face.center_mm,axis);
}

/**
 * Coaxial faces to relate: face -> the later faces (in `faces` order) on its
 * axis line. Pairwise on a short line, neighbours along the axis on a long one
 * (see COAXIAL_PAIRWISE_LIMIT). Pairs are never all tested nor stored.
 */
function coaxialPartners(faces) {
  const order=new Map(faces.map((f,i)=>[f,i]));
  const partners=new Map();
  // A pair may come twice: its two faces on two keys of one line, or neighbours in both chains below.
  const linked=new Set();
  const link=(a,b)=>{
    const [first,second]=order.get(a)<order.get(b) ? [a,b] : [b,a];
    const key=order.get(first)+":"+order.get(second);
    if (linked.has(key)) return;
    linked.add(key);
    const list=partners.get(first) ?? [];
    list.push(second);
    partners.set(first,list);
  };
  const lines=new Map();
  for (const f of faces) {
    for (const key of axisLineKeys(f.axis,f.center_mm)) {
      const line=lines.get(key);
      if (line) line.push(f);
      else lines.set(key,[f]);
    }
  }
  for (const group of lines.values()) {
    if (group.length<=COAXIAL_PAIRWISE_LIMIT) {
      for (let i=0;i<group.length;i++) for (let j=i+1;j<group.length;j++) link(group[i],group[j]);
      continue;
    }
    const axis=normalizeAxis(group[0].axis);
    const position=new Map(group.map(f=>[f,axialPosition(f,axis)]));
    const along=[...group].sort((a,b)=>position.get(a)-position.get(b) || order.get(a)-order.get(b));
    for (let i=1;i<along.length;i++) link(along[i-1],along[i]);
    // The cylinders on their own too: a shoulder is a step between two
    // diameters even with a chamfer (a cone) between them.
    const cylinders=along.filter(f=>f.type==="cylinder");
    for (let i=1;i<cylinders.length;i++) link(cylinders[i-1],cylinders[i]);
  }
  for (const list of partners.values()) list.sort((a,b)=>order.get(a)-order.get(b));
  return partners;
}

/** Distance between two parallel axis lines (direction + point on it); Infinity if not parallel. */
function axisDistance(axisA, pointA, axisB, pointB) {
  const aa=normalizeAxis(axisA), bb=normalizeAxis(axisB);
  if (!aa || !bb) return Infinity;
  if (!Array.isArray(pointA) || !Array.isArray(pointB) || !pointA.every(finite) || !pointB.every(finite)) return Infinity;
  const parallel = Math.abs(Math.abs(aa[0]*bb[0]+aa[1]*bb[1]+aa[2]*bb[2]) - 1);
  if (parallel > 1e-5) return Infinity;
  const d=[pointB[0]-pointA[0],pointB[1]-pointA[1],pointB[2]-pointA[2]];
  const axial=d[0]*aa[0]+d[1]*aa[1]+d[2]*aa[2];
  return Math.hypot(d[0]-axial*aa[0],d[1]-axial*aa[1],d[2]-axial*aa[2]);
}

function samePoint(a,b,tol=1e-6) {
  return Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i)=>Math.abs(v-b[i])<=tol*Math.max(1,Math.abs(v),Math.abs(b[i])));
}

function edgeKey(edge) {
  return Array.isArray(edge) && edge.length===6 ? edge.map(v=>Number(v).toPrecision(12)).join(",") : null;
}

function faceAdjacency(surfaces) {
  const owners=new Map();
  for (const face of surfaces) {
    for (const edge of (face.edge_signatures ?? [])) {
      const key=edgeKey(edge);
      if (!key) continue;
      const list=owners.get(key) ?? [];
      list.push(face.index);
      owners.set(key,list);
    }
  }
  const pairs=new Map();
  for (const list of owners.values()) {
    const unique=[...new Set(list)];
    if (unique.length<2) continue;
    for(let i=0;i<unique.length;i++) for(let j=i+1;j<unique.length;j++) {
      const k=unique[i]<unique[j] ? unique[i]+":"+unique[j] : unique[j]+":"+unique[i];
      pairs.set(k,(pairs.get(k)||0)+1);
    }
  }
  return [...pairs.entries()].map(([key,shared_edges])=>{
    const [a,b]=key.split(":").map(Number);
    return {faces:[a,b],shared_edges};
  });
}

/** Faces by index and their B-Rep neighbours (face index -> [{face, shared_edges}]), built once per body. */
function faceGraph(surfaces) {
  const byIndex=new Map(surfaces.map(s=>[s.index,s]));
  const neighbors=new Map();
  for (const rel of faceAdjacency(surfaces)) {
    for (const [a,b] of [[rel.faces[0],rel.faces[1]],[rel.faces[1],rel.faces[0]]]) {
      const list=neighbors.get(a) ?? [];
      list.push({face:b,shared_edges:rel.shared_edges});
      neighbors.set(a,list);
    }
  }
  return {byIndex, neighbors};
}

function cylindricalRelations(cylinders, cones, graph) {
  const relations=[];
  const {byIndex, neighbors}=graph;
  const partners=coaxialPartners([...cylinders, ...cones]);
  for (const a of cylinders) {
    for (const b of partners.get(a) ?? []) {
      if (b.type!=="cylinder") continue;
      if (axisDistance(a.axis,a.center_mm,b.axis,b.center_mm)>Math.max(1e-4,Math.min(a.radius_mm,b.radius_mm)*1e-3)) continue;
      const radiiEqual=Math.abs(a.radius_mm-b.radius_mm)<=Math.max(1e-5,Math.min(a.radius_mm,b.radius_mm)*1e-4);
      relations.push({
        type:radiiEqual ? "coaxial_cylinders" : "coaxial_cylinder_step",
        surfaces:[a.index,b.index],
        radius_mm:radiiEqual ? a.radius_mm : null,
        radii_mm:radiiEqual ? null : [a.radius_mm,b.radius_mm],
        confidence:radiiEqual ? 0.94 : 0.91
      });
    }
  }
  for (const c of cylinders) {
    // Cones come after the cylinders in the partner lists, in their own order.
    for (const cone of partners.get(c) ?? []) {
      if (cone.type!=="cone") continue;
      if (axisDistance(c.axis,c.center_mm,cone.axis,cone.center_mm)>Math.max(1e-4,c.radius_mm*1e-3)) continue;
      relations.push({
        type:"coaxial_cylinder_cone",
        surfaces:[c.index,cone.index],
        diameter_mm:2*c.radius_mm,
        cone_ref_radius_mm:cone.ref_radius_mm ?? null,
        confidence:0.9,
      });
    }
    const adjacent_planes=(neighbors.get(c.index)??[]).map(x=>byIndex.get(x.face)).filter(f=>f?.type==="plane");
    if(adjacent_planes.length){
      relations.push({
        type:"cylindrical_boundary_planes",
        surface:c.index,
        planes:adjacent_planes.map(f=>f.index),
        shared_edges:(neighbors.get(c.index)??[]).filter(x=>adjacent_planes.some(f=>f.index===x.face)).reduce((n,x)=>n+x.shared_edges,0),
        confidence:0.88,
        method:"shared_brep_edges"
      });
    }
  }
  return relations;
}


function parallelAxes(a,b,tol=1e-5) {
  const aa=normalizeAxis(a), bb=normalizeAxis(b);
  if (!aa || !bb) return false;
  return Math.abs(Math.abs(aa[0]*bb[0]+aa[1]*bb[1]+aa[2]*bb[2])-1) <= tol;
}

/**
 * Repeated cylinders: groups of parallel cylinders of the same radius, each
 * member's axis more than a diameter away from another one's in its group
 * (not a split face of the same hole, nor a section of the same shaft).
 * Groups of three or more, in face order.
 */
function repeatedCylinders(cylinders) {
  const order=new Map(cylinders.map((c,i)=>[c,i]));
  const groups=[];
  for (const parallel of groupBy(cylinders, c=>directionKey(c.axis)).values()) {
    // The same radius within the tolerance of the coaxial relations, from the
    // smallest one of each group, rather than a rounded key: two radii a few
    // bits apart (7/32" = 2.778125 mm) could round on either side of it.
    let group=null;
    for (const c of [...parallel].sort((a,b)=>a.radius_mm-b.radius_mm)) {
      if (!group || c.radius_mm-group[0].radius_mm>Math.max(1e-5,group[0].radius_mm*1e-4)) groups.push(group=[]);
      group.push(c);
    }
  }
  return groups
    .map(group=>group.sort((a,b)=>order.get(a)-order.get(b)))
    .sort((a,b)=>order.get(a[0])-order.get(b[0]))
    .map(group=>group.filter(a=>group.some(b=>b!==a && axisDistance(a.axis,a.center_mm,b.axis,b.center_mm)>Math.max(a.radius_mm*2,1e-3))))
    .filter(members=>members.length>=3);
}

function collinearCenters(cylinders) {
  if (cylinders.length < 3) return false;
  const p0=cylinders[0].center_mm, p1=cylinders[1].center_mm;
  if (!Array.isArray(p0) || !Array.isArray(p1)) return false;
  const base=[p1[0]-p0[0],p1[1]-p0[1],p1[2]-p0[2]];
  const baseNorm=Math.hypot(...base);
  if (baseNorm <= EPS) return false;
  for (let i=2;i<cylinders.length;i++) {
    const p=cylinders[i].center_mm;
    if (!Array.isArray(p)) return false;
    const v=[p[0]-p0[0],p[1]-p0[1],p[2]-p0[2]];
    const cross=[
      base[1]*v[2]-base[2]*v[1],
      base[2]*v[0]-base[0]*v[2],
      base[0]*v[1]-base[1]*v[0],
    ];
    if (Math.hypot(...cross) > 1e-5*Math.max(1,baseNorm,Math.hypot(...v))) return false;
  }
  const t=cylinders.map(c => {
    const p=c.center_mm;
    return ((p[0]-p0[0])*base[0]+(p[1]-p0[1])*base[1]+(p[2]-p0[2])*base[2])/(baseNorm*baseNorm);
  }).sort((a,b)=>a-b);
  const gaps=t.slice(1).map((v,i)=>v-t[i]);
  const mean=gaps.reduce((a,b)=>a+b,0)/gaps.length;
  return mean > EPS && gaps.every(g=>Math.abs(g-mean)<=1e-4*Math.max(1,Math.abs(mean)));
}

function circularCenters(cylinders) {
  if (cylinders.length < 3) return false;
  const axis=normalizeAxis(cylinders[0].axis);
  if (!axis || !cylinders.every(c=>parallelAxes(axis,c.axis) && Array.isArray(c.center_mm))) return false;
  const p0=cylinders[0].center_mm;
  const pts=cylinders.map(c => c.center_mm);
  const centroid=pts.reduce((o,p)=>o.map((v,i)=>v+p[i]/pts.length),[0,0,0]);
  const radial=pts.map(p => {
    const v=[p[0]-centroid[0],p[1]-centroid[1],p[2]-centroid[2]];
    const axial=v[0]*axis[0]+v[1]*axis[1]+v[2]*axis[2];
    return Math.hypot(v[0]-axial*axis[0],v[1]-axial*axis[1],v[2]-axial*axis[2]);
  });
  const r=radial.reduce((a,b)=>a+b,0)/radial.length;
  if (r <= EPS || !radial.every(v=>Math.abs(v-r)<=1e-4*Math.max(1,r))) return false;
  const axialSpread=pts.map(p=>(p[0]-p0[0])*axis[0]+(p[1]-p0[1])*axis[1]+(p[2]-p0[2])*axis[2]);
  return Math.max(...axialSpread)-Math.min(...axialSpread) <= 1e-4*Math.max(1,r);
}

function surfaceRelations(surfaces, graph, bodyId) {
  const cylinders=surfaces.filter(x=>x.type==="cylinder" && finite(x.radius_mm));
  const cones=surfaces.filter(x=>x.type==="cone" && Array.isArray(x.axis) && Array.isArray(x.center_mm));
  const analytic=cylindricalRelations(cylinders,cones,graph);
  return analytic.map((r, i) => ({
    ...r,
    // Scoped by body: surface indices, hence relations, restart in every body.
    relation_id:bodyId+"/relation-"+i,
    evidence:"analytic_surface_geometry",
    confirmed_by_shared_brep_edges: r.type==="cylindrical_boundary_planes"
  }));
}

/**
 * A cylindrical face that turns less than a full revolution (no seam edge in
 * its B-Rep edges) and meets a plane parallel to its axis tangentially: a
 * rounded edge or corner, not a hole or a boss. Needs the edges and plane
 * normals given by cad.js; false without them.
 */
function cylindricalBlend(cylinder, graph) {
  const axis=normalizeAxis(cylinder.axis);
  if (!axis || !Array.isArray(cylinder.center_mm)) return false;
  const tangentPlane=(graph.neighbors.get(cylinder.index) ?? []).some(({face}) => {
    const plane=graph.byIndex.get(face);
    const n=plane?.type==="plane" ? normalizeAxis(plane.normal) : null;
    if (!n || !Array.isArray(plane.center_mm) || Math.abs(dot(n,axis))>1e-6) return false;
    const distance=Math.abs(dot(n,cylinder.center_mm)-dot(n,plane.center_mm));
    return Math.abs(distance-cylinder.radius_mm)<=Math.max(1e-4,cylinder.radius_mm*1e-3);
  });
  if (!tangentPlane) return false;
  // A full revolution has a seam: one edge met twice around the face.
  const keys=(cylinder.edge_signatures ?? []).map(edgeKey).filter(Boolean);
  return new Set(keys).size===keys.length;
}

/** Whether a plane bounds the body's box, the whole body on one side of it: an outer face. False without a normal. */
function envelopePlane(plane, bbox) {
  const n=normalizeAxis(plane.normal);
  const min=bbox?.min, max=bbox?.max;
  if (!n || !Array.isArray(plane.center_mm) || !Array.isArray(min) || !Array.isArray(max)) return false;
  // Extent of the box along n: the lowest and highest projections of its corners.
  let lo=0, hi=0;
  for (let i=0;i<3;i++) {
    lo+=Math.min(n[i]*min[i],n[i]*max[i]);
    hi+=Math.max(n[i]*min[i],n[i]*max[i]);
  }
  const d=dot(n,plane.center_mm);
  const tol=Math.max(1e-4,(hi-lo)*1e-6);
  return Math.abs(d-lo)<=tol || Math.abs(d-hi)<=tol;
}

function featureCandidates(body, topo, relations, graph) {
  const out=[];
  const s=body.bbox?.size ?? [0,0,0];
  const volume=body.volume;
  const fill = volume!=null && s[0]*s[1]*s[2]>EPS ? volume/(s[0]*s[1]*s[2]) : null;

  if (body.closed && topo?.watertight) out.push({type:"closed_solid", confidence:1, method:"topology"});
  if (!body.closed) out.push({type:"open_surface", confidence:1, method:"reader"});
  if (fill != null && fill < 0.35) out.push({type:"low_fill_ratio_geometry", confidence:0.85, method:"metrology", fill_ratio:fill});

  const st=body.surface_types;
  if (st) {
    if ((st.cylinder ?? 0) > 0) out.push({type:"cylindrical_geometry", confidence:0.9, method:"surface_class", faces:st.cylinder});
    if ((st.cone ?? 0) > 0) out.push({type:"conical_geometry", confidence:0.85, method:"surface_class", faces:st.cone});
    if ((st.sphere ?? 0) > 0) out.push({type:"spherical_geometry", confidence:0.9, method:"surface_class", faces:st.sphere});
    if ((st.torus ?? 0) > 0) out.push({type:"toroidal_geometry", confidence:0.85, method:"surface_class", faces:st.torus});
    if ((st.plane ?? 0) > 0) out.push({type:"planar_geometry", confidence:0.95, method:"surface_class", faces:st.plane});
    if ((st.bspline ?? 0) > 0) out.push({type:"freeform_geometry", confidence:0.8, method:"surface_class", faces:st.bspline});
  }

  const surfaces=body.geometric_surfaces ?? [];
  const cylinders=surfaces.filter(x=>x.type==="cylinder" && finite(x.radius_mm));
  const cones=surfaces.filter(x=>x.type==="cone" && Array.isArray(x.axis) && Array.isArray(x.center_mm));
  const {byIndex, neighbors:adjacencyByFace}=graph;
  // Rounded edges are reported as fillets below, never as holes, bores or bosses.
  const blends=new Set(cylinders.filter(c=>cylindricalBlend(c,graph)).map(c=>c.index));
  const boundaryRelations=relations.filter(r=>r.type==="cylindrical_boundary_planes");

  for (const c of cylinders) {
    if (blends.has(c.index)) continue;
    const axial = Math.max(...s);
    const likelyThrough = c.radius_mm > 0 && axial > 0 && axial / (2*c.radius_mm) > 1.5;
    // Two boundary circles close a pin or a boss as well as a hole: only a face
    // with the material outside it (reversed; any other orientation is unknown)
    // can be a hole. They do not tell a through hole from a blind one either,
    // hence the confirmation still needed.
    const boundaryEvidence = c.orientation === "reversed" && (c.edge_count === 2 || c.wire_count === 2);
    out.push({
      type:"cylindrical_feature_candidate",
      subtype:boundaryEvidence && likelyThrough ? "possible_through_hole" : likelyThrough ? "possible_bore" : "cylindrical_surface",
      confidence:boundaryEvidence && likelyThrough ? 0.86 : likelyThrough ? 0.72 : 0.55,
      method:"analytic_surface_plus_brep_boundaries",
      surface_index:c.index,
      radius_mm:c.radius_mm,
      diameter_mm:2*c.radius_mm,
      axis:c.axis ?? null,
      center_mm:c.center_mm ?? null,
      boundary_evidence:{wire_count:c.wire_count ?? null,edge_count:c.edge_count ?? null},
      needs_topology_confirmation:true
    });
  }

  // A cylindrical face bounded by two planar faces is a strong geometric
  // signature of a cylindrical passage, but it is still not enough to prove
  // design intent: an external boss can have the same topology.
  for (const r of boundaryRelations) {
    const cylinder = byIndex.get(r.surface);
    if (!cylinder || blends.has(cylinder.index)) continue;
    const planeCount = r.planes.length;
    const subtype = planeCount >= 2 ? "possible_through_hole_or_bore" :
      planeCount === 1 ? "possible_blind_hole_or_bore" : "cylindrical_cut_candidate";
    const confidence = planeCount >= 2 ? 0.84 : planeCount === 1 ? 0.76 : 0.6;
    out.push({
      type:"hole_feature_candidate",
      subtype,
      surface_index:cylinder.index,
      diameter_mm:2*cylinder.radius_mm,
      axis:cylinder.axis ?? null,
      center_mm:cylinder.center_mm ?? null,
      boundary_planes:r.planes,
      confidence,
      method:"cylindrical_face_plus_shared_brep_planar_boundaries",
      evidence:[{source:"relation", relation_id:r.relation_id}],
      needs_topology_confirmation:true
    });
  }

  // Promote analytic cone/cylinder junctions only when their boundary evidence
  // supports a machining-like transition. Keep the result explicitly provisional.
  for (const r of relations) {
    if (r.type === "coaxial_cylinder_cone") {
      const cylinder = byIndex.get(r.surfaces[0]);
      const cone = byIndex.get(r.surfaces[1]);
      if (!cylinder || !cone) continue;
      const coneAngle = Math.abs(cone.semi_angle_rad ?? 0);
      out.push({
        type: "tapered_feature_candidate",
        subtype: coneAngle > 0 && coneAngle < Math.PI / 4
          ? "possible_countersink_or_taper"
          : "possible_conical_transition",
        surfaces: [cylinder.index, cone.index],
        cylinder_diameter_mm: 2 * cylinder.radius_mm,
        cone_ref_radius_mm: cone.ref_radius_mm ?? null,
        cone_semi_angle_rad: cone.semi_angle_rad ?? null,
        confidence: coneAngle > 0 && coneAngle < Math.PI / 4 ? 0.82 : 0.68,
        method: "coaxial_cylinder_cone_analytic_surfaces",
        evidence: [{source:"relation", relation_id:r.relation_id}],
        needs_topology_confirmation: true
      });
    }
  }

  // Promote repeated, parallel, equal-radius cylinders (rounded edges aside)
  // to a conservative pattern candidate, one per direction and radius. Do not
  // infer linear/circular intent until the centers support a stronger pattern
  // classification.
  for (const members of repeatedCylinders(cylinders.filter(c=>!blends.has(c.index)))) {
    const subtype = collinearCenters(members)
      ? "possible_linear_cylindrical_pattern"
      : circularCenters(members)
        ? "possible_circular_cylindrical_pattern"
        : "possible_repeated_cylindrical_pattern";
    out.push({
      type:"pattern_feature_candidate",
      subtype,
      surfaces:members.map(x=>x.index),
      diameter_mm:2*members[0].radius_mm,
      axes:members.map(x=>x.axis ?? null),
      centers_mm:members.map(x=>x.center_mm ?? null),
      confidence:subtype==="possible_repeated_cylindrical_pattern" ? 0.78 : 0.84,
      method:"parallel_equal_radius_cylindrical_surface_repetition",
      needs_topology_confirmation:true
    });
  }

  // Toroidal faces adjacent to analytic faces are strong evidence of a blend,
  // but the semantic layer does not assume that every torus is a fillet.
  for (const torus of surfaces.filter(x=>x.type==="torus" && finite(x.minor_radius_mm))) {
    const neighbors=(adjacencyByFace.get(torus.index) ?? [])
      .map(x=>byIndex.get(x.face))
      .filter(Boolean)
      .filter(x=>["plane","cylinder","cone","bspline","bezier"].includes(x.type));
    if (neighbors.length < 2) continue;
    out.push({
      type:"fillet_feature_candidate",
      subtype:"possible_fillet_or_toroidal_blend",
      surface_index:torus.index,
      minor_radius_mm:torus.minor_radius_mm,
      adjacent_surfaces:neighbors.map(x=>x.index),
      confidence:0.8,
      method:"toroidal_face_plus_shared_brep_edges",
      needs_topology_confirmation:true
    });
  }

  // A partial cylinder tangent to a plane parallel to its axis rounds an edge
  // or a corner (cylindricalBlend): a fillet, whatever its length.
  for (const c of cylinders) {
    if (!blends.has(c.index)) continue;
    const neighbors=(adjacencyByFace.get(c.index) ?? [])
      .map(x=>byIndex.get(x.face))
      .filter(Boolean)
      .filter(x=>["plane","cylinder","cone","bspline","bezier"].includes(x.type));
    out.push({
      type:"fillet_feature_candidate",
      subtype:"possible_cylindrical_fillet_or_blend",
      surface_index:c.index,
      radius_mm:c.radius_mm,
      axis:c.axis ?? null,
      adjacent_surfaces:neighbors.map(x=>x.index),
      confidence:0.8,
      method:"partial_cylindrical_face_tangent_to_shared_brep_planes",
      needs_topology_confirmation:true
    });
  }

  // A conical face adjacent to machining-like analytic faces is a possible
  // chamfer/taper. Angle and adjacency are evidence, not proof of intent.
  for (const cone of cones) {
    const neighbors=(adjacencyByFace.get(cone.index) ?? [])
      .map(x=>byIndex.get(x.face))
      .filter(Boolean)
      .filter(x=>["plane","cylinder"].includes(x.type));
    if (neighbors.length < 2) continue;
    const angle=Math.abs(cone.semi_angle_rad ?? 0);
    out.push({
      type:"chamfer_feature_candidate",
      subtype:"possible_chamfer_or_taper_transition",
      surface_index:cone.index,
      semi_angle_rad:cone.semi_angle_rad ?? null,
      adjacent_surfaces:neighbors.map(x=>x.index),
      confidence:angle>0 && angle<Math.PI/3 ? 0.77 : 0.68,
      method:"conical_face_plus_shared_brep_edges",
      needs_topology_confirmation:true
    });
  }

  // A planar face with several shared B-Rep edges to neighboring faces is a
  // conservative recess/pocket signal. Concavity is intentionally not inferred
  // from face orientation alone, but a face on the body's envelope (every face
  // of a plain box) has the whole body on one side: it is no recess floor.
  const relationIdsByPlane=new Map();
  for (const r of boundaryRelations) {
    for (const plane of r.planes ?? []) {
      const list=relationIdsByPlane.get(plane) ?? [];
      list.push(r.relation_id);
      relationIdsByPlane.set(plane,list);
    }
  }
  for (const floor of surfaces.filter(x=>x.type==="plane")) {
    if (envelopePlane(floor, body.bbox)) continue;
    const neighbors=adjacencyByFace.get(floor.index) ?? [];
    const wallSurfaces=neighbors
      .map(x=>byIndex.get(x.face))
      .filter(Boolean)
      .filter(x=>x.type==="plane" || x.type==="cylinder" || x.type==="cone" || x.type==="bspline" || x.type==="bezier");
    if (wallSurfaces.length < 3) continue;
    const relationIds=relationIdsByPlane.get(floor.index) ?? [];
    out.push({
      type:"pocket_feature_candidate",
      subtype:"possible_pocket_or_recess",
      floor_surface:floor.index,
      wall_surfaces:wallSurfaces.map(x=>x.index),
      shared_brep_edges:neighbors.reduce((n,x)=>n+x.shared_edges,0),
      evidence:relationIds.map(relation_id=>({source:"relation",relation_id})),
      confidence:0.7,
      method:"planar_floor_plus_multiple_shared_brep_neighbors",
      needs_topology_confirmation:true
    });
  }

  // A cylindrical face attached to planar faces may represent an external boss
  // or an internal bore. Without a reliable inside/outside test, keep both
  // interpretations explicit rather than misclassifying the feature.
  const boundaryRelationBySurface=new Map(boundaryRelations.map(r=>[r.surface,r]));
  for (const c of cylinders) {
    if (blends.has(c.index)) continue;
    const neighbors=adjacencyByFace.get(c.index) ?? [];
    const planes=neighbors
      .map(x=>byIndex.get(x.face))
      .filter(x=>x?.type==="plane");
    if (!planes.length) continue;
    const boundaryRelation=boundaryRelationBySurface.get(c.index);
    out.push({
      type:"boss_feature_candidate",
      subtype:"possible_cylindrical_boss_or_bore",
      surface_index:c.index,
      support_or_termination_planes:planes.map(x=>x.index),
      diameter_mm:2*c.radius_mm,
      axis:c.axis ?? null,
      center_mm:c.center_mm ?? null,
      confidence:planes.length>=2 ? 0.72 : 0.64,
      method:"cylindrical_face_plus_shared_brep_planar_boundaries",
      evidence:boundaryRelation ? [{source:"relation",relation_id:boundaryRelation.relation_id}] : [],
      needs_topology_confirmation:true
    });
  }

  // Promote coaxial cylinders to a pattern/step relation while retaining the
  // underlying analytic evidence. Equal diameters are useful for pattern hints;
  // different diameters are useful for counterbore/step candidates.
  const coaxial = relations.filter(r => r.type === "coaxial_cylinders" || r.type === "coaxial_cylinder_step");
  for (const r of coaxial) {
    const a = byIndex.get(r.surfaces[0]);
    const b = byIndex.get(r.surfaces[1]);
    if (!a || !b) continue;
    const subtype = r.type === "coaxial_cylinders"
      ? "possible_coaxial_repeat_or_continuous_bore"
      : "possible_counterbore_or_coaxial_step";
    out.push({
      type: "feature_relation_candidate",
      subtype,
      surfaces: r.surfaces,
      radii_mm: r.radii_mm ?? [a.radius_mm, b.radius_mm],
      confidence: r.type === "coaxial_cylinders" ? 0.88 : 0.9,
      method: "coaxial_analytic_surface_relation",
      evidence: [{source:"relation", relation_id:r.relation_id}],
      needs_topology_confirmation: true
    });
  }

  for (const r of relations) {
    if (r.type==="cylindrical_boundary_planes") {
      out.push({
        type:"cylindrical_boundary_relation",
        surface_index:r.surface,
        plane_indices:r.planes,
        shared_edges:r.shared_edges,
        confidence:r.confidence,
        method:r.method,
        evidence:[{source:"relation", relation_id:r.relation_id}],
        interpretation:"cylindrical_face_shares_brep_edges_with_planar_faces",
        needs_topology_confirmation:false
      });
    } else if (r.type==="coaxial_cylinder_cone") {
      out.push({
        type:"stepped_cylindrical_feature_candidate",
        subtype:"possible_countersink_or_taper_transition",
        surfaces:r.surfaces,
        diameter_mm:r.diameter_mm,
        cone_ref_radius_mm:r.cone_ref_radius_mm,
        confidence:0.78,
        method:"coaxial_analytic_surfaces",
        evidence:[{source:"relation", relation_id:r.relation_id}],
        needs_topology_confirmation:true
      });
    } else if (r.type==="coaxial_cylinder_step") {
      out.push({
        type:"stepped_cylindrical_feature_candidate",
        subtype:"possible_counterbore_or_coaxial_step",
        surfaces:r.surfaces,
        radii_mm:r.radii_mm,
        confidence:0.79,
        method:"coaxial_analytic_surfaces_with_different_radii",
        evidence:[{source:"relation", relation_id:r.relation_id}],
        needs_topology_confirmation:true
      });
    } else if (r.type==="coaxial_cylinders") {
      out.push({
        type:"coaxial_cylindrical_relation",
        subtype:"same_diameter_coaxial_surfaces",
        surfaces:r.surfaces,
        radius_mm:r.radius_mm,
        confidence:0.94,
        method:"coaxial_analytic_surfaces",
        evidence:[{source:"relation", relation_id:r.relation_id}],
        needs_topology_confirmation:true
      });
    }
  }

  return out;
}

/**
 * Id of a feature, scoped by its body (surface indices restart in every body):
 * `body-0/feature-1a2b3c4d`. A hash of 32 bits can collide in a body of tens
 * of thousands of features: the next free value is then taken (`taken`: the
 * ids given so far in the body).
 */
function stableFeatureId(feature, occurrence, bodyId, taken) {
  const identity = [
    feature.type ?? "feature",
    feature.subtype ?? "",
    feature.surface_index ?? feature.floor_surface ?? "",
    Array.isArray(feature.surfaces) ? feature.surfaces.join(",") : "",
    Array.isArray(feature.boundary_planes) ? feature.boundary_planes.join(",") : "",
    Array.isArray(feature.wall_surfaces) ? feature.wall_surfaces.join(",") : "",
    occurrence,
  ].join("|");
  let hash = 2166136261;
  for (let i=0;i<identity.length;i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const id = (h) => bodyId + "/feature-" + (h >>> 0).toString(16).padStart(8, "0");
  while (taken.has(id(hash))) hash = (hash + 1) | 0;
  taken.add(id(hash));
  return id(hash);
}

function normalizeFeatureEvidence(features, bodyId) {
  const occurrences = new Map();
  const taken = new Set();
  return features.map((feature) => {
    const key = [
      feature.type ?? "feature",
      feature.subtype ?? "",
      feature.surface_index ?? feature.floor_surface ?? "",
      Array.isArray(feature.surfaces) ? feature.surfaces.join(",") : "",
    ].join("|");
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const evidence = Array.isArray(feature.evidence) ? feature.evidence : [];
    const needsConfirmation = feature.needs_topology_confirmation === true;
    const normalizedEvidence = evidence.length > 0
      ? evidence
      : feature.surface_index != null
        ? [{source:"analytic_surface", surface_index:feature.surface_index}]
        : feature.floor_surface != null
          ? [{source:"analytic_surface", surface_index:feature.floor_surface}]
          : Array.isArray(feature.surfaces)
            ? feature.surfaces.map(surface_index => ({source:"analytic_surface", surface_index}))
            : [];
    const confidence = finite(feature.confidence) ? Math.max(0, Math.min(1, feature.confidence)) : 0;
    return {
      ...feature,
      feature_id: feature.feature_id ?? stableFeatureId(feature, occurrence, bodyId, taken),
      status: needsConfirmation ? "provisional" : "evidenced",
      confidence,
      evidence: normalizedEvidence,
      evidence_count: normalizedEvidence.length,
      evidence_quality: normalizedEvidence.some(e => e.source === "relation")
        ? "linked_relation"
        : normalizedEvidence.length > 0 ? "analytic_or_metrology" : "none",
    };
  });
}

function semanticEvidenceQuality(relations, features) {
  const relationCount = relations.length;
  const featureCount = features.length;
  const provisionalCount = features.filter(f => f.status === "provisional").length;
  const linkedCount = features.filter(f => f.evidence_quality === "linked_relation").length;
  const validationErrors = features.flatMap(f => {
    const errors = [];
    if (!finite(f.confidence) || f.confidence < 0 || f.confidence > 1) errors.push("invalid_confidence");
    if (typeof f.method !== "string" || !f.method) errors.push("missing_detection_method");
    if (f.status === "provisional" && f.needs_topology_confirmation !== true) errors.push("provisional_without_topology_confirmation");
    if (f.evidence_count !== f.evidence.length) errors.push("evidence_count_mismatch");
    return errors.map(code => ({feature_id:f.feature_id, code}));
  });
  return {
    relation_count: relationCount,
    feature_count: featureCount,
    provisional_feature_count: provisionalCount,
    linked_feature_count: linkedCount,
    validation_error_count: validationErrors.length,
    validation_errors: validationErrors,
    confidence_policy: "geometric_evidence_does_not_prove_design_intent",
  };
}

function manufacturingOperation(feature) {
  const t=feature.type;
  const s=feature.subtype ?? "";
  if (t==="hole_feature_candidate" || t==="cylindrical_feature_candidate") {
    if (s.includes("through_hole")) return "drilling";
    if (s.includes("blind_hole")) return "drilling_blind";
    return "drilling_or_boring";
  }
  if (t==="stepped_cylindrical_feature_candidate" || s.includes("counterbore")) return "counterboring_or_boring";
  if (t==="tapered_feature_candidate" || t==="chamfer_feature_candidate" || s.includes("countersink")) return "chamfering_or_countersinking";
  if (t==="pocket_feature_candidate") return "pocket_milling";
  if (t==="boss_feature_candidate") return "boss_milling_or_bore";
  if (t==="fillet_feature_candidate") return "fillet_or_blend_finishing";
  if (t==="pattern_feature_candidate") return "patterned_feature_machining";
  if (t==="feature_relation_candidate") return s.includes("counterbore") ? "counterboring_or_boring" : "feature_machining";
  if (t==="coaxial_cylindrical_relation") return "boring_or_coaxial_feature_machining";
  return null;
}

function featureToolAxis(feature) {
  if (Array.isArray(feature.axis)) return normalizeAxis(feature.axis);
  if (Array.isArray(feature.axes) && feature.axes.length && Array.isArray(feature.axes[0])) return normalizeAxis(feature.axes[0]);
  return null;
}

function manufacturingAccessibility(feature) {
  const axis=featureToolAxis(feature);
  return {
    status: axis ? "candidate_only" : "undetermined",
    tool_axis: axis,
    setup_direction: axis,
    access_evidence: axis ? "feature_axis_geometry" : "insufficient_geometric_evidence",
    requires_stock_fixture_analysis: true,
  };
}

/** The faces a feature machines, as a key ("" when it names none). */
function featureSurfacesKey(feature) {
  if (feature.surface_index != null) return String(feature.surface_index);
  if (feature.floor_surface != null) return String(feature.floor_surface);
  return Array.isArray(feature.surfaces) ? [...feature.surfaces].sort((a,b)=>a-b).join(",") : "";
}

/** Surfaces an operation works on: those of its feature, and the faces a chamfer or blend meets. */
function featureSurfaces(feature) {
  const list=[feature.surface_index, feature.floor_surface, ...(feature.surfaces ?? []), ...(feature.relation?.surfaces ?? []), ...(feature.adjacent_surfaces ?? [])];
  return [...new Set(list.filter(i=>i!=null))];
}

function manufacturingForBody(body, features, principal, topo) {
  // One operation per operation kind and machined faces: the features that
  // read the same faces the same way share it. The analytic cylinder of a
  // hole candidate is the same hole: it takes the hole's operation.
  const holeOperations=new Map(features
    .filter(f=>f.type==="hole_feature_candidate")
    .map(f=>[f.surface_index, manufacturingOperation(f)]));
  const operations=[];
  const byTarget=new Map();
  for (const feature of features) {
    const operation=(feature.type==="cylindrical_feature_candidate" && holeOperations.get(feature.surface_index)) || manufacturingOperation(feature);
    if (!operation) continue;
    const surfaces=featureSurfacesKey(feature);
    const shared=surfaces ? byTarget.get(operation+"|"+surfaces) : null;
    if (shared) {
      shared.feature_ids.push(feature.feature_id);
      shared.confidence=Math.max(shared.confidence, feature.confidence);
      continue;
    }
    const entry={
      operation_id:"op-"+feature.feature_id,
      feature_ids:[feature.feature_id],
      surfaces:featureSurfaces(feature),
      operation,
      confidence:feature.confidence,
      status:"candidate",
      accessibility:manufacturingAccessibility(feature),
      rationale:feature.method,
    };
    operations.push(entry);
    if (surfaces) byTarget.set(operation+"|"+surfaces, entry);
  }

  // Same precedence and dependencies as the V6 plan (manufacturing-plan.js).
  operations.sort((a,b)=>precedence(a.operation)-precedence(b.operation) || a.operation_id.localeCompare(b.operation_id));
  const dependsOn=new Map();
  for (const edge of operationDependencyGraph(operations)) {
    const list=dependsOn.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    dependsOn.set(edge.to,list);
  }
  const sequence=operations.map((op,i)=>({
    sequence:i+1,
    operation_id:op.operation_id,
    feature_ids:op.feature_ids,
    depends_on:dependsOn.get(op.operation_id) ?? [],
  }));

  // The thinnest wall measured by the Reader: thickness.min is always the
  // "wall" method, whichever method the 3D view shows (app.js thicknessExport).
  const minThickness=finite(body.thickness?.min) ? body.thickness.min : null;
  const functionalThickness={
    minimum_wall_thickness_mm:minThickness,
    source:minThickness!=null ? "reader_wall_thickness" : "not_available",
    status:minThickness!=null ? "measured" : "undetermined",
    warning:minThickness!=null && minThickness < 2 ? "thin_wall_candidate" : null,
  };

  const dfm=[];
  if (!body.closed) dfm.push({code:"open_body",severity:"high",recommendation:"repair_or_close_body_before_manufacturing_analysis"});
  if (topo?.non_manifold_edges>0) dfm.push({code:"non_manifold_geometry",severity:"high",recommendation:"repair_non_manifold_topology"});
  if (minThickness!=null && minThickness < 2) dfm.push({code:"thin_wall",severity:"medium",recommendation:"verify_process_capability_and_clamping"});
  if (features.some(f=>f.status==="provisional")) dfm.push({code:"provisional_feature_intent",severity:"info",recommendation:"confirm_feature_intent_before_generating_toolpaths"});
  if (features.some(f=>f.type==="pattern_feature_candidate")) dfm.push({code:"repeated_features",severity:"info",recommendation:"consider a common setup/tool strategy for repeated features"});
  // Machining candidates only: a closed solid or planar faces say nothing of the process.
  if (!operations.length) dfm.push({code:"no_machining_feature_detected",severity:"info",recommendation:"do_not_assume_a_specific_manufacturing_process_from_geometry_alone"});

  return {
    schema_version:MANUFACTURING_SCHEMA_VERSION,
    process_candidates:[...new Set(operations.map(x=>x.operation))],
    operations,
    sequence,
    accessibility_policy:"geometric_axis_is_not_proof_of_tool_access",
    functional_thickness:functionalThickness,
    dfm_recommendations:dfm,
    confidence_policy:"manufacturing_operations_are_candidates_until_stock_fixture_and_process_constraints_are_known",
    principal_axes:principal,
  };
}

function semanticBody(body, index) {
  // Given with the body when it has no mesh (from the page), with the index of
  // each body in its result when only some of them are given (app.js).
  const topo=body.topology ?? topology(body);
  const sourceIndex=body.source_index ?? index;
  const size=body.bbox?.size ?? [0,0,0];
  const volume=body.volume;
  const envelopeVolume=size.reduce((a,b)=>a*b,1);
  const id="body-"+sourceIndex;
  const graph=faceGraph(body.geometric_surfaces ?? []);
  const relations=surfaceRelations(body.geometric_surfaces ?? [], graph, id);
  const features=normalizeFeatureEvidence(featureCandidates(body,topo,relations,graph), id);
  const semantic = {
    id,
    source_index:sourceIndex,
    name:body.name ?? "Body",
    role:"solid_body",
    metrics:{
      volume_mm3:volume,
      surface_area_mm2:body.area ?? null,
      mass_g:body.mass ?? null,
      centroid_mm:body.centroid ?? null,
      bbox_mm:{min:body.bbox?.min ?? null,max:body.bbox?.max ?? null,size},
      fill_ratio:volume!=null && envelopeVolume>EPS ? volume/envelopeVolume : null,
    },
    topology:topo,
    geometry:{
      method:body.method ?? null,
      surface_types:body.surface_types ?? null,
      analytic_surfaces:body.geometric_surfaces ?? [],
      principal_axes:principalAxes(body),
    },
    features,
    relations,
    quality:{
      closed:!!body.closed,
      evidence:semanticEvidenceQuality(relations, features),
      notes:Array.isArray(body.notes)?body.notes:[],
    },
    manufacturing:manufacturingForBody(body, features, principalAxes(body), topo),
    // The Reader body has no topology of its own: the one computed here.
    foundry: buildFoundryAnalysis({...body, topology:topo}, features, principalAxes(body), FOUNDRY_PROFILE),
  };
  semantic.manufacturing_plan = buildManufacturingPlan(semantic);
  return semantic;
}

/** Build the compact AI-facing semantic contract from a Reader analysis result. */
export function buildSemantic3D(result) {
  if (!result) return null;
  const s=result.summary ?? {};
  return {
    schema:"3d-semantic-json",
    schema_version:SEMANTIC_VERSION,
    feature_schema_version:FEATURE_SCHEMA_VERSION,
    source:{
      file:result.file ?? null,
      kind:result.kind ?? null,
      source_unit:result.source_unit ?? "mm",
      engine:result.engine ?? null,
    },
    units:{length:"mm",area:"mm2",volume:"mm3",mass:"g",density:"g/cm3"},
    model:{
      body_count:s.bodies ?? result.bodies?.length ?? 0,
      solid_count:s.solids ?? null,
      open_body_count:s.open_bodies ?? null,
      metrics:{
        volume_mm3:s.volume ?? null,
        surface_area_mm2:s.area ?? null,
        mass_g:result.density!=null && s.volume!=null ? (s.volume/1000)*result.density : null,
        centroid_mm:s.centroid ?? null,
        bbox_mm:s.bbox ?? null,
        oriented_bbox_mm:s.obb ?? null,
        fill_ratio:s.fill_ratio ?? null,
      },
    },
    bodies:(result.bodies ?? []).map(semanticBody),
    analysis_hints:[...ANALYSIS_HINTS],
    manufacturing_schema_version:MANUFACTURING_SCHEMA_VERSION,
    manufacturing_planning_schema_version:MANUFACTURING_PLANNING_SCHEMA_VERSION,
    foundry_schema_version: FOUNDRY_SCHEMA_VERSION,
    foundry_knowledge_version: FOUNDRY_KNOWLEDGE_VERSION,
  };
}
