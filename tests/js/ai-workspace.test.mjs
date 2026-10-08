import test from "node:test";
import assert from "node:assert/strict";
import { addressSpace, costingText, formatAnswer } from "../../web/ai-workspace.js";

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

test("the gateway asks for analyse_chiffrage, never a quote, and gives the costing trace read only", async () => {
  const { default: handler } = await import("../../api/ai.js");
  const trace = { schema: "3d-reader-costing-trace", lecture_seule: true, pieces: [{ nom: "A", valeurs: { "piece.prix.vente": { valeur: "masqué", unite: "€" } } }] };
  const requests = [];
  const { fetch } = globalThis;
  globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    // First the model reads the trace (a tool), then it answers.
    const output = requests.length === 1 ? [{ type: "function_call", name: "get_costing_trace", call_id: "c1", arguments: "{}" }] : [{ type: "message", role: "assistant", content: [] }];
    return new Response(JSON.stringify({ id: `r${requests.length}`, output }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  process.env.OPENAI_API_KEY = "test";
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
  try {
    await handler({ method: "POST", body: { context: { task: "manufacturing_analysis", costing_trace: trace }, messages: [{ role: "user", content: "Pourquoi ce prix ?" }] } }, res);
  } finally {
    globalThis.fetch = fetch;
    delete process.env.OPENAI_API_KEY;
  }
  assert.equal(res.code, 200);
  assert.equal(requests.length, 2);
  const { schema } = requests[0].text.format;
  assert.equal(schema.properties.quote, undefined);
  assert.ok(schema.required.includes("analyse_chiffrage") && !schema.required.includes("quote"));
  const analyse = schema.properties.analyse_chiffrage.anyOf.find((x) => x.type === "object");
  assert.deepEqual(analyse.required, ["explications", "ecarts_signales", "questions", "hypotheses"]);
  assert.deepEqual(analyse.properties.ecarts_signales.items.required, ["cle", "commentaire"]);
  assert.match(requests[0].instructions, /Never invent a price, rate, cycle time or number of cores, and only cite numbers present in costing_trace/);
  assert.match(requests[0].instructions, /You never set a value/);
  assert.ok(!requests[0].tools.some((t) => /costing_inputs/.test(t.name)));
  // The tool gives the trace as it was sent, nothing else.
  const result = requests[1].input.find((i) => i.type === "function_call_output");
  assert.deepEqual(JSON.parse(result.output), trace);
});
