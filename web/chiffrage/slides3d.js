// The slides (« tiroirs ») of the 3D analysis proposed to the costing: the
// undercuts of the part grouped by pull direction on the 3D page
// (engine/slides.js, app.js slidesBrief), per part × the cavities of the die,
// for « Tiroirs du moule ». Never applied by itself: « Utiliser » writes the
// count as the piece's value (q.pieces[key].outillageTiroirs) with a record of
// that adoption (tiroirs3D: when, what it was, what it came from), traced
// « analyse 3D validée »; a value typed afterwards drops the record, a change
// of the analysis since is shown, never applied. Pure functions, no DOM;
// French only, like the costing pages.

import { sameValue } from "./ai-apply.js";

const fr = (v, digits = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: digits });
const day = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("fr-FR") : "");
const tiroirs = (n) => `${n} tiroir${n > 1 ? "s" : ""}`;
const empreintes = (n) => `${n} empreinte${n > 1 ? "s" : ""}`;

/**
 * What the 3D analysis proposes for « Tiroirs du moule » of a piece on a
 * route (`piece.slides`: the brief of the 3D page): {status ("ready",
 * "computing", "error", "idle", "none"), perPart, cavities (of the die),
 * value (perPart × cavities), signature, slides, cores, parting_zones,
 * ignored, parting, warnings, edited, message}; null for a route without an
 * in-house die (no slides to count).
 */
export function slidesProposal(piece, route) {
  if (!route?.tooling) return null;
  const s = piece?.slides ?? null;
  const cavities = route.tooling.cavities ?? 1;
  const ready = s?.status === "ready" && Number.isInteger(s.count);
  return {
    status: ready ? "ready" : s?.status ?? "none",
    perPart: ready ? s.count : null,
    cavities,
    value: ready ? s.count * cavities : null,
    signature: ready ? s.signature ?? null : null,
    slides: ready && Array.isArray(s.slides) ? s.slides : [],
    cores: ready ? s.cores ?? 0 : 0,
    parting_zones: ready ? s.parting_zones ?? 0 : 0,
    ignored: ready ? s.ignored ?? 0 : 0,
    parting: s?.parting ?? null,
    warnings: ready && Array.isArray(s.warnings) ? s.warnings : [],
    edited: !!s?.edited,
    message: s?.message ?? null,
  };
}

/** A slide's pull direction in words: « +Y », « +Y +30° », « +Y, incliné de 20° vers le haut ». */
export function slideName(s) {
  let name = String(s?.reference_axis ?? s?.axis ?? "").replace(/^-/, "−");
  if (Number.isFinite(s?.angle_deg)) name += ` ${s.angle_deg > 0 ? "+" : "−"}${fr(Math.abs(s.angle_deg))}°`;
  if (Number.isFinite(s?.tilt_deg)) name += `, incliné de ${fr(s.tilt_deg)}° vers le ${s.tilt_up === false ? "bas" : "haut"}`;
  return name;
}

/** The parting line the slides are for: « plan de joint Z proposé », « … X défini à la main », « … dessiné à la main ». */
export function partingText(p) {
  if (!p) return "plan de joint inconnu";
  const axis = String(p.axis ?? "").replace(/^-/, "−");
  if (p.source === "drawn") return "plan de joint dessiné à la main";
  return `plan de joint ${axis} ${p.status === "manual" ? "défini à la main" : "proposé"}`;
}

/** The slides in short: « T1 +Y, course 15 mm ; T2 −X, course 25 mm ». */
const slidesList = (slides) => slides.map((s) => `${s.id} ${slideName(s)}, course ${fr(s.stroke_mm)} mm`).join(" ; ");

/** The count, per part and by cavities: « 2 par pièce × 2 empreintes », « 1 par pièce ». */
const perCavities = (perPart, cavities) => `${perPart} par pièce${cavities > 1 ? ` × ${empreintes(cavities)}` : ""}`;

/**
 * The count of the 3D analysis used for « Tiroirs du moule » of a piece
 * (`piece`: its inputs saved, `inputs`: those the costing used): the value
 * written, with its record (tiroirs3D: date, valeur, parPiece, empreintes,
 * avant (the value before, null: empty), signature, parting, slides, cores);
 * used again, the value before the first use is kept.
 */
