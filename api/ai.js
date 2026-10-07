import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    inferences: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    needs_human_validation: { type: "boolean" },
    quote: { anyOf: [
      { type: "null" },
      { type: "object", properties: {
        currency: { type: "string" }, quantity: { type: "number" },
        total: { type: "number" }, unit: { type: "number" }, confidence: { type: "number" },
        assumptions: { type: "array", items: { type: "string" } }
      }, required: ["currency","quantity","total","unit","confidence","assumptions"], additionalProperties: false }
    ] }
  },
  required: ["conclusion","observations","inferences","recommendations","uncertainties","needs_human_validation","quote"],
  additionalProperties: false
};

const TOOL_DEFS = [
  { type:"function", name:"get_model_metrics", description:"Return global model metrics from the supplied semantic context.", parameters:{type:"object",properties:{},required:[],additionalProperties:false}, strict:true },
  { type:"function", name:"get_body", description:"Return one semantic body by body_id.", parameters:{type:"object",properties:{body_id:{type:"string"}},required:["body_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_feature", description:"Return one semantic feature by feature_id.", parameters:{type:"object",properties:{feature_id:{type:"string"}},required:["feature_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_manufacturing_plan", description:"Return manufacturing planning data for a body.", parameters:{type:"object",properties:{body_id:{type:"string"}},required:["body_id"],additionalProperties:false}, strict:true },
  { type:"function", name:"get_costing_inputs", description:"Return costing inputs supplied by 3D Reader. Missing commercial rates remain missing.", parameters:{type:"object",properties:{},required:[],additionalProperties:false}, strict:true }
];

function toolResult(context, name, args) {
  if (name === "get_model_metrics") return context.model_facts ?? null;
  if (name === "get_body") return (context.bodies || []).find((b) => b.body_id === args.body_id || b.id === args.body_id) ?? null;
  if (name === "get_feature") {
    for (const body of context.bodies || []) {
      const feature = (body.features || []).find((f) => f.feature_id === args.feature_id);
      if (feature) return feature;
    }
    return null;
  }
  if (name === "get_manufacturing_plan") return (context.bodies || []).find((b) => b.body_id === args.body_id || b.id === args.body_id)?.manufacturing_plan ?? null;
  if (name === "get_costing_inputs") return context.costing_inputs ?? null;
  throw new Error(`Unknown tool: ${name}`);
}

const SYSTEM = `You are the engineering AI for 3D Reader.
Use only the supplied 3D semantic context.
Preserve units and never invent dimensions.
Distinguish measurements, inferences, recommendations, and assumptions.
Cite feature_id, relation_id, operation_id, or setup_id when making geometry/manufacturing claims.
Manufacturing planning is candidate guidance, not executable CAM.
For costing, never invent rates or prices: label missing commercial inputs as assumptions.
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

    let response = await client.responses.create({
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
      response = await client.responses.create({
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
