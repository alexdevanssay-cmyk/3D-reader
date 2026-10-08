import test from "node:test";
import assert from "node:assert/strict";
import { addressSpace, costingText, defaultGateway, formatAnswer, gatewayLabel } from "../../web/ai-workspace.js";

test("Ollama's address declares the address space the browser checks it against", () => {
  // This computer.
  for (const url of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) assert.equal(addressSpace(url), "loopback", url);
  // Another device of the local network, a Jetson for instance.
  for (const url of ["http://192.168.1.50:11434", "http://10.0.0.7:11434", "http://172.20.1.1:11434", "http://jetson.local:11434", "http://jetson:11434", "http://[fd12:3456::1]:11434"]) {
    assert.equal(addressSpace(url), "local", url);
  }
  // Public addresses: nothing declared.
  for (const url of ["https://api.example.com", "http://203.0.113.5:11434", "http://172.32.1.1:11434"]) assert.equal(addressSpace(url), undefined, url);
});

test("a costing answer of the gateway: analyse_chiffrage laid out, its text checked; no quote", () => {
  const answer = JSON.stringify({
    conclusion: "Prix à valider.",
    observations: [], inferences: [], recommendations: [], uncertainties: [],
    needs_human_validation: true,
    analyse_chiffrage: {
      explications: ["piece.prix.vente : 26,47 €, calculé à partir de piece.prix.pri."],
      ecarts_signales: [{ cle: "centre.CG3.trs", commentaire: "écart de -14,3 % à la tendance" }],
      questions: ["Le TRS de CG3 est-il à jour ?"],
      hypotheses: [],
    },
  });
  const text = formatAnswer(answer);
  assert.match(text, /^Prix à valider\.\n\nAnalyse du chiffrage :\nExplications :\n- piece\.prix\.vente : 26,47 €/);
  assert.match(text, /Écarts signalés :\n- centre\.CG3\.trs : écart de -14,3 % à la tendance\nQuestions :\n- Le TRS de CG3 est-il à jour \?\n\nValidation humaine requise\./);
  assert.doesNotMatch(text, /Hypothèses|Chiffrage :\n\{/);
  // The numbers checked: those of analyse_chiffrage only (the plain text of Ollama: all of it).
  assert.equal(costingText(answer), "piece.prix.vente : 26,47 €, calculé à partir de piece.prix.pri.\ncentre.CG3.trs\nécart de -14,3 % à la tendance\nLe TRS de CG3 est-il à jour ?");
  assert.equal(costingText("<think>12 €</think>Le prix est de 26,47 €."), "Le prix est de 26,47 €.");
  assert.equal(costingText(JSON.stringify({ conclusion: "3 corps", analyse_chiffrage: null })), "");
  // An earlier answer with a quote: no longer shown as a costing.
  assert.equal(formatAnswer(JSON.stringify({ conclusion: "x", quote: { total: 12 } })), "x");
});

test("the gateway's address: the site's own on Vercel, pasted on GitHub Pages", () => {
  assert.equal(defaultGateway(new URL("https://3-d-reader-git-groq-cycle-ai-3-d-madness.vercel.app/?page=ia")), "https://3-d-reader-git-groq-cycle-ai-3-d-madness.vercel.app/api/ai");
  assert.equal(defaultGateway(new URL("https://alexdevanssay-cmyk.github.io/3D-reader/")), "");
  assert.equal(defaultGateway(new URL("http://127.0.0.1:8000/")), "");
});

test("an answer of the gateway tells its provider, model and the questions left today", () => {
  const quota = { requests_remaining_day: 1234, requests_limit_day: 2000, tokens_remaining_minute: 5000, tokens_limit_minute: 8000 };
  assert.equal(gatewayLabel({ provider: "Groq", model: "openai/gpt-oss-120b", quota }), "Groq · openai/gpt-oss-120b · 1\u202f234 questions restantes aujourd'hui");
  assert.equal(gatewayLabel({ provider: "Groq", model: "openai/gpt-oss-120b", quota: { requests_remaining_day: 1 } }), "Groq · openai/gpt-oss-120b · 1 question restante aujourd'hui");
  assert.equal(gatewayLabel({ provider: "Groq", model: "openai/gpt-oss-120b", quota: { requests_remaining_day: 0 } }), "Groq · openai/gpt-oss-120b · 0 question restante aujourd'hui");
  // Unknown quota (another provider), or an older gateway.
  assert.equal(gatewayLabel({ provider: "Mistral", model: "m", quota: null }), "Mistral · m");
  assert.equal(gatewayLabel({ output: "x" }), "");
});
