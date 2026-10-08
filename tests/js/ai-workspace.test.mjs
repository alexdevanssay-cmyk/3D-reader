import test from "node:test";
import assert from "node:assert/strict";
import { addressSpace, answerText, costingText, defaultGateway, formatAnswer, gatewayLabel, numbersLabel } from "../../web/ai-workspace.js";
import { anonymizer, checkContextNumbers } from "../../web/engine/ai-context.js";

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

// A made-up context as the IA page sends it: the part (engine/ai-context.js) and the costing trace (chiffrage/ai-trace.js).
function syntheticContext() {
  const body = (id, name, extra = {}) => ({ id, name, role: "solid_body", metrics: { volume_mm3: 1000 }, ...extra });
  return {
    schema: "3d-ai-reasoning-context",
    task: "manufacturing_analysis",
    source: { file: "Carter Dupont 4711.step", kind: "cad", source_unit: "mm", engine: "browser" },
    model: { body_count: 5, metrics: { volume_mm3: 5000 } },
    bodies: [
      body("body-0", "Carter Dupont", {
        geometry: { analytic_surfaces: [{ type: "cylinder", radius_mm: 4 }] },
        features: [{ feature_id: "body-0/feature-1a2b", type: "possible_hole_or_bore", subtype: "cylinder", status: "provisional" }],
        quality: { closed: true, notes: ["Type A"] },
      }),
      body("body-1", "cylinder"), // named like a surface type: the types are left as they are
      body("body-2", "Vis"),
      body("body-3", "Carter Dupont"), // two bodies of the same name
      body("body-4", "A"), // too short to be replaced in a text
    ],
    warnings: ["features are geometric candidates, not guaranteed design intent"],
    costing_trace: {
      schema: "3d-reader-costing-trace",
      fichiers: { classeur: { nom: "Chiffrage Dupont v2.xlsm", date: "2026-01-02" }, indices: null, tendances: null, rfq: { nom: "RFQ Dupont 4711.xlsm", date: "2026-01-03" } },
      devis: { ensemble: true, valeurs: { "devis.alliage": { valeur: "AS7G03", source: "classeur « Chiffrage Dupont v2.xlsm »", autorite: "hard", confiance: "haute" } } },
      pieces: [
        { nom: "Carter Dupont", chiffree: true, valeurs: { "piece.poids": { valeur: 1.2, unite: "kg", ref: 'q.pieces["0:Carter Dupont"].poids', hypotheses: ["boîte à noyau « Noyau central » : 1 200 €"] } } },
        { nom: "Vis", chiffree: true, valeurs: {} },
      ],
      alertes: [{ piece: "Vis", cle: "piece.poids", type: "saisie ignorée", message: "Vis : poids saisi pour Carter Dupont" }],
    },
  };
}
const QUOTE_NAMES = [{ name: "Fonderies Martin", label: "Client" }, { name: "4711-B", label: "Référence" }, { name: "Noyau central", label: "Noyau 1" }];

