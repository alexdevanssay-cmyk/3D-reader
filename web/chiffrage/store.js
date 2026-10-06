// What the costing pages keep in this browser (localStorage): the data read
// from the costing workbook and from the metal prices file, the settings
// (TRS, islands, methods...) and the inputs of the current quote. Saved at
// every change, so they are back when the page is opened again. Nothing is
// sent anywhere.

import { DEFAULT_OPERATIONS, DEFAULT_PROCESSES, DEFAULT_TRS, DEFAULT_TTH } from "./routes.js";
import { DEFAULT_TOOLING } from "./tooling.js";
import { DEFAULT_CORES } from "./cores.js";
import { indexAverage } from "./model.js";

const KEYS = {
  base: "reader3d.chiffrage.base.v1",
  indices: "reader3d.chiffrage.indices.v1",
  settings: "reader3d.chiffrage.settings.v1",
  quote: "reader3d.chiffrage.quote.v1",
};

// Densities of the alloys (g/cm³), to get the weight of the part from its volume.
export const DEFAULT_DENSITIES = {
  AS7G03: 2.68, AS7G06: 2.68, AS7U3: 2.75, AS8U3: 2.75, AS9G: 2.65, AS9GU: 2.7, AS9U3: 2.76,
  AS10G: 2.65, AS12: 2.65, AS12U: 2.7, AS12UNG: 2.68, AS13: 2.65, AZ10: 2.85, AZ5: 2.8,
};

const clone = (x) => JSON.parse(JSON.stringify(x));

function read(key) {
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
    return true;
  } catch {
    return false; // private window, storage full or blocked: works for this visit only
  }
}

export const loadBase = () => read(KEYS.base);
export const saveBase = (base) => write(KEYS.base, base);
export const loadIndices = () => read(KEYS.indices);
export const saveIndices = (indices) => write(KEYS.indices, indices);

/** Settings with their defaults; the workbook's values where it has some. */
export function defaultSettings(base) {
  const d = base?.defaults ?? {};
  return {
    trs: { ...DEFAULT_TRS },
    modes: {},
    processes: clone(DEFAULT_PROCESSES),
    operations: clone(DEFAULT_OPERATIONS),
    densities: { ...DEFAULT_DENSITIES },
    tooling: clone(DEFAULT_TOOLING), // in-house gravity dies (tooling.js)
    tth: clone(DEFAULT_TTH), // heat treatments: cost relative to T6
    cores: clone(DEFAULT_CORES), // sand cores and core boxes (cores.js)
    inflation: {
      salaires: d.evolutionSalaires ?? 0.015,
      conso: d.evolutionConso ?? 0.02,
      elec: d.evolutionElec ?? 0,
      gaz: d.evolutionGaz ?? 0,
      autresEnergies: d.evolutionAutresEnergies ?? 0.03,
    },
    energy: null, // null: the workbook's prices
    marge: d.marge ?? 0.12,
    tauxMini: d.tauxMini ?? 0.1,
    coefSecurite: d.coefSecurite ?? 0.1,
    heuresChangementCoulee: d.changeover?.[0]?.heures ?? 8,
    heuresChangementFinition: d.changeover?.[1]?.heures ?? 1,
  };
}

/** Merge saved settings over the defaults (new settings of later versions get their default). */
export function loadSettings(base) {
  const defaults = defaultSettings(base);
  const saved = read(KEYS.settings);
  if (!saved) return defaults;
  const merged = { ...defaults, ...saved };
  for (const key of ["trs", "modes", "densities", "inflation"]) merged[key] = { ...defaults[key], ...saved[key] };
  merged.cores = { ...defaults.cores, ...saved.cores };
  for (const k of ["etude", "fao"]) merged.cores[k] = { ...defaults.cores[k], ...saved.cores?.[k] };
  merged.tth = { ...defaults.tth };
  for (const [code, value] of Object.entries(saved.tth ?? {})) merged.tth[code] = { ...defaults.tth[code], ...value };
  merged.tooling = { ...defaults.tooling, ...saved.tooling };
  for (const [k, v] of Object.entries(defaults.tooling)) {
    if (v && typeof v === "object" && !Array.isArray(v)) merged.tooling[k] = { ...v, ...saved.tooling?.[k] };
    else if (Array.isArray(v) && !Array.isArray(saved.tooling?.[k])) merged.tooling[k] = v;
  }
  for (const key of ["processes", "operations"]) {
    merged[key] = { ...defaults[key] };
    for (const [code, value] of Object.entries(saved[key] ?? {})) merged[key][code] = { ...defaults[key][code], ...value, cycle: { ...defaults[key][code]?.cycle, ...value.cycle }, rendement: { ...defaults[key][code]?.rendement, ...value.rendement } };
  }
  return merged;
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Settings `extra` (a whole or partial settings file) merged into `settings`; arrays are replaced. */
export function mergeSettings(settings, extra) {
  if (!isPlain(extra)) return settings;
  const out = { ...settings };
  for (const [k, v] of Object.entries(extra)) out[k] = isPlain(v) && isPlain(settings?.[k]) ? mergeSettings(settings[k], v) : v;
  return out;
}

export const saveSettings = (settings) => write(KEYS.settings, settings);
export const resetSettings = () => write(KEYS.settings, null);

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
    moqs: [], // order quantities, largest first
    prixCible: null,
    serieEnergie: true, // energy prices of the request in place of the settings
    prototype: false, // prototypes: prototype volumes of the request, no target price
    outillageInclus: true, // tooling amortised in the piece price; false: sold apart
    margeOutillage: 0, // margin on the tooling sold apart
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
