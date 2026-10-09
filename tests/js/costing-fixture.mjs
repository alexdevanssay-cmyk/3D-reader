// A costing workbook with the layout of the SAB costing workbook (sheets
// PRI "Chiffrage", PRI 1x8 / 2x8 / 3x8, PRI "Réel", Liste, Suivi indice,
// Chiffrage) and made-up numbers: the real one is confidential and cannot be
// part of the repository. Also a metal prices file ("Suivi indice" only).

import { zipSync, strToU8 } from '../../web/vendor/three/addons/libs/fflate.module.js';

export const CENTRES = [
  // code, name, kind: modes (costs per working mode), direct (typed costs), reel (always the "Réel" sheet)
  ['ASF', 'Appro-Stockage-Fusion', 'modes'],
  ['ASN', 'Appro-Stockage-Noyautage', 'modes'],
  ['DEG', 'Dégotage', 'modes'],
  ['SSP', 'Sous Pression', 'modes'],
  ['FSP', 'Finition Sous Pression', 'modes'],
  ['BPR', 'Basse Pression', 'modes'],
  ['CG1', 'Coquille Gravité Chantier DFP5 New look', 'modes'],
  ['CG2', 'Coquille Gravité Chantier Gauss 2', 'modes'],
  ['CG4', 'Coquille Gravité Chantier SAB Auto', 'modes'],
  ['CG5', 'Coquille Gravité Chantier Gauss 1', 'modes'],
  ['CG3', 'Coquille Gravité Chantier Traditionelle', 'modes'],
  ['FCE', 'Finition Cellules', 'modes'],
  ['FTR', 'Finition traditionelle', 'modes'],
  ['TRI', 'Tribofinition', 'direct'],
  ['RED', 'Redressage', 'modes'],
  ['TTH', 'TTH', 'modes'],
  ['GCV', 'Grenaillage / contrôle visuel', 'modes'],
  ['EXP', 'Expédition', 'reel'],
];
export const MODE_SHEETS = { '1*8': 'PRI 1x8', '2*8': 'PRI 2x8', '3*8': 'PRI 3x8', 'Réel': 'PRI "Réel"' };
// Hours a year of a centre in each mode, and a cost scale (fewer shifts, lower costs).
export const HOURS = { '1*8': 1800, '2*8': 3600, '3*8': 5400, 'Réel': 3000 };
export const SCALE = { '1*8': 0.6, '2*8': 0.8, '3*8': 1, 'Réel': 0.9 };
export const KG_SOLD = 1_000_000;
export const CORPORATE = 300_000;
export const DEFAULT_MODES = { ASF: '3*8', SSP: '2*8', CG4: '2*8' };
export const DIRECT_TRI = [80000, 3500, 6000, 0, 48000, 9000, 0, 0, 0, 0]; // rows 5-14, row 8 = amortization
export const TRI_HOURS = 3648;
export const TRI_INVEST = { structure: 280000, duree: 7 };
export const EXP_HOURS = 1761;

