// The key facts of what the IA page (ai-workspace.js) sends with a question,
// kept with each answer: the part and its costing as the model saw them when
// it answered. The next question compares them with the facts of its own
// context and tells the model what changed since (updateNote): a model
// trusts its own earlier answers of the conversation ("les épaisseurs ne sont
// pas calculées") over the new data, unless it is told.
//
// Read from the whole context of a question (engine/ai-context.js
// buildAIContext, before its compaction and the anonymizer), with the costing
// trace as it is sent (chiffrage/ai-trace.js traceForAI: an internal amount
// masked for the gateway stays unknown here, never told). No names: the
// bodies by their ids, the pieces of the quote by their rank. Pure functions,
// no DOM.
//
// {version, bodies: [ids of the bodies sent], body: {id: facts}, costing}:
//   thickness  null: not measured; {min, method (of the min), median, max} (mm);
//              missing: not in the data of the task (« Features » has no
//              foundry screen), never compared
//   parting    {status, axis, origin (proposed, candidate, manual, drawn;
//              null: a manual one whose source the task does not give),
//              planar, undercut (% of the area)}; missing: none computed
//   slides     {status, count, cores}; missing: none
//   feeding    {status, risers (count), gate (position, mm)}; missing: none
//   holes      {status, through, blind}; missing: no cylinder
//   closed, volume (mm³), mass (g)
//   costing    the task « Chiffrage » only: null without a costing workbook,
//              else {count (pieces), pieces: [{island, cycle (s), pri, price
//              (€, null when masked)}]}
// A fact that one side does not have is never compared.

export const FACTS_VERSION = 1;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 1) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const text = (v) => (typeof v === "string" && v ? v.slice(0, 80) : null);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** The wall thickness of a body of a context: null when not measured, undefined when the context does not give it. */
function thicknessFacts(b) {
  const t = b.foundry?.evidence?.thickness;
  if (isObject(t)) return t.status === "measured" ? { min: round(t.min_mm), method: text(t.min_method), median: round(t.median_mm), max: round(t.max_mm) } : null;
  const f = b.manufacturing?.functional_thickness;
  if (isObject(f)) return finite(f.minimum_wall_thickness_mm) ? { min: round(f.minimum_wall_thickness_mm), method: null, median: null, max: null } : null;
  return undefined;
}

// How a parting defined by hand was: a candidate chosen, a line drawn; a face or a direction typed is "manual".
const MANUAL_ORIGINS = { candidate: "candidate", drawn: "drawn" };

function partingFacts(b) {
  const p = b.parting;
  // Its source in its own context when drawn, else in the foundry screen (not in the task « Features »).
  const source = text(p.source) ?? text(b.foundry?.evidence?.parting?.source);
  const origin = p.status === "proposed" ? "proposed" : p.status === "manual" ? MANUAL_ORIGINS[source] ?? (source ? "manual" : null) : null;
  return { status: text(p.status), axis: text(p.axis), origin, planar: typeof p.planar === "boolean" ? p.planar : null, undercut: finite(p.undercut_share) ? round(p.undercut_share * 100) : null };
}

function bodyFacts(b) {
  const out = {};
  const thickness = thicknessFacts(b);
  if (thickness !== undefined) out.thickness = thickness;
  if (isObject(b.parting)) out.parting = partingFacts(b);
  if (isObject(b.slides)) out.slides = { status: text(b.slides.status), count: count(b.slides.count), cores: count(b.slides.cores) };
  if (isObject(b.feeding)) {
    const gate = b.feeding.gate?.position_mm;
    out.feeding = { status: text(b.feeding.status), risers: Array.isArray(b.feeding.risers) ? b.feeding.risers.length : null, gate: Array.isArray(gate) && gate.every(finite) ? gate.map((x) => round(x, 0)) : null };
  }
  if (isObject(b.holes)) out.holes = { status: text(b.holes.status), through: count(b.holes.through), blind: count(b.holes.blind) };
  if (typeof b.quality?.closed === "boolean") out.closed = b.quality.closed;
  if (finite(b.metrics?.volume_mm3)) out.volume = round(b.metrics.volume_mm3);
  if (finite(b.metrics?.mass_g)) out.mass = round(b.metrics.mass_g, 2);
  return out;
}

