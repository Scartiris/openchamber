import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampStatsDays,
  createUsageStatsService,
  localDateString,
  rangeStartDate,
} from './aggregator.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const session = (overrides = {}) => ({
  id: overrides.id ?? 'ses_1',
  directory: overrides.directory ?? '/proj',
  time: { created: 0, updated: overrides.updated ?? Date.now(), ...(overrides.archivedAt ? { archived: overrides.archivedAt } : {}) },
});

const assistantMessage = (overrides = {}) => ({
  role: 'assistant',
  providerID: overrides.providerID ?? 'anthropic',
  modelID: overrides.modelID ?? 'claude-x',
  cost: overrides.cost ?? 0.5,
  time: { created: overrides.created ?? Date.now() },
  tokens: overrides.tokens ?? {
    input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 50 },
  },
});

const fakeClientFactory = ({ sessions, messagesBySession }) => (config) => {
  const MESSAGE_PAGE = 2;
  assert.ok(config.baseUrl.startsWith('http'), 'baseUrl must be an http url');
  return {
    experimental: {
      session: {
        list: async ({ archived, cursor }) => {
          const pool = sessions[archived ? 'archived' : 'active'] ?? [];
          const start = cursor === undefined ? 0 : pool.findIndex((s) => s.time.updated === Number(cursor)) + 1;
          const page = pool.slice(start, start + 2);
          const next = start + 2 < pool.length ? page[page.length - 1].time.updated : undefined;
          const headers = new Map(next !== undefined ? [['x-next-cursor', String(next)]] : []);
          return { data: page.map((s) => ({ ...s })), response: { headers: { get: (k) => headers.get(k) ?? null } } };
        },
      },
    },
    session: {
      // Messages arrive oldest→newest; pagination walks from the newest page
      // backwards via a `before` message-id cursor.
      messages: async ({ sessionID, before }) => {
        const all = messagesBySession[sessionID] ?? [];
        let end = all.length;
        if (before !== undefined) {
          end = all.findIndex((m) => m.info.id === before);
          if (end <= 0) return { data: [], response: { headers: { get: () => null } } };
        }
        const start = Math.max(0, end - MESSAGE_PAGE);
        const slice = all.slice(start, end);
        if (slice.length === 0) return { data: [], response: { headers: { get: () => null } } };
        const next = start > 0 ? slice[0].info.id : null;
        return { data: slice, response: { headers: { get: (k) => (k === 'x-next-cursor' && next ? next : null) } } };
      },
    },
  };
};

test('clampStatsDays bounds and defaults', () => {
  assert.equal(clampStatsDays(undefined), 7);
  assert.equal(clampStatsDays('30'), 30);
  assert.equal(clampStatsDays('0'), 1);
  assert.equal(clampStatsDays('-5'), 1);
  assert.equal(clampStatsDays('9999'), 90);
});

test('rangeStartDate aligns to local midnight minus window', () => {
  const now = new Date('2026-08-25T15:00:00').getTime();
  const start = rangeStartDate(7, now);
  const expected = new Date('2026-08-19T00:00:00').getTime();
  assert.equal(start, expected);
});

test('localDateString pads month and day', () => {
  assert.equal(localDateString(new Date('2026-02-05T08:00:00').getTime()), '2026-02-05');
});

test('aggregates tokens per day, provider and model with cost sums', async () => {
  const now = Date.now();
  const todayNoon = new Date(); todayNoon.setHours(12, 0, 0, 0);
  const yesterdayNoon = todayNoon.getTime() - DAY_MS;
  const clientFactory = fakeClientFactory({
    sessions: {
      active: [session({ id: 'ses_a', updated: now })],
      archived: [],
    },
    messagesBySession: {
      // Oldest→newest, matching the API's chronological order.
      ses_a: [
        { info: { id: 'm2', ...assistantMessage({ created: yesterdayNoon, providerID: 'openrouter', modelID: 'ox-alpha', cost: 0.2 }) } },
        { info: { id: 'm3', role: 'user', time: { created: todayNoon.getTime() } } },
        { info: { id: 'm1', ...assistantMessage({ created: todayNoon.getTime(), providerID: 'opencode-go', modelID: 'muse-1', cost: 0.1 }) } },
      ],
    },
  });
  const service = createUsageStatsService({
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createClient: clientFactory,
  });
  const stats = await service.getStats(7);

  assert.equal(stats.byDay.length, 2);
  const today = stats.byDay.find((d) => d.date === stats.today.date);
  assert.ok(today, 'today entry present');
  const goProvider = today.providers.find((p) => p.providerID === 'opencode-go');
  assert.equal(goProvider.models[0].modelID, 'muse-1');
  assert.equal(goProvider.models[0].tokens.input, 100);
  assert.equal(goProvider.models[0].tokens.cacheRead, 300);
  assert.equal(goProvider.models[0].tokens.total, 475);
  assert.ok(Math.abs(today.cost - 0.1) < 1e-9);
  assert.equal(stats.today.tokens.total, 475);
  assert.equal(stats.today.tokens.output, 20);
  const older = stats.byDay.find((d) => d.date !== stats.today.date);
  assert.equal(older.providers[0].models[0].cost, 0.2);
});

test('stops message walk once a page is fully outside the window', async () => {
  const now = Date.now();
  let messageRequests = 0;
  const oldCreated = now - 40 * DAY_MS;
  const clientFactory = fakeClientFactory({
    sessions: { active: [session({ id: 'ses_long', updated: now })], archived: [] },
    messagesBySession: {
      // Oldest→newest, matching the API's chronological order.
      ses_long: [
        { info: { id: 'oldest', ...assistantMessage({ created: oldCreated }) } },
        { info: { id: 'mid', ...assistantMessage({ created: oldCreated + DAY_MS }) } },
        { info: { id: 'newest', ...assistantMessage({ created: now - DAY_MS }) } },
      ],
    },
  });
  // Wrap the factory to count message calls.
  const service = createUsageStatsService({
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createClient: (config) => {
      const client = clientFactory(config);
      const original = client.session.messages;
      client.session.messages = async (args) => {
        messageRequests += 1;
        return original(args);
      };
      return client;
    },
  });
  const stats = await service.getStats(7);
  // newest page covers m(newest); the walk must not fetch the oldest page.
  assert.ok(messageRequests < 3, `expected early stop, got ${messageRequests} requests`);
  assert.equal(stats.byDay.length, 1);
});

test('skips sessions entirely older than the window', async () => {
  const now = Date.now();
  let messageCalls = 0;
  const clientFactory = fakeClientFactory({
    sessions: {
      active: [
        session({ id: 'ses_fresh', updated: now }),
        session({ id: 'ses_stale', updated: now - 60 * DAY_MS }),
      ],
      archived: [],
    },
    messagesBySession: { ses_fresh: [{ info: { id: 'm1', ...assistantMessage({ created: now - 3600_000 }) } }] },
  });
  const service = createUsageStatsService({
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    createClient: (config) => {
      const client = clientFactory(config);
      const original = client.session.messages;
      client.session.messages = async (args) => {
        messageCalls += 1;
        assert.notEqual(args.sessionID, 'ses_stale', 'stale session must not be fetched');
        return original(args);
      };
      return client;
    },
  });
  await service.getStats(7);
  // History and today ranges each walk the session once.
  assert.equal(messageCalls, 2);
});
