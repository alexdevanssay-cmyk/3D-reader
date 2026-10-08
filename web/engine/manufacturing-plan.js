// V6 manufacturing planning layer.
// This module consumes V5 candidate operations only. It never produces executable toolpaths.
const EPS = 1e-9;

function finite(v) { return typeof v === "number" && Number.isFinite(v); }

function normalizeAxis(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n <= EPS) return null;
  const a = v.map(x => x / n);
  // Canonical sign makes grouping deterministic: first non-zero component is positive.
  const first = a.find(x => Math.abs(x) > 1e-9);
  return first < 0 ? a.map(x => -x) : a;
}

function sameAxis(a, b, tol = 1e-5) {
  const aa = normalizeAxis(a);
  const bb = normalizeAxis(b);
  if (!aa || !bb) return false;
  return Math.abs(Math.abs(aa[0]*bb[0] + aa[1]*bb[1] + aa[2]*bb[2]) - 1) <= tol;
}

function axisKey(axis) {
  const a = normalizeAxis(axis);
  return a ? a.map(v => v.toFixed(6)).join(",") : "undetermined";
}

function operationAxis(operation) {
  return normalizeAxis(operation.accessibility?.tool_axis);
}

function setupCompatibility(operations) {
  const groups = [];
  for (const operation of operations) {
    const axis = operationAxis(operation);
    // The operations without a tool axis share one setup, still to be determined.
    let group = axis
      ? groups.find(g => g.axis && sameAxis(axis, g.axis))
      : groups.find(g => !g.axis);
    if (!group) {
      group = { axis, operations: [] };
      groups.push(group);
    }
    group.operations.push(operation);
  }
  return groups;
}

const PRECEDENCE = {
  pocket_milling: 20,
  boss_milling_or_bore: 25,
  drilling: 30,
  drilling_blind: 30,
  drilling_or_boring: 30,
  counterboring_or_boring: 35,
  boring_or_coaxial_feature_machining: 35,
  patterned_feature_machining: 40,
  feature_machining: 45,
  chamfering_or_countersinking: 50,
  fillet_or_blend_finishing: 60,
};

// Operations that finish what another operation machined on the same surface:
// a counterbore after the drilling of its bore, a chamfer after the faces it breaks.
const FINISHING_OPERATIONS = new Set([
  "counterboring_or_boring",
  "boring_or_coaxial_feature_machining",
  "feature_machining",
  "chamfering_or_countersinking",
]);

/** Rank of an operation in the machining order (the V5 sequence uses it too). */
export function precedence(operation) {
  return PRECEDENCE[operation] ?? 45;
}

/** Dependencies between candidate operations: {from, to, reason, confidence}. */
export function operationDependencyGraph(operations) {
  const edges = [];
  const sorted = [...operations].sort((a, b) =>
    precedence(a.operation) - precedence(b.operation) ||
    a.operation_id.localeCompare(b.operation_id)
  );

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (precedence(previous.operation) < precedence(current.operation)) {
      edges.push({
        from: previous.operation_id,
        to: current.operation_id,
        reason: "manufacturing_precedence",
        confidence: 0.8,
      });
    }
  }

  // Each operation lists only its own feature: operations are related through
  // the surfaces they share (operation.surfaces, set by semantic.js).
  const producersBySurface = new Map();
  for (const operation of operations) {
    if (FINISHING_OPERATIONS.has(operation.operation)) continue;
    for (const surface of operation.surfaces ?? []) {
      const list = producersBySurface.get(surface) ?? [];
      list.push(operation);
      producersBySurface.set(surface, list);
    }
  }

  for (const operation of operations) {
    if (!FINISHING_OPERATIONS.has(operation.operation)) continue;
    for (const surface of operation.surfaces ?? []) {
      for (const producer of producersBySurface.get(surface) ?? []) {
        if (precedence(producer.operation) >= precedence(operation.operation)) continue;
        edges.push({
          from: producer.operation_id,
          to: operation.operation_id,
          reason: "feature_relation",
          confidence: 0.9,
        });
      }
    }
  }

  const seen = new Set();
  return edges.filter(edge => {
    const key = edge.from + ">" + edge.to + ":" + edge.reason;
    if (seen.has(key)) return false;
    seen.add(key);
    return edge.from !== edge.to;
  });
}

