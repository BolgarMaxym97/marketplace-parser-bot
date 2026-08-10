const now = (): number => Math.floor(Date.now() / 1000);

/** Chunked so a wide search never builds an oversized SQL statement. */
const LOOKUP_CHUNK = 100;

/**
 * Returns the subset of ids no search has broadcast yet.
 *
 * The check ignores source_id on purpose: two searches with overlapping filters
 * return the same ad, and the chats they feed are the same set, so whoever gets
 * there first owns it.
 */
export async function filterUnseen(db: D1Database, adIds: number[]): Promise<Set<number>> {
  const unseen = new Set(adIds);

  for (let offset = 0; offset < adIds.length; offset += LOOKUP_CHUNK) {
    const chunk = adIds.slice(offset, offset + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');

    const { results } = await db
      .prepare(`SELECT ad_id FROM seen_ads WHERE ad_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ ad_id: number }>();

    for (const row of results) unseen.delete(row.ad_id);
  }

  return unseen;
}

/**
 * Takes ownership of an ad before it is broadcast. Returns false when another
 * search — or another, overlapping invocation of this one — already holds it.
 *
 * filterUnseen alone cannot decide this: it runs once per source, minutes or
 * milliseconds before the send, and two ticks can be inside that gap at the same
 * time. The insert is a single statement, so the row either exists or is created
 * by exactly one caller, and the loser sends nothing.
 */
export async function claimAd(db: D1Database, sourceId: number, adId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO seen_ads (source_id, ad_id, sent_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM seen_ads WHERE ad_id = ?)`,
    )
    .bind(sourceId, adId, now(), adId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Gives a claim back when the broadcast reached nobody, so the next tick retries
 * the ad instead of burying it. Scoped to the claiming source so it can never
 * erase a delivery somebody else recorded.
 */
export async function releaseAd(db: D1Database, sourceId: number, adId: number): Promise<void> {
  await db
    .prepare('DELETE FROM seen_ads WHERE source_id = ? AND ad_id = ?')
    .bind(sourceId, adId)
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
