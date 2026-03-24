/**
 * LLM model pricing — cost per million tokens.
 * Source: Anthropic pricing page (as of March 2026)
 */

export interface ModelPrice {
  input: number;  // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic Claude
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-3-5": { input: 0.8, output: 4.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },

  // Default fallback (assume sonnet-tier pricing)
  default: { input: 3.0, output: 15.0 },
};

/**
 * Calculate cost in USD for a given model + token counts.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Try exact match first, then partial match, then default
  let pricing = MODEL_PRICING[model];

  if (!pricing) {
    // Partial match: "anthropic/claude-opus-4-6" → "claude-opus-4-6"
    const shortModel = model.includes("/") ? model.split("/").pop()! : model;
    pricing = MODEL_PRICING[shortModel];
  }

  if (!pricing) {
    // Fuzzy match by family
    if (model.includes("opus")) pricing = MODEL_PRICING["claude-opus-4-6"];
    else if (model.includes("haiku")) pricing = MODEL_PRICING["claude-haiku-3-5"];
    else pricing = MODEL_PRICING["default"];
  }

  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Get a display-friendly model name.
 */
export function shortModelName(model: string): string {
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return model.split("/").pop() || model;
}
