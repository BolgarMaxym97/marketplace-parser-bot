import { describe, expect, it } from 'vitest';
import { isOwner, parseOwnerIds, readConfig, type Env } from '../src/config';

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
