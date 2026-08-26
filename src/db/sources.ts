export interface SourceRow {
  id: number;
  page_url: string;
  api_url: string;
  label: string | null;
  enabled: number;
  initialized: number;
  last_run_at: number | null;
  last_error: string | null;
  fail_count: number;
  created_at: number;
  /** Creation time of the newest ad already broadcast, unix seconds. */
  last_created_at: number | null;
  /** 1 when the search feeds private chats only — added with /add-for-me. */
  private_only: number;
}

const now = (): number => Math.floor(Date.now() / 1000);

export async function addSource(
  db: D1Database,
  pageUrl: string,
  apiUrl: string,
  label: string,
  privateOnly: boolean,
): Promise<SourceRow | null> {
  return db
    .prepare(
      `INSERT INTO sources (page_url, api_url, label, created_at, private_only)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (api_url) DO NOTHING
       RETURNING *`,
    )
    .bind(pageUrl, apiUrl, label, now(), privateOnly ? 1 : 0)
    .first<SourceRow>();
}

export async function getSource(db: D1Database, id: number): Promise<SourceRow | null> {
  return db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>();
}

export async function listSources(db: D1Database): Promise<SourceRow[]> {
  const { results } = await db.prepare('SELECT * FROM sources ORDER BY id').all<SourceRow>();
  return results;
}

/** Oldest-polled first, so a backlog drains fairly instead of starving the tail. */
export async function pickDueSources(db: D1Database, limit: number): Promise<SourceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sources
       WHERE enabled = 1
       ORDER BY COALESCE(last_run_at, 0) ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<SourceRow>();
  return results;
}

export async function deleteSource(db: D1Database, id: number): Promise<boolean> {
  await db.prepare('DELETE FROM seen_ads WHERE source_id = ?').bind(id).run();
  const result = await db.prepare('DELETE FROM sources WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setEnabled(db: D1Database, id: number, enabled: boolean): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sources
       SET enabled = ?, fail_count = CASE WHEN ? = 1 THEN 0 ELSE fail_count END
       WHERE id = ?`,
    )
    .bind(enabled ? 1 : 0, enabled ? 1 : 0, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markInitialized(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE sources SET initialized = 1 WHERE id = ?').bind(id).run();
}

/**
 * Raises the watermark, never lowers it. A tick cut short by the subrequest
 * budget must not push the mark past ads it never delivered, and two ticks
 * racing must not let the older one win.
 */
export async function advanceWatermark(
  db: D1Database,
  id: number,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sources
       SET last_created_at = ?
       WHERE id = ? AND (last_created_at IS NULL OR last_created_at < ?)`,
    )
    .bind(createdAt, id, createdAt)
    .run();
}

export async function markSuccess(db: D1Database, id: number): Promise<void> {
  await db
    .prepare('UPDATE sources SET last_run_at = ?, last_error = NULL, fail_count = 0 WHERE id = ?')
    .bind(now(), id)
    .run();
}

/**
 * Bumps the failure counter and disables the source once it trips the threshold,
 * so a dead search stops burning one subrequest every tick forever.
 * Returns the new fail_count, or null if the row vanished.
 */
export async function markFailure(
  db: D1Database,
  id: number,
  message: string,
  maxFailures: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE sources
       SET last_run_at = ?,
           last_error = ?,
           fail_count = fail_count + 1,
           enabled = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE enabled END
       WHERE id = ?
       RETURNING fail_count`,
    )
    .bind(now(), message.slice(0, 500), maxFailures, id)
    .first<{ fail_count: number }>();

  return row?.fail_count ?? null;
}

export async function countSources(db: D1Database): Promise<{ total: number; enabled: number }> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM sources')
    .first<{ total: number; enabled: number }>();
  return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 };
}
