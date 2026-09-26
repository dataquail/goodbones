import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Where `astro build` put the page: `build/site`, beside this module's
// `build/esm`. The bin serves it; a static export copies it.
export const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site");
