export const fullscreenVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Flowmap simulation pass.
// Each texel holds a displacement (RG) and its velocity (BA), in normalized
// units. Every frame:
//   - the cursor adds velocity along the segment it travelled this frame
//   - a damped spring pulls displacement back to zero (the ooze + jiggle)
// The result is written to the other render target (ping-pong, see LiquidType).
export const simFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPrev;
  uniform vec2 uA;          // segment start (aspect-corrected: x * aspect, y)
  uniform vec2 uB;          // segment end
  uniform vec2 uVel;        // normalized cursor velocity, length 0..1
  uniform float uAspect;
  uniform float uRadius;
  uniform float uImpulse;   // gain * dt
  uniform float uK;         // spring stiffness
  uniform float uC;         // spring damping
  uniform float uDt;
  uniform float uActive;
  varying vec2 vUv;

  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return length(pa - ba * h);
  }

  void main() {
    vec4 s = texture2D(uPrev, vUv);
    vec2 disp = s.xy;
    vec2 vel = s.zw;

    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    float fall = 1.0 - smoothstep(0.0, uRadius, segDist(p, uA, uB));
    fall *= fall * uActive;

    vel += uVel * fall * uImpulse;
    vel += (-uK * disp - uC * vel) * uDt;   // semi-implicit Euler
    disp += vel * uDt;

    float len = length(disp);
    if (len > 1.2) disp *= 1.2 / len;

    gl_FragColor = vec4(disp, vel);
  }
`;

// 2D simplex noise by Ian McEwan, Ashima Arts (MIT License).
// https://github.com/ashima/webgl-noise
const simplex2d = /* glsl */ `
  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

/**
 * Display pass, compiled per letter count. Works in "screen units": y spans
 * -0.5..0.5, x is aspect-scaled.
 */
