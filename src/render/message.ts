import { MAX_CAPTION } from '../config';
import type { OlxAd } from '../olx/types';
import { formatAdDate } from './date';
import { escapeHtml, htmlToPlainText, truncate } from './text';

export interface RenderedAd {
  caption: string;
  photoUrls: string[];
}

const LINK_LABEL = '➡️ Відкрити на OLX';
const DIVIDER = '➖➖➖➖➖➖➖➖';
const DOT = ' · ';

const joinParts = (...parts: Array<string | null>): string =>
  parts.filter((part): part is string => Boolean(part)).join(DOT);

function headerLines(ad: OlxAd, timezone: string, now?: Date): string[] {
  const lines = [
    `🕹 <b>${escapeHtml(ad.title)}</b>`,
    '',
    `💸 <b>${escapeHtml(ad.priceLabel)}</b>${ad.condition ? DOT + escapeHtml(ad.condition) : ''}`,
  ];

  const place = joinParts(ad.cityName, ad.regionName);
  const when = formatAdDate(ad.createdTime, timezone, now);
  const placeLine = joinParts(place || null, when || null);
  if (placeLine) lines.push(`🧭 ${escapeHtml(placeLine)}`);

  if (ad.sellerName) lines.push(`👤 ${escapeHtml(ad.sellerName)}`);

  return lines;
}

/**
 * Builds the media-group caption. The description is the only part that gets
 * trimmed — cutting the assembled caption instead could sever the <a> tag or a
 * blockquote and make Telegram reject the message with "can't parse entities".
 *
 * `blockquote expandable` collapses a long description to a few lines with a
 * tap-to-expand control. It does not lift the 1024-character caption limit.
 */
export function renderAd(ad: OlxAd, timezone: string, now?: Date): RenderedAd {
  const header = headerLines(ad, timezone, now).join('\n');
  const footer = `<a href="${escapeHtml(ad.url)}">${LINK_LABEL}</a>`;

  const description = escapeHtml(htmlToPlainText(ad.description));
  const wrapper = `\n${DIVIDER}\n<blockquote expandable></blockquote>\n`;
  const budget = MAX_CAPTION - header.length - footer.length - wrapper.length - 1;

  const body = truncate(description, budget);
  const quoted = body ? `\n${DIVIDER}\n<blockquote expandable>${body}</blockquote>\n` : '\n';

  return { caption: `${header}${quoted}\n${footer}`, photoUrls: ad.photoUrls };
}
