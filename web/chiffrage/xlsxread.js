// Minimal Excel reader (.xlsx, .xlsm): the values of the cells of chosen
// sheets, as Excel last computed them (formulas are not evaluated: the cached
// result stored in the file is read). Runs in the browser and in Node.js.

import { unzipSync, strFromU8 } from "../vendor/three/addons/libs/fflate.module.js";

const decode = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** Text of a <si> or <is> element: the concatenation of its <t> runs. */
function richText(xml) {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) out += m[1] === undefined ? "" : decode(m[1]);
  return out;
}

/** Column index (0-based) and row (1-based) of a reference such as "AB12". */
export function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`Bad cell reference ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

export function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Excel serial date (1900 system) to a JavaScript Date (UTC). */
export function excelDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
}

/**
 * Open a workbook. Returns {sheetNames, sheet(name), formulas(name)}: sheet()
 * parses one sheet (once) into a Map "A1" -> value (number, string, boolean or
 * {error}); formulas() gives the Map "A1" -> formula text of the same sheet
 * (the text of the first cell of a shared formula for all its cells).
 */
export function readWorkbook(bytes) {
  let files;
  try {
    files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx / .xlsm)");
  }
  const text = (name) => (files[name] ? strFromU8(files[name]) : null);
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx / .xlsm)");

  const rels = new Map();
  for (const m of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets = new Map();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const id = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    if (name && rels.has(id)) sheets.set(name, rels.get(id));
  }
  const shared = [];
  for (const m of (text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(richText(m[1]));

  const cache = new Map();
  const formulaCache = new Map();
  function sheet(name) {
    if (cache.has(name)) return cache.get(name);
    const path = sheets.get(name);
    const xml = path && text(path);
    if (!xml) return null;
    const cells = new Map();
    const formulas = new Map();
    const sharedFormulas = new Map();
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(m[1])?.[1];
      const body = m[2];
      if (!ref || !body) continue;
      const type = /\bt="([^"]+)"/.exec(m[1])?.[1];
      const f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
      if (f) {
        const si = /\bsi="(\d+)"/.exec(f[1])?.[1];
        let formula = f[2] === undefined ? undefined : decode(f[2]);
        if (si !== undefined) {
          if (formula) sharedFormulas.set(si, formula);
          else formula = sharedFormulas.get(si);
        }
        if (formula) formulas.set(ref, formula);
      }
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value;
      if (type === "inlineStr") value = richText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (raw === undefined) continue;
      else if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "str") value = decode(raw);
      else if (type === "b") value = raw === "1";
      else if (type === "e") value = { error: decode(raw) };
      else value = Number(raw);
      cells.set(ref, value);
    }
    cache.set(name, cells);
    formulaCache.set(name, formulas);
    return cells;
  }
  function formulas(name) {
    if (!formulaCache.has(name)) sheet(name);
    return formulaCache.get(name) ?? null;
  }
  return { sheetNames: [...sheets.keys()], sheet, formulas };
}
