// V7 AI reasoning context compiler.
// Converts the full semantic contract into a compact, evidence-linked context
// for an LLM. It does not invent geometry and never upgrades provisional facts.

import { ANALYSIS_HINTS } from "./analysis-hints.js";

const TASKS = new Set(["general", "feature_analysis", "manufacturing_analysis", "dfm", "planning"]);

function finite(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v) { return finite(v) ? Math.max(0, Math.min(1, v)) : 0; }

// Keys of a semantic feature that are not its geometry: they have their own
// fields in the context, or describe the detection rather than the part. Every
// other key is geometry, so that a new geometric field is not silently dropped.
const NON_GEOMETRY_KEYS = new Set([
  "feature_id", "type", "subtype", "status", "confidence", "method", "evidence", "evidence_count",
  "evidence_quality", "needs_topology_confirmation", "interpretation", "relation",
]);

function evidenceFor(feature) {
  return (feature?.evidence ?? []).map(e => ({ ...e }));
}

function featureGeometry(feature) {
  // Stepped and coaxial features carry the surfaces and dimensions of their relation themselves.
  return Object.fromEntries(Object.entries(feature).filter(([k]) => !NON_GEOMETRY_KEYS.has(k)));
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
    geometry: featureGeometry(feature),
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

/** The parting line of a body, compact: its direction, its undercut and zero-draft shares, planar or not. */
function partingContext(p) {
  const line = p.parting ?? null;
  return {
    status: p.status ?? null,
    axis: p.axis ?? null,
    direction: p.direction ?? null,
    undercut_share: p.undercut_share ?? null,
    zero_draft_share: p.zero_draft_share ?? null,
    planar: line?.planar ?? null,
    ...(line?.planar === false ? { kind: line.kind, height_range_mm: line.height_range_mm } : {}),
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
    ...(body.parting ? { parting: partingContext(body.parting) } : {}),
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

const DIMENSION_KEYS = ["diameter_mm", "radius_mm", "minor_radius_mm", "cone_semi_angle_rad", "semi_angle_rad", "cylinder_diameter_mm"];
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

/** The distinct sizes of a group, largest first: the first 12 under `key`, the others counted under `more`. */
function sizeList(sizes, key, more) {
  const sorted = [...sizes].sort((a, b) => b - a);
  return sorted.length ? { [key]: sorted.slice(0, 12), ...(sorted.length > 12 ? { [more]: sorted.length - 12 } : {}) } : {};
}

/** Features grouped by type: counts and the distinct dimensions (largest first). */
function featureGroups(features) {
  const groups = new Map();
  for (const f of features) {
    const key = `${f.type}|${f.subtype ?? ""}`;
    const g = groups.get(key) ?? { type: f.type, ...(f.subtype ? { subtype: f.subtype } : {}), count: 0, evidenced: 0, provisional: 0, diameters_mm: new Set(), radii_mm: new Set() };
    g.count++;
    if (f.status === "provisional") g.provisional++;
    else g.evidenced++;
    if (f.type === "fillet_feature_candidate") {
      // A fillet is sized by its radius: an R5 rounded edge is no Ø10.
      const r = f.geometry?.radius_mm ?? f.geometry?.minor_radius_mm;
      if (finite(r)) g.radii_mm.add(round(r, 2));
    } else {
      const d = f.geometry?.diameter_mm ?? (finite(f.geometry?.radius_mm) ? 2 * f.geometry.radius_mm : null);
      if (finite(d)) g.diameters_mm.add(round(d, 2));
    }
    groups.set(key, g);
  }
  return [...groups.values()].map(({ diameters_mm, radii_mm, ...rest }) => ({
    ...rest,
    ...sizeList(diameters_mm, "diameters_mm", "more_diameters"),
    ...sizeList(radii_mm, "radii_mm", "more_radii"),
  }));
}

function relationCounts(relations) {
  const counts = {};
  for (const r of relations ?? []) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return counts;
}

// Features that repeat other fields of their body: the closed solid (quality),
// the kinds of surfaces (geometry), the fill ratio (metrics), the cylinders
// bounded by planes (relation_counts).
const REPEATED_FEATURES = new Set(["closed_solid", "cylindrical_geometry", "planar_geometry", "low_fill_ratio_geometry", "cylindrical_boundary_relation"]);

// The provisional features listed first when not all fit: the bores and holes,
// then the patterns, pockets and fillets, then the bosses; the other candidates
// (a cylinder of unknown use, a relation between features) last.
const FEATURE_ORDER = ["hole_feature_candidate", "stepped_cylindrical_feature_candidate", "coaxial_cylindrical_relation", "pattern_feature_candidate", "pocket_feature_candidate", "fillet_feature_candidate", "boss_feature_candidate"];
const featureRank = (f) => {
  const i = FEATURE_ORDER.indexOf(f.type);
  return i < 0 ? FEATURE_ORDER.length : i;
};

/** How many of `items` of each kind (`kind` of an item). */
function countBy(items, kind) {
  const counts = {};
  for (const item of items) counts[kind(item)] = (counts[kind(item)] ?? 0) + 1;
  return counts;
}

/**
 * The foundry screen of a body without what repeats its body (closed,
 * topology, principal axes) nor the rules not evaluated ("not_…"): its
 * profile, the thickness and feature counts it read, the rules it could
 * evaluate, its risks and the checks it requires.
 */
function shortFoundry(foundry) {
  const { schema_version, knowledge_version, evidence, rules, ...own } = foundry;
  const evaluated = Object.entries(rules ?? {}).filter(([, v]) => !(typeof v === "string" && /^not_/.test(v)));
  return {
    ...own,
    evidence: { thickness: evidence?.thickness ?? null, feature_counts: evidence?.feature_counts ?? null },
    ...(evaluated.length ? { rules: Object.fromEntries(evaluated) } : {}),
  };
}

/**
 * A smaller copy of an AI context (buildAIContext) for a model with a small
 * context window (the gateway's budget, a local LLM): the same facts, less
 * detail, until its JSON fits in `maxChars`. What is given up first is what
 * matters least: the geometry of the part comes first, then how it is made by
 * the right process, then the machining plan and its times. Levels:
 *   1 the per-surface geometry and the evidence lists left out, the foundry
 *     knowledge common to every body given once;
 *   2 what repeats other fields or the instructions: the features repeating
 *     their body (counted), the notes of every analysis, the reasoning rules,
 *     the foundry knowledge and screens in short;
 *   3 the machining plan summarized (operations in order, readiness);
 *   4 the process in short: the operations counted by kind, the foundry
 *     screen reduced to its profile, risks and checks;
 *   5 the provisional features listed as the budget allows, bores and holes
 *     first, the others grouped by type (the evidenced ones listed);
 *   6 every feature grouped by type;
 *   7 only the largest bodies in detail;
 *   8 the bodies reduced to their metrics, the largest with its feature
 *     groups and foundry screen;
 *   9 a large assembly: the first warnings, the largest bodies listed, the
 *     others counted; then, as a last resort, no foundry screen and fewer
 *     warnings.
 * What was left out is listed in `compaction.omitted`, so that the model
 * knows the context is partial.
 */
export function compactAIContext(context, { maxChars = 16000, detailedBodies = 6 } = {}) {
  const size = (o) => JSON.stringify(o).length;
  let common = {};
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
      ...(body.parting ? { parting: body.parting } : {}),
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
  let top = context; // the fields besides the bodies
  const build = (bodies, level) => ({
    ...top,
    bodies: strip(bodies),
    foundry_common: Object.keys(common).length ? common : undefined,
    compaction: { level, omitted: [...omitted], original_body_count: context.bodies.length },
  });

  let out = build(bodies1, 1);
  if (size(out) <= maxChars) return out;

  // 2: what repeats other fields, or the instructions of the model.
  omitted.push("features repeating other fields of their body (counted in repeated_features)", "notes and reasoning rules common to every analysis (given in the instructions)", "foundry evidence repeating the body, foundry rules not evaluated");
  const { reasoning_contract, ...rest } = context;
  const hints = new Set(ANALYSIS_HINTS);
  top = { ...rest, warnings: (context.warnings ?? []).filter((w) => !hints.has(w)) };
  if (Object.keys(common).length) {
    common = {
      sources: (common.sources ?? []).map(({ id, title }) => ({ id, title })),
      simulation_boundary: common.simulation_boundary?.message ?? common.simulation_boundary ?? null,
      confidence_policy: common.confidence_policy ?? null,
      engineering_inputs: { required: common.engineering_inputs?.required ?? [] },
    };
  }
  const bodies2 = bodies1.map((b) => {
    const repeated = b._features.filter((f) => REPEATED_FEATURES.has(f.type));
    return {
      ...b,
      features: b.features.filter((f) => !REPEATED_FEATURES.has(f.type)),
      ...(repeated.length ? { repeated_features: countBy(repeated, (f) => f.type) } : {}),
      ...(b.foundry ? { foundry: shortFoundry(b.foundry) } : {}),
      _features: b._features.filter((f) => !REPEATED_FEATURES.has(f.type)),
    };
  });
  out = build(bodies2, 2);
  if (size(out) <= maxChars) return out;

  // 3: the machining plan (and its times) summarized.
  omitted.push("machining plan details (setups, dependencies, constraints)");
  const bodies3 = bodies2.map((b) => (b.manufacturing_plan ? { ...b, manufacturing_plan: {
    operation_count: b.manufacturing_plan.operation_count ?? null,
    setup_count: b.manufacturing_plan.setup_count ?? b.manufacturing_plan.setups?.length ?? null,
    planned_order: (b.manufacturing_plan.planned_order ?? []).map((s) => s.operation),
    readiness: b.manufacturing_plan.readiness?.status ?? null,
    unresolved_constraints: b.manufacturing_plan.readiness?.unresolved_constraints ?? [],
  } } : b));
  out = build(bodies3, 3);
  if (size(out) <= maxChars) return out;

  // 4: the process in short.
  omitted.push("individual operations (counted by kind)", "foundry screen details (profile, risks and checks kept)");
  const bodies4 = bodies3.map((b) => ({
    ...b,
    ...(b.manufacturing ? { manufacturing: {
      process_candidates: b.manufacturing.process_candidates,
      operations: countBy(b.manufacturing.operations ?? [], (o) => o.operation),
      functional_thickness: b.manufacturing.functional_thickness,
      dfm_recommendations: b.manufacturing.dfm_recommendations,
    } } : {}),
    ...(b.foundry ? { foundry: {
      profile: b.foundry.profile?.label ?? b.foundry.profile?.id ?? null,
      ...(b.foundry.evidence?.thickness ? { thickness: b.foundry.evidence.thickness } : {}),
      risks: (b.foundry.risks ?? []).map(({ code, severity, message }) => ({ code, severity, message })),
      required_checks: b.foundry.required_checks ?? [],
    } } : {}),
  }));
  out = build(bodies4, 4);
  if (size(out) <= maxChars) return out;

  // 5: the provisional features listed as the budget allows, the bores and holes first (FEATURE_RANK), the
  // others grouped by type; the evidenced ones listed.
  omitted.push("provisional features past the budget (grouped by type)");
  const ranked = bodies4
    .flatMap((b, bi) => b._features.map((f, fi) => ({ bi, fi, f })).filter(({ f }) => f.status === "provisional"))
    .sort((x, y) => featureRank(x.f) - featureRank(y.f) || x.bi - y.bi || x.fi - y.fi);
  const listing = (count) => {
    const listed = new Set(ranked.slice(0, count).map(({ f }) => f));
    return bodies4.map((b) => {
      const grouped = b._features.filter((f) => f.status === "provisional" && !listed.has(f));
      return {
        ...b,
        features: b._features.filter((f) => f.status !== "provisional" || listed.has(f)).map(slimFeature),
        ...(grouped.length ? { provisional_feature_groups: featureGroups(grouped) } : {}),
      };
    });
  };
  // The most features listed that fit (none listed: every provisional one grouped).
  let [low, high] = [0, ranked.length - 1];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(build(listing(mid), 5)) <= maxChars) low = mid;
    else high = mid - 1;
  }
  const bodies5 = listing(low);
  out = build(bodies5, 5);
  if (size(out) <= maxChars) return out;

  // 6: every feature grouped by type.
  omitted.push("individual features (grouped by type)");
  const bodies6 = bodies5.map(({ features, provisional_feature_groups, ...b }) => ({ ...b, feature_groups: featureGroups(b._features) }));
  out = build(bodies6, 6);
  if (size(out) <= maxChars) return out;

  // 7: only the largest bodies in detail.
  const byVolume = [...bodies6].sort((a, b) => (b.metrics?.volume_mm3 ?? 0) - (a.metrics?.volume_mm3 ?? 0));
  const detailed = new Set(byVolume.slice(0, detailedBodies).map((b) => b.id));
  const brief = (b) => ({ id: b.id, name: b.name, role: b.role, metrics: { volume_mm3: b.metrics?.volume_mm3 ?? null, surface_area_mm2: b.metrics?.surface_area_mm2 ?? null, bbox_size_mm: b.metrics?.bbox_mm?.size ?? null }, ...(b.parting ? { parting: b.parting } : {}), feature_count: b._features.length });
  if (context.bodies.length > detailedBodies) {
    omitted.push(`details of the ${context.bodies.length - detailedBodies} smallest bodies`);
    out = build(bodies6.map((b) => (detailed.has(b.id) ? b : brief(b))), 7);
    if (size(out) <= maxChars) return out;
  }

  // 8: every body reduced to its metrics and feature counts; the feature groups and foundry screen of the largest one.
  omitted.push("per-body foundry and manufacturing details (kept for the largest body only)");
  const largest = byVolume[0]?.id;
  const level8 = (b) => (b.id === largest ? { ...brief(b), feature_groups: b.feature_groups, foundry: b.foundry } : brief(b));
  out = build(bodies6.map(level8), 8);
  if (size(out) <= maxChars) return out;

  // 9: a large assembly. The first warnings only, then only the largest bodies
  // listed, the others counted: the context always fits the window of a local
  // model (a longer prompt would be cut by Ollama, the model reading part of it).
  const warnings = top.warnings ?? [];
  const warningCount = warnings.length;
  const fewWarnings = (o) => ({ ...o, warnings: warnings.slice(0, 5), ...(warningCount > 5 ? { warning_count: warningCount } : {}) });
  if (warningCount > 5) omitted.push(`${warningCount - 5} warnings`);
  out = fewWarnings(build(bodies6.map(level8), 9));
  if (size(out) <= maxChars) return out;
  const omittedBefore = [...omitted];
  for (const keep of [24, 12, 6, 3, 1]) {
    if (keep >= byVolume.length) continue;
    const others = byVolume.slice(keep);
    omitted.splice(0, omitted.length, ...omittedBefore, `the ${others.length} smallest bodies (counted in other_bodies)`);
    out = fewWarnings({
      ...build(byVolume.slice(0, keep).map(level8), 9), // the largest first
      other_bodies: { count: others.length, volume_mm3: Math.round(others.reduce((s, b) => s + (b.metrics?.volume_mm3 ?? 0), 0)) },
    });
    if (size(out) <= maxChars) return out;
  }
  // Last resort: the largest body without its foundry screen, nor the foundry notes that only explain it.
  omitted.push("foundry screen of the largest body", "foundry sources and policies");
  const { foundry_common, ...kept } = out;
  out = { ...kept, bodies: out.bodies.map(({ foundry, feature_groups, ...b }) => b), compaction: { ...out.compaction, omitted: [...omitted] } };
  // Still over (a small budget): fewer warnings, down to none; their count stays.
  const warningsAt = omitted.findIndex((o) => / warnings$/.test(o));
  for (const keep of [3, 1, 0]) {
    if (size(out) <= maxChars || out.warnings.length <= keep) break;
    const label = `${warningCount - keep} warnings`;
    const omittedNow = warningsAt >= 0 ? omitted.map((o, i) => (i === warningsAt ? label : o)) : [...omitted, label];
    out = { ...out, warnings: warnings.slice(0, keep), warning_count: warningCount, compaction: { ...out.compaction, omitted: omittedNow } };
  }
  return out;
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

// --------------------------------------------------------------------------- numbers of an answer

// A number written in a text: "1 234,5", "-12 %", "0.75". Not the digits of
// an identifier (CG3, AS7G03, T6, P1020, M-1, J73, 3D), of an ordinal (2e),
// of a date, a time or the number of an item of a list.
const NUMBER = /(?<![\p{L}\p{N}_.,/:\-−])(?:[-−](?=\d))?\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?(?![\d\p{Lu}_]|[.,:]\d|(?:er|re|e|ème|eme|nde?)(?!\p{L}))/gu;
const DATES = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g;
const LIST_ITEM = /^([ \t]*(?:[-*•][ \t]+)?)\d+[.)](?=\s)/gm;
const blank = (m) => " ".repeat(m.length);

/** The numbers of a text: [{texte, valeur, tolerance, index}] (tolerance: half a unit of the last digit written, see below). */
export function numbersOf(text) {
  const s = String(text ?? "").replace(DATES, blank).replace(LIST_ITEM, blank);
  return [...s.matchAll(NUMBER)].map((m) => {
    const raw = m[0];
    const valeur = Number(raw.replace(/[ \u00a0\u202f]/g, "").replace(",", ".").replace("−", "-"));
    return { texte: raw, valeur, tolerance: tolerance(raw, valeur), index: m.index };
  });
}

/**
 * How far from a value a number written may be and still be that value
 * rounded: half a unit of its last decimal; for a whole number ending in
 * zeros, rounded to two significant digits at least ("15 000" for 15 012,
 * "300" for 302, never "10" for 14).
 */
function tolerance(raw, valeur) {
  const decimals = /[.,](\d+)$/.exec(raw)?.[1].length ?? 0;
  if (decimals) return 0.5 * 10 ** -decimals;
  const digits = String(Math.trunc(Math.abs(valeur)));
  const significant = Math.max(digits.replace(/0+$/, "").length, 2);
  return digits.length > significant ? 0.5 * 10 ** (digits.length - significant) : 0.5;
}

/** The numbers of a text that are none of `known` (absolute values) to their rounding: {nombres (count), inconnus (as written)}. */
export function unknownNumbers(text, known) {
  const numbers = numbersOf(text);
  const inconnus = numbers.filter((n) => !known.some((k) => Math.abs(Math.abs(n.valeur) - k) <= n.tolerance + 1e-9 * Math.max(1, k))).map((n) => n.texte);
  return { nombres: numbers.length, inconnus: [...new Set(inconnus)] };
}

// Fields of a context that describe it, not the part or the quote: their numbers are not data.
const ABOUT = /^(schema|.*version|note|masque|compaction|reasoning_contract)$/;

/**
 * The unit of the numbers under a key of a context, read from its name
 * (volume_mm3, bbox_mm, mass_g, cone_semi_angle_rad, fill_ratio, ecart_pct,
 * temps_cycle_s);
 * undefined: the unit of the field that holds it.
 */
function unitOfKey(key) {
  if (/_mm3$|^volume$/.test(key)) return "mm3";
  if (/_mm2$|^area$/.test(key)) return "mm2";
  if (/_mm$/.test(key)) return "mm";
  if (/_g$/.test(key)) return "g";
  if (/_rad$/.test(key)) return "rad";
  if (/ratio$|^confidence$/.test(key)) return "fraction";
  if (/_pct$/.test(key)) return "%";
  if (/_s$/.test(key)) return "s";
  return undefined;
}

// The other ways a value may be written in an answer: its unit converted.
const CONVERSIONS = {
  mm: [0.1, 0.001], // cm, m
  mm2: [0.01, 1e-6], // cm², m²
  mm3: [0.001, 1e-6], // cm³, dm³ (litres)
  g: [0.001], // kg
  rad: [180 / Math.PI], // degrees
  fraction: [100], // percent
  "%": [0.01], // a fraction
  s: [1 / 60], // minutes
};
// The smallest value written in a converted unit: a time under a minute is not written in minutes.
const SMALLEST = { s: 1 };

/**
 * Every number a context gives (its values, and the numbers of its texts) as
 * absolute values, with the other forms an answer may write them in: another
 * unit (cm, cm³, kg, degrees, minutes, a fraction in percent and back), a radius as a
 * diameter and a diameter as a radius.
 */
function contextNumbers(context) {
  const known = [];
  (function walk(v, unit, key) {
    if (typeof v === "number" && Number.isFinite(v)) {
      const a = Math.abs(v);
      const sizes = /radius|radii/.test(key) ? [a, 2 * a] : /diameter/.test(key) ? [a, a / 2] : [a];
      for (const s of sizes) known.push(s, ...(CONVERSIONS[unit] ?? []).map((f) => s * f).filter((x) => !(x < (SMALLEST[unit] ?? 0))));
    } else if (typeof v === "string") known.push(...numbersOf(v).map((n) => Math.abs(n.valeur)));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, unit, key));
    else if (v && typeof v === "object") {
      // A traced value of the costing: in percent when its unit is "%".
      const own = v.unite === "%" ? "%" : unit;
      for (const [k, x] of Object.entries(v)) if (!ABOUT.test(k)) walk(x, unitOfKey(k) ?? own, k);
    }
  })(context, undefined, "");
  return known;
}

