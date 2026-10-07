// Exact (B-rep) reading of CAD files: STEP, IGES and BREP, with OpenCascade
// compiled to WebAssembly (opencascade.js).
//
// This is a line-by-line port of reader3d/cad.py, the reference engine: same
// quality presets, part naming and colour rules, sewing of loose surfaces and
// note strings. Volumes, areas and centres of mass come from BRepGProp, which
// integrates over the real NURBS/analytic surfaces of the solids (adaptively, see
// GPROP_EPS); they do not depend on the display tessellation.
//
// Where it is not a line-by-line port:
// - limits of WebAssembly: the model is tessellated one solid at a time (see
//   meshEach()), and running out of wasm memory is reported as an error
//   instead of silently dropping the faces that could not be tessellated;
// - the OpenCascade 7.6 of opencascade.js drops the mirror of mirrored STEP
//   instances, which OpenCascade 8 (cad.py) keeps: it is restored, see
//   mirroredOccurrences();
// - a solid whose shell is open is treated as open surfaces (no volume), and
//   a colour set on an assembly instance overrides the part's own colour,
//   like OpenCascade's own presentation of XCAF documents.
//
// Memory: every embind object lives in the wasm heap and must be released by
// hand. Objects that survive a whole analysis (shapes, labels, the XCAF
// document) are registered in a Context released at the end; short-lived
// objects are released on the spot. In this opencascade.js build, delete()
// frees nothing for the objects OpenCascade returns by value (shapes,
// locations, points...): release() runs their destructor by hand. Without it,
// every analysed model stayed in memory.

export const CAD_EXTENSIONS = {
  '.step': 'step',
  '.stp': 'step',
  '.p21': 'step',
  '.iges': 'iges',
  '.igs': 'iges',
  '.brep': 'brep',
  '.brp': 'brep',
};

// Display tessellation presets: [linear deflection as a fraction of the model
// diagonal, angular deflection in radians]. They only affect the 3D view and
// the mesh cross-check; the reported volume is exact whatever the preset.
export const QUALITY = {
  coarse: [2e-3, 0.5],
  normal: [5e-4, 0.3],
  fine: [1e-4, 0.1],
};

// Names some CAD systems give to the shape itself instead of the product.
const GENERIC_NAMES = new Set([
  'SOLID', 'COMPOUND', 'SHELL', 'BODY', 'FACE', 'OPEN SHELL', 'CLOSED SHELL',
  'MANIFOLD_SOLID_BREP', 'BREP', 'NONE', 'UNNAMED',
]);

const NOTE_SEWN = 'Solid rebuilt by sewing the surfaces of the file';
const NOTE_CLOSED = (tol) => `Body closed on request: surfaces sewn with a tolerance of ${tol} mm`;
const NOTE_FILLED = (n) => `${n} hole(s) of the surfaces filled: approximate volume`;
const NOTE_INVERTED = 'Solid had inverted orientation; volume sign corrected';
const NOTE_OPEN = 'Open surfaces (not a closed solid): no volume can be computed';

const OUT_OF_MEMORY = 'Not enough memory to analyse this model in the browser';

// Relative accuracy of BRepGProp's adaptive integration (GPROP_EPS in cad.py). The
// default (fixed Gauss order) is exact on planes and quadrics but off by up to a
// few tenths of a percent on rational NURBS surfaces; with Eps the integration is
// refined until it converges. Eps is an estimate: 1e-9 still left 2e-7 on a NURBS
// torus, 1e-10 leaves 2e-8 (for about 20 % more integration time).
const GPROP_EPS = 1e-10;
// Planes, cylinders, cones and spheres: the fixed Gauss order is already exact
// there, the adaptive integration only costs time (40 % of the measure on
// typical parts). It is kept for the other surfaces (NURBS, tori...).

// Largest wasm heap of this build (emscripten getHeapMax(): 4 GiB - 64 kiB), and
// the margin under it from which a failed allocation is put down to the heap
// being full (the heap grows up to the maximum before an allocation fails).
const HEAP_MAX = 2 ** 32 - 2 ** 16;
const HEAP_MARGIN = 2 ** 27;

let fileCounter = 0;

/**
 * Analyse a CAD file with OpenCascade.
 *
 * oc       -- the module returned by loadOcct() / loadOcctNode()
 * bytes    -- file content (Uint8Array or ArrayBuffer)
 * fileName -- original name: gives the format (extension) and the stem used
 *             to name BREP parts and sewn surface models
 * quality  -- display tessellation preset ('coarse' | 'normal' | 'fine';
 *             anything else falls back to 'normal', like read_cad)
 *
 * Returns {bodies, source_unit: 'mm'}: CAD files carry their own unit and are
 * always converted to millimetres. Throws an Error with the same messages as
 * cad.py when the file cannot be read.
 */
export function analyzeCad(oc, bytes, fileName, { quality = 'normal', onProgress = null, close = false } = {}) {
  const base = String(fileName).split(/[\\/]/).pop();
  const ext = suffix(base);
  const fmt = CAD_EXTENSIONS[ext];
  if (!fmt) throw new Error(`Unsupported file type '${ext}'`);

  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // OpenCascade's readers work on files: use the in-memory emscripten FS.
  const path = `/cad-input-${++fileCounter}${ext}`;
  const ctx = new Context(oc, onProgress);
  const stack = oc.stackSave();
  if (oc.work && onProgress) oc.work.onBeat = () => ctx.beat();
  try {
    oc.FS.writeFile(path, data);
    return { bodies: readCad(ctx, path, data, fmt, stem(base), quality, close), source_unit: 'mm' };
  } catch (err) {
    // A C++ exception that unwinds into JavaScript skips the code that pops
    // the emscripten stack: without this, every failed file would leave the
    // stack pointer lower, until the stack overwrote the module's static data.
    oc.stackRestore(stack);
    throw readableError(oc, err);
  } finally {
    if (oc.work) oc.work.onBeat = null;
    ctx.dispose();
    try {
      oc.FS.unlink(path);
    } catch {
      // never written (FS full) or already gone
    }
  }
}

function readCad(ctx, path, bytes, fmt, fileStem, quality, close = false) {
  const { oc } = ctx;
  // Progress, weighted by the times measured on a 35 MB STEP file of 2000 solids:
  // parsing the text (0 -> 15 %), converting it to shapes (15 -> 50 %), the
  // tessellation (50 -> 65 %) and the exact integrals (65 -> 100 %).
  const parts = fmt === 'brep' ? readBrep(ctx, path, fileStem, bytes) : readXcaf(ctx, path, fmt, bytes);
  if (!parts.length) throw new Error('The file does not contain any geometry');

  const shapes = parts.map((p) => p.shape);
  const [lin, ang] = Object.hasOwn(QUALITY, quality) ? QUALITY[quality] : QUALITY.normal;
  const deflection = Math.max(bboxDiagonal(ctx, compound(ctx, shapes)) * lin, 1e-6);
  meshEach(ctx, shapes, deflection, ang);

  const { TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE } = oc.TopAbs_ShapeEnum;
  const bodies = [];
  const openParts = [];
  // Measuring a solid takes a time about proportional to its number of faces.
  let totalFaces = 0;
  for (const p of parts) forEachChild(ctx, p.shape, TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE, (solid) => (totalFaces += countChildren(ctx, solid, TopAbs_FACE)));
  ctx.step('measure', 0.65, 1, { totalWeight: Math.max(1, totalFaces) });
  for (const part of parts) {
    const solids = [];
    const openShapes = [];
    for (const solid of children(ctx, part.shape, TopAbs_SOLID)) {
      // A solid bounded by an open shell (faces missing) has no meaningful
      // volume: its shells are handled like the loose surfaces of the file.
      const shells = children(ctx, solid, TopAbs_SHELL);
      if (shells.every((shell) => oc.BRep_Tool.IsClosed_1(shell))) solids.push(solid);
      else openShapes.push(...shells);
    }
    solids.forEach((solid, i) => {
      const name = solids.length === 1 ? part.name : `${part.name} [${i + 1}]`;
      ctx.item(countChildren(ctx, solid, TopAbs_FACE), () => bodies.push(solidBody(ctx, name, solid, part.color, [])));
    });
    openShapes.push(
      ...children(ctx, part.shape, TopAbs_SHELL, TopAbs_SOLID),
      ...children(ctx, part.shape, TopAbs_FACE, TopAbs_SHELL),
    );
    if (openShapes.length) openParts.push({ part, shapes: openShapes, hasSolids: solids.length > 0 });
  }

  if (openParts.length) bodies.push(...surfaceBodies(ctx, openParts, fileStem, deflection, ang, close));
  ctx.progress(1, 'measure');
  ctx.current = null;
  // Faces left without triangulation are dropped like in cad.py, unless the
  // mesher ran out of memory: the result would then be silently incomplete.
  if (ctx.untriangulatedFaces && heapExhausted(oc)) throw new Error(OUT_OF_MEMORY);
  return bodies.filter((b) => b.triangles > 0);
}

// --------------------------------------------------------------------------- readers

// Work (in units of the work meter, oc.work) of the long OpenCascade calls,
// measured on the test files and on STEP files of up to 35 MB. Parsing a STEP
// file costs 170 to 200 units per entity; converting it to shapes 300 to 1400
// (600 typical: it depends on the kind of geometry).
const WORK = {
  stepParsePerEntity: 180,
  stepTransferPerEntity: 600,
  igesParsePerByte: 0.8,
  igesTransferPerByte: 17,
  brepPerByte: 3.2,
  // Meshing a face: 7 000 units for planes, up to 750 000 for large NURBS.
  meshPerFace: 20000,
};