export function adoptSlides(piece, inputs, proposal, date = new Date().toISOString()) {
  const earlier = piece.tiroirs3D && sameValue(piece.outillageTiroirs ?? null, piece.tiroirs3D.valeur) ? piece.tiroirs3D : null;
  const avant = earlier ? earlier.avant ?? null : inputs?.outillageTiroirs ?? null;
  piece.outillageTiroirs = proposal.value;
  piece.tiroirs3D = {
    date,
    valeur: proposal.value,
    parPiece: proposal.perPart,
    empreintes: proposal.cavities,
    avant,
    signature: proposal.signature,
    parting: proposal.parting,
    slides: proposal.slides.map((s) => ({ id: s.id, nom: slideName(s), course_mm: s.stroke_mm })),
    cores: proposal.cores,
  };
  return piece.tiroirs3D;
}

/**
 * The adoption of the 3D analysis of a piece (`inputs`: its inputs, with
 * tiroirs3D): {record, adopted (the value is still the one used), stale (the
 * analysis proposes something else since: another definition, other edits,
 * another count or other cavities)}.
 */
export function adoptionOf(inputs, proposal) {
  const record = inputs?.tiroirs3D ?? null;
  const adopted = !!record && sameValue(inputs.outillageTiroirs ?? null, record.valeur);
  const stale = adopted && proposal?.status === "ready"
    && (record.signature !== proposal.signature || record.parPiece !== proposal.perPart || record.empreintes !== proposal.cavities);
  return { record, adopted, stale };
}

/** The 3D analysis no longer used: the value before it back (when the field still holds the one used), the record gone. */
export function undoSlides(piece) {
  const record = piece.tiroirs3D;
  if (!record) return null;
  if (sameValue(piece.outillageTiroirs ?? null, record.valeur)) {
    if (record.avant === null || record.avant === undefined) delete piece.outillageTiroirs;
    else piece.outillageTiroirs = record.avant;
  }
  delete piece.tiroirs3D;
  return record;
}

/** The record dropped once « Tiroirs du moule » no longer holds the value used (typed, applied from the AI). */
export function forgetSlidesAdoption(piece) {
  if (piece?.tiroirs3D && !sameValue(piece.outillageTiroirs ?? null, piece.tiroirs3D.valeur)) delete piece.tiroirs3D;
}

/**
 * The line under « Tiroirs du moule » (`r`: a result of ui.js computePiece):
 * {text, warn, buttons: [{action, label}]}, or null for a route without an
 * in-house die. `defaut`: the value the settings give when nothing is typed.
 */
