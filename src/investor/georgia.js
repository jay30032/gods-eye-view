/**
 * Georgia foreclosure and tax-sale calendar.
 *
 * Georgia is a non-judicial foreclosure state. There is no recorded Notice of
 * Default and no court case: the lender advertises a **Notice of Sale Under
 * Power** in the county's legal organ for four consecutive weeks, and the sale
 * happens on the **first Tuesday of the month** on the courthouse steps. If
 * that Tuesday is a legal holiday — which in practice only ever means January 1
 * or July 4 — the sale slides to the next day. County tax sales (fi. fa.
 * executions) run on the same first-Tuesday calendar.
 *
 * So a notice published today does not name an arbitrary date: it names the
 * first sale Tuesday that leaves room for four weekly publications.
 */

const DAY_MS = 86_400_000;
const TUESDAY = 2;

/** Four consecutive weekly publications must run before the sale. */
export const NOTICE_WEEKS = 4;
export const NOTICE_DAYS = NOTICE_WEEKS * 7;

export const COUNTIES = Object.freeze({
  dekalb: Object.freeze({
    name: 'DeKalb',
    legalOrgan: 'The Champion',
    courthouse: 'DeKalb County Courthouse, Decatur',
  }),
  fulton: Object.freeze({
    name: 'Fulton',
    legalOrgan: 'Fulton County Daily Report',
    courthouse: 'Fulton County Courthouse, Atlanta',
  }),
});

export const COUNTY_IDS = Object.freeze(Object.keys(COUNTIES));

/** Signal types that put a house on the courthouse-steps calendar. */
export const AUCTION_SIGNAL_TYPES = Object.freeze(['FORECLOSURE', 'TAX_SALE']);

export function isAuctionSignal(type) {
  return AUCTION_SIGNAL_TYPES.includes(String(type || ''));
}

/** Georgia tax deeds are redeemable for a year at a 20% premium. */
export const TAX_DEED = Object.freeze({ redemptionMonths: 12, premiumRate: 0.20 });

export function resolveCounty(id) {
  return COUNTIES[String(id || '').trim().toLowerCase()] || null;
}

/**
 * Any of a Date, a `YYYY-MM-DD` string, or epoch ms, snapped to UTC midnight.
 * Everything here is date arithmetic, so a timezone would only ever be a bug.
 */
export function toUtcDay(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const ms = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const date = value instanceof Date ? value : new Date(Number(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The sale date for a given month: the first Tuesday, pushed to Wednesday when
 * it lands on New Year's Day or Independence Day.
 *
 * @param {number} year
 * @param {number} monthIndex 0-11
 * @returns {Date} UTC midnight
 */
export function firstTuesday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (TUESDAY - first.getUTCDay() + 7) % 7;
  const sale = new Date(Date.UTC(year, monthIndex, 1 + offset));
  const day = sale.getUTCDate();
  const holiday = (monthIndex === 0 && day === 1) || (monthIndex === 6 && day === 4);
  return holiday ? new Date(sale.getTime() + DAY_MS) : sale;
}

/** The earliest sale date on or after `afterDate`. */
export function nextSaleDate(afterDate) {
  const from = toUtcDay(afterDate);
  if (!from) return null;
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  for (let i = 0; i < 24; i += 1) {
    const sale = firstTuesday(year, month);
    if (sale.getTime() >= from.getTime()) return sale;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return null;
}

/**
 * The sale a notice published on `effectiveDate` is actually advertising: the
 * first sale Tuesday that leaves room for the four weekly publications.
 */
export function auctionDateForNotice(effectiveDate) {
  const filed = toUtcDay(effectiveDate);
  if (!filed) return null;
  return nextSaleDate(new Date(filed.getTime() + NOTICE_DAYS * DAY_MS));
}

/** Whole days from `now` to `date`; negative once the date has passed. */
export function daysUntil(date, now) {
  const target = toUtcDay(date);
  const from = toUtcDay(now);
  if (!target || !from) return null;
  return Math.round((target.getTime() - from.getTime()) / DAY_MS);
}

const SALE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** `Oct 6` — the way a sale date gets said out loud. */
export function formatSaleDate(date) {
  const day = toUtcDay(date);
  return day ? SALE_DATE_FORMAT.format(day) : null;
}

/** `in 26 days` / `tomorrow` / `today` / `passed 3 days ago`. */
export function countdownWords(days) {
  if (!Number.isFinite(days)) return null;
  if (days < 0) return `passed ${Math.abs(days)} days ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `${days} days`;
}
