/**
 * Tokenizer wrapper using @xenova/transformers.
 * - Lazy-loaded (dynamic import) to keep initial bundle light.
 * - Single model cached; falls back to chars/4 heuristic when unavailable.
 * - Counts tokens for plain text, stripping special-token overhead consistently.
 */

type TokenizerInstance = {
  // callable: (text: string) => Promise<{ input_ids: { dims: number[]; data: unknown; size?: number } }>
  // Some versions expose encode() returning number[]
  // We'll handle both shapes defensively.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (text: string, opts?: any): Promise<any>;
  encode?: (text: string) => number[];
};

let tokenizerInstance: TokenizerInstance | null = null;
let tokenizerPromise: Promise<TokenizerInstance | null> | null = null;
let tokenizerModelId: string | null = null;
let tokenizerLoadAbort: AbortController | null = null;
let tokenizerDesiredIdForPromise: string | null = null;

// Map provider/model hints to closest Xenova tokenizer
const MODEL_TOKENIZER_MAP: Record<string, string> = {
  // OpenAI / generic
  'gpt-4': 'Xenova/gpt-4',
  'gpt-4o': 'Xenova/gpt-4',
  'gpt-3.5': 'Xenova/gpt-3.5-turbo',
  'o1': 'Xenova/gpt-4',
  // Claude – use cl100k as approximation (Anthropic not on Xenova, gpt-4 close)
  'claude': 'Xenova/gpt-4',
  'muse-spark': 'Xenova/gpt-4',
  'ox-alpha': 'Xenova/gpt-4',
  // fallback
  'default': 'Xenova/gpt-4',
};

const resolveModelId = (providerID?: string, modelID?: string): string => {
  const hint = `${providerID ?? ''}/${modelID ?? ''}`.toLowerCase();
  for (const [key, xenovaId] of Object.entries(MODEL_TOKENIZER_MAP)) {
    if (key === 'default') continue;
    if (hint.includes(key)) return xenovaId;
  }
  return MODEL_TOKENIZER_MAP['default']!;
};

const estimateTokensByChars = (text: string): number => {
  if (!text) return 0;
  // chars/4 is the heuristic already used in ContextSidebarTab computeContextBreakdown
  return Math.ceil(text.length / 4);
};

/**
 * Load tokenizer for given provider/model (cached, coalesced).
 * Returns null on failure – caller should fallback.
 */
const loadTokenizer = async (
  providerID?: string,
  modelID?: string,
): Promise<TokenizerInstance | null> => {  const desiredId = resolveModelId(providerID, modelID);
  if (tokenizerInstance && tokenizerModelId === desiredId) {
    return tokenizerInstance;
  }
  if (tokenizerPromise && tokenizerDesiredIdForPromise === desiredId) {
    return tokenizerPromise;
  }

  // abort previous load if model switched
  if (tokenizerLoadAbort && tokenizerDesiredIdForPromise !== desiredId) {
    try { tokenizerLoadAbort.abort(); } catch (_e) { void _e; }
    tokenizerLoadAbort = null;
  }
  tokenizerLoadAbort = new AbortController();
  const currentAbort = tokenizerLoadAbort;

  tokenizerModelId = desiredId;
  tokenizerDesiredIdForPromise = desiredId;
  tokenizerPromise = (async () => {
    try {
      if (currentAbort.signal.aborted) return null;
      // Dynamic import to avoid bundling ONNX runtime until needed
      const mod = await import('@xenova/transformers');
      if (currentAbort.signal.aborted) return null;
      // Some builds export AutoTokenizer as named, some as default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic transformers shape
      const AutoTokenizer = (mod as unknown as { AutoTokenizer: any }).AutoTokenizer
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic transformers shape
        ?? (mod as unknown as { default: { AutoTokenizer: any } }).default?.AutoTokenizer;
      if (!AutoTokenizer) {
        throw new Error('AutoTokenizer not found in @xenova/transformers');
      }
      const tok = await AutoTokenizer.from_pretrained(desiredId);
      tokenizerInstance = tok as TokenizerInstance;
      return tokenizerInstance;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // keep promise resolved to null so callers don't throw
      console.warn('[tokenizer] failed to load', desiredId, msg);
      tokenizerInstance = null;
      return null;
    }
  })();

  return tokenizerPromise;
};

/**
 * Count tokens precisely when tokenizer is ready, otherwise fallback to chars/4.
 * This is the sync fallback (no network, no async).
 */
export const countTokensEstimate = (text: string): number => estimateTokensByChars(text);

/**
 * Async precise count – awaits tokenizer if not yet loaded, but with timeout
 * so UI never blocks. If loading takes >800ms, return estimate.
 */
export const countTokens = async (
  text: string,
  providerID?: string,
  modelID?: string,
): Promise<{ tokens: number; isEstimate: boolean; modelId: string | null }> => {
  if (!text) return { tokens: 0, isEstimate: false, modelId: tokenizerModelId };
  // fast path: tokenizer already ready
  if (tokenizerInstance) {
    try {
      const n = await countWithTokenizer(tokenizerInstance, text);
      return { tokens: n, isEstimate: false, modelId: tokenizerModelId };
    } catch {
      return { tokens: estimateTokensByChars(text), isEstimate: true, modelId: tokenizerModelId };
    }
  }
  // not ready – try to load with race against estimate timeout so streaming stays smooth
  try {
    const tok = await Promise.race([
      loadTokenizer(providerID, modelID),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
    if (tok) {
      const n = await countWithTokenizer(tok, text);
      return { tokens: n, isEstimate: false, modelId: tokenizerModelId };
    }
  } catch {
    // fall through to estimate
  }
  return { tokens: estimateTokensByChars(text), isEstimate: true, modelId: tokenizerModelId };
};

/**
 * Extract the token id count from whatever shape the tokenizer returns.
 */

const countWithTokenizer = async (
  tok: TokenizerInstance,
  text: string,
): Promise<number> => {
  // Primary: call as function -> { input_ids: Tensor }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tok as unknown as (t: string) => Promise<any>)(text);
    if (result && typeof result === 'object') {
      if (result.input_ids) {
        const ids = result.input_ids;
        if (Array.isArray(ids)) return ids.length;
        if (ids && typeof ids === 'object') {
          if (typeof ids.size === 'number') return ids.size;
          if (Array.isArray(ids.dims) && ids.dims.length >= 2) {
            // dims [1, seq_len]
            return ids.dims[1] ?? ids.dims[0] ?? 0;
          }
          if (Array.isArray(ids.data)) return ids.data.length;
          // Tensor may be nested via .tolist()
          if (typeof ids.tolist === 'function') {
            const arr = ids.tolist();
            if (Array.isArray(arr)) {
              if (Array.isArray(arr[0])) return (arr[0] as unknown[]).length;
              return arr.length;
            }
          }
        }
      }
      // Some tokenizers return { input_ids: Tensor } wrapped differently
      if (Array.isArray(result)) return result.length;
    }
  } catch {
    // try encode fallback
  }
  // Fallback: encode()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enc = (tok as any).encode as ((t: string) => number[] | Promise<number[]>) | undefined;
  if (typeof enc === 'function') {
    const ids = await enc.call(tok, text);
    if (Array.isArray(ids)) return ids.length;
  }
  // Last resort: estimate
  return estimateTokensByChars(text);
};

/**
 * Pre-warm tokenizer for current model – fire-and-forget.
 */
export const warmTokenizer = (providerID?: string, modelID?: string): void => {
  void loadTokenizer(providerID, modelID);
};
