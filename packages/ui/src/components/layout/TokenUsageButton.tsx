import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type TokenBucket = {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
};

type ModelUsage = { modelID: string; tokens: TokenBucket; cost: number };
type ProviderUsage = { providerID: string; tokens: TokenBucket; cost: number; models: ModelUsage[] };
type DayUsage = { date: string; tokens: TokenBucket; cost: number; providers: ProviderUsage[] };
type TokenStatsResponse = {
    generatedAt: number;
    rangeDays: number;
    today: { date: string; tokens: TokenBucket; cost: number };
    byDay: DayUsage[];
};

export type TokenStatsRange = '1' | '7' | '30';

export const RANGE_OPTIONS = [
    { value: '1', labelKey: 'tokenUsage.range.today' },
    { value: '7', labelKey: 'tokenUsage.range.7days' },
    { value: '30', labelKey: 'tokenUsage.range.30days' },
] as const;

export const TOKEN_SEGMENTS = [
    { key: 'input', colorClass: 'bg-blue-500/70', labelKey: 'tokenUsage.tokens.input' },
    { key: 'output', colorClass: 'bg-emerald-500/80', labelKey: 'tokenUsage.tokens.output' },
    { key: 'reasoning', colorClass: 'bg-violet-500/80', labelKey: 'tokenUsage.tokens.reasoning' },
    { key: 'cacheRead', colorClass: 'bg-amber-500/70', labelKey: 'tokenUsage.tokens.cacheRead' },
    { key: 'cacheWrite', colorClass: 'bg-rose-500/70', labelKey: 'tokenUsage.tokens.cacheWrite' },
] as const;

export const formatCompactTokens = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return String(Math.round(value));
};

interface StatsState {
    data: TokenStatsResponse | null;
    loading: boolean;
    error: string | null;
}

export const useTokenStats = (range: TokenStatsRange, enabled: boolean): StatsState & { refresh: () => void } => {
    const [state, setState] = useState<StatsState>({ data: null, loading: enabled, error: null });
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick((value) => value + 1), []);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const controller = new AbortController();
        // First-ever collection of a long window can legitimately take a
        // while server-side; past that, fail visibly instead of hanging.
        const timeout = window.setTimeout(() => controller.abort(), 120_000);
        setState((previous) => ({ ...previous, loading: true, error: null }));
        runtimeFetch(`/api/token-stats?days=${range}`, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) {
                    const body = await response.json().catch(() => null) as { error?: string } | null;
                    throw new Error(body?.error || `HTTP ${response.status}`);
                }
                return response.json() as Promise<TokenStatsResponse>;
            })
            .then((data) => {
                if (!cancelled) setState({ data, loading: false, error: null });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : 'failed';
                setState({ data: null, loading: false, error: message });
            });
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
            controller.abort();
        };
    }, [range, enabled, tick]);

    return { ...state, refresh };
};

const StatPill: React.FC<{ label: string; value: string; className?: string }> = ({ label, value, className }) => (
    <div className={cn('rounded-md border border-border bg-[var(--surface-muted)]/40 px-2 py-1.5', className)}>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="typography-ui-label font-medium tabular-nums text-foreground">{value}</div>
    </div>
);

const StackedBar: React.FC<{ tokens: TokenBucket; max: number }> = ({ tokens, max }) => (
    <div className="flex h-3 w-full overflow-hidden rounded-sm bg-[var(--surface-muted)]">
        {TOKEN_SEGMENTS.map(({ key, colorClass }) => {
            const share = max > 0 ? (tokens[key] as number) / max : 0;
            if (share <= 0) return null;
            return <div key={key} className={colorClass} style={{ width: `${Math.max(share * 100, 0.5)}%` }} />;
        })}
    </div>
);

const DailyView: React.FC<{ byDay: DayUsage[] }> = ({ byDay }) => {
    const { t } = useI18n();
    const max = useMemo(() => Math.max(1, ...byDay.map((day) => day.tokens.total)), [byDay]);
    const days = useMemo(() => [...byDay].reverse(), [byDay]);
    if (days.length === 0) {
        return <p className="py-8 text-center text-sm text-muted-foreground">{t('tokenUsage.empty')}</p>;
    }
    return (
        <div className="flex flex-col gap-2">
            {days.map((day) => (
                <div key={day.date} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 tabular-nums text-xs text-muted-foreground">{day.date}</span>
                    <div className="min-w-0 flex-1">
                        <StackedBar tokens={day.tokens} max={max} />
                    </div>
                    <div className="w-24 shrink-0 text-right">
                        <span className="typography-ui-label font-medium tabular-nums text-foreground">{formatCompactTokens(day.tokens.total)}</span>
                    </div>
                </div>
            ))}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {TOKEN_SEGMENTS.map(({ key, colorClass, labelKey }) => (
                    <span key={key} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <span className={cn('inline-block h-2 w-2 rounded-sm', colorClass)} />
                        {t(labelKey)}
                    </span>
                ))}
            </div>
        </div>
    );
};

