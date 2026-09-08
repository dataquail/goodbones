import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The viewer, built to static assets under `build/app`. The CLI serves that
// folder and inlines an atlas into its `index.html` for `--out`; the paths are
// relative so it works from any prefix and from a file.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "build/app",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