/**
 * The numbers of an answer that come from none of the data sent: the context
 * (`context`, the one the model was given) and the questions (`asked`,
 * texts), to their rounding and their unit (see contextNumbers). Informative:
 * a number may be a sum or a fact of general knowledge. {nombres (count),
 * inconnus (as written)}.
 */
export function checkContextNumbers(text, context, asked = []) {
  return unknownNumbers(text, [...contextNumbers(context), ...asked.flatMap((q) => numbersOf(q).map((n) => Math.abs(n.valeur)))]);
}

// --------------------------------------------------------------------------- anonymised context

// Labels of the data files of the costing trace (costing_trace.fichiers).
const FILE_LABELS = { classeur: "classeur de chiffrage", indices: "fichier des indices", tendances: "fichier de tendances", rfq: "demande client" };
// A code (an enumeration, an identifier) of a context, never a name written by a person: left as it is.
const CODE = /^[a-z0-9_.:/-]+$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name replaced wherever it is written in a text: long enough not to be part of a word or a number.
const distinctive = (name) => (name.length >= 3 && /\p{L}/u.test(name)) || name.length >= 5;
const bodyLabel = (body, i) => `Corps ${Number(/^body-(\d+)$/.exec(body?.id ?? "")?.[1] ?? i) + 1}`;

