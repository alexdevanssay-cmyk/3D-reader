// Cost of a steel gravity die ("coquille") made in-house, from the geometry
// of the part: the steel of the two halves, the CNC milling (squaring of the
// blocks, roughing and finishing of the cavities, CAM programming) and the
// fitting and assembly of the die. All the coefficients are settings of the
// page (Paramètres): starting values, to be set to the workshop's own.

export const DEFAULT_TOOLING = {
  actif: true, // the gravity dies (islands "Coquille gravité") are costed with this estimate
  acier: { nuance: "X38CrMoV5 (1.2343)", prixKg: 7.5, densite: 7.85, traitementKg: 2.5 },
  // Steel around the cavities (mm): side walls, bottom of each half, between two cavities.
  bloc: { paroi: 60, fond: 50, entreEmpreintes: 40 },
  // Feeding system (runners, feeders, vents): share added to the cavity volume and surface.
  alimentation: 0.35,
  usinage: {
    taux: 85, // €/h, CNC milling centre
    dressage: 600, // cm²/h: squaring of the blocks (all their faces)
    ebauche: 30, // cm³/min: roughing of the steel
    finition: 120, // cm²/h: finishing of the cavity surfaces (ball-end mill)
    tauxProgrammation: 65, // €/h, CAM
    programmationBase: 6, // h
    programmationParDm2: 1.5, // h per dm² of cavity surface
  },
  montage: { taux: 60, base: 24, parEmpreinte: 6, parNoyau: 8 }, // €/h, h (fitting, ejectors, cooling, assembly, try-out)
  composants: { base: 1500, parEmpreinte: 250 }, // € (pillars, bushes, ejector pins, heating cartridges)
  aleas: 0.1, // contingencies, share of the total
};

/**
 * Estimate of the die of a part.
 *   part: {bboxSize: [x, y, z] mm (null if unknown), volume mm³, area mm², dimMax mm, noyaux}
 *   cavities: number of cavities of the die
 *   t: the settings (DEFAULT_TOOLING)
 * Returns {total, lines: [{label, detail, value}], block: {L, W, H, kg}, hours: {cnc, programmation, montage}}.
 */
export function estimateTooling(part, cavities, t = DEFAULT_TOOLING) {
  const n = Math.max(1, Math.round(cavities || 1));
  // Size of the part, largest first; without a 3D model, a guess from its largest size.
  let [a, b, c] = (part.bboxSize?.length === 3 ? [...part.bboxSize] : [part.dimMax || 100, (part.dimMax || 100) / 2, (part.dimMax || 100) / 4]).sort((x, y) => y - x);
  a ||= 1; b ||= 1; c ||= 1;
  // Two halves split at the middle of the smallest size; the cavities side by side.
  const L = a + 2 * t.bloc.paroi;
  const W = n * b + (n - 1) * t.bloc.entreEmpreintes + 2 * t.bloc.paroi;
  const H = c + 2 * t.bloc.fond;
  const kg = (L * W * H * t.acier.densite) / 1e6;
  const blockArea = 2 * (L * W + L * H + W * H) + 2 * L * W; // both halves: outside faces and parting faces (mm²)

  // Cavities: the volume and surface of the part (from the 3D model, else its envelope), plus the feeding.
  const volume = part.volume > 0 ? part.volume : a * b * c * 0.4;
  const area = part.area > 0 ? part.area : 2 * (a * b + a * c + b * c);
  const k = 1 + t.alimentation;
  const cavityVolume = (volume * n * k) / 1000; // cm³
  const cavityArea = (area * n * k) / 100; // cm²

  const hDressage = blockArea / 100 / t.usinage.dressage;
  const hEbauche = cavityVolume / t.usinage.ebauche / 60;
  const hFinition = cavityArea / t.usinage.finition;
  const cnc = hDressage + hEbauche + hFinition;
  const programmation = t.usinage.programmationBase + (t.usinage.programmationParDm2 * cavityArea) / 100;
  const montage = t.montage.base + t.montage.parEmpreinte * n + (part.noyaux ? t.montage.parNoyau : 0);

  const nf = (v, d = 1) => Number(v).toLocaleString("fr-FR", { maximumFractionDigits: d });
  const lines = [
    { label: `Acier ${t.acier.nuance}`, detail: `2 demi-coquilles ${nf(L, 0)} × ${nf(W, 0)} × ${nf(H / 2, 0)} mm, ${nf(kg, 0)} kg × ${nf(t.acier.prixKg, 2)} €/kg`, value: kg * t.acier.prixKg },
    { label: "Traitement (trempe, revenu, nitruration)", detail: `${nf(kg, 0)} kg × ${nf(t.acier.traitementKg, 2)} €/kg`, value: kg * t.acier.traitementKg },
    { label: "Fraisage CNC — dressage des blocs", detail: `${nf(blockArea / 100, 0)} cm² → ${nf(hDressage)} h`, value: hDressage * t.usinage.taux },
    { label: "Fraisage CNC — ébauche des empreintes", detail: `${nf(cavityVolume, 0)} cm³ (${n} empreinte${n > 1 ? "s" : ""} + alimentation) → ${nf(hEbauche)} h`, value: hEbauche * t.usinage.taux },
    { label: "Fraisage CNC — finition des empreintes", detail: `${nf(cavityArea, 0)} cm² → ${nf(hFinition)} h`, value: hFinition * t.usinage.taux },
    { label: "Programmation FAO", detail: `${nf(programmation)} h × ${nf(t.usinage.tauxProgrammation, 0)} €/h`, value: programmation * t.usinage.tauxProgrammation },
    { label: "Montage, ajustage et assemblage du moule", detail: `${nf(montage)} h × ${nf(t.montage.taux, 0)} €/h`, value: montage * t.montage.taux },
    { label: "Composants standard", detail: "colonnes, bagues, éjecteurs, cartouches", value: t.composants.base + t.composants.parEmpreinte * n },
  ];
  const subtotal = lines.reduce((s, l) => s + l.value, 0);
  lines.push({ label: "Aléas", detail: `${nf(t.aleas * 100, 0)} %`, value: subtotal * t.aleas });
  return {
    total: subtotal * (1 + t.aleas),
    lines,
    cavities: n,
    block: { L, W, H, kg },
    hours: { cnc, programmation, montage },
  };
}

/** A gravity die island (its tooling can be made in-house). */
export const isGravityDie = (process) => /^Coquille gravité/i.test(process?.famille ?? "");
