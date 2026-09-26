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
  /** Earliest poll after a transient failure, unix seconds. NULL means due now. */
  next_run_at: number | null;
}

export interface FailurePolicy {
  /** OLX's fault rather than the search's: back off, never disable. */
  transient: boolean;
  /** Permanent failures in a row that disable the source. */
  maxFailures: number;
  /** Delay after the first transient failure; it doubles with each one after. */
  backoffBaseSeconds: number;
  /** Ceiling on that delay, so a source is back within this long of OLX recovering. */
  backoffMaxSeconds: number;
}

/**
 * A tick lands a few seconds past the minute and the failure is written seconds
 * after that, so a retry due at exactly one interval later would slip a whole tick.
 */
const DUE_SLACK_SECONDS = 60;

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

/**
 * Oldest-polled first, so a backlog drains fairly instead of starving the tail.
 * A source backing off after a transient failure sits out until its retry is due.
 */
export async function pickDueSources(db: D1Database, limit: number): Promise<SourceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sources
       WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY COALESCE(last_run_at, 0) ASC
       LIMIT ?`,
    )
    .bind(now() + DUE_SLACK_SECONDS, limit)
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
       SET enabled = ?,
           fail_count = CASE WHEN ? = 1 THEN 0 ELSE fail_count END,
           next_run_at = NULL
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
    .prepare(
      `UPDATE sources
       SET last_run_at = ?, last_error = NULL, fail_count = 0, next_run_at = NULL
       WHERE id = ?`,
    )
    .bind(now(), id)
    .run();
}

/**
 * Bumps the failure counter and reschedules or disables the source.
 *
 * A transient failure — OLX down, throttling, a timeout — never disables: the next
 * poll is pushed out by base × 2^(failures − 1), capped, so an outage costs a
 * handful of subrequests and the source resumes by itself on the first success.
 * A permanent one disables the source once it trips the threshold, so a dead
 * search stops burning one subrequest every tick forever.
 *
 * The exponent is capped well below 64 so the shift cannot wrap in SQLite.
 * Returns the new fail_count, or null if the row vanished.
 */
export async function markFailure(
  db: D1Database,
  id: number,
  message: string,
  policy: FailurePolicy,
): Promise<number | null> {
  const transient = policy.transient ? 1 : 0;
  const timestamp = now();

  const row = await db
    .prepare(
      `UPDATE sources
       SET last_run_at = ?1,
           last_error = ?2,
           fail_count = fail_count + 1,
           next_run_at = CASE WHEN ?3 = 1
             THEN ?1 + MIN(?5 << MIN(fail_count, 20), ?6)
             ELSE NULL END,
           enabled = CASE WHEN ?3 = 0 AND fail_count + 1 >= ?4 THEN 0 ELSE enabled END
       WHERE id = ?7
       RETURNING fail_count`,
    )
    .bind(
      timestamp,
      message.slice(0, 500),
      transient,
      policy.maxFailures,
      policy.backoffBaseSeconds,
      policy.backoffMaxSeconds,
      id,
    )
    .first<{ fail_count: number }>();

  return row?.fail_count ?? null;
}

export async function countSources(db: D1Database): Promise<{ total: number; enabled: number }> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM sources')
    .first<{ total: number; enabled: number }>();
  return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 };
}
