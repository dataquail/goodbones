import type { Plugin } from "vite";

import { makeHandler } from "./handler.js";
import { makeSource } from "./source.js";

// For working on the browsers themselves: `astro dev` in this package, with
// the routes mounted on Vite's own server over whichever repository
// `GOODBONES_REPO` names (this one, by default). The page then has Vite's
// hot reload for its own source and the feed for the repository's.
export type BrowserPluginOptions = {
  readonly repoRoot: string;
  readonly roots: ReadonlyArray<string>;
  readonly configFilename?: string | undefined;
};

export const goodbonesBrowser = (options: BrowserPluginOptions): Plugin => ({
  name: "goodbones-browser",
  configureServer(server) {
    const source = makeSource({ ...options, watch: true });
    const handle = makeHandler(source);
    server.middlewares.use((request, response, next) => {
      handle(request, response)
        .then((handled) => {
          if (!handled) next();
        })
        .catch(next);
    });
    server.httpServer?.once("close", () => {
      source.close();
    });
  },
});
