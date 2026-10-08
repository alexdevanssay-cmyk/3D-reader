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

// Ratios of the measured thickness distribution that flag a body for review.
// No cited source defines them: they are 3D Reader heuristics, not castability
// limits, so the risks they raise cite their sources as background only.
const HEURISTIC_SOURCE = "3d_reader_heuristic_unvalidated";
const HOTSPOT_MAX_TO_MEDIAN = 1.5;
const THIN_MIN_TO_MEDIAN = 0.6;

function finite(v) { return typeof v === "number" && Number.isFinite(v); }

function measured(s) { return !!s && finite(s.min) && finite(s.median) && finite(s.max); }

function thicknessEvidence(body) {
  const t = body?.thickness ?? null;
  // Per-method statistics of the Reader (app.js thicknessExport), whichever
  // method the 3D view shows: the hot spots read on the inscribed spheres, the
  // thin walls on the "wall" method. Else the one distribution given.
  const sphere = measured(t?.sphere) ? t.sphere : t;
  const wall = measured(t?.wall) ? t.wall : t;
  if (!measured(sphere) || !measured(wall)) {
    return { status: "not_available", min_mm: null, median_mm: null, max_mm: null };
  }
  const methodOf = (s) => (s === t ? t.method ?? null : s === t.sphere ? "sphere" : "wall");
  return {
    status: "measured",
    min_mm: wall.min,
    min_method: methodOf(wall),
    median_mm: sphere.median,
    max_mm: sphere.max,
    median_max_method: methodOf(sphere),
    max_to_median: sphere.median > 0 ? sphere.max / sphere.median : null,
    hotspot_method: methodOf(sphere),
    min_to_median: wall.median > 0 ? wall.min / wall.median : null,
    thin_method: methodOf(wall),
  };
}

function issue(code, severity, basis, message, source_ids = [], extra = {}) {
  return { code, severity, basis, message, source_ids, ...extra };
}

export function buildFoundryAnalysis(body, features = [], principalAxes = null, profileId = "unspecified") {
  const profile = FOUNDRY_PROFILES[profileId] ?? FOUNDRY_PROFILES.unspecified;
  const thickness = thicknessEvidence(body);
  const risks = [];
  const requiredChecks = [];
  const confirmedEvidence = [];

  if (body?.closed === false) {
    // A limit of this screen, not a foundry rule: no source to cite.
    risks.push(issue(
      "open_geometry",
      "high",
      "measured_topology",
      "La géométrie ouverte ne permet pas une analyse fiable de remplissage/solidification.",
    ));
  } else if (body?.closed === true) {
    confirmedEvidence.push("closed_solid");
  }

  if (thickness.status === "measured") {
    confirmedEvidence.push("wall_thickness_measured");
    if (thickness.max_to_median >= HOTSPOT_MAX_TO_MEDIAN) {
      risks.push(issue(
        "thick_section_hotspot_candidate",
        "review",
        "measured_thickness_distribution",
        "La concentration locale d'épaisseur est compatible avec une zone chaude candidate (seuil heuristique de 3D Reader, non issu des sources); une vérification de solidification/alimentation est requise.",
        [],
        {
          threshold: { metric: "max_to_median", method: thickness.hotspot_method, value: HOTSPOT_MAX_TO_MEDIAN, source: HEURISTIC_SOURCE },
          background_source_ids: ["sfsa_design_steps","sfsa_handbook_supplement_1","afs_gating_riser"],
        },
      ));
    }
    if (thickness.min_to_median <= THIN_MIN_TO_MEDIAN) {
      risks.push(issue(
        "thin_section_candidate",
        "review",
        "measured_thickness_distribution",
        "Une zone mince est présente (seuil heuristique de 3D Reader, non issu des sources); la coulabilité dépend du procédé, de l'alliage, de la distance à l'attaque et des conditions thermiques.",
        [],
        {
          threshold: { metric: "min_to_median", method: thickness.thin_method, value: THIN_MIN_TO_MEDIAN, source: HEURISTIC_SOURCE },
          background_source_ids: ["sfsa_information_designers","afs_gating_riser"],
        },
      ));
    }
  } else {
    requiredChecks.push("compute_wall_thickness_before_foundry_review");
  }

  // semantic.js gives one cylindrical face as a cylinder, a hole and a boss
  // candidate: the faces are counted once. Without an inside/outside test such
  // a face is an opening (a core) or the outside of a boss or shaft. The planar
  // pocket signal (a face with three neighbours) fires on every face of a plain
  // block: it is not core evidence.
  const cylindricalFaces = new Set(features
    .filter(f =>
      f.type === "hole_feature_candidate" ||
      f.type === "boss_feature_candidate" ||
      f.subtype === "possible_through_hole"
    )
    .map(f => f.surface_index)
    .filter(i => i != null));
  const pocketCount = features.filter(f => f.type === "pocket_feature_candidate").length;

  if (cylindricalFaces.size > 0) {
    risks.push(issue(
      "core_or_undercut_review",
      "review",
      "geometric_feature_candidates",
      "Des faces cylindriques candidates, ouvertures ou bossages (l'intérieur et l'extérieur ne sont pas distingués), peuvent imposer des noyaux, des choix de plan de joint ou des opérations de reprise; l'intention et l'accessibilité restent à confirmer.",
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
    cores: cylindricalFaces.size + pocketCount > 0 ? "undetermined_without_concavity_test" : "not_detected",
    hot_spots: thickness.status === "measured" ? "screened_by_thickness_distribution" : "not_available",
    directional_solidification: "not_simulated",
    risering: "not_sized",
    gating: "not_sized",
    filling: "not_simulated",
    porosity: "not_simulated",
    distortion: "not_simulated",
  };

  const requiredEngineeringInputs = [
    "casting_process",
    "alloy_grade",
    "parting_direction_or_tooling_strategy",
    "mold_and_core_system",
    "pouring_temperature_or_superheat",
    "liquidus_solidus_or_solidification_range",
    "density_and_shrinkage_data",
    "thermal_properties_for_simulation",
  ];

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
      feature_counts: { cylindrical_opening_or_boss_candidates: cylindricalFaces.size, pocket_candidates: pocketCount },
      confirmed: confirmedEvidence,
    },
    rules: ruleStatus,
    risks,
    required_checks: [...new Set(requiredChecks)],
    engineering_inputs: {
      status: profile.requires_process_and_alloy ? "incomplete" : "profile_selected_but_material_data_still_required",
      process_known: !!profile.process,
      alloy_family_known: !!profile.alloy_family,
      required: requiredEngineeringInputs,
      missing_for_advanced_simulation: requiredEngineeringInputs,
    },
    simulation_boundary: {
      filling: "not_computed",
      solidification: "not_computed",
      shrinkage_porosity: "not_computed",
      riser_design: "not_computed",
      gating_design: "not_computed",
      thermal_stress_distortion: "not_computed",
      message: "Cette couche prépare et explique l'analyse; elle ne remplace pas un solveur de fonderie.",
    },
    confidence_policy: "geometry_screening_is_evidence; foundry_process_claims_require_process_alloy_and_simulation_or_foundry_validation; heuristic_thresholds_are_not_sourced_limits_and_background_source_ids_do_not_define_them",
    sources: FOUNDRY_SOURCES.map(({ id, title, publisher, url, scope }) => ({ id, title, publisher, url, scope })),
  };
}
