export interface ChatRow {
  chat_id: number;
  type: string;
  title: string | null;
  enabled: number;
  last_error: string | null;
  added_at: number;
  /** Forum topic to post into; null means the chat has no topics. */
  thread_id: number | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Called when the bot is added to a chat. Deliberately leaves thread_id alone:
 * my_chat_member cannot tell us which topic to use, and clearing it here would
 * silently move an already-configured feed back to "General".
 */
export async function upsertChat(
  db: D1Database,
  chatId: number,
  type: string,
  title: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (chat_id, type, title, enabled, last_error, added_at)
       VALUES (?, ?, ?, 1, NULL, ?)
       ON CONFLICT (chat_id) DO UPDATE
       SET type = excluded.type, title = excluded.title, enabled = 1, last_error = NULL`,
    )
    .bind(chatId, type, title, now())
    .run();
}

/** Called by /subscribe, which knows the topic it was sent from. */
export async function subscribeChat(
  db: D1Database,
  chatId: number,
  type: string,
  title: string | null,
  threadId: number | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (chat_id, type, title, enabled, last_error, added_at, thread_id)
       VALUES (?, ?, ?, 1, NULL, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE
       SET type = excluded.type, title = excluded.title, enabled = 1,
           last_error = NULL, thread_id = excluded.thread_id`,
    )
    .bind(chatId, type, title, now(), threadId)
    .run();
}

/** Called when the bot is kicked, or when a send fails with 403 / chat not found. */
export async function disableChat(db: D1Database, chatId: number, reason: string): Promise<void> {
  await db
    .prepare('UPDATE chats SET enabled = 0, last_error = ? WHERE chat_id = ?')
    .bind(reason.slice(0, 500), chatId)
    .run();
}

export async function activeChats(db: D1Database): Promise<ChatRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM chats WHERE enabled = 1 ORDER BY chat_id')
    .all<ChatRow>();
  return results;
}

export async function listChats(db: D1Database): Promise<ChatRow[]> {
  const { results } = await db.prepare('SELECT * FROM chats ORDER BY enabled DESC, chat_id').all<ChatRow>();
  return results;
}
