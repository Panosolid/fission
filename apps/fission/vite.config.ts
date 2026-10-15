import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the built site works from any URL, including GitHub Pages.
  base: "./",
  // The kernel worker imports the wasm-bindgen ES module.
  worker: { format: "es" },
});
