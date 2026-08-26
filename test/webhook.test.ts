import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import { handleWebhook } from '../src/telegram/webhook';
import { applySchema, makeFetchStub, offersPayload, resetDb, type TelegramCall } from './helpers';

const DB = env.DB as D1Database;
const OWNER = 777;

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), OWNER_CHAT_ID: String(OWNER), ...overrides };
}

function post(update: unknown, secret = 'test-secret'): Request {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  });
}

const message = (
  text: string,
  chat: { id: number; type: string; title?: string },
  senderId = OWNER,
) => ({
  update_id: 1,
  message: { message_id: 1, chat, text, from: { id: senderId } },
});

const membership = (chatId: number, status: string) => ({
  update_id: 2,
  my_chat_member: {
    chat: { id: chatId, type: 'channel', title: 'eblx' },
    from: { id: OWNER },
    new_chat_member: { status },
  },
});

const chatRow = (chatId: number) =>
  DB.prepare('SELECT * FROM chats WHERE chat_id = ?')
    .bind(chatId)
    .first<{ type: string; title: string | null; enabled: number; thread_id: number | null }>();

let calls: TelegramCall[];

beforeAll(async () => {
  await applySchema(DB);
});

beforeEach(async () => {
  await resetDb(DB);
  const stub = makeFetchStub({ offers: offersPayload([]) });
  calls = stub.telegramCalls;
  vi.stubGlobal('fetch', stub.fetch);
});

