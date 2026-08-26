import { describe, expect, it } from 'vitest';
import { fetchAds } from '../src/olx/client';
import { resolveSearchUrl } from '../src/olx/resolve';
import { renderAd } from '../src/render/message';
import { BROWSER_HEADERS, MAX_CAPTION } from '../src/config';

/**
 * Hits olx.ua for real. Excluded from `npm test`; run with `npm run test:live`.
 * This is the only check that covers the full-size page and the live API contract.
 */
const PAGE_URL =
  'https://www.olx.ua/uk/elektronika/igry-i-igrovye-pristavki/pristavki/q-new-nintendo-3ds/?currency=UAH&search%5Border%5D=created_at%3Adesc';

describe('live OLX', () => {
  it('resolves a search page to an API URL and renders its ads', async () => {
    const { apiUrl, label } = await resolveSearchUrl(PAGE_URL);
    console.log('resolved:', apiUrl);

    expect(apiUrl).toContain('https://www.olx.ua/api/v1/offers?');
    expect(apiUrl).toContain('category_id=101');
    expect(apiUrl).toContain('limit=50');
    expect(label).toBe('new nintendo 3ds');

    const ads = await fetchAds(apiUrl, '1000x700');
    expect(ads.length).toBeGreaterThan(0);

    for (const ad of ads) {
      const { caption, photoUrls } = renderAd(ad, 'Europe/Kyiv');
      expect(caption.length).toBeLessThanOrEqual(MAX_CAPTION);
      expect(photoUrls.every((url) => url.startsWith('https://'))).toBe(true);
    }

    console.log('--- sample caption ---\n' + renderAd(ads[0]!, 'Europe/Kyiv').caption);
  }, 60_000);

  /**
   * The private/business declaration is what keeps shops out of the feed, and the
   * mapper coerces a missing `business` to false — which would silently let every
   * shop through. Only the raw payload can prove the field is still being sent, so
   * this reads it directly instead of going through mapAds.
   */
  it('still receives the private/business flag on every offer', async () => {
    const { apiUrl } = await resolveSearchUrl(PAGE_URL);

    const response = await fetch(apiUrl, {
      headers: { ...BROWSER_HEADERS, accept: 'application/json' },
    });
    const { data } = (await response.json()) as { data: Array<Record<string, unknown>> };

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((offer) => typeof offer.business === 'boolean')).toBe(true);
  }, 60_000);
});
