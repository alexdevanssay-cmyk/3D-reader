// V7 AI reasoning context compiler.
// Converts the full semantic contract into a compact, evidence-linked context
// for an LLM. It does not invent geometry and never upgrades provisional facts.

const TASKS = new Set(["general", "feature_analysis", "manufacturing_analysis", "dfm", "planning"]);

function finite(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v) { return finite(v) ? Math.max(0, Math.min(1, v)) : 0; }

function evidenceFor(feature) {
  return (feature?.evidence ?? []).map(e => ({ ...e }));
}

function featureContext(feature) {
  return {
    feature_id: feature.feature_id ?? null,
    type: feature.type ?? null,
    subtype: feature.subtype ?? null,
    status: feature.status ?? (feature.needs_topology_confirmation ? "provisional" : "evidenced"),
    confidence: clamp(feature.confidence),
    method: feature.method ?? null,
    evidence: evidenceFor(feature),
    evidence_count: feature.evidence_count ?? evidenceFor(feature).length,
    geometry: Object.fromEntries(Object.entries(feature).filter(([k]) =>
      ["diameter_mm","radius_mm","radii_mm","minor_radius_mm","cone_semi_angle_rad","surface_index","floor_surface","boundary_planes","wall_surfaces","surfaces","centers_mm","axes","adjacent_surfaces","support_or_termination_planes"].includes(k)
    )),
    needs_topology_confirmation: feature.needs_topology_confirmation === true,
  };
}

function operationContext(operation) {
  return {
    operation_id: operation.operation_id,
    feature_ids: [...(operation.feature_ids ?? [])].sort(),
    operation: operation.operation,
    status: operation.status,
    accessibility: operation.accessibility ?? null,
    confidence: clamp(operation.confidence),
  };
}

function bodyContext(body, task) {
  const allFeatures = Array.isArray(body.features) ? body.features : [];
  const features = task === "feature_analysis" ? allFeatures : allFeatures;
  const manufacturing = body.manufacturing ?? {};
  const plan = body.manufacturing_plan ?? null;
  const includeManufacturing = ["manufacturing_analysis","dfm","planning"].includes(task);
  const includeFoundry = includeManufacturing || task === "general";
  const includePlanning = task === "planning";
  return {
    id: body.id ?? null,
    name: body.name ?? null,
    role: body.role ?? null,
    metrics: body.metrics ?? {},
    topology: body.topology ?? null,
    geometry: body.geometry ?? {},
    relations: body.relations ?? [],
    features: features.map(featureContext),
    quality: body.quality ?? {},
    ...(includeManufacturing ? {
      manufacturing: {
        process_candidates: manufacturing.process_candidates ?? [],
        operations: (manufacturing.operations ?? []).map(operationContext),
        functional_thickness: manufacturing.functional_thickness ?? null,
        dfm_recommendations: manufacturing.dfm_recommendations ?? [],
      }
    } : {}),
    ...(includePlanning ? { manufacturing_plan: plan } : {}),
    ...(includeFoundry ? { foundry: body.foundry ?? null } : {}),
  };
}

function modelFacts(semantic) {
  return {
    body_count: semantic.model?.body_count ?? null,
    solid_count: semantic.model?.solid_count ?? null,
    metrics: semantic.model?.metrics ?? {},
    principal_axes: semantic.model?.principal_axes ?? null,
  };
}

function selectFeatures(semantic, featureIds) {
  if (!Array.isArray(featureIds) || !featureIds.length) return null;
  const wanted = new Set(featureIds);
  return (semantic.bodies ?? []).flatMap(body =>
    (body.features ?? []).filter(f => wanted.has(f.feature_id)).map(f => ({ body_id: body.id, ...featureContext(f) }))
  );
}