function setupCandidate(group, index) {
  const operations = [...group.operations].sort((a,b) => a.operation_id.localeCompare(b.operation_id));
  const axis = group.axis;
  const unresolved = [];
  if (!axis) unresolved.push("tool_axis_undetermined");
  if (operations.some(o => o.accessibility?.requires_stock_fixture_analysis)) {
    unresolved.push("stock_fixture_access_not_verified");
  }
  return {
    setup_id: "setup-" + String(index + 1).padStart(2, "0"),
    tool_axis: axis,
    axis_key: axisKey(axis),
    operation_ids: operations.map(o => o.operation_id),
    feature_ids: [...new Set(operations.flatMap(o => o.feature_ids ?? []))].sort(),
    status: unresolved.length ? "candidate_with_constraints" : "candidate",
    unresolved_constraints: [...new Set(unresolved)],
    compatibility: axis ? "common_tool_axis" : "axis_unknown",
    confidence: axis ? 0.82 : 0.35,
  };
}

function readiness(body, operations, setups, dependencies) {
  const unresolved = [];
  if (!operations.length) unresolved.push("no_machining_operations");
  if (setups.some(s => !s.tool_axis)) unresolved.push("setup_axis_undetermined");
  if (setups.some(s => s.unresolved_constraints.includes("stock_fixture_access_not_verified"))) {
    unresolved.push("stock_fixture_access_not_verified");
  }
  if (operations.some(o => o.status !== "candidate")) unresolved.push("non_candidate_operation_state");
  // A semantic body (semantic.js) keeps its closedness in quality.closed.
  if ((body.closed ?? body.quality?.closed) !== true) unresolved.push("body_not_confirmed_closed");
  if (body.quality?.evidence?.validation_error_count > 0) unresolved.push("semantic_evidence_validation_errors");

  const score = Math.max(0, Math.min(1,
    1
    - (unresolved.includes("no_machining_operations") ? 0.3 : 0)
    - (unresolved.includes("setup_axis_undetermined") ? 0.2 : 0)
    - (unresolved.includes("stock_fixture_access_not_verified") ? 0.2 : 0)
    - (unresolved.includes("body_not_confirmed_closed") ? 0.2 : 0)
    - (unresolved.includes("semantic_evidence_validation_errors") ? 0.2 : 0)
  ));

  return {
    status: unresolved.length ? "needs_review" : "candidate_ready",
    score,
    unresolved_constraints: [...new Set(unresolved)],
    policy: "readiness_is_a_planning_signal_not_a_manufacturing_approval",
    dependency_count: dependencies.length,
  };
}

export function buildManufacturingPlan(body) {
  const manufacturing = body?.manufacturing ?? {};
  const operations = Array.isArray(manufacturing.operations) ? manufacturing.operations : [];
  // The setup without a tool axis comes last. Numbered by first appearance it
  // would come first (pocket candidates lead the precedence order) and put its
  // counterbores and chamfers before the drillings they finish. The sort is
  // stable: the axis setups keep their order.
  const groups = setupCompatibility(operations).sort((a, b) => !a.axis - !b.axis);
  const setups = groups.map(setupCandidate);
  const dependencies = operationDependencyGraph(operations);
  const setupOf = new Map();
  setups.forEach((setup, index) => setup.operation_ids.forEach(id => setupOf.set(id, index)));

  const plannedOrder = [...operations]
    .sort((a,b) =>
      (setupOf.get(a.operation_id) - setupOf.get(b.operation_id)) ||
      precedence(a.operation) - precedence(b.operation) ||
      a.operation_id.localeCompare(b.operation_id)
    )
    .map((operation, index) => ({
      step: index + 1,
      operation_id: operation.operation_id,
      setup_id: setups[setupOf.get(operation.operation_id)]?.setup_id ?? null,
      operation: operation.operation,
    }));

  const ids = new Set(operations.map(o => o.operation_id));
  const dependencyMap = dependencies.map(edge => ({
    ...edge,
    resolvable: ids.has(edge.from) && ids.has(edge.to),
  }));

  return {
    schema_version: "1.0",
    operation_count: operations.length,
    setup_count: setups.length,
    setups,
    dependencies: dependencyMap,
    planned_order: plannedOrder,
    readiness: readiness(body, operations, setups, dependencies),
    constraints: {
      tool_access: "not_verified",
      collision_check: "not_performed",
      stock_and_fixture: "not_analyzed",
      machine_kinematics: "not_analyzed",
      cutting_parameters: "not_defined",
      tool_selection: "not_defined",
    },
    confidence_policy: "V6 is deterministic planning evidence built from V5 candidates; it is not a CAM program or executable process plan",
  };
}
