import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useStreamingStore } from '@/sync/streaming';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
  computeAvgTokensPerSec,
  computeCharsPerSec,
  computeInstantTokensPerSec,
  pruneSamples,
  computeHistoryAvg,
  type RateSample,
  WINDOW_MS,
} from '@/lib/metrics/rateCalculator';
import {
  countTokens,
  countTokensEstimate,
  warmTokenizer,
  getTokenizerError,
  isTokenizerReady,
  getTokenizerModelId,
} from '@/lib/metrics/tokenizer';
import { deriveMessageRole } from '@/components/chat/message/messageRole';

type SessionMessage = { info: Message; parts: Part[] };

export type HistoricalTurn = {
  messageId: string;
  tokens: number;
  chars: number;
  elapsedMs: number;
  avgTokensPerSec: number | null;
  isEstimated: boolean;
  providerID?: string;
  modelID?: string;
};

export type ModelOutputRateSnapshot = {
  phase: 'idle' | 'streaming' | 'completed';
  isStreaming: boolean;
  streamingMessageId: string | null;
  // Current turn
  elapsedMs: number;
  totalChars: number;
  totalTokens: number;
  totalTokensIsEstimate: boolean;
  instantTokensPerSec: number | null;
  avgTokensPerSec: number | null;
  charsPerSec: number | null;
  peakTokensPerSec: number;
  // History (completed turns in this session)
  history: HistoricalTurn[];
  historyAvgTokensPerSec: number | null;
  historyAvgIsEstimate: boolean;
  // Tokenizer state
  tokenizerReady: boolean;
  tokenizerModelId: string | null;
  tokenizerError: string | null;
  // sparkline data: instant values over last ~30 ticks
  sparkline: number[];
};

const EMPTY: ModelOutputRateSnapshot = {
  phase: 'idle',
  isStreaming: false,
  streamingMessageId: null,
  elapsedMs: 0,
  totalChars: 0,
  totalTokens: 0,
  totalTokensIsEstimate: true,
  instantTokensPerSec: null,
  avgTokensPerSec: null,
  charsPerSec: null,
  peakTokensPerSec: 0,
  history: [],
  historyAvgTokensPerSec: null,
  historyAvgIsEstimate: true,
  tokenizerReady: false,
  tokenizerModelId: null,
  tokenizerError: null,
  sparkline: [],
};

const extractOutputTokens = (msg: SessionMessage): number | null => {
  const cand = (msg.info as { tokens?: unknown }).tokens;
  let src: unknown = cand;
  if (src === undefined) {
    src = (msg.parts.find((p) => (p as { tokens?: unknown }).tokens !== undefined) as { tokens?: unknown } | undefined)?.tokens;
  }
  if (typeof src === 'number') return src; // total – approximate as output for completed?
  if (!src || typeof src !== 'object') return null;
  const b = src as { output?: unknown; input?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } };
  const out = typeof b.output === 'number' && Number.isFinite(b.output) ? b.output : null;
  return out;
};

const extractCharsFromParts = (parts: Part[]): number => {
  let n = 0;
  for (const p of parts) {
    const r = p as Record<string, unknown>;
    const t = r.type;
    if (t === 'text' || t === 'reasoning') {
      const txt = typeof r.text === 'string' ? r.text : typeof r.content === 'string' ? r.content : '';
      n += txt.length;
    } else if (t === 'tool') {
      // tool output not counted as model output; skip for output rate
      continue;
    }
  }
  return n;
};

const getAssistantTextLength = (msg: SessionMessage): number => extractCharsFromParts(msg.parts);

const getElapsedForCompleted = (info: Message): number | null => {
  const c = (info as { time?: { created?: number; completed?: number } }).time;
  if (!c || typeof c.created !== 'number' || typeof c.completed !== 'number') return null;
  const d = c.completed - c.created;
  return d > 0 ? d : null;
};

