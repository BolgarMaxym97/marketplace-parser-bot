import { describe, expect, it } from 'vitest';
import { readConfig, type Config, type Env } from '../src/config';
import { formatWindow, hourIn, isChatOpen, isWithinWindow } from '../src/schedule';

const configWith = (hours: string | undefined): Config =>
  readConfig({ GROUP_HOURS: hours, TIMEZONE: 'Europe/Kyiv' } as Env);

/** Kyiv is UTC+3 in August, so a UTC instant maps to a known local hour. */
const at = (utcHour: number): Date => new Date(`2026-08-09T${String(utcHour).padStart(2, '0')}:30:00Z`);

describe('hourIn', () => {
  it('reads the hour in the given timezone, not in UTC', () => {
    expect(hourIn('Europe/Kyiv', at(21))).toBe(0);
    expect(hourIn('UTC', at(21))).toBe(21);
  });

  it('reports midnight as 0 rather than 24', () => {
    expect(hourIn('Europe/Kyiv', new Date('2026-08-08T21:00:00Z'))).toBe(0);
  });
});

describe('isWithinWindow', () => {
  it.each([
    [8, false],
    [9, true],
    [22, true],
    // Half-open: the window closes at 23:00, so nothing goes out at 23:xx.
    [23, false],
    [0, false],
  ])('at %i on a 9-23 window -> %s', (hour, expected) => {
    expect(isWithinWindow({ from: 9, to: 23 }, hour)).toBe(expected);
  });

  it.each([
    [22, true],
    [23, true],
    [0, true],
    [5, true],
    [6, false],
    [12, false],
  ])('at %i on a 22-6 window that wraps past midnight -> %s', (hour, expected) => {
    expect(isWithinWindow({ from: 22, to: 6 }, hour)).toBe(expected);
  });
});

describe('isChatOpen', () => {
  const config = configWith('9-23');

  it('keeps a private chat open around the clock', () => {
    expect(isChatOpen('private', config, at(1))).toBe(true);
    expect(isChatOpen('private', config, at(12))).toBe(true);
  });

  it.each(['group', 'supergroup', 'channel'])('holds a %s back outside the window', (type) => {
    // 01:30 UTC is 04:30 in Kyiv.
    expect(isChatOpen(type, config, at(1))).toBe(false);
    // 12:30 UTC is 15:30 in Kyiv.
    expect(isChatOpen(type, config, at(12))).toBe(true);
  });

  it('opens every chat when the window is off', () => {
    expect(isChatOpen('channel', configWith('off'), at(1))).toBe(true);
  });
});

describe('formatWindow', () => {
  it('pads the hours and names the round-the-clock case', () => {
    expect(formatWindow({ from: 9, to: 23 })).toBe('09:00–23:00');
    expect(formatWindow(null)).toBe('цілодобово');
  });
});
