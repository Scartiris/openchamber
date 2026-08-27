/**
 * Pure helpers for model output rate calculations.
 * No React, no tokenizer – easily unit-tested.
 */

export type RateSample = {
  t: number;      // epoch ms
  tokens: number; // cumulative tokens at t
};

export const WINDOW_MS = 2000;

export const computeAvgTokensPerSec = (
  totalTokens: number,
  elapsedMs: number,
): number | null => {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(elapsedMs)) return null;
  if (totalTokens <= 0 || elapsedMs <= 0) return null;
  return totalTokens / (elapsedMs / 1000);
};

export const computeInstantTokensPerSec = (
  samples: readonly RateSample[],
  now: number,
  windowMs: number = WINDOW_MS,
): number | null => {
  if (samples.length < 2) return null;
  if (windowMs <= 0) return null;
  const windowStart = now - windowMs;
  // find earliest sample within window; if none inside, no instant value
  let startIdx = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].t >= windowStart) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;
  const first = samples[startIdx];
  const last = samples[samples.length - 1];
  if (!first || !last || last.t <= first.t) return null;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  const dTokens = last.tokens - first.tokens;
  if (dTokens < 0) return null;
  return dTokens / dt;
};

export const computeCharsPerSec = (
  totalChars: number,
  elapsedMs: number,
): number | null => {
  if (!Number.isFinite(totalChars) || !Number.isFinite(elapsedMs)) return null;
  if (totalChars <= 0 || elapsedMs <= 0) return null;
  return totalChars / (elapsedMs / 1000);
};

/**
 * Clamp samples to bounded size and window.
 */
export const pruneSamples = (
  samples: RateSample[],
  now: number,
  windowMs: number = WINDOW_MS,
  maxSize: number = 120,
): RateSample[] => {
  const cutoff = now - windowMs * 3; // keep a bit more than window for peak calc
  let pruned = samples;
  if (samples.length > maxSize) {
    pruned = samples.slice(samples.length - maxSize);
  }
  // drop ancient
  const firstWithin = pruned.findIndex((s) => s.t >= cutoff);
  if (firstWithin > 0) {
    pruned = pruned.slice(firstWithin);
  }
  return pruned;
};
