#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

import { collect } from "./server/collect.js";
import { exportSite } from "./server/export.js";
import { makeHandler } from "./server/handler.js";
import { serve } from "./server/serve.js";
import { SITE_DIR } from "./server/site.js";
import { makeSource } from "./server/source.js";

// goodbones-browser [serve] [<root>...] [--port N] [--host H] [--open] [--no-nudge]
// goodbones-browser build --out <dir> [<root>...] [--no-nudge]
//
// Run from the repository's root, as `architecture` is. `serve` (the
// default) opens the Architecture Browser and the Campaign Browser over the
// repository and redraws them as it changes; `build` writes the same page
// with the models as of now, for a static host.

const USAGE = [
  "goodbones-browser [serve] [<root>...] [--port <n>] [--host <h>] [--open] [--no-nudge]",
  "goodbones-browser build --out <dir> [<root>...] [--no-nudge]",
  "",
  "Roots default to `packages`, as the architecture CLI's do. ARCHITECTURE_CONFIG names",
  "the manifest when it is not architecture.yaml at the root.",
].join("\n");

type Args = {
  readonly command: "serve" | "build";
  readonly roots: ReadonlyArray<string>;
  readonly port: number;
  readonly host: string;
  readonly open: boolean;
  readonly out: string | null;
  readonly nudge: boolean;
};

const parse = (argv: ReadonlyArray<string>): Args => {
  let command: Args["command"] = "serve";
  const roots: Array<string> = [];
  let port = 4321;
  let host = "127.0.0.1";
  let open = false;
  let out: string | null = null;
  let nudge = true;
  const rest = [...argv];
  if (rest[0] === "serve" || rest[0] === "build") command = rest.shift() as Args["command"];
  while (rest.length > 0) {
    const argument = rest.shift() as string;
    switch (argument) {
      case "--port": {
        const value = Number(rest.shift());
        if (!Number.isInteger(value) || value < 0) throw new Error("--port needs a number");
        port = value;
        break;
      }
      case "--host":
        host = rest.shift() ?? host;
        break;
      case "--open":
        open = true;
        break;
      case "--out":
        out = rest.shift() ?? null;
        break;
      case "--no-nudge":
        nudge = false;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        if (argument.startsWith("--")) throw new Error(`unknown flag ${argument}\n\n${USAGE}`);
        roots.push(argument);
    }
  }
  if (command === "build" && out === null) throw new Error(`build needs --out <dir>\n\n${USAGE}`);
  return { command, roots: roots.length > 0 ? roots : ["packages"], port, host, open, out, nudge };
};

// Relative when it reads well, absolute when it would climb out of the repo.
const describePath = (repoRoot: string, target: string): string => {
  const relative = path.relative(repoRoot, target);
  if (relative === "") return ".";
  return relative.startsWith("..") ? target : relative;
};

const openBrowser = (url: string): void => {
  const [bin, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(bin, args, { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
};

const main = async (): Promise<void> => {
  const args = parse(process.argv.slice(2));
  const repoRoot = process.cwd();
  const configFilename = process.env.ARCHITECTURE_CONFIG;
  if (!existsSync(SITE_DIR)) {
    throw new Error(
      `the page is not built: ${SITE_DIR} is missing. In this repository, run \`pnpm exec nx build @goodbones/browser\`.`,
    );
  }

  if (args.command === "build") {
    const out = path.resolve(repoRoot, args.out ?? "");
    const collected = await collect({ repoRoot, roots: args.roots, configFilename, nudge: false });
    exportSite(SITE_DIR, out, collected);
    process.stdout.write(
      `wrote ${describePath(repoRoot, out)}: ${String(collected.atlas.files.length)} files, ${String(collected.campaigns.campaigns.length)} campaigns. Serve it from the root of a host.\n`,
    );
    return;
  }

  const source = makeSource({
    repoRoot,
    roots: args.roots,
    configFilename,
    nudge: args.nudge,
    watch: true,
  });
  const served = await serve({
    siteDir: SITE_DIR,
    handler: makeHandler(source),
    port: args.port,
    host: args.host,
  });
  process.stdout.write(
    `goodbones-browser: ${served.url} over ${path.basename(repoRoot)} (${args.roots.join(", ")}); watching for changes.\n`,
  );
  if (args.open) openBrowser(served.url);
  const stop = (): void => {
    source.close();
    void served.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

main().catch((cause: unknown) => {
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause);
  process.stderr.write(`\n${message}\n`);
  process.exitCode = 1;
});
