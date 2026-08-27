import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useModelOutputRate } from '@/hooks/useModelOutputRate';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';

type SessionMessage = { info: import('@opencode-ai/sdk/v2').Message; parts: import('@opencode-ai/sdk/v2').Part[] };

type Props = {
  sessionId: string | null;
  sessionMessages: SessionMessage[];
};

const formatRate = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(1);
  return v.toFixed(0);
};

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
};

const Sparkline: React.FC<{ data: number[]; isStreaming: boolean }> = ({ data, isStreaming }) => {
  if (data.length < 2) {
    return (
      <div className="flex h-[32px] items-center justify-center rounded bg-[var(--surface-subtle)]/40 typography-micro text-muted-foreground/60">
        —
      </div>
    );
  }
  const w = 152;
  const h = 32;
  const pad = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(1, data.length - 1);
  const points = data
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={isStreaming ? 'var(--primary-base)' : 'var(--surface-muted-foreground)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
        opacity={isStreaming ? 1 : 0.7}
      />
      {isStreaming && data.length > 0 && (
        <circle
          cx={pad + (data.length - 1) * step}
          cy={h - pad - ((data[data.length - 1] - min) / range) * (h - pad * 2)}
          r="2.5"
          fill="var(--primary-base)"
        />
      )}
    </svg>
  );
};

export const ModelOutputRateSection: React.FC<Props> = ({ sessionId, sessionMessages }) => {
  const { t } = useI18n();
  const rate = useModelOutputRate(sessionId, sessionMessages);

  const formatNumber = React.useCallback(
    (v: number) => v.toLocaleString(getCurrentIntlLocale()),
    [],
  );

  const hasAnyHistory = rate.history.length > 0;
  const showStreaming = rate.isStreaming;
  const showIdleWithHistory = !showStreaming && hasAnyHistory;

  return (
    <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="typography-micro font-medium text-muted-foreground">
            {t('contextSidebar.rate.title')}
          </span>
          {showStreaming ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-success)]/10 px-1.5 py-0.5 typography-micro font-medium text-[var(--status-success)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-success)]" />
              {t('contextSidebar.rate.streaming')}
            </span>
          ) : hasAnyHistory ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 typography-micro text-muted-foreground/70">
              {t('contextSidebar.rate.completed')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {rate.tokenizerReady ? (
            <span
              className="inline-flex items-center gap-1 typography-micro text-[var(--status-success)]/80"
              title={rate.tokenizerModelId ?? 'Xenova/gpt-4'}
            >
              <Icon name="check" className="size-3" />
              {t('contextSidebar.rate.precise')}
            </span>
          ) : rate.totalTokensIsEstimate ? (
            <span
              className="typography-micro text-muted-foreground/60"
              title={rate.tokenizerError ?? t('contextSidebar.rate.estimatingHint')}
            >
              {t('contextSidebar.rate.estimating')}
            </span>
          ) : null}
        </div>
      </div>

      {/* Main rate */}
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="typography-micro text-muted-foreground/70">
            {showStreaming ? t('contextSidebar.rate.instant') : t('contextSidebar.rate.lastAvg')}
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-[1.35rem] font-semibold tabular-nums leading-none text-foreground">
              {showStreaming
                ? formatRate(rate.instantTokensPerSec)
                : formatRate(rate.avgTokensPerSec)}
            </span>
            <span className="typography-micro font-medium text-muted-foreground/70">tok/s</span>
            {showStreaming && (
              <span className="ml-2 typography-micro tabular-nums text-muted-foreground/60">
                {rate.charsPerSec !== null ? `${Math.round(rate.charsPerSec)} chars/s` : ''}
              </span>
            )}
          </div>
          <div className="mt-1 typography-micro tabular-nums text-muted-foreground/60">
            {t('contextSidebar.rate.totalTokens', { count: formatNumber(rate.totalTokens) })}
            {' · '}
            {formatDuration(rate.elapsedMs)}
          </div>
        </div>
        <div className="shrink-0">
          <Sparkline data={rate.sparkline} isStreaming={showStreaming} />
        </div>
      </div>

      {/* Secondary grid */}
      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
        <div>
          <div className="typography-micro text-muted-foreground/60">{t('contextSidebar.rate.avg')}</div>
          <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
            {rate.avgTokensPerSec !== null ? `${formatRate(rate.avgTokensPerSec)} tok/s` : '—'}
          </div>
        </div>
        <div>
          <div className="typography-micro text-muted-foreground/60">{t('contextSidebar.rate.peak')}</div>
          <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
            {rate.peakTokensPerSec > 0 ? `${formatRate(rate.peakTokensPerSec)} tok/s` : '—'}
          </div>
        </div>
        <div>
          <div className="typography-micro text-muted-foreground/60">{t('contextSidebar.rate.elapsed')}</div>
          <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
            {formatDuration(rate.elapsedMs)}
          </div>
        </div>
      </div>

      {/* History avg */}
      <div className="mt-3 flex items-center justify-between border-t border-[var(--surface-subtle)] pt-2.5 typography-micro">
        <span className="text-muted-foreground/70">
          {t('contextSidebar.rate.historyAvg')}
          {hasAnyHistory ? ` (${rate.history.length})` : ''}
        </span>
        <span className="tabular-nums font-medium text-foreground/80">
          {rate.historyAvgTokensPerSec !== null
            ? `${formatRate(rate.historyAvgTokensPerSec)} tok/s${rate.historyAvgIsEstimate ? ' *' : ''}`
            : '—'}
        </span>
      </div>

      {/* Tokenizer hint / error */}
      {!rate.tokenizerReady && rate.tokenizerError && (
        <div className="mt-2 typography-micro text-muted-foreground/50">
          {t('contextSidebar.rate.tokenizerFailed')}
        </div>
      )}

      {/* Empty state */}
      {!showStreaming && !hasAnyHistory && (
        <div className="mt-3 rounded bg-[var(--surface-subtle)]/50 px-3 py-2 text-center typography-micro text-muted-foreground/60">
          {t('contextSidebar.rate.empty')}
        </div>
      )}

      {/* Last turns mini table (max 3) */}
      {hasAnyHistory && (
        <div className="mt-2.5 space-y-1">
          {rate.history.slice(-3).reverse().map((h) => (
            <div
              key={h.messageId}
              className="flex items-center justify-between rounded bg-[var(--surface-subtle)]/30 px-2 py-1 typography-micro"
            >
              <span className="truncate text-muted-foreground/70">
                {h.modelID ?? '—'} · {formatNumber(h.tokens)} tok · {formatDuration(h.elapsedMs)}
                {h.isEstimated ? ' *' : ''}
              </span>
              <span className="ml-2 shrink-0 tabular-nums font-medium text-foreground/70">
                {h.avgTokensPerSec !== null ? `${formatRate(h.avgTokensPerSec)}` : '—'} tok/s
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
