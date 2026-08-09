interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function partsIn(timezone: string, date: Date): DateParts {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    formatted.find((part) => part.type === type)?.value ?? '';

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl can render midnight as "24" in some locales/engines.
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
  };
}

const dayKey = (parts: DateParts): string => `${parts.year}-${parts.month}-${parts.day}`;

/**
 * "сьогодні 15:00" / "вчора 15:00" / "09.08.2026 15:00", in the given timezone.
 * Lower case on purpose: the value sits mid-line after a separator.
 */
export function formatAdDate(iso: string, timezone: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const parts = partsIn(timezone, date);
  const time = `${parts.hour}:${parts.minute}`;

  const today = dayKey(partsIn(timezone, now));
  const yesterday = dayKey(partsIn(timezone, new Date(now.getTime() - 86_400_000)));
  const target = dayKey(parts);

  if (target === today) return `сьогодні ${time}`;
  if (target === yesterday) return `вчора ${time}`;

  return `${parts.day}.${parts.month}.${parts.year} ${time}`;
}
