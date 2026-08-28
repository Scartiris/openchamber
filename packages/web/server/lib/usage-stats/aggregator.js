import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_PAGE_LIMIT = 200;
const MESSAGE_PAGE_LIMIT = 100;
const MAX_CONCURRENT_SESSIONS = 10;
const MESSAGE_PAGE_DELAY_MS = 5;
const COLLECT_DEADLINE_MS = 90_000;

export const USAGE_STATS_MIN_DAYS = 1;
export const USAGE_STATS_MAX_DAYS = 90;
export const TODAY_CACHE_TTL_MS = Number.parseInt(process.env.OPENCHAMBER_TOKEN_STATS_TTL_MS ?? '10000', 10) || 10_000;
export const HISTORY_DISK_FILENAME = 'token-stats-history.json';

export const clampStatsDays = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(USAGE_STATS_MAX_DAYS, Math.max(USAGE_STATS_MIN_DAYS, parsed));
};

export const localDateString = (ms) => {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export const rangeStartDate = (days, now = Date.now()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - (days - 1) * DAY_MS;
};

export const localMidnight = (now = Date.now()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
};

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

const finite = (value) => (Number.isFinite(value) ? value : 0);

const addMessageTokens = (bucket, message) => {
  const tokens = message.tokens || {};
  bucket.input += finite(tokens.input);
  bucket.output += finite(tokens.output);
  bucket.reasoning += finite(tokens.reasoning);
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  bucket.cacheRead += finite(cache.read);
  bucket.cacheWrite += finite(cache.write);
};

export const tokensTotal = (bucket) =>
  bucket.input + bucket.output + bucket.reasoning + bucket.cacheRead + bucket.cacheWrite;

const ensureDayEntry = (byDay, date) => {
  let entry = byDay.get(date);
  if (!entry) {
    entry = { date, tokens: emptyTokens(), cost: 0, providers: new Map() };
    byDay.set(date, entry);
  }
  return entry;
};

const ensureProviderEntry = (dayEntry, providerID) => {
  let entry = dayEntry.providers.get(providerID);
  if (!entry) {
    entry = { providerID, tokens: emptyTokens(), cost: 0, models: new Map() };
    dayEntry.providers.set(providerID, entry);
  }
  return entry;
};

const ensureModelEntry = (providerEntry, modelID) => {
  let entry = providerEntry.models.get(modelID);
  if (!entry) {
    entry = { modelID, tokens: emptyTokens(), cost: 0 };
    providerEntry.models.set(modelID, entry);
  }
  return entry;
};

const accumulateMessage = (byDay, message, startDate, endDate) => {
  if (!message || message.role !== 'assistant') return false;
  const created = message.time?.created;
  if (!Number.isFinite(created) || created < startDate) return false;
  if (endDate !== undefined && created >= endDate) return false;
  const date = localDateString(created);
  const dayEntry = ensureDayEntry(byDay, date);
  const providerEntry = ensureProviderEntry(dayEntry, message.providerID || 'unknown');
  const modelEntry = ensureModelEntry(providerEntry, message.modelID || 'unknown');

  addMessageTokens(dayEntry.tokens, message);
  addMessageTokens(providerEntry.tokens, message);
  addMessageTokens(modelEntry.tokens, message);

  const cost = finite(message.cost);
  dayEntry.cost += cost;
  providerEntry.cost += cost;
  modelEntry.cost += cost;
  return true;
};

const nextCursorFrom = (response) => response?.response?.headers?.get?.('x-next-cursor') ?? undefined;

async function listRecentSessions(client, startDate, deadline) {
  const sessions = [];
  for (const archived of [false, true]) {
    let cursor;
    while (true) {
      if (Date.now() > deadline) return sessions;
      const response = await client.experimental.session.list({
        archived,
        limit: SESSION_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const page = Array.isArray(response?.data) ? response.data : [];
      if (page.length === 0) break;
      let oldestUpdated = Infinity;
      for (const session of page) {
        oldestUpdated = Math.min(oldestUpdated, session.time?.updated ?? session.time?.created ?? 0);
        // Sessions whose last update predates the window cannot contain
        // in-window messages; the message walk would stop immediately anyway.
        if ((session.time?.updated ?? session.time?.created ?? 0) >= startDate) {
          sessions.push(session);
        }
      }
      const next = nextCursorFrom(response);
      if (!next || !Number.isFinite(next)) break;
      const nextNumber = Number(next);
      if (cursor !== undefined && nextNumber >= cursor) break;
      // The cursor is strictly decreasing; a fully stale page means every
      // later page is older still.
      if (oldestUpdated < startDate) break;
      cursor = nextNumber;
    }
  }
  return sessions;
}

async function collectSessionUsage(client, session, startDate, endDate, byDay, deadline) {
  let before;
  while (true) {
    if (Date.now() > deadline) return;
    const response = await client.session.messages({
      sessionID: session.id,
      directory: session.directory,
      limit: MESSAGE_PAGE_LIMIT,
      ...(before !== undefined ? { before } : {}),
    });
    const records = Array.isArray(response?.data) ? response.data : [];
    if (records.length === 0) break;
    let oldestCreated = Infinity;
    for (const record of records) {
      const info = record?.info;
      const created = info?.time?.created;
      if (Number.isFinite(created)) oldestCreated = Math.min(oldestCreated, created);
      accumulateMessage(byDay, info, startDate, endDate);
    }
    const next = nextCursorFrom(response);
    if (!next || oldestCreated < startDate) break;
    before = next;
    // Give the OpenCode server breathing room between deep walks.
    await new Promise((resolve) => setTimeout(resolve, MESSAGE_PAGE_DELAY_MS));
  }
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

const serializeTokens = (bucket) => ({ ...bucket, total: tokensTotal(bucket) });

export const serializeByDay = (byDay) =>
  [...byDay.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((dayEntry) => ({
      date: dayEntry.date,
      tokens: serializeTokens(dayEntry.tokens),
      cost: Number(dayEntry.cost.toFixed(6)),
      providers: [...dayEntry.providers.values()]
        .sort((left, right) => tokensTotal(right.tokens) - tokensTotal(left.tokens))
        .map((providerEntry) => ({
          providerID: providerEntry.providerID,
          tokens: serializeTokens(providerEntry.tokens),
          cost: Number(providerEntry.cost.toFixed(6)),
          models: [...providerEntry.models.values()]
            .sort((left, right) => tokensTotal(right.tokens) - tokensTotal(left.tokens))
            .map((modelEntry) => ({
              modelID: modelEntry.modelID,
              tokens: serializeTokens(modelEntry.tokens),
              cost: Number(modelEntry.cost.toFixed(6)),
            })),
        })),
    }));

// Rebuilds an aggregation Map from a serialized byDay array so persisted
// history can be merged with freshly collected ranges.
export const deserializeByDay = (serialized) => {
  const byDay = new Map();
  for (const day of Array.isArray(serialized) ? serialized : []) {
    if (!day?.date) continue;
    const dayEntry = ensureDayEntry(byDay, day.date);
    for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
      dayEntry.tokens[key] += finite(day.tokens?.[key]);
    }
    dayEntry.cost += finite(day.cost);
    for (const provider of day.providers ?? []) {
      if (!provider?.providerID) continue;
      const providerEntry = ensureProviderEntry(dayEntry, provider.providerID);
      for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
        providerEntry.tokens[key] += finite(provider.tokens?.[key]);
      }
      providerEntry.cost += finite(provider.cost);
      for (const model of provider.models ?? []) {
        if (!model?.modelID) continue;
        const modelEntry = ensureModelEntry(providerEntry, model.modelID);
        for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
          modelEntry.tokens[key] += finite(model.tokens?.[key]);
        }
        modelEntry.cost += finite(model.cost);
      }
    }
  }
  return byDay;
};

export const mergeByDayMaps = (maps) => {
  const merged = new Map();
  for (const map of maps) {
    for (const [date, dayEntry] of map) {
      const target = ensureDayEntry(merged, date);
      for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
        target.tokens[key] += dayEntry.tokens[key];
      }
      target.cost += dayEntry.cost;
      for (const [providerID, providerEntry] of dayEntry.providers) {
        const targetProvider = ensureProviderEntry(target, providerID);
        for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
          targetProvider.tokens[key] += providerEntry.tokens[key];
        }
        targetProvider.cost += providerEntry.cost;
        for (const [modelID, modelEntry] of providerEntry.models) {
          const targetModel = ensureModelEntry(targetProvider, modelID);
          for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
            targetModel.tokens[key] += modelEntry.tokens[key];
          }
          targetModel.cost += modelEntry.cost;
        }
      }
    }
  }
  return merged;
};