/** The costing trace sent (costing_trace): per piece, its island retained, its cycle, its PRI and its price; null without one. */
function costingFacts(trace) {
  if (!isObject(trace)) return null;
  const pieces = Array.isArray(trace.pieces) ? trace.pieces : [];
  return {
    count: pieces.length + (count(trace.autres_pieces) ?? 0),
    pieces: pieces.map((p) => {
      const value = (key) => p?.valeurs?.[key]?.valeur; // "masqué" for an internal amount the gateway does not get
      const retained = (Array.isArray(p?.routes) ? p.routes : []).find((r) => r?.retenue);
      return { island: text(value("piece.ilot")) ?? text(retained?.ilot), cycle: round(value("piece.cycle")), pri: round(value("piece.prix.pri"), 2), price: round(value("piece.prix.vente"), 2) };
    }),
  };
}

/**
 * The facts of a whole AI context, before its compaction and its anonymizer
 * (see above); null when it is none.
 */
export function factsOf(context) {
  if (!isObject(context)) return null;
  const bodies = context.no_model_loaded ? [] : Array.isArray(context.bodies) ? context.bodies : [];
  const raw = { version: FACTS_VERSION, bodies: bodies.map((b, i) => text(b?.id) ?? `body-${i}`), body: {} };
  bodies.forEach((b, i) => {
    raw.body[raw.bodies[i]] = bodyFacts(isObject(b) ? b : {});
  });
  if ("costing_trace" in context) raw.costing = costingFacts(context.costing_trace);
  return cleanFacts(raw);
}

/**
 * Facts as they are kept: their known fields, of their types (a file of the
 * network folder may come from another version of the page, or be edited);
 * null when they are not facts of this version.
 */
export function cleanFacts(f) {
  if (!isObject(f) || f.version !== FACTS_VERSION || !Array.isArray(f.bodies)) return null;
  const n = (v) => (finite(v) ? v : null);
  const b = (v) => (typeof v === "boolean" ? v : null);
  const bodies = [...new Set(f.bodies.filter((id) => typeof id === "string").map((id) => id.slice(0, 80)))].slice(0, 2000);
  const body = {};
  for (const id of bodies) {
    const x = isObject(f.body) && isObject(f.body[id]) ? f.body[id] : {};
    const out = {};
    if ("thickness" in x) out.thickness = isObject(x.thickness) ? { min: n(x.thickness.min), method: text(x.thickness.method), median: n(x.thickness.median), max: n(x.thickness.max) } : null;
    if (isObject(x.parting)) {
      const p = x.parting;
      out.parting = { status: text(p.status), axis: text(p.axis), origin: text(p.origin), planar: b(p.planar), undercut: n(p.undercut) };
    }
    if (isObject(x.slides)) out.slides = { status: text(x.slides.status), count: count(x.slides.count), cores: count(x.slides.cores) };
    if (isObject(x.feeding)) {
      const gate = x.feeding.gate;
      out.feeding = { status: text(x.feeding.status), risers: count(x.feeding.risers), gate: Array.isArray(gate) && gate.length === 3 && gate.every(finite) ? [...gate] : null };
    }
    if (isObject(x.holes)) out.holes = { status: text(x.holes.status), through: count(x.holes.through), blind: count(x.holes.blind) };
    if (typeof x.closed === "boolean") out.closed = x.closed;
    if (finite(x.volume)) out.volume = x.volume;
    if (finite(x.mass)) out.mass = x.mass;
    body[id] = out;
  }
  const out = { version: FACTS_VERSION, bodies, body };
  if ("costing" in f) {
    const c = f.costing;
    out.costing = isObject(c)
      ? { count: count(c.count) ?? 0, pieces: (Array.isArray(c.pieces) ? c.pieces : []).filter(isObject).slice(0, 500).map((p) => ({ island: text(p.island), cycle: n(p.cycle), pri: n(p.pri), price: n(p.price) })) }
      : null;
  }
  return out;
}

// --------------------------------------------------------------------------- what changed

/** A number as the page writes it: French, `digits` decimals at most ("3,2", "12 000"). */
const fr = (v, digits = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: digits });
const euros = (v) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const plural = (k, word, words = `${word}s`) => `${k} ${k > 1 ? words : word}`;
/** "a → b", or "b" when they are the same. */
const change = (a, b, show) => (a !== null && a !== undefined && a !== b ? `${show(a)} → ${show(b)}` : show(b));

