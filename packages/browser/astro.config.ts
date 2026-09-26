import * as path from "node:path";

import react from "@astrojs/react";
import { defineConfig } from "astro/config";

import { goodbonesBrowser } from "./src/server/vite-plugin.js";

// The page: one Astro route with two React islands, built to `build/site`
// as flat files (`index.html`) so the bin and a static host serve the same
// thing. In `astro dev` the routes are mounted on Vite's server over the
// repository `GOODBONES_REPO` names — this one by default — so the page can
// be worked on against real data with hot reload.

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(process.env.GOODBONES_REPO ?? path.join(here, "../.."));
const roots = (process.env.GOODBONES_ROOTS ?? "packages").split(",").filter((one) => one !== "");

export default defineConfig({
  srcDir: "./src/app",
  publicDir: "./src/app/public",
  outDir: "./build/site",
  output: "static",
  build: { format: "file" },
  integrations: [react()],
  vite: {
    plugins: [
      goodbonesBrowser({ repoRoot, roots, configFilename: process.env.ARCHITECTURE_CONFIG }),
    ],
  },
});
