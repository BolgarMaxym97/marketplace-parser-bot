import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import { pollSources } from '../src/poller';
import { applySchema, daysAgo, hoursAgo, makeFetchStub, offersPayload, resetDb } from './helpers';

const DB = env.DB as D1Database;

const API_URL = 'https://www.olx.ua/api/v1/offers?query=test&limit=50';

async function seedSource(initialized: boolean, apiUrl: string = API_URL): Promise<number> {
  const row = await DB.prepare(
    `INSERT INTO sources (page_url, api_url, label, initialized, created_at)
     VALUES ('https://www.olx.ua/uk/q-test/', ?, 'test', ?, 0)
     RETURNING id`,
  )
    .bind(apiUrl, initialized ? 1 : 0)
    .first<{ id: number }>();
  return row!.id;
}

async function seedChats(...ids: number[]): Promise<void> {
  for (const id of ids) {
    await DB.prepare(
      `INSERT INTO chats (chat_id, type, title, added_at) VALUES (?, 'channel', 'c', 0)`,
    )
      .bind(id)
      .run();
  }
}

const seenIds = async (sourceId: number): Promise<number[]> => {
  const { results } = await DB.prepare('SELECT ad_id FROM seen_ads WHERE source_id = ? ORDER BY ad_id')
    .bind(sourceId)
    .all<{ ad_id: number }>();
  return results.map((row) => row.ad_id);
};

const watermark = async (sourceId: number): Promise<number | null> => {
  const row = await DB.prepare('SELECT last_created_at FROM sources WHERE id = ?')
    .bind(sourceId)
    .first<{ last_created_at: number | null }>();
  return row!.last_created_at;
};

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const mediaGroups = (calls: Array<{ method: string }>): number =>
  calls.filter((call) => call.method === 'sendMediaGroup').length;

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

beforeAll(async () => {
  await applySchema(DB);
});

beforeEach(async () => {
  await resetDb(DB);
  vi.unstubAllGlobals();
});

describe('first sweep of a new source', () => {
  it('records every ad and broadcasts nothing', async () => {
    const sourceId = await seedSource(false);
    await seedChats(-100, -200);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 1 }, { id: 2 }, { id: 3 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(await seenIds(sourceId)).toEqual([1, 2, 3]);
    expect(mediaGroups(stub.telegramCalls)).toBe(0);

    // Exactly one report, and it goes to the owner only.
    const messages = stub.telegramCalls.filter((call) => call.method === 'sendMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body.chat_id).toBe(777);

    const row = await DB.prepare('SELECT initialized FROM sources WHERE id = ?')
      .bind(sourceId)
      .first<{ initialized: number }>();
    expect(row!.initialized).toBe(1);
  });
});

describe('multiple owners', () => {
  it('reports the first sweep to every owner', async () => {
    await seedSource(false);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 1 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ OWNER_CHAT_ID: '777, 888' }));

    const reports = stub.telegramCalls.filter((call) => call.method === 'sendMessage');
    expect(reports.map((call) => call.body.chat_id)).toEqual([777, 888]);
  });

  it('warns every owner once when a source is auto-disabled', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([]) });
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/v1/offers')) return new Response('nope', { status: 500 });
      return stub.fetch(input, init);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', failing);

    for (let attempt = 0; attempt < 2; attempt++) {
      await pollSources(testEnv({ OWNER_CHAT_ID: '777,888', MAX_FAILURES: '2' }));
    }

    const warnings = stub.telegramCalls.filter(
      (call) => call.method === 'sendMessage' && String(call.body.text).includes('вимкнено'),
    );
    expect(warnings.map((call) => call.body.chat_id)).toEqual([777, 888]);
  });
});

