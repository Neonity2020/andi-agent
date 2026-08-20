import type { RunUsage, TokenUsage } from "./model/types";

export function emptyRunUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    modelRequests: 0,
    modelDurationMs: 0,
  };
}

export function addTokenUsage(current: RunUsage, usage: TokenUsage | undefined, durationMs = 0): RunUsage {
  return {
    inputTokens: current.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage?.outputTokens ?? 0),
    totalTokens: current.totalTokens + (usage?.totalTokens ?? 0),
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (usage?.cachedInputTokens ?? 0),
    cacheCreationInputTokens: (current.cacheCreationInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0),
    modelRequests: current.modelRequests + 1,
    modelDurationMs: current.modelDurationMs + durationMs,
  };
}

export function addRunUsage(left: RunUsage, right: RunUsage): RunUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cacheCreationInputTokens: (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0),
    modelRequests: left.modelRequests + right.modelRequests,
    modelDurationMs: left.modelDurationMs + right.modelDurationMs,
  };
}
