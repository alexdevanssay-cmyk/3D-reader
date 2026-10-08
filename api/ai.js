
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    inferences: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    needs_human_validation: { type: "boolean" },
    // Task "Chiffrage": reasoning on the traced values of the quote (context.costing_trace), never a value to apply.
    analyse_chiffrage: { anyOf: [
      { type: "null" },
      { type: "object", properties: {
        explications: { type: "array", items: { type: "string" } },
        ecarts_signales: { type: "array", items: { type: "object", properties: { cle: { type: "string" }, commentaire: { type: "string" } }, required: ["cle","commentaire"], additionalProperties: false } },
        questions: { type: "array", items: { type: "string" } },
        hypotheses: { type: "array", items: { type: "string" } }
      }, required: ["explications","ecarts_signales","questions","hypotheses"], additionalProperties: false }
    ] }
  },
  required: ["conclusion","observations","inferences","recommendations","uncertainties","needs_human_validation","analyse_chiffrage"],
  additionalProperties: false
};

const TOOL_DEFS = [
  { type:"function", name:"get_model_metrics", description:"Return global model metrics from the supplied semantic context.", parameters:{type:"object",properties:{},required:[],additionalProperties:false}, strict:true },
  { type:"function", name:"get_body", description:"Return one semantic body by body_id.", parameters:{type:"object",properties:{body_id:{type:"string"}},required:["body_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_feature", description:"Return one semantic feature by feature_id.", parameters:{type:"object",properties:{feature_id:{type:"string"}},required:["feature_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_manufacturing_plan", description:"Return manufacturing planning data for a body.", parameters:{type:"object",properties:{body_id:{type:"string"}},required:["body_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_costing_trace", description:"Return the traced values of the current quote supplied by 3D Reader (read-only): value, unit, source, authority, confidence, deviation from the trend, validation required, alerts. Internal amounts may be masked.", parameters:{type:"object",properties:{},required:[],additionalProperties:false}, strict:true },
  { type:"function", name:"get_foundry_analysis", description:"Return conservative foundry geometry screening for a body. It does not simulate filling or solidification.", parameters:{type:"object",properties:{body_id:{type:"string"}},required:["body_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_foundry_knowledge", description:"Return the sourced foundry engineering knowledge metadata included in the 3D Reader context.", parameters:{type:"object",properties:{},required:[],additionalProperties:false}, strict:true }
];

function toolResult(context, name, args) {
  if (name === "get_model_metrics") return context.model ?? null;
  if (name === "get_body") return (context.bodies || []).find((b) => b.body_id === args.body_id || b.id === args.body_id) ?? null;
  if (name === "get_feature") {
    for (const body of context.bodies || []) {
      const feature = (body.features || []).find((f) => f.feature_id === args.feature_id);
      if (feature) return feature;
    }
    return null;
  }
  if (name === "get_manufacturing_plan") return (context.bodies || []).find((b) => b.body_id === args.body_id || b.id === args.body_id)?.manufacturing_plan ?? null;
  if (name === "get_costing_trace") return context.costing_trace ?? null;
  if (name === "get_foundry_analysis") return (context.bodies || []).find((b) => b.body_id === args.body_id || b.id === args.body_id)?.foundry ?? null;
  if (name === "get_foundry_knowledge") {
    const first = (context.bodies || []).find((b) => b.foundry)?.foundry;
    return first ? { knowledge_version: first.knowledge_version, sources: first.sources, confidence_policy: first.confidence_policy } : null;
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function createResponse(body) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured on the gateway.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
  return data;
}

const SYSTEM = `You are the engineering AI for 3D Reader.
Use only the supplied context: the 3D semantic context and, for costing, costing_trace.
Preserve units and never invent dimensions.
Distinguish measurements, inferences, recommendations, and assumptions.
Cite feature_id, relation_id, operation_id, or setup_id when making geometry/manufacturing claims.
Manufacturing planning is candidate guidance, not executable CAM.
Foundry screening is not a filling/solidification solver. Never claim a riser, gate, porosity result, thermal history or defect probability unless it is supplied by a simulation/tool result. Cite foundry source ids for knowledge-based recommendations and feature/relation ids for geometry evidence.
For costing (task "Chiffrage"), context.costing_trace holds the traced values of the current quote, read-only. Explain them in analyse_chiffrage (French): explications, ecarts_signales (deviations, alerts and values to validate, each with its trace key in cle), questions to the user, hypotheses; cite the trace key of every value you mention. Never invent a price, rate, cycle time or number of cores, and only cite numbers present in costing_trace, as they are or rounded: an answer with another number is marked unverified. Values masked ("masqué") are confidential: never guess them. You never set a value: nothing you write is applied to the quote or the settings. If costing_trace is null, no costing workbook is imported: say so. For the other tasks, analyse_chiffrage is null.
Return concise, technically grounded answers.`;

export default async function handler(req, res) {
  const allowedOrigin = process.env.READER3D_ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { model, context, messages = [] } = req.body || {};
    if (!context) return res.status(400).json({ error: "context is required" });

    const input = [
      { role: "developer", content: JSON.stringify({ schema: "3d-ai-gateway-context", context }) },
      ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }))
    ];

    let response = await createResponse({
      model: model || process.env.OPENAI_MODEL || "gpt-6-astra",
      instructions: SYSTEM,
      input,
      tools: TOOL_DEFS,
      text: { format: { type:"json_schema", name:"engineering_analysis", strict:true, schema:OUTPUT_SCHEMA } }
    });

    for (let round = 0; round < 4; round++) {
      const calls = (response.output || []).filter((item) => item.type === "function_call");
      if (!calls.length) break;
      input.push(...response.output);
      for (const call of calls) {
        const result = toolResult(context, call.name, JSON.parse(call.arguments || "{}"));
        input.push({ type:"function_call_output", call_id:call.call_id, output:JSON.stringify(result) });
      }
      response = await createResponse({
        model: model || process.env.OPENAI_MODEL || "gpt-6-astra",
        instructions: SYSTEM,
        input,
        tools: TOOL_DEFS,
        text: { format: { type:"json_schema", name:"engineering_analysis", strict:true, schema:OUTPUT_SCHEMA } }
      });
    }

    return res.status(200).json({ output: response.output_text || "", response_id: response.id });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "AI request failed" });
  }
}
