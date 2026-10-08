// What the costing pages keep in this browser (localStorage): the data read
// from the costing workbook and from the metal prices file, the settings
// (TRS, islands, methods...) and the inputs of the current quote. Saved at
// every change, so they are back when the page is opened again. Nothing is
// sent anywhere.
//
// The settings are layers, resolved value by value at each loading (so a
// re-imported workbook or a new trends file is taken into account):
//   1. saisie    the values typed in the Paramètres page, and only those, each
//                with its provenance {source: "saisie", date};
//   2. classeur  the values the costing workbook holds (margin, minimum rate,
//                safety coefficient, changeover hours, yearly increases,
//                energy prices, working modes): current rules of the company;
//   3. tendance  the calibrated settings file imported in Paramètres (trends of
//                past quotes): a soft prior, never above a current value;
//   4. défaut    the neutral values of the code (DEFAULT_*).
// An empty field is "not set" (the next layer), never 0.

import { DEFAULT_OPERATIONS, DEFAULT_PROCESSES, DEFAULT_TRS, DEFAULT_TTH } from "./routes.js";
import { DEFAULT_TOOLING } from "./tooling.js";
import { DEFAULT_CORES } from "./cores.js";
import { indexAverage } from "./model.js";
import { MODES } from "./workbook.js";

const KEYS = {
  base: "reader3d.chiffrage.base.v1",
  indices: "reader3d.chiffrage.indices.v1",
  // Earlier versions: the whole settings object, defaults, imported file and
  // inputs mixed. Migrated once to `saisies`, then left as it is (a backup)
  // until the typed values are erased.
  settings: "reader3d.chiffrage.settings.v1",
  saisies: "reader3d.chiffrage.settings.v2", // {values: {path: {value, source: "saisie", date}}, migratedAt?}
  tendances: "reader3d.chiffrage.tendances.v1", // {fileName, importedAt, values, completed: [path]}
  quote: "reader3d.chiffrage.quote.v1",
};

// Densities of the alloys (g/cm³), to get the weight of the part from its volume.
export const DEFAULT_DENSITIES = {
  AS7G03: 2.68, AS7G06: 2.68, AS7U3: 2.75, AS8U3: 2.75, AS9G: 2.65, AS9GU: 2.7, AS9U3: 2.76,
  AS10G: 2.65, AS12: 2.65, AS12U: 2.7, AS12UNG: 2.68, AS13: 2.65, AZ10: 2.85, AZ5: 2.8,
};
// Density of an alloy that has none in the settings (an alert in the trace of the quote).
export const GENERIC_DENSITY = 2.7;

const clone = (x) => JSON.parse(JSON.stringify(x));

// Values that could not be saved (private window, storage full or blocked):
// kept for this visit, in place of the older ones of the storage.
const unsaved = new Map();

function read(key) {
  if (unsaved.has(key)) return JSON.parse(unsaved.get(key));
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.set(key, JSON.stringify(value));
    return false; // private window, storage full or blocked: works for this visit only
  }
}

export const loadBase = () => read(KEYS.base);
export const saveBase = (base) => write(KEYS.base, base);
export const loadIndices = () => read(KEYS.indices);
export const saveIndices = (indices) => write(KEYS.indices, indices);

// --------------------------------------------------------------------------- settings: the layers

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const at = (o, keys) => keys.reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);
const byDepth = (entries) => entries.sort(([a], [b]) => a.split(".").length - b.split(".").length);

/** The neutral settings of the code. */
function codeSettings() {
  return {
    trs: { ...DEFAULT_TRS },
    modes: {},
    processes: clone(DEFAULT_PROCESSES),
    operations: clone(DEFAULT_OPERATIONS),
    densities: { ...DEFAULT_DENSITIES },
    tooling: clone(DEFAULT_TOOLING), // in-house gravity dies (tooling.js)
    tth: clone(DEFAULT_TTH), // heat treatments: cost relative to T6
    cores: clone(DEFAULT_CORES), // sand cores and core boxes (cores.js)
    inflation: { salaires: 0.015, conso: 0.02, elec: 0, gaz: 0, autresEnergies: 0.03 },
    energy: null, // null: the workbook's prices
    marge: 0.12,
    tauxMini: 0.1,
    coefSecurite: 0.1,
    heuresChangementCoulee: 8,
    heuresChangementFinition: 1,
    seuilTendance: 0.15, // deviation from the trend above which the trace of the quote raises an alert (provenance.js)
  };
}

