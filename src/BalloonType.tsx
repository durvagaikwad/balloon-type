import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import * as THREE from "three";
import { autoLayout, fillLayout, fitLayout, type FittedLayout, type LetterPlacement, type Token } from "./layout";
import {
  DEFAULT_BACKGROUND,
  DEFAULT_FONT_FAMILY,
  DEFAULT_INK,
  DEFAULT_OPTIONS,
  MAX_LETTERS,
  type BalloonTypeOptions,
} from "./options";
import { resolveContacts, type Body, type Rest } from "./physics";
import { buildAtlas, hasInk, SDF_RESOLUTION, type Atlas } from "./sdf";
import { fullscreenVert, makeDisplayFrag, simFrag } from "./shaders";

const DPR_CAP = 2;
const FLOW_RES_SCALE = 0.25; // flowmap resolution relative to CSS size (it's blurry by nature)
const FLOW_RES_MAX = 512;
const MAX_DT = 1 / 30; // clamp so tab-switching doesn't cause jumps
const ROT_STIFFNESS = 150; // tilt springs back to each letter's resting rotation
const ROT_DAMPING = 12;
const LETTER_REACH = 0.15; // how far beyond a letter's core the cursor reaches, in view heights
const MAX_ROTATION = 15; // degrees a push can tilt a letter
const RIM = 0.22; // background colour reflected at the silhouette
const BRUSH_RADIUS = 0.16; // melt brush, in view heights
// Organic wobble and downward sag in melted areas (view heights).
const MELT_NOISE = 0.03;
const MELT_NOISE_SCALE = 3;
const MELT_DRIP = 0.03;

export type BalloonTypeProps = {
  /** The word(s) to render. Spaces separate words, "\n" starts a new line. */
  text: string;
  /** CSS font-family. The font must already be loaded on the page (e.g. Google Fonts or next/font). */
  fontFamily?: string;
  fontWeight?: number | string;
  background?: string;
  ink?: string;
  /** Change to get a different auto layout. */
  seed?: number;
  /**
   * Auto layout style. "fill" (default) packs the letters to fill the whole
   * view, re-packing when its shape changes. "row" keeps them on one line
   * per text line, with small letters tucked into big ones' gaps.
   */
  arrangement?: "fill" | "row";
  /** Hand-placed letters (one per visible character), instead of the auto layout. */
  layout?: LetterPlacement[];
  /** Called with the layout in use, ready to paste into `layout` and tweak. */
  onLayout?: (layout: LetterPlacement[]) => void;
  /** Tuning; anything left out uses DEFAULT_OPTIONS. */
  options?: Partial<BalloonTypeOptions>;
  /** false = static poster, no cursor effects. */
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
};

type PointerState = {
  x: number; // uv, 0..1
  y: number;
  prevX: number;
  prevY: number;
  inside: boolean;
  fresh: boolean; // just entered / touched down: don't draw a streak from the old position
};

type Built = {
  atlas: Atlas;
  layout: FittedLayout;
  material: THREE.ShaderMaterial;
  bodies: Body[];
};

function tokenize(text: string, ctx: CanvasRenderingContext2D) {
  const tokens: Token[] = [];
  const chars: string[] = [];
  for (const ch of Array.from(text)) {
    if (ch === "\n") tokens.push({ kind: "newline" });
    else if (!hasInk(ctx, ch)) tokens.push({ kind: "space" });
    else if (chars.length < MAX_LETTERS) {
      tokens.push({ kind: "glyph", index: chars.length });
      chars.push(ch);
    }
  }
  return { tokens, chars };
}

function setRgb(hex: string, out: THREE.Vector3) {
  // Raw sRGB values: the shader writes straight to the screen, no colour management.
  const rgb = { r: 0, g: 0, b: 0 };
  new THREE.Color(hex).getRGB(rgb, THREE.SRGBColorSpace);
  out.set(rgb.r, rgb.g, rgb.b);
}

