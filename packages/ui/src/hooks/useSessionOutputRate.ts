import React from 'react';
import { useStreamingStore } from '@/sync/streaming';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
  computeAvgTokensPerSec,
  computeCharsPerSec,
  computeInstantTokensPerSec,
  pruneSamples,
  type RateSample,
  WINDOW_MS,
} from '@/lib/metrics/rateCalculator';
import {
  countTokens,
  countTokensEstimate,
  warmTokenizer,
} from '@/lib/metrics/tokenizer';
import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { useSessionMessageRecords, useGlobalSessionStatus } from '@/sync/sync-context';

/**
 * Slim hook for sidebar single-column rate.
 * - No history, no sparkline, no peak persistence beyond current turn
 * - Samples updated in effects, not during render
 * - Memory-only, tokenizer optional
 *
 * Streaming detection does not rely on the streaming store alone: that store
 * is derived from a single-directory sync subscription and can stay empty
 * (multi-directory sessions never get marked), which hid the rate entirely.
 * The aggregated global session status (same source as the sidebar "active"
 * badge) plus the trailing assistant message is the source of truth; the
 * streaming store only supplements phase/startedAt when available.
 */
export type SessionOutputRateSnapshot = {
  isStreaming: boolean;
  instantTokensPerSec: number | null;
  avgTokensPerSec: number | null;
  charsPerSec: number | null;
  isEstimate: boolean;
};

