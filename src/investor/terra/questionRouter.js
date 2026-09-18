/**
 * Which tool answers an investor's question, and which figures it needs.
 *
 * This is not a parser the app runs; the model chooses its own tools. It is
 * the contract the instructions describe, written down so a unit test can
 * hold forty investor questions against it and the fixture's facts, and so
 * the fields named here are guaranteed to exist on `propertyFacts`.
 *
 * Pure.
 */
export const RENTAL_ORDER = Object.freeze([
  'strategies.rental.cashFlowMonthly',
  'strategies.rental.cashOnCashPct',
  'strategies.rental.capRatePct',
  'strategies.rental.dscr',
]);

const STRATEGY_WORDS = Object.freeze([
  [/\bbrrr+\b|\brefi(?:nance)?(?:d|-and-hold)?\b|\bburr\b/, 'brrrr'],
  [/\bwholesal|\bassign/, 'wholesale'],
  [/\bflip/, 'flip'],
  [/\brent(?:al|er|s)?\b|\bcash ?flow\b|\bbuy and hold\b/, 'rental'],
]);

function strategyIn(text) {
  for (const [pattern, strategy] of STRATEGY_WORDS) if (pattern.test(text)) return strategy;
  return null;
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$%.'\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Field rules for `property_facts`, most specific first. */
const FACT_RULES = Object.freeze([
  [/\brental numbers\b|\bas a rental\b|\brun (it )?as a rental\b|\brental (case|side|math)\b/, RENTAL_ORDER],
  [/\bcap ?rate\b/, ['strategies.rental.capRatePct', 'strategies.rental.noi']],
  [/\bdscr\b|\bdebt (service )?coverage\b|\bcoverage ratio\b/, ['strategies.rental.dscr', 'strategies.brrrr.dscr']],
  [/\byield on cost\b/, ['strategies.rental.yieldOnCostPct']],
  [/\bnoi\b|\bnet operating\b/, ['strategies.rental.noi', 'strategies.rental.operatingExpenses']],
  [/\bcash ?flow\b/, ['strategies.rental.cashFlowMonthly', 'strategies.brrrr.cashFlowMonthly']],
  [/\bcash left in\b|\bleft in\b/, ['strategies.brrrr.cashLeftIn', 'strategies.brrrr.cashOut']],
  [/\bcash out\b|\bpull out\b/, ['strategies.brrrr.cashOut', 'strategies.brrrr.refinanceAmount']],
  [/\brefi(?:nance)? (amount|loan|proceeds)\b|\brefinance for\b/, ['strategies.brrrr.refinanceAmount', 'strategies.brrrr.refiLtvPct', 'strategies.brrrr.refiClosing']],
  [/\bdown ?payment\b/, ['strategies.rental.downPayment', 'assumptions.downPaymentPct']],
  [/\b(mortgage|interest|hard money) rate\b|\brate (are you|in use|assumed)\b|\bwhat rate\b/, ['assumptions.mortgageRatePct', 'assumptions.hardMoneyRatePct']],
  [/\bpoints\b/, ['strategies.flip.points', 'assumptions.hardMoneyPointsPct']],
  [/\bhold(ing)? (cost|costs)\b|\bcarry(ing)? (cost|costs)\b|\bcost to hold\b/, ['strategies.flip.carryingCost', 'strategies.flip.interest', 'strategies.flip.holdMonths']],
  [/\bclosing( costs?)?\b/, ['strategies.flip.buyClosing', 'strategies.flip.sellClosing', 'assumptions.buyClosingPct', 'assumptions.sellClosingPct']],
  [/\bannuali[sz]ed\b/, ['strategies.flip.annualizedPct', 'strategies.flip.holdMonths']],
  [/\bmargin\b/, ['strategies.flip.marginPct', 'strategies.flip.profit']],
  [/\ball[\s-]?in\b/, ['strategies.flip.allIn', 'strategies.flip.profit']],
  [/\bmao\b|\bmax(imum)? (allowable )?offer\b|\b70 ?(percent|%) rule\b/, ['strategies.wholesale.mao', 'strategies.flip.mao70']],
  [/\b(assignment|wholesale) fee\b|\bspread\b/, ['strategies.wholesale.assignmentFee', 'strategies.wholesale.spread']],
  [/\barv\b|\bafter[\s-]repair\b|\bresale\b/, ['strategies.flip.arv', 'deal.arv']],
  [/\brehab\b|\brenovation\b|\brepairs?\b|\bcontingency\b/, ['strategies.flip.rehab', 'strategies.flip.contingency', 'strategies.flip.rehabWithContingency']],
  [/\bcash (needed|in|to close)\b|\bhow much cash\b|\bcash invested\b/, ['strategies.flip.cashNeeded', 'strategies.rental.cashInvested']],
  [/\bprofit\b/, ['strategies.flip.profit', 'strategies.flip.cashOnCashPct']],
  [/\bauction\b|\bsale date\b|\bcourthouse\b|\bwhen (does|is) it (sell|go)\b/, ['signals.0.auction.date', 'signals.0.auction.daysUntil', 'signals.0.auction.courthouse']],
  [/\bfiled\b|\bhow (recent|old)\b|\bconfidence\b|\bsource\b/, ['signals.0.filed', 'signals.0.ageDays', 'signals.0.confidencePct', 'signals.0.source']],
  [/\bcounty\b/, ['county.name', 'county.legalOrgan']],
  [/\blot\b|\bparcel\b|\bacre/, ['parcel.acres']],
  [/\bequity\b/, ['ownerEquityPct', 'estimatedValue']],
  [/\bunder value\b|\bdiscount\b|\bentry\b|\bvs value\b|\bagainst value\b/, ['entry.underValuePct', 'entry.discount', 'estimatedValue']],
  [/\bworth\b|\bvalue\b|\bestimate\b/, ['estimatedValue', 'entry.purchase']],
  [/\bsquare feet\b|\bsqft\b|\bbeds?\b|\bbaths?\b|\byear built\b/, ['sqft', 'beds', 'baths', 'yearBuilt']],
  [/\bassumptions?\b|\bopex\b|\bexpense lines?\b/, ['assumptions.vacancyPct', 'assumptions.managementPct', 'assumptions.maintenancePct', 'assumptions.capexPct']],
]);

/**
 * @param {string} text the investor's words
 * @returns {{tool:string, fields:string[], strategy?:string|null, args?:object}}
 */
export function routeQuestion(text) {
  const q = normalize(text);

  // Two houses: "compare with the last one", "compare 621 third and 208 winter".
  if (/\bcompare\b.*\b(with|to|against)\b.*\b(last|previous|other|first) (one|house)\b/.test(q)
    || /\b(versus|vs)\b.*\b(last|previous)\b/.test(q)) {
    return { tool: 'compare_properties', fields: ['a.profit', 'b.profit', 'aMinusB.profit'], strategy: strategyIn(q), args: { withPrevious: true } };
  }
  if (/\bcompare\b.*\b\d{2,5} [a-z]+\b.*\b(and|with|to|vs|versus)\b.*\b\d{2,5} [a-z]+\b/.test(q)) {
    return { tool: 'compare_properties', fields: ['a.address', 'b.address', 'aMinusB.profit'], strategy: strategyIn(q), args: { named: true } };
  }
  // Ranking: "which ranks second and why", "why is this first".
  if (/\brank(s|ed|ing)?\b|\b(second|third|fourth) (one|house|pick|best)\b|\bwhy (is|does) (this|that|it) (the )?(first|top|best|second|third)\b|\border of\b|\bshortlist\b/.test(q)) {
    return { tool: 'rank_shortlist', fields: ['0.rank', '0.composite', '0.parts.bestPlayScore', '0.parts.signalStrength', '0.parts.equityScore', '0.drivers'] };
  }
  // What-ifs: a changed number, re-run.
  if (/^(what if|assume|suppose|say)\b|\bif (i|we) (pay|offer|buy|sell|hold|put|rent)\b|\bif rent\b|\bif (the )?rehab\b|\bat \d+(\.\d+)? ?(percent|%)\b/.test(q)) {
    return { tool: 'what_if', fields: ['facts.verdict', 'facts.headline'], strategy: strategyIn(q), args: { text: String(text || '') } };
  }
  // Why a strategy landed where it did.
  if (/\bwhy (not|is|isn't|does|doesn't|did)\b.*\b(flip|rental|rent|brrr+|wholesale|assign)/.test(q)
    || /\b(flip|rental|brrr+|wholesale) (is|was|came out|landed) (a )?(thin|pass|strong|weak)\b/.test(q)) {
    return { tool: 'explain_strategy', fields: ['verdict', 'spoken'], strategy: strategyIn(q) };
  }
  // All four side by side.
  if (/\bcompare\b|\bwhich (strategy|play|path|way|exit)\b|\bside by side\b|\ball four\b|\bbest (strategy|play|path|exit)\b|\bflip (or|vs|versus|and) (rent|rental|hold)\b/.test(q)) {
    return { tool: 'compare_strategies', fields: ['best', 'rows'] };
  }
  // A number about the house.
  for (const [pattern, fields] of FACT_RULES) {
    if (pattern.test(q)) return { tool: 'property_facts', fields: fields.slice(), strategy: strategyIn(q) };
  }
  if (/\bnumbers?\b|\bfigures?\b|\bunderwrit/.test(q)) {
    const strategy = strategyIn(q);
    return { tool: 'property_facts', fields: strategy ? [`strategies.${strategy}.headline`, `strategies.${strategy}.verdict`] : ['bestPlay', 'verdicts.flip'], strategy };
  }
  return { tool: 'investor_command', fields: [], strategy: strategyIn(q), args: { text: String(text || '') } };
}

/** Resolve a dotted path on an object; arrays take numeric segments. */
export function fieldAt(object, path) {
  return String(path).split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}
