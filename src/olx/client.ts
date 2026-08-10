import { BROWSER_HEADERS, FETCH_TIMEOUT_MS, MAX_PHOTOS } from '../config';
import type { OlxAd } from './types';

interface RawPriceValue {
  label?: string | null;
  arranged?: boolean;
  budget?: boolean;
  value?: number | null;
  currency?: string | null;
}

interface RawParam {
  key?: string;
  value?: RawPriceValue | { label?: string } | string | null;
}

interface RawPlace {
  name?: string;
}

interface RawPhoto {
  link?: string;
}

interface RawAd {
  id?: number;
  title?: string;
  url?: string;
  description?: string;
  created_time?: string;
  params?: RawParam[];
  photos?: RawPhoto[];
  location?: { city?: RawPlace | null; region?: RawPlace | null } | null;
  user?: { name?: string; created?: string } | null;
  safedeal?: { status?: string } | null;
}

export class OlxHttpError extends Error {
  constructor(readonly status: number) {
    super(`OLX responded with HTTP ${status}`);
    this.name = 'OlxHttpError';
  }
}

function priceLabel(params: RawParam[] | undefined): string {
  const price = params?.find((p) => p.key === 'price')?.value;
  if (!price || typeof price !== 'object') return 'Ціна не вказана';

  const raw = price as RawPriceValue;
  if (raw.arranged) return 'Договірна';
  if (raw.label) return raw.label;
  return 'Ціна не вказана';
}

/** Reads the label of a `select` param, e.g. state -> "Вживане". */
function selectLabel(params: RawParam[] | undefined, key: string): string | null {
  const value = params?.find((param) => param.key === key)?.value;
  if (!value || typeof value !== 'object') return null;

  const label = (value as { label?: string }).label;
  return label && label.length > 0 ? label : null;
}

/** "Вінницька область" is long and always trails a city name — shorten it. */
function shortRegion(region: RawPlace | null | undefined, cityName: string | null): string | null {
  const name = region?.name?.trim();
  if (!name) return null;

  // Kyiv and Sevastopol are their own region; repeating the name adds nothing.
  // Match exactly — "Львівська область" merely starts with "Львів".
  if (name === cityName) return null;

  return name.replace(/\s+область$/i, ' обл.');
}

function photoUrls(photos: RawPhoto[] | undefined, size: string): string[] {
  return (photos ?? [])
    .slice(0, MAX_PHOTOS)
    .map((p) => p.link)
    .filter((link): link is string => typeof link === 'string' && link.length > 0)
    .map((link) => link.replace('{width}x{height}', size).replace('.com:443/', '.com/'));
}

export function mapAds(payload: unknown, size: string): OlxAd[] {
  const data = (payload as { data?: RawAd[] } | null)?.data;
  if (!Array.isArray(data)) return [];

  const ads: OlxAd[] = [];
  for (const raw of data) {
    if (typeof raw?.id !== 'number' || !raw.url || !raw.created_time) continue;

    const cityName = raw.location?.city?.name ?? null;

    ads.push({
      id: raw.id,
      title: raw.title ?? '',
      url: raw.url,
      description: raw.description ?? '',
      createdTime: raw.created_time,
      priceLabel: priceLabel(raw.params),
      cityName,
      regionName: shortRegion(raw.location?.region, cityName),
      condition: selectLabel(raw.params, 'state'),
      sellerName: raw.user?.name?.trim() || null,
      sellerCreatedTime: raw.user?.created ?? null,
      safedealActive: raw.safedeal?.status === 'active',
      photoUrls: photoUrls(raw.photos, size),
    });
  }
  return ads;
}

/** One subrequest. Throws OlxHttpError on non-200 so the caller can bump fail_count. */
export async function fetchAds(apiUrl: string, size: string): Promise<OlxAd[]> {
  const response = await fetch(apiUrl, {
    headers: { ...BROWSER_HEADERS, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new OlxHttpError(response.status);

  return mapAds(await response.json(), size);
}