describe('broadcasting', () => {
  it('sends each new ad to every active chat and records it', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100, -200);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 10 }, { id: 11 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(mediaGroups(stub.telegramCalls)).toBe(4); // 2 ads × 2 chats
    expect(await seenIds(sourceId)).toEqual([10, 11]);
  });

  it('sends oldest first so a chat reads chronologically', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 20, title: 'newer', created: hoursAgo(1) },
        { id: 21, title: 'older', created: hoursAgo(5) },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions[0]).toContain('older');
    expect(captions[1]).toContain('newer');
  });

  it('posts into the forum topic a chat is pinned to', async () => {
    await seedSource(true);
    await DB.prepare(
      `INSERT INTO chats (chat_id, type, title, added_at, thread_id)
       VALUES (-100, 'supergroup', 'eblx', 0, 42)`,
    ).run();

    const stub = makeFetchStub({ offers: offersPayload([{ id: 25 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const [send] = stub.telegramCalls.filter((call) => call.method === 'sendMediaGroup');
    expect(send!.body.message_thread_id).toBe(42);
  });

  it('omits message_thread_id for a chat without topics', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 26 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const [send] = stub.telegramCalls.filter((call) => call.method === 'sendMediaGroup');
    expect(send!.body).not.toHaveProperty('message_thread_id');
  });

  it('falls back to sendMessage when an ad has no photos', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 30, photos: 0 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(mediaGroups(stub.telegramCalls)).toBe(0);
    expect(stub.telegramCalls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
  });

  it('does nothing when there are no chats', async () => {
    const sourceId = await seedSource(true);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 40 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(stub.telegramCalls).toHaveLength(0);
    // Nothing was delivered, so nothing may be marked as seen.
    expect(await seenIds(sourceId)).toEqual([]);
  });
});

describe('ad age', () => {
  it('skips an old ad that OLX resurfaced via a refresh', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 110, title: 'bumped', created: '2023-12-31T14:15:00+02:00' },
        { id: 111, title: 'genuinely new', created: hoursAgo(2) },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('genuinely new');
    // The stale ad must not be recorded either — it never reached a chat.
    expect(await seenIds(sourceId)).toEqual([111]);
  });

  it('honours MAX_AD_AGE_HOURS', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 120, created: hoursAgo(5) }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MAX_AD_AGE_HOURS: '2' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(0);
  });

  it('drops an ad with an unparsable creation date', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 130, created: 'not-a-date' }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(stub.telegramCalls).toHaveLength(0);
  });

  it('still records every ad on the first sweep, however old', async () => {
    const sourceId = await seedSource(false);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 140, created: '2023-12-31T14:15:00+02:00' },
        { id: 141, created: hoursAgo(1) },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(await seenIds(sourceId)).toEqual([140, 141]);
  });
});

describe('seller trust', () => {
  it('skips an ad from an account younger than MIN_SELLER_AGE_DAYS', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 400, title: 'throwaway', sellerCreated: daysAgo(3) },
        { id: 401, title: 'established', sellerCreated: daysAgo(400) },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MIN_SELLER_AGE_DAYS: '30' }));

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('established');
    // Rejected, not consumed — nothing was delivered, so nothing may be recorded.
    expect(await seenIds(sourceId)).toEqual([401]);
  });

  it('lets an account through on the day it reaches the threshold', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 402, sellerCreated: daysAgo(30.01) }]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MIN_SELLER_AGE_DAYS: '30' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('checks nothing when MIN_SELLER_AGE_DAYS is 0', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 403, sellerCreated: hoursAgo(1) }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MIN_SELLER_AGE_DAYS: '0' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('passes an ad whose seller has no registration date, rather than muting the feed', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 404, sellerCreated: null }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MIN_SELLER_AGE_DAYS: '30' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('ignores OLX Доставка by default', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 405, safedeal: 'unactive' }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('requires OLX Доставка once REQUIRE_SAFEDEAL is on', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 406, title: 'no delivery', safedeal: 'unactive' },
        { id: 407, title: 'with delivery', safedeal: 'active' },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ REQUIRE_SAFEDEAL: 'true' }));

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('with delivery');
  });

  it('skips an ad that names no price, and keeps a negotiable one', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 420, title: 'bare arranged', price: 'arranged' },
        { id: 421, title: 'no price param', price: null },
        { id: 422, title: 'negotiable figure', price: 'negotiable' },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('negotiable figure');
    expect(captions[0]).toContain('2300 грн. (договірна)');
  });

  it('sends priceless ads once REQUIRE_PRICE is off', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 423, price: 'arranged' }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ REQUIRE_PRICE: 'false' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('still records every ad on the first sweep, however untrusted', async () => {
    const sourceId = await seedSource(false);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 410, sellerCreated: hoursAgo(1), safedeal: 'unactive' },
        { id: 411 },
        { id: 412, price: 'arranged' },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MIN_SELLER_AGE_DAYS: '30', REQUIRE_SAFEDEAL: 'true' }));

    expect(await seenIds(sourceId)).toEqual([410, 411, 412]);
  });
});

