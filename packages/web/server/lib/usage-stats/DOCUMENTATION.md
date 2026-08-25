# Usage Stats

Token consumption statistics aggregated from OpenCode session messages.

## Ownership

Owns the `GET /api/token-stats` route: day × provider × model aggregation of
assistant-message token usage (input, output, reasoning, cache.read,
cache.write) plus per-message cost, over a rolling local-date window.

## Data flow

1. `createUsageStatsService({ buildOpenCodeUrl, getOpenCodeAuthHeaders, waitForOpenCodeReady })`
   builds an `@opencode-ai/sdk/v2` client lazily per collection run.
2. Sessions come from `experimental.session.list` (active + archived pages,
   numeric descending cursor). Sessions whose `time.updated` predates the
   window start are skipped; because the cursor is strictly decreasing, the
   page loop stops once an entire page is older than the window.
3. Messages come from `session.messages` paginated newest→oldest via the
   `x-next-cursor` header. Collection stops for a session when a page's oldest
   `time.created` falls before the window start.
4. Every assistant message contributes its five token classes and `cost` to
   `byDay[date][providerID][modelID]`. Dates use server-local midnight
   (`Asia/Shanghai` on this deployment); token counts are processing-volume
   sums — cross-turn cache folding is intentionally NOT deduplicated.

## Caching

Two layers, keyed by local-midnight cutoff:

- **History** (everything before today's midnight): collected once per day per
  window start, persisted to `<openchamberDataDir>/token-stats-history.json`
  and cached in memory. Second requests are instant even across server
  restarts; the file is rewritten when the cutoff rolls over.
- **Today**: fresh single-flight collection with a 60s TTL.

Collection runs with session concurrency 3, a 50ms pause between message pages,
and a 90s deadline after which walks return partial results instead of hanging.
First-ever request for a long window can still take a while; callers should
surface progress and allow retries.

## Contracts

- Route returns `{ generatedAt, rangeDays, today, byDay }`; `today.total.tokens`
  mirrors the five-class sum shown in the titlebar button.
- `cost` values sum message-level `cost` directly (incremental by turn).
