/**
 * Tuning for <BalloonType />. Every field is optional on the component; anything
 * you leave out falls back to DEFAULT_OPTIONS.
 *
 * Units: "viewport heights" means fractions of the component's height
 * (0.1 = 10% of its height), so the feel is the same at any size.
 */
export type BalloonTypeOptions = {
  // Look
  /** Dome width from the edge inward, in viewport heights. Bigger = more inflated. */
  puffiness: number;
  /** Specular exponent. Higher = smaller, crisper highlights. */
  glossSharpness: number;
  /** Soft contact darkening of the background around letters. */
  shadow: number;
  /** Extra corner rounding applied to the font, as a fraction of the glyph tile. */
  rounding: number;

  // Layout
  /** Maximum random tilt per letter in the auto layout, in degrees. */
  tilt: number;

  // Melt
  /** How far a melt can drag the surface, in viewport heights. */
  meltStrength: number;
  /** How hard the cursor pushes the melt. */
  meltGain: number;
  /** Seconds for the melt to ooze back. */
  recoveryTime: number;
  /** 0 = no overshoot when the melt settles, 0.7 = wobbly. */
  jiggle: number;
  /** Cursor speed (viewport heights / s) that counts as a full-strength swipe. */
  speedForMax: number;
  /** >1 keeps slow hovers subtle and lets fast swipes dominate. */
  speedCurve: number;

  // Movement
  /** Force the cursor applies to letters. 0 disables pushing. */
  letterPush: number;
  /** Fraction of the push a slow or resting cursor still applies. */
  hoverFloor: number;
  /** How much a swipe throws letters along its direction vs straight away. */
  flingBias: number;
  /** How quickly a thrown letter slows down, per second. Lower = glides further. */
  friction: number;
  /** Spring back toward the original layout. 0 = letters stay where you leave them. */
  homePull: number;
  /** Energy kept when a letter hits an edge or another letter (0..1). */
  bounce: number;
  /** How strongly a push tilts a letter. */
  spin: number;
};

export const DEFAULT_OPTIONS: BalloonTypeOptions = {
  puffiness: 0.07,
  glossSharpness: 28,
  shadow: 0.07,
  rounding: 0.035,

  tilt: 12,

  meltStrength: 0.2,
  meltGain: 80,
  recoveryTime: 1.8,
  jiggle: 0.35,
  speedForMax: 6,
  speedCurve: 1.4,

  letterPush: 40,
  hoverFloor: 0.1,
  flingBias: 0.8,
  friction: 2.5,
  homePull: 0,
  bounce: 0.45,
  spin: 4,
};

export const DEFAULT_FONT_FAMILY = '"Bagel Fat One", "Arial Rounded MT Bold", sans-serif';
export const DEFAULT_BACKGROUND = "#F1ECE3";
export const DEFAULT_INK = "#0b0b0c";

/** Letters beyond this are dropped: each one costs shader work on every pixel. */
export const MAX_LETTERS = 48;
