import { readConfig, SUBREQUEST_RESERVE, type Config, type Env } from './config';
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

  // With nowhere to deliver, ads stay unseen rather than being silently consumed —
  // they go out once the bot is actually added somewhere.
  if (chats.length === 0) return;

  // The watermark rules out anything already overtaken; the age cutoff covers a
  // source that has never delivered, and caps how far back a stale watermark
  // could reach.
  const cutoff = Math.floor((Date.now() - config.maxAdAgeHours * HOUR_MS) / 1000);
  const floor = Math.max(cutoff, source.last_created_at ?? 0);
  const recent = ads.filter((ad) => isRecent(ad, floor));

  const unseen = await filterUnseen(deps.db, recent.map((ad) => ad.id));
  const fresh = recent.filter((ad) => unseen.has(ad.id)).sort(oldestFirst);

  // Oldest first means every ad left in the loop is newer than the one just sent,
  // so a tick cut short by the budget leaves the watermark below them.
  let delivered = 0;

  for (const ad of fresh) {
    // Never start a broadcast we cannot finish: the ad stays unseen and is
    // picked up whole on the next tick.
    if (state.budget - chats.length < state.reserve) break;
    if (state.sends >= config.maxSendsPerTick) break;

    // Claimed before the first send, not after the last: filterUnseen ran once
    // for the whole source, and between that read and this send another source
    // of this tick — or a concurrent invocation — can have taken the same ad.
    // The claim is what makes two searches sharing an ad send it once.
    if (!(await claimAd(deps.db, source.id, ad.id))) continue;

    const result = await broadcastAd(deps, chats, ad);
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
  const config = readConfig(env);
  const telegram = new TelegramClient(env.BOT_TOKEN);
  const deps: BroadcastDeps = { db: env.DB, telegram, timezone: config.timezone };

  const [sources, chats] = await Promise.all([
    pickDueSources(env.DB, config.maxSourcesPerTick),
    activeChats(env.DB),
  ]);

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
