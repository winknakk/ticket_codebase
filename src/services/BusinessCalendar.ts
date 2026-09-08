/**
 * Business-day arithmetic for the SLA matrix ("วันทำการ").
 *
 * Rule: Monday–Friday in Asia/Bangkok, same time-of-day, no public-holiday
 * table yet. This is the TypeScript twin of the SQL function
 * `ticketx_add_business_days` (migration 044); keep the two in step.
 *
 * Urgent/High are 24×7 and never come through here.
 */

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 1 = Monday … 7 = Sunday, evaluated in Bangkok local time. */
function bangkokIsoWeekday(date: Date): number {
  const local = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  const jsDay = local.getUTCDay(); // 0 = Sunday
  return jsDay === 0 ? 7 : jsDay;
}

function isBusinessDay(date: Date): boolean {
  return bangkokIsoWeekday(date) < 6;
}

/** Adds `days` business days, skipping Saturday and Sunday. */
export function addBusinessDays(base: Date, days: number): Date {
  let remaining = Math.max(0, Math.floor(days));
  let cursor = new Date(base.getTime());
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}

/**
 * Whole business days elapsed between `from` and `to` (to ≥ from), counting a
 * day once its same time-of-day has passed. Weekend time never counts, so a
 * reminder "every 1 business day" does not fire over a weekend.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  let count = 0;
  let cursor = new Date(from.getTime());
  while (true) {
    const next = new Date(cursor.getTime() + DAY_MS);
    if (next.getTime() > to.getTime()) break;
    if (isBusinessDay(next)) count += 1;
    cursor = next;
  }
  return count;
}

export const BusinessCalendar = { addBusinessDays, businessDaysBetween, isBusinessDay };