function countByte(bytes, value) {
  let n = 0;
  for (let i = bytes.indexOf(value); i >= 0; i = bytes.indexOf(value, i + 1)) n++;
  return n;
}

function readBrep(ctx, path, fileStem, bytes) {
  const { oc } = ctx;
  if (!brepLooksComplete(bytes)) throw new Error('Unable to read BREP file');
  const shape = ctx.keep(new oc.TopoDS_Shape());
  const builder = ctx.keep(new oc.BRep_Builder());
  ctx.step('read', 0, 0.5, { expected: WORK.brepPerByte * bytes.length, approximate: true });
  const ok = oc.BRepTools.Read_2(shape, path, builder, ctx.keep(new oc.Message_ProgressRange_1()));
  if (!ok) throw new Error('Unable to read BREP file');
  return [{ name: fileStem, shape, color: null }];
}

/**
 * Cheap completeness check of a text BREP file.
 *
 * BRepTools::Read never returns on some truncated files: it keeps waiting for
 * the "*" that closes each shape's sub-shape list (OCCT 8 under Python hangs
 * the same way). Every one of the N shapes announced by the "TShapes N" header
 * ends with such a "*", so a file with fewer is incomplete. Other formats are
 * left to OpenCascade, which rejects them.
 */
function brepLooksComplete(bytes) {
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).trimStart();
  if (!prefix.startsWith('DBRep_DrawableShape') && !prefix.startsWith('CASCADE Topology')) return true;
  const header = indexOfAscii(bytes, '\nTShapes ');
  if (header < 0) return false;
  let i = header + '\nTShapes '.length;
  let count = 0;
  for (; i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39; i++) count = count * 10 + bytes[i] - 0x30;
  let stars = 0;
  for (; i < bytes.length && stars < count; i++) if (bytes[i] === 0x2a /* '*' */) stars++;
  return stars >= count;
}

function indexOfAscii(bytes, text) {
  const codes = Array.from(text, (ch) => ch.charCodeAt(0));
  const first = codes[0];
  for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - codes.length; i = bytes.indexOf(first, i + 1)) {
    let k = 1;
    while (k < codes.length && bytes[i + k] === codes[k]) k++;
    if (k === codes.length) return i;
  }
  return -1;
}

function readXcaf(ctx, path, fmt, bytes) {
  const { oc } = ctx;
  const occurrences = fmt === 'step' ? mirroredOccurrences(bytes) : [];
  const FMT = fmt.toUpperCase();
  // The handle owns the document: deleting the handle (at dispose) frees it,
  // so the raw document object itself must never be deleted.
  const doc = new oc.TDocStd_Document(ctx.keep(new oc.TCollection_ExtendedString_2('XmlOcaf', false)));
  const hdoc = ctx.keep(new oc.Handle_TDocStd_Document_2(doc));
  // Ask OpenCascade to convert everything to millimetres whatever the file unit.
  oc.XCAFDoc_DocumentTool.SetLengthUnit_2(hdoc, 1, oc.UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter);

  const { reader, session } =
    fmt === 'step' ? stepReader(oc, occurrences.length > 0) : { reader: new oc.IGESCAFControl_Reader_1(), session: null };
  let mirrors = [];
  try {
    reader.SetNameMode(true);
    reader.SetColorMode(true);
    // Work expected from the size of the file (see WORK): exact enough for the
    // parsing, only a typical value for the conversion to shapes.
    const entities = fmt === 'step' ? countByte(bytes, 0x3b) : 0; // one ';' per STEP entity
    const expected = (kind) => (fmt === 'step' ? WORK[`step${kind}PerEntity`] * entities : WORK[`iges${kind}PerByte`] * bytes.length);
    ctx.step('read', 0, 0.15, { expected: expected('Parse'), approximate: fmt !== 'step' });
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new Error(`Unable to read ${FMT} file`);
    }
    ctx.step('transfer', 0.15, 0.5, { expected: expected('Transfer'), approximate: true });
    const progress = ctx.keep(new oc.Message_ProgressRange_1());
    const ok = fmt === 'step' ? reader.Transfer_1(hdoc, progress) : reader.Transfer(hdoc, progress);
    if (!ok) throw new Error(`Unable to transfer ${FMT} geometry`);
    if (session) mirrors = mirroredPlacements(ctx, session.get(), occurrences);
  } finally {
    reader.delete(); // releases the parsed file model, which can be large
    session?.delete(); // (the work session holds it too)
  }

  const main = ctx.keep(doc.Main());
  const shapeToolHandle = ctx.keep(oc.XCAFDoc_DocumentTool.ShapeTool(main));
  const colorToolHandle = ctx.keep(oc.XCAFDoc_DocumentTool.ColorTool(main));
  const shapeTool = shapeToolHandle.get();
  const colorTool = colorToolHandle.get();
  const ST = oc.XCAFDoc_ShapeTool;
  const nameId = ctx.keep(oc.TDataStd_Name.GetID());
  const parts = [];

  // Colour precedence of XCAF (as displayed by XCAFPrs_DocumentExplorer): the
  // colour set on the instance (component), then the label's own colour, then
  // the colour inherited from the enclosing assembly instance.
  const walk = (label, loc, inheritedName, inheritedColor, instanceColor = null) => {
    let color = instanceColor ?? labelColor(oc, colorTool, label) ?? inheritedColor;
    let ownName = labelName(oc, nameId, label);
    if (ST.IsAssembly(label)) {
      // Assembly / product labels carry the meaningful part names (PLATE, BOLT...)
      inheritedName = ownName ?? inheritedName;
      const comps = ctx.keep(new oc.TDF_LabelSequence_1());
      ST.GetComponents(label, comps, false);
      for (let i = 1; i <= comps.Length(); i++) {
        const comp = ctx.keep(comps.Value(i));
        const ref = ctx.keep(new oc.TDF_Label());
        // cad.py would raise on a dangling reference; skipping it is equivalent but readable.
        if (!ST.GetReferredShape(comp, ref) || ref.IsNull()) continue;
        let compLoc = ctx.keep(ST.GetLocation(comp));
        if (mirrors.length) compLoc = restoreMirror(ctx, compLoc, mirrors);
        walk(
          ref,
          ctx.keep(loc.Multiplied(compLoc)),
          labelName(oc, nameId, comp) ?? inheritedName,
          color,
          labelColor(oc, colorTool, comp),
        );
      }
    } else {
      const shape = ctx.keep(ST.GetShape_2(label));
      if (shape.IsNull()) return;
      if (ownName && GENERIC_NAMES.has(ownName.toUpperCase())) ownName = null;
      const name = ownName ?? inheritedName ?? `Part ${parts.length + 1}`;
      if (color == null) color = shapeColor(oc, colorTool, shape);
      parts.push({ name, shape: ctx.keep(shape.Moved(loc, false)), color });
    }
  };

  const free = ctx.keep(new oc.TDF_LabelSequence_1());
  shapeTool.GetFreeShapes(free);
  const identity = ctx.keep(new oc.TopLoc_Location_1());
  for (let i = 1; i <= free.Length(); i++) {
    walk(ctx.keep(free.Value(i)), identity, null, null);
  }
  return parts;
}

// ------------------------------------------------------------ mirrored instances

// Length units a STEP file can be written in, in millimetres.
const LENGTH_UNITS_MM = [1e-6, 2.54e-5, 1e-3, 0.0254, 1, 10, 25.4, 100, 304.8, 914.4, 1e3, 1e6, 1609344];

/**
 * Mirrored assembly occurrences of a STEP file.
 *
 * OpenCascade writes a mirrored instance as a CARTESIAN_TRANSFORMATION_OPERATOR_3D
 * with a scale of -1, which places one occurrence of a part:
 *
 *   operator <- [ITEM_DEFINED_TRANSFORMATION] <- REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION
 *            <- CONTEXT_DEPENDENT_SHAPE_REPRESENTATION -> PRODUCT_DEFINITION_SHAPE
 *            -> NEXT_ASSEMBLY_USAGE_OCCURRENCE
 *
 * cad.py (OpenCascade 8) places such an occurrence with the rigid placement
 * built from the operator's origin and axes, followed by a reflection through
 * the origin (scale -1). The OpenCascade 7.6 of opencascade.js ignores the
 * scale and keeps the rigid placement only. Returns, for each occurrence
 * reached from such an operator, its entity number (`id`), its rank among the
 * entities of the file (`rank`) and that rotation (row-major 3x3, built like
 * StepToGeom::MakeTransformation3d: axis3 and axis1, axis2 ignored) and origin
 * (file units), for mirroredPlacements(). Operators written as part of a
 * complex entity are not recognised.
 */
