import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_PAGE_LIMIT = 200;
const MESSAGE_PAGE_LIMIT = 100;
const MAX_CONCURRENT_SESSIONS = 6;

export const USAGE_STATS_MIN_DAYS = 1;
export const USAGE_STATS_MAX_DAYS = 90;

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

const tokensTotal = (bucket) =>
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

const accumulateMessage = (byDay, message, startDate) => {
  if (!message || message.role !== 'assistant') return false;
  const created = message.time?.created;
  if (!Number.isFinite(created) || created < startDate) return false;
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

async function listRecentSessions(client, startDate) {
  const sessions = [];
  for (const archived of [false, true]) {
    let cursor;
    while (true) {
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
      if (!next || !Number.isFinite(next) || next >= cursor && cursor !== undefined) break;
      // The cursor is strictly decreasing; a fully stale page means every
      // later page is older still.
      if (oldestUpdated < startDate) break;
      cursor = Number(next);
    }
  }
  return sessions;
}

async function collectSessionUsage(client, session, startDate, byDay) {
  let before;
  while (true) {
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
      accumulateMessage(byDay, info, startDate);
    }
    const next = nextCursorFrom(response);
    if (!next || oldestCreated < startDate) break;
    before = next;
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

const serializeByDay = (byDay) =>
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

export const createUsageStatsService = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  createClient = createOpencodeClient,
}) => {
  if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') {
    throw new Error('usage-stats service requires buildOpenCodeUrl and getOpenCodeAuthHeaders');
  }

  let cacheEntry = null;
  let pending = null;

  const getClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
  };

  const collect = async (days, now) => {
    const client = await getClient();
    const startDate = rangeStartDate(days, now);
    const todayDate = localDateString(now);
    const byDay = new Map();

    const sessions = await listRecentSessions(client, startDate);
    await mapWithConcurrency(sessions, MAX_CONCURRENT_SESSIONS, async (session) => {
      try {
        await collectSessionUsage(client, session, startDate, byDay);
      } catch (error) {
        console.error(`token-stats: failed to collect session ${session.id}:`, error?.message || error);
      }
    });

    const serialized = serializeByDay(byDay);
    const todayEntry = byDay.get(todayDate);
    const todayTokens = todayEntry ? todayEntry.tokens : emptyTokens();
    return {
      generatedAt: now,
      rangeDays: days,
      timezoneOffsetMinutes: new Date(now).getTimezoneOffset(),
      today: {
        date: todayDate,
        tokens: serializeTokens(todayTokens),
        cost: Number((todayEntry?.cost ?? 0).toFixed(6)),
      },
      byDay: serialized,
    };
  };

  const getStats = async (rawDays) => {
    const days = clampStatsDays(rawDays);
    const now = Date.now();
    if (cacheEntry && cacheEntry.days === days && now - cacheEntry.fetchedAt < STATS_CACHE_TTL_MS) {
      return cacheEntry.data;
    }
    if (!pending) {
      pending = (async () => {
        try {
          const data = await collect(days, Date.now());
          cacheEntry = { days, fetchedAt: Date.now(), data };
          return data;
        } finally {
          pending = null;
        }
      })();
    }
    return pending;
  };

  return { getStats };
};
