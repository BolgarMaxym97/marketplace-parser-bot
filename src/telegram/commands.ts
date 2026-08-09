import type { Config } from '../config';
import { disableChat, listChats, subscribeChat } from '../db/chats';
import { countSeen } from '../db/seen';
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
  '/list — список пошуків',
  '/rm &lt;id&gt; — видалити пошук',
  '/pause &lt;id&gt; — призупинити',
  '/resume &lt;id&gt; — відновити',
  '/test &lt;id&gt; — показати найсвіжіше оголошення без запису в історію',
  '/chats — чати розсилки',
  '/subscribe — отримувати оголошення сюди',
  '/unsubscribe — перестати отримувати оголошення сюди',
  '/status — стан бота',
  '/help — ця довідка',
].join('\n');

const statusIcon = (source: SourceRow): string => (source.enabled ? '🟢' : '🔴');

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

async function handleAdd(ctx: CommandContext, arg: string): Promise<string> {
  const { url, kind } = validateOlxUrl(arg);

  // An api/v1/offers URL is taken as-is — the escape hatch if OLX ever changes
  // the shape of the embedded listing state and resolving breaks.
  const resolved =
    kind === 'api'
      ? { apiUrl: buildApiUrl(Object.fromEntries(new URL(url).searchParams)), label: url }
      : await resolveSearchUrl(url);

  const source = await addSource(ctx.db, url, resolved.apiUrl, resolved.label);
  if (!source) return '⚠️ Такий пошук уже додано.';

  return [
    `✅ Пошук #${source.id} додано: <b>${source.label ?? ''}</b>`,
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
        `${statusIcon(source)} <b>#${source.id}</b> ${source.label ?? ''}`,
        `   обхід: ${formatTime(source.last_run_at, ctx.config.timezone)}`,
      ];
      if (source.fail_count > 0) lines.push(`   ⚠️ помилок поспіль: ${source.fail_count}`);
      if (source.last_error) lines.push(`   ${source.last_error}`);
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
      return handleAdd(ctx, arg);
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