export function buildAIContext(semantic, options = {}) {
  if (!semantic || semantic.schema !== "3d-semantic-json") {
    throw new TypeError("A valid 3D semantic contract is required");
  }
  const requestedTask = options.task ?? "general";
  const task = TASKS.has(requestedTask) ? requestedTask : "general";
  const selected = selectFeatures(semantic, options.featureIds);
  // Feature ids are scoped by body (body-0/feature-…): one id names one feature.
  const found = new Set(selected?.map(s => s.feature_id));
  const source = semantic.source ?? {};
  const warnings = [];
  if (semantic.analysis_hints?.length) warnings.push(...semantic.analysis_hints);
  if (selected && options.featureIds.some(id => !found.has(id))) warnings.push("some_requested_features_not_found");
  const bodies = (semantic.bodies ?? []).map(body => bodyContext(body, task));
  if (task === "feature_analysis" && selected) {
    for (const body of bodies) body.features = body.features.filter(f => found.has(f.feature_id));
  }
  const provisional = bodies.flatMap(b => b.features).filter(f => f.status === "provisional");
  const evidenceErrors = bodies.flatMap(b => b.quality?.evidence?.validation_errors ?? []);

  return {
    schema: "3d-ai-reasoning-context",
    schema_version: "1.0",
    semantic_schema_version: semantic.schema_version ?? null,
    feature_schema_version: semantic.feature_schema_version ?? null,
    foundry_schema_version: semantic.foundry_schema_version ?? null,
    foundry_knowledge_version: semantic.foundry_knowledge_version ?? null,
    manufacturing_schema_version: semantic.manufacturing_schema_version ?? null,
    manufacturing_planning_schema_version: semantic.manufacturing_planning_schema_version ?? null,
    task,
    source: {
      file: source.file ?? null,
      kind: source.kind ?? null,
      source_unit: source.source_unit ?? null,
      engine: source.engine ?? null,
    },
    model: modelFacts(semantic),
    bodies,
    focus: {
      feature_ids: options.featureIds ?? [],
      selected_feature_count: selected ? selected.length : null,
    },
    warnings,
    uncertainty: {
      provisional_feature_count: provisional.length,
      validation_error_count: evidenceErrors.length,
      policy: "evidenced facts may be stated; provisional features are hypotheses and must not be treated as confirmed design intent",
    },
    reasoning_contract: {
      use_only_provided_geometry: true,
      preserve_units: true,
      never_invent_dimensions: true,
      distinguish_measurement_inference_recommendation: true,
      cite_feature_or_relation_ids_for_conclusions: true,
      surface_missing_or_unverified_constraints: true,
      manufacturing_outputs_are_candidates_not_executable_cam: true,
      foundry_geometry_screen_is_not_a_filling_or_solidification_simulation: true,
      foundry_numeric_limits_require_process_and_alloy_context: true,
      foundry_risks_must_be_cited_to_geometry_evidence_or_knowledge_source_ids: true,
    },
  };
}

// --------------------------------------------------------------------------- compact context

const DIMENSION_KEYS = ["diameter_mm", "radius_mm", "minor_radius_mm", "cone_semi_angle_rad"];
const round = (v, d = 3) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

function roundDeep(value) {
  if (finite(value)) return round(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  return value;
}

/** A feature without its evidence lists: its kind, status and main dimensions. */
function slimFeature(feature) {
  const out = { feature_id: feature.feature_id, type: feature.type, status: feature.status, confidence: round(feature.confidence, 2) };
  if (feature.subtype) out.subtype = feature.subtype;
  for (const k of DIMENSION_KEYS) if (finite(feature.geometry?.[k])) out[k] = round(feature.geometry[k]);
  return out;
}

/** Features grouped by type: counts and the distinct dimensions (largest first). */
function featureGroups(features) {
  const groups = new Map();
  for (const f of features) {
    const key = `${f.type}|${f.subtype ?? ""}`;
    const g = groups.get(key) ?? { type: f.type, ...(f.subtype ? { subtype: f.subtype } : {}), count: 0, evidenced: 0, provisional: 0, diameters_mm: new Set() };
    g.count++;
    if (f.status === "provisional") g.provisional++;
    else g.evidenced++;
    const d = f.geometry?.diameter_mm ?? (finite(f.geometry?.radius_mm) ? 2 * f.geometry.radius_mm : null);
    if (finite(d)) g.diameters_mm.add(round(d, 2));
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const diameters = [...g.diameters_mm].sort((a, b) => b - a);
    const { diameters_mm, ...rest } = g;
    return { ...rest, ...(diameters.length ? { diameters_mm: diameters.slice(0, 12), ...(diameters.length > 12 ? { more_diameters: diameters.length - 12 } : {}) } : {}) };
  });
}

