// Sand cores of a piece: their cost per piece (sand, core making) and the
// cost of their core boxes ("boîtes à noyau", BAN), with the method of the
// "4- Outillage" sheet of the customer request workbook (section BAN):
//   weight of the box = L × l × h × 7.8 kg/dm³ (steel)
//   steel             = weight × price per kg of the type of box
//   3-axis milling    = h(3 axes présentiel) × rate + h(3 axes auto) × rate + h(tiroirs 3 axes) × rate × slides
//   5-axis milling    = idem with the 5-axis hours
//   CAM, design       = hours × rate;  scan, fitting = hours of the weight band × rate
//   subcontracting    = cost / (1 − share) − cost;  margin likewise
// The hours of each weight band are those of the workbook; its hourly rates
// are placeholders (10 €/h), so the rates below are starting values of the
// page (Paramètres), like everything here.

export const DEFAULT_CORES = {
  sableDensite: 1.6, // kg/dm³ of core sand, to size a core box from the mass of its core
  paroi: 50, // mm of steel around the core in its box
  densiteAcier: 7.8,
  types: [
    { label: "INDUS BAN XC48", prixKg: 8 },
    { label: "AUTO BAN 110 KGS", prixKg: 11 },
  ],
  // Hours per weight band of the box (kg): "Coquille/BAN/HPDC" table of the workbook.
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
  // Design hours by complexity (BOITE A NOYAU column of the workbook).
  etude: { Simple: 40, Moyen: 60, "Compliqué(e)": 80, "Très compliqué(e)": 100 },
  faoHeures: 8, // CAM hours of a box, by default
  taux: { ax3: 85, ax3auto: 45, ax5: 110, ax5auto: 60, fao: 65, etude: 65, scan: 65, ajustage: 60 }, // €/h
  sousTraitance: 0.1, // share of subcontracting (STT)
  marge: 0, // margin on the boxes
};

/** A core of a piece, with the defaults: sand mass from the piece weight when unknown. */
export function newCore(i, poids = 0) {
  return { nom: `Noyau ${i + 1}`, masse: poids > 0 ? Math.round(poids * 0.2 * 1000) / 1000 : 0.2, qte: 1, L: null, l: null, h: null, type: 0, tiroirs: 0, complexite: "Moyen" };
}

/** Inside size of a box (mm) for a core of this sand mass: a cube of its volume, plus the walls. */
export function boxSize(core, s = DEFAULT_CORES) {
  const side = Math.cbrt(((core.masse || 0) / s.sableDensite) * 1e6); // mm
  const auto = side + 2 * s.paroi;
  return { L: core.L > 0 ? core.L : auto, l: core.l > 0 ? core.l : auto, h: core.h > 0 ? core.h : auto, auto: !(core.L > 0 && core.l > 0 && core.h > 0) };
}

/** Cost of the core box of a core: {total, kg, size, lines: [{label, detail, value}]}. */
export function coreBoxCost(core, s = DEFAULT_CORES) {
  const size = boxSize(core, s);
  const kg = (size.L * size.l * size.h * s.densiteAcier) / 1e6;
  const band = s.bandes.find((b) => kg <= b.max) ?? s.bandes.at(-1);
  const type = s.types[core.type] ?? s.types[0];
  const t = s.taux;
  const slides = core.tiroirs || 0;
  const etude = s.etude[core.complexite] ?? 0;
  const nf = (v, d = 1) => Number(v).toLocaleString("fr-FR", { maximumFractionDigits: d });
  const lines = [
    { label: `Acier (${type.label})`, detail: `${nf(size.L, 0)} × ${nf(size.l, 0)} × ${nf(size.h, 0)} mm, ${nf(kg, 0)} kg × ${nf(type.prixKg, 2)} €/kg`, value: kg * type.prixKg },
    { label: "Usinage 3 axes", detail: `${band.ax3} h + ${band.ax3auto} h auto${slides ? ` + ${band.tiroir3} h × ${slides} tiroir(s)` : ""}`, value: band.ax3 * t.ax3 + band.ax3auto * t.ax3auto + band.tiroir3 * t.ax3 * slides },
    { label: "Usinage 5 axes", detail: `${band.ax5} h + ${band.ax5auto} h auto${slides ? ` + ${band.tiroir5} h × ${slides} tiroir(s)` : ""}`, value: band.ax5 * t.ax5 + band.ax5auto * t.ax5auto + band.tiroir5 * t.ax5 * slides },
    { label: "FAO", detail: `${nf(s.faoHeures)} h × ${nf(t.fao, 0)} €/h`, value: s.faoHeures * t.fao },
    { label: "Étude", detail: `${core.complexite} : ${etude} h × ${nf(t.etude, 0)} €/h`, value: etude * t.etude },
    { label: "Scan 3D + rapport", detail: `${band.scan} h`, value: band.scan * t.scan },
    { label: "Ajustage / montage", detail: `${band.ajustage} h × ${nf(t.ajustage, 0)} €/h`, value: band.ajustage * t.ajustage },
  ];
  const cost = lines.reduce((n, l) => n + l.value, 0);
  const stt = cost / (1 - s.sousTraitance) - cost;
  const marge = (cost + stt) / (1 - s.marge) - stt - cost;
  if (stt) lines.push({ label: "Sous-traitance", detail: `${nf(s.sousTraitance * 100, 0)} %`, value: stt });
  if (marge) lines.push({ label: "Marge", detail: `${nf(s.marge * 100, 0)} %`, value: marge });
  return { total: cost + stt + marge, kg, size, band, lines };
}

/** The cores of a piece: sand per piece (kg) and core-making time per piece (s, ASN centre). */
export function coresPerPiece(cores, asn) {
  let sable = 0;
  let cycle = 0;
  for (const c of cores ?? []) {
    const n = c.qte || 0;
    sable += (c.masse || 0) * n;
    cycle += n * (asn.base + asn.parKg * (c.masse || 0));
  }
  return { sable, cycle };
}
