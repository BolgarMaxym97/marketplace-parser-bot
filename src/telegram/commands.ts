import {
  HOURS_OFF,
  parseGroupHours,
  SETTING_ALLOW_BUSINESS_ADS,
  SETTING_BLOCKED_SELLERS,
  SETTING_GROUP_HOURS,
  type Config,
} from '../config';
import { disableChat, listChats, subscribeChat } from '../db/chats';
import { countSeen } from '../db/seen';
import { writeSetting } from '../db/settings';
import {
  addSource,
  countSources,
  deleteSource,
  getSource,
  listSources,
  setEnabled,
  type SourceRow,
} from '../db/sources';
import { validateOlxUrl } from '../lib/url';
import { fetchAds } from '../olx/client';
import { API_LIMIT, buildApiUrl, resolveSearchUrl } from '../olx/resolve';
import { renderAd } from '../render/message';
import { formatWindow } from '../schedule';
import type { TelegramClient } from './api';

export interface CommandContext {
  db: D1Database;
  telegram: TelegramClient;
  config: Config;
  /** The chat the command came from — /test replies there, not to a fixed owner. */
  chatId: number;
  chatType: string;
  chatTitle: string | null;
  /** Thread the command arrived in. Every reply must go back into it. */
  threadId: number | null;
  /** True only for a real forum topic — a plain threaded reply is not one. */
  isForumTopic: boolean;
}

const HELP = [
  '<b>Команди</b>',
  '',
  '/add &lt;url&gt; — додати пошук OLX (сторінка видачі або api/v1/offers)',
  '/add-for-me &lt;url&gt; — те саме, але оголошення йдуть лише в особисті чати',
  '/list — список пошуків',
  '/rm &lt;id&gt; — видалити пошук',
  '/pause &lt;id&gt; — призупинити',
  '/resume &lt;id&gt; — відновити',
  '/test &lt;id&gt; — показати найсвіжіше оголошення без запису в історію',
  '/business [on|off] — оголошення від бізнесу; без аргументу показує стан',
  '/hours [9-23|off] — коли групи й канали отримують оголошення; приват завжди',
  '/blocked — список заблокованих продавців',
  '/block &lt;slug|id&gt; — заблокувати продавця (можна кілька за раз)',
  '/unblock &lt;slug|id&gt; — розблокувати',
  '/chats — чати розсилки',
  '/subscribe — отримувати оголошення сюди',
  '/unsubscribe — перестати отримувати оголошення сюди',
  '/status — стан бота',
  '/help — ця довідка',
].join('\n');

const statusIcon = (source: SourceRow): string => (source.enabled ? '🟢' : '🔴');

const onOff = (enabled: boolean): string => (enabled ? 'увімкнено' : 'вимкнено');

function formatTime(seconds: number | null, timezone: string): string {
  if (!seconds) return 'ніколи';
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(seconds * 1000));
}

function parseId(arg: string | undefined): number {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Вкажи коректний id, напр. /rm 3');
  return id;
}

/**
 * `privateOnly` is what separates /add from /add-for-me. It is stored on the source
 * rather than checked at send time, so the choice survives every later tick.
 */
async function handleAdd(ctx: CommandContext, arg: string, privateOnly: boolean): Promise<string> {
  const { url, kind } = validateOlxUrl(arg);

  // An api/v1/offers URL is taken as-is — the escape hatch if OLX ever changes
  // the shape of the embedded listing state and resolving breaks.
  const resolved =
    kind === 'api'
      ? { apiUrl: buildApiUrl(Object.fromEntries(new URL(url).searchParams)), label: url }
      : await resolveSearchUrl(url);

  const source = await addSource(ctx.db, url, resolved.apiUrl, resolved.label, privateOnly);
  // api_url is unique, so the flag of an existing search is left alone: switching it
  // would quietly move a group's feed, and /rm then re-adding says it out loud.
  if (!source) return '⚠️ Такий пошук уже додано. Щоб змінити тип, видали його: /list, потім /rm &lt;id&gt;';

  return [
    `✅ Пошук #${source.id} додано: <b>${source.label ?? ''}</b>`,
    privateOnly
      ? '👤 Тільки в особисті чати — у групи й канали не піде.'
      : '📣 В усі підписані чати.',
    `Перший обхід пройде тихо — усі поточні оголошення позначу як переглянуті.`,
    `Далі надсилатиму лише нові. Перевір формат: /test ${source.id}`,
  ].join('\n');
}

