const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Escapes for Telegram's HTML parse mode. Must run after entity decoding, never before. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** OLX descriptions are HTML fragments: <br /> for newlines, entities for punctuation. */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncates on a word boundary so a cut never lands mid-entity or mid-word. */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;

  const hard = text.slice(0, limit - 1);
  const lastBreak = Math.max(hard.lastIndexOf(' '), hard.lastIndexOf('\n'));
  const cut = lastBreak > limit * 0.5 ? hard.slice(0, lastBreak) : hard;

  return `${cut.trimEnd()}…`;
}
