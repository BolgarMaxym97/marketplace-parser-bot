import { describe, expect, it } from 'vitest';
import {
  isOwner,
  parseBlockedSellers,
  parseGroupHours,
  parseOwnerIds,
  readConfig,
  type Env,
} from '../src/config';

describe('parseOwnerIds', () => {
  it('reads a single id', () => {
    expect(parseOwnerIds('57809974')).toEqual([57809974]);
  });

  it.each([
    ['111,222,333', [111, 222, 333]],
    ['111, 222 , 333', [111, 222, 333]],
    ['111 222\n333', [111, 222, 333]],
    ['111;222', [111, 222]],
  ])('splits %s', (raw, expected) => {
    expect(parseOwnerIds(raw)).toEqual(expected);
  });

  it('keeps negative ids, which is how Telegram numbers groups', () => {
    expect(parseOwnerIds('-1001234567890,777')).toEqual([-1001234567890, 777]);
  });

  it('drops duplicates and junk', () => {
    expect(parseOwnerIds('111,111,abc,,0,222')).toEqual([111, 222]);
  });

  it('returns nothing for an unset secret', () => {
    expect(parseOwnerIds(undefined)).toEqual([]);
    expect(parseOwnerIds('   ')).toEqual([]);
  });
});

describe('isOwner', () => {
  const config = readConfig({ OWNER_CHAT_ID: '111,222' } as Env);

  it('accepts every listed id', () => {
    expect(isOwner(config, 111)).toBe(true);
    expect(isOwner(config, 222)).toBe(true);
  });

  it('rejects anyone else', () => {
    expect(isOwner(config, 333)).toBe(false);
  });

  it('locks everything out when the secret is missing', () => {
    expect(isOwner(readConfig({} as Env), 111)).toBe(false);
  });
});

describe('seller trust settings', () => {
  const read = (env: Partial<Env>) => readConfig(env as Env);

  it('filters on account age by default and leaves OLX Доставка alone', () => {
    expect(read({})).toMatchObject({ minSellerAgeDays: 30, requireSafedeal: false });
  });

  it('accepts 0 as "do not check the age at all"', () => {
    expect(read({ MIN_SELLER_AGE_DAYS: '0' }).minSellerAgeDays).toBe(0);
  });

  it('falls back to the default on junk', () => {
    expect(read({ MIN_SELLER_AGE_DAYS: 'soon' }).minSellerAgeDays).toBe(30);
    expect(read({ MIN_SELLER_AGE_DAYS: '-5' }).minSellerAgeDays).toBe(30);
    expect(read({ MIN_SELLER_AGE_DAYS: '  ' }).minSellerAgeDays).toBe(30);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['nope', false],
  ])('reads REQUIRE_SAFEDEAL=%s as %s', (raw, expected) => {
    expect(read({ REQUIRE_SAFEDEAL: raw }).requireSafedeal).toBe(expected);
  });
});

describe('price setting', () => {
  const read = (env: Partial<Env>) => readConfig(env as Env);

  it('requires a price by default', () => {
    expect(read({}).requirePrice).toBe(true);
    expect(read({ REQUIRE_PRICE: '  ' }).requirePrice).toBe(true);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['off', false],
    ['true', true],
    ['1', true],
  ])('reads REQUIRE_PRICE=%s as %s', (raw, expected) => {
    expect(read({ REQUIRE_PRICE: raw }).requirePrice).toBe(expected);
  });
});

describe('parseBlockedSellers', () => {
  it('reads a single shop slug', () => {
    expect(parseBlockedSellers('retromagaz')).toEqual(new Set(['retromagaz']));
  });

  it.each([
    ['retromagaz,12345', ['retromagaz', '12345']],
    ['retromagaz, 12345 ', ['retromagaz', '12345']],
    ['retromagaz 12345\nfoo', ['retromagaz', '12345', 'foo']],
    ['retromagaz;12345', ['retromagaz', '12345']],
  ])('splits %s', (raw, expected) => {
    expect(parseBlockedSellers(raw)).toEqual(new Set(expected));
  });

  it('lowercases, so a slug matches however it was typed', () => {
    expect(parseBlockedSellers('RetroMagaz')).toEqual(new Set(['retromagaz']));
  });

  it('blocks nobody when unset', () => {
    expect(parseBlockedSellers(undefined).size).toBe(0);
    expect(parseBlockedSellers('  ').size).toBe(0);
    expect(readConfig({} as Env).blockedSellers.size).toBe(0);
  });
});

describe('parseGroupHours', () => {
  const fallback = { from: 9, to: 23 };

  it('reads a window', () => {
    expect(parseGroupHours('9-23', null)).toEqual({ from: 9, to: 23 });
    expect(parseGroupHours('22 - 6', null)).toEqual({ from: 22, to: 6 });
  });

  it('turns the window off only on the explicit word', () => {
    expect(parseGroupHours('off', fallback)).toBeNull();
    expect(parseGroupHours('OFF', fallback)).toBeNull();
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['nonsense', 'evenings'],
    ['an hour out of range', '9-24'],
    ['a window of zero length', '9-9'],
  ])('falls back on %s, so a typo cannot mute a group feed', (_name, raw) => {
    expect(parseGroupHours(raw, fallback)).toEqual(fallback);
  });

  it('defaults to Kyiv daytime', () => {
    expect(readConfig({} as Env).groupHours).toEqual({ from: 9, to: 23 });
    expect(readConfig({ GROUP_HOURS: 'off' } as Env).groupHours).toBeNull();
  });
});
