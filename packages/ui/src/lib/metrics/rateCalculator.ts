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
  // find earliest sample within window
  let startIdx = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].t >= windowStart) {
      startIdx = i;
      break;
    }
    if (i === samples.length - 1) {
      // all samples outside window – use last two
      startIdx = Math.max(0, samples.length - 2);
    }
  }
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

export const formatRate = (
  value: number | null,
  fractionDigits: number = 1,
): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(fractionDigits);
};

export const formatTokensPerSec = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} tok/s`;
};

export const formatCharsPerSec = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(0)} chars/s`;
};

export const computeHistoryAvg = (
  rates: Array<number | null>,
): number | null => {
  const valid = rates.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
};

/**
 * Decide display precision: small values show 1 decimal, large show 0.
 */
export const toDisplayRate = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 10) return value.toFixed(1);
  return value.toFixed(0);
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
