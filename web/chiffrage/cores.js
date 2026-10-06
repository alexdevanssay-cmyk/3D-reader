// Sand cores of a piece: their cost per piece (sand, core making) and the
// cost of their core boxes ("boîtes à noyau", BAN), with the method of the
// foundry's tooling workbook (sheet "Outillage fonderie", rows BAN), the same
// as the dies (tooling.js): weight of the box = L × l × h × 7.8 × coefficient,
// steel, 3- and 5-axis milling, scan and fitting by weight band, design and
// CAM by complexity, subcontracting. The hourly rates, the hours of the weight
// bands and the weight coefficients are those of the dies (one table in the
// workbook): the tooling settings. Neutral starting values: the foundry's own
// are imported as a settings file.

import { DEFAULT_TOOLING, steelToolCost } from "./tooling.js";

export const DEFAULT_CORES = {
  sableDensite: 1.6, // kg/dm³ of core sand, to size a core box from the mass of its core
  paroi: 50, // mm of steel around the core in its box
  types: [
    { label: "INDUS BAN XC48", prixKg: 8 },
    { label: "AUTO BAN 110 KGS", prixKg: 11 },
  ],
  // Design and CAM hours by complexity.
  etude: { Simple: 40, Moyen: 60, "Compliqué(e)": 80 },
  fao: { Simple: 8, Moyen: 12, "Compliqué(e)": 16 },
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

/**
 * Cost of the core box of a core: {total, suivant, kg, size, band, lines: [{label, detail, value}]}.
 *   s: the core settings (DEFAULT_CORES); t: the tooling settings (rates, bands, weight coefficients).
 */
export function coreBoxCost(core, s = DEFAULT_CORES, t = DEFAULT_TOOLING) {
  const size = boxSize(core, s);
  const type = s.types[core.type] ?? s.types[0];
  // Complexities of earlier versions ("Très compliqué(e)") count as the most complex one.
  const complexite = core.complexite in s.etude ? core.complexite : "Compliqué(e)";
  const r = steelToolCost(
    { L: size.L, l: size.l, h: size.h, prixKg: type.prixKg, typeLabel: type.label, tiroirs: core.tiroirs || 0, etudeH: s.etude[complexite] ?? 0, faoH: s.fao?.[complexite] ?? 0 },
    { densite: t.densite, coefPoids: t.coefPoids, bandes: t.bandes, taux: t.taux, sousTraitance: s.sousTraitance, marge: s.marge },
  );
  return { total: r.total, suivant: r.suivant, kg: r.kg, size, band: r.band, lines: r.lines };
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
