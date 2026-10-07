// Foundry engineering knowledge and deterministic pre-simulation checks.
//
// This module is deliberately conservative: it stores engineering principles and
// source metadata, then turns only measured geometry into evidence. It never
// pretends to simulate filling, solidification, porosity, risering or tooling.
// Numeric limits are process/alloy dependent and are therefore only activated
// when a supported profile supplies them.

export const FOUNDRY_SCHEMA_VERSION = "1.0";
export const FOUNDRY_KNOWLEDGE_VERSION = "1.0";

export const FOUNDRY_SOURCES = [
  {
    id: "sfsa_design_steps",
    title: "The Metal Casting Design Steps",
    publisher: "Steel Founders' Society of America",
    url: "https://www.sfsa.org/tutorials/cs1_text/Castings_04.html",
    scope: "parting_line_draft_hotspots_directional_solidification_risers_gates",
  },
  {
    id: "sfsa_handbook_supplement_1",
    title: "Steel Castings Handbook — Supplement 1: Design Rules and Data",
    publisher: "Steel Founders' Society of America",
    url: "https://cdn.sfsa.org/wp-content/uploads/2021/10/s1.pdf",
    scope: "steel_castability_section_thickness_directional_solidification_junctions_cores",
  },
  {
    id: "sfsa_information_designers",
    title: "Information for Casting Designers",
    publisher: "Steel Founders' Society of America",
    url: "https://www.sfsa.org/subject-areas/education/information-for-casting-designers/",
    scope: "steel_casting_design_alloy_specificity_foundry_validation",
  },
  {
    id: "afs_gating_riser",
    title: "Gating & Riser Design",
    publisher: "American Foundry Society",
    url: "https://www.afsinc.org/e-learning/gating-riser-design",
    scope: "fluid_flow_heat_transfer_risers_gates_chills_alloy_specificity",
  },
  {
    id: "asm_casting_design",
    title: "Casting Design and Geometry",
    publisher: "ASM International",
    url: "https://dl.asminternational.org/handbooks/edited-volume/27/chapter-abstract/376603/Casting-Design-and-Geometry-1",
    scope: "casting_design_geometry_junctions_shrinkage_secondary_operations",
  },
];

export const FOUNDRY_PROFILES = {
  unspecified: {
    label: "Procédé de fonderie non spécifié",
    numeric_rules: {},
    requires_process_and_alloy: true,
  },
  steel_sand_casting: {
    label: "Acier moulé — procédé conventionnel",
    process: "sand_casting",
    alloy_family: "steel",
    numeric_rules: {
      minimum_section_thickness_mm: { value: 6, source_id: "sfsa_information_designers", status: "reference" },
    },
    requires_process_and_alloy: false,
  },
  steel_investment_casting: {
    label: "Acier moulé — cire perdue / investment casting",
    process: "investment_casting",
    alloy_family: "steel",
    numeric_rules: {
      common_section_thickness_mm: { value: 1.5, source_id: "sfsa_information_designers", status: "reference" },
    },
    requires_process_and_alloy: false,
  },
};

function finite(v) { return typeof v === "number" && Number.isFinite(v); }

function thicknessEvidence(body) {
  const t = body?.thickness ?? null;
  if (!t || !finite(t.min) || !finite(t.median) || !finite(t.max)) {
    return { status: "not_available", min_mm: null, median_mm: null, max_mm: null };
  }
  return {
    status: "measured",
    method: t.method ?? null,
    min_mm: t.min,
    median_mm: t.median,
    max_mm: t.max,
    max_to_median: t.median > 0 ? t.max / t.median : null,
    min_to_median: t.median > 0 ? t.min / t.median : null,
  };
}

function issue(code, severity, basis, message, source_ids = []) {
  return { code, severity, basis, message, source_ids };
}

