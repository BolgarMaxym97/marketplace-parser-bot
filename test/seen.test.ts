import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimAd, filterUnseen, markSeenBatch, releaseAd } from '../src/db/seen';
import { applySchema, resetDb } from './helpers';

const DB = env.DB as D1Database;

const ownerOf = async (adId: number): Promise<number | null> => {
  const row = await DB.prepare('SELECT source_id FROM seen_ads WHERE ad_id = ?')
    .bind(adId)
    .first<{ source_id: number }>();
  return row?.source_id ?? null;
};

beforeAll(async () => {
  await applySchema(DB);
});

beforeEach(async () => {
  await resetDb(DB);
});

describe('claimAd', () => {
  it('lets exactly one caller through, whichever source asks', async () => {
    expect(await claimAd(DB, 1, 500)).toBe(true);
    expect(await claimAd(DB, 2, 500)).toBe(false);
    expect(await claimAd(DB, 1, 500)).toBe(false);

    // The loser must not have overwritten the owner.
    expect(await ownerOf(500)).toBe(1);
  });

  it('does not block a different ad', async () => {
    await claimAd(DB, 1, 501);
    expect(await claimAd(DB, 1, 502)).toBe(true);
  });

  it('is blocked by a first sweep of another search', async () => {
    await markSeenBatch(DB, 1, [503]);
    expect(await claimAd(DB, 2, 503)).toBe(false);
  });
});

describe('releaseAd', () => {
  it('frees the ad for the next attempt', async () => {
    await claimAd(DB, 1, 510);
    await releaseAd(DB, 1, 510);

    expect(await ownerOf(510)).toBeNull();
    expect(await claimAd(DB, 2, 510)).toBe(true);
  });

  it('ignores a claim held by another source', async () => {
    await claimAd(DB, 1, 511);
    await releaseAd(DB, 2, 511);

    expect(await ownerOf(511)).toBe(1);
  });
});

describe('filterUnseen', () => {
  it('reports an ad seen by any source as seen', async () => {
    await markSeenBatch(DB, 7, [520]);

    const unseen = await filterUnseen(DB, [520, 521]);

    expect([...unseen]).toEqual([521]);
  });

  it('handles more ids than one lookup chunk', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => 1000 + index);
    await markSeenBatch(DB, 7, ids.filter((id) => id % 2 === 0));

    const unseen = await filterUnseen(DB, ids);

    expect(unseen.size).toBe(125);
    expect(unseen.has(1001)).toBe(true);
    expect(unseen.has(1000)).toBe(false);
  });
});