const METHODS = { wall: "paroi", sphere: "sphère", ray: "rayon" };

/** "mini 3,2 mm, méthode paroi ; médiane 5,1 mm ; maxi 12 mm", each value changed since `before` as "a → b". */
function thicknessText(t, before = null) {
  const mm = (v) => `${fr(v)} mm`;
  const value = (k) => (before && before[k] !== null && t[k] !== null && before[k] !== t[k] ? `${fr(before[k])} → ${mm(t[k])}` : mm(t[k]));
  return [
    t.min !== null ? `mini ${value("min")}${t.method ? `, méthode ${METHODS[t.method] ?? t.method}` : ""}` : null,
    t.median !== null ? `médiane ${value("median")}` : null,
    t.max !== null ? `maxi ${value("max")}` : null,
  ].filter(Boolean).join(" ; ");
}

const ORIGINS = { proposed: "proposé", candidate: "candidat choisi", manual: "défini à la main", drawn: "dessiné à la main" };
const PARTING_STATUS = { proposed: "proposé", manual: "défini à la main" };
const how = (p) => ORIGINS[p.origin] ?? PARTING_STATUS[p.status] ?? null;
const percent = (v) => `${fr(v)} %`;

function partingText(p) {
  return [
    p.axis ? `direction ${p.axis}` : null,
    how(p),
    p.planar === null ? null : p.planar ? "ligne plane" : "ligne non plane",
    p.undercut === null ? null : `contre-dépouilles ${percent(p.undercut)}`,
  ].filter(Boolean).join(", ");
}

/** What changed of the parting of a body: [] when nothing. */
function partingChanges(x, y) {
  const parts = [];
  if (x.axis !== y.axis) parts.push(`direction ${x.axis ?? "?"} → ${y.axis ?? "?"}${how(y) ? ` (${how(y)})` : ""}`);
  else if (((x.origin && y.origin && x.origin !== y.origin) || x.status !== y.status) && how(x) && how(y) && how(x) !== how(y)) parts.push(`${how(x)} → ${how(y)}${y.axis ? ` (direction ${y.axis})` : ""}`);
  if (x.planar !== null && y.planar !== null && x.planar !== y.planar) parts.push(y.planar ? "ligne non plane → plane" : "ligne plane → non plane");
  if (x.undercut !== null && y.undercut !== null && x.undercut !== y.undercut) parts.push(`contre-dépouilles ${percent(x.undercut)} → ${percent(y.undercut)}`);
  return parts;
}

const slidesComputed = (s) => !!s && (s.status === "proposed" || s.status === "manual");
const SLIDES_STATUS = { computing: "calcul en cours", error: "calcul en échec" };

function slidesText(s) {
  return [
    s.count !== null ? plural(s.count, "tiroir") : null,
    s.cores !== null ? `${plural(s.cores, "noyau probable", "noyaux probables")}` : null,
    s.status === "manual" ? "modifiés à la main" : null,
  ].filter(Boolean).join(", ");
}

const FEEDING_STATUS = { proposed: "proposée", manual: "placée à la main" };

function feedingText(f) {
  return [f.risers !== null ? plural(f.risers, "masselotte") : null, f.gate ? "attaque placée" : "sans attaque"].filter(Boolean).join(", ");
}

const holesMeasured = (h) => !!h && h.through !== null && h.blind !== null && h.status !== "not_measured";
/** Two measures the same to their last digit kept (a rounding of floating point, not a change). */
const same = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(Math.abs(a), Math.abs(b), 1);
const significant = (v) => v.toLocaleString("fr-FR", { maximumSignificantDigits: 4 });
const volume = (v) => `${significant(v / 1000)} cm³`;
const mass = (g) => (g >= 1000 ? `${significant(g / 1000)} kg` : `${significant(g)} g`);

