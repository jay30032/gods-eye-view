import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { rehabWithContingency } from './common.js';
import { money, ratio, requireFinite } from './math.js';

function wholesaleVerdict(assignmentFee, a) {
  if (assignmentFee >= a.wholesaleStrongFee) return 'strong';
  if (assignmentFee >= a.wholesaleThinFee) return 'thin';
  return 'pass';
}

/**
 * Deterministic wholesale underwrite.
 *
 * MAO is the 70% rule net of rehab — `ARV × 0.70 − rehab` — not a bare 70% of
 * ARV. Ignoring rehab is what made every distressed house look assignable.
 * The spread is what is left between that offer and the contract price.
 *
 * @param {{purchase:number,rehab:number,arv:number}} deal
 * @param {object} [overrides]
 */
export function analyzeWholesale(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const a = mergeAssumptions(overrides);

  const rehabTotal = rehabWithContingency(rehab, a);
  const mao = money(arv * a.wholesaleMaoRate - rehabTotal);
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
  const buyerDiscountToArv = arv > 0 ? ratio(1 - (buyerPays / arv)) : 0;

  return Object.freeze({
    strategy: 'wholesale',
    purchase: money(purchase),
    rehab: money(rehab),
    rehabTotal,
    arv: money(arv),
    mao,
    spread,
    assignmentFee,
    profit: assignmentFee,
    buyerPays,
    buyerDiscountToArv,
    viable: assignmentFee > 0,
    verdict: wholesaleVerdict(assignmentFee, a),
    assumptions: Object.freeze({ ...a }),
  });
}

export { DEAL_ASSUMPTIONS };