test("the names sent online: neutral labels in place of the file, the bodies, the quote's names and its files; codes and numbers kept", () => {
  const context = syntheticContext();
  const copy = structuredClone(context);
  const names = anonymizer(context, QUOTE_NAMES);
  const sent = names.context(context);
  assert.deepEqual(context, copy, "the context itself is not changed");
  const text = JSON.stringify(sent);
  for (const name of ["Carter Dupont", "Dupont", "4711", "Vis", "Noyau central", "Chiffrage", "RFQ"]) assert.ok(!text.includes(name), name);
  assert.equal(sent.source.file, "Pièce.step");
  assert.deepEqual(sent.bodies.map((b) => b.name), ["Corps 1", "Corps 2", "Corps 3", "Corps 4", "Corps 5"]);
  // Codes are not names: the surface and feature types, the ids, the alloy.
  assert.equal(sent.bodies[0].geometry.analytic_surfaces[0].type, "cylinder");
  assert.equal(sent.bodies[0].features[0].subtype, "cylinder");
  assert.equal(sent.bodies[0].features[0].feature_id, "body-0/feature-1a2b");
  assert.equal(sent.costing_trace.devis.valeurs["devis.alliage"].valeur, "AS7G03");
  // A name of one letter: only where it is the whole value (the body's name), not in a text.
  assert.deepEqual(sent.bodies[0].quality.notes, ["Type A"]);
  // The costing trace: its pieces, alerts and files, and the names written in its texts.
  const trace = sent.costing_trace;
  assert.deepEqual(trace.pieces.map((p) => p.nom), ["Corps 1", "Corps 3"]);
  assert.equal(trace.pieces[0].valeurs["piece.poids"].ref, 'q.pieces["0:Corps 1"].poids');
  assert.deepEqual(trace.pieces[0].valeurs["piece.poids"].hypotheses, ["boîte à noyau « Noyau 1 » : 1 200 €"]);
  assert.deepEqual(trace.alertes[0], { piece: "Corps 3", cle: "piece.poids", type: "saisie ignorée", message: "Corps 3 : poids saisi pour Corps 1" });
  assert.deepEqual([trace.fichiers.classeur.nom, trace.fichiers.rfq.nom, trace.fichiers.indices], ["classeur de chiffrage", "demande client", null]);
  assert.equal(trace.devis.valeurs["devis.alliage"].source, "classeur « classeur de chiffrage »");
  assert.equal(trace.pieces[0].valeurs["piece.poids"].valeur, 1.2);
  // The question and the conversation: the same labels.
  assert.equal(names.text("Pourquoi le Carter Dupont de Fonderies Martin (4711-B) pèse-t-il plus que Vis ?"), "Pourquoi le Corps 1 de Client (Référence) pèse-t-il plus que Corps 3 ?");
  assert.equal(names.text("Carter Dupont 4711.step, Avis, Visserie, A"), "Pièce.step, Avis, Visserie, A");
  // The real names of the labels an answer writes, for the reader of the answer.
  assert.deepEqual(names.legend("Corps 3 est plus léger que Corps 4. La Pièce est un carter."), [["Corps 3", "Vis"], ["Corps 4", "Carter Dupont"], ["Pièce", "Carter Dupont 4711.step"]]);
  assert.deepEqual(names.legend("Corps 30 et Corps 1x : rien."), []);
  // Nothing to replace: a context without a part.
  const none = anonymizer({ no_model_loaded: true, bodies: [] });
  assert.deepEqual(none.context({ no_model_loaded: true, bodies: [], note: "Aucun modèle" }), { no_model_loaded: true, bodies: [], note: "Aucun modèle" });
  assert.equal(none.text("Bonjour"), "Bonjour");
});

test("the numbers of an answer checked against the data sent: rounded, in another unit, from the question; the others counted", () => {
  const context = {
    schema_version: "1.0",
    model: { metrics: { volume_mm3: 7257.4, surface_area_mm2: 3120.5, mass_g: 19.6, bbox_mm: { size: [40, 20, 12.5] }, fill_ratio: 0.725 } },
    bodies: [{ id: "body-0", name: "Corps 1", features: [{ confidence: 0.8, geometry: { radius_mm: 4, cone_semi_angle_rad: 0.0523599 } }] }],
  };
  const good = "Corps 1 : volume 7,257 cm³ (7 257 mm³), surface 31,2 cm², masse 0,0196 kg (19,6 g), enveloppe 4 × 2 × 1,25 cm, remplissage 72,5 %, perçage Ø 8 mm (rayon 4), dépouille 3°, confiance 80 %.";
  assert.deepEqual(checkContextNumbers(good, context), { nombres: 14, inconnus: [] });
  // Invented: a thickness, a count; a number of the question is not.
  assert.deepEqual(checkContextNumbers(`${good} Épaisseur 3,5 mm, 15 noyaux, pour 5 000 pièces.`, context, ["Et pour 5000 pièces ?"]).inconnus, ["3,5", "15"]);
  // The version of the context is no data.
  assert.deepEqual(checkContextNumbers("Contexte en version 1.0", { schema_version: "1.0" }).inconnus, ["1.0"]);
  // The costing trace: percentages in percent, written as fractions too.
  assert.deepEqual(checkContextNumbers("TRS 85 % (0,85), écart -14,3 %", { costing_trace: { v: { valeur: 85, unite: "%", ecart_tendance: { ecart_pct: -14.3 } } } }).inconnus, []);
});

test("the text of an answer whose numbers are checked, and the label of those that come from none of the data sent", () => {
  assert.equal(answerText(JSON.stringify({ conclusion: "Volume 7,3 cm³", observations: ["2 corps"], analyse_chiffrage: null })), "Volume 7,3 cm³\n2 corps");
  assert.equal(answerText("<think>12 mm</think>Volume 7,3 cm³"), "Volume 7,3 cm³");
  assert.equal(numbersLabel(["3,5"]), "1 nombre ne vient pas des données envoyées");
  assert.equal(numbersLabel(["3,5", "15"]), "2 nombres ne viennent pas des données envoyées");
});
