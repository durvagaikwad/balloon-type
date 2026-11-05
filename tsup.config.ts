import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  external: ["react", "react-dom", "three", "@react-three/fiber"],
  // Next.js App Router: the component uses hooks and WebGL, so it's client-only.
  banner: { js: '"use client";' },
});
