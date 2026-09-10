import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { money, ratio, requireFinite } from './math.js';

/**
 * Deterministic wholesale underwrite.
 * MAO (max allowable offer to end buyer) = ARV × 0.70
 * Assignment fee is 40% of spread, clamped to $5k–$25k, and never exceeds spread.
 *
 * @param {{purchase:number,arv:number}} deal
 * @param {object} [overrides]
 */
export function analyzeWholesale(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const arv = requireFinite('arv', deal?.arv);
  const a = mergeAssumptions(overrides);

  const mao = money(arv * a.wholesaleMaoRate);
  const spread = money(mao - purchase);
  let assignmentFee = 0;
  if (spread > a.wholesaleFeeMin) {
    assignmentFee = money(Math.min(
      a.wholesaleFeeMax,
      Math.max(a.wholesaleFeeMin, spread * a.wholesaleFeeRate),
    ));
    if (assignmentFee > spread) assignmentFee = money(spread);
  }
  const buyerPays = money(purchase + assignmentFee);
  const discountToArv = arv > 0 ? ratio(1 - (buyerPays / arv)) : 0;

  return Object.freeze({
    strategy: 'wholesale',
    purchase: money(purchase),
    arv: money(arv),
    mao,
    spread,
    assignmentFee,
    profit: assignmentFee,
    buyerPays,
    discountToArv,
    viable: assignmentFee > 0 && spread > 0,
    assumptions: Object.freeze({ ...a }),
  });
}
