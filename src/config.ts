export interface Env {
  DB: D1Database;

  // Secrets
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** One chat id, or several separated by commas: "123,456". */
  OWNER_CHAT_ID: string;

  // Vars
  MAX_SOURCES_PER_TICK?: string;
  MAX_SENDS_PER_TICK?: string;
  SUBREQUEST_BUDGET?: string;
  PHOTO_SIZE?: string;
  TIMEZONE?: string;
  RETENTION_PER_SOURCE?: string;
  MAX_FAILURES?: string;
  MAX_AD_AGE_HOURS?: string;
  MIN_SELLER_AGE_DAYS?: string;
  REQUIRE_SAFEDEAL?: string;
  REQUIRE_PRICE?: string;
  /** Shop slugs and/or seller ids to skip: "retromagaz,12345". */
  BLOCKED_SELLERS?: string;
}

export interface Config {
  maxSourcesPerTick: number;
  maxSendsPerTick: number;
  subrequestBudget: number;
  photoSize: string;
  timezone: string;
  retentionPerSource: number;
  maxFailures: number;
  /** How old an ad may be, by creation date, and still count as new. */
  maxAdAgeHours: number;
  /** Sellers who registered more recently than this are skipped. 0 turns the check off. */
  minSellerAgeDays: number;
  /** Skip ads that do not offer OLX Доставка. */
  requireSafedeal: boolean;
  /** Skip ads that name no price — a bare "Договірна", an exchange, a giveaway. */
  requirePrice: boolean;
  /** Shop slugs and seller ids whose ads never go out. Lowercased, as strings. */
  blockedSellers: Set<string>;
  /** Everyone allowed to run commands. Reports go to all of them. */
  ownerChatIds: number[];
}

/** Subrequests kept aside for owner reports and failure notices. */
export const SUBREQUEST_RESERVE = 5;

/** Telegram caps a media group at 10 items. */
export const MAX_PHOTOS = 10;

/** Telegram caps a media-group caption at 1024 characters. */
export const MAX_CAPTION = 1024;

/** Delay between Telegram sends. Wall-clock, so it does not count against the CPU limit. */
export const SEND_DELAY_MS = 1100;

export const FETCH_TIMEOUT_MS = 10_000;

/** Sent to OLX so the request does not look like a naked script. */
export const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'accept-language': 'uk,en;q=0.9',
};

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like num(), except 0 is meaningful here — it is how a threshold is switched off. */
function threshold(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Accepts one id or several, separated by commas, spaces or newlines. */
export function parseOwnerIds(raw: string | undefined): number[] {
  const ids = (raw ?? '')
    .split(/[\s,;]+/)
    .filter((part) => part.length > 0)
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id !== 0);

  return [...new Set(ids)];
}

/**
 * A blocked seller is named either by shop slug — the `retromagaz` of
 * retromagaz.olx.ua — or by numeric OLX account id, since a private seller has
 * no slug. Both live in one set: the two never collide, and matching is a plain
 * string lookup on either field of an ad.
 */
export function parseBlockedSellers(raw: string | undefined): Set<string> {
  const entries = (raw ?? '')
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  return new Set(entries);
}

export const isOwner = (config: Config, chatId: number): boolean =>
  config.ownerChatIds.includes(chatId);

export function readConfig(env: Env): Config {
  return {
    maxSourcesPerTick: num(env.MAX_SOURCES_PER_TICK, 10),
    maxSendsPerTick: num(env.MAX_SENDS_PER_TICK, 30),
    subrequestBudget: num(env.SUBREQUEST_BUDGET, 50),
    photoSize: env.PHOTO_SIZE || '1000x700',
    timezone: env.TIMEZONE || 'Europe/Kyiv',
    retentionPerSource: num(env.RETENTION_PER_SOURCE, 500),
    maxFailures: num(env.MAX_FAILURES, 5),
    maxAdAgeHours: num(env.MAX_AD_AGE_HOURS, 24),
    minSellerAgeDays: threshold(env.MIN_SELLER_AGE_DAYS, 30),
    // Off by default: OLX Доставка only exists for shippable goods, so requiring
    // it would empty a property, jobs or services search outright.
    requireSafedeal: flag(env.REQUIRE_SAFEDEAL, false),
    // On by default: an ad with no figure on it cannot be judged from the feed,
    // and a negotiable price still carries one, so this costs no real listings.
    requirePrice: flag(env.REQUIRE_PRICE, true),
    blockedSellers: parseBlockedSellers(env.BLOCKED_SELLERS),
    ownerChatIds: parseOwnerIds(env.OWNER_CHAT_ID),
  };
}
