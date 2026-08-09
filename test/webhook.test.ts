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
