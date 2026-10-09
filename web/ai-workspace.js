// "IA / analyse" page: questions on the part shown, answered either by a
// language model behind the AI gateway (api/ai.js on Vercel: Groq or another
// OpenAI-compatible provider) or by a local model run by Ollama on this
// computer or on a device of the local network, a Jetson for instance
// (nothing leaves the site).
//
// The gateway gives its configuration (GET): provider, model, the size of
// context it takes (the free plan of Groq allows 8,000 tokens a minute), and
// whether it asks for an access code, sent in the X-Reader3D-Code header.
//
// Local Ollama from a page on the web needs two permissions, both outside this
// page: Ollama must allow the page's origin (OLLAMA_ORIGINS), and the browser
// must allow the site to reach applications on this device ("Apps on device" /
// loopback-network permission of Chrome and Edge, Firefox "Device apps and
// services") or devices of the local network ("Local network" /
// local-network). diagnoseOllama() tells which one is missing.
//
// Task "Chiffrage": the model is given the traced values of the quote shown
// (costing_trace, from chiffrage/ui.js costingSnapshot), read only. It
// explains, it never sets a value: no answer is applied to the quote or the
// settings. Every number of its answer must be in the trace, or the answer is
// marked "non vérifiée". The AI gateway gets the internal amounts masked,
// unless the user ticks the box that sends them. Each answer of this task is
// kept with the quote (chiffrage/ui.js addAIAnalysis), for the record.
//
// Every task with a part: the numbers of an answer that come from none of the
// data sent are counted under it (engine/ai-context.js checkContextNumbers).
//
// The Chiffrage page asks the AI chosen here, outside the conversations, for
// its estimate of the casting cycle time (askJSON, chiffrage/ai-cycle.js): a
// JSON answer, a proposal that the quote uses only once a person adopts it.
//
// One conversation per tab of the 3D page (see conversationKey). The gateway
// gets neutral labels in place of the names of the part, of its bodies and of
// the quote ("Pièce", "Corps 1"...: engine/ai-context.js anonymizer), in every
// task, unless the box is unticked; Ollama always gets the real names
// (nothing leaves the site). When the free quota of the gateway is reached,
// the local model answers if it can (box "Repli automatique sur le modèle
// local"). What the local model answered never goes online with the
// conversation (onlineMessages): it was given the real names and amounts.

import { anonymizer, buildAIContext, checkContextNumbers, compactAIContext, partNames, summaryAIContext } from "./engine/ai-context.js";
import { PROPOSAL_FIELDS, checkProposals, readProposals, valueLabel } from "./chiffrage/ai-apply.js";
import * as archives from "./ai-history.js";

const PROVIDERS = [
  ["openai", "En ligne via la passerelle (Groq…)"], // value of earlier versions, kept in this browser's storage
  ["ollama", "Ollama local (ce PC ou le réseau local)"],
];
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "qwen3:8b";
// The context of a local model is kept small: its window (num_ctx) and the
// time to read the prompt on a CPU grow with it.
const LOCAL_CONTEXT_CHARS = 12000;
const LOCAL_TRACE_CHARS = 8000; // of which the costing trace (task "Chiffrage"), the geometry having the rest
const HISTORY = 6; // messages of the conversation sent again with a question
const MAX_WINDOW = 16384; // largest window (tokens) asked of Ollama
// Context budget of a gateway that does not give its own (GET), sized for the free plan of Groq.
const GATEWAY_CONTEXT_CHARS = 9000;
const GATEWAY_EXAMPLE = "https://<projet>.vercel.app/api/ai";

// The tasks of the IA page: [value, label, what the AI is given for it, a question it answers]. The task
// chooses what of the analysis goes with the question (engine/ai-context.js) and the instructions.
const TASKS = [
  ["general", "Analyse générale", "Questions libres : la pièce, ses features et son criblage fonderie.",
    "Fais l'analyse de la pièce : ce qui est mesuré, les features principales avec leurs cotes, le criblage fonderie, et ce qui reste à valider."],
  ["feature_analysis", "Features", "Les features détectées (trous, alésages, poches, congés, motifs, relations coaxiales) avec leurs cotes et leurs identifiants.",
    "Liste les features de la pièce par type, avec leurs cotes et leurs identifiants ; distingue celles qui sont établies des provisoires."],
  ["manufacturing_analysis", "Fabrication", "Les pistes de procédés et d'opérations, les épaisseurs fonctionnelles et le criblage fonderie.",
    "Quels procédés et quelles opérations pour fabriquer cette pièce ? Avec le besoin en noyaux, les contre-dépouilles et les épaisseurs à surveiller."],
  ["dfm", "DFM", "La conception pour la fabrication : recommandations, contre-dépouilles, épaisseurs, risques fonderie.",
    "Quelles modifications de conception faciliteraient la fabrication de cette pièce ? Classe-les par impact."],
  ["planning", "Planification", "Une gamme indicative : mises en position et opérations (une piste, pas une gamme exécutable).",
    "Propose une gamme d'usinage indicative : mises en position, opérations et outils, avec les points à valider."],
  ["costing", "Chiffrage", "Le devis en cours et sa trace : la réponse explique ses valeurs, chaque nombre vérifié ; les saisies qu'elle propose ne sont appliquées qu'avec votre accord.",
    "Explique le chiffrage de cette pièce : les postes principaux, les écarts signalés et les valeurs à valider."],
];
const TASK_NOTE = "Un clic sur une tâche pose sa question ; vos questions suivantes gardent la tâche choisie.";

const KEYS = {
  gateway: "reader3d.ai.gateway", code: "reader3d.ai.gatewayCode", ollama: "reader3d.ai.ollama", model: "reader3d.ai.model", provider: "reader3d.ai.provider",
  messages: "reader3d.ai.messages", think: "reader3d.ai.think", amounts: "reader3d.ai.costingAmounts", anonymize: "reader3d.ai.anonymize", fallback: "reader3d.ai.fallback",
  codeRequired: "reader3d.ai.gatewayCodeRequired", // the gateway asked for an access code: its field shown at once
  quota: "reader3d.ai.quota", // what is left of the free quota of the gateway, from its last answer in any tab of this browser
  tokens: "reader3d.ai.tokens", // the tokens of the latest answers of the gateway: {questions, all} (questions left estimated with them)
  historyTab: "reader3d.ai.historyTab", // the history shown on the right: "local" or "reseau"
};
// Sent on window when an answer of the gateway tells what is left of its free quota (the IA page shows it).
const QUOTA_EVENT = "reader3d-ai-quota";
const COSTING_LABEL = "Raisonnement IA — rien n'est appliqué sans votre accord";
// The reply suggested after a costing answer that proposes values (Tab or its button): applied here, never sent.
const APPLY_TEXT = "Appliquer les valeurs au chiffrage";
// HTTP statuses of the gateway when the free quota of its provider is reached (api/ai.js): the local model may answer instead.
const QUOTA_STATUSES = [413, 429];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const store = {
  get(area, key) {
    try {
      return area.getItem(key);
    } catch {
      return null; // storage blocked: works for this visit only
    }
  },
  set(area, key, value) {
    try {
      if (value == null) area.removeItem(key);
      else area.setItem(key, value);
    } catch {
      // storage blocked or full
    }
  },
};

// One conversation per tab of the 3D page (reader.tab), in this browser
// tab's sessionStorage: the first tab's under the key of earlier versions,
// kept after a reload as its quote (chiffrage/store.js); the others' as long
// as the page (app.js forgets them when their tab is closed and when the
// page loads again). Each answered one is also kept in the history
// (ai-history.js: this browser, and the network folder for a part), where
// the part finds it again when it is opened again. A conversation belongs to
// the part it is about ({id, part: {id: its file's hash, file}, file,
// started, updated, messages, names}): another part opened in its tab shows
// that part's last conversation, or a new one, so that a part's conversation
// is never sent with another part's context. `names`: the names of the quote
// and of the part ({name, label}) known when its questions went to the
// gateway, replaced in its history even once changed.
const conversationKey = (id) => (id == null || id === 1 ? KEYS.messages : `${KEYS.messages}.${id}`);
const unsaved = new Map(); // conversations that could not be saved (storage blocked or full): kept for this visit

/** The conversation saved under `key`: {id (null: never answered), part (null: no part yet), file, started, updated, messages, names}. */
function readConversation(key) {
  let data = null;
  try {
    data = JSON.parse(unsaved.get(key) ?? store.get(sessionStorage, key) ?? "null");
  } catch {
    data = null;
  }
  if (Array.isArray(data)) data = { messages: data }; // earlier versions: the messages alone
  const text = (v) => (typeof v === "string" ? v : null);
  return {
    id: text(data?.id),
    part: typeof data?.part?.id === "string" ? { id: data.part.id, file: text(data.part.file) } : null,
    started: text(data?.started),
    updated: text(data?.updated),
    file: text(data?.file),
    messages: Array.isArray(data?.messages) ? data.messages : [],
    names: Array.isArray(data?.names) ? data.names.filter((n) => typeof n?.name === "string" && typeof n?.label === "string") : [],
  };
}

/** The names of `a`, then those of `b` that `a` does not have ([{name, label}]). */
const unionNames = (a, b) => [...a, ...b.filter((x) => !a.some((y) => y.name === x.name))];

/**
 * The messages of a conversation that may go to the gateway: not the
 * exchanges the local model answered (`local`), nor their question. It was
 * given the real names and, for the costing, the internal amounts: its answer
 * may quote them. Nor the exchanges the gateway answered with the internal
 * amounts of the costing (`amounts`: the box ticked then), unless the box is
 * ticked now (`amounts`) and the gateway is the same (`gateway`, its address).
 */
export function onlineMessages(messages, { amounts = false, gateway = null } = {}) {
  const left = (m) => m?.local || (m?.amounts && !(amounts && m.gateway === gateway));
  return messages.filter((m, i) => !(left(m) || (m.role !== "assistant" && left(messages[i + 1]))));
}

/** Keep the conversation of a tab; an empty one is forgotten, unless it is a new one about a part (not the part's last one). */
function writeConversation(key, conversation) {
  const text = conversation.messages.length || conversation.part ? JSON.stringify(conversation) : null;
  unsaved.delete(key);
  try {
    if (text === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, text);
  } catch {
    if (text !== null) unsaved.set(key, text);
  }
}

// The block of proposals of an answer of the local model (task "Chiffrage"): closed, or still being written at its end.
const PROPOSALS_BLOCK = /```(?:json)?\s*(\{\s*"propositions"[\s\S]*?\})\s*```/;
const OPEN_BLOCK = /```(?:json)?\s*(\{\s*"propositions"(?![\s\S]*```)[\s\S]*)$/;

/** The block of proposals of an answer when it can be read: {list, start, end}; null otherwise. */
function proposalsBlock(text) {
  const m = PROPOSALS_BLOCK.exec(text) ?? OPEN_BLOCK.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed?.propositions) ? { list: parsed.propositions, start: m.index, end: m.index + m[0].length } : null;
  } catch {
    return null;
  }
}

/**
 * An answer without its block of proposals, shown apart under it: the block
 * read taken out, the text after it kept; one still being written at the end
 * hidden. One that cannot be read stays in the answer, as it was written.
 */
function withoutProposals(text) {
  const s = String(text ?? "");
  const block = proposalsBlock(s);
  if (block) return `${s.slice(0, block.start).trimEnd()}${s.slice(block.end).trim() ? `\n\n${s.slice(block.end).trim()}` : ""}`;
  return PROPOSALS_BLOCK.test(s) ? s : s.replace(/\n*```(?:json)?\s*\{\s*"propositions"(?![\s\S]*```)[\s\S]*$/, "").trimEnd();
}

/**
 * The values an answer of the task "Chiffrage" proposes for the inputs of a
 * piece, as the model wrote them (chiffrage/ai-apply.js reads and checks
 * them): analyse_chiffrage.propositions of an answer of the gateway, the
 * block that ends one of the local model; [] without them.
 */
export function proposalsOf(content) {
  const text = withoutThinking(content);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return proposalsBlock(text)?.list ?? [];
  }
  const list = parsed?.analyse_chiffrage?.propositions;
  return Array.isArray(list) ? list : [];
}

/** An answer of the local model that ends with proposals that cannot be read (JSON not valid). */
export const unreadableProposals = (content) => /```(?:json)?\s*\{\s*"propositions"/.test(withoutThinking(content)) && !proposalsBlock(withoutThinking(content));

/** The text of an answer: the JSON of the structured contract laid out, or the raw text. */
export function formatAnswer(content) {
  const text = withoutProposals(withoutThinking(content));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== "object") return text;
  const list = (title, items) => (Array.isArray(items) && items.length ? `${title} :\n- ${items.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n- ")}` : "");
  // Task "Chiffrage": the reasoning of the model on the traced values, each item citing a key of the trace.
  const a = parsed.analyse_chiffrage;
  const analyse = a && typeof a === "object"
    ? [
      list("Explications", a.explications),
      list("Écarts signalés", a.ecarts_signales?.map?.((e) => (e && typeof e === "object" ? `${e.cle} : ${e.commentaire}` : e))),
      list("Questions", a.questions),
      list("Hypothèses", a.hypotheses),
    ].filter(Boolean).join("\n")
    : "";
  return [
    parsed.conclusion ?? "",
    list("Observations", parsed.observations),
    list("Inférences", parsed.inferences),
    list("Recommandations", parsed.recommendations),
    list("Incertitudes", parsed.uncertainties),
    analyse ? `Analyse du chiffrage :\n${analyse}` : "",
    parsed.needs_human_validation ? "Validation humaine requise." : "",
  ].filter(Boolean).join("\n\n");
}

