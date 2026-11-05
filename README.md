# liquid-type

Glossy, inflated liquid letters for React. Type any word. Push the letters around with your cursor or finger, and they melt and smear like warm wax.

**[Live demo →](https://durvagaikwad.github.io/liquid-type/)**

| At rest | Melting |
| --- | --- |
| ![DURVA at rest](docs/rest.jpg) | ![DURVA mid-melt](docs/melt.jpg) |

- **Any word.** Seeded auto-layout mixes big, medium and small letters and tucks them into each other's gaps, like a hand-made poster.
- **Real gloss.** Each glyph becomes a signed distance field, inflated into a dome and lit with sharp highlights.
- **Melt + physics.** A cursor flowmap bends the surface. Letters are free bodies that collide by their actual shapes, so they never overlap.
- **Respectful.** Static under `prefers-reduced-motion`, pauses offscreen, and is labelled for screen readers.

## Install

```bash
npm install liquid-type three @react-three/fiber
```

Requires React 18 or 19. Use `@react-three/fiber` v8 with React 18, or v9 with React 19.

## Usage

```tsx
import { LiquidType } from "liquid-type";

export default function Hero() {
  return (
    <div style={{ height: "100vh" }}>
      <LiquidType text="HELLO" />
    </div>
  );
}
```

The component fills its parent, so **give the parent a height**.

### Fonts

The default font is [Bagel Fat One](https://fonts.google.com/specimen/Bagel+Fat+One). Load it yourself, since the package doesn't bundle any fonts. Chunky, rounded display fonts look best.

**Google Fonts:**

```html
<link href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&display=swap" rel="stylesheet" />
```

**Next.js (`next/font`):**

```tsx
import { Bagel_Fat_One } from "next/font/google";
const bagel = Bagel_Fat_One({ subsets: ["latin"], weight: "400" });

<LiquidType text="HELLO" fontFamily={bagel.style.fontFamily} />;
```

The component is client-only (it ships with `"use client"`), so it works in the App Router as-is.

## Props

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `text` | `string` | (required) | Spaces separate words. `"\n"` starts a new line. Up to 48 letters. |
| `fontFamily` | `string` | Bagel Fat One | Any loaded CSS font family. |
| `fontWeight` | `number \| string` | `400` | |
| `background` | `string` | `#F1ECE3` | |
| `ink` | `string` | `#0b0b0c` | Letter colour. |
| `seed` | `number` | `1` | Change it for a different auto layout. |
| `layout` | `LetterPlacement[]` | auto | Hand-placed letters (see below). |
| `onLayout` | `(layout) => void` | | Receives the layout in use. |
| `options` | `Partial<LiquidTypeOptions>` | `DEFAULT_OPTIONS` | Tuning, see below. |
| `interactive` | `boolean` | `true` | `false` gives a static poster. |
| `className`, `style` | | | Applied to the wrapper. |

### Hand-tuning the layout

The auto layout is a starting point. Grab it with `onLayout` (or the **Copy layout** button in the demo), adjust the numbers, and pass it back:

```tsx
<LiquidType
  text="DURVA"
  layout={[
    { x: -0.676, y: 0.012, height: 0.92, rotate: -4 },
    { x: -0.035, y: -0.199, height: 0.58, rotate: 6 },
    { x: 0.012, y: 0.305, height: 0.38, rotate: -10 },
    { x: 0.565, y: 0.092, height: 0.72, rotate: -4 },
    { x: 0.889, y: -0.272, height: 0.38, rotate: -14 },
  ]}
/>
```

There's one entry per visible character, in reading order:
- **`x`, `y`:** the center of the letter's ink, with y pointing up.
- **`height`:** the ink height.
- **`rotate`:** degrees, clockwise.

Units are arbitrary: the whole layout is scaled to fit. Keep a small gap between letters. Ones that touch at rest get nudged apart when the page loads.

### Options

All are optional. Sizes are fractions of the component's height.

| Option | Default | What it does |
| --- | --- | --- |
| `puffiness` | `0.07` | How inflated letters look. |
| `glossSharpness` | `28` | Higher = smaller, crisper highlights. |
| `rim` | `0.22` | Background colour reflected at the edges. |
| `gap` | `0.012` | Minimum space between letters. |
| `shadow` | `0.07` | Soft darkening of the background around letters. |
| `rounding` | `0.035` | Extra rounding applied to the font's corners. |
| `fill` | `0.96` | How much of the component the word fills. |
| `sizeVariety` | `1` | `0` = all letters the same size. |
| `tilt` | `12` | Max random tilt in the auto layout (degrees). |
| `brushRadius` | `0.16` | Size of the melt brush. |
| `meltStrength` | `0.2` | How far a melt drags the surface. |
| `meltGain` | `80` | How hard the cursor pushes the melt. |
| `recoveryTime` | `1.8` | Seconds for the melt to ooze back. |
| `jiggle` | `0.35` | Overshoot as the melt settles. |
| `noiseAmount`, `noiseScale` | `0.03`, `3` | Organic wobble in melted areas. |
| `drip` | `0.03` | Downward sag where the melt is strong. |
| `speedForMax`, `speedCurve` | `6`, `1.4` | How swipe speed maps to melt strength. |
| `letterPush` | `40` | How hard the cursor shoves letters. `0` = letters stay put. |
| `letterRadius` | `0.15` | Cursor reach around each letter. |
| `hoverFloor` | `0.1` | Push from a slow / resting cursor. |
| `flingBias` | `0.8` | Throw along the swipe vs. straight away. |
| `friction` | `2.5` | Lower = thrown letters glide further. |
| `homePull` | `0` | Spring back to the layout. `0` = letters stay where you leave them. |
| `bounce` | `0.45` | Bounciness off edges and other letters. |
| `maxRotation`, `spin` | `15`, `4` | How much pushes tilt letters. |

## How it works

1. **Glyphs to distance fields.** Each letter is drawn to a canvas and converted to an exact signed distance field (Felzenszwalb–Huttenlocher EDT), then rounded and smoothed. The fields share one half-float texture atlas.
2. **Auto layout.** Letters get seeded sizes and tilts, then slide into place right to left until their real outlines touch a neighbour. Small letters try sitting high, low and centered, and keep whichever tucks in furthest.
3. **Melt.** A ping-pong render target stores a displacement and velocity per pixel. The cursor pushes it, and a damped spring pulls it back.
4. **Shading.** The fragment shader warps each pixel by the flowmap, finds the nearest letter, turns the distance inside it into a dome-shaped height map, and lights it with a sharp key highlight, a soft fill and a rim.
5. **Physics.** Letters are rigid bodies. Collisions test each letter's outline points against its neighbours' distance fields, so W's and K's collide by shape, not by bounding circles.

## Performance

Every letter adds shader work on every pixel. A 20-letter word runs at 120 fps on an M-series Mac. On phones, keep text short. The canvas is capped at a device pixel ratio of 2 and stops rendering while offscreen. Building the letters takes about 0.1 s each, once per font and character set.

## Development

```bash
npm install
npm run dev        # demo at http://localhost:5173
npm run build      # library -> dist/
npm run build:demo # demo -> demo/dist/
```

## Credits

- 2D simplex noise by Ian McEwan and Ashima Arts ([webgl-noise](https://github.com/ashima/webgl-noise), MIT).
- Demo fonts (Bagel Fat One, Titan One, Chango) are loaded from Google Fonts under the SIL Open Font License. No fonts are bundled in the package.

## License

[MIT](LICENSE) © Durva Gaikwad
