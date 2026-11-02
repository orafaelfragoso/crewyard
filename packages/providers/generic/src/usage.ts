import { UNKNOWN_USAGE, type UsageReport } from '@crewyard/core';

export interface UsageAccumulator {
  add(delta: { input?: number | null; output?: number | null; cached?: number | null; costUsd?: number | null }): void;
  setModel(model: string | null): void;
  report(): UsageReport;
}

export function createUsageAccumulator(): UsageAccumulator {
  let seen = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  let cachedSeen = false;
  let cost: number | null = null;
  let model: string | null = null;
  return {
    add(delta) {
      if (delta.input == null && delta.output == null) return;
      seen = true;
      input += delta.input ?? 0;
      output += delta.output ?? 0;
      if (delta.cached != null) {
        cachedSeen = true;
        cached += delta.cached;
      }
      if (delta.costUsd != null) cost = (cost ?? 0) + delta.costUsd;
    },
    setModel(value) {
      if (value) model = value;
    },
    report() {
      if (!seen) return { ...UNKNOWN_USAGE, ...(model ? { model } : {}) };
      return {
        ...(model ? { model } : {}),
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cachedSeen ? cached : null,
        costUsd: cost,
        usageSource: 'measured',
        costSource: cost === null ? 'unknown' : 'reported',
      };
    },
  };
}
