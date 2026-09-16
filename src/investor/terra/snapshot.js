/**
 * The state snapshot the assistant reads before every turn.
 *
 * Compact on purpose: it is sent as a system item on every turn, and every
 * token in it is a token the model reads before it can answer. It carries what
 * a person standing next to the screen would know — where we are, what the
 * camera is doing, what is lit, which house is open and what its numbers say,
 * what was just said — and nothing a tool could not be asked for.
 *
 * Every number is exact. The assistant is told to repeat numbers verbatim, so
 * rounding here is rounding the product's answer.
 *
 * Pure: the caller gathers the live objects; this shapes them.
 */
import { primarySignal, signalLabel } from '../mock/schema.js';
import { strategyHeadline } from '../scoring.js';
import { whyThisMatters } from '../focus.js';
import { formatSaleDate } from '../georgia.js';
import { ASSISTANT_NAME } from './identity.js';

/**
 * Shots in words. The model is told where the camera is, never what the shot
 * is called, so it cannot read "cruise view" back to the user.
 */
export const VIEW_WORDS = Object.freeze({
  WORLD: 'the globe',
  STAGING: 'high over the market',
  CRUISE: 'over the market',
  REVEAL: 'over the shortlist',
  HERO: 'at the house',
  HOP: 'hopping to the next house',
  DRIVE: 'driving the streets',
  ANGLE: 'at the house, from a new angle',
});

export function viewWords(shot) {
  if (!shot) return null;
  return VIEW_WORDS[String(shot).toUpperCase()] || String(shot).toLowerCase();
}

/** How many exchanges the snapshot remembers. */
export const EXCHANGE_LIMIT = 3;
/** How many shortlist rows are listed in full. */
export const SHORTLIST_LIMIT = 6;

function shortAddress(property) {
  return String(property?.address || '').split(',')[0];
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 10;
}

/** The plays, in an investor's words rather than the calculators'. */
export const PLAY_WORDS = Object.freeze({
  flip: 'flip',
  rental: 'rental',
  brrrr: 'refinance-and-hold',
  wholesale: 'assignment',
});

export function playWords(strategy) {
  return PLAY_WORDS[String(strategy || '').toLowerCase()] || null;
}

function underValuePct(property) {
  const value = Number(property?.estimatedValue);
  const purchase = Number(property?.deal?.purchase);
  if (!(value > 0) || !Number.isFinite(purchase)) return null;
  return Math.round((1 - purchase / value) * 100);
}

/**
 * One house, as the assistant needs it.
 *
 * No score and no strategy key: the assistant is told to talk money and
 * deadline, and a field called `composite` on every row is an invitation to
 * say "composite score" out loud. The ranking survives as `rank` (1 is the
 * gold pick), the calculators as a headline in dollars, and the strategy as
 * the words an investor would use for it.
 */
export function rowSummary(property, { rank = null } = {}) {
  if (!property) return null;
  const signal = primarySignal(property);
  const best = property.bestStrategy || null;
  const analysis = property.analyses?.[best] || null;
  return {
    id: property.id,
    address: shortAddress(property),
    signal: signalLabel(signal?.type),
    ...(rank ? { rank } : {}),
    play: playWords(best),
    ...(analysis ? { works: analysis.verdict, headline: strategyHeadline(analysis) } : {}),
    underValuePct: underValuePct(property),
    ...(property.auction ? { auctionDays: property.auction.daysUntil } : {}),
  };
}

/**
 * The whole board in a few numbers: how many houses, how many of each signal,
 * and the auctions on the calendar soonest first.
 */
export function boardSummary(properties = []) {
  const rows = (properties || []).filter(Boolean);
  const signals = {};
  const auctions = [];
  for (const row of rows) {
    for (const signal of row.signals || []) {
      const label = signalLabel(signal.type);
      signals[label] = (signals[label] || 0) + 1;
    }
    if (row.auction && Number.isFinite(row.auction.daysUntil)) {
      auctions.push({
        address: shortAddress(row),
        daysUntil: row.auction.daysUntil,
        date: formatSaleDate(row.auction.date),
        courthouse: String(row.auction.courthouse || '').split(',')[0],
      });
    }
  }
  auctions.sort((a, b) => a.daysUntil - b.daysUntil);
  const count = rows.reduce((n, row) => n + (row.signals || []).length, 0);
  return { houses: rows.length, signals: count, byType: signals, auctions };
}