/** The strings of the part `pick` of a JSON answer, one per line; null when the answer is not JSON. */
function jsonText(content, pick) {
  let parsed = null;
  try {
    parsed = JSON.parse(withoutThinking(content));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const strings = [];
  (function walk(v) {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(pick(parsed));
  return strings.join("\n");
}

/**
 * The part of an answer that is about the costing, whose numbers are checked
 * against the trace: analyse_chiffrage of an answer of the gateway (JSON),
 * else the whole text (the plain text of Ollama).
 */
export function costingText(content) {
  // The proposals apart: their numbers may come from the user's messages (ai-apply.js checks them).
  return jsonText(content, (parsed) => (parsed.analyse_chiffrage ? { ...parsed.analyse_chiffrage, propositions: undefined } : null)) ?? withoutProposals(withoutThinking(content));
}

/** The text of an answer whose numbers are checked against the data sent: every string of its JSON, or its plain text. */
export function answerText(content) {
  return jsonText(content, (parsed) => parsed) ?? withoutThinking(content);
}

/** Under an answer of the gateway: the real names of the labels it writes ([[label, name]], engine/ai-context.js anonymizer). */
const namesLine = (names) => `Noms réels : ${names.map(([label, name]) => `${label} = ${name}`).join(" ; ")}`;

/** Under an answer: how many of its numbers come from none of the data sent (informative). */
export function numbersLabel(unknown) {
  const n = unknown.length;
  return `${n} nombre${n > 1 ? "s ne viennent" : " ne vient"} pas des données envoyées`;
}

/** State of the browser permission for this site to reach applications on this device (Chrome/Edge 142+, Firefox 153+), or null. */
/**
 * The address space of Ollama's address, for the browser's Local Network
 * Access: "loopback" for this computer, "local" for another device of the
 * local network, none for a public address. Chrome and Edge refuse a request
 * whose declared space is not the one its host resolves to.
 */
export function addressSpace(base) {
  const { protocol, hostname } = new URL(base);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1") return "loopback";
  if (/^(10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./.test(host) || /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host) || host.endsWith(".local")) return "local";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return undefined; // a public address
  // A name: Ollama on plain http is on the local network; https is a public service.
  return protocol === "http:" ? "local" : undefined;
}

async function networkPermission(space) {
  for (const name of [space === "local" ? "local-network" : "loopback-network", "local-network-access"]) {
    try {
      const status = await navigator.permissions.query({ name });
      return { name, state: status.state };
    } catch {
      // name unknown to this browser
    }
  }
  return null;
}

/** Why Ollama cannot be used from this page: null when it answers and has the model. */
export async function diagnoseOllama(base, model) {
  const origin = location.origin;
  const space = addressSpace(base);
  const lan = space === "local"; // Ollama on another device of the network (a Jetson, another PC)
  const permission = lan ? "Réseau local" : "Applications sur l'appareil";
  const settings = lan ? "localNetwork" : "loopbackNetwork";
  let response;
  try {
    response = await fetch(`${base}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(8000), ...(space ? { targetAddressSpace: space } : {}) });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      return lan
        ? `Ollama (${base}) ne répond pas : vérifiez que l'appareil est allumé et sur le réseau, et qu'Ollama y tourne (sudo systemctl status ollama).`
        : `Ollama (${base}) ne répond pas : vérifiez qu'il est lancé (icône du lama près de l'horloge).`;
    }
    const state = await networkPermission(space);
    if (state?.state === "denied") {
      return `Le navigateur interdit à ce site d'accéder ${lan ? "aux appareils du réseau local" : "aux applications de ce PC"} (autorisation « ${permission} » refusée).
Edge : ouvrez edge://settings/content/${settings} (Chrome : chrome://settings/content/${settings}), ajoutez ${origin} dans « Autorisé », puis rechargez la page.`;
    }
    return `Ollama est inaccessible depuis cette page (${origin}). Vérifiez, dans l'ordre :
${lan
    ? `1. Ollama tourne sur l'appareil et écoute le réseau (OLLAMA_HOST=0.0.0.0:11434 dans « sudo systemctl edit ollama.service ») : ${base} ouvert dans un nouvel onglet affiche « Ollama is running » ;
2. OLLAMA_ORIGINS, dans ce même fichier, contient ${origin} (origines séparées par des virgules, sans espace ni « / » final), puis sudo systemctl daemon-reload et sudo systemctl restart ollama ;`
    : `1. Ollama est lancé (icône du lama près de l'horloge) : ${base} ouvert dans un nouvel onglet affiche « Ollama is running » ;
2. la variable d'environnement OLLAMA_ORIGINS contient ${origin} (origines séparées par des virgules, sans espace ni « / » final — sinon Ollama ne démarre pas), puis Ollama a été quitté et relancé ;`}
3. le navigateur autorise ce site à accéder ${lan ? "au « Réseau local »" : "aux « Applications sur l'appareil »"} (Edge : edge://settings/content/${settings}) — s'il le demande, cliquez sur Autoriser.
Le détail exact est affiché dans la console du navigateur (F12).`;
  }
  if (response.status === 403) return `Ollama refuse l'origine ${origin} : ajoutez-la à OLLAMA_ORIGINS, puis ${lan ? "redémarrez Ollama (sudo systemctl restart ollama)" : "quittez et relancez Ollama"}.`;
  if (!response.ok) return `Ollama répond par une erreur HTTP ${response.status} sur ${base}/api/tags.`;
  const data = await response.json().catch(() => ({}));
  const names = (data.models ?? []).map((m) => m.name ?? m.model).filter(Boolean);
  const wanted = model.includes(":") ? model : `${model}:latest`;
  if (!names.includes(model) && !names.includes(wanted)) {
    return `Le modèle « ${model} » n'est pas installé dans Ollama${names.length ? ` (installés : ${names.join(", ")})` : ""}. Installez-le avec : ollama pull ${model}`;
  }
  return null;
}

/** The gateway of this deployment: api/ai.js is served with the site on Vercel, not on GitHub Pages (its address is pasted there). */
export function defaultGateway(where = location) {
  return /\.vercel\.app$/.test(where.hostname) ? new URL("/api/ai", where.origin).href : "";
}

/**
 * Which bodies of the part a context holds, without their names (the context
 * may go online): the model answers about them only.
 */
export function selectionOf({ mode, bodies_sent, bodies_in_file }) {
  // Short: it counts in the budget of the context. The whole part needs no note.
  const note = mode === "selected"
    ? "Seul le corps sélectionné est envoyé : réponds sur lui seulement."
    : mode === "checked" ? `Seuls ${bodies_sent} des ${bodies_in_file} corps (les cochés) sont envoyés : réponds sur eux seulement.` : null;
  return { mode, bodies_sent, bodies_in_file, ...(note ? { note } : {}) }; // mode: "selected" (in the list), "checked" or "all"
}

/** Whether an answer is written in Markdown (bold, headings, tables, code): else it is shown as plain text. */
export function isMarkdown(text) {
  return /\*\*[^*\n]+\*\*|^#{1,4} |^\s*\|.*\|\s*$|^```/m.test(String(text ?? ""));
}

/**
 * The simple Markdown of an answer (headings, bold, italics, code, lists,
 * tables, paragraphs) as HTML. Everything is escaped first: no tag or
 * attribute of the answer reaches the page, only the ones written here.
 */
export function markdownToHtml(text) {
  const ITEM = /^(\s*)([-*•]|(\d+)[.)])\s+(.*)$/; // a list item: its indent, its mark, its number, its text
  const indent = (l) => /^\s*/.exec(l)[0].replace(/\t/g, "    ").length; // a tab as four spaces
  const inline = (line) => escapeHtml(line)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```[\w+-]*\s*$/.test(line)) {
      // A fence line only (```, ```js): a line that starts with ``` and goes on is text, its code inline.
      flush();
      const code = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...rest] = body;
      // Only rows of dashes or pipes (a header line without its leading pipe above): text, not a table.
      if (!head) out.push(`<p>${rows.map(inline).join("<br>")}</p>`);
      else out.push(`<table class="ai-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (ITEM.test(line)) {
      flush();
      // One list per kind: a numbered list after bullets starts a list of its own. The lines indented
      // under an item (a list of its own, at any depth) are laid out in it; blank lines between items
      // (a loose list) keep the list open.
      const base = indent(line);
      const ordered = !!ITEM.exec(line)[3];
      const items = []; // {lines: its text, kids: the lines under it, start}
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = ITEM.exec(lines[j] ?? "");
          if (next && (indent(lines[j]) >= base + 2 || !!next[3] === ordered)) {
            i = j - 1;
            continue;
          }
          break;
        }
        const m = ITEM.exec(l);
        const last = items[items.length - 1];
        if (indent(l) >= base + 2 && last && (m || last.kids.length)) last.kids.push(l);
        else if (m && indent(l) < base + 2 && !!m[3] === ordered) items.push({ lines: [m[4]], kids: [], start: Number(m[3] ?? 1) });
        else if (!m && indent(l) >= base + 2 && last) last.lines.push(l.trim());
        else break;
      }
      i--;
      const lis = items.map((it) => `<li>${it.lines.map(inline).join("<br>")}${it.kids.length ? markdownToHtml(it.kids.join("\n")) : ""}</li>`).join("");
      out.push(ordered ? `<ol${items[0].start !== 1 ? ` start="${items[0].start}"` : ""}>${lis}</ol>` : `<ul>${lis}</ul>`);
    } else if (/^#{1,4} /.test(line)) {
      flush();
      out.push(`<p class="ai-h">${inline(line.replace(/^#{1,4} /, ""))}</p>`);
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out.join("");
}

/** An answer in its bubble: laid out when written in Markdown, else as plain text (line breaks kept). */
function setAnswer(el, text) {
  let html = null;
  try {
    html = isMarkdown(text) ? markdownToHtml(text) : null;
  } catch (err) {
    console.warn("Answer not laid out", err); // shown as it was written: never lost
  }
  el.classList.toggle("ai-md", html != null);
  if (html != null) el.innerHTML = html;
  else el.textContent = text;
}

/** Where an answer of the gateway comes from: "Groq · openai/gpt-oss-120b". */
export function gatewayLabel({ provider, model } = {}) {
  return [provider, model].filter(Boolean).join(" · ");
}

const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

/**
 * The questions left today, from the tokens: those of a day (`quota`
 * tokens_limit_day), less those of the requests already made today with the
 * key of the gateway, from any PC (requests_limit_day − requests_remaining_day,
 * at the mean tokens of a request), at the mean tokens of a question of this
 * browser (`tokens`: {questions, all}, the total tokens of its latest answers);
 * never more than the requests left. Null when the provider or the gateway
 * does not tell enough.
 */
export function questionsLeft(quota, tokens) {
  const { tokens_limit_day: perDay, requests_limit_day: limit, requests_remaining_day: remaining } = quota ?? {};
  const questions = (tokens?.questions ?? []).filter((n) => n > 0);
  const all = (tokens?.all ?? []).filter((n) => n > 0);
  if (!(perDay > 0 && Number.isFinite(limit) && Number.isFinite(remaining) && (questions.length || all.length))) return null;
  const perQuestion = Math.round(mean(questions.length ? questions : all));
  const perRequest = Math.round(mean(all.length ? all : questions));
  const requests = Math.max(0, limit - remaining);
  const used = requests * perRequest;
  const left = Math.max(0, Math.min(remaining, Math.floor((perDay - used) / perQuestion)));
  return { left, perQuestion, measured: questions.length || all.length, requests, used, perDay };
}

/**
 * What is left of the free quota of the day: "≈ 36 questions restantes
 * aujourd'hui" from the tokens (questionsLeft), else from the requests left
 * "998 questions restantes aujourd'hui"; "" when the provider does not say.
 */
export function quotaLabel(quota, tokens) {
  const estimate = questionsLeft(quota, tokens);
  const left = estimate ? estimate.left : quota?.requests_remaining_day;
  return Number.isFinite(left) ? `${estimate ? "≈ " : ""}${left.toLocaleString("fr-FR")} question${left > 1 ? "s restantes" : " restante"} aujourd'hui` : "";
}

/** The tokens of the latest answers of the gateway kept in this browser: {questions, all}. */
function readTokens() {
  try {
    const kept = JSON.parse(store.get(localStorage, KEYS.tokens) || "null");
    return { questions: Array.isArray(kept?.questions) ? kept.questions : [], all: Array.isArray(kept?.all) ? kept.all : [] };
  } catch {
    return { questions: [], all: [] };
  }
}

/**
 * Keeps what is left of the free quota of a gateway answer, for the badge of
 * the IA page (also after the Chiffrage page asked), and the tokens it took:
 * those of the latest 20 questions of the IA page (`question`), of the latest
 * 50 requests of any kind.
 */
function noteQuota({ provider, quota, usage } = {}, question = false) {
  const total = usage?.total_tokens;
  if (typeof localStorage !== "undefined" && Number.isFinite(total) && total > 0) {
    const kept = readTokens();
    store.set(localStorage, KEYS.tokens, JSON.stringify({ questions: question ? [...kept.questions, total].slice(-20) : kept.questions.slice(-20), all: [...kept.all, total].slice(-50) }));
  }
  if (!Number.isFinite(quota?.requests_remaining_day)) return;
  // For every tab of this browser (the quota is the account's, whatever the tab that asked): the latest answer's.
  const kept = { provider: provider ?? null, ...quota, at: new Date().toISOString() };
  if (typeof localStorage !== "undefined") store.set(localStorage, KEYS.quota, JSON.stringify(kept));
  globalThis.dispatchEvent?.(new CustomEvent(QUOTA_EVENT, { detail: kept })); // the page, not the unit tests
}

/**
 * A request to the gateway `url` with the access code `code`: its JSON
 * answer, or an Error with its message (in French), the HTTP status, whether
 * an access code is needed (codeRequired) and when to ask again (retryAfter, s).
 */
async function fetchGateway(url, code, init = {}) {
  if (!url) throw new Error(`Renseignez l'adresse de la passerelle : collez son adresse Vercel (${GATEWAY_EXAMPLE}, voir api/README.md), ou choisissez « Ollama local ».`);
  let response;
  try {
    response = await fetch(url, { cache: "no-store", ...init, headers: { Accept: "application/json", ...init.headers, ...(code ? { "X-Reader3D-Code": code } : {}) } });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(`La passerelle est injoignable (${url}) : vérifiez son adresse (${GATEWAY_EXAMPLE}) et qu'elle autorise cette page, ${location.origin} (READER3D_ALLOWED_ORIGINS dans Vercel).`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((typeof data.error === "string" ? data.error : data.error?.message) || `La passerelle répond par une erreur HTTP ${response.status}.`);
    error.codeRequired = !!data.access_code_required;
    error.status = response.status;
    // An answer cut at the length allowed (AI_MAX_TOKENS): one that cannot be used.
    if (data.truncated) error.truncated = true;
    // When to ask again after a refusal for quota (s), as the gateway tells it.
    if (Number.isFinite(data.retry_after)) error.retryAfter = data.retry_after;
    throw error;
  }
  return data;
}

/** The base address of Ollama from what was typed (an old /v1/chat/completions address is accepted). */
function ollamaBase(value) {
  const text = (value || OLLAMA_URL).trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).origin;
  } catch {
    throw new Error(`Adresse d'Ollama invalide : « ${text} » (exemple : ${OLLAMA_URL}).`);
  }
}

/**
 * Window (tokens) asked of Ollama for a prompt of this many characters, with
 * room for the answer. Only two sizes: Ollama reloads the whole model when
 * the window changes from one question to the next, and it can reuse what it
 * has already read only when it does not.
 */
function contextWindow(chars, reserve = 2048) {
  return Math.ceil(chars / 3) + reserve <= 8192 ? 8192 : MAX_WINDOW;
}

const seconds = (ns) => Math.round((ns ?? 0) / 1e9);

// Rules of the task "Chiffrage" for the local model: it explains the traced values, and may propose values of the
// inputs of a piece (as the gateway, api/ai.js PROPOSAL_RULES), in a JSON block that ends its answer.
const COSTING_RULES = `Tâche « Chiffrage » : le contexte contient costing_trace, les valeurs du devis en cours (devis, pièces, îlots classés), chacune avec sa trace : valeur, unité, source, autorité, confiance, écart à la tendance, autres sources, validation requise ; et les alertes. Tu ne les modifies pas toi-même : ta réponse est un raisonnement.
Explique les valeurs et leurs sources, signale les écarts et les valeurs à valider, pose les questions utiles, énonce tes hypothèses. Cite la clé de chaque valeur dont tu parles (par exemple piece.prix.vente).
N'invente jamais de prix, de taux, de temps de cycle ni de nombre de noyaux. Ne cite que des nombres présents dans costing_trace, tels quels ou arrondis, sans en calculer de nouveaux : une réponse qui contient un autre nombre est marquée « non vérifiée ».
Propositions : quand l'utilisateur demande de changer une saisie d'une pièce ou en donne la bonne valeur, ou quand costing_trace ou l'analyse de la pièce donnent une valeur plus juste d'une saisie, termine ta réponse par un seul bloc \`\`\`json {"propositions": [{"piece": "nom de la pièce dans costing_trace.pieces", "cle": "piece.poids", "valeur": 1.35, "unite": "kg", "source": "question", "justification": "une phrase"}]} \`\`\` ; cle : piece.poids, piece.toileMini, piece.epaisseurMax, piece.module, piece.dimMax, piece.ilot, piece.finition, piece.miseAuMille, piece.empreintes, piece.cycle, piece.mode, piece.tth, piece.tthMode, piece.noyaux, piece.tribo, piece.redressage, piece.outillage.tiroirs ou piece.outillage.complexite ; valeur dans l'unité de la saisie (kg, mm, s) ; source : question (le nombre que l'utilisateur a écrit), trace (la valeur de cette même clé pour cette pièce dans costing_trace) ou analyse_3d (la cote mesurée de la pièce : plus grande dimension, module, épaisseurs) ; un nombre absent de la source indiquée est refusé. Jamais un prix, un taux, une marge, un paramètre ni un nombre que tu calcules : seulement un nombre écrit par l'utilisateur, dans costing_trace ou dans l'analyse de la pièce. Une personne accepte chaque proposition avant qu'elle soit appliquée. Sans proposition, pas de bloc.
Si costing_trace est null, aucun classeur de chiffrage n'est importé : dis-le et propose de l'importer dans la page Chiffrage.`;

// As the gateway's text tasks (api/ai.js TEXT_RULES): not in the task « Chiffrage », which proposes values in its own block.
const PROPOSALS = "Paramètres de fonderie et de chiffrage (nombre de noyaux, de tiroirs, de chapes, îlot de coulée, coefficient de difficulté…) : quand on te les demande, propose-les en fondeur à partir des features et du criblage fonderie du contexte. Présente chaque valeur comme « Proposition IA — à valider », avec sa justification (identifiants des features) et ta confiance. N'invente jamais de prix, de taux horaires ni de mesures.";

/** Instructions of the local model: plain French text, laid out only when the question is about the part. */
function systemPrompt(model, where = "sur ce PC", costing = false) {
  return `Tu es l'assistant d'ingénierie de 3D Reader, pour une fonderie d'aluminium. Tu es un modèle de langage (${model}) qui tourne en local ${where} avec Ollama : aucune donnée n'est envoyée sur Internet.
Réponds en français, en texte (jamais de JSON ; gras, listes et petits tableaux Markdown permis), de façon claire et concise.
Pour une conversation ou une question générale (fonderie, procédés, chiffrage, méthode), réponds directement et brièvement.
Pour une question sur la pièce, organise la réponse en courtes sections, celles qui sont utiles seulement : « Conclusion », « Mesuré » (valeurs du contexte, avec leurs identifiants), « Déduit », « Recommandations », « À valider ».
N'utilise que le contexte fourni (analyse géométrique et sémantique de la pièce, connaissances fonderie). N'invente jamais de dimensions, de paramètres de procédé, de propriétés matière, de prix, de taux, de temps de cycle, ${costing ? "de nombre de noyaux, " : ""}de probabilités de défaut, d'attaques, de masselottes ni de résultats de simulation.
Pour la fonderie, cite les identifiants de sources fournis et dis clairement quand une conclusion demande une simulation de remplissage/solidification ou une validation fonderie.
Ce contexte est l'analyse de la pièce par 3D Reader (features détectées avec leurs identifiants, criblage fonderie, pistes de fabrication) : ne renvoie jamais vers un module ou un outil de 3D Reader que tu supposes. S'il manque du détail (champ "summary_only" ou "compaction"), dis-le et indique l'analyse à choisir dans la page IA : « Features », « Fabrication », « DFM » ou « Chiffrage ».
Champ "selection" : seuls ces corps de la pièce sont envoyés ; réponds sur eux seulement.
Si aucun modèle 3D n'est chargé (champ "no_model_loaded"), ne prétends pas connaître une pièce et propose d'ouvrir le modèle si la question en dépend.
${costing ? COSTING_RULES : PROPOSALS}`;
}

/** The answer without a model's hidden reasoning (<think>…</think>, written by older Ollama versions). */
function withoutThinking(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
}

/** That reasoning, when the model writes it in the answer. */
function inlineThinking(text) {
  return /<think>([\s\S]*?)(<\/think>|$)/.exec(String(text ?? ""))?.[1].trim() ?? "";
}

/**
 * The AI chosen on the IA page, as this browser keeps it (the fields are saved
 * as soon as they are changed): {provider ("openai": the gateway, "ollama"),
 * gateway: {url, code, model}, ollama: {base, model}, anonymize, fallback}.
 */
export function savedAI() {
  const savedGateway = store.get(localStorage, KEYS.gateway);
  return {
    // As the page: the gateway (Groq) unless Ollama was chosen ("openai_compatible" of older versions is Ollama).
    provider: ["ollama", "openai_compatible"].includes(store.get(localStorage, KEYS.provider)) ? "ollama" : "openai",
    gateway: {
      url: savedGateway && !/:11434|\/api\/analyze/.test(savedGateway) ? savedGateway : defaultGateway(),
      code: store.get(localStorage, KEYS.code) || "",
      model: store.get(localStorage, `${KEYS.model}.openai`) || "",
    },
    ollama: { base: store.get(localStorage, KEYS.ollama) || OLLAMA_URL, model: store.get(localStorage, `${KEYS.model}.ollama`) || OLLAMA_MODEL },
    anonymize: store.get(localStorage, KEYS.anonymize) !== "0",
    fallback: store.get(localStorage, KEYS.fallback) !== "0",
  };
}

/** Ask Ollama (`ollama`: {base, model}) for a JSON answer to `question` on the data `context`, with the instructions `system`. */
async function askOllamaJSON({ system, question, context }, { base, model }, signal) {
  const space = addressSpace(base);
  const messages = [{ role: "system", content: system }, { role: "user", content: `${question}\n\nDONNÉES (JSON) :\n${JSON.stringify(context)}` }];
  // The JSON of the answer, without the reasoning before it (much slower on a CPU); the schema is in the instructions.
  const body = { model, messages, stream: false, format: "json", think: false, keep_alive: "15m", options: { num_ctx: contextWindow(JSON.stringify(messages).length), temperature: 0.2 } };
  const post = () => fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    ...(space ? { targetAddressSpace: space } : {}),
  }).catch((err) => {
    if (err?.name === "AbortError") throw err;
    throw new Error("La connexion à Ollama a été coupée. Ollama s'est peut-être arrêté (mémoire insuffisante pour le modèle ?) : vérifiez qu'il tourne, puis réessayez.");
  });
  let response = await post();
  if (response.status === 400) {
    // Models (or Ollama versions) without the thinking switch refuse "think".
    const text = await response.text();
    if (!/think/i.test(text)) throw new Error(`Ollama : ${text}`);
    delete body.think;
    response = await post();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Ollama : ${data.error || `HTTP ${response.status}`}`);
  return data.message?.content ?? "";
}

/**
 * A JSON answer to the task `task` from the AI chosen on the IA page
 * (savedAI), outside its conversations: the estimate of the cycle time of the
 * Chiffrage page (chiffrage/ai-cycle.js). `build({budget, local, anonymize,
 * model})` gives what is sent within `budget` characters: {context, question,
 * system (the instructions of the local model `model`)}; the gateway has its
 * own instructions for the task. When the gateway refuses for its free quota,
 * Ollama answers, if it can and the box "Repli automatique" is ticked (or
 * `fallback`, when given: false for the backtest of the history, whose
 * answers must all come from the same AI), as for the questions of the IA
 * page. Resolves to {output, provider, model, quota, usage (tokens of the
 * gateway's answer), sent (what was built for the AI that answered), local,
 * notice}. An access code refused: where to type it (the page that asks has no
 * field for it), and its field shown at once on the IA page.
 */
export async function askJSON(task, build, { signal, fallback } = {}) {
  const ai = savedAI();
  // Ollama, its address and model of the IA page; `quota`: the refusal of the gateway it answers in place of, told when it cannot.
  const askLocal = async (ollama, quota = null) => {
    let base;
    let problem;
    try {
      base = ollamaBase(ollama.base);
      problem = await diagnoseOllama(base, ollama.model);
    } catch (err) {
      problem = err.message;
    }
    if (problem) throw quota ?? new Error(problem);
    const sent = build({ budget: LOCAL_CONTEXT_CHARS, local: true, anonymize: false, model: ollama.model });
    const output = await askOllamaJSON(sent, { base, model: ollama.model }, signal);
    return { output, provider: "Ollama", model: ollama.model, quota: null, usage: null, sent, local: true };
  };
  if (ai.provider === "ollama") return askLocal(ai.ollama);
  const { url, code, model } = ai.gateway;
  if (!url) throw new Error(`Aucune passerelle IA renseignée : dans la page IA / analyse, collez l'adresse Vercel de la passerelle (${GATEWAY_EXAMPLE}) ou choisissez « Ollama local ».`);
  const codeAsked = (err) => {
    if (!err?.codeRequired) return err;
    store.set(localStorage, KEYS.codeRequired, "1");
    const where = "dans la page IA / analyse (champ « Code d'accès »), puis relancez.";
    return Object.assign(new Error(code ? `Code d'accès de la passerelle incorrect : corrigez-le ${where}` : `Code d'accès de la passerelle requis : saisissez-le ${where}`), { status: err.status, codeRequired: true });
  };
  // The budget of the gateway; an older gateway, without its configuration: the default one.
  const info = await fetchGateway(url, code, { signal }).catch((err) => {
    if (err?.name === "AbortError") throw err;
    if (err?.codeRequired) store.set(localStorage, KEYS.codeRequired, "1");
    return null; // the question tells what is wrong
  });
  if (info) store.set(localStorage, KEYS.codeRequired, info.access_code_required ? "1" : null);
  const sent = build({ budget: info?.context_chars > 0 ? info.context_chars : GATEWAY_CONTEXT_CHARS, local: false, anonymize: ai.anonymize });
  try {
    const data = await fetchGateway(url, code, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gateway_schema_version: "1.0", task, model: model || undefined, context: sent.context, messages: [{ role: "user", content: sent.question }] }),
      signal,
    });
    const output = data.output ?? data.text;
    if (typeof output !== "string" || !output.trim()) throw new Error("La passerelle a renvoyé une réponse vide : réessayez.");
    noteQuota(data);
    return { output, provider: data.provider ?? null, model: data.model ?? null, quota: data.quota ?? null, usage: data.usage ?? null, sent, local: false };
  } catch (err) {
    // The free quota reached: the local model, when it answers (its own address and model).
    if (err?.name === "AbortError" || !QUOTA_STATUSES.includes(err?.status) || !(fallback ?? ai.fallback)) throw codeAsked(err);
    return { ...(await askLocal(ai.ollama, err)), notice: `Quota en ligne atteint : réponse du modèle local (${ai.ollama.model})` };
  }
}

export function mount({ page, reader }) {
  if (!page) return { show() {} };
  page.innerHTML = `
    <div class="ai-page">
      <div class="ai-main">
      <section class="card ai-settings">
        <div class="card-head">
          <h2>IA / analyse</h2>
          <span id="ai-quota" class="ai-quota" hidden></span>
          <span id="ai-status" class="muted small" role="status">Non connecté</span>
        </div>
        <div class="ai-row">
          <label class="field">Fournisseur
            <select id="ai-provider">${PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          </label>
          <label class="field ai-url-field"><span id="ai-url-label">Adresse</span>
            <input id="ai-url" type="url" spellcheck="false">
          </label>
          <label class="field">Modèle
            <input id="ai-model" spellcheck="false" list="ai-models">
            <datalist id="ai-models"></datalist>
          </label>
          <label class="field" id="ai-code-field" hidden title="Code demandé par la passerelle (variable READER3D_ACCESS_CODE dans Vercel), gardé dans ce navigateur.">Code d'accès
            <input id="ai-code" type="password" autocomplete="off" spellcheck="false">
          </label>
          <label class="check" id="ai-think-field" title="Le modèle raisonne avant de répondre : réponses plus sûres, mais bien plus lentes sur un PC sans carte graphique. Le raisonnement s'affiche sous la réponse."><input type="checkbox" id="ai-think"> Réflexion du modèle (plus lent)</label>
          <label class="check" id="ai-anon-field" title="Avant l'envoi à la passerelle, dans toutes les tâches, le nom du fichier, les noms des corps, la référence et la désignation de la pièce, les noms du client et des fichiers du chiffrage sont remplacés par « Pièce », « Corps 1 »…, dans la question et la conversation aussi. Le modèle local (Ollama) reçoit toujours les vrais noms : rien ne quitte le site, et ses réponses ne sont jamais envoyées en ligne."><input type="checkbox" id="ai-anon"> Anonymiser les noms envoyés en ligne</label>
          <label class="check" id="ai-fallback-field" title="Quand le quota gratuit de la passerelle est atteint, la question est posée au modèle local (Ollama, avec l'adresse et le modèle choisis pour lui), s'il répond."><input type="checkbox" id="ai-fallback"> Repli automatique sur le modèle local</label>
          <label class="check" id="ai-amounts-field" hidden title="Sans cette case, la passerelle reçoit la trace du chiffrage sans les montants internes (taux, coûts, prix, marges, pertes au feu, TRS) : leurs sources et leurs écarts relatifs seulement. Le modèle local (Ollama) reçoit toujours la trace complète, rien ne quitte le site."><input type="checkbox" id="ai-amounts"> Envoyer les montants internes du chiffrage à la passerelle</label>
          <button id="ai-test" class="btn" type="button">Tester la connexion</button>
        </div>
        <div class="ai-row ai-tasks" role="group" aria-label="Type d'analyse">
          ${TASKS.map(([v, l, help, question]) => `<button type="button" class="small ai-task" data-task="${v}" aria-pressed="${v === "general"}" title="${escapeHtml(`${help} Question posée : « ${question} »`)}">${l}</button>`).join("")}
        </div>
        <p id="ai-task-help" class="ai-scope">${escapeHtml(`${TASKS[0][2]} ${TASK_NOTE}`)}</p>
        <p id="ai-scope" class="ai-scope"></p>
      </section>

      <section class="card ai-convo">
        <div id="ai-chat" class="ai-chat" aria-live="polite"></div>
        <form id="ai-form" class="ai-form">
          <div id="ai-suggest" class="ai-suggest" hidden><button id="ai-suggest-apply" type="button" class="small ai-suggest-btn" aria-describedby="ai-suggest-help">${APPLY_TEXT}</button><span id="ai-suggest-help" class="ai-scope"></span></div>
          <textarea id="ai-input" rows="4" placeholder="Posez une question sur la pièce, les features, la fabrication ou le coût… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea>
          <div class="ai-actions">
            <button id="ai-send" class="btn primary" type="submit">Envoyer</button>
            <button id="ai-cancel" class="btn" type="button" hidden>Annuler</button>
            <button id="ai-clear" class="btn small" type="button">Nouvelle conversation</button>
          </div>
        </form>
      </section>
      </div>
      <aside class="card ai-history" aria-label="Historique des discussions">
        <div class="ai-hist-tabs" role="tablist" aria-label="Historique">
          <button type="button" role="tab" id="ai-hist-tab-local" class="ai-hist-tab" data-history="local" aria-controls="ai-hist-local">Historique local</button>
          <button type="button" role="tab" id="ai-hist-tab-reseau" class="ai-hist-tab" data-history="reseau" aria-controls="ai-hist-reseau">Historique réseau</button>
        </div>
        <div id="ai-hist-local" class="ai-hist-panel" role="tabpanel" aria-labelledby="ai-hist-tab-local">
          <p class="ai-hist-note">Les discussions gardées dans ce navigateur, sur ce PC. Une pièce ouverte à nouveau retrouve sa dernière discussion.</p>
          <ul id="ai-hist-list-local" class="ai-hist-list"></ul>
        </div>
        <div id="ai-hist-reseau" class="ai-hist-panel" role="tabpanel" aria-labelledby="ai-hist-tab-reseau" hidden>
          <div id="ai-hist-folder" class="ai-hist-folder"></div>
          <ul id="ai-hist-list-reseau" class="ai-hist-list"></ul>
        </div>
      </aside>
    </div>`;

  const $ = (id) => page.querySelector("#" + id);
  let task = "general";
  let busy = null; // AbortController of the question in progress
  let suggestion = null; // the reply suggested after values proposed: {key, message (id of the answer), target: {tab, file}, pieces: [{key, name, proposals, changes}]}
  let suggesting = 0; // only the latest evaluation of it is used
  const placeholder = $("ai-input").placeholder; // the box's own, in place of the suggestion
  let shown = null; // {key, file}: the conversation on screen, the one of the tab shown and of its part
  let pending = null; // the question in progress: {key, nodes (its two messages, shown again with their conversation), dropped}
  // The history on the right (ai-history.js): the list shown, the network folder ({handle, name, permission}),
  // what went wrong with it last, the conversations read in it, the latest reading of the lists.
  let historyTab = store.get(localStorage, KEYS.historyTab) === "reseau" ? "reseau" : "local";
  let network = null;
  let networkNote = "";
  let networkList = [];
  let networkBehind = true; // conversations of this PC may not be in the folder yet (written at the first write that works)
  let historyRead = 0;
  // The shared folder chosen or forgotten (here or in Paramètres): read again, what this PC has written there anew.
  document.addEventListener(archives.FOLDER_CHANGED, () => {
    networkList = [];
    networkNote = "";
    networkBehind = true;
  });

  const provider = () => $("ai-provider").value;
  const isLocal = () => provider() === "ollama";
  // The gateway asks for an access code: as it said last, here or to the Chiffrage page (askJSON).
  let codeRequired = store.get(localStorage, KEYS.codeRequired) === "1";
  let gatewayInfo = null; // {key, data}: the configuration the gateway gave, for its address and code
  const gatewayKey = () => `${$("ai-url").value.trim()}\n${$("ai-code").value.trim()}`;

  /** The access code field: shown when the gateway asks for one, or when one is kept. */
  function showCode(required = codeRequired) {
    codeRequired = !!required;
    store.set(localStorage, KEYS.codeRequired, codeRequired ? "1" : null);
    $("ai-code-field").hidden = isLocal() || !(codeRequired || $("ai-code").value);
  }

  /**
   * The field « Modèle » of the gateway, once it gave its configuration: the
   * models it lists (AI_MODELS) to choose from; none, the model is fixed by
   * the gateway (AI_MODEL) and the field disabled, a model typed there being
   * ignored.
   */
  function showModels() {
    const data = !isLocal() && gatewayInfo?.key === gatewayKey() ? gatewayInfo.data : null;
    const models = Array.isArray(data?.models) ? data.models.filter((m) => typeof m === "string") : [];
    const fixed = !!data && !models.length;
    $("ai-model").disabled = fixed;
    if (fixed) {
      $("ai-model").value = "";
      store.set(localStorage, `${KEYS.model}.openai`, null);
    }
    $("ai-models").replaceChildren(...models.map((m) => Object.assign(document.createElement("option"), { value: m })));
    $("ai-model").placeholder = isLocal() ? OLLAMA_MODEL : !data?.model ? "modèle par défaut de la passerelle" : `${data.model} (${fixed ? "fixé par la passerelle" : "par défaut"})`;
    $("ai-model").title = !data ? "" : fixed
      ? "Modèle fixé par la passerelle (variable AI_MODEL dans Vercel). Pour en proposer d'autres ici, ajoutez la variable AI_MODELS."
      : `Modèles proposés par la passerelle (variable AI_MODELS) : ${models.join(", ")}. Un autre modèle est ignoré.`;
  }

  function showProvider() {
    const local = isLocal();
    $("ai-url-label").textContent = local ? "Adresse d'Ollama" : "Adresse de la passerelle";
    const savedGateway = store.get(localStorage, KEYS.gateway);
    // Older versions stored the Ollama address, or the Vercel analysis API, as the gateway.
    const gateway = savedGateway && !/:11434|\/api\/analyze/.test(savedGateway) ? savedGateway : defaultGateway();
    $("ai-url").value = local ? store.get(localStorage, KEYS.ollama) || OLLAMA_URL : gateway;
    $("ai-url").placeholder = local ? OLLAMA_URL : `Collez l'adresse Vercel : ${GATEWAY_EXAMPLE}`;
    const savedModel = store.get(localStorage, `${KEYS.model}.${provider()}`);
    $("ai-model").value = savedModel || (local ? OLLAMA_MODEL : "");
    showModels();
    $("ai-think-field").hidden = !local;
    $("ai-anon-field").hidden = local;
    $("ai-fallback-field").hidden = local;
    $("ai-amounts-field").hidden = local || task !== "costing";
    showCode();
    showQuota();
  }

  /** The badge of what is left of the free quota of the gateway, from its last answer (hidden for Ollama). */
  function showQuota() {
    let kept = null;
    try {
      kept = JSON.parse(store.get(localStorage, KEYS.quota) || "null");
    } catch {
      kept = null;
    }
    // A day old: the quota of the day has been given back since.
    const at = Date.parse(kept?.at ?? "");
    if (Number.isFinite(at) && Date.now() - at > 24 * 3600 * 1000) kept = null;
    const tokens = readTokens();
    const text = isLocal() ? "" : quotaLabel(kept, tokens);
    $("ai-quota").hidden = !text;
    $("ai-quota").textContent = text;
    const limit = kept?.requests_limit_day;
    const when = Number.isFinite(at) ? new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    const fr = (n) => n.toLocaleString("fr-FR");
    const plural = (n, word) => `${fr(n)} ${word}${n > 1 ? "s" : ""}`;
    const estimate = questionsLeft(kept, tokens);
    const perMinute = estimate && kept.tokens_limit_minute > 0 ? Math.max(1, Math.floor(kept.tokens_limit_minute / estimate.perQuestion)) : 0;
    const of = kept?.provider ? ` de ${kept.provider}` : "";
    $("ai-quota").title = !text
      ? ""
      : estimate
        ? `Estimation d'après la dernière réponse${when ? ` (${when})` : ""} : ${fr(estimate.perDay)} tokens par jour${of} ; une question en prend ${fr(estimate.perQuestion)} en moyenne (${plural(estimate.measured, "réponse")} de ce navigateur) ; ${plural(estimate.requests, "requête")} déjà faite${estimate.requests > 1 ? "s" : ""} aujourd'hui avec la clé de la passerelle, depuis tous les PC (≈ ${fr(estimate.used)} tokens) ; ${plural(kept.requests_remaining_day, "requête")} restante${kept.requests_remaining_day > 1 ? "s" : ""}${Number.isFinite(limit) ? ` sur ${fr(limit)}` : ""}.${perMinute ? ` Au plus ${plural(perMinute, "question")} par minute (${fr(kept.tokens_limit_minute)} tokens par minute).` : ""}`
        : `Quota gratuit${of} : ${text}${Number.isFinite(limit) ? ` sur ${fr(limit)}` : ""}, d'après sa dernière réponse${when ? ` (${when})` : ""}, dans n'importe quel onglet de ce navigateur. Les questions posées depuis un autre PC ne comptent qu'à la réponse suivante.`;
  }
  window.addEventListener(QUOTA_EVENT, showQuota);
  // An answer in another tab of this browser: its quota, here too.
  window.addEventListener("storage", (event) => {
    if (event.key === KEYS.quota || event.key === KEYS.tokens) showQuota();
  });
  {
    $("ai-code").value = store.get(localStorage, KEYS.code) || "";
    const saved = store.get(localStorage, KEYS.provider);
    // Nothing chosen yet: the gateway (Groq). Older versions stored "openai_compatible" for Ollama.
    $("ai-provider").value = saved === "openai_compatible" || saved === "ollama" ? "ollama" : "openai";
    showProvider();
    $("ai-think").checked = store.get(localStorage, KEYS.think) === "1";
    // Anonymised names and the fallback on the local model: on unless unticked.
    $("ai-anon").checked = store.get(localStorage, KEYS.anonymize) !== "0";
    $("ai-fallback").checked = store.get(localStorage, KEYS.fallback) !== "0";
    // Consent to send the internal amounts: kept for this browser tab only (sessionStorage), never for good.
    $("ai-amounts").checked = store.get(sessionStorage, KEYS.amounts) === "1";
  }

  /** A message of the conversation; an answer of the task "Chiffrage" (costing) under its label. */
  function bubble(role, text = "", costing = false) {
    const box = document.createElement("div");
    box.className = `ai-msg ${role === "user" ? "ai-user" : role === "error" ? "ai-error" : "ai-assistant"}`;
    const who = document.createElement("strong");
    who.textContent = role === "user" ? "Vous" : role === "error" ? "Erreur" : "IA";
    const body = document.createElement("div");
    body.className = "ai-text";
    body.textContent = text;
    box.append(who);
    if (costing) {
      const label = document.createElement("div");
      label.className = "ai-label";
      label.textContent = COSTING_LABEL;
      box.append(label);
    }
    box.append(body);
    $("ai-chat").append(box);
    toEnd(true);
    return body;
  }

  // As a chat: the conversation shows its last message, unless one scrolled up to read (then it stays there).
  let pinned = true;
  $("ai-chat").addEventListener("scroll", () => {
    const chat = $("ai-chat");
    pinned = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  });
  /** The last message in view (`force`: a question asked, a conversation shown: whatever was read). */
  function toEnd(force = false) {
    if (force) pinned = true;
    if (!pinned) return;
    const chat = $("ai-chat");
    chat.scrollTop = chat.scrollHeight;
  }

  /** A line of an answer besides its text: before it (`before`), else at the end of its message. */
  function line(body, className, text, before = false) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    if (before) body.before(el);
    else body.parentElement.append(el);
    return el;
  }

  /** Under the label of a costing answer: whether every number it cites is in the trace sent (chiffrage/ai-trace.js checkNumbers). */
  function showCheck(body, check) {
    const n = check.inconnus.length;
    line(body, `ai-check ${check.verifiee ? "ok" : "bad"}`, check.verifiee
      ? check.nombres ? "Vérifiée : chaque nombre cité figure dans la trace du chiffrage." : "Aucun nombre cité."
      : `Réponse non vérifiée : ${n > 1 ? `${n} nombres absents` : "un nombre absent"} de la trace du chiffrage (${check.inconnus.join(" ; ")}).`, true);
  }

  /**
   * The lines kept with an answer: its costing check, the numbers that come
   * from none of the data sent, the real names of the labels it writes.
   */
  function decorate(body, m) {
    if (Array.isArray(m.costing?.inconnus)) showCheck(body, m.costing);
    if (Array.isArray(m.proposals) && m.proposals.length) showProposals(body, m.proposals);
    if (m.application && !m.application.undone) {
      // Its undo, until done (a later message says so).
      const conversation = shown ? readConversation(shown.key) : null;
      const undone = (conversation?.messages ?? []).some((x) => x.application?.undone && x.application.message === m.application.message);
      if (!undone) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "small ai-undo-apply";
        button.dataset.message = m.application.message;
        button.textContent = "Annuler l'application";
        body.append(button);
      }
    }
    if (Array.isArray(m.numbers) && m.numbers.length) line(body, "ai-numbers", numbersLabel(m.numbers)).title = m.numbers.join(" ; ");
    if (Array.isArray(m.names) && m.names.length) line(body, "ai-names", namesLine(m.names));
  }

  /** Under a costing answer: the values it proposes for the inputs of a piece, those that cannot be applied with why. */
  function showProposals(body, proposals) {
    const box = document.createElement("div");
    box.className = "ai-proposals";
    const title = document.createElement("strong");
    title.textContent = "Saisies proposées pour le chiffrage (appliquées seulement avec votre accord) :";
    const list = document.createElement("ul");
    const from = { question: "votre message", trace: "trace du chiffrage", analyse_3d: "analyse de la pièce" };
    for (const p of proposals) {
      const li = document.createElement("li");
      const label = PROPOSAL_FIELDS[p.cle]?.label ?? p.cle;
      li.textContent = `${label}${p.piece ? ` de « ${p.piece} »` : ""} : ${valueLabel(p.valeur, p.unite)}${p.source ? ` (${from[p.source] ?? p.source})` : ""}${p.justification ? ` — ${p.justification}` : ""}${p.refus ? ` — non applicable : ${p.refus}` : ""}`;
      if (p.refus) li.className = "refused";
      list.append(li);
    }
    box.append(title, list);
    body.append(box);
  }

  /** A message kept in a conversation, on screen. */
  function showMessage(m) {
    if (m.role !== "assistant") return bubble("user", m.content);
    const body = bubble("assistant", "", !!m.costing);
    setAnswer(body, formatAnswer(m.content));
    if (m.notice) line(body, "ai-notice", m.notice, true);
    decorate(body, m);
  }

  /**
   * The conversation of the tab shown, on screen. Another part opened in that
   * tab (another file's hash; a conversation of before: another name): that
   * part's last conversation from the history, else a new one. Questions asked
   * before the part was known stay, about it from now on.
   */
  function showConversation() {
    const tab = reader.tab ?? { id: 1, file: null, part: null };
    const key = conversationKey(tab.id);
    const partId = tab.part?.id ?? null;
    if (shown?.key === key && shown.file === tab.file && shown.part === partId) return;
    let conversation = readConversation(key);
    // Another part: by its id; a conversation of before, without one: by its file's name. The file's
    // name alone does not tell another part from the same one renamed (its id coming).
    const renamed = !!(tab.file && conversation.file && conversation.file !== tab.file);
    const other = partId ? (conversation.part ? conversation.part.id !== partId : renamed) : !conversation.part && renamed;
    if (other) {
      // Its question in progress is about the part that was there: dropped (its conversation is in the history).
      if (pending?.key === key) {
        pending.dropped = true;
        busy?.abort();
      }
      conversation = { ...conversation, id: null, part: null, started: null, updated: null, file: tab.file, messages: [], names: [] };
      writeConversation(key, conversation);
    }
    if (partId && conversation.part?.id === partId && renamed) {
      // The same part under another name (renamed, or opened from the history): its conversation goes on.
      conversation = { ...conversation, file: tab.file };
      writeConversation(key, conversation);
    }
    if (!tab.file && !partId && conversation.part && !conversation.messages.length) {
      // A new conversation of a part no longer open (the page reloaded): not about it any more.
      conversation = { ...conversation, id: null, part: null, file: null, names: [] };
      writeConversation(key, conversation);
    }
    if (partId && !conversation.part) {
      if (conversation.messages.length) {
        conversation = { ...conversation, part: tab.part, file: tab.file ?? tab.part.file };
        if (conversation.id) conversation = archives.normalizeConversation(conversation);
        writeConversation(key, conversation);
        if (conversation.id) archive(conversation);
      } else {
        loadLatest(key, tab.part);
      }
    }
    shown = { key, file: tab.file, part: partId };
    $("ai-chat").replaceChildren();
    for (const m of conversation.messages) showMessage(m);
    if (pending?.key === key && !pending.dropped) $("ai-chat").append(...pending.nodes);
    toEnd(true);
    showHistory();
    updateSuggestion();
  }

  let loading = 0; // the history read for the part of a tab: only the latest read is used

  /** The last conversation of the history about `part`, shown in the tab of `key` if nothing was asked there since. */
  async function loadLatest(key, part) {
    const token = ++loading;
    const found = await latestOf(part).catch(() => null);
    if (token !== loading || !found) return;
    const now = readConversation(key);
    // A question asked meanwhile, a new conversation, another part, the tab closed: left as they are.
    if (now.messages.length || now.part || pending?.key === key) return;
    const tabs = reader.tabs ?? [];
    if (tabs.find((t) => conversationKey(t.id) === key)?.part?.id !== part.id) return;
    // Already shown in another tab (the part open twice): a conversation of its own here, not the same one twice.
    if (tabs.some((t) => conversationKey(t.id) !== key && readConversation(conversationKey(t.id)).id === found.id)) return;
    const { synced, ...conversation } = found;
    writeConversation(key, { ...conversation, part, file: part.file ?? conversation.file });
    if (shown?.key === key) {
      shown = null;
      showConversation();
    }
  }

  /** The last conversation about `part`: of this browser, or of the network folder (when it is reachable), one merged with the other. */
  async function latestOf(part) {
    const local = await archives.localFor(part.id).catch(() => []);
    let best = local[0] ?? null;
    const folder = await networkReady();
    if (folder && archives.partHash(part)) {
      const remote = (await archives.readPartFile(folder, part).catch(() => [])).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
      if (remote[0] && (!best || Date.parse(remote[0].updated) > Date.parse(best.updated))) best = remote[0];
      if (best) best = archives.mergeConversation(best, [...local, ...remote].find((c) => c.id === best.id && c !== best));
    }
    return best;
  }
  showConversation();
  // Another tab shown, or another part in the tab shown.
  document.addEventListener("reader3d-part", showConversation);

  function setStatus(text) {
    $("ai-status").textContent = text;
  }

  /**
   * The whole context of a question, before its compaction: the part
   * (`part`: {semantic, scope}, its bodies sent), or none (general questions
   * are allowed without a model);
   * for the task "Chiffrage", the traced values of the quote (`costing`:
   * {snapshot, problem}, read only): smaller for the local model; for the
   * gateway, its internal amounts masked unless the box is ticked, within
   * two thirds of the gateway's budget (`budget`, characters) as for the
   * local model.
   */
  async function contextOf(part, costing, askedTask, local, budget = GATEWAY_CONTEXT_CHARS) {
    const aiTask = askedTask === "costing" ? "manufacturing_analysis" : askedTask;
    const semantic = part?.semantic ?? null;
    const scope = part?.scope ?? null;
    const context = semantic ? { ...buildAIContext(semantic, { task: aiTask }), ...(scope ? { selection: selectionOf(scope) } : {}) } : {
      schema: "3d-ai-reasoning-context",
      schema_version: "1.0",
      task: aiTask,
      no_model_loaded: true,
      note: scope && !scope.bodies_sent
        ? "Une pièce est ouverte mais aucun de ses corps n'est coché : aucune donnée de pièce n'est envoyée."
        : "Aucun modèle 3D n'est chargé : aucune donnée de pièce n'est disponible.",
      model: null,
      bodies: [],
      warnings: [],
    };
    if (!costing) return context;
    const { traceForAI } = await import("./chiffrage/ai-trace.js");
    const costingTrace = traceForAI(costing.snapshot, local ? { maxChars: LOCAL_TRACE_CHARS } : { mask: !$("ai-amounts").checked, maxChars: Math.round((budget * 2) / 3) });
    return { ...context, costing_trace: costingTrace, ...(costing.problem ? { costing_note: costing.problem } : {}) };
  }

  /**
   * The context sent: for the general questions of the local model, a
   * summary of the part (read in seconds on a CPU); otherwise the detail,
   * as much as `maxChars` allows (the costing trace is kept whole by the
   * compaction, the geometry has the room it leaves).
   */
  const compacted = (context, askedTask, maxChars, local) => {
    if (context.no_model_loaded) return context;
    // The summary for the general questions of the local model only (read in seconds on a CPU); the gateway reads the detail in seconds.
    const out = local && askedTask === "general" ? summaryAIContext(context) : compactAIContext(context, { maxChars });
    return context.selection ? { ...out, selection: context.selection } : out; // the summary keeps which bodies were sent
  };

  /** The part of the tab shown, as the IA page sends it: the body selected in the list, else the bodies checked (app.js aiPart). */
  const readPart = (options) => (reader.aiPart ? reader.aiPart(options) : reader.semantic ? { semantic: reader.semantic, scope: null } : null);

  /** Under the tasks: what the AI is given of the part, read when the page is shown and after each question. */
  function showScope() {
    const el = $("ai-scope");
    if (reader.status === "analysing") {
      el.textContent = "Pièce en cours d'analyse : l'IA ne la verra qu'à la fin de l'analyse.";
      return;
    }
    const scope = readPart({ withSemantic: false })?.scope;
    if (!scope) {
      el.textContent = "Aucune pièce ouverte : questions générales seulement.";
      return;
    }
    const names = scope.names.map((n) => `« ${n} »`);
    el.textContent = scope.mode === "selected"
      ? `Envoyé à l'IA : le corps sélectionné ${names[0]} seulement (1 sur ${scope.bodies_in_file}). Cliquez à nouveau sa ligne dans la liste des corps pour envoyer les corps cochés.`
      : !scope.bodies_sent
        ? "Aucun corps coché dans la liste : l'IA ne reçoit pas la pièce."
        : scope.mode === "checked"
          ? scope.bodies_sent === 1
            ? `Envoyé à l'IA : le corps coché ${names[0]} seulement (1 sur ${scope.bodies_in_file}).`
            : `Envoyé à l'IA : les ${scope.bodies_sent} corps cochés sur ${scope.bodies_in_file}${scope.bodies_sent <= 3 ? ` (${names.join(", ")})` : ""}.`
          : `Envoyé à l'IA : toute la pièce${scope.file ? ` « ${scope.file} »` : ""} (${scope.bodies_in_file} corps).`;
  }
  document.addEventListener("reader3d-part", showScope);

  let timing = ""; // time spent by Ollama on the last answer, shown with it

  /** Ask Ollama (`ollama`: {base, model}), the answer shown as it is written. Resolves to the whole answer. */
  async function askOllama(question, context, history, askedTask, ollama, signal, onText, onThought) {
    const { base, model } = ollama;
    const space = addressSpace(base);
    const system = `${systemPrompt(model, space === "loopback" ? "sur ce PC" : "sur un appareil du réseau local", askedTask === "costing")}\n\nCONTEXTE :\n${JSON.stringify(context)}`;
    const think = $("ai-think").checked;
    const reserve = think ? 4096 : 2048; // room for the answer, and for the reasoning written before it
    const promptChars = () => system.length + JSON.stringify(history).length + question.length;
    // The oldest exchanges are left out rather than the prompt cut by Ollama.
    while (history.length && Math.ceil(promptChars() / 3) + reserve > MAX_WINDOW) history = history.slice(2);
    const numCtx = contextWindow(promptChars(), reserve);
    const body = {
      model,
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: question }],
      stream: true,
      think, // Qwen3 reasons before answering only when asked: much slower on a CPU
      keep_alive: "15m", // the model stays loaded between questions (loading it takes long on a CPU)
      options: { num_ctx: numCtx, temperature: 0.2 },
    };
    const post = (payload) => fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      ...(space ? { targetAddressSpace: space } : {}),
    }).catch((err) => {
      if (err?.name === "AbortError") throw err;
      // The test of /api/tags passed: not a permission problem.
      throw new Error("La connexion à Ollama a été coupée. Ollama s'est peut-être arrêté (mémoire insuffisante pour le modèle ?) : vérifiez qu'il tourne, puis réessayez.");
    });
    let response = await post(body);
    if (response.status === 400) {
      // Models (or Ollama versions) without the thinking switch refuse "think".
      const text = await response.text();
      if (!/think/i.test(text)) throw new Error(`Ollama : ${text}`);
      delete body.think;
      response = await post(body);
    }
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`Ollama : ${data.error || `HTTP ${response.status}`}`);
    }
    // Streamed answer: one JSON object per line.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let thought = "";
    let last = null;
    for (;;) {
      let chunkRead;
      try {
        chunkRead = await reader.read();
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        throw new Error("La connexion à Ollama a été coupée pendant la réponse (Ollama arrêté ou mémoire insuffisante ?).");
      }
      const { value, done } = chunkRead;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(`Ollama : ${chunk.error}`);
        if (chunk.done) last = chunk;
        if (chunk.message?.thinking) {
          thought += chunk.message.thinking;
          onThought(thought);
        }
        if (chunk.message?.content) {
          answer += chunk.message.content;
          onText(answer);
        }
      }
    }
    if (last?.done_reason === "length") answer += "\n\n(Réponse coupée : limite de longueur atteinte.)";
    if (last) {
      // Where the time went: loading the model, reading the prompt, writing the answer.
      timing = [
        seconds(last.load_duration) >= 1 ? `chargement du modèle ${seconds(last.load_duration)} s` : "",
        last.prompt_eval_count ? `lecture de ${last.prompt_eval_count} tokens ${seconds(last.prompt_eval_duration)} s` : "",
        last.eval_count ? `rédaction de ${last.eval_count} tokens ${seconds(last.eval_duration)} s` : "",
      ].filter(Boolean).join(", ");
    }
    if (last?.prompt_eval_count >= 0.95 * numCtx) timing += `${timing ? ", " : ""}contexte trop long : Ollama en a peut-être ignoré le début`;
    return answer;
  }

  /** A request to the gateway of this page (its address and access code): see fetchGateway. */
  async function gatewayFetch(init = {}) {
    try {
      return await fetchGateway($("ai-url").value.trim(), $("ai-code").value.trim(), init);
    } catch (err) {
      if (err.codeRequired) showCode(true);
      throw err;
    }
  }

  /** The configuration of the gateway (GET): provider, model, models, context budget, access code; asked again when its address or the code changes. */
  async function gatewayConfig(signal) {
    const key = gatewayKey();
    if (gatewayInfo?.key === key) return gatewayInfo.data;
    const data = await gatewayFetch({ signal });
    gatewayInfo = { key, data };
    showCode(data.access_code_required);
    showModels();
    return data;
  }

  /** Ask the gateway the question with its context (compacted) and the conversation, within `budget`, of the model `model` (none: its own). Resolves to its answer: {output, provider, model, quota}. */
  async function askGateway(question, context, history, askedTask, model, signal, budget) {
    // The latest exchanges, while they take no more than half the room of the context.
    while (history.length && JSON.stringify(history).length > budget / 2) history = history.slice(2);
    const data = await gatewayFetch({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gateway_schema_version: "1.0",
        task: askedTask,
        model: model || undefined,
        context,
        messages: [...history, { role: "user", content: question }],
      }),
      signal,
    });
    const output = data.output ?? data.text;
    if (typeof output !== "string" || !output.trim()) throw new Error("La passerelle a renvoyé une réponse vide : réessayez.");
    return { ...data, output };
  }

  async function send(question) {
    const local = isLocal();
    const askedTask = task;
    const costing = askedTask === "costing";
    // The internal amounts of the costing sent to the gateway (box ticked): its address, else null.
    const amountsSent = costing && !local && $("ai-amounts").checked ? $("ai-url").value.trim() : null;
    store.set(localStorage, KEYS.provider, provider());
    store.set(localStorage, local ? KEYS.ollama : KEYS.gateway, $("ai-url").value.trim() || null);
    const wanted = $("ai-model").value.trim();
    store.set(localStorage, `${KEYS.model}.${provider()}`, wanted || null);

    // What the question is about, read now: the conversation, the part and the quote of the tab shown when it is asked.
    showConversation();
    const conv = shown;
    const tabId = reader.tab?.id;
    const tabPart = reader.tab?.part ?? null;
    const tabFile = reader.part?.()?.file ?? null; // the 3D file of the quote: the values proposed are for its pieces
    const askedAt = new Date().toISOString(); // the date of the question and of its answer in the history
    const part = readPart();
    const snapshot = costing ? (async () => reader.costing?.())() : null;
    snapshot?.catch(() => {}); // read below
    const conversation = readConversation(conv.key);
    const recent = (messages) => messages.slice(-HISTORY).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
    // The local model is given the whole conversation; the gateway, none of what the local model answered.
    const history = recent(conversation.messages);

    const userBox = bubble("user", question);
    // Until the first words arrive: "Réflexion en cours…", in grey italics.
    const answerBox = bubble("assistant", "Réflexion en cours…", costing);
    answerBox.classList.add("ai-thinking");
    const mine = (pending = { key: conv.key, nodes: [userBox.parentElement, answerBox.parentElement], dropped: false });
    // The model's reasoning while it is written: one grey line under the answer, its latest words;
    // folded once the answer starts.
    const thoughtLine = document.createElement("div");
    thoughtLine.className = "ai-thought";
    thoughtLine.hidden = true;
    // Rewritten at every word: not read out by a screen reader (the folded reasoning stays readable), nor the answer until it is complete.
    thoughtLine.setAttribute("aria-hidden", "true");
    answerBox.parentElement.setAttribute("aria-busy", "true");
    answerBox.after(thoughtLine);
    let thought = "";
    let folded = false;
    const showThought = (text) => {
      if (!text || folded) return;
      thought = text;
      thoughtLine.hidden = false;
      thoughtLine.textContent = text.replace(/\s+/g, " ").slice(-300);
    };
    const foldThought = () => {
      if (folded) return;
      folded = true;
      if (!thought) return thoughtLine.remove();
      const details = document.createElement("details");
      details.className = "ai-thought-details";
      const summary = document.createElement("summary");
      summary.textContent = "Voir la réflexion";
      const text = document.createElement("div");
      text.className = "ai-text";
      text.textContent = thought;
      details.append(summary, text);
      thoughtLine.replaceWith(details);
    };
    const onText = (text) => {
      showThought(inlineThinking(text));
      const visible = withoutThinking(text);
      if (!visible) return; // still thinking
      written = visible.length;
      foldThought();
      answerBox.classList.remove("ai-thinking");
      answerBox.textContent = visible;
      toEnd();
    };
    busy = new AbortController();
    const { signal } = busy;
    $("ai-cancel").hidden = false;
    $("ai-send").disabled = true;
    const start = performance.now();
    let written = 0;
    let fallback = null; // the local model, answering in place of the gateway
    const tick = () => {
      const s = Math.round((performance.now() - start) / 1000);
      setStatus(local || fallback
        ? written ? `Rédaction… ${s} s` : thought ? `Réflexion… ${s} s` : `Lecture du contexte par le modèle… ${s} s (sur un PC sans carte graphique, cela peut prendre quelques minutes)`
        : `Analyse… ${s} s`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      let read = null; // the costing of the tab, read only: {snapshot, problem}
      if (snapshot) {
        try {
          read = { snapshot: (await snapshot) ?? null };
        } catch (err) {
          read = { snapshot: null, problem: `trace du chiffrage indisponible : ${err?.message || err}` };
        }
      }
      const questions = (q, h) => [q, ...h.filter((m) => m.role === "user").map((m) => m.content)];
      // The names of the part, kept with the conversation: after a reload, no part open, its history may name them.
      const ofPart = part?.scope ? partNames({ bodies: part.scope.all_names, file: part.scope.file }) : [];
      let sent; // the context the model was given
      let asked; // and the questions
      let names = null; // the labels put in place of the names (gateway)
      let quoteNames = null; // the names of the quote of the tab when the question went to the gateway
      let notice = null; // above the answer: the local model answered in place of the gateway, or a model typed in it does not offer
      let answer = null; // of the gateway
      let localModel = null; // of Ollama
      let output;
      const askLocal = async (ollama) => {
        sent = compacted(await contextOf(part, read, askedTask, true), askedTask, LOCAL_CONTEXT_CHARS, true);
        asked = questions(question, history);
        localModel = ollama.model;
        return askOllama(question, sent, history, askedTask, ollama, signal, onText, showThought);
      };
      if (local) {
        const ollama = { base: ollamaBase($("ai-url").value.trim()), model: $("ai-model").value.trim() || OLLAMA_MODEL };
        const problem = await diagnoseOllama(ollama.base, ollama.model);
        if (problem) throw new Error(problem);
        output = await askLocal(ollama);
      } else {
        // The gateway's budget; an older gateway, without its configuration: the default one.
        const info = await gatewayConfig(signal).catch((err) => {
          if (err?.name === "AbortError") throw err;
          return null; // the question tells what is wrong
        });
        const budget = info?.context_chars > 0 ? info.context_chars : GATEWAY_CONTEXT_CHARS;
        // A model the gateway does not list (AI_MODELS) is not asked for: it answers with its own, and says so.
        const models = Array.isArray(info?.models) ? info.models : [];
        const model = info && wanted && !models.includes(wanted) ? null : wanted;
        if (info && wanted && !model) notice = `Modèle « ${wanted} » non proposé par la passerelle (variable AI_MODELS dans Vercel) : réponse de son modèle par défaut`;
        let whole = await contextOf(part, read, askedTask, false, budget);
        // The names of the quote of the tab, whatever the task: a question may name the customer.
        const { costingNames } = await import("./chiffrage/ui.js");
        quoteNames = costingNames({ tab: tabId });
        // Not what was answered with the internal amounts of the costing, unless they may go now, to this gateway.
        let online = { question, history: recent(onlineMessages(conversation.messages, { amounts: $("ai-amounts").checked, gateway: $("ai-url").value.trim() })) };
        if ($("ai-anon").checked) {
          // Before the compaction: the labels count in the budget. With the names this conversation
          // replaced before: one changed since in the quote may be in its history.
          // The names of the part too, sent or not: a body not sent may be named in the question or the history.
          names = anonymizer(whole, unionNames(quoteNames, conversation.names), ofPart);
          whole = names.context(whole);
          online = { question: names.text(online.question), history: online.history.map((m) => ({ ...m, content: names.text(m.content) })) };
        }
        sent = compacted(whole, askedTask, budget, false);
        asked = questions(online.question, online.history);
        try {
          answer = await askGateway(online.question, sent, online.history, askedTask, model, signal, budget);
          output = answer.output;
        } catch (err) {
          // The free quota reached: the local model, when it answers (its own address and model).
          if (err?.name === "AbortError" || !QUOTA_STATUSES.includes(err?.status) || !$("ai-fallback").checked) throw err;
          const ollama = { base: ollamaBase(store.get(localStorage, KEYS.ollama) || OLLAMA_URL), model: store.get(localStorage, `${KEYS.model}.ollama`) || OLLAMA_MODEL };
          if (await diagnoseOllama(ollama.base, ollama.model)) throw err;
          fallback = { ...ollama, notice: `Quota en ligne atteint : réponse du modèle local (${ollama.model})` };
          notice = fallback.notice;
          line(answerBox, "ai-notice", fallback.notice, true);
          names = null; // the real names: nothing leaves the site
          output = await askLocal(ollama);
        }
        if (notice && !fallback) line(answerBox, "ai-notice", notice, true);
      }
      foldThought();
      answerBox.classList.remove("ai-thinking");
      setAnswer(answerBox, formatAnswer(output) || "(réponse vide)");
      answerBox.parentElement.removeAttribute("aria-busy");
      // Costing: every number of the answer must be in the trace the model was given.
      let check = null;
      if (costing) {
        const { checkNumbers } = await import("./chiffrage/ai-trace.js");
        check = checkNumbers(costingText(output), sent.costing_trace);
      }
      // Costing: the values proposed for the inputs of a piece, each number from the data sent or the questions;
      // the piece by its rank in the trace sent (its labels online), its key and real name from the snapshot.
      let proposals = [];
      if (costing && unreadableProposals(output)) {
        // Said now and kept with the answer (shown with it again).
        const unreadable = "Propositions de l'IA illisibles (JSON non valide) : rien à appliquer.";
        line(answerBox, "ai-notice", unreadable, true);
        notice = [notice, unreadable].filter(Boolean).join(" ");
      }
      if (costing && sent.costing_trace && read?.snapshot && tabId !== undefined) {
        proposals = checkProposals(readProposals(proposalsOf(output), sent.costing_trace), sent, asked).map(({ index, ...p }) => {
          const piece = read.snapshot.pieces[index];
          return piece ? { ...p, piece: piece.nom, cle_piece: piece.cle } : p;
        });
      }
      // Every task with a part: the numbers that come from none of the data sent (informative).
      const numbers = sent.no_model_loaded ? [] : checkContextNumbers(answerText(output), sent, asked).inconnus;
      const legend = names ? names.legend(formatAnswer(output)) : [];
      // An answer of the local model is marked: it never goes online with the conversation (onlineMessages);
      // one of the gateway given the internal amounts of the costing too, with the gateway: not without the box ticked.
      const source = answer ? { provider: answer.provider, model: answer.model } : { provider: "Ollama", model: localModel };
      const message = {
        id: archives.newId(), role: "assistant", content: withoutThinking(output), date: askedAt, answered: new Date().toISOString(),
        ...(source.provider ? { provider: source.provider } : {}), ...(source.model ? { model: source.model } : {}),
        ...(localModel ? { local: true } : {}), ...(amountsSent !== null && !localModel ? { amounts: true, gateway: amountsSent } : {}),
        ...(check ? { costing: check } : {}), ...(numbers.length ? { numbers } : {}), ...(notice ? { notice } : {}), ...(legend.length ? { names: legend } : {}),
        ...(proposals.length ? { proposals, target: { tab: tabId, file: tabFile } } : {}),
      };
      signal.throwIfAborted();
      decorate(answerBox, message);
      toEnd();
      // Only answered questions are kept: a failed one is not sent again with the next. Not in a
      // conversation started since (another part of the tab, a new conversation: the question dropped).
      const kept = readConversation(conv.key);
      if (!mine.dropped && kept.id === conversation.id) {
        const known = unionNames(quoteNames ? unionNames(kept.names, quoteNames) : kept.names, ofPart);
        // The part known since the question was asked (its file opened meanwhile in its tab, shown or not): the conversation is about it.
        const asking = (reader.tabs ?? []).find((t) => t.id === tabId) ?? null;
        const here = asking?.part ?? null;
        const part = kept.part ?? here ?? tabPart;
        // Ids and dates given once (the messages of an earlier version have none): the history merges by them.
        const record = archives.normalizeConversation({
          ...kept, id: kept.id ?? archives.newId(), part, file: kept.file ?? (here ? asking.file ?? here.file : null) ?? conv.file ?? part?.file ?? null,
          started: kept.started ?? askedAt, updated: new Date().toISOString(),
          messages: [...kept.messages, { id: archives.newId(), role: "user", content: question, date: askedAt }, message], names: known,
        });
        writeConversation(conv.key, record);
        archive(record);
      }
      // Costing: the answer kept with the quote of the tab, for the record (nothing in it is applied).
      if (costing && sent.costing_trace) {
        const { addAIAnalysis } = await import("./chiffrage/ui.js");
        const text = [formatAnswer(output), legend.length ? namesLine(legend) : ""].filter(Boolean).join("\n\n");
        addAIAnalysis({ date: new Date().toISOString(), provider: source.provider ?? null, model: source.model ?? null, question, answer: text, verified: check.verifiee }, { tab: tabId });
      }
      if (answer) noteQuota(answer, true);
      const label = answer ? gatewayLabel(answer) : fallback ? `repli local : Ollama · ${fallback.model}` : "";
      setStatus(`Réponse en ${Math.round((performance.now() - start) / 1000)} s${(local || fallback) && timing ? ` (${timing})` : ""}${label ? ` · ${label}` : ""}`);
      timing = "";
    } catch (err) {
      answerBox.parentElement.remove();
      // A question dropped (its tab closed, another part opened in it, a new conversation): nothing to say there.
      const there = shown?.key === conv.key && !mine.dropped;
      if (err?.name === "AbortError") {
        if (there) bubble("error", "Question annulée.");
        setStatus("Annulé");
      } else {
        if (there) bubble("error", err?.message || String(err));
        setStatus("Erreur");
      }
    } finally {
      clearInterval(timer);
      busy = null;
      pending = null;
      $("ai-cancel").hidden = true;
      $("ai-send").disabled = false;
      updateSuggestion();
    }
  }

  $("ai-think").addEventListener("change", () => store.set(localStorage, KEYS.think, $("ai-think").checked ? "1" : null));
  $("ai-anon").addEventListener("change", () => store.set(localStorage, KEYS.anonymize, $("ai-anon").checked ? null : "0"));
  $("ai-fallback").addEventListener("change", () => store.set(localStorage, KEYS.fallback, $("ai-fallback").checked ? null : "0"));
  $("ai-code").addEventListener("input", () => store.set(localStorage, KEYS.code, $("ai-code").value.trim() || null));
  // The address and the model of each provider, kept as soon as typed: those of Ollama are also the ones of the fallback.
  $("ai-url").addEventListener("change", () => {
    store.set(localStorage, isLocal() ? KEYS.ollama : KEYS.gateway, $("ai-url").value.trim() || null);
    showModels(); // another gateway: its models are not known yet
  });
  $("ai-model").addEventListener("change", () => store.set(localStorage, `${KEYS.model}.${provider()}`, $("ai-model").value.trim() || null));
  $("ai-amounts").addEventListener("change", () => store.set(sessionStorage, KEYS.amounts, $("ai-amounts").checked ? "1" : null));

  $("ai-provider").addEventListener("change", () => {
    store.set(localStorage, KEYS.provider, provider());
    showProvider();
  });

  $("ai-test").addEventListener("click", async () => {
    if (!isLocal()) {
      setStatus("Test de la passerelle…");
      gatewayInfo = null; // asked again
      try {
        const info = await gatewayConfig();
        const code = $("ai-code").value.trim();
        setStatus(`Passerelle connectée : ${gatewayLabel(info)} · ${info.access_code_required ? (code ? "code d'accès accepté" : "code d'accès requis") : "sans code d'accès"}`);
        if (info.access_code_required && !code) $("ai-code").focus();
      } catch (err) {
        if (err.codeRequired) {
          setStatus(err.message);
          $("ai-code").focus();
        } else {
          bubble("error", err.message);
          setStatus("Passerelle inaccessible");
        }
      }
      return;
    }
    setStatus("Test d'Ollama…");
    let problem;
    const model = $("ai-model").value.trim() || OLLAMA_MODEL;
    try {
      problem = await diagnoseOllama(ollamaBase($("ai-url").value.trim()), model);
    } catch (err) {
      problem = err.message;
    }
    if (problem) {
      bubble("error", problem);
      setStatus("Ollama inaccessible");
    } else {
      setStatus(`Connecté à Ollama (${model})`);
    }
  });

  page.querySelectorAll(".ai-task").forEach((button) => {
    button.addEventListener("click", () => {
      task = button.dataset.task;
      page.querySelectorAll(".ai-task").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      $("ai-amounts-field").hidden = isLocal() || task !== "costing";
      const [, label, help, question] = TASKS.find(([v]) => v === task);
      $("ai-task-help").textContent = `${help} ${TASK_NOTE}`;
      // The click asks its question (a question being written stays in the box), when it can be answered.
      if (busy) return setStatus(`Tâche « ${label} » choisie : une question est déjà en cours, cliquez de nouveau une fois la réponse écrite`);
      if (reader.status === "analysing") return setStatus(`Tâche « ${label} » choisie : la pièce est encore en cours d'analyse, cliquez de nouveau une fois l'analyse finie`);
      // The costing reads the quote of the tab, the other tasks the part.
      if (task !== "costing" && !readPart({ withSemantic: false })) return setStatus(`Tâche « ${label} » choisie : ouvrez une pièce dans le lecteur 3D pour son analyse`);
      ask(question);
    });
  });

  $("ai-cancel").addEventListener("click", () => busy?.abort());

  $("ai-clear").addEventListener("click", () => {
    showConversation();
    if (pending?.key === shown.key) {
      pending.dropped = true;
      busy?.abort();
    }
    // About a part: a new one of its conversations (the one before stays in the history, not shown again).
    const part = reader.tab?.part ?? null;
    writeConversation(shown.key, part ? { id: null, part, file: reader.tab.file ?? part.file, messages: [], names: [] } : { file: null, messages: [] });
    $("ai-chat").replaceChildren();
    setStatus("Nouvelle conversation");
    showHistory();
    updateSuggestion();
  });

  // ------------------------------------------------------------------ history (ai-history.js), on the right


  /** The network folder when it may be written (its access granted), else null. */
  async function networkReady() {
    if (!archives.folderSupported()) return null;
    network = await archives.networkFolder().catch(() => null);
    return network?.permission === "granted" ? network.handle : null;
  }

  // What is written in the history, one after the other (two tabs answered at once, the folder synchronised meanwhile).
  let archiving = Promise.resolve();
  const inTurn = (job) => {
    const done = archiving.then(job);
    archiving = done.catch(() => {});
    return done;
  };

  /**
   * Keep a conversation in the history: in this browser at once (a slow
   * network folder must not hold it back, nor a page closed meanwhile lose
   * it), then in the network folder for a part, when its access is granted,
   * one write after the other.
   */
  function archive(conversation) {
    if (!conversation.messages.length) return Promise.resolve();
    const saved = archives.saveLocal(conversation).then(
      (record) => {
        showHistory();
        return record;
      },
      (err) => {
        networkNote = `Historique de ce PC indisponible : ${err?.message || err}`;
        return null;
      },
    );
    return inTurn(async () => archiveNow(conversation, await saved)).catch(() => {});
  }

  /** In the network folder: the conversation as kept on this PC (`record`: merged with what another tab added to it). */
  async function archiveNow(conversation, record) {
    const folder = archives.partHash(conversation.part) ? await networkReady() : null;
    if (!folder) return;
    const kept = record ?? conversation;
    let wrote = false;
    try {
      await archives.writePartFile(folder, kept);
      wrote = true;
      if (record) await archives.markSynced(kept.id, kept.updated);
      networkNote = "";
      networkList = []; // read again when shown
      // What could not be written before (the folder unreachable): written now, and said if it still cannot be.
      if (networkBehind) {
        const { failed } = await archives.syncFolder(folder);
        networkBehind = failed > 0;
        if (failed) networkNote = notWritten(failed);
      }
    } catch (err) {
      networkBehind = true;
      networkNote = `Écriture dans le dossier réseau impossible (réessayée à la prochaine réponse, ou avec « Actualiser ») : ${err?.message || err}`;
    }
    // Read again once written (not after a failed write: its note stays).
    showHistory({ folder: wrote && historyTab === "reseau" });
  }

  const notWritten = (n) => `${n} discussion${n > 1 ? "s" : ""} non écrite${n > 1 ? "s" : ""} dans le dossier : réessayé${n > 1 ? "es" : "e"} à la prochaine réponse, ou avec « Actualiser ».`;

  const dateLabel = (iso) => {
    const d = new Date(iso);
    const options = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    if (d.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
    return Number.isFinite(d.getTime()) ? d.toLocaleString("fr-FR", options) : "";
  };

  /** A list of the history: each conversation, its part, its date, its first question; the one shown and its part's marked. */
  function historyItems(list, conversations, source) {
    const tab = reader.tab;
    const current = readConversation(conversationKey(tab?.id ?? 1)).id;
    if (!conversations.length) {
      const empty = document.createElement("li");
      empty.className = "ai-hist-empty";
      empty.textContent = source === "local" ? "Aucune discussion gardée sur ce PC." : "Aucune discussion dans ce dossier.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...conversations.map((c) => {
      const li = document.createElement("li");
      li.className = "ai-hist-item";
      const thisPart = !!c.part && c.part.id === tab?.part?.id;
      li.classList.toggle("current", c.id === current);
      li.classList.toggle("this-part", thisPart);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ai-hist-open";
      open.dataset.id = c.id;
      open.dataset.source = source;
      if (c.id === current) open.setAttribute("aria-current", "true");
      const { question, count } = archives.conversationSummary(c);
      const name = c.file ?? c.part?.file; // the name it was last opened under
      open.title = `${name ?? "Sans pièce"} — ouvrir cette discussion dans un nouvel onglet${c.part ? " (le modèle 3D n'est pas ouvert)" : ""}`;
      const part = document.createElement("span");
      part.className = "ai-hist-part";
      part.textContent = name ? name.replace(/\.[^.]+$/, "") : "Sans pièce";
      const meta = document.createElement("span");
      meta.className = "ai-hist-meta";
      meta.textContent = `${dateLabel(c.updated)} · ${count} message${count > 1 ? "s" : ""}${c.id === current ? " · affichée" : thisPart ? " · pièce ouverte" : ""}`;
      const first = document.createElement("span");
      first.className = "ai-hist-q";
      first.textContent = question ? `« ${question} »` : "";
      open.append(part, meta, first);
      li.append(open);
      if (source === "local") {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "ai-hist-del";
        del.dataset.id = c.id;
        del.textContent = "×";
        del.title = "Supprimer cette discussion de l'historique de ce PC";
        del.setAttribute("aria-label", `Supprimer la discussion ${name ?? "sans pièce"} du ${dateLabel(c.updated)}`);
        li.append(del);
      }
      return li;
    }));
  }

  /** The element of the history that has the focus, to give it back once the history is drawn again: a selector, or null. */
  function historyFocus() {
    const el = document.activeElement;
    if (!el || !page.querySelector(".ai-history").contains(el)) return null;
    if (el.dataset.histAction) return `[data-hist-action="${el.dataset.histAction}"]`;
    if (el.dataset.history) return `.ai-hist-tab[data-history="${el.dataset.history}"]`;
    if (el.dataset.id) return `.${el.classList.contains("ai-hist-del") ? "ai-hist-del" : "ai-hist-open"}[data-id="${CSS.escape(el.dataset.id)}"]`;
    return null;
  }

  /** The history on the right, as kept now (`folder`: read the network folder again; `focus`: where the focus goes, else where it was). */
  async function showHistory({ folder = false, focus = historyFocus() } = {}) {
    const token = ++historyRead;
    const refocus = () => {
      if (!focus || token !== historyRead) return;
      const el = typeof focus === "function" ? focus() : page.querySelector(focus);
      if (el && document.activeElement !== el && (!document.activeElement || document.activeElement === document.body || page.querySelector(".ai-history").contains(document.activeElement))) el.focus();
    };
    for (const tabEl of page.querySelectorAll(".ai-hist-tab")) {
      const on = tabEl.dataset.history === historyTab;
      tabEl.setAttribute("aria-selected", String(on));
      tabEl.tabIndex = on ? 0 : -1;
    }
    $("ai-hist-local").hidden = historyTab !== "local";
    $("ai-hist-reseau").hidden = historyTab !== "reseau";
    if (historyTab === "local") {
      const local = await archives.listLocal().catch(() => null);
      if (token !== historyRead) return;
      if (local) historyItems($("ai-hist-list-local"), local, "local");
      else $("ai-hist-list-local").replaceChildren(Object.assign(document.createElement("li"), { className: "ai-hist-empty", textContent: "Historique indisponible dans ce navigateur (navigation privée ?)." }));
      refocus();
      return;
    }
    const box = $("ai-hist-folder");
    const handle = await networkReady();
    if (token !== historyRead) return;
    const button = (action, label) => `<button type="button" class="btn small" data-hist-action="${action}">${label}</button>`;
    const note = networkNote ? `<p class="ai-hist-error">${escapeHtml(networkNote)}</p>` : "";
    if (!archives.folderSupported()) {
      box.innerHTML = '<p class="ai-hist-note">Ce navigateur ne peut pas ouvrir de dossier : l\'historique réseau demande Chrome ou Edge.</p>';
      $("ai-hist-list-reseau").replaceChildren();
      refocus();
      return;
    }
    if (!network) {
      box.innerHTML = `<p class="ai-hist-note">Aucun dossier réseau choisi. Le dossier réseau partagé de l'entreprise (aussi dans Paramètres) : les discussions des pièces y seront écrites (sous-dossier « historique-ia », un fichier par discussion) pour les retrouver depuis les autres postes, avec les analyses 3D et les retours d'expérience.</p><div class="ai-hist-actions">${button("choose", "Choisir le dossier…")}</div>${note}`;
      $("ai-hist-list-reseau").replaceChildren();
      refocus();
      return;
    }
    // The shared folder of the company (network-folder.js), else the folder chosen in this page before it.
    const where = `${network.shared ? "Dossier réseau partagé" : "Dossier"} « ${escapeHtml(network.name)} »`;
    if (!handle) {
      box.innerHTML = `<p class="ai-hist-note">${where} : ${network.error ? `injoignable (${escapeHtml(network.error)})` : "accès à autoriser (le navigateur le demande après chaque redémarrage)"}.</p><div class="ai-hist-actions">${button("grant", "Autoriser l'accès")}${button("choose", "Changer de dossier…")}</div>${note}`;
      $("ai-hist-list-reseau").replaceChildren();
      refocus();
      return;
    }
    const drawFolder = () => {
      const note = networkNote ? `<p class="ai-hist-error">${escapeHtml(networkNote)}</p>` : "";
      const legacy = network.legacy == null ? "" : `<p class="ai-hist-note">Les discussions du dossier « ${escapeHtml(network.legacy)} », choisi avant dans cette page, sont à recopier ici.</p><div class="ai-hist-actions">${button("move-legacy", "Recopier ces discussions")}</div>`;
      box.innerHTML = `<p class="ai-hist-note">${where}${network.shared ? ", sous-dossier « historique-ia »" : ""} : les discussions des pièces y sont écrites après chaque réponse.</p><div class="ai-hist-actions">${button("refresh", "Actualiser")}${button("choose", "Changer de dossier…")}</div>${legacy}${note}`;
    };
    drawFolder();
    if (folder || !networkList.length) {
      $("ai-hist-list-reseau").replaceChildren(Object.assign(document.createElement("li"), { className: "ai-hist-empty", textContent: "Lecture du dossier…" }));
      let read = null;
      let problem = "";
      try {
        read = await archives.listFolder(handle);
      } catch (err) {
        problem = `Lecture du dossier réseau impossible : ${err?.message || err}`;
      }
      if (token !== historyRead) return;
      networkList = read ?? [];
      // Read: what went wrong reading it before is past. Not read: said, the note of a failed write kept.
      if (read && networkNote.startsWith("Lecture")) networkNote = "";
      if (problem && !networkNote.startsWith("Écriture")) networkNote = problem;
      drawFolder();
      if (!read) {
        $("ai-hist-list-reseau").replaceChildren(Object.assign(document.createElement("li"), { className: "ai-hist-empty", textContent: "Dossier illisible pour l'instant (réseau ?) : « Actualiser » pour le lire à nouveau." }));
        refocus();
        return;
      }
    }
    historyItems($("ai-hist-list-reseau"), networkList, "reseau");
    refocus();
  }

  /** Open a conversation of the history: the tab that shows it, else a new tab of its part (its model not opened). */
  async function openArchive(id, source) {
    const found = source === "local" ? await archives.getLocal(id).catch(() => null) : networkList.find((c) => c.id === id);
    if (!found) return;
    const there = (reader.tabs ?? []).find((t) => readConversation(conversationKey(t.id)).id === id);
    if (there) {
      reader.showTab?.(there.id);
      $("ai-input").focus();
      return;
    }
    let conversation = found;
    // The same conversation on this PC and in the folder: the messages of both.
    const local = source === "local" ? null : await archives.getLocal(id).catch(() => null);
    if (local) conversation = archives.mergeConversation(found, local);
    const { synced, ...kept } = conversation;
    if (!reader.openPartTab) return;
    const file = kept.file ?? kept.part?.file ?? null; // the name the part was last opened under
    // The tab shown, when it is empty (no part, no conversation, no question under way): it takes the conversation.
    const shownTab = reader.tab;
    const shownKey = shownTab ? conversationKey(shownTab.id) : null;
    const reuse = !!shownTab && !shownTab.file && !shownTab.part && !readConversation(shownKey).messages.length && pending?.key !== shownKey;
    const tabId = reader.openPartTab(kept.part ? { ...kept.part, file } : { id: null, file: null }, (id) => writeConversation(conversationKey(id), { ...kept, file }), { reuse });
    if (tabId === shownTab?.id) {
      // The same tab (a conversation without part does not change it): shown again.
      shown = null;
      showConversation();
    }
    const where = tabId === shownTab?.id ? "dans cet onglet" : "dans un nouvel onglet";
    setStatus(kept.part ? `Discussion ouverte ${where} : ouvrez le fichier de la pièce pour la voir en 3D` : `Discussion ouverte ${where}`);
    $("ai-input").focus();
  }

  page.querySelector(".ai-hist-tabs").addEventListener("click", (event) => {
    const tabEl = event.target.closest(".ai-hist-tab");
    if (!tabEl) return;
    historyTab = tabEl.dataset.history;
    store.set(localStorage, KEYS.historyTab, historyTab === "reseau" ? "reseau" : null);
    showHistory({ folder: historyTab === "reseau" });
  });
  page.querySelector(".ai-hist-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    historyTab = historyTab === "local" ? "reseau" : "local";
    store.set(localStorage, KEYS.historyTab, historyTab === "reseau" ? "reseau" : null);
    const chosen = `.ai-hist-tab[data-history="${historyTab}"]`;
    page.querySelector(chosen).focus();
    showHistory({ folder: historyTab === "reseau", focus: chosen });
  });
  page.querySelector(".ai-history").addEventListener("click", async (event) => {
    const open = event.target.closest(".ai-hist-open");
    if (open) return openArchive(open.dataset.id, open.dataset.source);
    const del = event.target.closest(".ai-hist-del");
    if (del) {
      if (!confirm("Supprimer cette discussion de l'historique de ce PC ? (Une copie écrite dans le dossier réseau y reste.)")) return;
      const rank = [...$("ai-hist-list-local").children].indexOf(del.closest("li"));
      await archives.deleteLocal(del.dataset.id).catch(() => {});
      // The focus to the discussion that took its place, else to the tab of the list.
      const next = () => {
        const opens = $("ai-hist-list-local").querySelectorAll(".ai-hist-open");
        return opens[Math.min(rank, opens.length - 1)] ?? $("ai-hist-tab-local");
      };
      return showHistory({ focus: next });
    }
    const action = event.target.closest("[data-hist-action]")?.dataset.histAction;
    if (!action) return;
    const sync = async (handle, options) => {
      const { failed } = await inTurn(() => archives.syncFolder(handle, options));
      networkBehind = failed > 0;
      networkNote = failed ? notWritten(failed) : "";
    };
    try {
      if (action === "choose") {
        const previous = network?.handle ?? null;
        const handle = await archives.chooseNetworkFolder();
        networkList = [];
        networkNote = "";
        // Another folder: every conversation of a part written there (what was written in the other one too).
        const same = previous ? await previous.isSameEntry(handle).catch(() => false) : false;
        const before = (await archives.listLocal()).filter((c) => archives.partHash(c.part) && (!same || !(c.synced && Date.parse(c.synced) >= Date.parse(c.updated)))).length;
        const all = !before || confirm(`Écrire aussi dans ce dossier les ${before} discussion${before > 1 ? "s" : ""} de pièces déjà gardée${before > 1 ? "s" : ""} sur ce PC ?`);
        await sync(handle, { all, force: !same });
      } else if (action === "grant") {
        // Granted: the folder of the conversations (in the shared folder: its subfolder), not the one asked.
        if (network && (await archives.grantNetworkFolder(network.handle)) && (await networkReady())) await sync(network.handle);
      } else if (action === "move-legacy") {
        // The conversations of the folder chosen here before the shared folder: copied into it (its access asked again if need be).
        const moved = await inTurn(async () => archives.moveLegacyFolder(await networkReady(), { ask: true }));
        networkList = [];
        networkNote = !moved ? "Ancien dossier non lu : accès refusé, ou dossier partagé inaccessible." : moved.failed ? `${moved.failed} discussion${moved.failed > 1 ? "s" : ""} non recopiée${moved.failed > 1 ? "s" : ""} : réessayez.` : "";
      } else if (action === "refresh" && (await networkReady())) {
        await sync(network.handle);
      }
    } catch (err) {
      if (err?.name !== "AbortError") networkNote = `Dossier réseau : ${err?.message || err}`;
    }
    // The focus where it was; after the access granted, its button gone: to "Actualiser".
    showHistory({ folder: true, ...(action === "grant" ? { focus: '[data-hist-action="refresh"], [data-hist-action="grant"]' } : {}) });
  });

  $("ai-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("ai-form").requestSubmit();
    }
    // The suggested reply taken with Tab (the box empty), as in a terminal; else Tab moves on.
    if (event.key === "Tab" && !event.shiftKey && suggestion && !$("ai-input").value) {
      event.preventDefault();
      $("ai-input").value = APPLY_TEXT;
      showSuggestion();
    }
  });
  $("ai-input").addEventListener("input", () => showSuggestion());

  // ------------------------------------------------------------------ the values proposed, applied to the costing

  /** The suggested reply, by the box: its button, and in the empty box what Tab writes. */
  function showSuggestion() {
    $("ai-suggest").hidden = !suggestion;
    const n = suggestion ? suggestion.pieces.reduce((k, p) => k + p.changes.length, 0) : 0;
    $("ai-suggest-help").textContent = suggestion
      ? `${n} saisie${n > 1 ? "s" : ""} de ${suggestion.pieces.map((p) => `« ${p.name} »`).join(", ")} : Tab dans la zone de saisie, puis Entrée (une confirmation suit).`
      : "";
    $("ai-input").placeholder = suggestion ? `${APPLY_TEXT} (Tab pour l'écrire, puis Entrée)` : placeholder;
  }

  /**
   * The reply suggested now: when the last answer of the conversation shown
   * proposes values that would change the costing of its tab (a dry run of
   * ui.js applyAIValues, the quote as it is now), "Appliquer les valeurs au
   * chiffrage".
   */
  async function updateSuggestion() {
    const token = ++suggesting;
    let found = null;
    const key = shown?.key ?? null;
    const last = key ? readConversation(key).messages.at(-1) : null;
    const valid = last?.role === "assistant" && last.target && Array.isArray(last.proposals) ? last.proposals.filter((p) => !p.refus && p.cle_piece) : [];
    if (valid.length && !busy && last.target.tab === reader.tab?.id) {
      try {
        const { applyAIValues } = await import("./chiffrage/ui.js");
        const pieces = [];
        for (const piece of new Set(valid.map((p) => p.cle_piece))) {
          const proposals = valid.filter((p) => p.cle_piece === piece);
          const dry = applyAIValues({ ...last.target, key: piece }, proposals, {}, { dryRun: true });
          if (!dry.error && dry.applied.length) pieces.push({ key: piece, name: dry.piece, proposals, changes: dry.applied });
        }
        if (pieces.length) found = { key, message: last.id, target: last.target, pieces };
      } catch (err) {
        console.warn("Values proposed not evaluated", err);
      }
    }
    if (token !== suggesting) return;
    suggestion = found;
    showSuggestion();
  }

  /** The conversation shown, with `messages` added (the reply accepted and what was done), kept and archived. */
  function appendMessages(messages) {
    const kept = readConversation(shown.key);
    const now = new Date().toISOString();
    const record = archives.normalizeConversation({
      ...kept, id: kept.id ?? archives.newId(), part: kept.part ?? reader.tab?.part ?? null, started: kept.started ?? now, updated: now,
      messages: [...kept.messages, ...messages.map((m) => ({ id: archives.newId(), date: now, ...m }))],
    });
    writeConversation(shown.key, record);
    archive(record);
    shown = null;
    showConversation();
  }

  const changeLine = (x) => `${x.label} : ${valueLabel(x.avant, x.unite)} → ${valueLabel(x.apres, x.unite)}`;

  /**
   * "Appliquer les valeurs au chiffrage": the values of the suggestion that
   * still change the costing, confirmed by the person, written as the inputs
   * of their pieces (ui.js applyAIValues). Nothing is sent to the AI.
   */
  async function applySuggestion() {
    const s = suggestion;
    if (!s || busy) return;
    const { applyAIValues } = await import("./chiffrage/ui.js");
    const plans = s.pieces.map((p) => ({ ...p, dry: applyAIValues({ ...s.target, key: p.key }, p.proposals, {}, { dryRun: true }) }));
    const todo = plans.filter((p) => !p.dry.error && p.dry.applied.length);
    if (!todo.length) {
      setStatus(plans.find((p) => p.dry.error)?.dry.error ?? "Les valeurs proposées sont déjà celles du chiffrage.");
      return updateSuggestion();
    }
    const lines = todo.flatMap((p) => [
      `« ${p.dry.piece} » :`, ...p.dry.applied.map((x) => `  ${changeLine(x)}`),
      ...(p.dry.consequences ?? []).map((x) => `  et par conséquent, ${changeLine(x)}`),
      ...p.dry.refused.map((x) => `  non appliqué, ${x.label} : ${x.refus}`),
    ]);
    if (!confirm(`Appliquer ces valeurs au chiffrage de cet onglet ?\n\n${lines.join("\n")}\n\nElles deviennent des saisies de la pièce, tracées « proposition IA appliquée » ; « Annuler l'application » remet les valeurs d'avant.`)) {
      setStatus("Valeurs non appliquées");
      return;
    }
    const answer = readConversation(s.key).messages.find((m) => m.id === s.message);
    const origin = { date: new Date().toISOString(), provider: answer?.provider ?? null, model: answer?.model ?? null, message: s.message };
    const done = todo.map((p) => applyAIValues({ ...s.target, key: p.key }, p.proposals, origin));
    const changes = done.flatMap((r) => (r.error ? [] : [...r.applied, ...(r.consequences ?? [])].map((x) => ({ ...x, label: `${x.label} de « ${r.piece} »` }))));
    const failed = done.filter((r) => r.error).map((r) => r.error);
    const unsaved = done.some((r) => r.saved === false);
    const content = [
      changes.length ? `Valeurs appliquées au chiffrage :\n- ${changes.map(changeLine).join("\n- ")}` : "Aucune valeur appliquée.",
      failed.length ? `Non appliqué : ${failed.join(" ")}` : "",
      unsaved ? "Le stockage de ce navigateur est plein ou bloqué : ces saisies ne sont gardées que pendant cette visite." : "",
    ].filter(Boolean).join("\n\n");
    appendMessages([
      { role: "user", content: APPLY_TEXT },
      { role: "assistant", content, ...(changes.length ? { application: { message: s.message, undone: false, changes } } : {}) },
    ]);
    setStatus(changes.length ? `Valeurs appliquées au chiffrage (${changes.length}) : voir la page Chiffrage` : "Aucune valeur appliquée");
    $("ai-input").focus(); // its button gone with the suggestion
    updateSuggestion();
  }

  /** "Annuler l'application": the values applied from the answer `answerId` back to what was there before (ui.js undoAIValues). */
  async function undoApplication(answerId) {
    if (busy || !shown) return;
    const answer = readConversation(shown.key).messages.find((m) => m.id === answerId);
    if (!answer?.target) return;
    if (!confirm("Annuler l'application des valeurs de l'IA ?\n\nLes saisies d'avant reviennent ; une valeur modifiée depuis dans la page Chiffrage est gardée.")) return;
    const { undoAIValues } = await import("./chiffrage/ui.js");
    const pieces = new Map((answer.proposals ?? []).filter((p) => p.cle_piece).map((p) => [p.cle_piece, p.piece]));
    const results = [...pieces].map(([key, name]) => undoAIValues({ ...answer.target, key, name }, { message: answerId }));
    const changes = results.flatMap((r) => (r.error ? [] : r.undone.map((x) => ({ ...x, label: `${x.label} de « ${r.piece} »` }))));
    const kept = results.flatMap((r) => r.kept ?? []);
    // Nothing undone, nothing kept (no workbook, another tab shown): said, the button left to try again.
    if (results.every((r) => r.error)) {
      setStatus(results[0]?.error ?? "Rien à annuler");
      return;
    }
    const content = [
      changes.length ? `Application annulée :\n- ${changes.map(changeLine).join("\n- ")}` : "Rien à annuler : les valeurs ont été modifiées depuis.",
      kept.length ? `Modifiées depuis, gardées : ${kept.join(", ")}.` : "",
    ].filter(Boolean).join("\n\n");
    appendMessages([{ role: "assistant", content, application: { message: answerId, undone: true, changes } }]);
    setStatus(changes.length ? "Application des valeurs de l'IA annulée" : "Rien à annuler");
    $("ai-input").focus(); // its button gone with the message redrawn
    updateSuggestion();
  }

  $("ai-suggest-apply").addEventListener("click", () => applySuggestion());
  $("ai-chat").addEventListener("click", (event) => {
    const undo = event.target.closest(".ai-undo-apply");
    if (undo) undoApplication(undo.dataset.message);
  });
  // Another part, body or tab: the suggestion evaluated again.
  document.addEventListener("reader3d-part", () => updateSuggestion());

  $("ai-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const input = $("ai-input");
    const question = input.value.trim();
    if (!question) return;
    // The suggested reply: applied here, not asked.
    if (suggestion && question === APPLY_TEXT) {
      input.value = "";
      return applySuggestion();
    }
    // A question about the part while it is analysed: it would be answered without it.
    if (reader.status === "analysing" && task !== "general") {
      setStatus("La pièce est encore en cours d'analyse : attendez la fin, puis reposez la question.");
      showScope();
      return;
    }
    input.value = "";
    await ask(question);
  });

  /** Asks `question` under the task chosen: its answer, or its error, in the conversation. */
  async function ask(question) {
    await send(question).catch((err) => bubble("error", err?.message || String(err)));
    showScope();
  }

  /** The status line when no question is asked: is there a part, is it still analysed. */
  function showReady() {
    if (!busy) setStatus(reader.status === "analysing" ? "Analyse de la pièce en cours" : readPart({ withSemantic: false }) ? "Modèle analysé : posez votre question" : "Aucun modèle 3D chargé : questions générales possibles");
  }
  // The analysis ended (or failed, or another tab is shown): said without leaving the page.
  document.addEventListener("reader3d-status", () => {
    showScope();
    showReady();
  });

  return {
    show() {
      showConversation();
      toEnd(); // an answer written while the page was not shown
      $("ai-input")?.focus();
      showScope();
      showReady();
      showHistory();
      updateSuggestion(); // the costing may have changed in its page
    },
    /** The tab `id` of the 3D page was closed (app.js): its conversation is forgotten, its question dropped. */
    forgetTab(id) {
      const key = conversationKey(id);
      if (pending?.key === key) {
        pending.dropped = true;
        busy?.abort();
      }
      writeConversation(key, { file: null, messages: [] });
      if (shown?.key === key) {
        shown = null;
        showConversation();
      }
    },
  };
}
