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
// unless the user ticks the box that sends them.

import { buildAIContext, compactAIContext, summaryAIContext } from "./engine/ai-context.js";

const PROVIDERS = [
  ["openai", "En ligne via la passerelle (Groq…)"], // value of earlier versions, kept in this browser's storage
  ["ollama", "Ollama local (sur ce PC)"],
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

const TASKS = [
  ["general", "Analyse générale"],
  ["feature_analysis", "Features"],
  ["manufacturing_analysis", "Fabrication"],
  ["dfm", "DFM"],
  ["planning", "Planification"],
  ["costing", "Chiffrage"],
];

const KEYS = { gateway: "reader3d.ai.gateway", code: "reader3d.ai.gatewayCode", ollama: "reader3d.ai.ollama", model: "reader3d.ai.model", provider: "reader3d.ai.provider", messages: "reader3d.ai.messages", think: "reader3d.ai.think", amounts: "reader3d.ai.costingAmounts" };
const COSTING_LABEL = "Raisonnement IA — aucune valeur n'est appliquée";

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

/** The text of an answer: the JSON of the structured contract laid out, or the raw text. */
export function formatAnswer(content) {
  const text = withoutThinking(content);
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

/**
 * The part of an answer that is about the costing, whose numbers are checked
 * against the trace: analyse_chiffrage of an answer of the gateway (JSON),
 * else the whole text (the plain text of Ollama).
 */
export function costingText(content) {
  const text = withoutThinking(content);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== "object") return text;
  const strings = [];
  (function walk(v) {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(parsed.analyse_chiffrage);
  return strings.join("\n");
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

/** Where an answer of the gateway comes from, and what is left of its free quota: "Groq · openai/gpt-oss-120b · 998 questions restantes aujourd'hui". */
export function gatewayLabel({ provider, model, quota } = {}) {
  const left = quota?.requests_remaining_day;
  return [
    [provider, model].filter(Boolean).join(" · "),
    Number.isFinite(left) ? `${left.toLocaleString("fr-FR")} question${left > 1 ? "s restantes" : " restante"} aujourd'hui` : "",
  ].filter(Boolean).join(" · ");
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

// Rules of the task "Chiffrage" for the local model: it explains the traced values, it never sets one.
const COSTING_RULES = `Tâche « Chiffrage » : le contexte contient costing_trace, les valeurs du devis en cours (devis, pièces, îlots classés), chacune avec sa trace : valeur, unité, source, autorité, confiance, écart à la tendance, autres sources, validation requise ; et les alertes. Elles sont en lecture seule : ta réponse est un raisonnement, aucune valeur n'est appliquée au devis ni aux paramètres.
Explique les valeurs et leurs sources, signale les écarts et les valeurs à valider, pose les questions utiles, énonce tes hypothèses. Cite la clé de chaque valeur dont tu parles (par exemple piece.prix.vente).
N'invente jamais de prix, de taux, de temps de cycle ni de nombre de noyaux. Ne cite que des nombres présents dans costing_trace, tels quels ou arrondis, sans en calculer de nouveaux : une réponse qui contient un autre nombre est marquée « non vérifiée ».
Si costing_trace est null, aucun classeur de chiffrage n'est importé : dis-le et propose de l'importer dans la page Chiffrage.`;

/** Instructions of the local model: plain French text, laid out only when the question is about the part. */
function systemPrompt(model, where = "sur ce PC", costing = false) {
  return `Tu es l'assistant d'ingénierie de 3D Reader, pour une fonderie d'aluminium. Tu es un modèle de langage (${model}) qui tourne en local ${where} avec Ollama : aucune donnée n'est envoyée sur Internet.
Réponds en français, en texte simple (jamais de JSON), de façon claire et concise.
Pour une conversation ou une question générale (fonderie, procédés, chiffrage, méthode), réponds directement et brièvement.
Pour une question sur la pièce, organise la réponse en courtes sections, celles qui sont utiles seulement : « Conclusion », « Mesuré » (valeurs du contexte, avec leurs identifiants), « Déduit », « Recommandations », « À valider ».
N'utilise que le contexte fourni (analyse géométrique et sémantique de la pièce, connaissances fonderie). N'invente jamais de dimensions, de paramètres de procédé, de propriétés matière, de prix, de taux, de temps de cycle, de nombre de noyaux, de probabilités de défaut, d'attaques, de masselottes ni de résultats de simulation.
Pour la fonderie, cite les identifiants de sources fournis et dis clairement quand une conclusion demande une simulation de remplissage/solidification ou une validation fonderie.
Si le contexte est partiel (champ "compaction"), dis-le quand cela limite la réponse.
Si aucun modèle 3D n'est chargé (champ "no_model_loaded"), ne prétends pas connaître une pièce et propose d'ouvrir le modèle si la question en dépend.${costing ? `\n${COSTING_RULES}` : ""}`;
}

/** The answer without a model's hidden reasoning (<think>…</think>, written by older Ollama versions). */
function withoutThinking(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
}

/** That reasoning, when the model writes it in the answer. */
function inlineThinking(text) {
  return /<think>([\s\S]*?)(<\/think>|$)/.exec(String(text ?? ""))?.[1].trim() ?? "";
}

export function mount({ page, reader }) {
  if (!page) return { show() {} };
  page.innerHTML = `
    <div class="ai-page">
      <section class="card">
        <div class="card-head">
          <h2>IA / analyse</h2>
          <span id="ai-status" class="muted small" role="status">Non connecté</span>
        </div>
        <div class="ai-row">
          <label class="field">Fournisseur
            <select id="ai-provider">${PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          </label>
          <label class="field"><span id="ai-url-label">Adresse</span>
            <input id="ai-url" type="url" spellcheck="false">
          </label>
          <label class="field">Modèle
            <input id="ai-model" spellcheck="false">
          </label>
          <label class="field" id="ai-code-field" hidden title="Code demandé par la passerelle (variable READER3D_ACCESS_CODE dans Vercel), gardé dans ce navigateur.">Code d'accès
            <input id="ai-code" type="password" autocomplete="off" spellcheck="false">
          </label>
          <label class="check" id="ai-think-field" title="Le modèle raisonne avant de répondre : réponses plus sûres, mais bien plus lentes sur un PC sans carte graphique. Le raisonnement s'affiche sous la réponse."><input type="checkbox" id="ai-think"> Réflexion du modèle (plus lent)</label>
          <label class="check" id="ai-amounts-field" hidden title="Sans cette case, la passerelle reçoit la trace du chiffrage sans les montants internes (taux, coûts, prix, marges, pertes au feu, TRS) : leurs sources et leurs écarts relatifs seulement. Le modèle local (Ollama) reçoit toujours la trace complète, rien ne quitte le site."><input type="checkbox" id="ai-amounts"> Envoyer les montants internes du chiffrage à la passerelle</label>
          <button id="ai-test" class="btn" type="button">Tester la connexion</button>
        </div>
        <div class="ai-row ai-tasks" role="group" aria-label="Type d'analyse">
          ${TASKS.map(([v, l]) => `<button type="button" class="small ai-task" data-task="${v}" aria-pressed="${v === "general"}">${l}</button>`).join("")}
        </div>
      </section>

      <section class="card">
        <div id="ai-chat" class="ai-chat" aria-live="polite"></div>
        <form id="ai-form" class="ai-form">
          <textarea id="ai-input" rows="4" placeholder="Posez une question sur la pièce, les features, la fabrication ou le coût… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea>
          <div class="ai-actions">
            <button id="ai-send" class="btn primary" type="submit">Envoyer</button>
            <button id="ai-cancel" class="btn" type="button" hidden>Annuler</button>
            <button id="ai-clear" class="btn small" type="button">Nouvelle conversation</button>
          </div>
        </form>
      </section>
    </div>`;

  const $ = (id) => page.querySelector("#" + id);
  let task = "general";
  let busy = null; // AbortController of the question in progress
  let messages = [];
  try {
    messages = JSON.parse(store.get(sessionStorage, KEYS.messages) || "[]");
    if (!Array.isArray(messages)) messages = [];
  } catch {
    messages = [];
  }
  const saveMessages = () => store.set(sessionStorage, KEYS.messages, JSON.stringify(messages));

  const provider = () => $("ai-provider").value;
  const isLocal = () => provider() === "ollama";
  let codeRequired = false; // the gateway asks for an access code
  let gatewayInfo = null; // {key, data}: the configuration the gateway gave, for its address and code

  /** The access code field: shown when the gateway asks for one, or when one is kept. */
  function showCode(required = codeRequired) {
    codeRequired = !!required;
    $("ai-code-field").hidden = isLocal() || !(codeRequired || $("ai-code").value);
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
    $("ai-model").placeholder = local ? OLLAMA_MODEL : "modèle par défaut de la passerelle";
    $("ai-think-field").hidden = !local;
    $("ai-amounts-field").hidden = local || task !== "costing";
    showCode();
  }
  {
    $("ai-code").value = store.get(localStorage, KEYS.code) || "";
    const saved = store.get(localStorage, KEYS.provider);
    // Older versions stored "openai_compatible" for Ollama.
    $("ai-provider").value = saved === "openai_compatible" ? "ollama" : saved === "openai" || saved === "ollama" ? saved : "ollama";
    showProvider();
    $("ai-think").checked = store.get(localStorage, KEYS.think) === "1";
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
    $("ai-chat").scrollTop = $("ai-chat").scrollHeight;
    return body;
  }

  /** Under the label of a costing answer: whether every number it cites is in the trace sent (chiffrage/ai-trace.js checkNumbers). */
  function showCheck(body, check) {
    const line = document.createElement("div");
    line.className = `ai-check ${check.verifiee ? "ok" : "bad"}`;
    const n = check.inconnus.length;
    line.textContent = check.verifiee
      ? check.nombres ? "Vérifiée : chaque nombre cité figure dans la trace du chiffrage." : "Aucun nombre cité."
      : `Réponse non vérifiée : ${n > 1 ? `${n} nombres absents` : "un nombre absent"} de la trace du chiffrage (${check.inconnus.join(" ; ")}).`;
    body.before(line);
  }

  for (const m of messages) {
    const body = bubble(m.role, m.role === "assistant" ? formatAnswer(m.content) : m.content, !!m.costing);
    if (m.costing) showCheck(body, m.costing);
  }

  function setStatus(text) {
    $("ai-status").textContent = text;
  }

  /**
   * The context of the question: the part shown, or none (general questions
   * are allowed without a model); for the task "Chiffrage", the traced values
   * of the quote (costing_trace, read only): smaller for the local model; for
   * the gateway, its internal amounts masked unless the box is ticked, within
   * two thirds of the gateway's budget (`budget`, characters) as for the
   * local model.
   */
  async function contextForCurrentTask(local, budget = GATEWAY_CONTEXT_CHARS) {
    const semantic = reader.semantic;
    const aiTask = task === "costing" ? "manufacturing_analysis" : task;
    const context = semantic ? buildAIContext(semantic, { task: aiTask }) : {
      schema: "3d-ai-reasoning-context",
      schema_version: "1.0",
      task: aiTask,
      no_model_loaded: true,
      note: "Aucun modèle 3D n'est chargé : aucune donnée de pièce n'est disponible.",
      model: null,
      bodies: [],
      warnings: [],
    };
    if (task !== "costing") return context;
    let snapshot = null;
    let problem = null;
    try {
      snapshot = (await reader.costing?.()) ?? null;
    } catch (err) {
      problem = `trace du chiffrage indisponible : ${err?.message || err}`;
    }
    const { traceForAI } = await import("./chiffrage/ai-trace.js");
    const costingTrace = traceForAI(snapshot, local ? { maxChars: LOCAL_TRACE_CHARS } : { mask: !$("ai-amounts").checked, maxChars: Math.round((budget * 2) / 3) });
    return { ...context, costing_trace: costingTrace, ...(problem ? { costing_note: problem } : {}) };
  }

  let timing = ""; // time spent by Ollama on the last answer, shown with it

  /** Ask the local Ollama, the answer shown as it is written. Resolves to the whole answer. */
  async function askOllama(question, context, signal, onText, onThought) {
    const base = ollamaBase($("ai-url").value.trim());
    const model = $("ai-model").value.trim() || OLLAMA_MODEL;
    const problem = await diagnoseOllama(base, model);
    if (problem) throw new Error(problem);
    // General questions: a summary of the part (read in seconds on a CPU); the analysis tasks: the detail.
    // The costing trace is kept whole by the compaction (the geometry has the room it leaves).
    const compact = context.no_model_loaded ? context : task === "general" ? summaryAIContext(context) : compactAIContext(context, { maxChars: LOCAL_CONTEXT_CHARS });
    const space = addressSpace(base);
    const system = `${systemPrompt(model, space === "loopback" ? "sur ce PC" : "sur un appareil du réseau local", task === "costing")}\n\nCONTEXTE :\n${JSON.stringify(compact)}`;
    const think = $("ai-think").checked;
    const reserve = think ? 4096 : 2048; // room for the answer, and for the reasoning written before it
    let history = messages.slice(-HISTORY).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
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
    let pending = "";
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
      pending += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
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

  /** A request to the gateway: its JSON answer, or an Error with its message (in French). */
  async function gatewayFetch(init = {}) {
    const url = $("ai-url").value.trim();
    if (!url) throw new Error(`Renseignez l'adresse de la passerelle : collez son adresse Vercel (${GATEWAY_EXAMPLE}, voir api/README.md), ou choisissez « Ollama local ».`);
    const code = $("ai-code").value.trim();
    let response;
    try {
      response = await fetch(url, { cache: "no-store", ...init, headers: { Accept: "application/json", ...init.headers, ...(code ? { "X-Reader3D-Code": code } : {}) } });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new Error(`La passerelle est injoignable (${url}) : vérifiez son adresse (${GATEWAY_EXAMPLE}) et qu'elle autorise cette page, ${location.origin} (READER3D_ALLOWED_ORIGINS dans Vercel).`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.access_code_required) showCode(true);
      const error = new Error((typeof data.error === "string" ? data.error : data.error?.message) || `La passerelle répond par une erreur HTTP ${response.status}.`);
      error.codeRequired = !!data.access_code_required;
      throw error;
    }
    return data;
  }

  /** The configuration of the gateway (GET): provider, model, context budget, access code; asked again when its address or the code changes. */
  async function gatewayConfig(signal) {
    const key = `${$("ai-url").value.trim()}\n${$("ai-code").value.trim()}`;
    if (gatewayInfo?.key === key) return gatewayInfo.data;
    const data = await gatewayFetch({ signal });
    gatewayInfo = { key, data };
    showCode(data.access_code_required);
    if (data.model) $("ai-model").placeholder = `${data.model} (par défaut)`;
    return data;
  }

  /** Ask the gateway, the context compacted to its budget. Resolves to its answer: {output, provider, model, quota}. */
  async function askGateway(question, context, signal, budget) {
    // General questions: a summary of the part; the analysis tasks: the detail, as much as the budget allows.
    const compact = context.no_model_loaded ? context : task === "general" ? summaryAIContext(context) : compactAIContext(context, { maxChars: budget });
    // The latest exchanges, while they take no more than half the room of the context.
    let history = messages.slice(-HISTORY).map(({ role, content }) => ({ role, content }));
    while (history.length && JSON.stringify(history).length > budget / 2) history = history.slice(2);
    const data = await gatewayFetch({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gateway_schema_version: "1.0",
        task,
        model: $("ai-model").value.trim() || undefined,
        context: compact,
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
    const costing = task === "costing";
    store.set(localStorage, KEYS.provider, provider());
    store.set(localStorage, local ? KEYS.ollama : KEYS.gateway, $("ai-url").value.trim() || null);
    store.set(localStorage, `${KEYS.model}.${provider()}`, $("ai-model").value.trim() || null);

    bubble("user", question);
    // Until the first words arrive: "Réflexion en cours…", in grey italics.
    const answerBox = bubble("assistant", "Réflexion en cours…", costing);
    answerBox.classList.add("ai-thinking");
    // The model's reasoning while it is written: one grey line under the answer, its latest words;
    // folded once the answer starts.
    const thoughtLine = document.createElement("div");
    thoughtLine.className = "ai-thought";
    thoughtLine.hidden = true;
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
    busy = new AbortController();
    $("ai-cancel").hidden = false;
    $("ai-send").disabled = true;
    const start = performance.now();
    let written = 0;
    const tick = () => {
      const s = Math.round((performance.now() - start) / 1000);
      setStatus(local
        ? written ? `Rédaction… ${s} s` : thought ? `Réflexion… ${s} s` : `Lecture du contexte par le modèle… ${s} s (sur un PC sans carte graphique, cela peut prendre quelques minutes)`
        : `Analyse… ${s} s`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      // The gateway's budget; an older gateway, without its configuration: the default one.
      const info = local ? null : await gatewayConfig(busy.signal).catch((err) => {
        if (err?.name === "AbortError") throw err;
        return null; // the question tells what is wrong
      });
      const budget = info?.context_chars > 0 ? info.context_chars : GATEWAY_CONTEXT_CHARS;
      const context = await contextForCurrentTask(local, budget);
      let answer = null; // of the gateway
      const output = local
        ? await askOllama(question, context, busy.signal, (text) => {
          showThought(inlineThinking(text));
          const visible = withoutThinking(text);
          if (!visible) return; // still thinking
          written = visible.length;
          foldThought();
          answerBox.classList.remove("ai-thinking");
          answerBox.textContent = visible;
          $("ai-chat").scrollTop = $("ai-chat").scrollHeight;
        }, showThought)
        : (answer = await askGateway(question, context, busy.signal, budget)).output;
      foldThought();
      answerBox.classList.remove("ai-thinking");
      answerBox.textContent = formatAnswer(output) || "(réponse vide)";
      // Costing: every number of the answer must be in the trace the model was given.
      let check = null;
      if (costing) {
        const { checkNumbers } = await import("./chiffrage/ai-trace.js");
        check = checkNumbers(costingText(output), context.costing_trace);
        showCheck(answerBox, check);
      }
      // Only answered questions are kept: a failed one is not sent again with the next.
      messages.push({ role: "user", content: question }, { role: "assistant", content: withoutThinking(output), ...(check ? { costing: check } : {}) });
      saveMessages();
      const source = answer ? gatewayLabel(answer) : "";
      setStatus(`Réponse en ${Math.round((performance.now() - start) / 1000)} s${local && timing ? ` (${timing})` : ""}${source ? ` · ${source}` : ""}`);
      timing = "";
    } catch (err) {
      answerBox.parentElement.remove();
      if (err?.name === "AbortError") {
        bubble("error", "Question annulée.");
        setStatus("Annulé");
      } else {
        bubble("error", err?.message || String(err));
        setStatus("Erreur");
      }
    } finally {
      clearInterval(timer);
      busy = null;
      $("ai-cancel").hidden = true;
      $("ai-send").disabled = false;
    }
  }

  $("ai-think").addEventListener("change", () => store.set(localStorage, KEYS.think, $("ai-think").checked ? "1" : null));
  $("ai-code").addEventListener("input", () => store.set(localStorage, KEYS.code, $("ai-code").value.trim() || null));
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
      setStatus(`Tâche : ${button.textContent}`);
      $("ai-input").focus();
    });
  });

  $("ai-cancel").addEventListener("click", () => busy?.abort());

  $("ai-clear").addEventListener("click", () => {
    busy?.abort();
    messages = [];
    saveMessages();
    $("ai-chat").replaceChildren();
    setStatus("Nouvelle conversation");
  });

  $("ai-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("ai-form").requestSubmit();
    }
  });

  $("ai-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const input = $("ai-input");
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    await send(question).catch((err) => bubble("error", err?.message || String(err)));
  });

  return {
    show() {
      $("ai-input")?.focus();
      if (!busy) setStatus(reader.semantic ? "Modèle analysé : posez votre question" : "Aucun modèle 3D chargé : questions générales possibles");
    },
  };
}