function makeFlowTarget(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function makeDisplayMaterial(count: number, atlas: Atlas, bg: THREE.Vector3, ink: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    vertexShader: fullscreenVert,
    fragmentShader: makeDisplayFrag(count, atlas.cols, atlas.rows),
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSdf: { value: atlas.texture },
      uFlow: { value: null },
      uLetters: { value: Array.from({ length: count }, () => new THREE.Vector4()) },
      uAtlasSize: { value: new THREE.Vector2(SDF_RESOLUTION * atlas.cols, SDF_RESOLUTION * atlas.rows) },
      uTexel: { value: 2 / SDF_RESOLUTION },
      uAspect: { value: 1 },
      uPx: { value: 0.001 },
      uPuff: { value: 0 },
      uGloss: { value: 1 },
      uRim: { value: 0 },
      uShadow: { value: 0 },
      uStrength: { value: 0 },
      uNoise: { value: 0 },
      uNoiseScale: { value: 1 },
      uDrip: { value: 0 },
      uTime: { value: 0 },
      uEnabled: { value: 1 },
      uBg: { value: bg },
      uInk: { value: ink },
    },
  });
}

type SceneProps = {
  text: string;
  fontFamily: string;
  fontWeight: number | string;
  background: string;
  ink: string;
  seed: number;
  arrangement: "fill" | "row";
  layout?: LetterPlacement[];
  onLayout?: (layout: LetterPlacement[]) => void;
  options: BalloonTypeOptions;
  interactive: boolean;
  reduced: boolean;
  pointer: MutableRefObject<PointerState>;
};

