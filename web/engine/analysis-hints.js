// The notes of every semantic analysis (semantic.js analysis_hints), the same
// for every part: the AI context (ai-context.js) gives them up first when it
// is compacted, the instructions of the model saying the same.
export const ANALYSIS_HINTS = [
  "features are geometric candidates, not guaranteed design intent",
  "manufacturing operations, setups, dependencies and DFM notes are candidates, not executable toolpaths",
  "V6 planning groups candidate operations by compatible tool axis and exposes unresolved access constraints",
  "functional thickness is reported only when an existing Reader metric is available",
  "raw tessellation is intentionally excluded from this AI payload",
  "use source_index to map semantic bodies back to Reader bodies",
  "foundry analysis is a conservative geometry screen; filling, solidification, risering and gating are not simulated",
  "numeric foundry limits are process/alloy specific and must be validated against the selected foundry process",
];
