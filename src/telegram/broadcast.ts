import { SEND_DELAY_MS } from '../config';
import { disableChat, type ChatRow } from '../db/chats';
import type { OlxAd } from '../olx/types';
import { renderAd } from '../render/message';
import { ChatUnreachableError, RateLimitedError, sleep, TelegramClient } from './api';
import type { TgInputMediaPhoto } from './types';

export interface BroadcastDeps {
  db: D1Database;
  telegram: TelegramClient;
  timezone: string;
}

export interface BroadcastResult {
  /** Subrequests actually spent. */
  spent: number;
  /** Chats that accepted the ad. */
  delivered: number;
  /** Set when Telegram asked us to back off; sending must stop for this tick. */
  rateLimited: boolean;
}

function buildMedia(caption: string, photoUrls: string[]): TgInputMediaPhoto[] {
  return photoUrls.map((media, index) => ({
    type: 'photo',
    media,
    ...(index === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
  }));
}

/** Telegram fetches the photo URLs itself, so no image ever passes through the worker. */
export async function sendAd(
  deps: BroadcastDeps,
  chatId: number,
  ad: OlxAd,
  threadId: number | null = null,
): Promise<void> {
  const { caption, photoUrls } = renderAd(ad, deps.timezone);

  if (photoUrls.length === 0) {
    await deps.telegram.sendMessage(chatId, caption, true, threadId);
    return;
  }
  await deps.telegram.sendMediaGroup(chatId, buildMedia(caption, photoUrls), threadId);
}

/**
 * Sends one ad to every active chat. A dead chat is disabled and skipped without
 * aborting the run; a 429 stops the whole tick, since waiting out a Telegram
 * backoff inside an invocation is worse than picking up 5 minutes later.
 */
export async function broadcastAd(
  deps: BroadcastDeps,
  chats: ChatRow[],
  ad: OlxAd,
): Promise<BroadcastResult> {
  let spent = 0;
  let delivered = 0;

  for (const chat of chats) {
    try {
      await sendAd(deps, chat.chat_id, ad, chat.thread_id);
      spent++;
      delivered++;
    } catch (error) {
      spent++;
      if (error instanceof RateLimitedError) {
        return { spent, delivered, rateLimited: true };
      }
      if (error instanceof ChatUnreachableError) {
        await disableChat(deps.db, chat.chat_id, error.reason);
        continue;
      }
      console.error(`broadcast to ${chat.chat_id} failed`, error);
    }

    await sleep(SEND_DELAY_MS);
  }

  return { spent, delivered, rateLimited: false };
}