describe('blocked sellers', () => {
  it('skips a shop named by its slug and leaves everyone else alone', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([
        { id: 500, title: 'shop', shop: 'retromagaz' },
        { id: 501, title: 'private' },
      ]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ BLOCKED_SELLERS: 'retromagaz' }));

    const captions = stub.telegramCalls
      .filter((call) => call.method === 'sendMediaGroup')
      .map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('private');
    // Rejected, not consumed — the blocked ad was never delivered.
    expect(await seenIds(sourceId)).toEqual([501]);
  });

  it('matches the slug whatever the case', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 502, shop: 'RetroMagaz' }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ BLOCKED_SELLERS: 'RETROMAGAZ' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(0);
  });

  it('skips a private seller named by account id', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 503, sellerId: 98765 }, { id: 504, sellerId: 11111 }]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ BLOCKED_SELLERS: 'retromagaz,98765' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });

  it('blocks nobody when the list is empty', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 505, shop: 'retromagaz' }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ BLOCKED_SELLERS: '' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
  });
});

describe('watermark', () => {
  it('starts at the newest ad of the first sweep', async () => {
    const sourceId = await seedSource(false);
    await seedChats(-100);

    const newest = hoursAgo(1);
    const stub = makeFetchStub({
      offers: offersPayload([{ id: 200, created: hoursAgo(6) }, { id: 201, created: newest }]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(await watermark(sourceId)).toBe(unix(newest));
  });

  it('skips an ad created before the last one delivered', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const first = makeFetchStub({ offers: offersPayload([{ id: 210, created: hoursAgo(2) }]) });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv());
    expect(mediaGroups(first.telegramCalls)).toBe(1);

    // Unseen, well inside the age window, but created before the ad already sent.
    const second = makeFetchStub({
      offers: offersPayload([{ id: 211, created: hoursAgo(5) }, { id: 210, created: hoursAgo(2) }]),
    });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());

    expect(mediaGroups(second.telegramCalls)).toBe(0);
    expect(await seenIds(sourceId)).toEqual([210]);
  });

  it('lets an ad newer than the watermark through', async () => {
    await seedSource(true);
    await seedChats(-100);

    const first = makeFetchStub({ offers: offersPayload([{ id: 220, created: hoursAgo(3) }]) });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv());

    const second = makeFetchStub({
      offers: offersPayload([{ id: 221, title: 'later', created: hoursAgo(1) }]),
    });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());

    expect(mediaGroups(second.telegramCalls)).toBe(1);
  });

  it('does not overtake ads the subrequest budget left undelivered', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100, -200);

    // Captured once: the sends are spaced out, so calling hoursAgo() twice for
    // the same ad would yield two different timestamps.
    const second231 = hoursAgo(3);
    const offers = offersPayload([
      { id: 230, created: hoursAgo(4) },
      { id: 231, created: second231 },
      { id: 232, created: hoursAgo(2) },
      { id: 233, created: hoursAgo(1) },
    ]);

    // 10 total − 1 OLX fetch − 5 reserve leaves room for 2 broadcasts of 2 chats.
    const first = makeFetchStub({ offers });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv({ SUBREQUEST_BUDGET: '10' }));

    expect(await seenIds(sourceId)).toEqual([230, 231]);
    expect(await watermark(sourceId)).toBe(unix(second231));

    const second = makeFetchStub({ offers });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());

    expect(await seenIds(sourceId)).toEqual([230, 231, 232, 233]);
    // Eight sends, each behind SEND_DELAY_MS, outlast the default timeout.
  }, 30_000);

  it('keeps an ad sharing its second with the watermark', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100, -200);

    const sameSecond = hoursAgo(2);
    const offers = offersPayload([
      { id: 240, created: sameSecond },
      { id: 241, created: sameSecond },
    ]);

    // 8 total − 1 OLX fetch − 5 reserve leaves room for exactly one broadcast.
    const first = makeFetchStub({ offers });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv({ SUBREQUEST_BUDGET: '8' }));
    expect(await seenIds(sourceId)).toEqual([240]);

    const second = makeFetchStub({ offers });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());

    expect(await seenIds(sourceId)).toEqual([240, 241]);
  }, 30_000);

  it('stays put when nothing was delivered', async () => {
    const sourceId = await seedSource(true);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 250 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(await watermark(sourceId)).toBeNull();
  });
});

