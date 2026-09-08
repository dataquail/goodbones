import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The one thing this package exports to Node: where the bundle Vite built is.
// The CLI's `explore` serves that folder, and copies it for `--out`. Nothing
// else here runs outside a browser, and nothing here imports the viewer.
export const assetsDir = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");