function relationCounts(relations) {
  const counts = {};
  for (const r of relations ?? []) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return counts;
}

/**
 * A smaller copy of an AI context (buildAIContext) for models with a small
 * context window (a local LLM): the same facts, less detail, until its JSON
 * fits in `maxChars`. Levels: 1 the per-surface geometry and the evidence
 * lists left out, the foundry knowledge common to every body given once;
 * 2 the features grouped by type; 3 only the largest bodies in detail;
 * 4 the bodies reduced to their metrics. What was left out is listed in
 * `compaction.omitted`, so that the model knows the context is partial.
 */
export function compactAIContext(context, { maxChars = 16000, detailedBodies = 6 } = {}) {
  const size = (o) => JSON.stringify(o).length;
  const common = {};
  const bodies1 = context.bodies.map((body) => {
    const { analytic_surfaces, ...geometry } = body.geometry ?? {};
    let foundry = body.foundry ?? null;
    if (foundry) {
      const { sources, simulation_boundary, confidence_policy, engineering_inputs, ...own } = foundry;
      common.sources ??= (sources ?? []).map(({ id, title, publisher }) => ({ id, title, publisher }));
      common.simulation_boundary ??= simulation_boundary;
      common.confidence_policy ??= confidence_policy;
      common.engineering_inputs ??= engineering_inputs;
      foundry = own;
    }
    return {
      id: body.id, name: body.name, role: body.role,
      metrics: roundDeep(body.metrics),
      geometry: { ...roundDeep(geometry), analytic_surface_count: Array.isArray(analytic_surfaces) ? analytic_surfaces.length : 0 },
      relation_counts: relationCounts(body.relations),
      features: (body.features ?? []).map(slimFeature),
      ...(body.manufacturing ? { manufacturing: roundDeep(body.manufacturing) } : {}),
      ...(body.manufacturing_plan ? { manufacturing_plan: roundDeep(body.manufacturing_plan) } : {}),
      foundry,
      _features: body.features ?? [],
    };
  });
  const omitted = ["analytic surfaces", "feature and relation evidence lists"];
  const strip = (bodies) => bodies.map(({ _features, ...b }) => b);
  const build = (bodies, level) => ({
    ...context,
    bodies: strip(bodies),
    foundry_common: Object.keys(common).length ? common : undefined,
    compaction: { level, omitted: [...omitted], original_body_count: context.bodies.length },
  });

  let out = build(bodies1, 1);
  if (size(out) <= maxChars) return out;

  // 2: features grouped by type, operations summarized.
  omitted.push("individual features (grouped by type)");
  const bodies2 = bodies1.map((b) => ({
    ...b,
    features: undefined,
    feature_groups: featureGroups(b._features),
    ...(b.manufacturing ? { manufacturing: {
      process_candidates: b.manufacturing.process_candidates,
      operation_count: b.manufacturing.operations?.length ?? 0,
      functional_thickness: b.manufacturing.functional_thickness,
      dfm_recommendations: b.manufacturing.dfm_recommendations,
    } } : {}),
    ...(b.manufacturing_plan ? { manufacturing_plan: { summary: b.manufacturing_plan.summary ?? null, setup_count: b.manufacturing_plan.setups?.length ?? null } } : {}),
  }));
  out = build(bodies2, 2);
  if (size(out) <= maxChars) return out;

  // 3: only the largest bodies in detail.
  const byVolume = [...bodies2].sort((a, b) => (b.metrics?.volume_mm3 ?? 0) - (a.metrics?.volume_mm3 ?? 0));
  const detailed = new Set(byVolume.slice(0, detailedBodies).map((b) => b.id));
  const brief = (b) => ({ id: b.id, name: b.name, role: b.role, metrics: { volume_mm3: b.metrics?.volume_mm3 ?? null, surface_area_mm2: b.metrics?.surface_area_mm2 ?? null, bbox_size_mm: b.metrics?.bbox_mm?.size ?? null }, feature_count: b._features.length });
  if (context.bodies.length > detailedBodies) {
    omitted.push(`details of the ${context.bodies.length - detailedBodies} smallest bodies`);
    out = build(bodies2.map((b) => (detailed.has(b.id) ? b : brief(b))), 3);
    if (size(out) <= maxChars) return out;
  }

  // 4: every body reduced to its metrics and feature counts; the foundry screen of the largest one.
  omitted.push("per-body foundry and manufacturing details (kept for the largest body only)");
  const largest = byVolume[0]?.id;
  const level4 = (b) => (b.id === largest ? { ...brief(b), feature_groups: b.feature_groups, foundry: b.foundry } : brief(b));
  out = build(bodies2.map(level4), 4);
  if (size(out) <= maxChars) return out;

  // 5: a large assembly. The first warnings only, then only the largest bodies
  // listed, the others counted: the context always fits the window of a local
  // model (a longer prompt would be cut by Ollama, the model reading part of it).
  const warningCount = (context.warnings ?? []).length;
  const fewWarnings = (o) => ({ ...o, warnings: (o.warnings ?? []).slice(0, 5), ...(warningCount > 5 ? { warning_count: warningCount } : {}) });
  if (warningCount > 5) omitted.push(`${warningCount - 5} warnings`);
  out = fewWarnings(build(bodies2.map(level4), 5));
  if (size(out) <= maxChars) return out;
  const omittedBefore = [...omitted];
  for (const keep of [24, 12, 6, 3, 1]) {
    if (keep >= byVolume.length) continue;
    const rest = byVolume.slice(keep);
    omitted.splice(0, omitted.length, ...omittedBefore, `the ${rest.length} smallest bodies (counted in other_bodies)`);
    out = fewWarnings({
      ...build(byVolume.slice(0, keep).map(level4), 5), // the largest first
      other_bodies: { count: rest.length, volume_mm3: Math.round(rest.reduce((s, b) => s + (b.metrics?.volume_mm3 ?? 0), 0)) },
    });
    if (size(out) <= maxChars) return out;
  }
  // Last resort: the largest body without its foundry screen.
  omitted.push("foundry screen of the largest body");
  return { ...out, bodies: out.bodies.map(({ foundry, feature_groups, ...b }) => b), compaction: { ...out.compaction, omitted: [...omitted] } };
}

