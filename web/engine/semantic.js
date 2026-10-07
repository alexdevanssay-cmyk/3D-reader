// Semantic intermediate representation for AI reasoning.
//
// V1 deliberately keeps the raw tessellation out of the public semantic payload.
// It derives stable metrology, topology and geometric feature candidates from the
// existing Reader result. CAD surface classes are supplied by cad.js when available.
//
// Contract version: 1.0
export const SEMANTIC_VERSION = "1.0";

const EPS = 1e-9;
const FEATURE_SCHEMA_VERSION = "2.0";

function finite(v) { return typeof v === "number" && Number.isFinite(v); }
function dist(a, b) { const x=a[0]-b[0], y=a[1]-b[1], z=a[2]-b[2]; return Math.hypot(x,y,z); }

function topology(body) {
  const p = body.mesh?.positions;
  const f = body.mesh?.indices;
  if (!p || !f) return null;
  const nv = Math.floor(p.length / 3);
  const nf = Math.floor(f.length / 3);
  const edges = new Map();
  let degenerate = 0;
  for (let i=0;i<nf;i++) {
    const a=f[3*i], b=f[3*i+1], c=f[3*i+2];
    if (a===b || b===c || a===c) degenerate++;
    for (const [u,v] of [[a,b],[b,c],[c,a]]) {
      const lo=Math.min(u,v), hi=Math.max(u,v), k=lo+","+hi;
      edges.set(k,(edges.get(k)||0)+1);
    }
  }
  let boundary=0, nonManifold=0;
  for (const n of edges.values()) {
    if (n===1) boundary++;
    else if (n!==2) nonManifold++;
  }
  return {
    vertices: nv,
    triangles: nf,
    unique_edges: edges.size,
    boundary_edges: boundary,
    non_manifold_edges: nonManifold,
    degenerate_triangles: degenerate,
    watertight: boundary===0 && nonManifold===0,
  };
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

function axisDistance(a, b) {
  const aa=normalizeAxis(a), bb=normalizeAxis(b);
  if (!aa || !bb) return Infinity;
  const parallel = Math.abs(Math.abs(aa[0]*bb[0]+aa[1]*bb[1]+aa[2]*bb[2]) - 1);
  if (parallel > 1e-5) return Infinity;
  const d=[(b?.[0]??0)-(a?.[0]??0),(b?.[1]??0)-(a?.[1]??0),(b?.[2]??0)-(a?.[2]??0)];
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

function cylindricalRelations(cylinders, cones, surfaces) {
  const relations=[];
  const adjacency=faceAdjacency(surfaces);
  const neighbors=new Map();
  for(const rel of adjacency){
    for(const [a,b] of [[rel.faces[0],rel.faces[1]],[rel.faces[1],rel.faces[0]]]){
      const list=neighbors.get(a)??[];
      list.push({face:b,shared_edges:rel.shared_edges});
      neighbors.set(a,list);
    }
  }
  for (let i=0;i<cylinders.length;i++) {
    for (let j=i+1;j<cylinders.length;j++) {
      const a=cylinders[i], b=cylinders[j];
      if (Math.abs(a.radius_mm-b.radius_mm)>Math.max(1e-5,Math.min(a.radius_mm,b.radius_mm)*1e-4)) continue;
      if (axisDistance(a.center_mm,b.center_mm)>Math.max(1e-4,Math.min(a.radius_mm,b.radius_mm)*1e-3)) continue;
      relations.push({type:"coaxial_cylinders", surfaces:[a.index,b.index], radius_mm:a.radius_mm, confidence:0.94});
    }
  }
  for (const c of cylinders) {
    for (const cone of cones) {
      if (axisDistance(c.center_mm,cone.center_mm)>Math.max(1e-4,c.radius_mm*1e-3)) continue;
      relations.push({
        type:"coaxial_cylinder_cone",
        surfaces:[c.index,cone.index],
        diameter_mm:c.diameter_mm,
        cone_ref_radius_mm:cone.ref_radius_mm ?? null,
        confidence:0.9,
      });
    }
    const adjacent_planes=(neighbors.get(c.index)??[]).map(x=>surfaces.find(f=>f.index===x.face)).filter(f=>f?.type==="plane");
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

function featureCandidates(body, topo) {
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
  const relations=cylindricalRelations(cylinders,cones,surfaces);

  for (const c of cylinders) {
    const axial = Math.max(...s);
    const likelyThrough = c.radius_mm > 0 && axial > 0 && axial / (2*c.radius_mm) > 1.5;
    const boundaryEvidence = c.edge_count === 2 || c.wire_count === 2;
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
      needs_topology_confirmation:!(boundaryEvidence && likelyThrough)
    });
  }

  for (const r of relations) {
    if (r.type==="coaxial_cylinder_cone") {
      out.push({
        type:"stepped_cylindrical_feature_candidate",
        subtype:"possible_countersink_or_taper_transition",
        relation:r,
        confidence:0.78,
        method:"coaxial_analytic_surfaces",
        needs_topology_confirmation:true
      });
    } else if (r.type==="coaxial_cylinders") {
      out.push({
        type:"stepped_cylindrical_feature_candidate",
        subtype:"possible_counterbore_or_coaxial_step",
        relation:r,
        confidence:0.74,
        method:"coaxial_analytic_surfaces",
        needs_topology_confirmation:true
      });
    }
  }

  return out;
}

function semanticBody(body, index) {
  const topo=topology(body);
  const size=body.bbox?.size ?? [0,0,0];
  const volume=body.volume;
  const envelopeVolume=size.reduce((a,b)=>a*b,1);
  return {
    id: "body-"+index,
    source_index:index,
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
    features:featureCandidates(body,topo),
    quality:{
      closed:!!body.closed,
      notes:Array.isArray(body.notes)?body.notes:[],
    },
  };
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
    analysis_hints:[
      "features are geometric candidates, not guaranteed design intent",
      "raw tessellation is intentionally excluded from this AI payload",
      "use source_index to map semantic bodies back to Reader bodies",
    ],
  };
}
