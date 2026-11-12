import * as NodePath from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const webRoot = NodePath.resolve(import.meta.dirname, "..");

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: {
    alias: { "~": NodePath.join(webRoot, "src") },
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
