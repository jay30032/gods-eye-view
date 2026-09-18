/**
 * Where the property card goes: next to its house.
 *
 * The card used to be a fixed right-hand panel — a dashboard widget that
 * happened to be about a house somewhere else on screen. Now it is anchored
 * to the marker: beside it, clear of it, clamped inside the viewport, and on
 * a narrow screen it becomes a bottom sheet because there is no "beside".
 *
 * Pure geometry, so the clamping and the side choice are tested on numbers.
 */

/** Below this viewport width there is no room beside a house; use a sheet. */
export const SHEET_MAX_WIDTH_PX = 640;
/** Gap between the marker and the card's near edge. */
export const ANCHOR_GAP_PX = 34;
/** Keep the card off the viewport edge by this much. */
export const ANCHOR_MARGIN_PX = 16;
/** The strip and the orb live along the bottom; the card stays above them. */
export const BOTTOM_RESERVE_PX = 132;
/** The brand mark lives top-left; nothing should cover it. */
export const TOP_RESERVE_PX = 56;
/** How far, in px, a card slides in from — towards its house. */
export const ENTER_OFFSET_PX = 28;

/**
 * @param {{marker:{x:number,y:number}|null, viewport:{w:number,h:number},
 *   card:{w:number,h:number}}} args
 * @returns {{mode:'sheet'|'anchored', left:number, top:number, side:string,
 *   from:{dx:number,dy:number}}}
 */
export function anchorCard({ marker, viewport, card }) {
  const vw = Math.max(0, Number(viewport?.w) || 0);
  const vh = Math.max(0, Number(viewport?.h) || 0);
  const cw = Math.max(0, Number(card?.w) || 0);
  const ch = Math.max(0, Number(card?.h) || 0);

  if (vw < SHEET_MAX_WIDTH_PX || cw + 2 * ANCHOR_MARGIN_PX > vw) {
    return { mode: 'sheet', left: 0, top: 0, side: 'bottom', from: { dx: 0, dy: ENTER_OFFSET_PX } };
  }

  const minTop = TOP_RESERVE_PX;
  const maxTop = Math.max(minTop, vh - BOTTOM_RESERVE_PX - ch);
  const minLeft = ANCHOR_MARGIN_PX;
  const maxLeft = Math.max(minLeft, vw - ANCHOR_MARGIN_PX - cw);
  const clampLeft = (x) => Math.min(maxLeft, Math.max(minLeft, x));
  const clampTop = (y) => Math.min(maxTop, Math.max(minTop, y));

  // No marker on screen: park where a card is expected, lower right.
  if (!marker || !Number.isFinite(marker.x) || !Number.isFinite(marker.y)) {
    return {
      mode: 'anchored', left: maxLeft, top: maxTop, side: 'parked', from: { dx: 0, dy: ENTER_OFFSET_PX },
    };
  }

  const fitsRight = marker.x + ANCHOR_GAP_PX + cw <= vw - ANCHOR_MARGIN_PX;
  const fitsLeft = marker.x - ANCHOR_GAP_PX - cw >= ANCHOR_MARGIN_PX;
  let side;
  let left;
  if (fitsRight) { side = 'right'; left = marker.x + ANCHOR_GAP_PX; }
  else if (fitsLeft) { side = 'left'; left = marker.x - ANCHOR_GAP_PX - cw; }
  else {
    // Neither side fits: go below (or above) and let the clamp do its work.
    side = marker.y < vh / 2 ? 'below' : 'above';
    left = clampLeft(marker.x - cw / 2);
  }
  let top = side === 'below'
    ? marker.y + ANCHOR_GAP_PX
    : side === 'above'
      ? marker.y - ANCHOR_GAP_PX - ch
      : marker.y - ch / 2;
  left = clampLeft(left);
  top = clampTop(top);

  // The clamp can slide the card over the house. If the marker ended up inside
  // the card, push the card off it along the shorter axis.
  const inside = marker.x >= left && marker.x <= left + cw && marker.y >= top && marker.y <= top + ch;
  if (inside) {
    const pushUp = marker.y - top + ANCHOR_GAP_PX;
    const pushDown = top + ch - marker.y + ANCHOR_GAP_PX;
    const upTop = clampTop(top - pushUp);
    const downTop = clampTop(top + pushDown);
    const upClear = marker.y > upTop + ch;
    const downClear = marker.y < downTop;
    if (upClear && (!downClear || pushUp <= pushDown)) top = upTop;
    else if (downClear) top = downTop;
  }

  return { mode: 'anchored', left: Math.round(left), top: Math.round(top), side, from: enterOffset(marker, { left, top, w: cw, h: ch }) };
}

/** A unit-ish offset from the card's centre towards the marker, scaled to the slide distance. */
export function enterOffset(marker, rect) {
  const cx = rect.left + rect.w / 2;
  const cy = rect.top + rect.h / 2;
  const dx = marker.x - cx;
  const dy = marker.y - cy;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return { dx: 0, dy: ENTER_OFFSET_PX };
  return {
    dx: Math.round((dx / length) * ENTER_OFFSET_PX),
    dy: Math.round((dy / length) * ENTER_OFFSET_PX),
  };
}

/**
 * The leader line: from the marker to the nearest point on the card's edge.
 * @returns {{x1:number,y1:number,x2:number,y2:number,length:number}}
 */
export function leaderLine(marker, rect) {
  const x2 = Math.min(rect.left + rect.w, Math.max(rect.left, marker.x));
  const y2 = Math.min(rect.top + rect.h, Math.max(rect.top, marker.y));
  return {
    x1: marker.x, y1: marker.y, x2, y2, length: Math.hypot(x2 - marker.x, y2 - marker.y),
  };
}