const ModelsView: React.FC<{ byDay: DayUsage[] }> = ({ byDay }) => {
    const { t } = useI18n();
    const grouped = useMemo(() => {
        const map = new Map<string, Map<string, { tokens: TokenBucket; cost: number }>>();
        for (const day of byDay) {
            for (const provider of day.providers) {
                let models = map.get(provider.providerID);
                if (!models) {
                    models = new Map();
                    map.set(provider.providerID, models);
                }
                for (const model of provider.models) {
                    const entry = models.get(model.modelID) ?? { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
                    entry.tokens.input += model.tokens.input;
                    entry.tokens.output += model.tokens.output;
                    entry.tokens.reasoning += model.tokens.reasoning;
                    entry.tokens.cacheRead += model.tokens.cacheRead;
                    entry.tokens.cacheWrite += model.tokens.cacheWrite;
                    entry.tokens.total += model.tokens.total;
                    entry.cost += model.cost;
                    models.set(model.modelID, entry);
                }
            }
        }
        return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [byDay]);

    if (grouped.length === 0) {
        return <p className="py-8 text-center text-sm text-muted-foreground">{t('tokenUsage.empty')}</p>;
    }

    const headerClass = 'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
    const cellClass = 'px-2 py-1.5 tabular-nums';

    return (
        <div className="flex flex-col gap-4">
            {grouped.map(([providerID, models]) => {
                const rows = [...models.entries()].sort((a, b) => b[1].tokens.total - a[1].tokens.total);
                return (
                    <div key={providerID} className="overflow-hidden rounded-lg border border-border">
                        <div className="flex items-center justify-between border-b border-border bg-[var(--surface-muted)]/50 px-3 py-1.5">
                            <span className="typography-ui-label font-medium text-foreground">{providerID}</span>
                        </div>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b border-border">
                                    <th className={headerClass}>{t('tokenUsage.model')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.input')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.output')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.reasoning')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.cacheRead')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.cacheWrite')}</th>
                                    <th className={`${headerClass} text-right`}>{t('tokenUsage.tokens.total')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(([modelID, usage]) => (
                                    <tr key={modelID} className="border-b border-border last:border-b-0">
                                        <td className={`${cellClass} max-w-40 truncate font-medium text-foreground`} title={modelID}>{modelID}</td>
                                        <td className={`${cellClass} text-right text-muted-foreground`}>{formatCompactTokens(usage.tokens.input)}</td>
                                        <td className={`${cellClass} text-right text-foreground`}>{formatCompactTokens(usage.tokens.output)}</td>
                                        <td className={`${cellClass} text-right text-muted-foreground`}>{formatCompactTokens(usage.tokens.reasoning)}</td>
                                        <td className={`${cellClass} text-right text-muted-foreground`}>{formatCompactTokens(usage.tokens.cacheRead)}</td>
                                        <td className={`${cellClass} text-right text-muted-foreground`}>{formatCompactTokens(usage.tokens.cacheWrite)}</td>
                                        <td className={`${cellClass} text-right font-medium text-foreground`}>{formatCompactTokens(usage.tokens.total)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            })}
        </div>
    );
};

export const TokenUsageButton: React.FC<{ className?: string }> = ({ className }) => {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [range, setRange] = useState<TokenStatsRange>('7');
    const [view, setView] = useState<'daily' | 'models'>('daily');
    // Poll while mounted so the titlebar figure stays fresh; the server caches
    // for 30s so this stays cheap.
    const stats = useTokenStats(range, true);

    useEffect(() => {
        const timer = window.setInterval(() => stats.refresh(), 30_000);
        return () => window.clearInterval(timer);
    }, [stats.refresh]);

    useEffect(() => {
        if (open) stats.refresh();
    }, [open, stats.refresh]);

    const todayTotal = stats.data?.today.tokens.total ?? 0;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={t('tokenUsage.button.aria')}
                title={t('tokenUsage.button.title')}
                className={cn(
                    'app-region-no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-[var(--surface-muted)]/50 px-2 typography-ui-label font-medium tabular-nums text-foreground hover:bg-interactive-hover transition-colors',
                    className,
                )}
            >
                <Icon name="bar-chart-2" className="h-4 w-4 text-muted-foreground" />
                <span>{stats.loading && !stats.data ? '…' : formatCompactTokens(todayTotal)}</span>
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="w-full max-w-2xl gap-0 overflow-hidden p-0">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <h2 className="typography-ui-title font-medium text-foreground">{t('tokenUsage.dialog.title')}</h2>
                        <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)] p-0.5">
                            {RANGE_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setRange(option.value)}
                                    className={cn(
                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                        range === option.value
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground hover:text-foreground',
                                    )}
                                >
                                    {t(option.labelKey)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="border-b border-border px-4 py-3">
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                            {TOKEN_SEGMENTS.map(({ key, labelKey }) => (
                                <StatPill
                                    key={key}
                                    label={t(labelKey)}
                                    value={formatCompactTokens(stats.data?.today.tokens[key] ?? 0)}
                                />
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 border-b border-border px-4 py-2">
                        {(['daily', 'models'] as const).map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                onClick={() => setView(tab)}
                                className={cn(
                                    'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                    view === tab ? 'bg-[var(--surface-muted)] text-foreground' : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {tab === 'daily' ? t('tokenUsage.tab.daily') : t('tokenUsage.tab.models')}
                            </button>
                        ))}
                        {stats.error ? (
                            <button
                                type="button"
                                onClick={stats.refresh}
                                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                            >
                                <Icon name="arrow-go-back" className="h-3.5 w-3.5" />
                                {t('tokenUsage.retry')}
                                {stats.data ? null : (
                                    <span className="max-w-48 truncate font-normal text-muted-foreground" title={stats.error}>
                                        {stats.error}
                                    </span>
                                )}
                            </button>
                        ) : null}
                    </div>
                    <div className="max-h-[55vh] overflow-y-auto px-4 py-3">
                        {stats.loading && !stats.data ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
                        ) : view === 'daily' ? (
                            <DailyView byDay={stats.data?.byDay ?? []} />
                        ) : (
                            <ModelsView byDay={stats.data?.byDay ?? []} />
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
};