export const makeDisplayFrag = (count: number, cols: number, rows: number) => /* glsl */ `
  precision highp float;
  #define N ${count}
  #define ATLAS_COLS ${cols}.0
  #define ATLAS_ROWS ${rows}.0

  uniform sampler2D uSdf;
  uniform sampler2D uFlow;
  uniform vec4 uLetters[N];   // center.xy, angle (rad, ccw), tile size
  uniform vec2 uAtlasSize;    // atlas size in texels
  uniform float uTexel;       // edge inset in tile uv, keeps cubic taps inside the tile
  uniform float uAspect;
  uniform float uPx;          // one device pixel, in screen units
  uniform float uPuff;
  uniform float uGloss;
  uniform float uRim;
  uniform float uGap;
  uniform float uShadow;
  uniform float uStrength;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uDrip;
  uniform float uTime;
  uniform float uEnabled;
  uniform vec3 uBg;
  uniform vec3 uInk;
  varying vec2 vUv;

  ${simplex2d}

  // Cubic B-spline SDF lookup from 4 bilinear taps. Bilinear alone has a
  // gradient that jumps at texel borders, which shows up as streaks in the gloss.
  float sampleCubic(vec2 uv) {
    vec2 st = uv * uAtlasSize - 0.5;
    vec2 i = floor(st);
    vec2 f = st - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 h0 = (i - 0.5 + w1 / g0) / uAtlasSize;
    vec2 h1 = (i + 1.5 + w3 / g1) / uAtlasSize;
    return g0.y * (g0.x * texture2D(uSdf, h0).r + g1.x * texture2D(uSdf, vec2(h1.x, h0.y)).r)
         + g1.y * (g0.x * texture2D(uSdf, vec2(h0.x, h1.y)).r + g1.x * texture2D(uSdf, h1).r);
  }

  // Signed distance to one letter (negative inside), in screen units.
  float letterDist(vec4 L, float idx, vec2 p, bool cubic) {
    vec2 q = p - L.xy;
    float c = cos(L.z), s = sin(L.z);
    q = vec2(c * q.x + s * q.y, -s * q.x + c * q.y) / L.w + 0.5;
    vec2 cq = clamp(q, uTexel, 1.0 - uTexel);
    vec2 tile = vec2(mod(idx, ATLAS_COLS), floor(idx / ATLAS_COLS));
    vec2 uv = (tile + cq) / vec2(ATLAS_COLS, ATLAS_ROWS);
    float d = cubic ? sampleCubic(uv) : texture2D(uSdf, uv).r;
    return (d + length(q - cq)) * L.w;
  }

  // Where this pixel samples the letters from, after the melt.
  vec2 warp(vec2 p) {
    vec2 disp = texture2D(uFlow, vec2(p.x / uAspect + 0.5, p.y + 0.5)).xy * uEnabled;
    float m = length(disp);
    if (m < 1e-4) return p;
    vec2 np = p * uNoiseScale;
    vec2 n = vec2(snoise(np + vec2(0.0, uTime * 0.2)), snoise(np + vec2(31.7, -uTime * 0.2)));
    return p - disp * uStrength - n * uNoise * sqrt(m) + vec2(0.0, uDrip * m);
  }

  float smax(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
    return mix(b, a, h) + k * h * (1.0 - h);
  }

  // Combined field. Each pixel belongs to its nearest letter, clipped by the
  // bisector with the runner-up minus half the gap. Neighbours pushed together
  // by the melt flatten against each other instead of merging.
  float field(vec2 p) {
    vec2 w = warp(p);
    float d1 = 1e5, d2 = 1e5;
    vec4 best = uLetters[0];
    float bestIdx = 0.0;
    for (int i = 0; i < N; i++) {
      float d = letterDist(uLetters[i], float(i), w, false);
      if (d < d1) { d2 = d1; d1 = d; best = uLetters[i]; bestIdx = float(i); }
      else if (d < d2) { d2 = d; }
    }
    // Only the owning letter needs the smooth (cubic) lookup; it drives the normals.
    d1 = letterDist(best, bestIdx, w, true);
    return smax(d1, 0.5 * (d1 - d2 + uGap), max(uGap * 0.5, 1e-5));
  }

  // Distance inside -> dome height. Infinitely steep at the silhouette (the
  // balloon edge), easing smoothly to a rounded top toward the stroke middle.
  float height(float d) {
    float x = max(-d, 0.0) / uPuff;
    return uPuff * sqrt(1.0 - exp(-2.5 * x));
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
    float d = field(p);

    vec3 bg = uBg * (1.0 - uShadow * exp(-max(d, 0.0) / (uPuff * 0.6)));
    float alpha = clamp(0.5 - d / uPx, 0.0, 1.0);
    if (alpha <= 0.0) {
      gl_FragColor = vec4(bg, 1.0);
      return;
    }

    // Normal from the height map via finite differences on the warped field,
    // so the gloss follows the melted surface.
    float e = uPx * 2.5;
    float h = height(d);
    float hx = height(field(p + vec2(e, 0.0)));
    float hy = height(field(p + vec2(0.0, e)));
    vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.0));

    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 L1 = normalize(vec3(-0.5, 0.6, 0.62));   // key light, top-left
    vec3 L2 = normalize(vec3(0.45, -0.55, 0.7));  // soft fill, bottom-right

    float s1 = pow(max(dot(n, normalize(L1 + V)), 0.0), uGloss);
    s1 = smoothstep(0.3, 0.7, s1);                // crisp-edged highlight
    float s2 = pow(max(dot(n, normalize(L2 + V)), 0.0), uGloss * 0.5);
    s2 = smoothstep(0.45, 0.85, s2) * 0.3;        // softer, dimmer second highlight
    float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.5);
    vec3 R = reflect(-V, n);
    float sky = smoothstep(-0.4, 1.0, R.y) * 0.06;

    vec3 col = uInk + uBg * fres * uRim + sky * (1.0 - n.z) + vec3(s1 * 0.95 + s2);
    gl_FragColor = vec4(mix(bg, col, alpha), 1.0);
  }
`;
