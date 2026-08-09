import { readConfig, SUBREQUEST_RESERVE, type Config, type Env } from './config';
import { activeChats, type ChatRow } from './db/chats';
import { filterUnseen, markSeen, markSeenBatch } from './db/seen';
import {
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

/** Oldest first, so a chat reads chronologically. The API returns newest first. */
const oldestFirst = (a: OlxAd, b: OlxAd): number =>
  Date.parse(a.createdTime) - Date.parse(b.createdTime);

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

  const unseen = await filterUnseen(deps.db, source.id, ads.map((ad) => ad.id));
  const fresh = ads.filter((ad) => unseen.has(ad.id)).sort(oldestFirst);

  for (const ad of fresh) {
    // Never start a broadcast we cannot finish: the ad stays unseen and is
    // picked up whole on the next tick.
    if (state.budget - chats.length < state.reserve) return;
    if (state.sends >= config.maxSendsPerTick) return;

    const result = await broadcastAd(deps, chats, ad);
    state.budget -= result.spent;
    state.sends += result.spent;

    if (result.rateLimited) {
      state.rateLimited = true;
      return;
    }

    // Recorded only after the broadcast, and only if at least one chat took it.
    // The reverse order would lose an ad forever on a mid-send crash; this way
    // the worst case is a duplicate.
    if (result.delivered > 0) await markSeen(deps.db, source.id, ad.id);
  }
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