/** The settings the costing workbook holds (only those it has a value for). */
function workbookSettings(base) {
  if (!base) return {};
  const d = base.defaults ?? {};
  const known = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  const out = known({
    marge: d.marge,
    tauxMini: d.tauxMini,
    coefSecurite: d.coefSecurite,
    heuresChangementCoulee: d.changeover?.[0]?.heures,
    heuresChangementFinition: d.changeover?.[1]?.heures,
  });
  const inflation = known({ salaires: d.evolutionSalaires, conso: d.evolutionConso, elec: d.evolutionElec, gaz: d.evolutionGaz, autresEnergies: d.evolutionAutresEnergies });
  // Energy prices and working modes: what the costing already took from the workbook when the settings had none.
  const energy = Object.fromEntries(Object.entries(base.energy ?? {}).filter(([, v]) => Number.isFinite(v)));
  const modes = Object.fromEntries((base.centres ?? []).filter((c) => c.defaultMode).map((c) => [c.code, c.defaultMode]));
  for (const [k, v] of Object.entries({ inflation, energy, modes })) if (Object.keys(v).length) out[k] = v;
  return out;
}

/** Settings with their defaults; the workbook's values where it has some. */
export function defaultSettings(base) {
  return mergeSettings(codeSettings(), workbookSettings(base));
}

/** Settings `extra` (a whole or partial settings file) merged into `settings`; arrays are replaced. */
export function mergeSettings(settings, extra) {
  if (!isPlain(extra)) return settings;
  const out = { ...settings };
  for (const [k, v] of Object.entries(extra)) out[k] = isPlain(v) && isPlain(settings?.[k]) ? mergeSettings(settings[k], v) : v;
  return out;
}

/** Put `value` at `keys` of the settings `root`; not where the place does not exist (row of a shorter table, value instead of a group). */
function place(root, keys, value) {
  let o = root;
  for (const k of keys.slice(0, -1)) {
    if (Array.isArray(o) && !(Number(k) < o.length)) return;
    if (o[k] === null || o[k] === undefined) o[k] = {};
    else if (typeof o[k] !== "object") return;
    o = o[k];
  }
  const last = keys.at(-1);
  if (Array.isArray(o) && !(Number(last) < o.length)) return;
  // A table saved whole over another one: its rows completed by those below.
  const below = o[last];
  if (Array.isArray(value) && Array.isArray(below) && isPlain(below[0])) value = value.map((x, i) => (isPlain(x) ? { ...(below[i] ?? below.at(-1)), ...x } : x));
  o[last] = value;
}

/**
 * The effective settings: at each place, the value typed in (saisies: {path:
 * {value}}), else the workbook's, else the trend's, else the code's. A trend
 * never takes the place of a current value (typed, or of the workbook).
 */
export function resolveSettings({ code = codeSettings(), workbook = {}, tendances = null, saisies = {} } = {}) {
  const s = clone(mergeSettings(mergeSettings(code, tendances), workbook));
  for (const [path, e] of byDepth(Object.entries(saisies))) {
    if (e?.value !== null && e?.value !== undefined) place(s, path.split("."), clone(e.value));
  }
  return s;
}

/**
 * Migration of the settings of earlier versions. They were saved as one whole
 * object at the first change (defaults of the code and of the workbook, the
 * imported calibrated file and the inputs mixed). Each of its values becomes a
 * typed value, except:
 *   - those equal to the default of the code, or of the workbook, at the same
 *     place: they were defaults, not choices (a re-imported workbook now
 *     applies to them);
 *   - the empty ones (null: a field emptied, now "not set").
 * Tables of the same length as the default one are taken row by row, value by
 * value; others whole. The values of an imported calibrated file cannot be
 * told apart from the inputs: they are typed values too (Paramètres says so).
 */
