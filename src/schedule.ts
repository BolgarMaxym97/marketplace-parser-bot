import type { Config, HourWindow } from './config';

/** Hour of day, 0-23, in the given timezone. */
export function hourIn(timezone: string, now: Date): number {
  const value = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(now);

  // Intl renders midnight as "24" in some engines.
  const hour = Number(value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

/**
 * Half-open on purpose: "9-23" means the last ad of the day lands at 22:59.
 * A window whose end is below its start wraps past midnight, so "22-6" works.
 */
export function isWithinWindow(window: HourWindow, hour: number): boolean {
  if (window.from < window.to) return hour >= window.from && hour < window.to;
  return hour >= window.from || hour < window.to;
}

/**
 * A private chat is the owner's own feed and always open. A group or channel is a
 * shared space, so it keeps daytime hours — nobody wants a phone lighting up at
 * 03:00 over a used console.
 *
 * An ad rejected here is lost for that chat rather than queued: delivery is
 * tracked per ad, not per chat, so another chat taking it settles the matter. When
 * every chat is closed the ad is not claimed at all and the next tick inside the
 * window picks it up, as long as it is still in the feed and inside the age cutoff.
 */
export function isChatOpen(chatType: string, config: Config, now: Date): boolean {
  if (config.groupHours === null || chatType === 'private') return true;

  return isWithinWindow(config.groupHours, hourIn(config.timezone, now));
}

/** "09:00–23:00" / "цілодобово", for /hours and /status. */
export function formatWindow(window: HourWindow | null): string {
  if (window === null) return 'цілодобово';

  const pad = (hour: number): string => String(hour).padStart(2, '0');
  return `${pad(window.from)}:00–${pad(window.to)}:00`;
}
