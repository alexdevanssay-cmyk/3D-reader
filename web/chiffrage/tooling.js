// Cost of a steel die made in-house (gravity die "coquille", low pressure
// die), with the method of the foundry's tooling workbook (sheet "Outillage
// fonderie"):
//   weight of the die = L × l × h × steel density × coefficient (by the
//                       weight of the bare block)
//   steel             = weight × price per kg of the type of die
//   3-axis milling    = h(3 axes présentiel) × rate + h(3 axes auto) × rate
//                       + h(tiroir 3 axes) × présentiel rate × slides
//   5-axis milling    = idem with the 5-axis hours
//   scan, fitting     = hours of the weight band × rate
//   CAM, design       = hours by complexity × rate
//   subcontracting    = cost / (1 − share) − cost;  margin likewise
// The size of the die (L × l × h) is not in the 3D model: it is the size of
// the part plus margins. The values below are neutral starting values: the
// foundry's own (prices, rates, hours, margins calibrated on its dies) are
// imported as a settings file (Paramètres → Importer des paramètres), never
// written in this public code.

export const DEFAULT_TOOLING = {
  actif: true, // the gravity and low pressure dies are costed with this estimate
  types: [
    { label: "X38CrMoV5 (1.2343)", prixKg: 7.5 },
    { label: "XC48", prixKg: 6 },
  ],
  type: 0,
  densite: 7.8,
  // Weight coefficient by the weight of the bare block (kg): [{max, coef}].
  coefPoids: [{ max: 1e9, coef: 1.2 }],
  // Size of the die = size of the part + 2 × margin (mm); cavities side by side
  // along the middle size of the part.
  marges: { longueur: 60, largeur: 60, hauteur: 50, entreEmpreintes: 40 },
  // Hours per weight band of the die (kg).
  bandes: [
    { max: 200, ax3: 50, ax3auto: 50, ax5: 5, ax5auto: 5, tiroir3: 5, tiroir5: 5, scan: 5, ajustage: 50 },
    { max: 300, ax3: 50, ax3auto: 50, ax5: 10, ax5auto: 10, tiroir3: 10, tiroir5: 10, scan: 10, ajustage: 50 },
    { max: 400, ax3: 50, ax3auto: 50, ax5: 15, ax5auto: 15, tiroir3: 15, tiroir5: 15, scan: 15, ajustage: 50 },
    { max: 500, ax3: 60, ax3auto: 60, ax5: 20, ax5auto: 20, tiroir3: 20, tiroir5: 20, scan: 20, ajustage: 60 },
    { max: 600, ax3: 60, ax3auto: 60, ax5: 28, ax5auto: 28, tiroir3: 28, tiroir5: 28, scan: 28, ajustage: 60 },
    { max: 700, ax3: 80, ax3auto: 80, ax5: 30, ax5auto: 30, tiroir3: 30, tiroir5: 30, scan: 30, ajustage: 80 },
    { max: 800, ax3: 80, ax3auto: 80, ax5: 35, ax5auto: 35, tiroir3: 35, tiroir5: 35, scan: 35, ajustage: 80 },
    { max: 900, ax3: 100, ax3auto: 100, ax5: 40, ax5auto: 40, tiroir3: 40, tiroir5: 40, scan: 40, ajustage: 100 },
    { max: 1000, ax3: 100, ax3auto: 100, ax5: 45, ax5auto: 45, tiroir3: 45, tiroir5: 45, scan: 45, ajustage: 100 },
    { max: 2000, ax3: 150, ax3auto: 150, ax5: 50, ax5auto: 50, tiroir3: 50, tiroir5: 50, scan: 50, ajustage: 150 },
  ],
  // Design and CAM hours by complexity.
  etude: { Simple: 40, Moyen: 60, "Compliqué(e)": 80 },
  fao: { Simple: 20, Moyen: 40, "Compliqué(e)": 60 },
  taux: { etude: 65, fao: 65, ax3: 85, ax3auto: 45, ax5: 110, ax5auto: 60, scan: 65, ajustage: 60 }, // €/h
  // Defaults of a part; each part can set its own.
  tiroirs: 0,
  complexite: "Moyen",
  sousTraitance: 0.1, // share of subcontracting (STT)
  marge: 0, // margin on the die
};

export const COMPLEXITES = ["Simple", "Moyen", "Compliqué(e)"];

/** Hours of the weight band of a die or a core box (the last band above its maximum). */
export function bandOf(bandes, kg) {
  return bandes.find((b) => kg <= b.max) ?? bandes.at(-1);
}

/** Weight coefficient of a block of `bareKg` (kg of the bare block). */
export function coefOf(coefPoids, bareKg) {
  if (!Array.isArray(coefPoids)) return Number(coefPoids) || 1;
  return (coefPoids.find((c) => bareKg <= c.max) ?? coefPoids.at(-1))?.coef ?? 1;
}

/**
 * Cost lines of a steel tool of L × l × h mm with the method of the workbook:
 * {total, suivant (next tool: without design and CAM), kg, band, lines}.
 *   o: {L, l, h, prixKg, typeLabel, tiroirs, etudeH, faoH}
 *   s: {densite, coefPoids, bandes, taux, sousTraitance, marge}
 */