export function migrateSettings(saved, base) {
  const refs = [defaultSettings(base), codeSettings()];
  const date = new Date().toISOString();
  const values = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  (function walk(v, keys) {
    const ref = refs.map((r) => at(r, keys)).find((x) => x !== undefined);
    if (isPlain(v)) for (const [k, x] of Object.entries(v)) walk(x, [...keys, k]);
    else if (Array.isArray(v) && Array.isArray(ref) && v.length === ref.length && v.every(isPlain)) v.forEach((x, i) => walk(x, [...keys, String(i)]));
    else if (v !== null && v !== undefined && keys.length && !refs.some((r) => same(at(r, keys), v))) values[keys.join(".")] = { value: v, source: "saisie", date, migrated: true };
  })(saved, []);
  return values;
}

function loadSaisies(base) {
  const saved = read(KEYS.saisies);
  if (isPlain(saved?.values)) return saved;
  const old = read(KEYS.settings);
  if (!isPlain(old)) return { values: {} };
  const saisies = { values: migrateSettings(old, base), migratedAt: new Date().toISOString() };
  write(KEYS.saisies, saisies);
  return saisies;
}

function loadTendances() {
  const t = read(KEYS.tendances);
  return isPlain(t?.values) ? t : null;
}

/** The typed value at `keys`, or the value saved whole that holds it (earlier versions). */
function typedAt(values, keys) {
  for (let n = keys.length; n > 0; n--) {
    const e = values[keys.slice(0, n).join(".")];
    if (e && (n === keys.length || at(e.value, keys.slice(n)) !== undefined)) return e;
  }
  return null;
}

/**
 * The settings and their layers: {effective, saisies, tendances,
 * provenance(path)}. provenance("trs.CG3") = {source: "saisie" | "classeur" |
 * "tendance" | "defaut", value, date?, fileName?, migrated?, trend (the
 * trend's value at that place, if any)}.
 */
export function loadSettingsLayers(base) {
  const code = codeSettings();
  const workbook = workbookSettings(base);
  const tendances = loadTendances();
  const saisies = loadSaisies(base);
  const effective = resolveSettings({ code, workbook, tendances: tendances?.values, saisies: saisies.values });
  const completed = new Set(tendances?.completed ?? []); // values the trends file did not have
  return {
    effective,
    saisies,
    tendances,
    provenance(path) {
      const keys = path.split(".");
      const value = at(effective, keys);
      const trend = tendances && !completed.has(path) ? at(tendances.values, keys) : undefined;
      const typed = typedAt(saisies.values, keys);
      if (typed) return { source: "saisie", value, date: typed.date, migrated: !!typed.migrated, trend };
      if (at(workbook, keys) !== undefined) return { source: "classeur", value, fileName: base?.source?.fileName, trend };
      if (trend !== undefined) return { source: "tendance", value, fileName: tendances.fileName, date: tendances.importedAt, trend };
      return { source: "defaut", value };
    },
  };
}

/** The effective settings (see loadSettingsLayers). */
export const loadSettings = (base) => loadSettingsLayers(base).effective;

// Values without meaning at 0 or out of their range: refused when typed in,
// left out of a trends file. modes: the working modes of the workbook.
const RULES = [
  { re: /^trs\.[^.]+$/, test: (v) => v > 0 && v <= 1, message: "TRS entre 0 et 100 %" },
  { re: /^densities\.[^.]+$/, test: (v) => v > 0, message: "densité supérieure à 0" },
  { re: /^operations\.[^.]+\.chargeKg$/, test: (v) => v > 0, message: "charge supérieure à 0 kg" },
  { re: /^processes\.[^.]+\.miseAuMille$/, test: (v) => v > 0, message: "mise au mille supérieure à 0" },
  { re: /^modes\.[^.]+$/, test: (v) => MODES.includes(v), message: `fonctionnement ${MODES.join(", ")}` },
  { re: /^seuilTendance$/, test: (v) => v >= 0, message: "seuil positif ou nul" },
];
const ruleOf = (path) => RULES.find((r) => r.re.test(path));

/**
 * A value typed in Paramètres at `path` ("trs.CG3"), saved with its date.
 * Empty (null, ""): not set, the value of the next layer comes back. Returns
 * the reason of a value refused (TRS at 0...), else null.
 */
export function setSetting(path, value, base = null) {
  if (value === null || value === undefined || value === "") {
    clearSetting(path, base);
    return null;
  }
  const rule = ruleOf(path);
  if (rule && !rule.test(value)) return rule.message;
  const saisies = loadSaisies(base);
  saisies.values[path] = { value, source: "saisie", date: new Date().toISOString() };
  write(KEYS.saisies, saisies);
  return null;
}

