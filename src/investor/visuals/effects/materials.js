/**
 * The two shaders the near-field layer draws with.
 *
 * Kept in their own file because they are the part with no Node-side test: a
 * unit suite cannot compile GLSL, so the rule is that anything which must be
 * *proven* bounded (brightness, glow width, alpha) is computed in JS and
 * arrives here as a uniform already in range. What the shaders decide for
 * themselves is only what varies across the geometry, which the CPU cannot
 * supply at all: where the travelling segment is around a parcel loop, and how
 * far up a column the wave has climbed.
 *
 * Both read the same `time` uniform, written once per frame from one clock.
 */

/**
 * The building outline.
 *
 * This used to draw the *parcel* — a synthetic box pushed out from the
 * footprint by typical setbacks. On the tiles that read as the wrong property
 * altogether: a crooked rectangle lying across the street and over a
 * neighbour's roof, drawn in the confident gold that is supposed to mean "this
 * house". So the ring handed to this material is now the real OSM building
 * footprint, and the profile below is built to read as a *drawn line* rather
 * than a ribbon of light.
 *
 * The profile is expressed in PIXELS, not in fractions of the baked ribbon.
 * `GroundPolylineGeometry` bakes its width at construction, so the geometry is
 * created once at the widest the design ever needs and the material decides how
 * much of it lights up. Doing that in pixels is what lets "2 px core, 6 px
 * glow" mean exactly that at any camera range, instead of a fraction that
 * silently changes meaning when the baked width changes.
 *
 * `st.s` runs around the loop, `st.t` across the ribbon — so the glow profile is
 * a function of `t` and the travelling segment is a window on `s`.
 */
export const OUTLINE_FABRIC = Object.freeze({
  type: 'TerraSignalParcelGlow',
  uniforms: {
    color: [1, 1, 1, 1],
    /** CPU envelope, already inside the signal's own [floor, ceil]. */
    brightness: 0.5,
    /** Half-width of the solid core, in pixels. 1.0 draws a 2 px line. */
    coreHalfPx: 1.0,
    /** Half-width at which the halo has fallen to nothing, in pixels. */
    glowHalfPx: 3.0,
    /** Half-width the ribbon geometry was actually baked at, in pixels. */
    ribbonHalfPx: 8.0,
    /** Selection alpha: 1 focused, 0.35 dimmed, 0.25 quiet. */
    alpha: 1.0,
    /** The one shared clock, in seconds. */
    time: 0.0,
    /** Loops per second for the travelling segment. 0 disables it entirely. */
    travelPerSec: 0.0,
    /** Length of that segment as a fraction of the loop. */
    segmentWidth: 0.08,
  },
  source: `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);

  // 0 down the centre line of the ribbon, 1 at either edge, then back into
  // pixels using the width the geometry was baked at.
  float across = abs(materialInput.st.t - 0.5) * 2.0;
  float px = across * ribbonHalfPx;

  // A hard couple of pixels with half a pixel of anti-aliasing either side,
  // then a soft shoulder that is gone by glowHalfPx.
  float core = 1.0 - smoothstep(coreHalfPx - 0.5, coreHalfPx + 0.5, px);
  float shoulder = max(glowHalfPx - coreHalfPx, 0.5);
  float halo = pow(clamp(1.0 - (px - coreHalfPx) / shoulder, 0.0, 1.0), 2.0);
  float glow = clamp(core + halo * 0.55, 0.0, 1.0);

  float lit = brightness;
  if (travelPerSec > 0.0) {
    // One bright segment running around the loop. Distance is measured the
    // short way round so it crosses the seam without a flicker.
    float head = fract(time * travelPerSec);
    float d = abs(materialInput.st.s - head);
    d = min(d, 1.0 - d);
    lit += (1.0 - smoothstep(0.0, max(segmentWidth, 0.01), d)) * 0.85;
  }

  float shade = clamp(lit, 0.0, 1.0);
  material.diffuse = color.rgb * clamp(lit, 0.0, 1.6);
  material.emission = color.rgb * shade * 0.65;
  material.alpha = glow * alpha * (0.35 + 0.65 * shade);
  return material;
}
`,
});

/**
 * The column: a translucent prism standing on the footprint.
 *
 * Drawn as a wall, not an extruded polygon, so there is no lid — a capped box
 * reads as a solid object sitting on the roof, and the whole point is a shaft
 * of light that runs out of substance on the way up. `st.t` is 0 at the
 * footprint and 1 at the top of the wall, which is what the upward fade rides.
 */
export const COLUMN_FABRIC = Object.freeze({
  type: 'TerraSignalSignalColumn',
  uniforms: {
    color: [1, 1, 1, 1],
    brightness: 0.6,
    /** Distance fade times selection alpha, both computed on the CPU. */
    alpha: 0.3,
    time: 0.0,
    /** Rise rate of the TAX_SALE wave, in column-heights per second. 0 = none. */
    wavePerSec: 0.0,
  },
  source: `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);

  float up = clamp(materialInput.st.t, 0.0, 1.0);
  // Gone by the top, and mostly gone well before it: the column marks a house,
  // it does not draw a box around the sky above it. The exponent is steep
  // because the near and far faces of a closed wall both contribute.
  float fade = pow(1.0 - up, 2.4);

  float lit = brightness;
  if (wavePerSec > 0.0) {
    float head = fract(time * wavePerSec);
    float d = abs(up - head);
    lit += (1.0 - smoothstep(0.0, 0.20, d)) * 0.80;
  }

  float shade = clamp(lit, 0.0, 1.0);
  material.diffuse = color.rgb * clamp(lit, 0.0, 1.6);
  material.emission = color.rgb * shade * 0.8;
  material.alpha = fade * alpha * (0.4 + 0.6 * shade);
  return material;
}
`,
});
