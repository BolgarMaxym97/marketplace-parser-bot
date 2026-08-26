const migrations = import.meta.glob('../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Applies every migration, in filename order, to the D1 used by the workers pool. */
export async function applySchema(db: D1Database): Promise<void> {
  const statements = Object.keys(migrations)
    .sort()
    .flatMap((path) =>
      migrations[path]!.split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
    );

  await db.batch(statements.map((statement) => db.prepare(statement)));
}

export async function resetDb(db: D1Database): Promise<void> {
  for (const table of ['seen_ads', 'sources', 'chats', 'settings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export interface FetchStubOptions {
  /** Payload returned for any OLX api/v1/offers request. */
  offers: unknown;
  /** Per-Telegram-method responses; default is `{ ok: true, result: true }`. */
  telegram?: (call: TelegramCall, index: number) => Response | undefined;
}

export interface FetchStub {
  fetch: typeof fetch;
  telegramCalls: TelegramCall[];
  olxCalls: string[];
}

const ok = (): Response =>
  new Response(JSON.stringify({ ok: true, result: true }), {
    headers: { 'content-type': 'application/json' },
  });

export function makeFetchStub(options: FetchStubOptions): FetchStub {
  const telegramCalls: TelegramCall[] = [];
  const olxCalls: string[] = [];

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop() ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const index = telegramCalls.length;
      telegramCalls.push({ method, body });

      return options.telegram?.({ method, body }, index) ?? ok();
    }

    if (url.includes('/api/v1/offers')) {
      olxCalls.push(url);
      return new Response(JSON.stringify(options.offers), {
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch to ${url}`);
  };

  return { fetch: stub as unknown as typeof fetch, telegramCalls, olxCalls };
}

/** ISO timestamp N hours in the past. Keeps age-sensitive fixtures from rotting. */
export const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

export const daysAgo = (days: number): string => hoursAgo(days * 24);

/** Old enough to clear the default MIN_SELLER_AGE_DAYS without saying so in every fixture. */
const ESTABLISHED_SELLER = '2015-05-18T14:01:19+03:00';

interface AdFixture {
  id: number;
  title?: string;
  created?: string;
  photos?: number;
  /** `null` omits the field, which is how OLX behaves when it has nothing to send. */
  sellerCreated?: string | null;
  sellerId?: number;
  /** Shop slug, as OLX sends it for a shop account. Private sellers get null. */
  shop?: string;
  /** What the seller declared when posting. Omitted, as OLX does, for a private one. */
  business?: boolean;
  safedeal?: string;
  /**
   * A figure, `'arranged'` for a "Договірна" with nothing behind it,
   * `'negotiable'` for a figure OLX marks as haggle-friendly, or `null` for an
   * ad OLX sends without a price param at all.
   */
  price?: number | 'arranged' | 'negotiable' | null;
}

/** The price shapes OLX actually sends, kept in one place. */
function priceParams(price: AdFixture['price']): unknown[] {
  if (price === null) return [];

  if (price === 'arranged') {
    return [{ key: 'price', value: { value: null, currency: 'UAH', label: 'Договірна', arranged: true } }];
  }

  const negotiable = price === 'negotiable';
  const value = negotiable || price === undefined ? 2300 : price;

  return [
    {
      key: 'price',
      value: {
        value,
        currency: 'UAH',
        label: `${value} грн.`,
        arranged: false,
        negotiable,
      },
    },
  ];
}

/** Builds an offers payload shaped like the real /api/v1/offers response. */
export function offersPayload(ads: AdFixture[]): unknown {
  return {
    data: ads.map((ad) => ({
      id: ad.id,
      url: `https://www.olx.ua/d/uk/obyavlenie/ad-${ad.id}.html`,
      title: ad.title ?? `Ad ${ad.id}`,
      description: 'Опис<br />другий рядок',
      created_time: ad.created ?? hoursAgo(1),
      business: ad.business ?? false,
      params: [
        ...priceParams(ad.price),
        { key: 'state', value: { key: 'used', label: 'Вживане' } },
      ],
      location: { city: { name: 'Гнівань' }, region: { name: 'Вінницька область' } },
      user:
        ad.sellerCreated === null
          ? { id: ad.sellerId ?? 1001, name: 'Максим' }
          : {
              id: ad.sellerId ?? 1001,
              name: 'Максим',
              created: ad.sellerCreated ?? ESTABLISHED_SELLER,
            },
      safedeal: { status: ad.safedeal ?? 'active', safedeal_blocked: false },
      shop: { subdomain: ad.shop ?? null },
      photos: Array.from({ length: ad.photos ?? 2 }, (_, index) => ({
        link: `https://ireland.apollo.olxcdn.com:443/v1/files/photo-${ad.id}-${index}/image;s={width}x{height}`,
      })),
    })),
  };
}