export function buildFoundryAnalysis(body, features = [], principalAxes = null, profileId = "unspecified") {
  const profile = FOUNDRY_PROFILES[profileId] ?? FOUNDRY_PROFILES.unspecified;
  const thickness = thicknessEvidence(body);
  const risks = [];
  const requiredChecks = [];
  const confirmedEvidence = [];

  if (body?.closed === false) {
    risks.push(issue(
      "open_geometry",
      "high",
      "measured_topology",
      "La géométrie ouverte ne permet pas une analyse fiable de remplissage/solidification.",
      ["sfsa_design_steps"],
    ));
  } else if (body?.closed === true) {
    confirmedEvidence.push("closed_solid");
  }

  if (thickness.status === "measured") {
    confirmedEvidence.push("wall_thickness_measured");
    if (thickness.max_to_median >= 1.5) {
      risks.push(issue(
        "thick_section_hotspot_candidate",
        "high",
        "measured_thickness_distribution",
        "La concentration locale d'épaisseur est compatible avec une zone chaude candidate; une vérification de solidification/alimentation est requise.",
        ["sfsa_design_steps","sfsa_handbook_supplement_1","afs_gating_riser"],
      ));
    }
    if (thickness.min_to_median <= 0.6) {
      risks.push(issue(
        "thin_section_candidate",
        "medium",
        "measured_thickness_distribution",
        "Une zone mince est présente; la coulabilité dépend du procédé, de l'alliage, de la distance à l'attaque et des conditions thermiques.",
        ["sfsa_information_designers","afs_gating_riser"],
      ));
    }
  } else {
    requiredChecks.push("compute_wall_thickness_before_foundry_review");
  }

  const holeCount = features.filter(f =>
    f.type === "hole_feature_candidate" ||
    f.subtype === "possible_through_hole" ||
    f.subtype === "possible_through_hole_or_bore"
  ).length;
  const pocketCount = features.filter(f => f.type === "pocket_feature_candidate").length;
  const bossCount = features.filter(f => f.type === "boss_feature_candidate").length;

  if (holeCount + pocketCount + bossCount > 0) {
    risks.push(issue(
      "core_or_undercut_review",
      "medium",
      "geometric_feature_candidates",
      "Des ouvertures, évidements ou bossages candidats peuvent imposer des noyaux, des choix de plan de joint ou des opérations de reprise; l'intention et l'accessibilité restent à confirmer.",
      ["sfsa_design_steps","sfsa_handbook_supplement_1"],
    ));
  }

  requiredChecks.push("select_parting_direction");
  requiredChecks.push("evaluate_draft_and_pattern_release");
  requiredChecks.push("locate_and_size_risers_after_solidification_analysis");
  requiredChecks.push("design_gating_after_flow_analysis");
  requiredChecks.push("validate_directional_solidification");
  requiredChecks.push("run_fill_and_solidification_simulation_for_advanced_claims");

  const ruleStatus = {
    uniform_wall_thickness: thickness.status === "measured" ? "screened" : "not_available",
    section_transitions: "not_localized_from_current_semantic_geometry",
    draft: "not_evaluated_without_parting_direction",
    fillets_and_junctions: "candidate_geometry_only",
    parting_line: "not_evaluated",
    cores: holeCount + pocketCount > 0 ? "candidate" : "not_detected",
    hot_spots: thickness.status === "measured" ? "screened_by_thickness_distribution" : "not_available",
    directional_solidification: "not_simulated",
    risering: "not_sized",
    gating: "not_sized",
    filling: "not_simulated",
    porosity: "not_simulated",
    distortion: "not_simulated",
  };

  return {
    schema_version: FOUNDRY_SCHEMA_VERSION,
    knowledge_version: FOUNDRY_KNOWLEDGE_VERSION,
    profile: {
      id: profileId,
      label: profile.label,
      process: profile.process ?? null,
      alloy_family: profile.alloy_family ?? null,
      requires_process_and_alloy: profile.requires_process_and_alloy,
      numeric_rules: profile.numeric_rules,
    },
    evidence: {
      closed: body?.closed ?? null,
      topology: body?.topology ?? null,
      thickness,
      principal_axes: principalAxes,
      feature_counts: { hole_candidates: holeCount, pocket_candidates: pocketCount, boss_candidates: bossCount },
      confirmed: confirmedEvidence,
    },
    rules: ruleStatus,
    risks,
    required_checks: [...new Set(requiredChecks)],
    simulation_boundary: {
      filling: "not_computed",
      solidification: "not_computed",
      shrinkage_porosity: "not_computed",
      riser_design: "not_computed",
      gating_design: "not_computed",
      thermal_stress_distortion: "not_computed",
      message: "Cette couche prépare et explique l'analyse; elle ne remplace pas un solveur de fonderie.",
    },
    confidence_policy: "geometry_screening_is_evidence; foundry_process_claims_require_process_alloy_and_simulation_or_foundry_validation",
    sources: FOUNDRY_SOURCES.map(({ id, title, publisher, url, scope }) => ({ id, title, publisher, url, scope })),
  };
}
