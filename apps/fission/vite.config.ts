import { defineConfig } from "vite";
import { licencesPlugin } from "./licences.mjs";

export default defineConfig({
  // Relative paths so the built site works from any URL, including GitHub Pages.
  base: "./",
  // The kernel worker imports the wasm-bindgen ES module.
  worker: { format: "es", plugins: () => [licencesPlugin({ emit: false })] },
  // third-party-licences.txt beside the app, checked against what is bundled (audit L2).
  plugins: [licencesPlugin({ emit: true })],
});
