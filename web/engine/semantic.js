// Semantic intermediate representation for AI reasoning.
//
// V1 deliberately keeps the raw tessellation out of the public semantic payload.
// It derives stable metrology, topology and geometric feature candidates from the
// existing Reader result. CAD surface classes are supplied by cad.js when available.
//
// Contract version: 1.0
export const SEMANTIC_VERSION = "1.0";

const EPS = 1e-9;\nconst FEATURE_SCHEMA_VERSION = "2.0";

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

  // Cylindrical faces become hole candidates only when the B-rep supplies enough
  // evidence to distinguish an actual cylindrical wall from a boss/outer surface.
  // V2 therefore emits "cylindrical_feature_candidate", never an unconditional hole.
  const cylinders=(body.geometric_surfaces ?? []).filter(x=>x.type==="cylinder" && finite(x.radius_mm));
  for (const c of cylinders) {
    const axial = Math.max(...s);
    const likelyThrough = c.radius_mm > 0 && axial > 0 && axial / (2*c.radius_mm) > 1.5;
    out.push({
      type:"cylindrical_feature_candidate",
      subtype:likelyThrough ? "possible_hole_or_bore" : "cylindrical_surface",
      confidence:likelyThrough ? 0.7 : 0.55,
      method:"analytic_surface",
      radius_mm:c.radius_mm,
      diameter_mm:2*c.radius_mm,
      axis:c.axis ?? null,
      center_mm:c.center_mm ?? null,
      needs_topology_confirmation:true
    });
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
    schema_version:SEMANTIC_VERSION,\n    feature_schema_version:FEATURE_SCHEMA_VERSION,
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
