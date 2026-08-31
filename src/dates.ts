/**
 * Date helpers. Every age comparison in the decision engine goes through here
 * and is truncated to a UTC calendar day, so the same GitHub state on the same
 * UTC date always yields the same answer.
 */

export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** UTC calendar date as YYYY-MM-DD. */
export function ymd(d: Date): string {
  return utcMidnight(d).toISOString().slice(0, 10);
}

/** Whole UTC days from `a` to `b` (b - a). Negative if `b` is before `a`. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((utcMidnight(b).getTime() - utcMidnight(a).getTime()) / 86_400_000);
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True if `iso` is no more than `days` UTC days before `today`.
 * A missing/invalid date is NOT within (returns false).
 * A future date counts as within (age <= days trivially).
 */
export function withinDays(iso: string | null | undefined, days: number, today: Date): boolean {
  const d = parse(iso);
  if (!d) return false;
  return daysBetween(d, today) <= days;
}

/** Age of `iso` in whole UTC days relative to `today`; null if unparseable. */
export function ageInDays(iso: string | null | undefined, today: Date): number | null {
  const d = parse(iso);
  return d ? daysBetween(d, today) : null;
}

/** Latest (max) of the given ISO timestamps, or null if none are valid. */
export function maxIso(...isos: Array<string | null | undefined>): string | null {
  let best: Date | null = null;
  let bestIso: string | null = null;
  for (const iso of isos) {
    const d = parse(iso);
    if (d && (!best || d.getTime() > best.getTime())) {
      best = d;
      bestIso = new Date(iso as string).toISOString();
    }
  }
  return bestIso;
}
