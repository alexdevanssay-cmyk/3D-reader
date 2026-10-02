// Length units of mesh files, mirroring reader3d/mesh.py.
//
// All results of the engine are expressed in millimetres; a mesh file is
// scaled by the factor of its source unit when it is read.

/** Conversion factors to millimetres (the units the user can choose). */
export const UNITS = Object.freeze({ mm: 1.0, cm: 10.0, m: 1000.0, in: 25.4, ft: 304.8 });

/** Unit names a file may declare itself (3MF `unit` attribute, glTF/COLLADA metadata). */
export const UNIT_ALIASES = Object.freeze({
  millimeters: 1.0, millimeter: 1.0, mm: 1.0,
  centimeters: 10.0, centimeter: 10.0, cm: 10.0,
  meters: 1000.0, meter: 1000.0, m: 1000.0,
  inches: 25.4, inch: 25.4, in: 25.4,
  feet: 304.8, foot: 304.8, ft: 304.8,
  microns: 1e-3, micron: 1e-3,
});

/** Factor to millimetres of a user-selected unit ("mm", "cm", "m", "in", "ft"). */
export function unitFactor(unit) {
  if (!Object.prototype.hasOwnProperty.call(UNITS, unit)) {
    throw new Error(`Unknown unit '${unit}'`);
  }
  return UNITS[unit];
}

/**
 * Short name of a factor: the key of UNITS with exactly that factor, else `fallback`.
 * Same rule as mesh.py `_auto_unit` (e.g. a 3MF in microns is reported as "micron").
 */
export function unitName(factor, fallback) {
  for (const [name, value] of Object.entries(UNITS)) {
    if (value === factor) return name;
  }
  return fallback;
}

/**
 * Resolve a unit name declared by a file ("millimeter", "inch", ...).
 * Returns `{ name, factor }` or null when the name is unknown.
 */
export function unitFromName(declared) {
  const key = String(declared ?? '').trim().toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(UNIT_ALIASES, key)) return null;
  const factor = UNIT_ALIASES[key];
  return { name: unitName(factor, key), factor };
}