export function steelToolCost(o, s) {
  const bare = (o.L * o.l * o.h * s.densite) / 1e6;
  const coef = coefOf(s.coefPoids, bare);
  const kg = bare * coef;
  const band = bandOf(s.bandes, kg);
  const t = s.taux;
  const slides = o.tiroirs || 0;
  const nf = (v, d = 1) => Number(v).toLocaleString("fr-FR", { maximumFractionDigits: d });
  const lines = [
    { label: `Acier (${o.typeLabel})`, detail: `${nf(o.L, 0)} × ${nf(o.l, 0)} × ${nf(o.h, 0)} mm × ${nf(s.densite)} × ${nf(coef, 2)} = ${nf(kg, 0)} kg × ${nf(o.prixKg, 2)} €/kg`, value: kg * o.prixKg },
    { label: "Usinage 3 axes", detail: `${nf(band.ax3)} h × ${nf(t.ax3, 0)} € + ${nf(band.ax3auto)} h auto × ${nf(t.ax3auto, 0)} €${slides ? ` + ${nf(band.tiroir3)} h × ${slides} tiroir${slides > 1 ? "s" : ""}` : ""}`, value: band.ax3 * t.ax3 + band.ax3auto * t.ax3auto + band.tiroir3 * t.ax3 * slides },
    { label: "Usinage 5 axes", detail: `${nf(band.ax5)} h × ${nf(t.ax5, 0)} € + ${nf(band.ax5auto)} h auto × ${nf(t.ax5auto, 0)} €${slides ? ` + ${nf(band.tiroir5)} h × ${slides} tiroir${slides > 1 ? "s" : ""}` : ""}`, value: band.ax5 * t.ax5 + band.ax5auto * t.ax5auto + band.tiroir5 * t.ax5 * slides },
    { label: "FAO", detail: `${nf(o.faoH)} h × ${nf(t.fao, 0)} €/h`, value: o.faoH * t.fao },
    { label: "Scan 3D + rapport", detail: `${nf(band.scan)} h × ${nf(t.scan, 0)} €/h`, value: band.scan * t.scan },
    { label: "Étude", detail: `${nf(o.etudeH)} h × ${nf(t.etude, 0)} €/h`, value: o.etudeH * t.etude },
    { label: "Ajustage / montage", detail: `${nf(band.ajustage)} h × ${nf(t.ajustage, 0)} €/h`, value: band.ajustage * t.ajustage },
  ];
  const cost = lines.reduce((n, l) => n + l.value, 0);
  const stt = cost / (1 - s.sousTraitance) - cost;
  const marge = (cost + stt) / (1 - s.marge) - stt - cost;
  if (stt) lines.push({ label: "Sous-traitance", detail: `${nf(s.sousTraitance * 100, 0)} %`, value: stt });
  if (marge) lines.push({ label: "Marge", detail: `${nf(s.marge * 100, 0)} %`, value: marge });
  const etudeFao = o.faoH * t.fao + o.etudeH * t.etude;
  const suivant = ((cost + stt - etudeFao) / (1 - s.marge));
  return { total: cost + stt + marge, suivant, kg, coef, band, lines };
}

/** Size of the die of a part (mm): the part, largest first, plus the margins; the cavities side by side. */
export function dieSize(part, cavities, t = DEFAULT_TOOLING) {
  const n = Math.max(1, Math.round(cavities || 1));
  let [a, b, c] = (part.bboxSize?.length === 3 ? [...part.bboxSize] : [part.dimMax || 100, (part.dimMax || 100) / 2, (part.dimMax || 100) / 4]).sort((x, y) => y - x);
  a ||= 1; b ||= 1; c ||= 1;
  const m = t.marges;
  return { L: a + 2 * m.longueur, l: n * b + (n - 1) * m.entreEmpreintes + 2 * m.largeur, h: c + 2 * m.hauteur, n };
}

/**
 * Estimate of the die of a part.
 *   part: {bboxSize: [x, y, z] mm (null if unknown), dimMax mm,
 *          outillageTiroirs, outillageComplexite (else the defaults of the settings)}
 *   cavities: number of cavities of the die
 *   t: the settings (DEFAULT_TOOLING)
 * Returns {total, suivant, lines: [{label, detail, value}], cavities, block: {L, W, H, kg}, tiroirs, complexite}.
 */
export function estimateTooling(part, cavities, t = DEFAULT_TOOLING) {
  const size = dieSize(part, cavities, t);
  const type = t.types[t.type] ?? t.types[0];
  const tiroirs = part.outillageTiroirs ?? t.tiroirs ?? 0;
  const complexite = part.outillageComplexite || t.complexite || "Moyen";
  const r = steelToolCost({ L: size.L, l: size.l, h: size.h, prixKg: type.prixKg, typeLabel: type.label, tiroirs, etudeH: t.etude[complexite] ?? 0, faoH: t.fao[complexite] ?? 0 }, t);
  return {
    total: r.total,
    suivant: r.suivant,
    lines: r.lines,
    cavities: size.n,
    block: { L: size.L, W: size.l, H: size.h, kg: r.kg },
    tiroirs,
    complexite,
  };
}

/** An island whose dies are made in-house (gravity dies, low pressure dies). */
export const isGravityDie = (process) => /^(Coquille gravité|Basse pression)/i.test(process?.famille ?? "");
