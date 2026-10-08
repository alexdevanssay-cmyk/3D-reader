// "IA / analyse" page: questions on the part shown, answered either by a
// language model behind the AI gateway (api/ai.js, OpenAI Responses API) or by
// a local model run by Ollama on this computer (nothing leaves the PC).
//
// Local Ollama from a page on the web needs two permissions, both outside this
// page: Ollama must allow the page's origin (OLLAMA_ORIGINS), and the browser
// must allow the site to reach applications on this device ("Apps on device" /
// loopback-network permission of Chrome and Edge, Firefox "Device apps and
// services"). diagnoseOllama() tells which one is missing.

import { buildAIContext, compactAIContext } from "./engine/ai-context.js";

const PROVIDERS = [
  ["openai", "OpenAI / Responses API (gateway)"],
  ["ollama", "Ollama local (sur ce PC)"],
];
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "qwen3:8b";
// The context of a local model is kept small: its window (num_ctx) and the
// time to read the prompt on a CPU grow with it.
const LOCAL_CONTEXT_CHARS = 16000;
const LOCAL_HISTORY = 6; // messages of the conversation sent again with a question

const TASKS = [
  ["general", "Analyse générale"],
  ["feature_analysis", "Features"],
  ["manufacturing_analysis", "Fabrication"],
  ["dfm", "DFM"],
  ["planning", "Planification"],
  ["costing", "Chiffrage"],
];

const KEYS = { gateway: "reader3d.ai.gateway", ollama: "reader3d.ai.ollama", model: "reader3d.ai.model", provider: "reader3d.ai.provider", messages: "reader3d.ai.messages" };

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
  let parsed = null;
  try {
    parsed = JSON.parse(String(content).replace(/^\s*<think>[\s\S]*?<\/think>\s*/, ""));
  } catch {
    return String(content ?? "");
  }
  if (!parsed || typeof parsed !== "object") return String(content ?? "");
  const list = (title, items) => (Array.isArray(items) && items.length ? `${title} :\n- ${items.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n- ")}` : "");
  return [
    parsed.conclusion ?? "",
    list("Observations", parsed.observations),
    list("Inférences", parsed.inferences),
    list("Recommandations", parsed.recommendations),
    list("Incertitudes", parsed.uncertainties),
    parsed.quote ? `Chiffrage :\n${JSON.stringify(parsed.quote, null, 2)}` : "",
    parsed.needs_human_validation ? "Validation humaine requise." : "",
  ].filter(Boolean).join("\n\n");
}

/** State of the browser permission for this site to reach applications on this device (Chrome/Edge 142+, Firefox 153+), or null. */
async function loopbackPermission() {
  for (const name of ["loopback-network", "local-network-access"]) {
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
  let response;
  try {
    response = await fetch(`${base}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(8000), targetAddressSpace: "loopback" });
  } catch (err) {
    if (err?.name === "TimeoutError") return `Ollama (${base}) ne répond pas : vérifiez qu'il est lancé (icône du lama près de l'horloge).`;
    const permission = await loopbackPermission();
    if (permission?.state === "denied") {
      return `Le navigateur interdit à ce site d'accéder aux applications de ce PC (autorisation « Applications sur l'appareil » refusée).
Edge : ouvrez edge://settings/content/loopbackNetwork (Chrome : chrome://settings/content/loopbackNetwork), ajoutez ${origin} dans « Autorisé », puis rechargez la page.`;
    }
    return `Ollama est inaccessible depuis cette page (${origin}). Vérifiez, dans l'ordre :
1. Ollama est lancé (icône du lama près de l'horloge) : ${base} ouvert dans un nouvel onglet affiche « Ollama is running » ;
2. la variable d'environnement OLLAMA_ORIGINS contient ${origin} (origines séparées par des virgules, sans espace ni « / » final — sinon Ollama ne démarre pas), puis Ollama a été quitté et relancé ;
3. le navigateur autorise ce site à accéder aux « Applications sur l'appareil » (Edge : edge://settings/content/loopbackNetwork) — s'il le demande, cliquez sur Autoriser.
Le détail exact est affiché dans la console du navigateur (F12).`;
  }
  if (response.status === 403) return `Ollama refuse l'origine ${origin} : ajoutez-la à OLLAMA_ORIGINS, puis quittez et relancez Ollama.`;
  if (!response.ok) return `Ollama répond par une erreur HTTP ${response.status} sur ${base}/api/tags.`;
  const data = await response.json().catch(() => ({}));
  const names = (data.models ?? []).map((m) => m.name ?? m.model).filter(Boolean);
  const wanted = model.includes(":") ? model : `${model}:latest`;
  if (!names.includes(model) && !names.includes(wanted)) {
    return `Le modèle « ${model} » n'est pas installé dans Ollama${names.length ? ` (installés : ${names.join(", ")})` : ""}. Installez-le avec : ollama pull ${model}`;
  }
  return null;
}