describe('deduplication', () => {
  it('sends nothing on a second run over identical data', async () => {
    await seedSource(true);
    await seedChats(-100);
    const offers = offersPayload([{ id: 50 }, { id: 51 }]);

    const first = makeFetchStub({ offers });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv());
    expect(mediaGroups(first.telegramCalls)).toBe(2);

    const second = makeFetchStub({ offers });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());
    expect(mediaGroups(second.telegramCalls)).toBe(0);
  });

  it('sends an ad only once when two searches both match it', async () => {
    const first = await seedSource(true);
    const second = await seedSource(true, `${API_URL}&other=1`);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([{ id: 300 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(stub.olxCalls).toHaveLength(2); // both searches did run
    expect(mediaGroups(stub.telegramCalls)).toBe(1);

    // Whichever search got there first owns the single row; the other records nothing.
    const owners = [...(await seenIds(first)), ...(await seenIds(second))];
    expect(owners).toEqual([300]);
  });

  it('skips an ad another search already claimed', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    // A row owned by a source that is not even polled here still blocks the send.
    await DB.prepare('INSERT INTO seen_ads (source_id, ad_id, sent_at) VALUES (999, 310, 0)').run();

    const stub = makeFetchStub({ offers: offersPayload([{ id: 310 }, { id: 311 }]) });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(mediaGroups(stub.telegramCalls)).toBe(1);
    expect(await seenIds(sourceId)).toEqual([311]);
  });

  it('only sends the ad that is actually new', async () => {
    await seedSource(true);
    await seedChats(-100);

    const first = makeFetchStub({ offers: offersPayload([{ id: 60 }]) });
    vi.stubGlobal('fetch', first.fetch);
    await pollSources(testEnv());

    const second = makeFetchStub({ offers: offersPayload([{ id: 61 }, { id: 60 }]) });
    vi.stubGlobal('fetch', second.fetch);
    await pollSources(testEnv());

    expect(mediaGroups(second.telegramCalls)).toBe(1);
  });
});

describe('subrequest budget', () => {
  it('leaves undelivered ads unseen so the next tick retries them', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100, -200);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 70 }, { id: 71 }, { id: 72 }, { id: 73 }]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    // 10 total − 1 OLX fetch − 5 reserve leaves room for 2 broadcasts of 2 chats.
    await pollSources(testEnv({ SUBREQUEST_BUDGET: '10' }));

    const sent = mediaGroups(stub.telegramCalls);
    expect(sent).toBe(4);

    const recorded = await seenIds(sourceId);
    expect(recorded).toHaveLength(2);
    expect(recorded.length * 2).toBe(sent);
  });

  it('honours MAX_SENDS_PER_TICK', async () => {
    await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 80 }, { id: 81 }, { id: 82 }, { id: 83 }]),
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv({ MAX_SENDS_PER_TICK: '2' }));

    expect(mediaGroups(stub.telegramCalls)).toBe(2);
  });
});

describe('Telegram failures', () => {
  it('stops the tick on 429 without marking the ad as seen', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 90 }, { id: 91 }]),
      telegram: (call) =>
        call.method === 'sendMediaGroup'
          ? new Response(
              JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 12 } }),
              { status: 429, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    expect(mediaGroups(stub.telegramCalls)).toBe(1); // stopped after the first rejection
    expect(await seenIds(sourceId)).toEqual([]);
  });

  it('disables a chat the bot was kicked from and keeps serving the rest', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100, -200);

    const stub = makeFetchStub({
      offers: offersPayload([{ id: 100 }]),
      telegram: (call) =>
        call.method === 'sendMediaGroup' && call.body.chat_id === -200
          ? new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was kicked' }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
    });
    vi.stubGlobal('fetch', stub.fetch);

    await pollSources(testEnv());

    const chat = await DB.prepare('SELECT enabled, last_error FROM chats WHERE chat_id = -200').first<{
      enabled: number;
      last_error: string;
    }>();
    expect(chat!.enabled).toBe(0);
    expect(chat!.last_error).toContain('kicked');

    // The healthy chat still got it, so the ad counts as delivered.
    expect(await seenIds(sourceId)).toEqual([100]);
  });
});

describe('source failures', () => {
  it('counts failures, disables at the threshold and warns the owner once', async () => {
    const sourceId = await seedSource(true);
    await seedChats(-100);

    const stub = makeFetchStub({ offers: offersPayload([]) });
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/v1/offers')) return new Response('nope', { status: 403 });
      return stub.fetch(input, init);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', failing);

    for (let attempt = 0; attempt < 3; attempt++) {
      await pollSources(testEnv({ MAX_FAILURES: '3' }));
    }

    const row = await DB.prepare('SELECT enabled, fail_count, last_error FROM sources WHERE id = ?')
      .bind(sourceId)
      .first<{ enabled: number; fail_count: number; last_error: string }>();

    expect(row!.fail_count).toBe(3);
    expect(row!.enabled).toBe(0);
    expect(row!.last_error).toContain('403');

    const warnings = stub.telegramCalls.filter(
      (call) => call.method === 'sendMessage' && String(call.body.text).includes('вимкнено'),
    );
    expect(warnings).toHaveLength(1);
  });
});
