import test from "node:test";
import assert from "node:assert/strict";
import { addressSpace, answerText, costingText, defaultGateway, formatAnswer, gatewayLabel, isMarkdown, markdownToHtml, numbersLabel, proposalsOf, questionsLeft, quotaLabel, selectionOf, onlineMessages, unreadableProposals } from "../../web/ai-workspace.js";
import { anonymizer, checkContextNumbers, partNames } from "../../web/engine/ai-context.js";

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

test("an answer of the gateway tells its provider and model, and the questions left today apart", () => {
  const quota = { requests_remaining_day: 1234, requests_limit_day: 2000, tokens_remaining_minute: 5000, tokens_limit_minute: 8000 };
  assert.equal(gatewayLabel({ provider: "Groq", model: "openai/gpt-oss-120b", quota }), "Groq · openai/gpt-oss-120b");
  assert.equal(quotaLabel(quota), "1\u202f234 questions restantes aujourd'hui");
  assert.equal(quotaLabel({ requests_remaining_day: 1 }), "1 question restante aujourd'hui");
  assert.equal(quotaLabel({ requests_remaining_day: 0 }), "0 question restante aujourd'hui");
  // Unknown quota (another provider, or OpenAI counting per minute), or an older gateway.
  assert.equal(quotaLabel(null), "");
  assert.equal(quotaLabel({ requests_remaining: 50 }), "");
  assert.equal(gatewayLabel({ provider: "Mistral", model: "m", quota: null }), "Mistral · m");
  assert.equal(gatewayLabel({ output: "x" }), "");
});

