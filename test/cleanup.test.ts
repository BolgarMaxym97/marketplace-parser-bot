import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupSeen } from '../src/cleanup';
import type { Env } from '../src/config';
import { applySchema, resetDb } from './helpers';

const DB = env.DB as D1Database;

async function seedSource(label: string): Promise<number> {
  const row = await DB.prepare(
    `INSERT INTO sources (page_url, api_url, label, initialized, created_at)
     VALUES ('https://www.olx.ua/uk/q-x/', ?, ?, 1, 0)
     RETURNING id`,
  )
    .bind(`https://www.olx.ua/api/v1/offers?query=${label}`, label)
    .first<{ id: number }>();
  return row!.id;
}

async function seedSeen(sourceId: number, count: number, base = 0): Promise<void> {
  const statement = DB.prepare('INSERT INTO seen_ads (source_id, ad_id, sent_at) VALUES (?, ?, ?)');
  await DB.batch(
    Array.from({ length: count }, (_, index) => statement.bind(sourceId, base + index, base + index)),
  );
}

const remaining = async (sourceId: number): Promise<number[]> => {
  const { results } = await DB.prepare('SELECT ad_id FROM seen_ads WHERE source_id = ? ORDER BY ad_id')
    .bind(sourceId)
    .all<{ ad_id: number }>();
  return results.map((row) => row.ad_id);
};

beforeAll(async () => {
  await applySchema(DB);
});

beforeEach(async () => {
  await resetDb(DB);
});

describe('cleanupSeen', () => {
  it('keeps the newest N rows per source and drops the rest', async () => {
    const sourceId = await seedSource('a');
    await seedSeen(sourceId, 10);

    const removed = await cleanupSeen({ ...(env as unknown as Env), RETENTION_PER_SOURCE: '4' });

    expect(removed).toBe(6);
    expect(await remaining(sourceId)).toEqual([6, 7, 8, 9]);
  });

  it('prunes each source independently', async () => {
    const first = await seedSource('a');
    const second = await seedSource('b');
    await seedSeen(first, 5, 0);
    await seedSeen(second, 2, 100);

    await cleanupSeen({ ...(env as unknown as Env), RETENTION_PER_SOURCE: '3' });

    expect(await remaining(first)).toEqual([2, 3, 4]);
    expect(await remaining(second)).toEqual([100, 101]);
  });

  it('does nothing when a source is under the retention limit', async () => {
    const sourceId = await seedSource('a');
    await seedSeen(sourceId, 3);

    const removed = await cleanupSeen({ ...(env as unknown as Env), RETENTION_PER_SOURCE: '500' });

    expect(removed).toBe(0);
    expect(await remaining(sourceId)).toHaveLength(3);
  });
});