/** The typed value at `path` removed: the next layer applies there. */
export function clearSetting(path, base = null) {
  const saisies = loadSaisies(base);
  const keys = path.split(".");
  delete saisies.values[path];
  // Inside a group or a table saved whole (earlier versions): removed from it (a table row gets the value below).
  for (let n = keys.length - 1; n > 0; n--) {
    const parent = at(saisies.values[keys.slice(0, n).join(".")]?.value, keys.slice(n, -1));
    if (parent && typeof parent === "object") delete parent[keys.at(-1)];
  }
  write(KEYS.saisies, saisies);
}

/**
 * "Adopter la tendance": the typed value at `path` gives way to the trend.
 * Where the workbook has a value (above the trends), the trend is typed in.
 */
export function adoptTendance(path, base = null) {
  const keys = path.split(".");
  const trend = at(loadTendances()?.values, keys);
  if (trend === undefined) return;
  clearSetting(path, base);
  if (at(workbookSettings(base), keys) !== undefined) {
    const saisies = loadSaisies(base);
    saisies.values[path] = { value: trend, source: "saisie", date: new Date().toISOString(), from: "tendance" };
    write(KEYS.saisies, saisies);
  }
}

/** Erase the typed values (and the settings of earlier versions); the trends are kept. */
export function clearSaisies() {
  write(KEYS.saisies, { values: {} });
  write(KEYS.settings, null);
}

/** Erase the trends; the typed values are kept. */
export const clearTendances = () => write(KEYS.tendances, null);

/** The typed values as a settings file (groups of values; table rows by their number). */
export function exportSaisies(base = null) {
  const out = {};
  for (const [path, e] of byDepth(Object.entries(loadSaisies(base).values))) {
    const keys = path.split(".");
    let o = out;
    for (const k of keys.slice(0, -1)) o = isPlain(o[k]) || Array.isArray(o[k]) ? o[k] : (o[k] = {});
    o[keys.at(-1)] = e.value;
  }
  return out;
}

/** The trends imported: {fileName, importedAt, values}, or null. */
export const exportTendances = loadTendances;

// --------------------------------------------------------------------------- settings: trends file

/** Number of values of a settings file (a list of finishing methods counts as one). */
export function countValues(o) {
  if (Array.isArray(o)) return o.some((x) => x !== null && typeof x === "object") ? o.reduce((n, x) => n + countValues(x), 0) : 1;
  if (isPlain(o)) return Object.values(o).reduce((n, x) => n + countValues(x), 0);
  return o === null || o === undefined ? 0 : 1;
}

// Groups open to new entries (a centre, an alloy, a heat treatment): the
// shape of an entry; a new heat treatment needs its cost coefficient.
const OPEN = {
  trs: { template: 0 },
  modes: { template: "" },
  densities: { template: 0 },
  tth: { template: { label: "", coef: 0, cycle: "" }, required: ["coef"], complete: (code, t) => ({ label: code, cycle: "", ...t }) },
};
const TYPES = { number: "nombre attendu", string: "texte attendu", boolean: "vrai / faux attendu" };

/** The known key nearest to a misspelled one (at most 2 letters apart), or null. */
function nearest(key, known) {
  const distance = (a, b) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best = null;
  let min = 3;
  for (const k of known) {
    const d = distance(key.toLowerCase(), k.toLowerCase());
    if (d < min) [best, min] = [k, d];
  }
  return best;
}

/** Value `v` of a trends file checked against `ref`, the code's value at the same place `keys`; undefined: left out. */
function clean(v, ref, keys, report) {
  const path = keys.join(".");
  const refuse = (reason) => void report.invalid.push({ path, reason });
  if (v === null || v === undefined) return refuse("vide");
  if (Array.isArray(ref)) return cleanTable(v, ref, keys, report);
  if (isPlain(ref)) {
    if (!isPlain(v)) return refuse("groupe de valeurs attendu");
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith("_")) continue; // comments of the file
      const sub = [...keys, k];
      let c;
      if (Object.hasOwn(ref, k)) c = clean(x, ref[k], sub, report);
      else if (OPEN[path]) {
        const open = OPEN[path];
        c = clean(x, open.template, sub, report);
        const missing = c === undefined ? [] : (open.required ?? []).filter((r) => !Object.hasOwn(c, r));
        if (missing.length) {
          report.invalid.push({ path: sub.join("."), reason: `incomplet (${missing.join(", ")})` });
          c = undefined;
        } else if (c !== undefined && open.complete) c = open.complete(k, c);
      } else report.unknown.push({ path: sub.join("."), suggestion: nearest(k, Object.keys(ref)) });
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v !== typeof ref || (typeof v === "number" && !Number.isFinite(v))) return refuse(TYPES[typeof ref] ?? "valeur attendue");
  const rule = ruleOf(path);
  if (rule && !rule.test(v)) return refuse(rule.message);
  return v;
}