/** The focused house, its analysis and its why. */
export function focusedSummary(property, analysis = null, { saved = false, strategy = null } = {}) {
  if (!property) return null;
  const run = analysis && analysis.strategy ? analysis : null;
  return {
    ...rowSummary(property),
    type: property.propertyType || null,
    value: money(property.estimatedValue),
    equityPct: pct(property.estimatedEquityPct),
    purchase: money(property.deal?.purchase),
    rehab: money(property.deal?.rehab),
    arv: money(property.deal?.arv),
    rent: money(property.deal?.rent),
    signals: (property.signals || []).map((s) => ({
      type: signalLabel(s.type),
      confidencePct: Math.round(Number(s.confidence || 0) * 100),
      filed: s.effectiveDate || null,
    })),
    auction: property.auction
      ? {
        date: formatSaleDate(property.auction.date),
        daysUntil: property.auction.daysUntil,
        courthouse: String(property.auction.courthouse || '').split(',')[0],
      }
      : null,
    analysis: run
      ? {
        play: playWords(run.strategy),
        works: run.verdict,
        headline: strategyHeadline(run),
        ...(run.strategy === 'flip' ? {
          profit: money(run.profit), cashIn: money(run.cashIn), marginPct: pct(run.margin), holdMonths: run.holdMonths,
        } : {}),
        ...(run.strategy === 'rental' ? {
          cashFlowMonthly: money(run.cashFlowMonthly), cocPct: pct(run.coc), dscr: Number(run.dscr?.toFixed?.(2) ?? run.dscr),
        } : {}),
        ...(run.strategy === 'brrrr' ? {
          cashLeftIn: money(run.cashLeftIn), cashOut: money(run.cashOut), cashFlowMonthly: money(run.cashFlowMonthly),
          cocPct: run.infiniteReturn ? 'infinite' : pct(run.coc),
        } : {}),
        ...(run.strategy === 'wholesale' ? {
          viable: Boolean(run.viable), mao: money(run.mao), spread: money(run.spread), fee: money(run.assignmentFee),
        } : {}),
      }
      : null,
    playShown: playWords(strategy),
    why: whyThisMatters(property, run),
    saved: Boolean(saved),
  };
}

/**
 * @param {object} input everything gathered from the live session
 * @returns {object} the snapshot, JSON-serialisable
 */
export function buildSnapshot({
  market = null,
  clock = null,
  camera = {},
  drive = {},
  properties = [],
  shortlistIds = [],
  topPickId = null,
  focused = null,
  analysis = null,
  strategy = null,
  saved = false,
  screen = {},
  exchanges = [],
  level = 'full',
  listening = true,
  event = null,
} = {}) {
  const byId = new Map((properties || []).filter(Boolean).map((row) => [row.id, row]));
  const shortlist = (shortlistIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, SHORTLIST_LIMIT)
    .map((row, index) => rowSummary(row, { rank: index + 1 }));
  const gold = topPickId ? rowSummary(byId.get(topPickId), { rank: 1 }) : null;
  const driveCurrent = drive?.current?.property || drive?.current || null;

  return {
    assistant: ASSISTANT_NAME,
    ...(event ? { event } : {}),
    market: market ? { id: market.id, name: market.name } : null,
    clock: clock || null,
    camera: {
      view: viewWords(camera.shot),
      flying: Boolean(camera.flying),
      orbiting: Boolean(camera.orbiting),
      heightM: Number.isFinite(camera.heightM) ? Math.round(camera.heightM) : null,
      // Present only when the view moved since the last snapshot: the cue for
      // the "announce every view change" clause, and its absence is the cue
      // not to narrate a camera standing still.
      ...(camera.change ? {
        change: {
          from: viewWords(camera.change.from),
          to: viewWords(camera.change.to),
          ...(camera.change.flying ? { flying: true } : {}),
        },
      } : {}),
    },
    drive: {
      running: Boolean(drive.running),
      paused: Boolean(drive.paused),
      ...(drive.running ? {
        alongM: Math.round(Number(drive.alongM) || 0),
        lengthM: Math.round(Number(drive.lengthM) || 0),
        current: driveCurrent?.id ? rowSummary(driveCurrent) : null,
        gold: drive.goldId ? rowSummary(byId.get(drive.goldId)) : null,
        streetView: Boolean(drive.panoStopped),
      } : {}),
    },
    narration: level,
    listening: Boolean(listening),
    board: boardSummary(properties),
    gold,
    shortlist,
    focused: focusedSummary(focused, analysis, { saved, strategy }),
    screen: {
      card: Boolean(screen.card),
      cardAssembling: Boolean(screen.cardAssembling),
      savedSheet: Boolean(screen.savedSheet),
      dealVision: screen.dealVision || null,
      opportunityVision: Boolean(screen.opportunityVision),
      xray: Boolean(screen.xray),
      strip: screen.strip || null,
    },
    exchanges: (exchanges || []).slice(-EXCHANGE_LIMIT),
  };
}

/** The snapshot as the model sees it: one line of JSON. */
export function snapshotText(snapshot) {
  return JSON.stringify(snapshot);
}
