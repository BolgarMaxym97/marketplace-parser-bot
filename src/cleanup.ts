import { readConfig, type Env } from './config';
import { pruneSeen } from './db/seen';
import { listSources } from './db/sources';

/** Nightly retention: keep the newest N seen_ads rows per source. */
export async function cleanupSeen(env: Env): Promise<number> {
  const config = readConfig(env);
  const sources = await listSources(env.DB);

  let removed = 0;
  for (const source of sources) {
    removed += await pruneSeen(env.DB, source.id, config.retentionPerSource);
  }

  return removed;
}
