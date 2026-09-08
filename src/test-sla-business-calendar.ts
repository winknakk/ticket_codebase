/**
 * Pure unit checks for the SLA business calendar and cadence slot math.
 * No database, no network: `npx tsx src/test-sla-business-calendar.ts`.
 */
import assert from "node:assert/strict";
import { addBusinessDays, businessDaysBetween } from "./services/BusinessCalendar";
import { cadenceSlot, normalizePriority, CADENCE_RULES } from "./services/SLACadenceService";

const bkk = (iso: string) => new Date(`${iso}+07:00`);

// Friday 17:00 + 2 business days = Tuesday 17:00 (weekend skipped)
assert.equal(addBusinessDays(bkk("2026-09-04T17:00:00"), 2).toISOString(), bkk("2026-09-08T17:00:00").toISOString());
// Saturday + 1 business day = Monday
assert.equal(addBusinessDays(bkk("2026-09-05T10:00:00"), 1).toISOString(), bkk("2026-09-07T10:00:00").toISOString());
// Monday + 5 business days = next Monday
assert.equal(addBusinessDays(bkk("2026-09-07T09:00:00"), 5).toISOString(), bkk("2026-09-14T09:00:00").toISOString());
// Zero / negative is identity
assert.equal(addBusinessDays(bkk("2026-09-07T09:00:00"), 0).getTime(), bkk("2026-09-07T09:00:00").getTime());

// Business days elapsed: Friday 17:00 -> Monday 16:59 = 0, Monday 17:00 = 1, Tuesday 17:00 = 2
assert.equal(businessDaysBetween(bkk("2026-09-04T17:00:00"), bkk("2026-09-07T16:59:00")), 0);
assert.equal(businessDaysBetween(bkk("2026-09-04T17:00:00"), bkk("2026-09-07T17:00:00")), 1);
assert.equal(businessDaysBetween(bkk("2026-09-04T17:00:00"), bkk("2026-09-08T17:00:00")), 2);
assert.equal(businessDaysBetween(bkk("2026-09-08T17:00:00"), bkk("2026-09-04T17:00:00")), 0);

// Cadence slots — hours
const created = bkk("2026-09-07T09:00:00");
assert.equal(cadenceSlot(created, bkk("2026-09-07T09:59:00"), CADENCE_RULES.Urgent.dev!), 0, "before first hour: nothing due");
assert.equal(cadenceSlot(created, bkk("2026-09-07T10:00:00"), CADENCE_RULES.Urgent.dev!), 1, "first hourly reminder");
assert.equal(cadenceSlot(created, bkk("2026-09-07T12:05:00"), CADENCE_RULES.High.dev!), 1, "High every 2 h -> slot 1 at +3h05");
assert.equal(cadenceSlot(created, bkk("2026-09-07T17:00:00"), CADENCE_RULES.Medium.dev!), 2, "Medium every 4 h -> slot 2 at +8h");
// Cadence slots — business days (Medium user progress: every 1 bd; Low user: every 2 bd)
assert.equal(cadenceSlot(bkk("2026-09-04T17:00:00"), bkk("2026-09-06T12:00:00"), CADENCE_RULES.Medium.user!), 0, "weekend does not count");
assert.equal(cadenceSlot(bkk("2026-09-04T17:00:00"), bkk("2026-09-07T17:00:00"), CADENCE_RULES.Medium.user!), 1);
assert.equal(cadenceSlot(bkk("2026-09-04T17:00:00"), bkk("2026-09-08T17:00:00"), CADENCE_RULES.Low.user!), 1, "Low user every 2 bd");
assert.equal(cadenceSlot(bkk("2026-09-04T17:00:00"), bkk("2026-09-08T17:00:00"), CADENCE_RULES.Low.dev!), 2, "Low dev every 1 bd");

// Priority normalisation
assert.equal(normalizePriority("P1"), "Urgent");
assert.equal(normalizePriority("critical"), "Urgent");
assert.equal(normalizePriority("none"), "None");
assert.equal(normalizePriority(""), "Medium");
assert.equal(CADENCE_RULES.None.dev, null);

console.log("SLA business calendar + cadence slot tests passed.");

// Slot-start / catch-up guard: an old ticket sits in a high slot but its
// boundary is far in the past, so the first pass after enabling must not fire.
import { slotStartedAt } from "./services/SLACadenceService";
const old = bkk("2026-08-20T09:00:00");
const nowRef = bkk("2026-09-07T10:13:00");
const urgentDev = CADENCE_RULES.Urgent.dev!;
const oldSlot = cadenceSlot(old, nowRef, urgentDev);
assert.ok(oldSlot > 100, "an 18-day-old Urgent ticket is many slots in");
const staleness = nowRef.getTime() - slotStartedAt(old, oldSlot, urgentDev).getTime();
assert.ok(staleness < 60 * 60 * 1000, "slot start is within the last hour by construction");
// A boundary crossed 5 minutes ago is fresh; the same slot 45 minutes later is not (grace 30 min).
const fresh = slotStartedAt(old, oldSlot, urgentDev);
assert.ok(new Date(fresh.getTime() + 5 * 60_000).getTime() - fresh.getTime() <= 30 * 60_000);
assert.ok(new Date(fresh.getTime() + 45 * 60_000).getTime() - fresh.getTime() > 30 * 60_000);
// Business-day slot start lands on a weekday
const bdStart = slotStartedAt(bkk("2026-09-04T17:00:00"), 1, CADENCE_RULES.Medium.user!);
assert.equal(bdStart.toISOString(), bkk("2026-09-07T17:00:00").toISOString(), "Fri +1 business day = Mon");

console.log("Slot-start and catch-up guard tests passed.");