/**
 * A short summary of an AI context, for conversation and general questions:
 * the model's size and the bodies' metrics only (a local model on a CPU reads
 * it in seconds). The detailed context is for the analysis tasks.
 */
export function summaryAIContext(context) {
  const r = (v) => (finite(v) ? Math.round(v * 100) / 100 : v ?? null);
  const bodies = (context.bodies ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    closed: b.quality?.closed ?? null,
    volume_mm3: r(b.metrics?.volume_mm3),
    surface_area_mm2: r(b.metrics?.surface_area_mm2),
    bbox_size_mm: (b.metrics?.bbox_mm?.size ?? []).map(r),
    feature_count: (b.features ?? []).length,
  }));
  const largest = [...bodies].sort((a, b) => (b.volume_mm3 ?? 0) - (a.volume_mm3 ?? 0)).slice(0, 12);
  return {
    schema: context.schema,
    schema_version: context.schema_version,
    task: context.task,
    summary_only: true,
    note: "Résumé de la pièce : pour le détail (features, fabrication, fonderie), choisir une analyse dédiée.",
    source: context.source,
    model: roundDeep(context.model),
    body_count: bodies.length,
    bodies: largest,
    ...(bodies.length > largest.length ? { other_bodies: bodies.length - largest.length } : {}),
  };
}

export const AI_CONTEXT_VERSION = "1.0";
export const AI_CONTEXT_TASKS = [...TASKS];
