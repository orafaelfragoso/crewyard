export const TOKEN_ESTIMATOR = 'chars/4+16';
const EXCERPT_OVERHEAD_TOKENS = 16;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateExcerptTokens(text: string): number {
  return estimateTokens(text) + EXCERPT_OVERHEAD_TOKENS;
}

export function linesWithinBudget(lines: readonly string[], budgetTokens: number): number {
  let chars = 0;
  const limit = Math.max(0, budgetTokens - EXCERPT_OVERHEAD_TOKENS) * 4;
  for (let i = 0; i < lines.length; i++) {
    chars += lines[i]!.length + 1;
    if (chars > limit) return i;
  }
  return lines.length;
}