function mirroredOccurrences(bytes) {
  if (indexOfAscii(bytes, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D') < 0) return [];
  const text = new TextDecoder('latin1').decode(bytes);
  const operators = new Map(); // id -> {axis1, origin, axis3}, scale -1 only
  const header = /#(\d+)\s*=\s*CARTESIAN_TRANSFORMATION_OPERATOR_3D\s*\(/gi;
  for (let m; (m = header.exec(text)); ) {
    // (name, [name, description,] axis1, axis2, local_origin, scale, axis3)
    const args = stepArguments(text, header.lastIndex).slice(-5);
    if (args.length === 5 && Number(args[3]) === -1) operators.set(`#${m[1]}`, { axis1: args[0], origin: args[2], axis3: args[4] });
  }
  if (!operators.size) return [];

  // What refers to them, down to the assembly occurrences.
  const itemTransforms = new Map(); // ITEM_DEFINED_TRANSFORMATION id -> its two items
  const relTransforms = new Map(); // representation relationship id -> its transformation
  const contexts = []; // CONTEXT_DEPENDENT_SHAPE_REPRESENTATION: [relationship, product definition shape]
  const definitions = new Map(); // PRODUCT_DEFINITION_SHAPE id -> definition
  const ranks = new Map(); // NEXT_ASSEMBLY_USAGE_OCCURRENCE id -> rank
  let rank = 0;
  forEachStatement(text, (statement) => {
    const m = /^\s*#(\d+)\s*=\s*/.exec(statement);
    if (!m) return; // header or section keyword
    rank++;
    const id = `#${m[1]}`;
    const body = statement.slice(m[0].length);
    const type = /^(\w+)\s*\(/.exec(body);
    if (!type) {
      // Complex entity: ( REPRESENTATION_RELATIONSHIP(...) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#t) ... )
      const t = /REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\s*\(\s*(#\d+)\s*\)/i.exec(body);
      if (t) relTransforms.set(id, t[1]);
      return;
    }
    const args = () => stepArguments(body, type[0].length);
    switch (type[1].toUpperCase()) {
      case 'ITEM_DEFINED_TRANSFORMATION':
        itemTransforms.set(id, args().slice(2, 4));
        break;
      case 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION':
      case 'SHAPE_REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION':
        relTransforms.set(id, args()[4]);
        break;
      case 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION':
        contexts.push(args());
        break;
      case 'PRODUCT_DEFINITION_SHAPE':
        definitions.set(id, args()[2]);
        break;
      case 'NEXT_ASSEMBLY_USAGE_OCCURRENCE':
        ranks.set(id, rank);
        break;
    }
  });

  // Transformations that are, or refer to, a mirroring operator.
  const mirroring = new Map(operators);
  for (const [id, items] of itemTransforms) {
    const op = items.map((item) => operators.get(item)).find(Boolean);
    if (op) mirroring.set(id, op);
  }
  const found = [];
  for (const [relationship, shapeDefinition] of contexts) {
    const op = mirroring.get(relTransforms.get(relationship));
    const occurrence = definitions.get(shapeDefinition);
    if (op && ranks.has(occurrence)) found.push({ occurrence, op });
  }
  if (!found.length) return [];

  // Coordinates of the DIRECTION and CARTESIAN_POINT entities referenced.
  const wanted = new Set(found.flatMap(({ op }) => [op.axis1, op.origin, op.axis3]).filter((a) => a?.startsWith('#')));
  const coords = new Map();
  const entity = /(#\d+)\s*=\s*(?:DIRECTION|CARTESIAN_POINT)\s*\(\s*'(?:[^']|'')*'\s*,\s*\(([^)]*)\)\s*\)/gi;
  for (let m; (m = entity.exec(text)); ) {
    if (wanted.has(m[1])) coords.set(m[1], m[2].split(',').map(Number));
  }
  const vector = (ref, fallback) => (ref === '$' ? fallback : coords.get(ref));

  const out = [];
  for (const { occurrence, op } of found) {
    const d1 = vector(op.axis1, [1, 0, 0]);
    const d3 = vector(op.axis3, [0, 0, 1]);
    const origin = coords.get(op.origin);
    if (![d1, d3, origin].every((v) => v?.length === 3 && v.every(Number.isFinite))) continue;
    // gp_Ax3(origin, d3, d1): Z = d3, X = d1 made orthogonal to Z, Y = Z x X.
    const z = unit(d3);
    const x = z && unit(sub(d1, scale(z, dot(d1, z))));
    if (!z || !x) continue;
    const y = cross(z, x);
    out.push({
      id: Number(occurrence.slice(1)),
      rank: ranks.get(occurrence),
      rotation: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
      origin,
    });
  }
  return out;
}

/**
 * STEP reader, with a work session of our own when `withSession`: its transfer
 * process tells where each occurrence was placed (see mirroredPlacements). A
 * reader's own work session cannot be reached without copying the reader.
 */
function stepReader(oc, withSession) {
  if (withSession) {
    const session = new oc.Handle_XSControl_WorkSession_2(new oc.XSControl_WorkSession());
    const reader = new oc.STEPCAFControl_Reader_2(session, true);
    // The reader's constructor registers the STEP norm: select it, then attach the
    // session again so that it gets a model and a transfer process.
    if (session.get().SelectNorm('STEP')) {
      reader.Init(session, true);
      return { reader, session };
    }
    reader.delete();
    session.delete();
  }
  return { reader: new oc.STEPCAFControl_Reader_1(), session: null };
}

/**
 * Locations OpenCascade gave to the mirrored occurrences of mirroredOccurrences(),
 * read from the transfer process of the STEP reader's work session.
 *
 * The STEP reader moves the shape of each occurrence by a location of its own,
 * and the XCAF component made of it gets that very location: like
 * STEPCAFControl_Reader::FindInstance, the component of an occurrence is the
 * one whose location is equal (same TopLoc_Datum3D objects, not merely the same
 * values) to that of the occurrence's shape. Another component placed by the
 * same rotation and translation is thus not mistaken for the mirrored one, and
 * an occurrence whose component cannot be found is left as it was read.
 */
function mirroredPlacements(ctx, session, occurrences) {
  const { oc } = ctx;
  const modelHandle = session.Model();
  const readerHandle = session.TransferReader();
  const processHandle = readerHandle.IsNull() ? null : readerHandle.get().TransientProcess();
  const out = [];
  try {
    if (modelHandle.IsNull() || !processHandle || processHandle.IsNull()) return out;
    const model = modelHandle.get();
    const process = processHandle.get();
    for (const { id, rank, rotation, origin } of occurrences) {
      const entity = modelEntity(model, id, rank);
      if (!entity) continue;
      const binder = process.Find(entity);
      try {
        const result = binder.IsNull() ? null : binder.get(); // owned by the handle
        if (!(result instanceof oc.TransferBRep_BinderOfShape) || !result.HasResult()) continue;
        const shape = result.Result();
        if (!shape.IsNull()) out.push({ loc: ctx.keep(shape.Location_1()), rotation, origin });
        release(oc, shape);
      } finally {
        binder.delete();
        entity.delete();
      }
    }
  } finally {
    processHandle?.delete();
    readerHandle.delete();
    modelHandle.delete();
  }
  return out;
}

/**
 * Handle of the entity #id of a STEP model, or null. Entities are numbered in
 * the order of the file: the rank found in the text is tried first, then the
 * model is searched for the label.
 */
function modelEntity(model, id, rank) {
  if (rank <= model.NbEntities()) {
    const entity = model.Value(rank);
    if (!entity.IsNull() && model.IdentLabel(entity) === id) return entity;
    entity.delete();
  }
  const num = model.NextNumberForLabel(`#${id}`, 0, true);
  return num > 0 ? model.Value(num) : null;
}

/**
 * The location of an assembly component, with the reflection that OpenCascade
 * 7.6 dropped (see mirroredOccurrences) restored when the component is a
 * mirrored occurrence and its location is still the rigid part of the
 * operator: same rotation, and a translation equal to the operator's origin
 * converted from a length unit to millimetres. A location that already holds
 * the reflection (an OpenCascade that keeps it) is left alone.
 */
function restoreMirror(ctx, loc, mirrors) {
  const { oc } = ctx;
  const mirror = mirrors.find((m) => m.loc.IsEqual(loc));
  if (!mirror) return loc;
  const m = affine(oc, loc);
  const t = [m[3], m[7], m[11]];
  const tol = 1e-9;
  const isPlacement = ({ rotation, origin }) => {
    if (rotation.some((v, i) => Math.abs(v - m[i + Math.floor(i / 3)]) > tol)) return false;
    const oo = dot(origin, origin);
    if (!oo) return Math.hypot(...t) <= tol;
    const k = dot(t, origin) / oo; // file unit -> mm
    if (!LENGTH_UNITS_MM.some((f) => Math.abs(k - f) <= tol * f)) return false;
    return t.every((v, i) => Math.abs(v - k * origin[i]) <= tol * Math.max(1, Math.abs(v)));
  };
  if (!isPlacement(mirror)) return loc;

  const reflection = new oc.gp_Trsf_1();
  const centre = new oc.gp_Pnt_1();
  reflection.SetScale(centre, -1);
  const mirrored = ctx.keep(new oc.TopLoc_Location_2(reflection));
  centre.delete();
  reflection.delete();
  return ctx.keep(mirrored.Multiplied(loc));
}

/**
 * Call fn on each statement of a STEP file: the text up to each ';' that is
 * not inside a quoted string. Linear in the size of the text, even when the
 * file is malformed.
 */
function forEachStatement(text, fn) {
  let start = 0;
  let semicolon = text.indexOf(';');
  let quote = text.indexOf("'");
  while (semicolon >= 0) {
    if (quote >= 0 && quote < semicolon) {
      // A string: skip to its closing quote (a doubled quote closes it and opens another).
      const close = text.indexOf("'", quote + 1);
      if (close < 0) return; // unterminated
      quote = text.indexOf("'", close + 1);
      if (semicolon < close) semicolon = text.indexOf(';', close + 1);
      continue;
    }
    fn(text.slice(start, semicolon));
    start = semicolon + 1;
    semicolon = text.indexOf(';', start);
  }
}

/**
 * Top-level arguments of a STEP entity, starting after its opening
 * parenthesis: strings, references, numbers and nested lists as raw text.
 */
function stepArguments(text, start) {
  const args = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'") quoted = false; // a doubled quote reopens the string just after
    } else if (ch === "'") {
      quoted = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' || (ch === ',' && depth === 0)) {
      if (ch === ')' && depth-- > 0) {
        current += ch;
        continue;
      }
      args.push(current.trim());
      current = '';
      if (ch === ')') return args;
      continue;
    } else if (ch === ';') {
      break; // malformed
    }
    current += ch;
  }
  return [];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const n = Math.hypot(...a);
  return n > 1e-12 ? scale(a, 1 / n) : null;
};

// --------------------------------------------------------------- names and colours

function labelName(oc, nameId, label) {
  const handle = new oc.Handle_TDF_Attribute_1();
  try {
    if (!label.FindAttribute_1(nameId, handle)) return null;
    const ext = handle.get().Get(); // TDataStd_Name -> TCollection_ExtendedString (a copy)
    const ascii = new oc.TCollection_AsciiString_13(ext, 0); // 0: convert to UTF-8
    const name = utf8FromBinaryString(ascii.ToCString()).trim();
    ascii.delete();
    release(oc, ext);
    // OpenCascade names unnamed instances like "=>[0:1:1:3]"; ignore those.
    return name && !name.startsWith('=>') ? name : null;
  } finally {
    handle.delete();
  }
}

/** Colour attached to a label (surface colour first, then generic colour). */
function labelColor(oc, colorTool, label) {
  const { XCAFDoc_ColorSurf, XCAFDoc_ColorGen } = oc.XCAFDoc_ColorType;
  for (const type of [XCAFDoc_ColorSurf, XCAFDoc_ColorGen]) {
    const col = new oc.Quantity_Color_1();
    try {
      if (colorTool.GetColor_4(label, type, col)) return rgb(col);
    } finally {
      col.delete();
    }
  }
  return null;
}

/** Colour attached to the shape itself (looked up through the shape tool). */
function shapeColor(oc, colorTool, shape) {
  const { XCAFDoc_ColorSurf, XCAFDoc_ColorGen } = oc.XCAFDoc_ColorType;
  for (const type of [XCAFDoc_ColorSurf, XCAFDoc_ColorGen]) {
    const col = new oc.Quantity_Color_1();
    try {
      if (colorTool.GetColor_7(shape, type, col)) return rgb(col);
    } finally {
      col.delete();
    }
  }
  return null;
}

/**
 * sRGB components (0..1) of a colour. Quantity_Color stores linear RGB and its
 * Red()/Green()/Blue() accessors return linear values; cad.py asks for
 * Values(Quantity_TOC_sRGB), which applies OpenCascade's sRGB transfer function.
 */
function rgb(col) {
  return [linearToSrgb(col.Red()), linearToSrgb(col.Green()), linearToSrgb(col.Blue())];
}

/** Same formula as Quantity_Color::Convert_LinearRGB_To_sRGB (double version). */
function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : Math.pow(v, 1.0 / 2.4) * 1.055 - 0.055;
}

// --------------------------------------------------------------------------- bodies

/**
 * Bodies for the geometry that is not inside a solid.
 *
 * Surface models are often exported with every face as its own "part", so the
 * loose surfaces of the whole file are sewn together; the closed shells that
 * result become solids whose volume can be computed.
 */
function surfaceBodies(ctx, openParts, fileStem, deflection, ang, close = false) {
  const allOpen = openParts.flatMap((p) => p.shapes);
  const { solids, remaining, notes = [NOTE_SEWN] } = close ? closeSurfaces(ctx, allOpen, deflection, ang) : sewToSolids(ctx, allOpen, deflection, ang);
  if (!solids.length) {
    return openParts.map(({ part, shapes, hasSolids }) =>
      openBody(ctx, hasSolids ? `${part.name} (surfaces)` : part.name, compound(ctx, shapes), part.color),
    );
  }

  const single = openParts.length === 1;
  const base = single ? openParts[0].part.name : fileStem;
  const color = single ? openParts[0].part.color : null;
  const bodies = solids.map((solid, i) =>
    solidBody(ctx, solids.length === 1 ? base : `${base} [${i + 1}]`, solid, color, [...notes]),
  );
  if (remaining.length) bodies.push(openBody(ctx, `${base} (surfaces)`, compound(ctx, remaining), color));
  return bodies;
}

function solidBody(ctx, name, solid, color, notes) {
  const { oc } = ctx;
  // Face by face, so that the progress moves inside a large solid. This is
  // the loop of BRepGProp::VolumeProperties: one integral per face between the
  // face and a reference point common to all the faces (the mean of the
  // vertices of the solid), accumulated with GProp_GProps::Add.
  const { TopAbs_FACE, TopAbs_VERTEX, TopAbs_SHAPE } = oc.TopAbs_ShapeEnum;
  const { TopAbs_FORWARD, TopAbs_REVERSED } = oc.TopAbs_Orientation;
  const sum = [0, 0, 0];
  let vertices = 0;
  forEachChild(ctx, solid, TopAbs_VERTEX, TopAbs_SHAPE, (vertex) => {
    const v = oc.TopoDS.Vertex_1(vertex);
    const p = oc.BRep_Tool.Pnt(v);
    sum[0] += p.X();
    sum[1] += p.Y();
    sum[2] += p.Z();
    release(oc, p);
    release(oc, v);
    vertices++;
  });
  const apex = new oc.gp_Pnt_3(...sum.map((x) => (vertices ? x / vertices : 0)));
  const props = new oc.GProp_GProps_1();
  let volume = 0;
  let centroid = null;
  let surfaceArea = 0;
  const surfaceTypes = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0, bezier: 0, other: 0 };\n  const geometricSurfaces = [];
  try {
    const faces = Math.max(1, countChildren(ctx, solid, TopAbs_FACE));
    let done = 0;
    forEachChild(ctx, solid, TopAbs_FACE, TopAbs_SHAPE, (shape) => {
      const face = oc.TopoDS.Face_1(shape);
      try {
        const orientation = face.Orientation_1();
        if (orientation === TopAbs_FORWARD || orientation === TopAbs_REVERSED) {
          const bf = new oc.BRepGProp_Face_2(face, false);
          const wires = new oc.TopoDS_Iterator_2(face, true, true);
          const naturalRestriction = !wires.More();
          wires.delete();
          const domain = naturalRestriction ? null : new oc.BRepGProp_Domain_2(face);
          const vinert = new oc.BRepGProp_Vinert_1();
          try {
            vinert.SetLocation(apex);
            const exact = analyticFace(oc, face);
            if (domain) exact ? vinert.Perform_7(bf, domain) : vinert.Perform_8(bf, domain, GPROP_EPS);
            else exact ? vinert.Perform_1(bf) : vinert.Perform_2(bf, GPROP_EPS);
            props.Add(vinert, 1);
          } finally {
            vinert.delete();
            domain?.delete();
            bf.delete();
          }
        }
        surfaceArea += area(ctx, face);\n        countSurfaceType(oc, face, surfaceTypes);\n        describeGeometricSurface(oc, face, geometricSurfaces, geometricSurfaces.length);
      } finally {
        release(oc, face);
      }
      ctx.itemProgress(++done / faces);
    });
    volume = props.Mass();
    centroid = pointXYZ(oc, props.CentreOfMass());
  } finally {
    props.delete();
    release(oc, apex);
  }
  if (volume < 0) {
    notes.push(NOTE_INVERTED);
    volume = -volume;
  }

  const tri = triangulate(ctx, solid);
  return makeBody({
    name,
    volume,
    mesh_volume: tri.triangles ? Math.abs(tri.signedVolume) : null,
    area: surfaceArea,
    bbox: bbox(ctx, solid),
    centroid,
    closed: true,
    color,
    notes,\n    surface_types: surfaceTypes,\n    geometric_surfaces: geometricSurfaces,\n    tri,\n  });\n}\n\n/** Compact analytic descriptors used by the semantic layer. */\nfunction describeGeometricSurface(oc, face, out, index) {\n  const surface = new oc.BRepAdaptor_Surface_2(face, true);\n  try {\n    const T = oc.GeomAbs_SurfaceType;\n    const type = surface.GetType();\n    const name = type === T.GeomAbs_Plane ? "plane" : type === T.GeomAbs_Cylinder ? "cylinder" : type === T.GeomAbs_Cone ? "cone" : type === T.GeomAbs_Sphere ? "sphere" : type === T.GeomAbs_Torus ? "torus" : type === T.GeomAbs_BSplineSurface ? "bspline" : type === T.GeomAbs_BezierSurface ? "bezier" : null;\n    if (!name) return;\n    const item = { index, type: name, orientation: face.Orientation_1() };\n    if (name === "cylinder") {\n      const c = surface.Cylinder();\n      const a = c.Axis();\n      const d = a.Direction();\n      item.radius_mm = c.Radius();\n      item.axis = [d.X(), d.Y(), d.Z()];\n      item.center_mm = [a.Location().X(), a.Location().Y(), a.Location().Z()];\n    }\n    if (name === "cone") item.semi_angle_rad = surface.Cone().SemiAngle();\n    if (name === "sphere") item.radius_mm = surface.Sphere().Radius();\n    if (name === "torus") { const t = surface.Torus(); item.major_radius_mm = t.MajorRadius(); item.minor_radius_mm = t.MinorRadius(); }\n    out.push(item);\n  } finally {\n    surface.delete();\n  }\n}\n\n/** Count OpenCascade surface classes for the semantic layer. */\nfunction countSurfaceType(oc, face, counts) {\n  const surface = new oc.BRepAdaptor_Surface_2(face, true);\n  try {\n    const T = oc.GeomAbs_SurfaceType;\n    switch (surface.GetType()) {\n      case T.GeomAbs_Plane: counts.plane++; break;\n      case T.GeomAbs_Cylinder: counts.cylinder++; break;\n      case T.GeomAbs_Cone: counts.cone++; break;\n      case T.GeomAbs_Sphere: counts.sphere++; break;\n      case T.GeomAbs_Torus: counts.torus++; break;\n      case T.GeomAbs_BSplineSurface: counts.bspline++; break;\n      case T.GeomAbs_BezierSurface: counts.bezier++; break;\n      default: counts.other++;\n    }\n  } finally {\n    surface.delete();\n  }\n}\n\n/** A plane, cylinder, cone or sphere (see GPROP_EPS). */
function analyticFace(oc, face) {
  const { GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere } = oc.GeomAbs_SurfaceType;
  const surface = new oc.BRepAdaptor_Surface_2(face, true);
  try {
    const type = surface.GetType();
    return type === GeomAbs_Plane || type === GeomAbs_Cylinder || type === GeomAbs_Cone || type === GeomAbs_Sphere;
  } finally {
    surface.delete();
  }
}

function openBody(ctx, name, shape, color) {
  return makeBody({
    name,
    volume: null,
    mesh_volume: null,
    area: area(ctx, shape),
    bbox: bbox(ctx, shape),
    centroid: null,
    closed: false,
    color,
    notes: [NOTE_OPEN],
    tri: triangulate(ctx, shape),
  });
}

/** Body object of the result contract (same fields as Body.to_dict in model.py). */
function makeBody({ name, volume, mesh_volume, area: surface, bbox: [min, max], centroid, closed, color, notes, tri }) {
  const mesh = { positions: new Float32Array(tri.verts), indices: tri.indices };
  // The display copy is float32. When that rounded the vertices, the double-precision
  // ones are kept for the oriented envelope (summary.js), which the Python engine
  // measures on its double-precision vertices (float32 made a thin plate's envelope
  // 2e-5 too large; far from the origin it does not even resolve the body), like
  // meshanalysis.js does for mesh files.
  if (!sameValues(tri.verts, mesh.positions)) mesh.positions64 = tri.verts;
  return {
    name,
    volume,
    mesh_volume,
    area: surface,
    bbox: { min, max, size: max.map((v, i) => v - min[i]) },
    centroid,
    closed,
    method: 'brep',
    color: color ? [...color] : null,
    triangles: tri.triangles,
    notes,
    mesh,
  };
}

/** True when the float32 copy holds exactly the double-precision coordinates (NaN aside). */
function sameValues(verts, copy) {
  for (let i = 0; i < verts.length; i++) if (verts[i] !== copy[i] && verts[i] === verts[i]) return false;
  return true;
}

function sewToSolids(ctx, shapes, deflection, ang) {
  const { oc } = ctx;
  const { TopAbs_SHELL, TopAbs_FACE } = oc.TopAbs_ShapeEnum;
  // Same options as BRepBuilderAPI_Sewing(1e-3) in Python: sewing, analysis,
  // cutting on, non-manifold mode off.
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
  let sewn;
  try {
    for (const s of shapes) sewing.Add(s);
    sewing.Perform(ctx.keep(new oc.Message_ProgressRange_1()));
    sewn = ctx.keep(sewing.SewedShape());
  } finally {
    sewing.delete();
  }

  // A closed surface made of a single face (sphere, torus...) is left by sewing as a
  // free face: wrap it in a shell of its own, which may be closed like the others.
  const shells = [
    ...children(ctx, sewn, TopAbs_SHELL),
    ...children(ctx, sewn, TopAbs_FACE, TopAbs_SHELL).map((face) => shellOf(ctx, face)),
  ];
  const solids = [];
  const remaining = [];
  for (const shell of shells) {
    if (oc.BRep_Tool.IsClosed_1(shell)) {
      const maker = new oc.BRepBuilderAPI_MakeSolid_3(ctx.keep(oc.TopoDS.Shell_1(shell)));
      try {
        if (maker.IsDone()) {
          solids.push(ctx.keep(maker.Solid()));
          continue;
        }
      } finally {
        maker.delete();
      }
    }
    remaining.push(shell);
  }
  if (solids.length) {
    // Sewing creates new faces without triangulation: mesh them like the originals.
    meshEach(ctx, [...solids, ...remaining], deflection, ang, false);
  }
  return { solids, remaining };
}

/**
 * Close open surfaces on request ("Fermer le corps"): sewing with larger and
 * larger tolerances (the gaps a CAD export leaves between faces); then the
 * holes still bounded by free edges are filled (see fillHoles) and sewn again.
 * Returns {solids, remaining, notes} like sewToSolids.
 */
function closeSurfaces(ctx, shapes, deflection, ang) {
  const { oc } = ctx;
  const { TopAbs_SHELL, TopAbs_FACE, TopAbs_WIRE, TopAbs_EDGE } = oc.TopAbs_ShapeEnum;
  const sew = (items, tol) => {
    const sewing = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
    try {
      for (const s of items) sewing.Add(s);
      sewing.Perform(ctx.keep(new oc.Message_ProgressRange_1()));
      return ctx.keep(sewing.SewedShape());
    } finally {
      sewing.delete();
    }
  };
  const shellsOf = (sewn) => [
    ...children(ctx, sewn, TopAbs_SHELL),
    ...children(ctx, sewn, TopAbs_FACE, TopAbs_SHELL).map((face) => shellOf(ctx, face)),
  ];
  const allClosed = (shells) => shells.length > 0 && shells.every((s) => oc.BRep_Tool.IsClosed_1(s));

  const TOLERANCES = [1e-3, 1e-2, 0.1];
  let sewn = null;
  let tol = TOLERANCES[0];
  let shells = [];
  for (tol of TOLERANCES) {
    sewn = sew(shapes, tol);
    shells = shellsOf(sewn);
    if (allClosed(shells)) break;
  }
  let filled = 0;
  if (!allClosed(shells)) {
    const holes = fillHoles(ctx, sewn, tol);
    filled = holes.filled;
    if (holes.faces.length) {
      sewn = sew([sewn, ...holes.faces], tol);
      shells = shellsOf(sewn);
    }
  }

  const solids = [];
  const remaining = [];
  for (const shell of shells) {
    if (oc.BRep_Tool.IsClosed_1(shell)) {
      const maker = new oc.BRepBuilderAPI_MakeSolid_3(ctx.keep(oc.TopoDS.Shell_1(shell)));
      try {
        if (maker.IsDone()) {
          // Faces of a closed shell may face inwards: oriented outwards.
          const fix = new oc.ShapeFix_Solid_1();
          try {
            fix.Init(ctx.keep(maker.Solid()));
            fix.Perform(ctx.keep(new oc.Message_ProgressRange_1()));
            solids.push(ctx.keep(fix.Solid()));
          } finally {
            fix.delete();
          }
          continue;
        }
      } finally {
        maker.delete();
      }
    }
    remaining.push(shell);
  }
  meshEach(ctx, [...solids, ...remaining], deflection, ang, false);
  const notes = [NOTE_CLOSED(tol)];
  if (filled) notes.push(NOTE_FILLED(filled));
  return { solids, remaining, notes };
}

/**
 * Faces that fill the holes of sewn surfaces, the closed contours of their free
 * edges. {faces, filled: number of holes filled}.
 * - Two contours one inside the other, parallel (the end face and the chamfer
 *   of a boss, left out of the export): on the same plane, one ring face;
 *   else a ruled surface between them. Filled one by one, they would give two
 *   overlapping caps and a wrong volume.
 * - A flat contour (within 1 % of its size): a plane face.
 * - Else a filling surface through the contour, unless it bulges out (larger
 *   than the disc of the same perimeter): then a fan of ruled faces from each
 *   edge to the centre of the contour.
 */
function fillHoles(ctx, sewn, tol) {
  const { oc } = ctx;
  const { TopAbs_WIRE, TopAbs_EDGE } = oc.TopAbs_ShapeEnum;
  const bounds = new oc.ShapeAnalysis_FreeBounds_2(sewn, tol, false, false);
  let wires;
  try {
    wires = children(ctx, bounds.GetClosedWires(), TopAbs_WIRE).map((w) => ctx.keep(oc.TopoDS.Wire_1(w)));
  } finally {
    bounds.delete();
  }
  const faceOn = (surface, wire) => {
    const maker = new oc.BRepBuilderAPI_MakeFace_21(surface, wire, true);
    try {
      return maker.IsDone() ? ctx.keep(maker.Face()) : null;
    } finally {
      maker.delete();
    }
  };
  const planeOf = (face) => {
    const adaptor = new oc.BRepAdaptor_Surface_2(face, true);
    try {
      return ctx.keep(adaptor.Plane());
    } finally {
      adaptor.delete();
    }
  };
  /** The plane through a wire, its points within `within` of it: {face, plane} or null. */
  const flat = (wire, within) => {
    const finder = new oc.BRepLib_FindSurface_2(wire, within, true, false);
    try {
      const face = finder.Found() ? faceOn(ctx.keep(finder.Surface()), wire) : null;
      return face ? { face, plane: planeOf(face) } : null;
    } finally {
      finder.delete();
    }
  };
  const holes = wires.map((wire) => {
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.LinearProperties(wire, props, false, false);
    const length = props.Mass();
    const centre = ctx.keep(props.CentreOfMass());
    props.delete();
    const size = bboxDiagonal(ctx, wire);
    const within = Math.max(tol, 0.01 * size);
    const exact = flat(wire, within);
    // The mean plane of a contour that is not flat, for its direction only.
    const mean = exact ?? flat(wire, 0.5 * size);
    return { wire, length, centre, size, within, face: exact?.face ?? null, plane: exact?.plane ?? null, normal: mean?.plane ?? null };
  });

  const faces = [];
  let filled = 0;
  const add = (shape) => {
    faces.push(shape);
    return true;
  };
  const xyz = (p) => [p.X(), p.Y(), p.Z()];
  const pair = (a, b) => {
    // b nested in a: parallel, its centre near a's axis and not far along it.
    const n = a.normal.Axis().Direction();
    if (Math.abs(n.Dot(b.normal.Axis().Direction())) < 0.95) return null;
    const [ax, ay, az] = xyz(a.centre), [bx, by, bz] = xyz(b.centre);
    const d = [bx - ax, by - ay, bz - az];
    const along = d[0] * n.X() + d[1] * n.Y() + d[2] * n.Z();
    const lateral = Math.sqrt(Math.max(0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along ** 2));
    if (Math.abs(along) > 0.5 * a.size || lateral > 0.15 * a.size) return null;
    return Math.hypot(...d);
  };
  const ring = (a, b) => {
    if (!a.plane || !b.plane || a.plane.Distance_1(b.centre) > a.within) return false;
    const target = area(ctx, a.face) - area(ctx, b.face);
    // The inner contour as a hole: the orientation that removes its area.
    for (const inner of [b.wire, ctx.keep(oc.TopoDS.Wire_1(b.wire.Reversed()))]) {
      const maker = new oc.BRepBuilderAPI_MakeFace_22(a.face, inner);
      const fix = new oc.ShapeFix_Face_2(ctx.keep(maker.Face()));
      maker.delete();
      try {
        fix.Perform();
        const face = ctx.keep(fix.Face());
        if (Math.abs(area(ctx, face) - target) < 0.05 * Math.abs(target) + tol) return add(face);
      } finally {
        fix.delete();
      }
    }
    return false;
  };
  const ruled = (sections, apex = null) => {
    const loft = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    try {
      for (const w of sections) loft.AddWire(w);
      if (apex) loft.AddVertex(apex);
      loft.Build(ctx.keep(new oc.Message_ProgressRange_1()));
      return loft.IsDone() ? ctx.keep(loft.Shape()) : null;
    } catch {
      return null;
    } finally {
      loft.delete();
    }
  };
  const single = (h) => {
    if (h.face) return add(h.face);
    let face = null;
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
    try {
      for (const e of children(ctx, h.wire, TopAbs_EDGE)) fill.Add_1(ctx.keep(oc.TopoDS.Edge_1(e)), oc.GeomAbs_Shape.GeomAbs_C0, true);
      fill.Build(ctx.keep(new oc.Message_ProgressRange_1()));
      if (fill.IsDone()) face = ctx.keep(fill.Shape());
    } catch {
      // not filled: the fan below
    } finally {
      fill.delete();
    }
    const disc = (h.length * h.length) / (4 * Math.PI);
    const a = face ? area(ctx, face) : 0;
    if (face && a > 0 && a < 1.5 * disc) return add(face);
    // A fan of ruled faces, edge by edge, to the centre of the contour.
    const apex = new oc.BRepBuilderAPI_MakeVertex(h.centre);
    const vertex = ctx.keep(apex.Vertex());
    apex.delete();
    const fan = [];
    for (const e of children(ctx, h.wire, TopAbs_EDGE)) {
      const maker = new oc.BRepBuilderAPI_MakeWire_2(ctx.keep(oc.TopoDS.Edge_1(e)));
      const piece = maker.IsDone() ? ruled([ctx.keep(maker.Wire())], vertex) : null;
      maker.delete();
      if (!piece) return false;
      fan.push(piece);
    }
    fan.forEach(add);
    return true;
  };

  holes.sort((x, y) => y.length - x.length);
  const done = new Set();
  holes.forEach((a, i) => {
    if (done.has(i)) return;
    done.add(i);
    let best = -1;
    let bestDistance = Infinity;
    if (a.normal) {
      holes.forEach((b, j) => {
        if (done.has(j) || !b.normal || b.size < 0.4 * a.size) return;
        const d = pair(a, b);
        if (d != null && d < bestDistance) [best, bestDistance] = [j, d];
      });
    }
    if (best >= 0) {
      const b = holes[best];
      done.add(best);
      if (ring(a, b)) return void filled++;
      const shape = ruled([a.wire, b.wire]);
      if (shape) return void (add(shape), filled++);
      filled += single(a) + single(b);
      return;
    }
    filled += single(a);
  });
  return { faces, filled };
}

// --------------------------------------------------------------------------- helpers

/** State of one analysis: embind objects to release at the end, caches, counters. */
class Context {
  constructor(oc, onProgress = null) {
    this.oc = oc;
    this.onProgress = onProgress;
    this.lastProgress = -1;
    this.current = null; // step in progress, see step()
    this.objects = [];
    this.matrices = new Map(); // TopLoc_Location hash -> [{loc, matrix}]
    this.meshed = new Set(); // TShape addresses of the shapes already tessellated
    this.identity = null;
    this.untriangulatedFaces = 0;
  }

  /** Report the fraction (0..1) of the analysis done, at most once per percent. */
  progress(fraction, step, approximate = false, beat = false) {
    if (!this.onProgress) return;
    const percent = Math.min(100, Math.floor(fraction * 100));
    if (percent === this.lastProgress && fraction < 1 && !beat) return;
    this.lastProgress = percent;
    this.onProgress({ percent, step, approximate, beat });
  }

  /**
   * Start a step covering [from, to] of the analysis. Inside it, progress is
   * measured with the work meter of the module (oc.work, see occt.js) and
   * reported while OpenCascade runs:
   * - `expected` work units: fraction = units done / expected. With
   *   `approximate`, the expected total is only a typical value: the fraction
   *   then slows down past 80 % so as never to reach the end of the step.
   * - or items (solids...) of known weights, see item(): fraction = weight of
   *   the items done, plus the part of the current item: as reported by the
   *   item itself (itemProgress), else estimated from the work per weight
   *   unit measured on the previous items, or `unitsPerWeight` for the first.
   */
  step(step, from, to, { expected = 0, approximate = false, totalWeight = 0, unitsPerWeight = 0 } = {}) {
    this.current = { step, from, to, expected, approximate, totalWeight, unitsPerWeight, base: this.workCount(), doneWeight: 0, item: null, units: 0, weight: 0 };
    this.progress(from, step, approximate && expected > 0);
  }

  /** Inside an item, the fraction (0..1) of it done, when the item can tell. */
  itemProgress(fraction) {
    const cur = this.current;
    if (!cur?.item) return;
    cur.item.fraction = fraction;
    this.progress(this.stepFraction(), cur.step);
  }

  /** Inside a step with items: run fn, the work of an item of this weight. */
  item(weight, fn) {
    const cur = this.current;
    cur.item = { weight, base: this.workCount(), fraction: null };
    try {
      return fn();
    } finally {
      cur.units += this.workCount() - cur.item.base;
      cur.weight += weight;
      cur.doneWeight += weight;
      cur.item = null;
      this.progress(this.stepFraction(), cur.step);
    }
  }

  workCount() {
    return this.oc.work?.count ?? 0;
  }

  /** Fraction of the whole analysis done, from the current step's measures. */
  stepFraction() {
    const cur = this.current;
    if (!cur) return 0;
    let f = 0;
    if (cur.totalWeight > 0) {
      let done = cur.doneWeight;
      if (cur.item?.fraction != null) {
        done += cur.item.weight * cur.item.fraction;
      } else if (cur.item) {
        // Work per weight unit measured on the items done, or a typical value.
        const rate = cur.weight > 0 && cur.units > 0 ? cur.units / cur.weight : cur.unitsPerWeight;
        if (rate > 0) done += cur.item.weight * Math.min(0.95, soften((this.workCount() - cur.item.base) / (rate * cur.item.weight)));
      }
      f = Math.min(1, done / cur.totalWeight);
    } else if (cur.expected > 0) {
      const ratio = (this.workCount() - cur.base) / cur.expected;
      f = cur.approximate ? soften(ratio) : Math.min(0.99, ratio);
    }
    return cur.from + (cur.to - cur.from) * f;
  }

  /** Called by the work meter while OpenCascade runs (at most every 200 ms). */
  beat() {
    const cur = this.current;
    if (cur) this.progress(this.stepFraction(), cur.step, cur.approximate && cur.expected > 0, true);
  }

  /** Register an embind object to release once the analysis is over. */
  keep(obj) {
    this.objects.push(obj);
    return obj;
  }

  /**
   * 3x4 matrix of a location. The faces of a solid, and of every solid of an
   * assembly instance, share their location: the matrix is computed once per
   * distinct location (equal chain of elementary transformations).
   */
  matrixOf(loc) {
    const key = loc.HashCode(0x7fffffff);
    let entries = this.matrices.get(key);
    if (!entries) this.matrices.set(key, (entries = []));
    for (const entry of entries) if (entry.loc.IsEqual(loc)) return entry.matrix;
    const matrix = affine(this.oc, loc);
    this.identity ??= this.keep(new this.oc.TopLoc_Location_1());
    // Multiplying by the identity returns a copy of `loc`, which the caller may delete.
    entries.push({ loc: this.keep(loc.Multiplied(this.identity)), matrix });
    return matrix;
  }

  dispose() {
    for (let i = this.objects.length - 1; i >= 0; i--) release(this.oc, this.objects[i]);
    this.objects = [];
    this.matrices.clear();
  }
}

/**
 * Fraction of a step done when `ratio` of its typical work is done: equal up
 * to 0.8, then slowing down towards 0.99 (same slope at 0.8) for the files
 * that need more work than the typical value.
 */
function soften(ratio) {
  if (ratio <= 0.8) return Math.max(0, ratio);
  return 0.8 + 0.19 * (1 - Math.exp(-(ratio - 0.8) / 0.19));
}

// Classes without resources of their own: releasing the block is their whole destructor.
const PLAIN_DATA = new Set(['gp_Pnt', 'gp_Trsf', 'Poly_Triangle', 'TDF_Label', 'Standard_GUID', 'BRep_Builder']);

/**
 * Delete an embind object, running its destructor by hand when delete() would not.
 *
 * In this opencascade.js build the classes used for objects returned by value
 * (and for some constructors, such as TopoDS_Shape's) are registered with a
 * destructor that does nothing: delete() frees neither the object nor what it
 * references. A shape would keep the whole model, triangulation included, in
 * the wasm heap. For the classes this module handles, the destructor is done
 * here: shapes and locations drop their references (Nullify, Clear), then the
 * block, a copy owned by the JavaScript handle, is returned to malloc. Objects
 * of any other class are only deleted. Never call this on an object owned by
 * OpenCascade (such as the result of a Handle's get()).
 */
function release(oc, obj) {
  const ptr = obj?.$$?.ptr;
  if (!ptr) return; // already deleted
  try {
    const isShape = obj instanceof oc.TopoDS_Shape;
    if (isShape) obj.Nullify(); // drop the reference on the shared geometry
    let free = obj.$$.ptrType.registeredClass.rawDestructor === noopDestructor(oc);
    if (free && !isShape) {
      if (obj instanceof oc.TopLoc_Location || obj instanceof oc.TCollection_ExtendedString) obj.Clear();
      else free = PLAIN_DATA.has(obj.$$.ptrType.registeredClass.name);
    }
    obj.delete();
    if (free) oc._free(ptr);
  } catch {
    // deleted meanwhile
  }
}

const noopDestructors = new WeakMap(); // oc -> destructor that does nothing, or null

/**
 * The do-nothing destructor of the opencascade.js build, or null if it has none.
 *
 * Detected rather than assumed, so that a build with working destructors is
 * never freed twice: gp_Trsf (plain data) and TopoDS_Shape (which holds
 * references) can only share their destructor if it does nothing, while the
 * constructible gp_Trsf_1 subclass has a real one.
 */
function noopDestructor(oc) {
  let noop = noopDestructors.get(oc);
  if (noop === undefined) {
    const shape = new oc.TopoDS_Shape();
    const trsf = new oc.gp_Trsf_1();
    const candidate = shape.$$.ptrType.registeredClass.rawDestructor;
    const trsfClass = trsf.$$.ptrType.registeredClass;
    noop = trsfClass.baseClass?.rawDestructor === candidate && trsfClass.rawDestructor !== candidate ? candidate : null;
    noopDestructors.set(oc, noop);
    trsf.delete();
    release(oc, shape);
  }
  return noop;
}

/** Whether the wasm heap is (nearly) at its maximum size: allocations then fail. */
function heapExhausted(oc) {
  return oc.HEAPU8.length > HEAP_MAX - HEAP_MARGIN;
}

/**
 * Display tessellation of the shapes: every solid, then every loose shell and
 * loose face, in its own BRepMesh_IncrementalMesh call.
 *
 * cad.py meshes all the parts in one call. The mesher keeps working data for
 * every face of its shape until the call returns (about 70 kB per face in
 * wasm), so one call on a large model fills the 4 GB wasm heap and leaves the
 * faces without triangulation. Solids do not share edges, so meshing them one
 * by one with the same absolute deflection gives the same triangulation, and
 * the memory peak is that of the largest solid. The triangulation is stored
 * in the shared geometry (TShape): the other instances of an assembly part
 * are not meshed again.
 */
function meshEach(ctx, shapes, deflection, ang, report = true) {
  const { oc } = ctx;
  const { TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE, TopAbs_SHAPE } = oc.TopAbs_ShapeEnum;
  const tshapeKey = (shape) => {
    const tshape = shape.TShape_1();
    const key = tshape.get().$$.ptr;
    tshape.delete();
    return key;
  };
  const mesh = (shape) => {
    const key = tshapeKey(shape);
    if (ctx.meshed.has(key)) return;
    ctx.meshed.add(key);
    // (shape, linear deflection, relative = false, angular deflection, parallel = true)
    new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, ang, true).delete();
  };
  // Progress (50 -> 65 % of the analysis), solid by solid, weighted by their
  // number of faces. The solids already meshed (other instances) count for nothing.
  if (report) {
    const seen = new Set();
    let faces = 0;
    for (const shape of shapes) {
      forEachChild(ctx, shape, TopAbs_SOLID, TopAbs_SHAPE, (solid) => {
        const key = tshapeKey(solid);
        if (!ctx.meshed.has(key) && !seen.has(key)) {
          seen.add(key);
          faces += countChildren(ctx, solid, TopAbs_FACE);
        }
      });
    }
    ctx.step('mesh', 0.5, 0.65, { totalWeight: Math.max(1, faces), unitsPerWeight: WORK.meshPerFace });
  }
  const meshSolid = (solid) => {
    if (!report || ctx.meshed.has(tshapeKey(solid))) mesh(solid);
    else ctx.item(countChildren(ctx, solid, TopAbs_FACE), () => mesh(solid));
  };
  for (const shape of shapes) {
    forEachChild(ctx, shape, TopAbs_SOLID, TopAbs_SHAPE, meshSolid);
    forEachChild(ctx, shape, TopAbs_SHELL, TopAbs_SOLID, mesh);
    forEachChild(ctx, shape, TopAbs_FACE, TopAbs_SHELL, mesh);
  }
}

/** Sub-shapes of a kind (outside `avoid` ones), kept until the end of the analysis. */
function children(ctx, shape, kind, avoid = ctx.oc.TopAbs_ShapeEnum.TopAbs_SHAPE) {
  const out = [];
  const exp = new ctx.oc.TopExp_Explorer_2(shape, kind, avoid);
  for (; exp.More(); exp.Next()) out.push(ctx.keep(exp.Current()));
  exp.delete();
  return out;
}

/** Call fn on each sub-shape of a kind (outside `avoid` ones), released right after. */
function countChildren(ctx, shape, kind) {
  let n = 0;
  forEachChild(ctx, shape, kind, ctx.oc.TopAbs_ShapeEnum.TopAbs_SHAPE, () => n++);
  return n;
}

function forEachChild(ctx, shape, kind, avoid, fn) {
  const exp = new ctx.oc.TopExp_Explorer_2(shape, kind, avoid);
  try {
    for (; exp.More(); exp.Next()) {
      const child = exp.Current();
      try {
        fn(child);
      } finally {
        release(ctx.oc, child);
      }
    }
  } finally {
    exp.delete();
  }
}

function compound(ctx, shapes) {
  const comp = ctx.keep(new ctx.oc.TopoDS_Compound());
  const builder = new ctx.oc.BRep_Builder();
  builder.MakeCompound(comp);
  for (const s of shapes) builder.Add(comp, s);
  release(ctx.oc, builder);
  return comp;
}

/** Shell made of one face. */
function shellOf(ctx, face) {
  const shell = ctx.keep(new ctx.oc.TopoDS_Shell());
  const builder = new ctx.oc.BRep_Builder();
  builder.MakeShell(shell);
  builder.Add(shell, face);
  release(ctx.oc, builder);
  return shell;
}

function area(ctx, shape) {
  const props = new ctx.oc.GProp_GProps_1();
  try {
    // (shape, props, Eps, skip shared = false)
    ctx.oc.BRepGProp.SurfaceProperties_2(shape, props, GPROP_EPS, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

function bbox(ctx, shape) {
  const box = new ctx.oc.Bnd_Box_1();
  try {
    ctx.oc.BRepBndLib.AddOptimal(shape, box, false, false);
    if (box.IsVoid()) return [[0, 0, 0], [0, 0, 0]];
    return [pointXYZ(ctx.oc, box.CornerMin()), pointXYZ(ctx.oc, box.CornerMax())];
  } finally {
    box.delete();
  }
}

function bboxDiagonal(ctx, shape) {
  const box = new ctx.oc.Bnd_Box_1();
  try {
    ctx.oc.BRepBndLib.Add(shape, box, false);
    return box.IsVoid() ? 1.0 : Math.sqrt(box.SquareExtent());
  } finally {
    box.delete();
  }
}

/** [x, y, z] of a gp_Pnt, which is released. */
function pointXYZ(oc, p) {
  const xyz = [p.X(), p.Y(), p.Z()];
  release(oc, p);
  return xyz;
}

/**
 * Display triangulation of every face of `shape`, in world coordinates
 * (face location applied) with reversed faces flipped so that normals point
 * outwards: double-precision vertices, indices, and the signed volume of that
 * mesh. Faces without triangulation are counted in the context.
 */
function triangulate(ctx, shape) {
  const { oc } = ctx;
  const { TopAbs_FACE, TopAbs_SHAPE } = oc.TopAbs_ShapeEnum;
  const reversed = oc.TopAbs_Orientation.TopAbs_REVERSED;
  const pieces = [];
  let nodeCount = 0;
  let triCount = 0;
  forEachChild(ctx, shape, TopAbs_FACE, TopAbs_SHAPE, (current) => {
    const face = oc.TopoDS.Face_1(current);
    const loc = new oc.TopLoc_Location_1();
    const handle = oc.BRep_Tool.Triangulation(face, loc, 0 /* Poly_MeshPurpose_NONE */);
    try {
      if (handle.IsNull()) {
        ctx.untriangulatedFaces++;
        return;
      }
      const { nodes, triangles } = readTriangulation(oc, handle.get());
      pieces.push({
        nodes,
        triangles,
        matrix: loc.IsIdentity() ? null : ctx.matrixOf(loc),
        flip: face.Orientation_1() === reversed,
      });
      nodeCount += nodes.length / 3;
      triCount += triangles.length / 3;
    } finally {
      handle.delete();
      loc.delete();
      release(oc, face);
    }
  });

  const verts = new Float64Array(nodeCount * 3);
  const faces = new Uint32Array(triCount * 3);
  let v = 0;
  let f = 0;
  for (const { nodes, triangles, matrix: m, flip } of pieces) {
    const offset = v / 3 - 1; // Poly_Triangle node indices are 1-based
    for (let i = 0; i < nodes.length; i += 3) {
      const x = nodes[i];
      const y = nodes[i + 1];
      const z = nodes[i + 2];
      if (m) {
        verts[v++] = m[0] * x + m[1] * y + m[2] * z + m[3];
        verts[v++] = m[4] * x + m[5] * y + m[6] * z + m[7];
        verts[v++] = m[8] * x + m[9] * y + m[10] * z + m[11];
      } else {
        verts[v++] = x;
        verts[v++] = y;
        verts[v++] = z;
      }
    }
    for (let i = 0; i < triangles.length; i += 3) {
      faces[f++] = triangles[i] + offset;
      faces[f++] = triangles[flip ? i + 2 : i + 1] + offset;
      faces[f++] = triangles[flip ? i + 1 : i + 2] + offset;
    }
  }

  return {
    verts,
    indices: faces,
    triangles: triCount,
    signedVolume: triCount ? meshSignedVolume(verts, faces) : 0,
  };
}

/** 3x4 row-major matrix of a location (rotation and scale included, then translation). */
function affine(oc, loc) {
  const trsf = loc.Transformation();
  const m = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) m.push(trsf.Value(r, c));
  release(oc, trsf);
  return m;
}

// ------------------------------------------------------------- triangulation data

/**
 * Nodes (Float64Array of xyz) and triangles (Int32Array of 1-based node
 * indices) of a Poly_Triangulation.
 *
 * The documented accessors, Node(i) and Triangle(i), need several embind calls
 * and a heap allocation per element: on big models that is slow. So the arrays
 * are located inside the Poly_Triangulation object and read straight from the
 * heap; the layout found is checked against Node(i)/Triangle(i) on first,
 * middle and last elements of every triangulation, and the accessors are used
 * whenever that check fails. Either way the values are bit-identical.
 */
function readTriangulation(oc, tri) {
  const n = tri.NbNodes();
  const m = tri.NbTriangles();
  const nodeAt = (i) => pointXYZ(oc, tri.Node(i));
  const triangleAt = (i) => {
    const t = tri.Triangle(i);
    const abc = [t.Value(1), t.Value(2), t.Value(3)];
    release(oc, t);
    return abc;
  };
  const nodeSamples = sampleIndices(n).map((i) => [i, nodeAt(i)]);
  const triSamples = sampleIndices(m).map((i) => [i, triangleAt(i)]);
  // Embind hands pointers over as signed 32-bit integers: negative above 2 GiB.
  const objPtr = tri.$$.ptr >>> 0;
  // Sampling allocates: the heap views are looked up only now (memory may have grown).
  return {
    nodes: readDirect(oc, objPtr, NODE_LAYOUTS, nodeSamples, n, Float64Array) ?? readSlow(n, nodeAt, Float64Array),
    triangles: readDirect(oc, objPtr, TRIANGLE_LAYOUTS, triSamples, m, Int32Array) ?? readSlow(m, triangleAt, Int32Array),
  };
}

// Element storage that can back the arrays: nodes are doubles (gp_Pnt) or
// floats (gp_Vec3f), triangles are three int32. `shift` is 1 when the stored
// pointer designates a virtual element 0 (NCollection_Array1 of OCCT 7.x).
const NODE_LAYOUTS = [
  { heap: 'HEAPF64', shift: 0 },
  { heap: 'HEAPF32', shift: 0 },
  { heap: 'HEAPF64', shift: 1 },
  { heap: 'HEAPF32', shift: 1 },
];
const TRIANGLE_LAYOUTS = [
  { heap: 'HEAP32', shift: 1 },
  { heap: 'HEAP32', shift: 0 },
];
const SCAN_BYTES = 256; // part of the Poly_Triangulation object searched for array pointers
const foundLayouts = new WeakMap(); // layout list -> {offset, layout} that matched last time

function readDirect(oc, objPtr, layouts, samples, count, ArrayType) {
  if (!count) return new ArrayType(0);
  if (!Number.isInteger(objPtr) || !objPtr) return null;
  const found = locateArray(oc, objPtr, layouts, samples);
  if (!found) return null;
  // The typed-array constructor copies (and widens float32 to float64).
  return new ArrayType(oc[found.layout.heap].subarray(found.base, found.base + count * 3));
}

/** Where the array is: the last layout that worked is tried first, then all of them. */
function locateArray(oc, objPtr, layouts, samples) {
  const known = foundLayouts.get(layouts);
  if (known) {
    const base = arrayBase(oc, objPtr, known.offset, known.layout, samples);
    if (base != null) return { base, layout: known.layout };
  }
  for (let offset = 0; offset < SCAN_BYTES; offset += 4) {
    for (const layout of layouts) {
      const base = arrayBase(oc, objPtr, offset, layout, samples);
      if (base != null) {
        foundLayouts.set(layouts, { offset, layout });
        return { base, layout };
      }
    }
  }
  return null;
}

/**
 * Index (in units of the heap view) of element 1 if the pointer stored at
 * objPtr + offset designates an array matching every sample, else null.
 */
function arrayBase(oc, objPtr, offset, { heap: heapName, shift }, samples) {
  const pointer = oc.HEAPU32[(objPtr + offset) >>> 2];
  const heap = oc[heapName];
  const bytes = heap.BYTES_PER_ELEMENT;
  if (!pointer || pointer % bytes) return null;
  const base = pointer / bytes + 3 * shift;
  for (const [i, values] of samples) {
    const at = base + 3 * (i - 1);
    if (at < 0 || at + 3 > heap.length) return null;
    if (heap[at] !== values[0] || heap[at + 1] !== values[1] || heap[at + 2] !== values[2]) return null;
  }
  return base;
}

function readSlow(count, element, ArrayType) {
  const out = new ArrayType(count * 3);
  for (let i = 1; i <= count; i++) out.set(element(i), 3 * (i - 1));
  return out;
}

/** Distinct 1-based indices of the first, middle and last elements. */
function sampleIndices(count) {
  return [...new Set([1, Math.ceil(count / 2), count])].filter((i) => i >= 1);
}

/** Signed volume (divergence theorem), centred on the vertex mean for precision far from the origin. */
function meshSignedVolume(verts, faces) {
  const nv = verts.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < verts.length; i += 3) {
    cx += verts[i];
    cy += verts[i + 1];
    cz += verts[i + 2];
  }
  cx /= nv;
  cy /= nv;
  cz /= nv;
  let sum = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3;
    const b = faces[f + 1] * 3;
    const c = faces[f + 2] * 3;
    const ax = verts[a] - cx, ay = verts[a + 1] - cy, az = verts[a + 2] - cz;
    const bx = verts[b] - cx, by = verts[b + 1] - cy, bz = verts[b + 2] - cz;
    const qx = verts[c] - cx, qy = verts[c + 1] - cy, qz = verts[c + 2] - cz;
    sum += ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx);
  }
  return sum / 6;
}

