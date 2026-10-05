// Minimal Excel (.xlsx) writer: one value per cell (numbers stay numbers), a
// bold header row with filters, frozen panes and column widths. No dependency
// besides fflate (zip), already vendored with three.js.

import { zipSync, strToU8 } from "three/addons/libs/fflate.module.js";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Cell styles (styles.xml cellXfs): 0 default, 1 bold header, 2 number 0.000,
// 3 number 0.00 %, 4 bold number 0.000, 5 bold text.
export const STYLE = { text: 0, header: 1, number: 2, percent: 3, totalNumber: 4, totalText: 5 };

function esc(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * A cell is a number, a string, a boolean, null (empty) or {value, style}.
 * Numbers that are not finite become empty cells.
 */
function cellXml(cell, ref, defaultStyle) {
  const { value, style } = cell !== null && typeof cell === "object" ? cell : { value: cell, style: undefined };
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return `<c r="${ref}" s="${style ?? STYLE.number}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${ref}" t="b" s="${style ?? STYLE.text}"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="${style ?? defaultStyle}"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml({ rows, widths = [], header = false }) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = rows
    .map((row, r) => {
      const style = header && r === 0 ? STYLE.header : STYLE.text;
      const cells = row.map((cell, c) => cellXml(header && r === 0 ? { value: cell, style } : cell, `${columnName(c)}${r + 1}`, style));
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    })
    .join("");
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pane = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : "";
  const filter = header && rows.length > 1 ? `<autoFilter ref="A1:${columnName(width - 1)}${rows.length}"/>` : "";
  return (
    XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    pane +
    cols +
    `<sheetData>${body}</sheetData>` +
    filter +
    "</worksheet>"
  );
}

const STYLES =
  XML +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.000"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDDE6F5"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="6">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/**
 * Build an .xlsx file.
 * @param {{name: string, rows: Array<Array<*>>, widths?: number[], header?: boolean}[]} sheets
 * @returns {Uint8Array}
 */
export function buildXlsx(sheets) {
  // Excel sheet names: at most 31 characters, none of : \ / ? * [ ]
  const names = sheets.map((s, i) => (s.name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || `Sheet${i + 1}`));
  const files = {
    "[Content_Types].xml": strToU8(
      XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join("") +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
    "xl/workbook.xml": strToU8(
      XML +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets>" +
        (sheets.some((s) => s.header && s.rows.length > 1)
          ? "<definedNames>" +
            sheets
              .map((s, i) =>
                s.header && s.rows.length > 1
                  ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i]).replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>`
                  : "",
              )
              .join("") +
            "</definedNames>"
          : "") +
        "</workbook>",
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ),
    "xl/styles.xml": strToU8(STYLES),
  };
  sheets.forEach((sheet, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet))));
  return zipSync(files, { level: 6 });
}