export const useSessionOutputRate = (sessionId: string, directory?: string | null): SessionOutputRateSnapshot => {
  // Status from the global event store: 'busy'/'retry' while a turn runs.
  const sessionStatus = useGlobalSessionStatus(sessionId);
  const isBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  const sessionMessages = useSessionMessageRecords(sessionId ?? '', directory ?? undefined);

  // While busy, the trailing assistant message is the one being generated.
  const trailingAssistantId = React.useMemo(() => {
    if (!isBusy) return null;
    for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
      const entry = sessionMessages[i];
      const role = deriveMessageRole(entry.info).role;
      if (role === 'user') return null;
      if (role === 'assistant') return entry.info.id;
    }
    return null;
  }, [isBusy, sessionMessages]);

  const storeStreamingMessageId = useStreamingStore(
    React.useCallback((s) => s.streamingMessageIds.get(sessionId) ?? null, [sessionId]),
  );
  const streamState = useStreamingStore(
    React.useCallback(
      (s) => (storeStreamingMessageId ? s.messageStreamStates.get(storeStreamingMessageId) ?? null : null),
      [storeStreamingMessageId],
    ),
  );

  const streamingMessageId = storeStreamingMessageId ?? trailingAssistantId;
  // The store can mark a message completed/cooldown mid-turn (e.g. on provider
  // retries the status flips busy→retry), so the global busy flag wins.
  const isStreaming = Boolean(streamingMessageId) && (isBusy || streamState?.phase === 'streaming');
  const storeMatchesTrailing = Boolean(
    storeStreamingMessageId && storeStreamingMessageId === trailingAssistantId,
  );

  const tickerNow = useDurationTickerNow(isStreaming, 250);
  const now = isStreaming ? tickerNow : 0;

  // Fallback start time for when the streaming store has no state for us.
  const [fallbackStartedAt, setFallbackStartedAt] = React.useState(0);
  React.useEffect(() => {
    if (!isStreaming) {
      setFallbackStartedAt(0);
      return;
    }
    setFallbackStartedAt((prev) => (prev === 0 ? Date.now() : prev));
  }, [isStreaming]);
  const startedAt = storeMatchesTrailing && streamState?.startedAt ? streamState.startedAt : fallbackStartedAt;

  const currentStreamingText = React.useMemo(() => {
    if (!streamingMessageId) return '';
    const entry = sessionMessages.find((m) => m.info.id === streamingMessageId);
    if (!entry) return '';
    const role = deriveMessageRole(entry.info).role;
    if (role !== 'assistant') return '';
    return entry.parts
      .map((p) => {
        const r = p as Record<string, unknown>;
        if (r.type === 'text' || r.type === 'reasoning') return typeof r.text === 'string' ? r.text : typeof r.content === 'string' ? r.content : '';
        return '';
      })
      .join('');
  }, [streamingMessageId, sessionMessages]);

  const providerModel = React.useMemo(() => {
    if (!streamingMessageId) return null;
    const entry = sessionMessages.find((m) => m.info.id === streamingMessageId);
    if (!entry) return null;
    const info = entry.info as { providerID?: string; modelID?: string };
    return { providerID: info.providerID, modelID: info.modelID };
  }, [streamingMessageId, sessionMessages]);

  const [preciseTokens, setPreciseTokens] = React.useState<number | null>(null);
  const [isEstimate, setIsEstimate] = React.useState(true);
  const samplesRef = React.useRef<RateSample[]>([]);
  const lastTextRef = React.useRef('');
  const prevIdRef = React.useRef<string | null>(null);
  const lastTotalTokensRef = React.useRef(0);
  const [instant, setInstant] = React.useState<number | null>(null);
  const [avg, setAvg] = React.useState<number | null>(null);
  const [cps, setCps] = React.useState<number | null>(null);

  // warm tokenizer
  React.useEffect(() => {
    if (isStreaming && providerModel) warmTokenizer(providerModel.providerID, providerModel.modelID);
  }, [isStreaming, providerModel]);

  // reset on message switch
  React.useEffect(() => {
    if (prevIdRef.current !== streamingMessageId) {
      prevIdRef.current = streamingMessageId;
      samplesRef.current = [];
      lastTextRef.current = '';
      lastTotalTokensRef.current = 0;
      setInstant(null);
      setAvg(null);
      setCps(null);
      setPreciseTokens(null);
      setIsEstimate(true);
      // Skip precise counting while no text has arrived yet: counting ''
      // would commit precise=0 and suppress the estimate path.
      if (streamingMessageId && currentStreamingText.length > 0) {
        setPreciseTokens(countTokensEstimate(currentStreamingText));
        void countTokens(currentStreamingText, providerModel?.providerID, providerModel?.modelID).then((res) => {
          setPreciseTokens(res.tokens);
          setIsEstimate(res.isEstimate);
        });
      }
    }
  }, [streamingMessageId, currentStreamingText, providerModel]);

  // debounce precise update
  React.useEffect(() => {
    if (!isStreaming || !streamingMessageId) return;
    if (currentStreamingText.length === 0) return;
    if (currentStreamingText === lastTextRef.current) return;
    lastTextRef.current = currentStreamingText;
    const h = window.setTimeout(() => {
      void countTokens(currentStreamingText, providerModel?.providerID, providerModel?.modelID).then((res) => {
        setPreciseTokens(res.tokens);
        setIsEstimate(res.isEstimate);
      });
    }, 300);
    return () => window.clearTimeout(h);
  }, [currentStreamingText, isStreaming, streamingMessageId, providerModel]);

  // ticker-driven sample + compute (side-effect in effect, not render)
  React.useEffect(() => {
    if (!isStreaming || !streamingMessageId) return;
    const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
    const totalChars = currentStreamingText.length;
    const est = countTokensEstimate(currentStreamingText);
    const totalTokens = preciseTokens !== null && !isEstimate ? preciseTokens : est;
    // Tokenizer switches can regress the cumulative count; a backward jump
    // would read as negative velocity, so restart the window on regression.
    if (totalTokens < lastTotalTokensRef.current) {
      samplesRef.current = [];
    }
    lastTotalTokensRef.current = totalTokens;
    const useIsEst = preciseTokens !== null && !isEstimate ? false : true;
    const samples = samplesRef.current;
    samples.push({ t: now, tokens: totalTokens });
    const pruned = pruneSamples(samples, now, WINDOW_MS, 120);
    samplesRef.current = pruned;
    const inst = computeInstantTokensPerSec(pruned, now, WINDOW_MS);
    const av = elapsed > 0 ? computeAvgTokensPerSec(totalTokens, elapsed) : null;
    const cc = elapsed > 0 ? computeCharsPerSec(totalChars, elapsed) : null;
    setInstant(inst);
    setAvg(av);
    setCps(cc);
    if (useIsEst !== isEstimate) setIsEstimate(useIsEst);
  }, [now, isStreaming, startedAt, streamingMessageId, currentStreamingText, preciseTokens, isEstimate]);

  // Values intentionally persist after the turn ends (常驻显示): the average
  // keeps the last turn's result until the next turn resets it on message
  // switch; instant only ticks while streaming.

  return {
    isStreaming,
    instantTokensPerSec: instant,
    avgTokensPerSec: avg,
    charsPerSec: cps,
    isEstimate,
  };
};