export const useModelOutputRate = (
  sessionId: string | null | undefined,
  sessionMessages: SessionMessage[],
  options?: { enabled?: boolean },
): ModelOutputRateSnapshot => {
  const enabled = options?.enabled ?? true;

  const streamingMessageId = useStreamingStore(
    React.useCallback(
      (s) => (sessionId ? s.streamingMessageIds.get(sessionId) ?? null : null),
      [sessionId],
    ),
  );
  const streamState = useStreamingStore(
    React.useCallback(
      (s) => (streamingMessageId ? s.messageStreamStates.get(streamingMessageId) ?? null : null),
      [streamingMessageId],
    ),
  );

  const isStreaming = !!streamingMessageId && streamState?.phase === 'streaming';
  const tickerNow = useDurationTickerNow(isStreaming, 250);
  const now = isStreaming ? tickerNow : Date.now();

  // Track async precise tokens for current text
  const [preciseTokens, setPreciseTokens] = React.useState<number | null>(null);
  const [preciseIsEstimate, setPreciseIsEstimate] = React.useState(true);
  const [tokenizerReadyState, setTokenizerReadyState] = React.useState(() => isTokenizerReady());
  const samplesRef = React.useRef<RateSample[]>([]);
  const peakRef = React.useRef<number>(0);
  const sparkRef = React.useRef<number[]>([]);
  const prevStreamingIdRef = React.useRef<string | null>(null);
  const lastTextRef = React.useRef<string>('');

  const currentStreamingText = React.useMemo(() => {
    if (!streamingMessageId) return '';
    const entry = sessionMessages.find((m) => m.info.id === streamingMessageId);
    if (!entry) return '';
    // Respect role; only assistant
    const role = deriveMessageRole(entry.info).role;
    if (role !== 'assistant') return '';
    return entry.parts
      .map((p) => {
        const r = p as Record<string, unknown>;
        if (r.type === 'text' || r.type === 'reasoning') {
          return typeof r.text === 'string' ? r.text : typeof r.content === 'string' ? r.content : '';
        }
        return '';
      })
      .join('');
  }, [streamingMessageId, sessionMessages]);

  const currentProviderModel = React.useMemo(() => {
    if (!streamingMessageId) return null;
    const entry = sessionMessages.find((m) => m.info.id === streamingMessageId);
    if (!entry) return null;
    const info = entry.info as { providerID?: string; modelID?: string };
    return { providerID: info.providerID, modelID: info.modelID };
  }, [streamingMessageId, sessionMessages]);

  // Warm tokenizer when streaming starts
  React.useEffect(() => {
    if (isStreaming && currentProviderModel) {
      warmTokenizer(currentProviderModel.providerID, currentProviderModel.modelID);
      // poll readiness shortly after
      const t = window.setTimeout(() => setTokenizerReadyState(isTokenizerReady()), 1200);
      return () => window.clearTimeout(t);
    }
  }, [isStreaming, currentProviderModel]);

  // Reset trackers on streaming id change
  React.useEffect(() => {
    if (prevStreamingIdRef.current !== streamingMessageId) {
      prevStreamingIdRef.current = streamingMessageId;
      samplesRef.current = [];
      peakRef.current = 0;
      sparkRef.current = [];
      lastTextRef.current = '';
      setPreciseTokens(null);
      setPreciseIsEstimate(true);
      setTokenizerReadyState(isTokenizerReady());
      if (streamingMessageId) {
        setPreciseTokens(countTokensEstimate(currentStreamingText));
        // kick async precise count for initial text
        void countTokens(currentStreamingText, currentProviderModel?.providerID, currentProviderModel?.modelID).then((res) => {
          setPreciseTokens(res.tokens);
          setPreciseIsEstimate(res.isEstimate);
          setTokenizerReadyState(isTokenizerReady());
        });
      }
    }
  }, [streamingMessageId, currentStreamingText, currentProviderModel]);

  // Live tick: update samples / peak / sparkline
  const liveSnapshot = React.useMemo<ModelOutputRateSnapshot | null>(() => {
    if (!enabled || !sessionId) return null;
    if (!isStreaming || !streamState || !streamingMessageId) return null;

    const startedAt = streamState.startedAt;
    const elapsedMs = Math.max(0, now - startedAt);
    const totalChars = currentStreamingText.length;

    // Sync fallback estimate for this tick (fast, no async)
    const estimateTokens = countTokensEstimate(currentStreamingText);
    // Prefer precise if we have it and it corresponds to same text length (approx)
    const totalTokens = preciseTokens !== null && !preciseIsEstimate
      ? preciseTokens
      : estimateTokens;
    const isEstimate = preciseTokens !== null && !preciseIsEstimate ? false : true;

    // Update samples (mutate ref, but memo recreates snapshot immutably)
    const samples = samplesRef.current;
    samples.push({ t: now, tokens: totalTokens });
    const pruned = pruneSamples(samples, now, WINDOW_MS, 120);
    samplesRef.current = pruned;

    const instant = computeInstantTokensPerSec(pruned, now, WINDOW_MS);
    const avg = computeAvgTokensPerSec(totalTokens, elapsedMs);
    const cps = computeCharsPerSec(totalChars, elapsedMs);

    if (instant !== null && instant > peakRef.current) {
      peakRef.current = instant;
    }
    // sparkline push (keep 30)
    const spark = sparkRef.current;
    if (instant !== null) {
      spark.push(instant);
      if (spark.length > 30) spark.shift();
    } else if (avg !== null) {
      // keep shape while waiting for window
      spark.push(avg);
      if (spark.length > 30) spark.shift();
    }
    sparkRef.current = spark.slice();

    return {
      phase: 'streaming',
      isStreaming: true,
      streamingMessageId,
      elapsedMs,
      totalChars,
      totalTokens,
      totalTokensIsEstimate: isEstimate,
      instantTokensPerSec: instant,
      avgTokensPerSec: avg,
      charsPerSec: cps,
      peakTokensPerSec: peakRef.current,
      history: [], // filled below outside live memo
      historyAvgTokensPerSec: null,
      historyAvgIsEstimate: true,
      tokenizerReady: isTokenizerReady(),
      tokenizerModelId: getTokenizerModelId(),
      tokenizerError: getTokenizerError(),
      sparkline: spark.slice(),
    };
  }, [enabled, sessionId, isStreaming, streamState, streamingMessageId, now, currentStreamingText, preciseTokens, preciseIsEstimate]);

  // Async precise token update throttled (when text grows)
  React.useEffect(() => {
    if (!isStreaming || !streamingMessageId) return;
    if (currentStreamingText === lastTextRef.current) return;
    lastTextRef.current = currentStreamingText;
    // debounce 300ms
    const handle = window.setTimeout(() => {
      void countTokens(currentStreamingText, currentProviderModel?.providerID, currentProviderModel?.modelID).then((res) => {
        setPreciseTokens(res.tokens);
        setPreciseIsEstimate(res.isEstimate);
        setTokenizerReadyState(isTokenizerReady());
      });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [currentStreamingText, isStreaming, streamingMessageId, currentProviderModel]);

  // History for completed turns (authoritative tokens.output when available)
  const history = React.useMemo<HistoricalTurn[]>(() => {
    const out: HistoricalTurn[] = [];
    for (const m of sessionMessages) {
      const role = deriveMessageRole(m.info).role;
      if (role !== 'assistant') continue;
      const elapsed = getElapsedForCompleted(m.info);
      if (elapsed === null) continue; // not completed
      const tok = extractOutputTokens(m);
      const chars = getAssistantTextLength(m);
      // Skip empty assistant turns
      if (chars === 0 && (tok === null || tok === 0)) continue;
      let tokens: number;
      let isEst = false;
      if (tok !== null && tok > 0) {
        tokens = tok;
      } else {
        // Fallback to estimate (unlikely after completed, but cover)
        tokens = countTokensEstimate(
          m.parts
            .map((p) => {
              const r = p as Record<string, unknown>;
              return typeof r.text === 'string' ? r.text : '';
            })
            .join(''),
        );
        isEst = true;
      }
      const avg = computeAvgTokensPerSec(tokens, elapsed);
      const info = m.info as { providerID?: string; modelID?: string };
      out.push({
        messageId: m.info.id,
        tokens,
        chars,
        elapsedMs: elapsed,
        avgTokensPerSec: avg,
        isEstimated: isEst,
        providerID: info.providerID,
        modelID: info.modelID,
      });
    }
    // most recent first? keep chronological then caller can slice
    return out;
  }, [sessionMessages]);

  const historyAvg = React.useMemo(() => computeHistoryAvg(history.map((h) => h.avgTokensPerSec)), [history]);
  const historyAvgIsEstimate = React.useMemo(() => history.some((h) => h.isEstimated), [history]);

  if (!enabled || !sessionId) {
    return EMPTY;
  }

  if (liveSnapshot) {
    return {
      ...liveSnapshot,
      history,
      historyAvgTokensPerSec: historyAvg,
      historyAvgIsEstimate,
      tokenizerReady: tokenizerReadyState,
    };
  }

  // Idle / completed: show last turn or history avg
  const last = history.length > 0 ? history[history.length - 1] : null;
  const phase: ModelOutputRateSnapshot['phase'] = history.length > 0 || streamingMessageId ? 'completed' : 'idle';

  return {
    phase,
    isStreaming: false,
    streamingMessageId: streamingMessageId ?? null,
    elapsedMs: last?.elapsedMs ?? 0,
    totalChars: last?.chars ?? 0,
    totalTokens: last?.tokens ?? 0,
    totalTokensIsEstimate: last?.isEstimated ?? true,
    instantTokensPerSec: null,
    avgTokensPerSec: last?.avgTokensPerSec ?? historyAvg,
    charsPerSec: last ? computeCharsPerSec(last.chars, last.elapsedMs) : null,
    peakTokensPerSec: peakRef.current,
    history,
    historyAvgTokensPerSec: historyAvg,
    historyAvgIsEstimate,
    tokenizerReady: tokenizerReadyState,
    tokenizerModelId: getTokenizerModelId(),
    tokenizerError: getTokenizerError(),
    sparkline: sparkRef.current.slice(),
  };
};
