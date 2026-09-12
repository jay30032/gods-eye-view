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
 * Parcel outline.
 *
 * `st.s` runs around the loop, `st.t` across the ribbon — so the glow profile
 * is a function of `t` and the travelling segment is a window on `s`. The
 * ribbon is built at its widest and the *material* narrows it: a
 * GroundPolylineGeometry's width is baked at construction, and rebuilding
 * thirty of them to make a line breathe is exactly the per-frame geometry work
 * this layer refuses to do.
 */
export const OUTLINE_FABRIC = Object.freeze({
  type: 'TerraSignalParcelGlow',
  uniforms: {
    color: [1, 1, 1, 1],
    /** CPU envelope, already inside the signal's own [floor, ceil]. */
    brightness: 0.5,
    /** Lit fraction of the ribbon's baked width, 0..1. */
    widthFrac: 0.4,
    /** Selection alpha: 1 focused, 0.35 dimmed, 0.25 quiet. */
    alpha: 1.0,
    /** Falloff exponent of the outer halo. Lower is softer and wider. */
    softness: 2.4,
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

  // 0 down the centre line of the ribbon, 1 at either edge.
  float across = abs(materialInput.st.t - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.0, max(widthFrac, 0.02), across);
  float halo = pow(max(0.0, 1.0 - across), softness);
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
