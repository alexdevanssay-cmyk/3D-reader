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
  // The rules of the risers and gating proposed by feeding.js (books and an article: no link).
  {
    id: "chvorinov_1940",
    title: "Theorie der Erstarrung von Gußstücken (N. Chvorinov)",
    publisher: "Die Giesserei, vol. 27, 1940",
    url: null,
    scope: "solidification_time_proportional_to_squared_modulus_volume_over_cooling_surface",
  },
  {
    id: "wlodawer_1966",
    title: "Directional Solidification of Steel Castings (R. Wlodawer)",
    publisher: "Pergamon Press, 1966",
    url: null,
    scope: "modulus_method_feeding_zones_riser_modulus_1_2_times_casting_section",
  },
  {
    id: "campbell_casting_handbook",
    title: "Complete Casting Handbook: Metal Casting Processes, Metallurgy, Techniques and Design (J. Campbell)",
    publisher: "Butterworth-Heinemann, 2nd edition, 2015",
    url: null,
    scope: "feeding_rules_directional_solidification_inscribed_circles_gating_bottom_filling",
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

/**
 * Draw direction and parting line of the body (parting.js, given with the
 * Reader body): proposed from the geometry or defined by hand; its undercut
 * and zero-draft areas measured by lines of sight along the draw direction.
 */
function partingEvidence(body) {
  const p = body?.parting;
  if (!p || (p.status !== "proposed" && p.status !== "manual") || !finite(p.undercut_area_mm2)) return { status: "not_evaluated" };
  return {
    status: p.status,
    // How a manual one was defined: a candidate, a face, a direction typed, or "drawn" (the line drawn by hand on the part).
    source: p.source ?? null,
    axis: p.axis ?? null,
    direction: p.direction ?? null,
    draft_angle_deg: p.draft_angle_deg ?? null,
    undercut_area_mm2: p.undercut_area_mm2,
    undercut_share: p.undercut_share ?? null,
    zero_draft_area_mm2: finite(p.zero_draft_area_mm2) ? p.zero_draft_area_mm2 : null,
    zero_draft_share: p.zero_draft_share ?? null,
    parting_line: p.parting ?? null,
    sampled: !!p.sampled,
  };
}

/**
 * Risers and ingate of the body (feeding.js, given with the Reader body):
 * proposed from the inscribed spheres and the moduli (heuristics of the
 * modulus method, not a solidification simulation), or placed by hand.
 */
function feedingEvidence(body) {
  const f = body?.feeding;
  if (!f || (f.status !== "proposed" && f.status !== "manual") || !Array.isArray(f.risers)) return { status: "not_evaluated" };
  const zones = Array.isArray(f.zones) ? f.zones : [];
  const gate = f.gate ?? null;
  return {
    status: f.status,
    // The risers by hand or proposed (an ingate placed by hand alone leaves them proposed).
    risers_status: f.risers_status === "manual" || f.risers_status === "proposed" ? f.risers_status : f.status,
    zone_count: zones.length,
    zones_needing_riser: zones.filter(z => z.needs_riser).length,
    small_isolated_hot_spots: zones.filter(z => z.small && !z.needs_riser).length,
    riser_count: f.risers.length,
    risers: f.risers.map(r => ({
      id: r.id ?? null, type: r.type ?? null, source: r.source ?? null, zone: r.zone ?? null,
      position_mm: r.position_mm ?? null, diameter_mm: r.diameter_mm ?? null, height_mm: r.height_mm ?? null,
      zone_sphere_mm: r.zone_sphere_mm ?? null, modulus_mm: r.modulus_mm ?? null,
    })),
    hot_spots_without_riser: Array.isArray(f.hot_spots_without_riser) ? f.hot_spots_without_riser : [],
    gate: gate ? {
      source: gate.source ?? null,
      position_mm: gate.position_mm ?? null,
      on_parting_line: gate.on_parting_line === true,
      section_mm2: gate.section_mm2 ?? null,
    } : null,
    yield: f.yield?.value ?? null,
    parting_known: f.parting_known ?? null,
    sampled: !!f.sampled,
  };
}

/**
 * The slides of the body (slides.js, given with the Reader body): its
 * undercuts grouped by the lateral direction that releases them, by lines of
 * sight; proposed, or edited by hand. Not a die design: the slides' draft and
 * their room in the die are not checked.
 */
function slidesEvidence(body) {
  const s = body?.slides;
  if (!s || (s.status !== "proposed" && s.status !== "manual") || !finite(s.count)) return { status: "not_evaluated" };
  const slides = Array.isArray(s.slides) ? s.slides : [];
  const strokes = slides.map(x => x.stroke_mm).filter(finite);
  return {
    status: s.status,
    count: s.count,
    cores: s.cores ?? 0,
    parting_zones: s.parting_zones ?? 0,
    ignored: s.ignored ?? 0,
    inclined: slides.filter(x => x.tags?.inclined || finite(x.tilt_deg)).length,
    long_strokes: slides.filter(x => x.tags?.long_stroke).length,
    max_stroke_mm: strokes.length ? Math.max(...strokes) : null,
    enclosed_cavities: (s.cores_detail ?? []).filter(c => c.reason === "enclosed").length,
    edited: !!s.edited,
    capped: (s.warnings ?? []).includes("capped"),
  };
}

// A share above 0 but below 0,05 %: not "0 %" (a risk raised for it would contradict itself).
const pct = (share) => (share > 0 && share < 0.0005 ? "< 0,1 %" : `${(Math.round(share * 1000) / 10).toLocaleString("fr-FR")} %`);
const mm = (v) => `${(Math.round(v * 10) / 10).toLocaleString("fr-FR")} mm`;
const mm2 = (v) => `${(Math.round(v * 10) / 10).toLocaleString("fr-FR")} mm²`;

const fr = (v) => (Math.round(v * 10) / 10).toLocaleString("fr-FR");
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const MANY_SLIDES = 4; // slides.js SLIDE_DEFAULTS.manySlides

/** A pull direction of a slide in words: « +Y », « +Y +30° », « +Y, incliné de 20° vers le haut ». */
function slideDirection(x) {
  let name = String(x.reference_axis ?? x.axis ?? "").replace(/^-/, "−");
  if (finite(x.angle_deg)) name += ` ${x.angle_deg > 0 ? "+" : "−"}${fr(Math.abs(x.angle_deg))}°`;
  if (finite(x.tilt_deg)) name += `, incliné de ${fr(x.tilt_deg)}° vers le ${x.tilt_up === false ? "bas" : "haut"}`;
  return name;
}

function issue(code, severity, basis, message, source_ids = [], extra = {}) {
  return { code, severity, basis, message, source_ids, ...extra };
}

export function buildFoundryAnalysis(body, features = [], principalAxes = null, profileId = "unspecified") {
  const profile = FOUNDRY_PROFILES[profileId] ?? FOUNDRY_PROFILES.unspecified;
  const thickness = thicknessEvidence(body);
  const parting = partingEvidence(body);
  const partingKnown = parting.status !== "not_evaluated";
  const feeding = feedingEvidence(body);
  const feedingKnown = feeding.status !== "not_evaluated";
  const slides = slidesEvidence(body);
  const slidesKnown = slides.status !== "not_evaluated";
  const undercut = partingKnown && parting.undercut_area_mm2 > 0;
  const zeroDraft = partingKnown && parting.zero_draft_area_mm2 > 0;
  const nonPlanar = partingKnown && parting.parting_line?.planar === false;
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
  // Holes measured through or blind on the mesh (holes.js): openings, their inside known.
  // Each once: a counterbored hole has a hole feature per diameter.
  const measuredHoles = [...new Map(features
    .filter(f => f.type === "hole_feature_candidate" && f.measured === true)
    .map(f => [String(f.hole_surfaces ?? f.surface_index), f])).values()];
  const throughHoles = measuredHoles.filter(f => f.through === true).length;
  const blindHoles = measuredHoles.length - throughHoles;
  if (measuredHoles.length) confirmedEvidence.push("holes_measured_through_or_blind");

  // With a draw direction, the lines of sight tell openings formed by the
  // die from undercuts: the candidates' review gives way to them.
  if (cylindricalFaces.size > 0 && !partingKnown) {
    risks.push(issue(
      "core_or_undercut_review",
      "review",
      "geometric_feature_candidates",
      measuredHoles.length
        ? `Des trous mesurés sur la géométrie (${throughHoles} débouchant(s), ${blindHoles} borgne(s)) et les autres faces cylindriques candidates peuvent imposer des noyaux ou des broches, des choix de plan de joint ou des opérations de reprise; l'accessibilité reste à confirmer.`
        : "Des faces cylindriques candidates, ouvertures ou bossages (l'intérieur et l'extérieur ne sont pas distingués), peuvent imposer des noyaux, des choix de plan de joint ou des opérations de reprise; l'intention et l'accessibilité restent à confirmer.",
      ["sfsa_design_steps","sfsa_handbook_supplement_1"],
    ));
  }

  if (partingKnown) {
    confirmedEvidence.push(parting.status === "manual" ? "parting_line_defined_manually" : "parting_line_proposed_from_geometry");
    // Its points placed on the part by hand, the halves given by part (not classified by lines of sight).
    if (parting.source === "drawn") confirmedEvidence.push("parting_line_drawn_by_hand");
    if (undercut) {
      risks.push(issue(
        "undercut_requires_core_or_slide",
        "review",
        "measured_line_of_sight_along_draw_direction",
        `${pct(parting.undercut_share ?? 0)} de la surface (${mm2(parting.undercut_area_mm2)}) ne se démoule par aucun des deux demi-moules selon la direction ${parting.axis ?? "choisie"} : noyaux ou tiroirs, ou une autre direction ; à confirmer avec l'outillage.`,
        ["sfsa_design_steps","sfsa_handbook_supplement_1"],
        { undercut_area_mm2: parting.undercut_area_mm2 },
      ));
    }
    if (zeroDraft) {
      risks.push(issue(
        "zero_draft_faces",
        "review",
        "measured_face_angle_to_draw_direction",
        `${pct(parting.zero_draft_share ?? 0)} de la surface (${mm2(parting.zero_draft_area_mm2)}) est à moins de ${parting.draft_angle_deg ?? 1}° de la direction de démoulage : dépouille à ajouter ou à confirmer avec la fonderie.`,
        ["sfsa_design_steps"],
        { zero_draft_area_mm2: parting.zero_draft_area_mm2 },
      ));
    }
    if (nonPlanar) {
      risks.push(issue(
        "non_planar_parting_line",
        "review",
        "measured_parting_line_heights",
        `La ligne de joint n'est pas plane (${parting.parting_line.kind === "stepped" ? "étagée" : "gauche"}, sur ${mm(parting.parting_line.height_range_mm)} le long de la direction de démoulage) : plan de joint et outillage plus complexes, à confirmer.`,
        ["sfsa_design_steps"],
      ));
    }
    requiredChecks.push(parting.status === "manual" ? "validate_manual_parting_line_with_tooling" : "confirm_proposed_parting_direction");
    if (zeroDraft) requiredChecks.push("add_or_confirm_draft_on_zero_draft_faces");
    if (undercut) requiredChecks.push("define_cores_or_slides_for_undercuts");
    if (nonPlanar) requiredChecks.push("design_non_planar_parting_surface");
  } else {
    requiredChecks.push("select_parting_direction");
    requiredChecks.push("evaluate_draft_and_pattern_release");
  }
  // The undercuts grouped into slides by the lateral direction that releases
  // them (slides.js): a count proposed to the costing, to validate with the
  // tooling; what no slide releases is a core (or machining).
  if (slidesKnown) {
    confirmedEvidence.push("slides_grouped_from_undercuts");
    const list = Array.isArray(body.slides.slides) ? body.slides.slides : [];
    const cores = Array.isArray(body.slides.cores_detail) ? body.slides.cores_detail : [];
    const area = (items) => items.reduce((n, c) => n + (finite(c.area_mm2) ? c.area_mm2 : 0), 0);
    const SLIDE_SOURCES = ["sfsa_design_steps", "asm_casting_design"];
    const slideIssue = (code, severity, message, extra = {}) => risks.push(issue(code, severity, "measured_lateral_lines_of_sight", message, SLIDE_SOURCES, extra));
    if (slides.count > 0) {
      slideIssue("slides_proposed", "review",
        `${plural(slides.count, "tiroir proposé", "tiroirs proposés")} (${list.map(x => `${x.id} ${slideDirection(x)}, course ${mm(x.stroke_mm)}`).join(" ; ")}) : à valider avec l'outillage.`,
        { count: slides.count });
    }
    if (slides.cores > 0) {
      slideIssue("probable_sand_core", "review", `${plural(slides.cores, "zone sans sortie latérale", "zones sans sortie latérale")} (noyau probable ou usinage) : ${mm2(area(cores))}.`, { cores: slides.cores });
    }
    const enclosed = cores.filter(c => c.reason === "enclosed");
    if (enclosed.length) {
      slideIssue("enclosed_cavity", "high",
        `${enclosed.length > 1 ? `${enclosed.length} cavités fermées` : "Cavité fermée"} sans ouverture (${mm2(area(enclosed))}) : noyau sans portée, à revoir avec le client.`,
        { cavities: enclosed.length });
    }
    if (slides.count > MANY_SLIDES) slideIssue("many_slides", "review", `${plural(slides.count, "tiroir", "tiroirs")}, plus de ${MANY_SLIDES} : revoir la direction de démoulage, ou des noyaux.`);
    const inclined = list.filter(x => finite(x.tilt_deg));
    if (inclined.length) {
      slideIssue("inclined_slide", "review",
        `${plural(inclined.length, "tiroir incliné", "tiroirs inclinés")} hors du plan de joint (${inclined.map(x => `${x.id} : ${fr(x.tilt_deg)}°`).join(", ")}) : moule plus complexe, à confirmer avec l'outillage.`);
    }
    const long = list.filter(x => x.tags?.long_stroke);
    if (long.length) slideIssue("long_stroke", "review", `Course longue (${long.map(x => `${x.id} : ${mm(x.stroke_mm)}`).join(", ")}) : vérin et place dans le moule à vérifier.`);
    if (slides.parting_zones > 0) {
      slideIssue("undercut_to_rework_at_parting_line", "review",
        `${plural(slides.parting_zones, "zone qu'une chape pourrait former", "zones qu'une chape pourrait former")} mais que la ligne de joint laisse en contre-dépouille : ligne étagée ou faces à réaffecter.`);
    }
    if (slides.count > 0) requiredChecks.push("validate_slides_with_tooling");
    if (slides.cores > 0) requiredChecks.push("confirm_cores_for_unreleasable_undercuts");
  }
  // Risers and ingate proposed from the geometry (feeding.js) or placed by
  // hand: a starting point, to be validated; a hot spot needing a riser left
  // without one is a likely shrinkage.
  if (feedingKnown) {
    confirmedEvidence.push(feeding.risers_status === "manual" ? "risers_placed_manually" : "risers_proposed_from_geometry");
    if (feeding.gate?.on_parting_line) confirmedEvidence.push("gate_on_parting_line");
    if (feeding.hot_spots_without_riser.length) {
      risks.push(issue(
        "hot_spot_without_riser",
        "review",
        "measured_feeding_zones_inscribed_spheres",
        `${feeding.hot_spots_without_riser.length} zone(s) d'alimentation isolée(s) par une section plus mince (zones ${feeding.hot_spots_without_riser.map(z => z + 1).join(", ")}) sans masselotte (ou d'un module inférieur à 1,2 × celui de la zone) : retassure probable sans masselotte, refroidisseur ou refroidissement local; à confirmer par une simulation ou avec la fonderie.`,
        ["wlodawer_1966","chvorinov_1940","sfsa_design_steps"],
        { zones: feeding.hot_spots_without_riser },
      ));
    }
    if (feeding.gate && !feeding.gate.on_parting_line) {
      risks.push(issue(
        "gate_off_parting_line",
        "review",
        "manual_gate_position",
        "L'attaque placée à la main n'est pas sur la ligne de joint (aucune ligne connue) : son accès par le moule est à confirmer.",
        ["campbell_casting_handbook","sfsa_design_steps"],
      ));
    }
    requiredChecks.push(feeding.status === "manual" ? "validate_manual_risers_and_gate_with_solidification_and_flow_analysis" : "validate_proposed_risers_and_gate_with_solidification_and_flow_analysis");
  } else {
    requiredChecks.push("locate_and_size_risers_after_solidification_analysis");
    requiredChecks.push("design_gating_after_flow_analysis");
  }
  requiredChecks.push("validate_directional_solidification");
  requiredChecks.push("run_fill_and_solidification_simulation_for_advanced_claims");

  const ruleStatus = {
    uniform_wall_thickness: thickness.status === "measured" ? "screened" : "not_available",
    section_transitions: "not_localized_from_current_semantic_geometry",
    draft: partingKnown ? "evaluated_from_zero_draft_area" : "not_evaluated_without_parting_direction",
    fillets_and_junctions: "candidate_geometry_only",
    parting_line: !partingKnown ? "not_evaluated" : parting.status === "manual" ? "manual" : "proposed_from_geometry",
    cores: partingKnown
      ? (undercut ? "undercuts_detected" : "no_undercut_for_the_chosen_axis")
      : cylindricalFaces.size + pocketCount > 0 ? "undetermined_without_concavity_test" : "not_detected",
    slides: !slidesKnown ? "not_evaluated"
      : slides.status === "manual" ? "edited_manually"
        : slides.count === 0 && slides.cores === 0 ? "none_needed" : "proposed_from_undercut_regions",
    hot_spots: feedingKnown ? "located_by_inscribed_sphere_feeding_zones" : thickness.status === "measured" ? "screened_by_thickness_distribution" : "not_available",
    directional_solidification: feedingKnown ? "screened_by_section_necks_not_simulated" : "not_simulated",
    risering: !feedingKnown ? "not_sized" : feeding.risers_status === "manual" ? "placed_manually" : "proposed_by_modulus_heuristic",
    gating: !feedingKnown || !feeding.gate ? "not_sized" : feeding.gate.source === "manual" ? "placed_manually" : "proposed_on_parting_line",
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
      parting,
      slides,
      feeding,
      principal_axes: principalAxes,
      feature_counts: {
        cylindrical_opening_or_boss_candidates: cylindricalFaces.size,
        pocket_candidates: pocketCount,
        ...(measuredHoles.length ? { measured_through_holes: throughHoles, measured_blind_holes: blindHoles } : {}),
      },
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
      // A proposal of the modulus method from the geometry, not a design computed by a solver.
      riser_design: feedingKnown ? "heuristic_proposal_not_simulated" : "not_computed",
      gating_design: feedingKnown && feeding.gate ? "heuristic_proposal_not_simulated" : "not_computed",
      thermal_stress_distortion: "not_computed",
      message: "Cette couche prépare et explique l'analyse; elle ne remplace pas un solveur de fonderie.",
    },
    confidence_policy: "geometry_screening_is_evidence; foundry_process_claims_require_process_alloy_and_simulation_or_foundry_validation; heuristic_thresholds_are_not_sourced_limits_and_background_source_ids_do_not_define_them",
    sources: FOUNDRY_SOURCES.map(({ id, title, publisher, url, scope }) => ({ id, title, publisher, url, scope })),
  };
}