export const createUsageStatsService = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  openchamberDataDir,
  createClient = createOpencodeClient,
  now = () => Date.now(),
}) => {
  if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') {
    throw new Error('usage-stats service requires buildOpenCodeUrl and getOpenCodeAuthHeaders');
  }

  const historyFilePath = openchamberDataDir
    ? path.join(openchamberDataDir, HISTORY_DISK_FILENAME)
    : null;

  // History (everything before today's local midnight) only changes once per
  // day, so it is cached in memory AND on disk keyed by its cutoff midnight.
  // Different window lengths use different start dates; the disk file keeps a
  // range per start date so they can coexist.
  let historyCache = null; // { cutoff, ranges: Map<startMs, Map> }
  let historyPending = null;
  // Today's numbers move constantly; short single-flight cache only.
  let todayCache = null; // { cutoff, fetchedAt, data }
  let todayPending = null;

  const getClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
  };

  const readHistoryDisk = async (cutoff, startMs) => {
    if (!historyFilePath) return null;
    try {
      const raw = await fs.readFile(historyFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.cutoff !== cutoff) return null;
      const serialized = parsed?.ranges?.[String(startMs)];
      return Array.isArray(serialized) ? deserializeByDay(serialized) : null;
    } catch {
      return null;
    }
  };

  const writeHistoryDisk = async (cutoff, startMs, data) => {
    if (!historyFilePath) return;
    try {
      let ranges = {};
      try {
        const raw = await fs.readFile(historyFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        // Keep other ranges of the same cutoff day; anything older is stale.
        if (parsed?.cutoff === cutoff && parsed?.ranges && typeof parsed.ranges === 'object') {
          ranges = parsed.ranges;
        }
      } catch {
        // No usable previous file.
      }
      ranges[String(startMs)] = serializeByDay(data);
      await fs.mkdir(path.dirname(historyFilePath), { recursive: true });
      await fs.writeFile(
        historyFilePath,
        JSON.stringify({ cutoff, generatedAt: now(), ranges }),
        'utf8',
      );
    } catch (error) {
      console.error('token-stats: failed to persist history cache:', error?.message || error);
    }
  };

  const loadHistory = async (startMs, cutoff) => {
    if (historyCache && historyCache.cutoff === cutoff) {
      const cached = historyCache.ranges.get(startMs);
      if (cached) return cached;
    } else {
      historyCache = { cutoff, ranges: new Map() };
    }
    const pendingKey = `hist:${startMs}`;
    if (historyPending?.key === pendingKey) return historyPending.promise;

    const promise = (async () => {
      try {
        let data = await readHistoryDisk(cutoff, startMs);
        if (!data) {
          data = await collectRange(startMs, cutoff, now() + COLLECT_DEADLINE_MS);
          await writeHistoryDisk(cutoff, startMs, data);
        }
        historyCache.ranges.set(startMs, data);
        return data;
      } finally {
        if (historyPending?.key === pendingKey) historyPending = null;
      }
    })();
    historyPending = { key: pendingKey, promise };
    return promise;
  };

  const loadToday = async (cutoff) => {
    const nowMs = now();
    const isFresh = todayCache && todayCache.cutoff === cutoff && nowMs - todayCache.fetchedAt < TODAY_CACHE_TTL_MS;
    if (isFresh) return todayCache.data;
    // stale-while-revalidate: expired but have data -> serve stale instantly, refresh in background
    if (todayCache && todayCache.cutoff === cutoff && todayCache.data) {
      if (!todayPending) {
        todayPending = (async () => {
          try {
            const data = await collectRange(cutoff, undefined, now() + COLLECT_DEADLINE_MS);
            todayCache = { cutoff, fetchedAt: now(), data };
            return data;
          } finally {
            todayPending = null;
          }
        })();
        todayPending.catch(() => {});
      }
      return todayCache.data;
    }
    if (todayPending) return todayPending;

    todayPending = (async () => {
      try {
        const data = await collectRange(cutoff, undefined, nowMs + COLLECT_DEADLINE_MS);
        todayCache = { cutoff, fetchedAt: now(), data };
        return data;
      } finally {
        todayPending = null;
      }
    })();
    return todayPending;
  };

  const collectRange = async (startDate, endDate, deadline) => {
    const client = await getClient();
    const byDay = new Map();
    const sessions = await listRecentSessions(client, startDate, deadline);
    await mapWithConcurrency(sessions, MAX_CONCURRENT_SESSIONS, async (session) => {
      try {
        await collectSessionUsage(client, session, startDate, endDate, byDay, deadline);
      } catch (error) {
        console.error(`token-stats: failed to collect session ${session.id}:`, error?.message || error);
      }
    });
    return byDay;
  };

  const getStats = async (rawDays) => {
    const days = clampStatsDays(rawDays);
    const nowMs = now();
    const todayCutoff = localMidnight(nowMs);
    const windowStart = rangeStartDate(days, nowMs);

    // history + today in parallel: history is disk/mem cached, today is 10s SWR -> both cheap
    const [historyData, todayData] = await Promise.all([
      loadHistory(windowStart, todayCutoff),
      loadToday(todayCutoff),
    ]);
    const maps = [historyData, todayData];

    const byDay = mergeByDayMaps(maps);
    const startDateString = localDateString(windowStart);
    const serialized = serializeByDay(
      new Map([...byDay.entries()].filter(([date]) => date >= startDateString)),
    );

    const todayDate = localDateString(nowMs);
    const todayEntry = byDay.get(todayDate);
    const todayTokens = todayEntry ? todayEntry.tokens : emptyTokens();
    return {
      generatedAt: nowMs,
      rangeDays: days,
      timezoneOffsetMinutes: new Date(nowMs).getTimezoneOffset(),
      today: {
        date: todayDate,
        tokens: serializeTokens(todayTokens),
        cost: Number((todayEntry?.cost ?? 0).toFixed(6)),
      },
      byDay: serialized,
    };
  };

  return { getStats };
};