/**
 * What an AI context sends online without the names that tell the part or
 * the customer (case "Anonymiser les noms envoyés en ligne" of the IA page):
 * the file name ("Pièce.step"), the names of the bodies ("Corps 1"..., by the
 * number of their id), the files the costing trace read ("classeur de
 * chiffrage"...) and the names of the quote, `names` ([{name, label}]:
 * client, reference, designation... of ui.js costingSnapshot noms), all
 * replaced by neutral labels: as whole values, and wherever they are written
 * in a text (the reasons, hypotheses and alerts of the trace, the question).
 * Built from the whole context (every body) and `part` ([{name, label}] of
 * partNames: the bodies of the file not sent, its name), applied to the
 * context sent (compacted). Returns {context(c): the copy of `c` sent, text(s): a text
 * (the question, the conversation), legend(answer): [[label, name]] of the
 * labels an answer writes}.
 */
export function anonymizer(context, names = [], part = []) {
  const byName = new Map(); // name -> label
  const byLabel = new Map(); // label -> name, for the legend
  const add = (name, label) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n || n === label) return;
    if (!byName.has(n)) byName.set(n, label);
    if (!byLabel.has(label)) byLabel.set(label, n);
  };
  (context?.bodies ?? []).forEach((b, i) => add(b?.name, bodyLabel(b, i)));
  // The names of the part open the context may not hold (partNames): each body by its own label,
  // before the file, whose name one of them may bear.
  for (const { name, label } of part) add(name, label);
  const file = context?.source?.file;
  const ext = /\.[^./\\]+$/.exec(file ?? "")?.[0] ?? "";
  add(file, `Pièce${ext}`);
  add(file?.slice(0, file.length - ext.length), "Pièce");
  if (byName.has(file?.trim())) byLabel.set("Pièce", file.trim()); // the legend gives the whole file name
  for (const [k, f] of Object.entries(context?.costing_trace?.fichiers ?? {})) add(f?.nom, FILE_LABELS[k] ?? "fichier");
  for (const { name, label } of names) add(name, label);

  const words = [...byName.keys()].filter(distinctive).sort((a, b) => b.length - a.length);
  const re = words.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "gu") : null;
  const text = (s) => (re && typeof s === "string" ? s.replace(re, (m) => byName.get(m)) : s);
  const whole = (s) => (typeof s === "string" ? byName.get(s.trim()) ?? text(s) : s);
  const deep = (v) => {
    if (typeof v === "string") return CODE.test(v) ? v : text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };

  return {
    context(c) {
      if (!c || typeof c !== "object") return c;
      const out = deep(c);
      if (out.source?.file) out.source.file = whole(c.source.file);
      // Each body by its own label (two bodies of the same name, two labels).
      if (Array.isArray(c.bodies)) out.bodies = c.bodies.map((b, i) => (b && typeof b === "object" && "name" in b ? { ...out.bodies[i], name: bodyLabel(b, i) } : out.bodies[i]));
      const trace = out.costing_trace;
      if (trace) {
        trace.pieces = (trace.pieces ?? []).map((p) => ({ ...p, nom: whole(p.nom) }));
        trace.alertes = (trace.alertes ?? []).map((a) => (a.pieces ? { ...a, pieces: a.pieces.map(whole) } : a));
        for (const [k, f] of Object.entries(trace.fichiers ?? {})) if (f?.nom) trace.fichiers[k] = { ...f, nom: whole(f.nom) };
      }
      return out;
    },
    text,
    legend(answer) {
      const s = String(answer ?? "");
      const seen = new Set();
      return [...byLabel].filter(([label, name]) => {
        if (seen.has(name) || !new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(label)}(?![\\p{L}\\p{N}_])`, "u").test(s)) return false;
        seen.add(name);
        return true;
      });
    },
  };
}

/**
 * The names of the part open, for the anonymizer, whatever its context holds:
 * every body of the file (`bodies`: their names, by their index in it), with
 * the label of the context ("Corps 1"...), and the file. A body not sent, or
 * the file when no body is, may still be named in a question or the history.
 */
export function partNames({ bodies = [], file = null } = {}) {
  const ext = /\.[^./\\]+$/.exec(file ?? "")?.[0] ?? "";
  return [
    ...bodies.map((name, i) => ({ name, label: bodyLabel({ id: `body-${i}` }, i) })),
    ...(file ? [{ name: file, label: `Pièce${ext}` }, { name: file.slice(0, file.length - ext.length), label: "Pièce" }] : []),
  ];
}

export const AI_CONTEXT_VERSION = "1.0";
export const AI_CONTEXT_TASKS = [...TASKS];
