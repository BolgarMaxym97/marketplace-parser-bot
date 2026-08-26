/**
 * Runtime settings an owner can flip from Telegram, so a toggle does not need a
 * redeploy. Deliberately schemaless key/value: the table already exists from the
 * first migration, and every knob here has an env var behind it as the default.
 */
interface SettingRow {
  key: string;
  value: string;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** One read per tick. The table holds a handful of rows, so it is fetched whole. */
export async function readSettings(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<SettingRow>();
  return new Map(results.map((row) => [row.key, row.value]));
}

export async function writeSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now())
    .run();
}
