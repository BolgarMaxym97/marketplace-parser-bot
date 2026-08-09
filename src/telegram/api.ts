import { FETCH_TIMEOUT_MS } from '../config';
import type { TgInputMediaPhoto } from './types';

export interface TelegramResult {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Telegram asked us to back off. The caller must stop sending for this tick. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super(`Telegram rate limited, retry after ${retryAfter}s`);
    this.name = 'RateLimitedError';
  }
}

/** The chat is gone or the bot was removed from it. The caller should disable it. */
export class ChatUnreachableError extends Error {
  constructor(readonly chatId: number, readonly reason: string) {
    super(`Chat ${chatId} unreachable: ${reason}`);
    this.name = 'ChatUnreachableError';
  }
}

function isUnreachable(status: number, description: string): boolean {
  if (status === 403) return true;
  const text = description.toLowerCase();
  return (
    status === 400 &&
    (text.includes('chat not found') ||
      text.includes('chat_id is empty') ||
      text.includes('group chat was upgraded'))
  );
}

export class TelegramClient {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /** One subrequest per call. */
  async call<T = unknown>(method: string, payload: unknown, chatId?: number): Promise<T> {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({ ok: false }))) as TelegramResult & { result?: T };

    if (body.ok) return body.result as T;

    const description = body.description ?? `HTTP ${response.status}`;

    if (response.status === 429) {
      throw new RateLimitedError(body.parameters?.retry_after ?? 30);
    }
    if (chatId !== undefined && isUnreachable(response.status, description)) {
      throw new ChatUnreachableError(chatId, description);
    }

    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  async sendMessage(
    chatId: number,
    text: string,
    disablePreview = true,
    threadId: number | null = null,
  ): Promise<void> {
    await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: disablePreview },
        ...(threadId === null ? {} : { message_thread_id: threadId }),
      },
      chatId,
    );
  }

  async sendMediaGroup(
    chatId: number,
    media: TgInputMediaPhoto[],
    threadId: number | null = null,
  ): Promise<void> {
    await this.call(
      'sendMediaGroup',
      { chat_id: chatId, media, ...(threadId === null ? {} : { message_thread_id: threadId }) },
      chatId,
    );
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'channel_post', 'my_chat_member'],
    });
  }
}

/** Wall-clock wait; it does not consume the Workers CPU budget. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
