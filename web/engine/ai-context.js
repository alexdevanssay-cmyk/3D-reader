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
      ["diameter_mm","radius_mm","minor_radius_mm","cone_semi_angle_rad","surface_index","floor_surface","boundary_planes","wall_surfaces","surfaces","centers_mm","axes","adjacent_surfaces","support_or_termination_planes"].includes(k)
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
  const source = semantic.source ?? {};
  const warnings = [];
  if (semantic.analysis_hints?.length) warnings.push(...semantic.analysis_hints);
  if (selected && selected.length < options.featureIds.length) warnings.push("some_requested_features_not_found");
  const bodies = (semantic.bodies ?? []).map(body => bodyContext(body, task));
  if (task === "feature_analysis" && selected) {
    for (const body of bodies) body.features = body.features.filter(f => selected.some(s => s.feature_id === f.feature_id));
  }
  const provisional = bodies.flatMap(b => b.features).filter(f => f.status === "provisional");
  const evidenceErrors = bodies.flatMap(b => b.quality?.evidence?.validation_errors ?? []);

  return {
    schema: "3d-ai-reasoning-context",
    schema_version: "1.0",
    semantic_schema_version: semantic.schema_version ?? null,
    feature_schema_version: semantic.feature_schema_version ?? null,
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
    warnings,\n    uncertainty: {
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
    },
  };
}

export const AI_CONTEXT_VERSION = "1.0";
export const AI_CONTEXT_TASKS = [...TASKS];
