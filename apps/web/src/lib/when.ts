import { dayDifference, todayIn } from './dates';

export interface WhenLabels {
  justNow: string;
  todayAt: (time: string) => string;
  tomorrowAt: (time: string) => string;
  dateAt: (date: string, time: string) => string;
}

/** "há 2 h" / "2 h ago": minutes under an hour, hours under a day, then days. */
export function relativeTime(iso: string, now: Date, locale: string, justNow: string): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 1) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

const timeFormat = (locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone });

/** "hoje às 18:40", "amanhã às 06:12" or "20 out. às 06:12", in the household time zone. */
export function dayTime(iso: string, now: Date, locale: string, timeZone: string, l: WhenLabels) {
  const at = new Date(iso);
  const time = timeFormat(locale, timeZone).format(at);
  const diff = dayDifference(todayIn(timeZone, at), todayIn(timeZone, now));
  if (diff === 0) return l.todayAt(time);
  if (diff === 1) return l.tomorrowAt(time);
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(
    at,
  );
  return l.dateAt(date, time);
}

/** A calendar date in the household time zone ("14 jan. 2027"). */
export function zonedDate(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(iso));
}