/**
 * A table of a trends file (bands of hours, weight coefficients, steel types,
 * finishing methods of an island). Rows missing a value get the default one
 * (reported in `completed`): a partial table never gives NaN.
 */
function cleanTable(v, ref, keys, report) {
  const path = keys.join(".");
  const complete = (c, template, row) => {
    for (const k of Object.keys(template)) if (!Object.hasOwn(c, k)) report.completed.push(`${path}.${row}.${k}`);
    return { ...template, ...c };
  };
  // Numbered rows ({"3": {...}}, as the typed values are exported): those rows of the default table.
  if (isPlain(v) && Object.keys(v).length && Object.keys(v).every((k) => /^\d+$/.test(k))) {
    const out = clone(ref);
    for (const [i, x] of Object.entries(v)) {
      if (!(Number(i) < ref.length)) report.unknown.push({ path: `${path}.${i}`, suggestion: null });
      else {
        const c = clean(x, ref[i], [...keys, i], report);
        if (c !== undefined) out[i] = isPlain(c) ? complete(c, ref[i], i) : c;
      }
    }
    return out;
  }
  if (!Array.isArray(v)) return void report.invalid.push({ path, reason: "tableau attendu" });
  if (isPlain(ref[0])) {
    const out = [];
    v.forEach((x, i) => {
      const template = ref[i] ?? ref.at(-1);
      const c = clean(x, template, [...keys, String(i)], report);
      if (c !== undefined) out.push(complete(c, template, out.length));
    });
    return out.length ? out : undefined;
  }
  // A list of names: the finishing methods of an island are known operations.
  const out = v.filter((x) => {
    const ok = typeof x === typeof ref[0] && (!path.endsWith(".finitions") || Object.hasOwn(DEFAULT_OPERATIONS, x));
    if (!ok) report.invalid.push({ path, reason: `« ${x} » inconnu` });
    return ok;
  });
  return out.length ? out : undefined;
}

/**
 * A trends file (calibrated settings, whole or partial) checked against the
 * settings of the code: unknown or misspelled keys and invalid values are
 * reported and left out. Returns {values (null: nothing usable), completed,
 * report: {count, unknown: [{path, suggestion}], invalid: [{path, reason}],
 * completed: [path]}}.
 */
export function validateTendances(json) {
  const report = { count: 0, unknown: [], invalid: [], completed: [] };
  const schema = { ...codeSettings(), energy: { elecAncien: 0, elecNouveau: 0, gazAncien: 0, gazNouveau: 0 } };
  const values = isPlain(json) ? clean(json, schema, [], report) ?? null : (report.invalid.push({ path: "", reason: "fichier de paramètres (objet JSON) attendu" }), null);
  report.count = countValues(values);
  return { values, completed: report.completed, report };
}

/**
 * Import of a trends file: it replaces the trends imported before, and only
 * them (the typed values stay above). Returns the report of validateTendances;
 * throws when the file has no usable value.
 */
export function importTendances(json, fileName) {
  const { values, completed, report } = validateTendances(json);
  const unknown = report.unknown.length ? ` (clés inconnues : ${report.unknown.slice(0, 8).map((u) => u.path).join(", ")})` : "";
  if (!values) throw new Error(`aucune valeur de paramètre reconnue dans ce fichier${unknown}`);
  write(KEYS.tendances, { fileName, importedAt: new Date().toISOString(), values, completed });
  return report;
}

