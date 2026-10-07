import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You are the engineering AI for 3D Reader.
Use only the supplied 3D semantic context.
Preserve units and never invent dimensions.
Distinguish measurements, inferences, recommendations, and assumptions.
Cite feature_id, relation_id, operation_id, or setup_id when making geometry/manufacturing claims.
Manufacturing planning is candidate guidance, not executable CAM.
For costing, never invent rates or prices: label missing commercial inputs as assumptions.
Return concise, technically grounded answers.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { model, context, messages = [] } = req.body || {};
    if (!context) return res.status(400).json({ error: "context is required" });

    const response = await client.responses.create({
      model: model || process.env.OPENAI_MODEL || "gpt-6-astra",
      instructions: SYSTEM,
      input: [
        { role: "developer", content: JSON.stringify({ schema: "3d-ai-gateway-context", context }) },
        ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }))
      ]
    });

    return res.status(200).json({
      output: response.output_text || "",
      response_id: response.id
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "AI request failed" });
  }
}
