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
import { useSessionMessageRecords } from '@/sync/sync-context';

/**
 * Slim hook for sidebar single-column rate.
 * - No history, no sparkline, no peak persistence beyond current turn
 * - Samples updated in effects, not during render
 * - Memory-only, tokenizer optional
 */
export type SessionOutputRateSnapshot = {
  isStreaming: boolean;
  instantTokensPerSec: number | null;
  avgTokensPerSec: number | null;
  charsPerSec: number | null;
  isEstimate: boolean;
};

export const useSessionOutputRate = (sessionId: string, directory?: string | null): SessionOutputRateSnapshot => {
  const streamingMessageId = useStreamingStore(
    React.useCallback((s) => s.streamingMessageIds.get(sessionId) ?? null, [sessionId]),
  );
  const streamState = useStreamingStore(
    React.useCallback((s) => (streamingMessageId ? s.messageStreamStates.get(streamingMessageId) ?? null : null), [streamingMessageId]),
  );
  const isStreaming = !!streamingMessageId && streamState?.phase === 'streaming';
  const tickerNow = useDurationTickerNow(isStreaming, 250);
  const now = isStreaming ? tickerNow : 0;

  // Fetch messages for this session - use explicit directory (no bootstrap fallback needed for visible rows)
  const sessionMessages = useSessionMessageRecords(sessionId ?? '', directory ?? undefined);

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
  const [instant, setInstant] = React.useState<number | null>(null);
  const [avg, setAvg] = React.useState<number | null>(null);
  const [cps, setCps] = React.useState<number | null>(null);

  // warm tokenizer
  React.useEffect(() => {
    if (isStreaming && providerModel) warmTokenizer(providerModel.providerID, providerModel.modelID);
  }, [isStreaming, providerModel]);

  // reset on id change
  React.useEffect(() => {
    if (prevIdRef.current !== streamingMessageId) {
      prevIdRef.current = streamingMessageId;
      samplesRef.current = [];
      lastTextRef.current = '';
      setInstant(null);
      setAvg(null);
      setCps(null);
      setPreciseTokens(null);
      setIsEstimate(true);
      if (streamingMessageId) {
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
    if (!isStreaming || !streamState || !streamingMessageId) return;
    const elapsed = Math.max(0, now - streamState.startedAt);
    const totalChars = currentStreamingText.length;
    const est = countTokensEstimate(currentStreamingText);
    const totalTokens = preciseTokens !== null && !isEstimate ? preciseTokens : est;
    const useIsEst = preciseTokens !== null && !isEstimate ? false : true;
    // keep isEstimate in sync for consumers that read instant label
    // (we don't call setIsEstimate here to avoid loop; precise path already sets)
    const samples = samplesRef.current;
    samples.push({ t: now, tokens: totalTokens });
    const pruned = pruneSamples(samples, now, WINDOW_MS, 120);
    samplesRef.current = pruned;
    const inst = computeInstantTokensPerSec(pruned, now, WINDOW_MS);
    const av = computeAvgTokensPerSec(totalTokens, elapsed);
    const cc = computeCharsPerSec(totalChars, elapsed);
    setInstant(inst);
    setAvg(av);
    setCps(cc);
    // update Estimate flag if precise became ready
    if (useIsEst !== isEstimate) setIsEstimate(useIsEst);
  }, [now, isStreaming, streamState, streamingMessageId, currentStreamingText, preciseTokens, isEstimate]);

  // when not streaming, clear
  React.useEffect(() => {
    if (!isStreaming) {
      // keep last values for a short fade? but spec says hide, so clear
      // do not clear samples immediately to allow quick restart, but UI hides
    }
  }, [isStreaming]);

  return {
    isStreaming,
    instantTokensPerSec: isStreaming ? instant : null,
    avgTokensPerSec: isStreaming ? avg : null,
    charsPerSec: isStreaming ? cps : null,
    isEstimate,
  };
};