async function handleList(ctx: CommandContext): Promise<string> {
  const sources = await listSources(ctx.db);
  if (sources.length === 0) return 'Пошуків немає. Додай: /add &lt;url&gt;';

  return sources
    .map((source) => {
      const lines = [
        `${statusIcon(source)} <b>#${source.id}</b> ${source.label ?? ''}${source.private_only ? ' 👤' : ''}`,
        `   обхід: ${formatTime(source.last_run_at, ctx.config.timezone)}`,
      ];
      if (source.fail_count > 0) lines.push(`   ⚠️ помилок поспіль: ${source.fail_count}`);
      if (source.last_error) lines.push(`   ${source.last_error}`);
      if (source.enabled && source.next_run_at) {
        lines.push(`   ⏳ наступна спроба: ${formatTime(source.next_run_at, ctx.config.timezone)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

async function handleTest(ctx: CommandContext, arg: string | undefined): Promise<string | null> {
  const id = parseId(arg);
  const source = await getSource(ctx.db, id);
  if (!source) return `Пошук #${id} не знайдено.`;

  const ads = await fetchAds(source.api_url, ctx.config.photoSize);
  if (ads.length === 0) return `Пошук #${id}: видача порожня.`;

  const ad = ads[0]!;
  const { caption, photoUrls } = renderAd(ad, ctx.config.timezone);

  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Прев'ю пошуку #${id}, знайдено ${ads.length} з ${API_LIMIT}:`,
    true,
    ctx.threadId,
  );
  if (photoUrls.length === 0) {
    await ctx.telegram.sendMessage(ctx.chatId, caption, false, ctx.threadId);
  } else {
    await ctx.telegram.sendMediaGroup(
      ctx.chatId,
      photoUrls.map((media, index) => ({
        type: 'photo' as const,
        media,
        ...(index === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
      })),
      ctx.threadId,
    );
  }
  return null;
}

/**
 * The one filter worth flipping without a deploy: whether a category is drowning
 * in shop stock changes by the hour, and the answer is not known at deploy time.
 * The written row outranks ALLOW_BUSINESS_ADS from then on.
 */
async function handleBusiness(ctx: CommandContext, arg: string): Promise<string> {
  const value = arg.trim().toLowerCase();

  if (value === '') {
    return [
      `Оголошення від бізнесу: <b>${onOff(ctx.config.allowBusinessAds)}</b>`,
      'Змінити: /business on — надсилати їх теж, /business off — лише приватні особи',
    ].join('\n');
  }
  if (value !== 'on' && value !== 'off') throw new Error('Вкажи /business on або /business off');

  const allow = value === 'on';
  await writeSetting(ctx.db, SETTING_ALLOW_BUSINESS_ADS, allow ? '1' : '0');

  return allow
    ? '🏢 Оголошення від бізнесу увімкнено — надсилатиму і приватні, і бізнесові.'
    : '👤 Оголошення від бізнесу вимкнено — надсилатиму лише від приватних осіб.';
}

/**
 * A group is a shared space and goes quiet overnight; a private chat is one
 * person's own feed and is never held back, so this window never applies to it.
 */
async function handleHours(ctx: CommandContext, arg: string): Promise<string> {
  const value = arg.trim().toLowerCase();

  if (value === '') {
    return [
      `Групи й канали: <b>${formatWindow(ctx.config.groupHours)}</b> (${ctx.config.timezone})`,
      'Приват — завжди цілодобово.',
      `Змінити: /hours 9-23, або /hours ${HOURS_OFF} для цілодобової роботи всюди`,
    ].join('\n');
  }

  // Read against a null fallback, so anything unparsable is rejected here rather
  // than silently landing on the current window.
  const parsed = parseGroupHours(value, null);
  if (parsed === null && value !== HOURS_OFF) {
    throw new Error(`Вкажи вікно як /hours 9-23, або /hours ${HOURS_OFF}`);
  }

  await writeSetting(ctx.db, SETTING_GROUP_HOURS, value);

  return parsed === null
    ? '🕘 Групи й канали працюють цілодобово.'
    : `🕘 Групи й канали отримують оголошення ${formatWindow(parsed)} (${ctx.config.timezone}).`;
}

/** Accepts one seller or several, in any of the separators BLOCKED_SELLERS allows. */
function parseSellerArgs(arg: string, hint: string): string[] {
  const entries = arg
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  if (entries.length === 0) throw new Error(hint);
  return entries;
}

/** Comma-joined, which is exactly what parseBlockedSellers reads back. */
async function writeBlocked(ctx: CommandContext, sellers: Set<string>): Promise<void> {
  await writeSetting(ctx.db, SETTING_BLOCKED_SELLERS, [...sellers].join(','));
}

const listBlocked = (sellers: Set<string>): string =>
  sellers.size === 0
    ? 'Заблокованих продавців немає. Додай: /block &lt;slug|id&gt;'
    : `Заблоковані продавці (${sellers.size}):\n${[...sellers].map((s) => `• <code>${s}</code>`).join('\n')}`;

/**
 * The starting point is the set currently in force, which is BLOCKED_SELLERS until
 * a row exists — writing only the new entry would silently unblock whoever the var
 * names.
 */
async function handleBlock(ctx: CommandContext, arg: string): Promise<string> {
  const entries = parseSellerArgs(arg, 'Вкажи продавця, напр. /block retromagaz або /block 12345');

  const sellers = new Set(ctx.config.blockedSellers);
  const added = entries.filter((entry) => !sellers.has(entry));
  for (const entry of entries) sellers.add(entry);

  await writeBlocked(ctx, sellers);

  const head = added.length === 0 ? '⚠️ Уже були в списку.' : `🚫 Заблоковано: ${added.join(', ')}`;
  return `${head}\n\n${listBlocked(sellers)}`;
}

async function handleUnblock(ctx: CommandContext, arg: string): Promise<string> {
  const entries = parseSellerArgs(arg, 'Вкажи продавця, напр. /unblock retromagaz');

  const sellers = new Set(ctx.config.blockedSellers);
  const removed = entries.filter((entry) => sellers.delete(entry));

  if (removed.length === 0) return `Не знайшов у списку: ${entries.join(', ')}\n\n${listBlocked(sellers)}`;

  await writeBlocked(ctx, sellers);
  return `✅ Розблоковано: ${removed.join(', ')}\n\n${listBlocked(sellers)}`;
}

async function handleChats(ctx: CommandContext): Promise<string> {
  const chats = await listChats(ctx.db);
  if (chats.length === 0) {
    return 'Чатів немає. Додай бота в канал/групу (для каналу — адміном) або напиши /start у приваті.';
  }

  return chats
    .map((chat) => {
      const mark = chat.enabled ? '🟢' : '🔴';
      const topic = chat.thread_id === null ? '' : ` · гілка ${chat.thread_id}`;
      const error = chat.last_error ? ` — ${chat.last_error}` : '';
      return `${mark} <code>${chat.chat_id}</code> ${chat.type} ${chat.title ?? ''}${topic}${error}`;
    })
    .join('\n');
}

async function handleStatus(ctx: CommandContext): Promise<string> {
  const [sources, seen, chats] = await Promise.all([
    countSources(ctx.db),
    countSeen(ctx.db),
    listChats(ctx.db),
  ]);
  const activeChats = chats.filter((chat) => chat.enabled).length;

  return [
    `Пошуків: ${sources.total} (активних ${sources.enabled})`,
    `Чатів розсилки: ${activeChats} з ${chats.length}`,
    `Записів в історії: ${seen}`,
    `Оголошення від бізнесу: ${onOff(ctx.config.allowBusinessAds)}`,
    `Групи й канали: ${formatWindow(ctx.config.groupHours)}`,
    `Заблокованих продавців: ${ctx.config.blockedSellers.size}`,
    `Власників: ${ctx.config.ownerChatIds.length} (${ctx.config.ownerChatIds.join(', ')})`,
  ].join('\n');
}

/** Returns the reply text, or null when the handler already replied itself. */
export async function runCommand(ctx: CommandContext, text: string): Promise<string | null> {
  const [rawCommand = '', ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.split('@')[0]!.toLowerCase();
  const arg = rest.join(' ');

  switch (command) {
    case '/start':
    case '/help':
      return HELP;
    case '/add':
      return handleAdd(ctx, arg, false);
    case '/add-for-me':
      return handleAdd(ctx, arg, true);
    case '/list':
      return handleList(ctx);
    case '/rm':
      return (await deleteSource(ctx.db, parseId(rest[0])))
        ? `🗑 Пошук #${rest[0]} видалено разом з історією.`
        : `Пошук #${rest[0]} не знайдено.`;
    case '/pause':
      return (await setEnabled(ctx.db, parseId(rest[0]), false))
        ? `⏸ Пошук #${rest[0]} призупинено.`
        : `Пошук #${rest[0]} не знайдено.`;
    case '/resume':
      return (await setEnabled(ctx.db, parseId(rest[0]), true))
        ? `▶️ Пошук #${rest[0]} відновлено, лічильник помилок скинуто.`
        : `Пошук #${rest[0]} не знайдено.`;
    case '/test':
      return handleTest(ctx, rest[0]);
    case '/business':
      return handleBusiness(ctx, arg);
    case '/hours':
      return handleHours(ctx, arg);
    case '/blocked':
      return listBlocked(ctx.config.blockedSellers);
    case '/block':
      return handleBlock(ctx, arg);
    case '/unblock':
      return handleUnblock(ctx, arg);
    case '/chats':
      return handleChats(ctx);
    case '/subscribe': {
      const topicId = ctx.isForumTopic ? ctx.threadId : null;
      await subscribeChat(ctx.db, ctx.chatId, ctx.chatType, ctx.chatTitle, topicId);
      return topicId === null
        ? '🔔 Цей чат додано до розсилки.'
        : '🔔 Цю гілку додано до розсилки — оголошення приходитимуть саме сюди.';
    }
    case '/unsubscribe':
      await disableChat(ctx.db, ctx.chatId, 'unsubscribed');
      return '🔕 Цей чат більше не отримуватиме оголошення.';
    case '/status':
      return handleStatus(ctx);
    default:
      return null;
  }
}
