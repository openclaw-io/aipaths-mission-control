/**
 * Model routing — decides sonnet vs opus based on task instruction complexity.
 */

export type ModelChoice = "sonnet" | "opus";

// Patterns that suggest opus (complex reasoning needed)
const OPUS_PATTERNS = [
  /refactor/i,
  /architect/i,
  /design.*system/i,
  /complex/i,
  /multi.?file/i,
  /debugging.*tricky/i,
  /migration.*strategy/i,
  /security.*audit/i,
  /performance.*optim/i,
  /re.?write/i,
  /breaking.*change/i,
];

// Patterns that confirm sonnet (clear, specific instructions)
const SONNET_PATTERNS = [
  /src\//,                    // specific file path
  /\.tsx?|\.jsx?|\.py|\.sql/, // file extensions
  /line\s*\d+/i,             // line numbers
  /```(sql|bash|tsx?|jsx?)/,  // code blocks with language
  /CREATE TABLE/i,            // SQL DDL
  /ALTER TABLE/i,
  /npm run/,                  // build commands
  /curl -s/,                  // API calls
  /Acceptance:/i,             // has clear criteria
];

/**
 * Route a task to the best model.
 * @param instruction - task instruction text
 * @param model - explicit override (null = auto-route)
 * @returns "sonnet" or "opus"
 */
export function routeModel(instruction: string, model?: string | null): ModelChoice {
  // Explicit override
  if (model === "sonnet" || model === "opus") return model;

  if (!instruction) return "sonnet";

  // Count pattern matches
  const opusScore = OPUS_PATTERNS.filter((p) => p.test(instruction)).length;
  const sonnetScore = SONNET_PATTERNS.filter((p) => p.test(instruction)).length;

  // Opus if 2+ opus patterns and not clearly specific
  if (opusScore >= 2 && sonnetScore < 3) return "opus";

  // Long instruction with no specific file paths → might need opus
  if (instruction.length > 2000 && sonnetScore === 0) return "opus";

  // Default: sonnet (cheaper, handles most tasks)
  return "sonnet";
}

/**
 * Get the full model identifier for API calls.
 */
export function getModelId(choice: ModelChoice): string {
  return choice === "opus"
    ? "anthropic/claude-opus-4-6"
    : "anthropic/claude-sonnet-4-20250514";
}