function BalloonScene({
  text,
  fontFamily,
  fontWeight,
  background,
  ink,
  seed,
  arrangement,
  layout,
  onLayout,
  options,
  interactive,
  reduced,
  pointer,
}: SceneProps) {
  const { gl, size, viewport, invalidate } = useThree();
  const dpr = Math.min(viewport.dpr, DPR_CAP);

  const optsRef = useRef(options);
  optsRef.current = options;
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  const meshRef = useRef<THREE.Mesh>(null);
  const built = useRef<Built | null>(null);
  const atlasCache = useRef<{ key: string; atlas: Atlas } | null>(null);
  const bgVec = useRef(new THREE.Vector3());
  const inkVec = useRef(new THREE.Vector3());

  // Flowmap ping-pong.
  // A shader can't read and write the same texture, so we keep two render
  // targets: each frame the sim pass reads `read` (last frame's state), writes
  // the updated state into `write`, then the two swap roles. After the swap,
  // `read` holds the newest state and is what the display pass samples.
  const sim = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: simFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uA: { value: new THREE.Vector2() },
        uB: { value: new THREE.Vector2() },
        uVel: { value: new THREE.Vector2() },
        uAspect: { value: 1 },
        uRadius: { value: 0.1 },
        uImpulse: { value: 0 },
        uK: { value: 1 },
        uC: { value: 1 },
        uDt: { value: 0 },
        uActive: { value: 0 },
      },
    });
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { material, scene, camera, quad };
  }, []);
  const targets = useRef<{ read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget } | null>(null);
  const smoothVel = useRef(new THREE.Vector2());
  const time = useRef(0);

  // (Re)allocate the flowmap on resize. Any melt in progress is dropped.
  useEffect(() => {
    const fw = Math.min(FLOW_RES_MAX, Math.max(8, Math.round(size.width * FLOW_RES_SCALE)));
    const fh = Math.min(FLOW_RES_MAX, Math.max(8, Math.round(size.height * FLOW_RES_SCALE)));
    const read = makeFlowTarget(fw, fh);
    const write = makeFlowTarget(fw, fh);
    targets.current = { read, write };
    invalidate();
    return () => {
      read.dispose();
      write.dispose();
    };
  }, [size.width, size.height, invalidate]);

  useEffect(() => {
    setRgb(background, bgVec.current);
    setRgb(ink, inkVec.current);
    gl.setClearColor(background);
    invalidate();
  }, [background, ink, gl, invalidate]);

  // Build: wait for the font, make the SDF atlas (cached per character set),
  // lay the letters out and compile a shader for this letter count. The SDFs
  // live in each letter's own tile space, so resizing never rebuilds them;
  // only the "fill" arrangement re-packs, because it depends on the view's shape.
  const layoutKey = layout ? JSON.stringify(layout) : "";
  const { rounding, tilt } = options;
  const fillAspect = !layout && arrangement === "fill" ? +(size.width / size.height).toFixed(2) : 0;
  useEffect(() => {
    let cancelled = false;
    const font = (px: number) => `${fontWeight} ${px}px ${fontFamily}`;
    (async () => {
      // Let a resize settle before re-packing.
      if (built.current) await new Promise((r) => setTimeout(r, 150));
      if (cancelled) return;
      try {
        await document.fonts.load(font(100), text);
        await document.fonts.ready;
      } catch {
        // draw with whatever is available
      }
      if (cancelled) return;

      const probe = document.createElement("canvas").getContext("2d")!;
      probe.font = font(100);
      const { tokens, chars } = tokenize(text, probe);
      const mesh = meshRef.current;
      if (!chars.length || !mesh) {
        if (mesh) mesh.visible = false;
        invalidate();
        return;
      }

      const key = `${font(1)}|${rounding}|${chars.join("\u0000")}`;
      if (atlasCache.current?.key !== key) {
        atlasCache.current?.atlas.texture.dispose();
        atlasCache.current = { key, atlas: buildAtlas(chars, font, rounding) };
      }
      const atlas = atlasCache.current.atlas;

      let placements: LetterPlacement[];
      if (layout && layout.length === chars.length) placements = layout;
      else {
        if (layout) {
          console.warn(
            `[balloon-type] layout has ${layout.length} entries but the text has ${chars.length} letters; using the auto layout.`,
          );
        }
        const settings = { seed, gap: 0, sizeVariety: 1, tilt }; // letters touch
        placements =
          arrangement === "fill" && fillAspect > 0
            ? fillLayout(tokens, atlas, { ...settings, aspect: fillAspect })
            : autoLayout(tokens, atlas, settings);
      }
      const fitted = fitLayout(placements, atlas);
      onLayoutRef.current?.(
        fitted.placements.map((p) => ({
          x: +p.x.toFixed(3),
          y: +p.y.toFixed(3),
          height: +p.height.toFixed(3),
          rotate: +p.rotate.toFixed(1),
        })),
      );

      const prev = built.current;
      const reuse =
        prev &&
        prev.atlas.cols === atlas.cols &&
        prev.atlas.rows === atlas.rows &&
        prev.layout.placements.length === chars.length;
      const material = reuse
        ? prev.material
        : makeDisplayMaterial(chars.length, atlas, bgVec.current, inkVec.current);
      if (!reuse) prev?.material.dispose();
      material.uniforms.uSdf.value = atlas.texture;

      built.current = {
        atlas,
        layout: fitted,
        material,
        bodies: chars.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0 })),
      };
      mesh.material = material;
      mesh.visible = true;
      invalidate();
    })();
    return () => {
      cancelled = true;
    };
  }, [text, fontFamily, fontWeight, seed, arrangement, fillAspect, layoutKey, rounding, tilt, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      built.current?.material.dispose();
      atlasCache.current?.atlas.texture.dispose();
      sim.material.dispose();
      sim.quad.geometry.dispose();
    },
    [sim],
  );

  useFrame((_, rawDelta) => {
    const b = built.current;
    if (!b || !targets.current) return;
    const o = optsRef.current;
    const u = b.material.uniforms;
    const aspect = size.width / size.height;
    const { placements, width, height } = b.layout;
    const n = placements.length;
    const bs = b.bodies;

    // Fit the layout into the view (view height = 1), then add physics offsets.
    const fit = Math.min(aspect / width, 1 / height); // edge to edge
    const rest: Rest[] = placements.map((p, i) => ({
      x: p.x * fit,
      y: p.y * fit,
      angle: (-p.rotate * Math.PI) / 180,
      tile: (p.height / b.atlas.inkHeights[i]) * fit,
      mass: p.height * 2, // big letters are heavier
    }));
    rest.forEach((r, i) => (u.uLetters.value[i] as THREE.Vector4).set(r.x + bs[i].x, r.y + bs[i].y, r.angle + bs[i].a, r.tile));

    u.uAspect.value = aspect;
    u.uPx.value = 1 / (size.height * dpr);
    u.uPuff.value = o.puffiness;
    u.uGloss.value = o.glossSharpness;
    u.uRim.value = RIM;
    u.uShadow.value = o.shadow;
    u.uEnabled.value = reduced ? 0 : 1;
    if (reduced) return;

    const dt = Math.min(rawDelta, MAX_DT);
    time.current += dt;

    // Cursor velocity in view heights / s, mapped to 0..1 with a curve.
    const p = pointer.current;
    const active = interactive && p.inside;
    const resumed = rawDelta > MAX_DT * 3; // returning from a hidden tab: don't streak
    if (p.fresh || resumed) {
      p.prevX = p.x;
      p.prevY = p.y;
      p.fresh = false;
    }
    const dx = (p.x - p.prevX) * aspect;
    const dy = p.y - p.prevY;
    const dist = Math.hypot(dx, dy);
    const speed = dist / Math.max(dt, 1e-4);
    const amount = Math.pow(Math.min(speed / o.speedForMax, 1), o.speedCurve);
    const targetVx = dist > 1e-6 ? (dx / dist) * amount : 0;
    const targetVy = dist > 1e-6 ? (dy / dist) * amount : 0;
    const k = 1 - Math.exp(-dt * 30); // smooth out pointer event timing jitter
    smoothVel.current.x += (targetVx - smoothVel.current.x) * k;
    smoothVel.current.y += (targetVy - smoothVel.current.y) * k;

    // Letter physics. Letters are free bodies: the cursor shoves nearby letters
    // (harder when closer and when moving fast, biased along the swipe),
    // friction brings them to a stop wherever they end up, and they collide
    // with each other and the view edges by shape. Only the tilt springs back.
    const cx = (p.x - 0.5) * aspect;
    const cy = p.y - 0.5;
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);
    const torque = new Array<number>(n).fill(0);
    if (active && o.letterPush > 0) {
      for (let i = 0; i < n; i++) {
        const lx = rest[i].x + bs[i].x;
        const ly = rest[i].y + bs[i].y;
        const ox = lx - cx;
        const oy = ly - cy;
        const d = Math.hypot(ox, oy) || 1e-6;
        const reach = LETTER_REACH + placements[i].height * fit * 0.35;
        if (d >= reach) continue;
        const fall = (1 - d / reach) ** 2;
        const mag = o.letterPush * fall * (o.hoverFloor + amount);
        const ux = ox / d + smoothVel.current.x * o.flingBias;
        const uy = oy / d + smoothVel.current.y * o.flingBias;
        const ul = Math.hypot(ux, uy) || 1;
        fx[i] = (ux / ul) * mag;
        fy[i] = (uy / ul) * mag;
        // Lean into the push (pushed right -> tilt clockwise), plus spin from off-center hits (r × F).
        torque[i] = (-fx[i] + ((cx - lx) * fy[i] - (cy - ly) * fx[i]) / reach) * o.spin;
      }
    }

    const maxRot = (MAX_ROTATION * Math.PI) / 180;
    const steps = 2;
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < n; i++) {
        const body = bs[i];
        const m = rest[i].mass;
        body.vx += (fx[i] / m - o.homePull * body.x - o.friction * body.vx) * h;
        body.vy += (fy[i] / m - o.homePull * body.y - o.friction * body.vy) * h;
        body.va += (torque[i] / m - ROT_STIFFNESS * body.a - ROT_DAMPING * body.va) * h;
        body.x += body.vx * h;
        body.y += body.vy * h;
        body.a += body.va * h;
        if (Math.abs(body.a) > maxRot) {
          body.a = Math.sign(body.a) * maxRot;
          body.va = 0;
        }
      }
      resolveContacts(b.atlas.shapes, bs, rest, 0, o.bounce, aspect);
    }

    // Melt spring from recovery time + jiggle: damping ratio ζ, settle time ≈ 4 / (ζω).
    const zeta = 1 - o.jiggle;
    const omega = 4 / (zeta * o.recoveryTime);
    const s = sim.material.uniforms;
    s.uA.value.set(p.prevX * aspect, p.prevY);
    s.uB.value.set(p.x * aspect, p.y);
    s.uVel.value.copy(smoothVel.current);
    s.uAspect.value = aspect;
    s.uRadius.value = BRUSH_RADIUS;
    s.uImpulse.value = o.meltGain * dt;
    s.uK.value = omega * omega;
    s.uC.value = 2 * zeta * omega;
    s.uDt.value = dt;
    s.uActive.value = active ? 1 : 0;
    p.prevX = p.x;
    p.prevY = p.y;

    // Ping-pong step: read -> sim -> write, then swap.
    const { read, write } = targets.current;
    s.uPrev.value = read.texture;
    gl.setRenderTarget(write);
    gl.render(sim.scene, sim.camera);
    gl.setRenderTarget(null);
    targets.current = { read: write, write: read };

    u.uFlow.value = write.texture;
    u.uStrength.value = o.meltStrength;
    u.uNoise.value = MELT_NOISE;
    u.uNoiseScale.value = MELT_NOISE_SCALE;
    u.uDrip.value = MELT_DRIP;
    u.uTime.value = time.current;
  });

  return (
    <mesh ref={meshRef} visible={false} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * Glossy, inflated balloon letters. Push them around with the cursor (or a
 * finger) and they melt and smear like warm wax.
 *
 * The component fills its parent: give the parent a height.
 */
export function BalloonType({
  text,
  fontFamily = DEFAULT_FONT_FAMILY,
  fontWeight = 400,
  background = DEFAULT_BACKGROUND,
  ink = DEFAULT_INK,
  seed = 1,
  arrangement = "fill",
  layout,
  onLayout,
  options,
  interactive = true,
  className,
  style,
}: BalloonTypeProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState(true);
  const pointer = useRef<PointerState>({ x: 0.5, y: 0.5, prevX: 0.5, prevY: 0.5, inside: false, fresh: true });
  const merged = { ...DEFAULT_OPTIONS, ...options };

  // Pause rendering while offscreen.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const updatePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = pointer.current;
    p.x = (e.clientX - r.left) / r.width;
    p.y = 1 - (e.clientY - r.top) / r.height;
    if (!p.inside) {
      p.inside = true;
      p.fresh = true;
    }
  };
  const release = () => {
    pointer.current.inside = false;
  };

  return (
    <div
      ref={wrapperRef}
      role="img"
      aria-label={text.trim() || undefined}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 200,
        background,
        overflow: "hidden",
        touchAction: interactive ? "none" : undefined, // finger drags push letters instead of scrolling
        ...style,
      }}
      onPointerDown={(e) => {
        pointer.current.inside = false; // force a fresh start on touch-down
        updatePointer(e);
      }}
      onPointerMove={updatePointer}
      onPointerUp={(e) => e.pointerType !== "mouse" && release()}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      <Canvas
        aria-hidden
        dpr={[1, DPR_CAP]}
        frameloop={!visible ? "never" : reduced || !interactive ? "demand" : "always"}
        gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
        style={{ position: "absolute", inset: 0 }}
      >
        <BalloonScene
          text={text}
          fontFamily={fontFamily}
          fontWeight={fontWeight}
          background={background}
          ink={ink}
          seed={seed}
          arrangement={arrangement}
          layout={layout}
          onLayout={onLayout}
          options={merged}
          interactive={interactive}
          reduced={reduced}
          pointer={pointer}
        />
      </Canvas>
    </div>
  );
}