describe('secret token', () => {
  it('rejects a request without the right header', async () => {
    const response = await handleWebhook(post(message('/help', { id: OWNER, type: 'private' }), 'wrong'), testEnv());

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('/start', () => {
  it('answers with help but does NOT add the private chat to the broadcast', async () => {
    // Telegram forces /start before showing an input field, so it cannot mean consent.
    await handleWebhook(post(message('/start', { id: OWNER, type: 'private' })), testEnv());

    expect(await chatRow(OWNER)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.body.text)).toContain('Команди');
  });
});

describe('/subscribe and /unsubscribe', () => {
  it('opts the current chat in and back out', async () => {
    await handleWebhook(post(message('/subscribe', { id: OWNER, type: 'private' })), testEnv());
    expect((await chatRow(OWNER))!.enabled).toBe(1);

    await handleWebhook(post(message('/unsubscribe', { id: OWNER, type: 'private' })), testEnv());
    expect((await chatRow(OWNER))!.enabled).toBe(0);
  });

  it('works inside a group, where chat.id is the group and not the owner', async () => {
    const update = message('/subscribe', { id: -100, type: 'supergroup', title: 'eblx' });
    await handleWebhook(post(update), testEnv());

    const row = await chatRow(-100);
    expect(row!.type).toBe('supergroup');
    expect(row!.title).toBe('eblx');
    expect(row!.thread_id).toBeNull();
  });

  it('ignores a group member who is not an owner', async () => {
    const update = message('/subscribe', { id: -100, type: 'supergroup', title: 'eblx' }, 999);
    await handleWebhook(post(update), testEnv());

    expect(await chatRow(-100)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('forum topics', () => {
  const inTopic = (threadId: number, { isTopic = true, senderId = OWNER } = {}) => ({
    update_id: 3,
    message: {
      message_id: 1,
      chat: { id: -100, type: 'supergroup', title: 'eblx' },
      from: { id: senderId },
      text: '/subscribe',
      message_thread_id: threadId,
      is_topic_message: isTopic,
    },
  });

  it('pins the feed to the topic /subscribe was sent from', async () => {
    await handleWebhook(post(inTopic(42)), testEnv());
    expect((await chatRow(-100))!.thread_id).toBe(42);
  });

  it('answers inside the topic instead of General', async () => {
    await handleWebhook(post(inTopic(42)), testEnv());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.message_thread_id).toBe(42);
  });

  it('answers in the thread even when it is not a forum topic', async () => {
    // The reply belongs where it was typed, whether or not the thread can be
    // subscribed to.
    await handleWebhook(post(inTopic(42, { isTopic: false })), testEnv());

    expect(calls[0]!.body.message_thread_id).toBe(42);
    expect((await chatRow(-100))!.thread_id).toBeNull();
  });

  it('omits message_thread_id in a chat without threads', async () => {
    await handleWebhook(post(message('/help', { id: OWNER, type: 'private' })), testEnv());

    expect(calls[0]!.body).not.toHaveProperty('message_thread_id');
  });

  it('ignores message_thread_id on a plain threaded reply', async () => {
    // Outside a forum, message_thread_id is just the reply chain — posting into
    // it would put the feed in the wrong place.
    await handleWebhook(post(inTopic(42, { isTopic: false })), testEnv());
    expect((await chatRow(-100))!.thread_id).toBeNull();
  });

  it('does not lose the topic when the bot is re-promoted', async () => {
    await handleWebhook(post(inTopic(42)), testEnv());
    await handleWebhook(post(membership(-100, 'administrator')), testEnv());

    expect((await chatRow(-100))!.thread_id).toBe(42);
  });

  it('moves the feed when an owner runs /subscribe in another topic', async () => {
    await handleWebhook(post(inTopic(42)), testEnv());
    await handleWebhook(post(inTopic(77)), testEnv());

    expect((await chatRow(-100))!.thread_id).toBe(77);
  });

  it('will not let a non-owner move the feed to their topic', async () => {
    await handleWebhook(post(inTopic(42)), testEnv());
    await handleWebhook(post(inTopic(77, { senderId: 999 })), testEnv());

    expect((await chatRow(-100))!.thread_id).toBe(42);
  });
});

describe('my_chat_member', () => {
  it('registers a channel when the bot is promoted', async () => {
    await handleWebhook(post(membership(-100500, 'administrator')), testEnv());

    const row = await chatRow(-100500);
    expect(row!.enabled).toBe(1);
    expect(row!.type).toBe('channel');
  });

  it('disables the chat when the bot is kicked', async () => {
    await handleWebhook(post(membership(-100500, 'administrator')), testEnv());
    await handleWebhook(post(membership(-100500, 'kicked')), testEnv());

    expect((await chatRow(-100500))!.enabled).toBe(0);
  });
});

describe('access control', () => {
  it('ignores a command from a stranger without replying', async () => {
    const stranger = message('/list', { id: 999, type: 'private' }, 999);
    const response = await handleWebhook(post(stranger), testEnv());

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('accepts commands from any listed owner', async () => {
    await handleWebhook(
      post(message('/help', { id: 888, type: 'private' }, 888)),
      testEnv({ OWNER_CHAT_ID: '777,888' }),
    );

    expect(calls).toHaveLength(1);
  });

  it('ignores a channel post, which carries no sender to authorise', async () => {
    const response = await handleWebhook(
      post({
        update_id: 9,
        channel_post: { message_id: 1, chat: { id: -100500, type: 'channel' }, text: '/rm 1' },
      }),
      testEnv(),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe('/business', () => {
  const setting = () =>
    DB.prepare("SELECT value FROM settings WHERE key = 'allow_business_ads'").first<{ value: string }>();

  const reply = () => String(calls.at(-1)!.body.text);

  it('reports the env default while no row is written', async () => {
    await handleWebhook(post(message('/business', { id: OWNER, type: 'private' })), testEnv());

    expect(reply()).toContain('вимкнено');
    expect(await setting()).toBeNull();
  });

  it('turns business ads on and off, and the row survives the env default', async () => {
    await handleWebhook(post(message('/business on', { id: OWNER, type: 'private' })), testEnv());
    expect((await setting())!.value).toBe('1');

    await handleWebhook(post(message('/business', { id: OWNER, type: 'private' })), testEnv());
    expect(reply()).toContain('увімкнено');

    await handleWebhook(post(message('/business off', { id: OWNER, type: 'private' })), testEnv());
    expect((await setting())!.value).toBe('0');

    // ALLOW_BUSINESS_ADS says yes; the owner said no, and the owner wins.
    await handleWebhook(
      post(message('/business', { id: OWNER, type: 'private' })),
      testEnv({ ALLOW_BUSINESS_ADS: 'true' }),
    );
    expect(reply()).toContain('вимкнено');
  });

  it('rejects an argument it does not understand and writes nothing', async () => {
    await handleWebhook(post(message('/business maybe', { id: OWNER, type: 'private' })), testEnv());

    expect(reply()).toContain('/business on');
    expect(await setting()).toBeNull();
  });

  it('will not let a non-owner change it', async () => {
    await handleWebhook(post(message('/business on', { id: 999, type: 'private' }, 999)), testEnv());

    expect(calls).toHaveLength(0);
    expect(await setting()).toBeNull();
  });
});

describe('/add and /add-for-me', () => {
  // An api/v1/offers URL is taken as-is, so nothing has to resolve a search page.
  const API = 'https://www.olx.ua/api/v1/offers?query=test';

  const reply = () => String(calls.at(-1)!.body.text);

  const send = (text: string) =>
    handleWebhook(post(message(text, { id: OWNER, type: 'private' })), testEnv());

  const sourceRow = () =>
    DB.prepare('SELECT id, private_only FROM sources ORDER BY id DESC').first<{
      id: number;
      private_only: number;
    }>();

  it('adds an ordinary search that feeds every chat', async () => {
    await send(`/add ${API}`);

    expect((await sourceRow())!.private_only).toBe(0);
    expect(reply()).toContain('В усі підписані чати');
  });

  it('adds a private-only search and says so', async () => {
    await send(`/add-for-me ${API}`);

    expect((await sourceRow())!.private_only).toBe(1);
    expect(reply()).toContain('Тільки в особисті чати');
  });

  it('marks a private-only search in /list', async () => {
    await send(`/add-for-me ${API}`);
    await send('/list');

    expect(reply()).toContain('👤');
  });

  it('leaves the flag of an existing search alone and says how to change it', async () => {
    await send(`/add ${API}`);
    const before = await sourceRow();

    await send(`/add-for-me ${API}`);

    expect(reply()).toContain('уже додано');
    expect((await sourceRow())!.id).toBe(before!.id);
    expect((await sourceRow())!.private_only).toBe(0);
  });

  it('will not let a non-owner add anything', async () => {
    await handleWebhook(post(message(`/add-for-me ${API}`, { id: 999, type: 'private' }, 999)), testEnv());

    expect(calls).toHaveLength(0);
    expect(await sourceRow()).toBeNull();
  });
});

describe('/hours', () => {
  const setting = () =>
    DB.prepare("SELECT value FROM settings WHERE key = 'group_hours'").first<{ value: string }>();

  const reply = () => String(calls.at(-1)!.body.text);

  const send = (text: string, env = testEnv()) =>
    handleWebhook(post(message(text, { id: OWNER, type: 'private' })), env);

  it('reports the env window, and says the private chat is never held back', async () => {
    await send('/hours');

    expect(reply()).toContain('09:00–23:00');
    expect(reply()).toContain('цілодобово');
    expect(await setting()).toBeNull();
  });

  it('sets a window and reports it back', async () => {
    await send('/hours 10-20');
    expect((await setting())!.value).toBe('10-20');

    await send('/hours');
    expect(reply()).toContain('10:00–20:00');
  });

  it('turns the window off, and the row outranks the env var', async () => {
    await send('/hours off');
    expect((await setting())!.value).toBe('off');

    await send('/hours', testEnv({ GROUP_HOURS: '9-23' }));
    expect(reply()).toContain('цілодобово');
  });

  it.each(['/hours evenings', '/hours 9-24', '/hours 9-9'])(
    'rejects %s and writes nothing',
    async (text) => {
      await send(text);

      expect(reply()).toContain('/hours 9-23');
      expect(await setting()).toBeNull();
    },
  );

  it('will not let a non-owner change it', async () => {
    await handleWebhook(post(message('/hours off', { id: 999, type: 'private' }, 999)), testEnv());

    expect(calls).toHaveLength(0);
    expect(await setting()).toBeNull();
  });
});

describe('/block, /unblock, /blocked', () => {
  const setting = () =>
    DB.prepare("SELECT value FROM settings WHERE key = 'blocked_sellers'").first<{ value: string }>();

  const reply = () => String(calls.at(-1)!.body.text);

  const send = (text: string, env = testEnv({ BLOCKED_SELLERS: 'retromagaz' })) =>
    handleWebhook(post(message(text, { id: OWNER, type: 'private' })), env);

  it('lists the env blocklist while no row is written', async () => {
    await send('/blocked');

    expect(reply()).toContain('retromagaz');
    expect(await setting()).toBeNull();
  });

  it('keeps the env entries when the first /block is written', async () => {
    // Writing only the new entry would silently unblock whoever the var names.
    await send('/block 12345');

    expect((await setting())!.value).toBe('retromagaz,12345');
    expect(reply()).toContain('12345');
  });

  it('adds several at once and lowercases them', async () => {
    await send('/block AtC, 999');

    expect((await setting())!.value).toBe('retromagaz,atc,999');
  });

  it('says nothing changed when the entry is already there', async () => {
    await send('/block retromagaz');

    expect(reply()).toContain('Уже були в списку');
  });

  it('removes an entry the env var named', async () => {
    await send('/unblock retromagaz');

    expect((await setting())!.value).toBe('');
    expect(reply()).toContain('Розблоковано');
  });

  it('reports an entry it could not find, and writes nothing', async () => {
    await send('/unblock nobody');

    expect(reply()).toContain('Не знайшов');
    expect(await setting()).toBeNull();
  });

  it('reads the list back from the row on the next command', async () => {
    await send('/block 12345');
    await send('/unblock retromagaz');
    await send('/blocked');

    expect(reply()).toContain('12345');
    expect(reply()).not.toContain('retromagaz');
  });

  it.each(['/block', '/unblock'])('rejects %s with no argument', async (text) => {
    await send(text);

    expect(reply()).toContain('Вкажи продавця');
    expect(await setting()).toBeNull();
  });

  it('will not let a non-owner change the list', async () => {
    await handleWebhook(post(message('/block 1', { id: 999, type: 'private' }, 999)), testEnv());

    expect(calls).toHaveLength(0);
    expect(await setting()).toBeNull();
  });
});

describe('always answers 200', () => {
  it.each([
    ['a malformed body', new Request('https://worker.test/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
      body: 'not json',
    })],
    ['an unknown command', post(message('/nope', { id: OWNER, type: 'private' }))],
  ])('on %s', async (_label, request) => {
    // A non-2xx makes Telegram replay the same update forever.
    expect((await handleWebhook(request, testEnv())).status).toBe(200);
  });
});