const col = (i) => String.fromCharCode(66 + i); // B..S
/** Annual cost of category k (0..9, rows 3..12) of centre i in a mode. */
export function baseCost(i, k, mode) {
  return Math.round((10000 + 1000 * i) * (10 - k) * SCALE[mode]);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sheetXml(cells) {
  const rows = new Map();
  for (const [ref, cell] of Object.entries(cells)) {
    const row = Number(/\d+/.exec(ref)[0]);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push([ref, cell]);
  }
  const colIndex = (ref) => [.../^[A-Z]+/.exec(ref)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const body = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const cs = rows
        .get(r)
        .sort((a, b) => colIndex(a[0]) - colIndex(b[0]))
        .map(([ref, cell]) => {
          const { f, v } = cell !== null && typeof cell === 'object' ? cell : { v: cell };
          const formula = f ? `<f>${esc(f)}</f>` : '';
          if (typeof v === 'number') return `<c r="${ref}">${formula}<v>${v}</v></c>`;
          if (f) return `<c r="${ref}" t="str">${formula}<v>${esc(v ?? '')}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** A minimal .xlsx: {sheetName: {A1: value | {f, v}}}. */
export function writeWorkbook(sheets) {
  const names = Object.keys(sheets);
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  names.forEach((n, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheets[n]))));
  return zipSync(files);
}

// Excel serial date of the first day of a month.
const serial = (y, m) => (Date.UTC(y, m - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000;

/** "Suivi indice" sheet: 2025-01 .. 2025-12, an LME index rising by 10 € a month, P1020 premium 300 + 5 m. */
export function indicesSheet(offset = 0) {
  const s = {
    A1: 'Type', B1: 'Début', C1: 'Fin', E1: 'Mois',
    G1: 'LME primary Alloy CASH seller', H1: 'Prime Mb P1020 €', I1: 'MB Free market DIN 226',
    A2: 'M-1', B2: -1, C2: -1, A3: 'M-1/M-3', B3: -1, C3: -3, A4: 'Année N-1', B4: -1, C4: -12,
  };
  for (let m = 1; m <= 12; m++) {
    const r = m + 1;
    s[`E${r}`] = serial(2025, m);
    s[`G${r}`] = 2000 + 10 * m + offset;
    s[`H${r}`] = 300 + 5 * m;
    if (m <= 6) s[`I${r}`] = 1800 + m; // stops in June: no value for the later months
  }
  return s;
}

export function costingWorkbookSheets() {
  const pri = {
    A1: 'Fonctionnement retenu', A3: 'Code', A4: 'Centres de profits',
    AB4: 'Administratif / Corporate\nCOR',
    B55: 0, B56: 0, B57: 0.1, B60: 0, B61: 0, C58: 50, D58: 100, C59: 20, D59: 20,
  };
  for (let k = 0; k < 10; k++) pri[`AB${5 + k}`] = CORPORATE / 10;
  const scenario = Object.fromEntries(Object.values(MODE_SHEETS).map((n) => [n, {}]));
  CENTRES.forEach(([code, name, kind], i) => {
    const c = col(i);
    pri[`${c}3`] = code;
    pri[`${c}4`] = `${name}\n${code}`;
    pri[`${c}19`] = 1000 * (i + 1); // fixed part of the costs
    if (kind === 'modes') pri[`${c}1`] = DEFAULT_MODES[code] ?? 'Réel';
    for (const [mode, sheet] of Object.entries(MODE_SHEETS)) {
      const reel = mode === 'Réel';
      const s = scenario[sheet];
      for (let k = 0; k < 10; k++) s[`${c}${3 + k}`] = baseCost(i, k, mode);
      s[`${c}${reel ? 20 : 17}`] = mode;
      s[`${c}${reel ? 21 : 18}`] = 1;
      s[`${c}${reel ? 22 : 19}`] = HOURS[mode];
      s[`${c}${reel ? 28 : 25}`] = KG_SOLD;
    }
    const pick = (row) => `IF(${c}$1="1*8",'PRI 1x8'!${c}${row},IF(${c}$1="2*8",'PRI 2x8'!${c}${row},IF(${c}$1="3*8",'PRI 3x8'!${c}${row},IF(${c}$1="Réel",'PRI "Réel"'!${c}${row},"Erreur choix"))))`;
    if (kind === 'modes') {
      pri[`${c}5`] = { f: `${pick(3)}*(1+$B57)+${c}45`, v: 0 };
      pri[`${c}24`] = { f: pick(19), v: 0 };
      pri[`${c}31`] = { f: pick(25), v: 0 };
    } else if (kind === 'reel') {
      pri[`${c}5`] = { f: `'PRI "Réel"'!${c}3*(1+$B57)+${c}45`, v: 0 };
      pri[`${c}24`] = EXP_HOURS;
    } else {
      DIRECT_TRI.forEach((v, k) => (pri[`${c}${5 + k}`] = v));
      pri[`${c}8`] = { f: `${c}43`, v: TRI_INVEST.structure / TRI_INVEST.duree };
      pri[`${c}24`] = { f: '2*8*228', v: TRI_HOURS };
      pri[`${c}38`] = TRI_INVEST.structure;
      pri[`${c}41`] = TRI_INVEST.duree;
    }
    if (code === 'ASF') {
      pri[`${c}26`] = 'au kg';
      pri[`${c}33`] = { f: `1/${c}30*${c}17`, v: 0 };
    }
    if (code === 'TTH') {
      pri[`${c}26`] = 'au kg';
      pri[`${c}33`] = { f: `1/${c}31*${c}17`, v: 0 };
    }
  });
  const liste = {
    A1: 'Année PRI', A2: 2025,
    C1: 'Alliage', C2: 'AS7G03', C3: 'AS9U3',
    L1: 'Coef de technicité', M1: 'Impact perte au feu', N1: 'Impact coût globaux',
    U1: 'Liste des emballages', U2: 'Caisse bois', V2: 80,
    Y1: 'Cours de référence', Y2: 'MB Free market DIN 226', Y3: 'LME primary Alloy cash seller',
    AA1: 'Moyenne base matière', AA2: 'M-1', AA3: 'M-1/M-3',
    AC1: 'Cours avec P1020', AC2: 'LME primary Alloy cash seller',
  };
  [-2, 0, 2].forEach((coef, i) => {
    liste[`L${2 + i}`] = coef;
    liste[`M${2 + i}`] = 0.12 + 0.02 * i;
    liste[`N${2 + i}`] = -0.02 + 0.02 * i;
  });
  const chiffrage = {
    J73: 2500, J74: 300, J75: 350, L75: 600, J78: 0.06, L78: 0.08, H83: 0, D84: 10, H84: 0.02,
    G94: 0.015, G96: 0.02, G98: 0, G100: 0, G102: 0.03, G116: 0.1, G119: 1000, G120: 10000, Q117: 0.1,
    B135: 0.12, AA156: 0.1, D108: 'CG3', G108: 8, D109: 'FCE', G109: 1,
  };
  return {
    'PRI "Chiffrage"': pri,
    ...scenario,
    Chiffrage: chiffrage,
    Liste: liste,
    'Suivi indice': indicesSheet(),
  };
}

export const costingWorkbook = () => writeWorkbook(costingWorkbookSheets());
export const indicesWorkbook = (offset = 100) => writeWorkbook({ Notes: { A1: 'cours' }, 'Suivi indice': indicesSheet(offset) });

/**
 * A made-up customer request (RFQ / GO NO GO workbook): volumes 2027-2030,
 * three MOQ, target price, weights, mise au mille and machining scrap rate.
 * go, foundry: cells added to (or replacing those of) the sheets
 * "1- Données GO NO GO" and "5- Chiffrage Fonderie".
 */
export function seriesOrderWorkbook({ go: extraGo = {}, foundry: extraFoundry = {} } = {}) {
  const go = {
    H7: 'Année', H8: 'Volume série', H9: 'Volume proto',
    A69: 'Proto', B69: 'Non',
    A20: 'Nom du client *', B20: 'ACME RAIL',
    A25: 'Référence de la demande client  *', B25: 'Castings 2027',
    A26: 'Référence & Désignation pièce *', B26: 'AB-123 - SUPPORT PLATE',
    A46: 'Target Price (communiqué par le client)\n(Prix + commentaire', B46: 30,
    A47: 'MOQ 1 (par taille décroissante) ', B47: 2000,
    A48: 'MOQ 2 (par taille décroissante) ', B48: 500,
    A49: 'MOQ 3 (par taille décroissante) ', B49: 50,
    A54: 'Alliage', B54: 'AS7G06',
    A58: 'Nombre total de référence à chiffrer dans RFQ *', B58: 1,
    A60: 'Fonderie', B60: 'CG',
    A73: 'Plan 2D', B73: 'Brut', C73: 'AB-123 ind A',
    A62: 'Poids Brut vendu (en kg)', B62: 1.25,
  };
  const vols = { 2026: 0, 2027: 1000, 2028: 1500, 2029: 1500, 2030: 800, 2031: 0 };
  Object.keys(vols).forEach((y, i) => {
    const c = String.fromCharCode(73 + i); // I..N
    go[`${c}7`] = Number(y);
    go[`${c}8`] = vols[y];
    go[`${c}9`] = y === '2026' ? 20 : 0; // prototypes the year before the series
  });
  Object.assign(go, extraGo);
  return writeWorkbook({
    'Mode opératoire': { A1: 'Template Go No Go' },
    '1- Données GO NO GO': go,
    '3- Données de chiffrages': { A24: 'Electricité (/Mwh) : ', B24: 150, A25: 'Gaz (/Mwh) :', B25: 60, A45: 'N° Offre :', B45: 'GTEST-CG-2026-00' },
    // Metal of the foundry quote: AS9U3, M-1, LME cash seller, March 2026 (not in the indices of the fixture).
    '5- Chiffrage Fonderie': {
      C18: 'Alliage', D18: 'AS9U3', C19: 'Typologie de la moyenne', D19: 'M-1', C20: 'Cours utilisé', D20: 'LME primary Alloy cash seller',
      C21: 'Date de référence', D21: 46082, C22: 'Valeur de référence achat', D22: 2800, C23: 'Valeur de référence vente', D23: 2810,
      C24: 'P1020 achat', D24: 400, C25: 'P1020 vente', D25: 410, C26: 'Premium achat', D26: 330, C27: 'Premium vente', D27: 640,
      C28: 'PAF PRI', D28: 0.05, C29: 'PAF vendue', D29: 0.07,
      // Part of the foundry quote: compared with the costing, not applied.
      C30: 'Poids vendu (kg / pc)', D30: 1.1, C31: 'Mise au mille', D31: 1.6, C32: 'Taux de rebuts usinage', D32: 0.03,
      ...extraFoundry,
    },
  });
}
