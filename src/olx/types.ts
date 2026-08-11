/** Narrow view of an OLX offer — only what a Telegram message needs. */
export interface OlxAd {
  id: number;
  title: string;
  url: string;
  /** Raw HTML as returned by OLX (contains <br />). */
  description: string;
  /** ISO 8601 with offset, e.g. 2026-08-09T15:00:00+03:00 */
  createdTime: string;
  priceLabel: string;
  /** The figure OLX put on the ad, null when it names no price at all. */
  priceValue: number | null;
  cityName: string | null;
  /** Shortened, e.g. "Вінницька обл." */
  regionName: string | null;
  /** "Вживане" / "Нове", when the category defines it. */
  condition: string | null;
  sellerName: string | null;
  /** When the seller registered on OLX. ISO 8601, null when OLX omits it. */
  sellerCreatedTime: string | null;
  /** OLX Доставка is on offer, so a buyer can pay through OLX rather than upfront. */
  safedealActive: boolean;
  photoUrls: string[];
}

/** The listing parameters embedded in the search page, mapped 1:1 to API query params. */
export interface ListingParams {
  query?: string;
  category_id?: number;
  currency?: string;
  sort_by?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ResolvedSource {
  apiUrl: string;
  label: string;
}