test("the questions left today, from the tokens: those of a day, less the requests made from every PC, at the mean tokens of a question", () => {
  const quota = { requests_remaining_day: 900, requests_limit_day: 1000, tokens_limit_day: 200000, tokens_limit_minute: 8000 };
  // 100 requests today (any PC) of 1 000 tokens on average: 100 000 tokens left, questions of 5 000 tokens: 20.
  const tokens = { questions: [4000, 6000], all: [4000, 6000, ...Array(16).fill(500)] };
  assert.deepEqual(questionsLeft(quota, tokens), { left: 20, perQuestion: 5000, measured: 2, requests: 100, used: 100000, perDay: 200000 });
  assert.equal(quotaLabel(quota, tokens), "≈ 20 questions restantes aujourd'hui");
  // No question of the IA page yet (the Chiffrage page asked): the requests of any kind.
  assert.equal(questionsLeft(quota, { questions: [], all: [1000] }).left, 100);
  // Never more than the requests left, never less than 0.
  assert.equal(questionsLeft({ ...quota, requests_limit_day: 103, requests_remaining_day: 3 }, tokens).left, 3);
  assert.equal(quotaLabel({ ...quota, requests_limit_day: 101, requests_remaining_day: 1 }, tokens), "≈ 1 question restante aujourd'hui");
  assert.equal(questionsLeft({ ...quota, requests_remaining_day: 700 }, { questions: [5000], all: [5000] }).left, 0);
  // Without the tokens of a day, or none measured yet: the requests left.
  assert.equal(questionsLeft({ requests_remaining_day: 900, requests_limit_day: 1000 }, tokens), null);
  assert.equal(quotaLabel({ requests_remaining_day: 900, requests_limit_day: 1000 }, tokens), "900 questions restantes aujourd'hui");
  assert.equal(quotaLabel(quota, { questions: [], all: [] }), "900 questions restantes aujourd'hui");
  assert.equal(quotaLabel(quota), "900 questions restantes aujourd'hui");
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
      alertes: [{ pieces: ["Vis", "Carter Dupont"], cle: "piece.poids", type: "saisie ignorée", message: "Vis : poids saisi pour Carter Dupont" }],
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
  assert.deepEqual(trace.alertes[0], { pieces: ["Corps 3", "Corps 1"], cle: "piece.poids", type: "saisie ignorée", message: "Corps 3 : poids saisi pour Corps 1" });
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

test("the names of the part not sent are replaced too: a body not selected, the file when no body is sent", () => {
  const all = partNames({ bodies: ["CARTER-4711-A", "COUVERCLE-9022"], file: "Projet X.step" });
  assert.deepEqual(all, [
    { name: "CARTER-4711-A", label: "Corps 1" }, { name: "COUVERCLE-9022", label: "Corps 2" },
    { name: "Projet X.step", label: "Pièce.step" }, { name: "Projet X", label: "Pièce" },
  ]);
  // Only the carter selected: its context holds it alone, the cover named in the question is replaced all the same.
  const names = anonymizer({ source: { file: "Projet X.step" }, bodies: [{ id: "body-0", name: "CARTER-4711-A" }] }, all);
  assert.equal(names.text("Compare CARTER-4711-A et COUVERCLE-9022 de Projet X"), "Compare Corps 1 et Corps 2 de Pièce");
  assert.deepEqual(names.legend("Corps 2 est plus léger."), [["Corps 2", "COUVERCLE-9022"]]);
  // No body checked: the context has no part, the file name is replaced.
  assert.equal(anonymizer({ no_model_loaded: true, bodies: [] }, all).text("Que sais-tu de Projet X.step ?"), "Que sais-tu de Pièce.step ?");
  assert.deepEqual(partNames(), []);
  // A body that bears the file's name, not sent: its own label, whatever the bodies sent.
  const part = partNames({ bodies: ["04R504033", "04R504033-NOYAU"], file: "04R504033.step" });
  const one = anonymizer({ source: { file: "04R504033.step" }, bodies: [{ id: "body-1", name: "04R504033-NOYAU" }] }, [], part);
  assert.equal(one.text("Et 04R504033 face à 04R504033-NOYAU ?"), "Et Corps 1 face à Corps 2 ?");
  assert.equal(one.text("Le fichier 04R504033.step"), "Le fichier Pièce.step");
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

test("the conversation sent online: never what the local model answered (real names, internal amounts), nor its question", () => {
  const messages = [
    { role: "user", content: "Résume la pièce." },
    { role: "assistant", content: "Une boîte." },
    { role: "user", content: "Quel taux pour ce centre ?" },
    { role: "assistant", content: "Taux horaire du centre : 42,5 €/h ; client Fonderie Exemple.", local: true, notice: "Quota en ligne atteint : réponse du modèle local (qwen3:8b)" },
    { role: "user", content: "Et les faces ?" },
    { role: "assistant", content: "Six faces." },
  ];
  assert.deepEqual(onlineMessages(messages).map((m) => m.content), ["Résume la pièce.", "Une boîte.", "Et les faces ?", "Six faces."]);
  assert.deepEqual(onlineMessages(messages.slice(0, 4)).map((m) => m.content), ["Résume la pièce.", "Une boîte."]);
  assert.deepEqual(onlineMessages([]), []);
});

test("the conversation sent online: an answer given with the internal amounts of the costing only while they may go, to the same gateway", () => {
  const gateway = "https://exemple.vercel.app/api/ai";
  const messages = [
    { role: "user", content: "Pourquoi ce prix ?" },
    { role: "assistant", content: "Le prix de vente est masqué." },
    { role: "user", content: "Et le détail ?" },
    { role: "assistant", content: "Taux du centre : 42,5 €/h ; prix de vente 26,47 €.", amounts: true, gateway },
    { role: "user", content: "Et les faces ?" },
    { role: "assistant", content: "Six faces." },
  ];
  // The box unticked since: neither the answer nor its question.
  assert.deepEqual(onlineMessages(messages, { amounts: false, gateway }).map((m) => m.content), ["Pourquoi ce prix ?", "Le prix de vente est masqué.", "Et les faces ?", "Six faces."]);
  assert.deepEqual(onlineMessages(messages).map((m) => m.content), ["Pourquoi ce prix ?", "Le prix de vente est masqué.", "Et les faces ?", "Six faces."]);
  // Ticked, but another gateway: not either.
  assert.deepEqual(onlineMessages(messages, { amounts: true, gateway: "https://autre.vercel.app/api/ai" }).length, 4);
  // Ticked, the same gateway: the whole conversation.
  assert.deepEqual(onlineMessages(messages, { amounts: true, gateway }), messages);
  // An answer of the local model: never, whatever the box.
  assert.deepEqual(onlineMessages([{ role: "user", content: "Q" }, { role: "assistant", content: "R", local: true }], { amounts: true, gateway }), []);
});

test("an answer in Markdown is laid out, and nothing of it becomes a tag of its own", () => {
  const answer = "## Analyse\n**Conclusion** : 2 noyaux, `body-0`.\n\n| Élément | Valeur |\n|---|---|\n| Noyaux | 2 <img src=x onerror=alert(1)> |\n\n- tiroir *proposé*\n  - sous-point\n1. premier";
  assert.equal(isMarkdown(answer), true);
  assert.equal(isMarkdown("Conclusion : une boîte.\n- point"), false);
  const html = markdownToHtml(answer);
  assert.match(html, /<p class="ai-h">Analyse<\/p>/);
  assert.match(html, /<strong>Conclusion<\/strong> : 2 noyaux, <code>body-0<\/code>\./);
  assert.match(html, /<table class="ai-table"><thead><tr><th>Élément<\/th><th>Valeur<\/th><\/tr><\/thead><tbody><tr><td>Noyaux<\/td><td>2 &lt;img src=x onerror=alert\(1\)&gt;<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li>tiroir <em>proposé<\/em><ul><li>sous-point<\/li><\/ul><\/li><\/ul><ol><li>premier<\/li><\/ol>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(markdownToHtml("```\n<b>x</b>\n```"), /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
});

test("numbered lists keep their numbers: items under an item in a list of its own, a loose list one list", () => {
  // The bullets under step 1 are not counted: step 2 stays 2.
  assert.equal(markdownToHtml("1. Ouvrir\n   - a\n   - b\n2. Fermer"), "<ol><li>Ouvrir<ul><li>a</li><li>b</li></ul></li><li>Fermer</li></ol>");
  // Items between blank lines: one list, not "1. 1. 1.".
  assert.equal(markdownToHtml("1. A\n\n2. B\n\n3. C\n\nFin."), "<ol><li>A</li><li>B</li><li>C</li></ol><p>Fin.</p>");
  // A list that does not start at 1 keeps its first number; a line indented under an item is in it.
  assert.equal(markdownToHtml("3. Poser les noyaux\n   au robot\n4. Couler"), '<ol start="3"><li>Poser les noyaux<br>au robot</li><li>Couler</li></ol>');
  // A list of another kind after a blank line is a list of its own; text after a list, a paragraph.
  assert.equal(markdownToHtml("- a\n\n1. b\nTexte"), "<ul><li>a</li></ul><ol><li>b</li></ol><p>Texte</p>");
  // A list indented as a whole is a list.
  assert.equal(markdownToHtml("  - a\n  - b"), "<ul><li>a</li><li>b</li></ul>");
  // Three levels: each in the item above it, numbered on its own.
  assert.equal(markdownToHtml("1. Préparation\n   1. Nettoyer le moule\n      - vérifier les évents\n   2. Poser les noyaux\n2. Coulée"),
    "<ol><li>Préparation<ol><li>Nettoyer le moule<ul><li>vérifier les évents</li></ul></li><li>Poser les noyaux</li></ol></li><li>Coulée</li></ol>");
  // Indented with a tab.
  assert.equal(markdownToHtml("1. A\n\t1. x\n\t2. y\n2. B"), "<ol><li>A<ol><li>x</li><li>y</li></ol></li><li>B</li></ol>");
});

test("a line that starts with ``` and goes on is text, not a code block that swallows the answer", () => {
  assert.equal(markdownToHtml("Le corps le plus épais :\n```body-0``` (12 mm), à surveiller.\n\nRecommandation : **noyau** sable."),
    "<p>Le corps le plus épais :<br>``<code>body-0</code>`` (12 mm), à surveiller.</p><p>Recommandation : <strong>noyau</strong> sable.</p>");
  assert.equal(markdownToHtml("```js\n<b>x</b>\n```\nfin"), "<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre><p>fin</p>");
});

test("pipe lines that are no table (separator rows only) are shown as text, the answer kept", () => {
  for (const answer of ["Voici:\n|---|---|\nfin", "Élément | Valeur\n|---|---|\nNoyaux | 2", "a\n|||\nb", "**x**\n| - |"]) {
    assert.equal(isMarkdown(answer), true);
    const html = markdownToHtml(answer);
    assert.doesNotMatch(html, /<table/);
    assert.match(html, /<p>[^<]*\|/, answer);
  }
});

test("the bodies sent are told to the model, without their names", () => {
  assert.deepEqual(Object.keys(selectionOf({ mode: "selected", bodies_sent: 1, bodies_in_file: 18, names: ["Carter"] })), ["mode", "bodies_sent", "bodies_in_file", "note"]);
  assert.match(selectionOf({ mode: "selected", bodies_sent: 1, bodies_in_file: 18 }).note, /Seul le corps sélectionné/);
  assert.match(selectionOf({ mode: "checked", bodies_sent: 3, bodies_in_file: 18 }).note, /Seuls 3 des 18 corps/);
  assert.deepEqual(selectionOf({ mode: "all", bodies_sent: 18, bodies_in_file: 18 }), { mode: "all", bodies_sent: 18, bodies_in_file: 18 });
});

test("the proposals of the local model: its JSON block read and taken out of the answer, the text after it kept; one that cannot be read left as written", () => {
  const block = (json) => `\n\n\`\`\`json\n${json}\n\`\`\``;
  const ok = `Le poids saisi diffère.${block('{"propositions": [{"piece": "P", "cle": "piece.poids", "valeur": 1.35}]}')}\n\nÀ valider : le prix passerait à 31,40 €.`;
  assert.deepEqual(proposalsOf(ok), [{ piece: "P", cle: "piece.poids", valeur: 1.35 }]);
  assert.equal(formatAnswer(ok), "Le poids saisi diffère.\n\nÀ valider : le prix passerait à 31,40 €.");
  // The numbers after it still checked against the trace.
  assert.match(costingText(ok), /31,40/);
  assert.equal(unreadableProposals(ok), false);
  // A French decimal comma: not JSON, nothing to apply, the block shown and said.
  const bad = `Texte.${block('{"propositions": [{"cle": "piece.poids", "valeur": 1,35}]}')}`;
  assert.deepEqual(proposalsOf(bad), []);
  assert.match(formatAnswer(bad), /"propositions"/);
  assert.equal(unreadableProposals(bad), true);
  // Still being written: hidden while it streams.
  assert.equal(formatAnswer('Texte.\n\n```json\n{"propositions": [{"cle"'), "Texte.");
  // The gateway's JSON.
  assert.deepEqual(proposalsOf(JSON.stringify({ conclusion: "c", analyse_chiffrage: { propositions: [{ cle: "piece.cycle", valeur: 60 }] } })), [{ cle: "piece.cycle", valeur: 60 }]);
  assert.deepEqual(proposalsOf("Rien."), []);
});