/** The gateway of this deployment: api/ai.js is served with the site on Vercel, not on GitHub Pages. */
function defaultGateway() {
  return /\.vercel\.app$/.test(location.hostname) ? new URL("/api/ai", location.origin).href : "";
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

// The answer contract, given to Ollama as a JSON schema (structured output).
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    inferences: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    needs_human_validation: { type: "boolean" },
    quote: { type: ["object", "null"] },
  },
  required: ["conclusion", "observations", "inferences", "recommendations", "uncertainties", "needs_human_validation"],
};

/** Window (tokens) asked of Ollama for a prompt of this many characters: room for the answer, never below the default. */
function contextWindow(chars) {
  const tokens = Math.ceil(chars / 3) + 2048;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

const SYSTEM_PROMPT = `Tu es l'assistant d'ingénierie de 3D Reader, pour une fonderie. Réponds en français.
N'utilise que le contexte fourni (analyse géométrique et sémantique de la pièce, connaissances fonderie).
N'invente jamais de dimensions, de paramètres de procédé, de propriétés matière, de probabilités de défaut, d'attaques, de masselottes ni de résultats de simulation.
Distingue ce qui est mesuré, ce qui est déduit, ce qui est recommandé et ce qui manque.
Pour la fonderie, cite les identifiants de sources fournis et dis clairement quand une conclusion demande une simulation de remplissage/solidification ou une validation fonderie.
Si le contexte est partiel (champ "compaction"), dis-le quand cela limite la réponse.
Si aucun modèle 3D n'est chargé (champ "no_model_loaded"), réponds de façon générale (fonderie, procédés, chiffrage, méthode) sans prétendre connaître une pièce, et propose d'ouvrir le modèle si la question en dépend.
Réponds UNIQUEMENT par un JSON valide de cette forme :
{"conclusion":"","observations":[],"inferences":[],"recommendations":[],"uncertainties":[],"needs_human_validation":true,"quote":null}`;

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

  function showProvider() {
    const local = isLocal();
    $("ai-url-label").textContent = local ? "Adresse d'Ollama" : "Adresse du AI Gateway";
    const savedGateway = store.get(localStorage, KEYS.gateway);
    // Older versions stored the Ollama address, or the Vercel analysis API, as the gateway.
    const gateway = savedGateway && !/:11434|\/api\/analyze/.test(savedGateway) ? savedGateway : defaultGateway();
    $("ai-url").value = local ? store.get(localStorage, KEYS.ollama) || OLLAMA_URL : gateway;
    $("ai-url").placeholder = local ? OLLAMA_URL : "https://<votre-gateway>/api/ai";
    const savedModel = store.get(localStorage, `${KEYS.model}.${provider()}`);
    $("ai-model").value = savedModel || (local ? OLLAMA_MODEL : "");
    $("ai-model").placeholder = local ? OLLAMA_MODEL : "modèle par défaut du gateway";
  }
  {
    const saved = store.get(localStorage, KEYS.provider);
    // Older versions stored "openai_compatible" for Ollama.
    $("ai-provider").value = saved === "openai_compatible" ? "ollama" : saved === "openai" || saved === "ollama" ? saved : "ollama";
    showProvider();
  }

  function bubble(role, text = "") {
    const box = document.createElement("div");
    box.className = `ai-msg ${role === "user" ? "ai-user" : role === "error" ? "ai-error" : "ai-assistant"}`;
    const who = document.createElement("strong");
    who.textContent = role === "user" ? "Vous" : role === "error" ? "Erreur" : "IA";
    const body = document.createElement("div");
    body.className = "ai-text";
    body.textContent = text;
    box.append(who, body);
    $("ai-chat").append(box);
    $("ai-chat").scrollTop = $("ai-chat").scrollHeight;
    return body;
  }
  for (const m of messages) bubble(m.role, m.role === "assistant" ? formatAnswer(m.content) : m.content);

  function setStatus(text) {
    $("ai-status").textContent = text;
  }

  /** The context of the question: the part shown, or none (general questions are allowed without a model). */
  function contextForCurrentTask() {
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
    return {
      ...context,
      costing_inputs: reader.part?.() || null,
      costing_contract: {
        currency: "EUR",
        quantity_required: true,
        machine_hourly_rate_required: true,
        material_price_required: true,
        finishing_price_required: false,
        assumptions_must_be_explicit: true,
      },
    };
  }

  /** Ask the local Ollama, the answer shown as it is written. Resolves to the whole answer. */
  async function askOllama(question, context, signal, onText) {
    const base = ollamaBase($("ai-url").value.trim());
    const model = $("ai-model").value.trim() || OLLAMA_MODEL;
    const problem = await diagnoseOllama(base, model);
    if (problem) throw new Error(problem);
    const compact = compactAIContext(context, { maxChars: LOCAL_CONTEXT_CHARS });
    const system = `${SYSTEM_PROMPT}\n\nCONTEXTE :\n${JSON.stringify(compact)}`;
    const numCtx = contextWindow(system.length + JSON.stringify(messages.slice(-LOCAL_HISTORY)).length + question.length);
    const history = messages.slice(-LOCAL_HISTORY).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
    const body = {
      model,
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: question }],
      stream: true,
      format: ANSWER_SCHEMA,
      think: false, // Qwen3 would otherwise write a long hidden reasoning first
      keep_alive: "15m", // the model stays loaded between questions (loading it takes long on a CPU)
      options: { num_ctx: numCtx, temperature: 0.2 },
    };
    const post = (payload) => fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      targetAddressSpace: "loopback",
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
        if (chunk.message?.content) {
          answer += chunk.message.content;
          onText(answer);
        }
      }
    }
    if (last?.done_reason === "length") answer += "\n\n(Réponse coupée : limite de longueur atteinte.)";
    if (last?.prompt_eval_count >= 0.95 * numCtx) console.warn(`Ollama: prompt of ${last.prompt_eval_count} tokens for a window of ${numCtx}: the start of the context may have been dropped`);
    return answer;
  }

  async function askGateway(question, context, signal) {
    const url = $("ai-url").value.trim();
    if (!url) throw new Error("Renseignez l'adresse du AI Gateway (déployé sur Vercel, voir api/README.md), ou choisissez « Ollama local ».");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        gateway_schema_version: "1.0",
        provider: "openai",
        model: $("ai-model").value.trim() || undefined,
        context,
        messages: [...messages, { role: "user", content: question }],
      }),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = typeof data.error === "string" ? data.error : data.error?.message;
      throw new Error(error || `Gateway HTTP ${response.status}`);
    }
    return data.output || data.text || "";
  }

  async function send(question) {
    const context = contextForCurrentTask();
    const local = isLocal();
    store.set(localStorage, KEYS.provider, provider());
    store.set(localStorage, local ? KEYS.ollama : KEYS.gateway, $("ai-url").value.trim() || null);
    store.set(localStorage, `${KEYS.model}.${provider()}`, $("ai-model").value.trim() || null);

    bubble("user", question);
    // Until the first words arrive: "Réflexion en cours…", in grey italics.
    const answerBox = bubble("assistant", "Réflexion en cours…");
    answerBox.classList.add("ai-thinking");
    busy = new AbortController();
    $("ai-cancel").hidden = false;
    $("ai-send").disabled = true;
    const start = performance.now();
    let written = 0;
    const tick = () => {
      const s = Math.round((performance.now() - start) / 1000);
      setStatus(local
        ? written ? `Rédaction… ${s} s` : `Lecture du contexte par le modèle… ${s} s (sur un PC sans carte graphique, cela peut prendre quelques minutes)`
        : `Analyse… ${s} s`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const output = local
        ? await askOllama(question, context, busy.signal, (text) => {
          written = text.length;
          answerBox.classList.remove("ai-thinking");
          answerBox.textContent = text;
          $("ai-chat").scrollTop = $("ai-chat").scrollHeight;
        })
        : await askGateway(question, context, busy.signal);
      answerBox.classList.remove("ai-thinking");
      answerBox.textContent = formatAnswer(output) || "(réponse vide)";
      // Only answered questions are kept: a failed one is not sent again with the next.
      messages.push({ role: "user", content: question }, { role: "assistant", content: output });
      saveMessages();
      setStatus(`Réponse en ${Math.round((performance.now() - start) / 1000)} s`);
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

  $("ai-provider").addEventListener("change", () => {
    store.set(localStorage, KEYS.provider, provider());
    showProvider();
  });

  $("ai-test").addEventListener("click", async () => {
    if (!isLocal()) {
      setStatus($("ai-url").value.trim() ? "Gateway configuré (testé à la première question)" : "Adresse du gateway manquante");
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