/**
 * Embind hands `const char*` results over one byte per character (Latin-1),
 * while OpenCascade produced UTF-8 bytes: decode them again. Strings that are
 * not valid UTF-8 (or already decoded) are returned unchanged.
 */
function utf8FromBinaryString(s) {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) return s;
    if (code > 0x7f) ascii = false;
  }
  if (ascii) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (ch) => ch.charCodeAt(0)));
  } catch {
    return s;
  }
}

/**
 * Turn whatever OpenCascade threw into an Error. C++ exceptions reach
 * JavaScript as raw pointers (numbers); opencascade.js can map them back to
 * the Standard_Failure that was thrown. Failures with a full heap are most
 * likely failed allocations (Standard_OutOfMemory, std::bad_alloc).
 */
function readableError(oc, err) {
  if (err instanceof Error) return err;
  if (heapExhausted(oc)) return new Error(OUT_OF_MEMORY);
  if (typeof err === 'number') {
    let detail = '';
    try {
      const failure = oc.OCJS.getStandard_FailureData(err);
      const type = failure.DynamicType().get().Name();
      const message = failure.GetMessageString();
      detail = message ? `${type}: ${message}` : type;
    } catch {
      // not a Standard_Failure (e.g. std::bad_alloc)
    }
    return new Error(`OpenCascade could not process the file${detail ? ` (${detail})` : ''}`);
  }
  return new Error(String(err));
}

/** Lower-case extension with its dot, like Path.suffix.lower(). */
function suffix(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** File name without its last extension, like Path.stem. */
function stem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
