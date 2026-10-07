import { buildAIContext } from "./engine/ai-context.js";

const PROVIDERS = [
  ["openai", "OpenAI / Responses API"],
  ["openai_compatible", "OpenAI-compatible / local"],
];

const TASKS = [
  ["general", "Analyse générale"],
  ["feature_analysis", "Features"],
  ["manufacturing_analysis", "Fabrication"],
  ["dfm", "DFM"],
  ["planning", "Planification"],
  ["costing", "Chiffrage"],
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

export function mount({ page, reader }) {
  if (!page) return { show() {} };
  page.innerHTML = `
    <div class="panel" style="max-width:1100px;margin:0 auto;padding:24px">
      <section class="card">
        <div class="card-head">
          <h2>IA / analyse</h2>
          <span id="ai-status" class="muted small">Non connecté</span>
        </div>
        <div class="row" style="flex-wrap:wrap">
          <label class="field">Gateway
            <input id="ai-gateway" type="url" placeholder="https://votre-gateway.example/api/ai" style="min-width:360px">
          </label>
          <label class="field">Provider
            <select id="ai-provider">${PROVIDERS.map(([v,l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          </label>
          <label class="field">Modèle
            <input id="ai-model" value="gpt-6-astra" style="min-width:180px">
          </label>
          <button id="ai-connect" class="btn primary" type="button">Connecter</button>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px">
          ${TASKS.map(([v,l]) => `<button type="button" class="small ai-task" data-task="${v}">${l}</button>`).join("")}
        </div>
      </section>

      <section class="card">
        <div id="ai-chat" style="display:grid;gap:10px;max-height:52vh;overflow:auto"></div>
        <form id="ai-form" class="row" style="align-items:flex-end;margin-top:12px">
          <textarea id="ai-input" rows="4" placeholder="Posez une question sur la pièce, les features, la fabrication ou le coût…" style="flex:1;min-width:280px"></textarea>
          <button class="btn primary" type="submit">Envoyer</button>
        </form>
      </section>
    </div>`;

  const $ = (id) => page.querySelector("#" + id);
  let task = "general";
  let messages = [];

  function add(role, content) {
    const box = document.createElement("div");
    box.style.cssText = "padding:10px 12px;border-radius:8px;white-space:pre-wrap";
    box.style.background = role === "user" ? "var(--panel, #eef)" : "var(--card, #f5f5f5)";
    box.innerHTML = `<strong>${role === "user" ? "Vous" : "IA"}</strong><br>${escapeHtml(content)}`;
    $("ai-chat").append(box);
    $("ai-chat").scrollTop = $("ai-chat").scrollHeight;
  }

  function contextForCurrentTask() {
    const semantic = reader.semantic;
    if (!semantic) throw new Error("Analysez d'abord un modèle 3D.");
    const context = buildAIContext(semantic, { task: task === "costing" ? "manufacturing_analysis" : task });
    if (task === "costing") {
      return {
        ...context,
        costing_inputs: reader.part?.() || null,
        costing_contract: {
          currency: "EUR",
          quantity_required: true,
          machine_hourly_rate_required: true,
          material_price_required: true,
          finishing_price_required: false,
          assumptions_must_be_explicit: true
        }
      };
    }
    return context;
  }

  async function send(content) {
    const gatewayUrl = $("ai-gateway").value.trim();
    if (!gatewayUrl) throw new Error("Renseignez l'URL du AI Gateway.");
    const context = contextForCurrentTask();
    messages.push({ role: "user", content });
    add("user", content);
    $("ai-status").textContent = "Analyse…";
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        gateway_schema_version: "1.0",
        provider: $("ai-provider").value,
        model: $("ai-model").value.trim() || undefined,
        context,
        messages
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Gateway HTTP ${response.status}`);
    const output = data.output || data.text || "";
    messages.push({ role: "assistant", content: output });
    add("assistant", output);
    $("ai-status").textContent = "Connecté";
  }

  $("ai-connect").addEventListener("click", () => {
    $("ai-status").textContent = $("ai-gateway").value.trim() ? "Gateway configuré" : "URL manquante";
  });

  page.querySelectorAll(".ai-task").forEach((button) => {
    button.addEventListener("click", () => {
      task = button.dataset.task;
      $("ai-status").textContent = `Tâche : ${button.textContent}`;
      $("ai-input").focus();
    });
  });

  $("ai-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("ai-input");
    const content = input.value.trim();
    if (!content) return;
    input.value = "";
    try {
      await send(content);
    } catch (error) {
      $("ai-status").textContent = "Erreur";
      add("assistant", `Erreur : ${error.message || error}`);
    }
  });

  return {
    show() {
      $("ai-input")?.focus();
      $("ai-status").textContent = reader.semantic ? "Modèle analysé" : "Analysez un modèle 3D";
    }
  };
}
