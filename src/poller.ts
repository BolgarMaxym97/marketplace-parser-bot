import { resolveConfig, SUBREQUEST_RESERVE, type Config, type Env } from './config';
import { activeChats, type ChatRow } from './db/chats';
import { claimAd, filterUnseen, markSeenBatch, releaseAd } from './db/seen';
import {
  advanceWatermark,
  markFailure,
  markInitialized,
  markSuccess,
  pickDueSources,
  type SourceRow,
} from './db/sources';
import { fetchAds } from './olx/client';
import { isChatOpen } from './schedule';
import type { OlxAd } from './olx/types';
import { TelegramClient } from './telegram/api';
import { broadcastAd, type BroadcastDeps } from './telegram/broadcast';

interface TickState {
  budget: number;
  sends: number;
  rateLimited: boolean;
  /** Subrequests held back so a report can always reach every owner. */
  reserve: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Oldest first, so a chat reads chronologically. The API returns newest first. */
const oldestFirst = (a: OlxAd, b: OlxAd): number =>
  Date.parse(a.createdTime) - Date.parse(b.createdTime);

/** Creation time in unix seconds, or 0 when OLX sent something unparsable. */
const createdAt = (ad: OlxAd): number => {
  const parsed = Date.parse(ad.createdTime);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
};

/**
 * OLX orders a search by refresh time and pins promoted ads on top, so an ad
 * created years ago resurfaces at the head of the feed the moment its seller
 * bumps it. Being absent from seen_ads therefore does not mean "new" — only the
 * creation date does. An unparsable date is treated as stale rather than risking
 * a flood of ancient listings.
 *
 * The floor is inclusive so that ads sharing a second with the watermark are not
 * lost; seen_ads is what keeps them from going out twice.
 */
const isRecent = (ad: OlxAd, floor: number): boolean => {
  const created = createdAt(ad);
  return created > 0 && created >= floor;
};

/**
 * An ad with no figure on it — a bare "Договірна", an exchange, a giveaway —
 * cannot be judged from the feed, so it is not worth a broadcast. A price marked
 * negotiable still carries its figure and passes.
 */
const hasPrice = (ad: OlxAd, config: Config): boolean =>
  !config.requirePrice || ad.priceValue !== null;

/** Registration time in milliseconds, or 0 when OLX sent nothing usable. */
const registeredAt = (ad: OlxAd): number => {
  const parsed = ad.sellerCreatedTime ? Date.parse(ad.sellerCreatedTime) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Trust filter built only from what the listing already carries, so it costs no
 * extra subrequest per seller. A days-old account is the signal that separates a
 * throwaway scam profile from an ordinary seller; OLX Доставка means the buyer
 * can pay through OLX instead of transferring money upfront.
 *
 * An unreadable registration date passes rather than fails. The filter exists to
 * trim spam, and a change in OLX's payload shape must not silently mute the feed.
 */
const isTrusted = (ad: OlxAd, config: Config, now: number): boolean => {
  if (config.requireSafedeal && !ad.safedealActive) return false;
  if (config.minSellerAgeDays === 0) return true;

  const registered = registeredAt(ad);
  return registered === 0 || now - registered >= config.minSellerAgeDays * DAY_MS;
};

/**
 * OLX makes a seller declare private or business when posting the ad and sends the
 * answer back as `business`. Nothing else in the payload carries it: most business
 * ads have no shop slug and an empty company name, so the flag is the only way to
 * keep the feed to private sellers.
 */
const isPrivateSeller = (ad: OlxAd, config: Config): boolean =>
  config.allowBusinessAds || !ad.isBusinessSeller;

/**
 * A named seller is muted outright, whatever else the ad looks like: a shop that
 * keeps reposting the same stock, or a profile that turned out to be a waste of
 * time. Matched on shop slug or account id, so both a shop and a private seller
 * can be named.
 */
const isBlocked = (ad: OlxAd, config: Config): boolean => {
  if (config.blockedSellers.size === 0) return false;

  if (ad.shopSubdomain !== null && config.blockedSellers.has(ad.shopSubdomain)) return true;
  return ad.sellerId !== null && config.blockedSellers.has(String(ad.sellerId));
};

/** Reports go to every owner. Returns how many subrequests it spent. */
async function notifyOwners(telegram: TelegramClient, config: Config, text: string): Promise<number> {
  for (const ownerId of config.ownerChatIds) {
    await telegram.sendMessage(ownerId, text).catch((error) => {
      console.error(`owner notification to ${ownerId} failed`, error);
    });
  }
  return config.ownerChatIds.length;
}

/**
 * A freshly added search matches dozens of existing ads. Broadcasting them would
 * be a burst of stale spam, so the first sweep only records them.
 */
async function initializeSource(
  db: D1Database,
  telegram: TelegramClient,
  config: Config,
  source: SourceRow,
  ads: OlxAd[],
  state: TickState,
): Promise<void> {
  await markSeenBatch(db, source.id, ads.map((ad) => ad.id));
  await markInitialized(db, source.id);

  // Everything already on the feed counts as delivered, so the watermark starts
  // at the newest of them and nothing older can slip in later.
  const newest = ads.reduce((max, ad) => Math.max(max, createdAt(ad)), 0);
  if (newest > 0) await advanceWatermark(db, source.id, newest);

  state.budget -= await notifyOwners(
    telegram,
    config,
    `🆕 Пошук #${source.id} «${source.label ?? ''}» ініціалізовано: знайдено ${ads.length} оголошень, ` +
      `усі позначені як переглянуті. Далі надсилатиму лише нові.`,
  );
}

async function processSource(
  deps: BroadcastDeps,
  config: Config,
  chats: ChatRow[],
  source: SourceRow,
  state: TickState,
): Promise<void> {
  const ads = await fetchAds(source.api_url, config.photoSize);
  state.budget--;

  if (!source.initialized) {
    await initializeSource(deps.db, deps.telegram, config, source, ads, state);
    return;
  }

  // A /add-for-me search is one person's own watchlist, so it never reaches a
  // group. Narrowed here rather than per tick: the same tick can carry both kinds.
  const targets = source.private_only ? chats.filter((chat) => chat.type === 'private') : chats;

  // With nowhere to deliver, ads stay unseen rather than being silently consumed —
  // they go out once the bot is actually added somewhere.
  if (targets.length === 0) return;

  // The watermark rules out anything already overtaken; the age cutoff covers a
  // source that has never delivered, and caps how far back a stale watermark
  // could reach.
  const now = Date.now();
  const cutoff = Math.floor((now - config.maxAdAgeHours * HOUR_MS) / 1000);
  const floor = Math.max(cutoff, source.last_created_at ?? 0);

  // A rejected ad is left unseen rather than recorded — it was never delivered,
  // and the watermark is what keeps it from being reconsidered forever.
  const eligible = ads.filter(
    (ad) =>
      isRecent(ad, floor) &&
      hasPrice(ad, config) &&
      isTrusted(ad, config, now) &&
      isPrivateSeller(ad, config) &&
      !isBlocked(ad, config),
  );

  const unseen = await filterUnseen(deps.db, eligible.map((ad) => ad.id));
  const fresh = eligible.filter((ad) => unseen.has(ad.id)).sort(oldestFirst);

  // Oldest first means every ad left in the loop is newer than the one just sent,
  // so a tick cut short by the budget leaves the watermark below them.
  let delivered = 0;

  for (const ad of fresh) {
    // Never start a broadcast we cannot finish: the ad stays unseen and is
    // picked up whole on the next tick.
    if (state.budget - targets.length < state.reserve) break;
    if (state.sends >= config.maxSendsPerTick) break;

    // Claimed before the first send, not after the last: filterUnseen ran once
    // for the whole source, and between that read and this send another source
    // of this tick — or a concurrent invocation — can have taken the same ad.
    // The claim is what makes two searches sharing an ad send it once.
    if (!(await claimAd(deps.db, source.id, ad.id))) continue;

    const result = await broadcastAd(deps, targets, ad);
    state.budget -= result.spent;
    state.sends += result.spent;

    // Nobody took it, so the claim is handed back and the next tick tries again.
    // The claim outlives only a crash mid-broadcast, which costs the ad instead
    // of duplicating it — the price of never sending the same ad twice.
    if (result.delivered === 0) await releaseAd(deps.db, source.id, ad.id);
    else delivered = Math.max(delivered, createdAt(ad));

    if (result.rateLimited) {
      state.rateLimited = true;
      break;
    }
  }

  if (delivered > 0) await advanceWatermark(deps.db, source.id, delivered);
}

export async function pollSources(env: Env): Promise<void> {
  const config = await resolveConfig(env, env.DB);
  const telegram = new TelegramClient(env.BOT_TOKEN);
  const deps: BroadcastDeps = { db: env.DB, telegram, timezone: config.timezone };

  const [sources, subscribed] = await Promise.all([
    pickDueSources(env.DB, config.maxSourcesPerTick),
    activeChats(env.DB),
  ]);

  // Closed chats are dropped for this tick, not disabled. With none left open the
  // sweep still runs and still records nothing, so the ads wait for the window.
  const now = new Date();
  const chats = subscribed.filter((chat) => isChatOpen(chat.type, config, now));

  const state: TickState = {
    budget: config.subrequestBudget,
    sends: 0,
    rateLimited: false,
    // A failure notice costs one subrequest per owner, so the reserve grows with them.
    reserve: Math.max(SUBREQUEST_RESERVE, config.ownerChatIds.length + 1),
  };

  for (const source of sources) {
    if (state.budget <= state.reserve || state.rateLimited) break;

    try {
      await processSource(deps, config, chats, source, state);
      await markSuccess(env.DB, source.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failures = await markFailure(env.DB, source.id, reason, config.maxFailures);

      // Warn exactly once, on the tick the source is auto-disabled.
      if (failures === config.maxFailures) {
        state.budget -= await notifyOwners(
          telegram,
          config,
          `⚠️ Пошук #${source.id} «${source.label ?? ''}» вимкнено після ${failures} помилок поспіль.\n` +
            `Остання: ${reason}\nПеревір і зроби /resume ${source.id} або /rm ${source.id}.`,
        );
      }
    }
  }
}
