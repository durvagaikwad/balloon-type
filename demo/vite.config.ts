import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: { "balloon-type": fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