export function defaultQuote(base, indices) {
  const d = base?.defaults ?? {};
  const lists = base?.lists ?? {};
  const year = lists.anneePri ? lists.anneePri + 1 : new Date().getFullYear();
  const typologies = indices?.typologies?.map((t) => t.name) ?? lists.typologies ?? [];
  const typologie = typologies.includes("M-1/M-3") ? "M-1/M-3" : typologies[0] ?? null;
  // The newest month and the first price index of the list that have a value.
  let month = indices?.months?.at(-1) ?? null;
  let cours = lists.cours?.[0] ?? null;
  search: for (const m of [...(indices?.months ?? [])].reverse()) {
    for (const c of lists.cours ?? []) {
      if (indexAverage(indices, c, m, typologie) !== null) {
        month = m;
        cours = c;
        break search;
      }
    }
  }
  return {
    client: "",
    reference: "",
    designation: "",
    plan: "",
    alliage: lists.alliages?.[0] ?? "AS7G03",
    poids: null, // null: from the 3D model
    toileMini: null,
    epaisseurMax: null,
    moduleMm: null,
    dimMax: null,
    volumeAnnuel: 10000,
    annees: 5,
    premiereAnnee: year,
    volumes: null, // null: the annual volume every year
    tth: "none",
    noyaux: false,
    sableKg: 0,
    tribo: false,
    redressage: false,
    month,
    typologie,
    cours,
    coursAchat: d.coursAchat ?? 0,
    p1020Achat: d.p1020Achat ?? 0,
    premiumAchat: d.premiumAchat ?? 0,
    premiumVente: d.premiumVente ?? 0,
    pafAchat: d.pafAchat ?? 0.06,
    pafVente: d.pafVente ?? 0.08,
    procede: "auto",
    finition: "auto",
    mode: null, // null: the setting of the casting centre
    cycle: null, // null: estimated
    empreintes: null,
    miseAuMille: null,
    coefDifficulte: d.coefDifficulte ?? 0,
    vaUsinage: d.vaUsinage ?? 0,
    rebutUsinage: d.rebutUsinage ?? 0,
    tailleSerie: d.tailleSerie || 1000,
    marge: null, // null: the setting
    composants: [],
    serie: null, // series order of the customer request (rfq.js)
    serieAvant: null, // {field: value} the fields of the quote before a request filled them (back with "Retirer")
    serieRetiree: null, // {fileName, fields: {field: value}, avant}: request removed, fields still holding its values
    moqs: [], // order quantities, largest first
    prixCible: null,
    serieEnergie: true, // energy prices of the request in place of the settings
    prototype: false, // prototypes: prototype volumes of the request, no target price
    outillageInclus: true, // tooling amortised in the piece price; false: sold apart
    margeOutillage: 0, // margin on the tooling sold apart
    analysesIA: [], // answers of the AI page on this quote, a record: {date, provider, model, question, answer, verified}; none applied
  };
}

// Each tab of the 3D page has its own quote: the first one is kept in this
// browser, the others live as long as the page (like their models).
const tabQuotes = new Map(); // tab id -> JSON of its quote
let quoteTab = 1;

/** The quote read and saved from now on: the one of the tab `id` of the 3D page. */
export function setQuoteTab(id) {
  quoteTab = id;
}

/** The tab of the 3D page whose quote is read and saved. */
export const currentQuoteTab = () => quoteTab;

/** `entry` added to the list `field` of the quote of the tab `id` as it is saved (not the one in a page). */
export function appendToQuote(id, field, entry) {
  const shown = quoteTab;
  quoteTab = id;
  try {
    const saved = readQuote() ?? {};
    saved[field] = [...(Array.isArray(saved[field]) ? saved[field] : []), entry];
    return saveQuote(saved);
  } finally {
    quoteTab = shown;
  }
}

function readQuote() {
  if (quoteTab === 1) return read(KEYS.quote);
  const text = tabQuotes.get(quoteTab);
  return text ? JSON.parse(text) : null;
}

export function loadQuote(base, indices) {
  return { ...defaultQuote(base, indices), ...readQuote() };
}

export const saveQuote = (quote) => (quoteTab === 1 ? write(KEYS.quote, quote) : !!tabQuotes.set(quoteTab, JSON.stringify(quote)));
export const resetQuote = () => forgetQuote(quoteTab);

/** Forget the quote of the tab `id` (closed). */
export function forgetQuote(id) {
  if (id === 1) write(KEYS.quote, null);
  else tabQuotes.delete(id);
}
