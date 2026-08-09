import { describe, expect, it } from 'vitest';
import { MAX_CAPTION } from '../src/config';
import { mapAds } from '../src/olx/client';
import { formatAdDate } from '../src/render/date';
import { renderAd } from '../src/render/message';
import { escapeHtml, htmlToPlainText, truncate } from '../src/render/text';
import offers from './fixtures/offers.json';

const TZ = 'Europe/Kyiv';

describe('mapAds on the real /api/v1/offers response', () => {
  const ads = mapAds(offers, '1000x700');

  it('maps every offer in the fixture', () => {
    expect(ads).toHaveLength(9);
  });

  it('pulls the price label out of params', () => {
    expect(ads[0]!.priceLabel).toBe('12 163 грн.');
  });

  it('resolves photo URLs to a concrete size', () => {
    expect(ads[0]!.photoUrls[0]).toBe(
      'https://ireland.apollo.olxcdn.com/v1/files/m94r92fje6mh1-UA/image;s=1000x700',
    );
    expect(ads[0]!.photoUrls.every((url) => !url.includes('{width}'))).toBe(true);
  });

  it('caps photos at the Telegram media-group limit', () => {
    expect(Math.max(...ads.map((ad) => ad.photoUrls.length))).toBeLessThanOrEqual(10);
  });

  it('takes the city name', () => {
    expect(ads[0]!.cityName).toBe('Львів');
  });

  it('shortens the region', () => {
    expect(ads[0]!.regionName).toBe('Львівська обл.');
  });

  it('reads the condition out of the state param', () => {
    expect(ads[0]!.condition).toBe('Вживане');
  });

  it('takes the seller name', () => {
    // Seller identities in the fixture are pseudonymised; everything else is verbatim.
    expect(ads[0]!.sellerName).toBe('Продавець 1');
  });

  it('drops a region that only repeats the city', () => {
    const [ad] = mapAds(
      {
        data: [
          {
            id: 1,
            url: 'https://www.olx.ua/d/uk/obyavlenie/x.html',
            created_time: '2026-08-09T15:00:00+03:00',
            location: { city: { name: 'Київ' }, region: { name: 'Київ' } },
          },
        ],
      },
      '1000x700',
    );
    expect(ad!.regionName).toBeNull();
    expect(ad!.condition).toBeNull();
    expect(ad!.sellerName).toBeNull();
  });
});

describe('text helpers', () => {
  it('turns <br /> into newlines and decodes entities', () => {
    expect(htmlToPlainText('a<br />b<br/>&amp; c&nbsp;d')).toBe('a\nb\n& c d');
  });

  it('collapses runs of blank lines', () => {
    expect(htmlToPlainText('a<br /><br /><br /><br />b')).toBe('a\n\nb');
  });

  it('escapes only after decoding, so entities are not double-escaped', () => {
    expect(escapeHtml(htmlToPlainText('Ціна &lt; 100 &amp; більше'))).toBe('Ціна &lt; 100 &amp; більше');
  });

  it('truncates on a word boundary', () => {
    expect(truncate('один два три чотири', 12)).toBe('один два…');
  });

  it('returns the input untouched when it fits', () => {
    expect(truncate('короткий', 50)).toBe('короткий');
  });
});

describe('formatAdDate', () => {
  const now = new Date('2026-08-09T12:00:00+03:00');

  it('says сьогодні for the same Kyiv day', () => {
    expect(formatAdDate('2026-08-09T15:00:00+03:00', TZ, now)).toBe('сьогодні 15:00');
  });

  it('says вчора for the previous Kyiv day', () => {
    expect(formatAdDate('2026-08-08T09:05:00+03:00', TZ, now)).toBe('вчора 09:05');
  });

  it('falls back to a full date', () => {
    expect(formatAdDate('2026-07-30T21:30:00+03:00', TZ, now)).toBe('30.07.2026 21:30');
  });

  it('bases the day on Kyiv, not on UTC', () => {
    // 22:30 UTC on the 8th is already 01:30 on the 9th in Kyiv — "сьогодні", not "вчора".
    expect(formatAdDate('2026-08-08T22:30:00+00:00', TZ, now)).toBe('сьогодні 01:30');
  });
});

describe('renderAd', () => {
  const now = new Date('2026-08-09T18:00:00+03:00');

  const sample = {
    id: 1,
    title: 'Nintendo 2DS.',
    url: 'https://www.olx.ua/d/uk/obyavlenie/x.html',
    description: 'Продам приставку в комплекті одна гра.<br />Немає кабеля зарядки',
    createdTime: '2026-08-09T15:00:00+03:00',
    priceLabel: '2 300 грн.',
    cityName: 'Гнівань',
    regionName: 'Вінницька обл.',
    condition: 'Вживане',
    sellerName: 'Максим',
    photoUrls: ['https://example.test/a.jpg'],
  };

  it('matches the agreed layout', () => {
    expect(renderAd(sample, TZ, now).caption).toBe(
      [
        '🕹 <b>Nintendo 2DS.</b>',
        '',
        '💸 <b>2 300 грн.</b> · Вживане',
        '🧭 Гнівань · Вінницька обл. · сьогодні 15:00',
        '👤 Максим',
        '➖➖➖➖➖➖➖➖',
        '<blockquote expandable>Продам приставку в комплекті одна гра.',
        'Немає кабеля зарядки</blockquote>',
        '',
        '<a href="https://www.olx.ua/d/uk/obyavlenie/x.html">➡️ Відкрити на OLX</a>',
      ].join('\n'),
    );
  });

  it('drops optional lines when the data is missing', () => {
    const caption = renderAd(
      { ...sample, condition: null, sellerName: null, regionName: null, description: '' },
      TZ,
      now,
    ).caption;

    expect(caption).toBe(
      [
        '🕹 <b>Nintendo 2DS.</b>',
        '',
        '💸 <b>2 300 грн.</b>',
        '🧭 Гнівань · сьогодні 15:00',
        '',
        '<a href="https://www.olx.ua/d/uk/obyavlenie/x.html">➡️ Відкрити на OLX</a>',
      ].join('\n'),
    );
    expect(caption).not.toContain('blockquote');
  });

  it('keeps every fixture caption inside the Telegram limit', () => {
    for (const ad of mapAds(offers, '1000x700')) {
      expect(renderAd(ad, TZ, now).caption.length).toBeLessThanOrEqual(MAX_CAPTION);
    }
  });

  it('never severs the link or the blockquote when the description is long', () => {
    const { caption } = renderAd({ ...sample, description: 'слово '.repeat(500) }, TZ, now);

    expect(caption.length).toBeLessThanOrEqual(MAX_CAPTION);
    expect(caption.endsWith('➡️ Відкрити на OLX</a>')).toBe(true);
    expect(caption).toContain('</blockquote>');
    expect(caption).toContain('…');
  });

  it('escapes HTML in the title', () => {
    const { caption } = renderAd({ ...sample, title: 'A <b>B</b> & C' }, TZ, now);
    expect(caption).toContain('🕹 <b>A &lt;b&gt;B&lt;/b&gt; &amp; C</b>');
  });
});
