import { describe, expect, it } from 'vitest';
import { buildApiUrl, extractListingParams, ResolveError } from '../src/olx/resolve';
import { validateOlxUrl } from '../src/lib/url';
import pageSlice from './fixtures/listing-page-slice.html?raw';

describe('extractListingParams', () => {
  it('reads the listing params out of a real page slice', () => {
    expect(extractListingParams(pageSlice)).toEqual({
      offset: 0,
      limit: 40,
      query: 'new nintendo 3ds',
      category_id: 101,
      currency: 'UAH',
      sort_by: 'created_at:desc',
    });
  });

  it('throws when the anchor is missing', () => {
    expect(() => extractListingParams('<html></html>')).toThrow(ResolveError);
  });

  it('ignores braces inside string values', () => {
    const escaped = String.raw`\"params\":{\"offset\":0,\"query\":\"a } b\",\"category_id\":7}`;
    expect(extractListingParams(escaped)).toEqual({ offset: 0, query: 'a } b', category_id: 7 });
  });
});

describe('buildApiUrl', () => {
  it('forces offset 0 and the full page size', () => {
    const url = new URL(buildApiUrl(extractListingParams(pageSlice)));

    expect(url.origin + url.pathname).toBe('https://www.olx.ua/api/v1/offers');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('category_id')).toBe('101');
    expect(url.searchParams.get('query')).toBe('new nintendo 3ds');
    expect(url.searchParams.get('sort_by')).toBe('created_at:desc');
  });

  it('forces newest-first even when the page was sorted otherwise', () => {
    const url = new URL(buildApiUrl({ query: 'x', sort_by: 'filter_float_price:asc' }));
    expect(url.searchParams.get('sort_by')).toBe('created_at:desc');
  });

  it('forces newest-first when the page had no sorting at all', () => {
    const url = new URL(buildApiUrl({ query: 'x' }));
    expect(url.searchParams.get('sort_by')).toBe('created_at:desc');
  });
});

describe('validateOlxUrl', () => {
  it('accepts an olx search page', () => {
    expect(validateOlxUrl('https://www.olx.ua/uk/elektronika/q-nintendo/?currency=UAH').kind).toBe(
      'search-page',
    );
  });

  it('recognises a direct api URL', () => {
    expect(validateOlxUrl('https://www.olx.ua/api/v1/offers?query=x').kind).toBe('api');
  });

  it.each([
    'http://www.olx.ua/uk/',
    'https://evil.example/uk/',
    'https://127.0.0.1/',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (input) => {
    expect(() => validateOlxUrl(input)).toThrow();
  });

  it('rejects an over-long URL', () => {
    expect(() => validateOlxUrl(`https://www.olx.ua/uk/?q=${'x'.repeat(2100)}`)).toThrow();
  });
});