/** What changed of body `id` (`x` before, `y` now; `tag`: its id, when several bodies are sent). */
function bodyChanges(x, y, tag, add) {
  if ("thickness" in x && "thickness" in y) {
    const [a, b] = [x.thickness, y.thickness];
    if (!a && b) add("épaisseurs mesurées", `Épaisseurs${tag} : maintenant mesurées (${thicknessText(b)})`);
    else if (a && !b) add("épaisseurs", `Épaisseurs${tag} : plus mesurées`);
    else if (a && b && ["min", "method", "median", "max"].some((k) => a[k] !== b[k])) add("épaisseurs", `Épaisseurs${tag} : ${thicknessText(b, a)}`);
  }

  const [p, q] = [x.parting ?? null, y.parting ?? null];
  if (!p && q) add("plan de joint", `Plan de joint${tag} : maintenant défini (${partingText(q)})`);
  else if (p && !q) add("plan de joint", `Plan de joint${tag} : plus défini`);
  else if (p && q) {
    const parts = partingChanges(p, q);
    if (parts.length) add("plan de joint", `Plan de joint${tag} : ${parts.join(" ; ")}`);
  }

  const [s, t] = [x.slides ?? null, y.slides ?? null];
  if (slidesComputed(t) && !slidesComputed(s)) add("tiroirs", `Tiroirs${tag} : maintenant calculés (${slidesText(t)})`);
  else if (slidesComputed(s) && !slidesComputed(t)) add("tiroirs", `Tiroirs${tag} : ${SLIDES_STATUS[t?.status] ?? "plus calculés"}`);
  else if (slidesComputed(s) && slidesComputed(t)) {
    const parts = [];
    if (s.count !== null && t.count !== null && s.count !== t.count) parts.push(`${s.count} → ${t.count}`);
    if (s.cores !== null && t.cores !== null && s.cores !== t.cores) parts.push(`noyaux probables ${s.cores} → ${t.cores}`);
    if (s.status !== t.status) parts.push(t.status === "manual" ? "modifiés à la main" : "proposés à nouveau");
    if (parts.length) add("tiroirs", `Tiroirs${tag} : ${parts.join(" ; ")}`);
  }

  const [f, g] = [x.feeding ?? null, y.feeding ?? null];
  if (!f && g) add("alimentation", `Alimentation${tag} : maintenant ${FEEDING_STATUS[g.status] ?? "proposée"} (${feedingText(g)})`);
  else if (f && !g) add("alimentation", `Alimentation${tag} : plus définie`);
  else if (f && g) {
    const parts = [];
    if (f.status !== g.status && FEEDING_STATUS[f.status] && FEEDING_STATUS[g.status]) parts.push(`${FEEDING_STATUS[f.status]} → ${FEEDING_STATUS[g.status]}`);
    if (f.risers !== null && g.risers !== null && f.risers !== g.risers) parts.push(`masselottes ${f.risers} → ${g.risers}`);
    if (!f.gate && g.gate) parts.push("attaque placée");
    else if (f.gate && !g.gate) parts.push("attaque retirée");
    else if (f.gate && g.gate && f.gate.some((v, i) => v !== g.gate[i])) parts.push("attaque déplacée");
    if (parts.length) add("alimentation", `Alimentation${tag} : ${parts.join(" ; ")}`);
  }

  const [h, k] = [x.holes ?? null, y.holes ?? null];
  if (holesMeasured(k) && !holesMeasured(h)) add("trous", `Trous${tag} : maintenant mesurés (${plural(k.through, "débouchant")}, ${plural(k.blind, "borgne")})`);
  else if (holesMeasured(h) && holesMeasured(k) && (h.through !== k.through || h.blind !== k.blind)) {
    add("trous", `Trous${tag} : débouchants ${change(h.through, k.through, String)} ; borgnes ${change(h.blind, k.blind, String)}`);
  }

  if (typeof x.closed === "boolean" && typeof y.closed === "boolean" && x.closed !== y.closed) add(y.closed ? "corps fermé" : "corps ouvert", `Corps${tag} : maintenant ${y.closed ? "fermé" : "ouvert"}`);
  if (finite(x.volume) && finite(y.volume) && !same(x.volume, y.volume)) add("volume", `Volume${tag} : ${volume(x.volume)} → ${volume(y.volume)}`);
  if (finite(x.mass) && finite(y.mass) && !same(x.mass, y.mass)) add("masse", `Masse${tag} : ${mass(x.mass)} → ${mass(y.mass)}`);
}

