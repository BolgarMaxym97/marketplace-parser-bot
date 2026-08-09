const ALLOWED_HOSTS = new Set(['olx.ua', 'www.olx.ua', 'm.olx.ua']);
const MAX_URL_LENGTH = 2048;

export type UrlKind = 'search-page' | 'api';

export interface ValidatedUrl {
  url: string;
  kind: UrlKind;
}

/**
 * Only https URLs on olx.ua are accepted. A single-host allowlist removes the SSRF
 * surface entirely — there is no private range left to reach, so no blacklist to
 * keep in sync.
 */
export function validateOlxUrl(input: string): ValidatedUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error('URL не вказано');
  if (trimmed.length > MAX_URL_LENGTH) throw new Error('URL задовгий');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Це не схоже на URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Дозволена лише схема https');
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error('Дозволені лише посилання на olx.ua');

  const kind: UrlKind = parsed.pathname.startsWith('/api/v1/offers') ? 'api' : 'search-page';

  return { url: parsed.toString(), kind };
}