export function slidesLineModel(r, { defaut = 0 } = {}) {
  const proposal = slidesProposal(r?.piece, r?.route);
  if (!proposal) return null;
  const inputs = r.inputs ?? {};
  const { record, adopted, stale } = adoptionOf(inputs, proposal);
  const typed = inputs.outillageTiroirs ?? null;
  const used = typed ?? defaut ?? 0;
  const buttons = [];
  const use = () => buttons.push({
    action: "use-slides-3d",
    label: `Utiliser ${tiroirs(proposal.value)}${proposal.cavities > 1 ? ` (${proposal.perPart} × ${empreintes(proposal.cavities)})` : ""}`,
  });
  if (proposal.status === "computing") return { text: "Analyse 3D des tiroirs en cours…", warn: false, buttons };
  if (proposal.status === "error") return { text: `Analyse 3D des tiroirs impossible : ${proposal.message ?? "erreur"}.`, warn: true, buttons };
  if (proposal.status !== "ready") return { text: "Pas d'analyse 3D des tiroirs : plan de joint non calculé pour ce corps (page Analyse 3D).", warn: false, buttons };

  const parting = partingText(proposal.parting);
  let text;
  let warn = false;
  if (adopted && !stale) {
    text = `${tiroirs(record.valeur)} : analyse 3D validée le ${day(record.date)} (${perCavities(record.parPiece, record.empreintes)}, ${partingText(record.parting)}).`;
    buttons.push({ action: "undo-slides-3d", label: "Ne plus utiliser l'analyse 3D" });
  } else if (adopted && stale) {
    warn = true;
    text = `L'analyse 3D propose maintenant ${tiroirs(proposal.value)} (validés : ${record.valeur} le ${day(record.date)}) : plan de joint, tiroirs ou empreintes modifiés depuis. La valeur reste ${record.valeur}.`;
    use();
    buttons.push({ action: "keep-slides-3d", label: `Garder ${record.valeur}` });
  } else if (typed !== null && sameValue(typed, proposal.value)) {
    text = `Conforme à l'analyse 3D (${tiroirs(proposal.perPart)} par pièce).`;
  } else {
    const n = proposal.perPart;
    const detail = n > 0 ? ` (${slidesList(proposal.slides)})` : "";
    const differs = typed !== null ? ` (saisi : ${typed})` : !sameValue(used, proposal.value) && used !== 0 ? ` (par défaut : ${used})` : "";
    const cores = proposal.cores > 0 ? ` ; ${proposal.cores} noyau${proposal.cores > 1 ? "x" : ""} probable${proposal.cores > 1 ? "s" : ""} (non compté${proposal.cores > 1 ? "s" : ""})` : "";
    const conform = typed === null && sameValue(used, proposal.value) ? " : conforme à la valeur par défaut" : "";
    // The conformity said of the count, before the cores (not counted).
    text = `Analyse 3D : ${tiroirs(n)} par pièce${detail}, ${parting}${differs}${conform}${cores}.`;
    if (!conform) use();
  }
  const notes = [];
  if (proposal.perPart === 0 && proposal.cores + proposal.parting_zones + proposal.ignored > 0) {
    notes.push("0 tiroir : les contre-dépouilles sont des noyaux probables, des détails ignorés ou à reprendre au plan de joint.");
  }
  if (proposal.warnings.includes("many_slides")) {
    warn = true;
    notes.push("Plus de 4 tiroirs : revoir la direction de démoulage, ou des noyaux.");
  }
  if (proposal.warnings.includes("capped")) notes.push("(analyse partielle)");
  if (proposal.cores > 0 && !inputs.noyaux) {
    // Information only: the box is never ticked from here. The cores already said in the line: not twice.
    notes.push(/ noyaux? probables? \(non comptés?\)/.test(text)
      ? "La case « Noyaux sable » n'est pas cochée."
      : `${proposal.cores} noyau${proposal.cores > 1 ? "x" : ""} probable${proposal.cores > 1 ? "s" : ""} selon l'analyse 3D : la case « Noyaux sable » n'est pas cochée.`);
  }
  return { text: [text, ...notes].join(" "), warn, buttons };
}

/** The message of « Utiliser » (the record of adoptSlides, the default value). */
export function adoptedMessage(record, { defaut = 0 } = {}) {
  const list = record.slides.length ? record.slides.map((s) => `${s.id} ${s.nom}`).join(", ") : "aucun tiroir";
  const before = record.avant === null || record.avant === undefined ? `vide (défaut ${defaut ?? 0})` : String(record.avant);
  return `Tiroirs du moule : ${record.valeur}, analyse 3D validée (${list} ; ${record.parPiece} × ${empreintes(record.empreintes)}). Avant : ${before}. « Ne plus utiliser l'analyse 3D » revient à la valeur d'avant.`;
}

/** The message of « Ne plus utiliser l'analyse 3D ». */
export function undoneMessage(record) {
  return `Tiroirs du moule : retour à ${record.avant === null || record.avant === undefined ? "la valeur par défaut" : record.avant}.`;
}

/** The hypotheses of the value used: the analysis it came from, and its parting line. */
export function adoptionHypotheses(record) {
  const list = record.slides.length ? ` (${record.slides.map((s) => `${s.id} ${s.nom}`).join(", ")})` : "";
  return [
    `analyse 3D du ${day(record.date)} : ${tiroirs(record.parPiece)} par pièce${record.empreintes > 1 ? ` × ${empreintes(record.empreintes)}` : ""}${list}`,
    partingText(record.parting),
  ];
}

/** The alternative of the trace: the count of the 3D analysis, not validated. */
export function proposalRef(proposal) {
  return `analyse 3D : ${tiroirs(proposal.perPart)} par pièce${proposal.cavities > 1 ? ` × ${empreintes(proposal.cavities)}` : ""} (non validés)`;
}

export { perCavities, tiroirs };