/** What changed of the costing trace sent (task « Chiffrage », both times). */
function costingChanges(a, b, add) {
  if (!a && b) return add("chiffrage", "Chiffrage : un classeur de chiffrage est maintenant importé (costing_trace)");
  if (a && !b) return add("chiffrage", "Chiffrage : plus de classeur de chiffrage (costing_trace null)");
  if (!a || !b) return;
  if (a.count !== b.count) add("chiffrage", `Chiffrage : ${plural(a.count, "pièce")} → ${plural(b.count, "pièce")}`);
  for (let i = 0; i < Math.min(a.pieces.length, b.pieces.length); i++) {
    const [u, v] = [a.pieces[i], b.pieces[i]];
    const parts = [];
    if (u.island !== v.island) parts.push(`îlot ${u.island ?? "aucun"} → ${v.island ?? "aucun"}`);
    if (u.cycle !== null && v.cycle !== null && u.cycle !== v.cycle) parts.push(`cycle ${fr(u.cycle)} s → ${fr(v.cycle)} s`);
    if (u.pri !== null && v.pri !== null && u.pri !== v.pri) parts.push(`PRI ${euros(u.pri)} → ${euros(v.pri)}`);
    if (u.price !== null && v.price !== null && u.price !== v.price) parts.push(`prix de vente ${euros(u.price)} → ${euros(v.price)}`);
    if (parts.length) add("chiffrage", `Chiffrage${b.pieces.length > 1 ? ` (pièce ${i + 1})` : ""} : ${parts.join(" ; ")}`);
  }
}

/**
 * What changed from the facts `previous` (kept with the model's last answer)
 * to `current` (of the question asked now): [{line (French, for the model),
 * label (a few words, for the person)}]; [] when nothing did, or when either
 * is not facts of this version.
 */
export function factChanges(previous, current) {
  const a = cleanFacts(previous);
  const b = cleanFacts(current);
  if (!a || !b) return [];
  const out = [];
  const add = (label, line) => out.push({ label, line });
  const ids = (list) => (list.length <= 6 ? list.join(", ") : `${list.length} corps`);
  if (a.bodies.length !== b.bodies.length) add("corps envoyés", `Corps envoyés : ${a.bodies.length} → ${b.bodies.length}${b.bodies.length && b.bodies.length <= 6 ? ` (${b.bodies.join(", ")})` : ""}`);
  else if (a.bodies.some((id, i) => id !== b.bodies[i])) add("corps envoyés", `Corps envoyés : ${ids(a.bodies)} → ${ids(b.bodies)}`);
  for (const id of b.bodies) {
    if (a.body[id]) bodyChanges(a.body[id], b.body[id], b.bodies.length > 1 ? ` (${id})` : "", add);
  }
  if ("costing" in a && "costing" in b) costingChanges(a.costing, b.costing, add);
  return out;
}

/** What changed from `previous` to `current`, one short French line each (factChanges). */
export function diffFacts(previous, current) {
  return factChanges(previous, current).map((c) => c.line);
}

export const UPDATE_START = "MISE À JOUR DE LA PIÈCE depuis ta dernière réponse : ";
export const UPDATE_END = "Les DONNÉES jointes sont l'état actuel de la pièce : elles remplacent ce que tu as écrit avant ; refais ton analyse avec elles.";
/** Said with a question when the conversation's answers have no facts to compare with (kept by an earlier version). */
export const CURRENT_DATA = "Les DONNÉES jointes sont l'état actuel de la pièce ; elles priment sur tes réponses précédentes.";

/**
 * What the model is told before a question asked with a conversation
 * (`history`: some of it is sent): what changed since the facts of its last
 * answer (`previous`), when something did; the data first when its answers
 * have none. {text, lines, labels (for the person, [] for the generic
 * line)}, or null: nothing to say.
 */
export function updateNote(previous, current, history = true) {
  if (!history || !cleanFacts(current)) return null;
  if (!cleanFacts(previous)) return { text: CURRENT_DATA, lines: [], labels: [] };
  const changes = factChanges(previous, current);
  if (!changes.length) return null;
  const lines = changes.map((c) => c.line);
  return { text: `${UPDATE_START}${lines.join(". ")}. ${UPDATE_END}`, lines, labels: [...new Set(changes.map((c) => c.label))] };
}

/** The question as the model gets it: the note `note` (updateNote), when there is one, before it. */
export const withNote = (note, question) => (note?.text ? `${note.text}\n\n${question}` : question);

/** The facts of the last answer of `messages` that has some (an answer of an earlier version has none), else null. */
export function lastFacts(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && cleanFacts(m.facts)) return m.facts;
  }
  return null;
}
