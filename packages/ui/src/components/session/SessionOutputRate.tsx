import React from 'react';
import { cn } from '@/lib/utils';
import { useSessionOutputRate } from '@/hooks/useSessionOutputRate';
import { useI18n } from '@/lib/i18n';

const formatRate = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '';
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(1);
  return v.toFixed(0);
};

/**
 * Single-column rate for sidebar row.
 * - Only renders when streaming; idle returns null (hidden)
 * - Isolated ticker: parent row does not re-render on every tick beyond this leaf
 */
export const SessionOutputRate: React.FC<{
  sessionId: string;
  directory?: string | null;
  className?: string;
}> = ({ sessionId, directory, className }) => {
  const { t } = useI18n();
  const rate = useSessionOutputRate(sessionId, directory ?? null);
  if (!rate.isStreaming) return null;
  // prefer instant, fallback to avg while window warming
  const value = rate.instantTokensPerSec ?? rate.avgTokensPerSec;
  if (value === null || value <= 0) return null;
  const label = `${formatRate(value)} tok/s`;
  const hint = rate.charsPerSec !== null ? `${Math.round(rate.charsPerSec)} chars/s${rate.isEstimate ? ' ~' : ''}` : rate.isEstimate ? t('contextSidebar.rate.estimating') : '';
  return (
    <span
      className={cn('shrink-0 tabular-nums', 'text-[0.72rem] text-primary', className)}
      aria-label={label}
      title={hint || label}
    >
      {label}
    </span>
  );
};


