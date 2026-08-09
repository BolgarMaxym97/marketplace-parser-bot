import { BROWSER_HEADERS, FETCH_TIMEOUT_MS } from '../config';
import type { ListingParams, ResolvedSource } from './types';

export const OLX_API_BASE = 'https://www.olx.ua/api/v1/offers';

/** How many ads to pull per poll. OLX accepts up to 50. */
export const API_LIMIT = 50;

/**
 * The listing page embeds its state as a JSON string inside a JS string literal,
 * so every quote is escaped once. `offset` appears only in the listing params —
 * an ad's own `params` array never has it — which makes this anchor unambiguous.
 */
const ANCHOR = '\\"params\\":{\\"offset\\":';

/** Guards against a runaway scan if the object is never closed. */
const MAX_OBJECT_CHARS = 8192;

/** Keeps enough tail around so an anchor split across two chunks still matches. */
const WINDOW_OVERLAP = 4096;

export class ResolveError extends Error {}

/**
 * Finds the end of the object that starts at `start` ('{'), ignoring braces that
 * sit inside string values. Returns the index just past the closing brace.
 */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      if (text[i + 1] === '"') inString = !inString;
      i++; // the escape consumes the next character either way
      continue;
    }
    if (inString) continue;

    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Unwraps the double escaping: JS string literal first, then the JSON it carried. */
export function parseListingParams(escaped: string): ListingParams {
  const json = JSON.parse(`"${escaped}"`) as string;
  return JSON.parse(json) as ListingParams;
}

/** Extracts the listing params from an already-buffered page. Used by tests. */
export function extractListingParams(html: string): ListingParams {
  const anchor = html.indexOf(ANCHOR);
  if (anchor === -1) throw new ResolveError('listing params not found in page');

  const objectStart = html.indexOf('{', anchor + '\\"params\\":'.length);
  const end = findObjectEnd(html, objectStart);
  if (end === -1) throw new ResolveError('listing params object is not closed');

  return parseListingParams(html.slice(objectStart, end));
}

export function buildApiUrl(params: ListingParams): string {
  const url = new URL(OLX_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', String(API_LIMIT));
  // Always newest-first, whatever the page was sorted by. Under OLX's default
  // relevance sort a brand-new ad can land outside the first 50 results and be
  // missed entirely — the one thing this bot must never do.
  url.searchParams.set('sort_by', 'created_at:desc');
  return url.toString();
}

/**
 * Streams the search page and stops reading the moment the listing params are found.
 * The full page is ~3.4 MB; the anchor sits around 640 KB, so cancelling early is
 * what keeps this inside the Workers CPU limit.
 */
async function readListingParams(body: ReadableStream<Uint8Array>): Promise<ListingParams> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let anchorAt = -1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (anchorAt === -1) {
        anchorAt = buffer.indexOf(ANCHOR);
        if (anchorAt === -1) {
          // Drop everything that can no longer contribute to a match.
          if (buffer.length > WINDOW_OVERLAP) buffer = buffer.slice(-WINDOW_OVERLAP);
          continue;
        }
        buffer = buffer.slice(anchorAt);
        anchorAt = 0;
      }

      const objectStart = buffer.indexOf('{');
      const end = findObjectEnd(buffer, objectStart);
      if (end !== -1) return parseListingParams(buffer.slice(objectStart, end));

      if (buffer.length > MAX_OBJECT_CHARS) {
        throw new ResolveError('listing params object is not closed');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new ResolveError('listing params not found in page');
}

/** One subrequest. Runs only on /add, never during polling. */
export async function resolveSearchUrl(pageUrl: string): Promise<ResolvedSource> {
  const response = await fetch(pageUrl, {
    headers: { ...BROWSER_HEADERS, accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new ResolveError(`OLX responded with HTTP ${response.status}`);
  if (!response.body) throw new ResolveError('OLX returned an empty body');

  const params = await readListingParams(response.body);

  return {
    apiUrl: buildApiUrl(params),
    label: String(params.query ?? '').trim() || pageUrl,
  };
}
