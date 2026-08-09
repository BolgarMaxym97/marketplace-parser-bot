import { isOwner, readConfig, type Env } from '../config';
import { disableChat, upsertChat } from '../db/chats';
import { TelegramClient } from './api';
import { runCommand } from './commands';
import type { TgChatMemberUpdated, TgMessage, TgUpdate } from './types';

const ACTIVE_STATUSES = new Set(['member', 'administrator', 'creator', 'restricted']);

function chatTitle(update: TgChatMemberUpdated | TgMessage): string | null {
  const chat = update.chat;
  return chat.title ?? chat.username ?? chat.first_name ?? null;
}

async function handleMembership(db: D1Database, update: TgChatMemberUpdated): Promise<void> {
  const status = update.new_chat_member.status;

  if (ACTIVE_STATUSES.has(status)) {
    await upsertChat(db, update.chat.id, update.chat.type, chatTitle(update));
    return;
  }
  await disableChat(db, update.chat.id, `bot status: ${status}`);
}

async function handleMessage(env: Env, message: TgMessage): Promise<void> {
  const config = readConfig(env);
  const telegram = new TelegramClient(env.BOT_TOKEN);
  const text = message.text ?? '';

  // A private chat is NOT registered for broadcast just by opening the bot:
  // Telegram forces /start before it even shows an input field, so treating that
  // as consent would flood the owner's DM. Opt in explicitly with /subscribe.
  if (!text.startsWith('/')) return;

  // Authorise the SENDER, not the chat. In a group `chat.id` is the group's own
  // negative id, which never matches a personal owner id — checking it would make
  // every in-group command fail, while adding the group id to OWNER_CHAT_ID to
  // work around that would hand /rm and /add to every member.
  // Channel posts carry no `from`, so commands there are ignored by design.
  const senderId = message.from?.id;
  if (senderId === undefined || !isOwner(config, senderId)) return;

  // Answer in the thread the command came from — without message_thread_id
  // Telegram drops the reply into "General", far from where it was typed.
  const threadId = message.message_thread_id ?? null;

  try {
    const reply = await runCommand(
      {
        db: env.DB,
        telegram,
        config,
        chatId: message.chat.id,
        chatType: message.chat.type,
        chatTitle: chatTitle(message),
        threadId,
        // Only a real forum topic may become a broadcast target; message_thread_id
        // is also set on ordinary threaded replies, which are not topics.
        isForumTopic: message.is_topic_message === true,
      },
      text,
    );
    if (reply) await telegram.sendMessage(message.chat.id, reply, true, threadId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await telegram
      .sendMessage(message.chat.id, `❌ ${reason}`, true, threadId)
      .catch(() => undefined);
  }
}

/**
 * Always answers 200: a non-2xx makes Telegram retry the same update, which would
 * replay a failing command forever. Errors go to the owner as text instead.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('ok');
  }

  try {
    if (update.my_chat_member) await handleMembership(env.DB, update.my_chat_member);

    const message = update.message ?? update.channel_post;
    if (message) await handleMessage(env, message);
  } catch (error) {
    console.error('webhook handling failed', error);
  }

  return new Response('ok');
}
