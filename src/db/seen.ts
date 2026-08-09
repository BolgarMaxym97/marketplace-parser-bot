const now = (): number => Math.floor(Date.now() / 1000);

/** Chunked so a wide search never builds an oversized SQL statement. */
const LOOKUP_CHUNK = 100;

/** Returns the subset of ids that has not been broadcast for this source yet. */
export async function filterUnseen(
  db: D1Database,
  sourceId: number,
  adIds: number[],
): Promise<Set<number>> {
  const unseen = new Set(adIds);

  for (let offset = 0; offset < adIds.length; offset += LOOKUP_CHUNK) {
    const chunk = adIds.slice(offset, offset + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');

    const { results } = await db
      .prepare(`SELECT ad_id FROM seen_ads WHERE source_id = ? AND ad_id IN (${placeholders})`)
      .bind(sourceId, ...chunk)
      .all<{ ad_id: number }>();

    for (const row of results) unseen.delete(row.ad_id);
  }

  return unseen;
}

/** INSERT OR IGNORE keeps this idempotent without a preceding SELECT. */
export async function markSeen(db: D1Database, sourceId: number, adId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO seen_ads (source_id, ad_id, sent_at) VALUES (?, ?, ?)')
    .bind(sourceId, adId, now())
    .run();
}

export async function markSeenBatch(db: D1Database, sourceId: number, adIds: number[]): Promise<void> {
  if (adIds.length === 0) return;

  const timestamp = now();
  const statement = db.prepare('INSERT OR IGNORE INTO seen_ads (source_id, ad_id, sent_at) VALUES (?, ?, ?)');
  await db.batch(adIds.map((adId) => statement.bind(sourceId, adId, timestamp)));
}

export async function countSeen(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM seen_ads').first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Keeps the newest N rows per source. Deleting purely by age is unsafe: an old ad
 * still present in the search results would look new again and be re-broadcast.
 */
export async function pruneSeen(db: D1Database, sourceId: number, keep: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM seen_ads
       WHERE source_id = ?
         AND ad_id NOT IN (
           SELECT ad_id FROM seen_ads WHERE source_id = ? ORDER BY sent_at DESC LIMIT ?
         )`,
    )
    .bind(sourceId, sourceId, keep)
    .run();

  return result.meta.changes ?? 0;
}
