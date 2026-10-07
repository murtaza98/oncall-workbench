import type { Shift } from '../shared/model';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function shiftFor(now: Date, offset = 0): Shift {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const beforeMondayHandoff = daysSinceMonday === 0 && local.getUTCHours() < 11;
  const daysBack = daysSinceMonday + (beforeMondayHandoff ? 7 : 0);
  const localStart = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysBack,
    11,
  );
  const start = new Date(localStart - IST_OFFSET_MS + offset * WEEK_MS);
  const end = new Date(start.getTime() + WEEK_MS);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
  });

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: `${format.format(start)} – ${format.format(end)}, 11 am IST`,
    offset,
  };
}
