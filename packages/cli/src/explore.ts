import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import type { Atlas } from "@goodbones/core";
import * as Result from "effect/Result";

// `architecture explore`: the viewer, served locally over the atlas of this
// repository — or written out as one folder with the atlas inlined, for a CI
// artifact or a docs page to host. This module holds the flags and the
// request handling as functions of their inputs, so a test can drive them
// with an atlas of its own and no socket; `run` opens the port.

export const EXPLORE_USAGE = "explore [--port N] [--open] [--out <dir>] [roots...]";

export type ExploreFlags = {
  readonly port: number;
  readonly open: boolean;
  // Write the bundle with the atlas inlined here instead of serving.
  readonly out: string | null;
  readonly roots: ReadonlyArray<string>;
};

export const parseExploreFlags = (
  argv: ReadonlyArray<string>,
): Result.Result<ExploreFlags, string> => {
  let port = 4141;
  let open = false;
  let out: string | null = null;
  const roots: Array<string> = [];

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) break;
    const value = (): Result.Result<string, string> => {
      const next = args.shift();
      return next === undefined || next.startsWith("--")
        ? Result.fail(`${arg} needs a value`)
        : Result.succeed(next);
    };
    switch (arg) {
      case "--port": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        const parsed = Number(given.success);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return Result.fail(`--port takes a port number, not "${given.success}"`);
        }
        port = parsed;
        break;
      }
      case "--out": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        out = given.success;
        break;
      }
      case "--open":
        open = true;
        break;
      default:
        if (arg.startsWith("--")) {
          return Result.fail(`unknown flag ${arg}. Usage: ${EXPLORE_USAGE}`);
        }
        roots.push(arg.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/+$/, ""));
    }
  }
  return Result.succeed({ port, open, out, roots: roots.length > 0 ? roots : ["packages"] });
};

// What the server answers from: a fresh atlas per request, the facts of one
// file, and the folder the bundle sits in.
export type ExploreRoutes = {
  readonly atlas: () => Promise<Atlas>;
  // The facts of a walked file as `facts --json` prints them, or null for a
  // file that is not one.
  readonly facts: (file: string) => Promise<unknown | null>;
  readonly assetsDir: string;
};

export type ExploreResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
};

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

const json = (status: number, value: unknown): ExploreResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(value),
});

const text = (status: number, body: string): ExploreResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});

// The three routes: the bundle, the atlas, a file's facts. Anything the
// bundle does not have is the page, so a deep link with a hash still lands.
export const respond = async (routes: ExploreRoutes, url: string): Promise<ExploreResponse> => {
  const parsed = new URL(url, "http://explore.local");
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname === "/atlas.json") {
    try {
      return json(200, await routes.atlas());
    } catch (cause) {
      return json(500, { error: String(cause) });
    }
  }
  if (pathname === "/facts") {
    const file = parsed.searchParams.get("file");
    if (file === null) return json(400, { error: "facts needs ?file=<path>" });
    try {
      const facts = await routes.facts(file);
      return facts === null
        ? json(404, { error: `${file} is not a walked file` })
        : json(200, facts);
    } catch (cause) {
      return json(500, { error: String(cause) });
    }
  }

  // A static file of the bundle, kept inside the folder.
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const at = path.resolve(routes.assetsDir, relative);
  if (!at.startsWith(path.resolve(routes.assetsDir) + path.sep)) {
    return text(403, "forbidden");
  }
  const file = existsAsFile(at) ? at : path.join(routes.assetsDir, "index.html");
  if (!existsAsFile(file)) {
    return text(
      500,
      "the viewer's bundle is not built: @goodbones/explorer has no build/app/index.html",
    );
  }
  return {
    status: 200,
    headers: {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    },
    body: readFileSync(file),
  };
};

const existsAsFile = (at: string): boolean => {
  try {
    return statSync(at).isFile();
  } catch {
    return false;
  }
};

// Where `explore --out` puts the atlas so the page reads it without a server.
export const INLINE_ATLAS_ID = "goodbones-atlas";

// `</script>` inside a JSON string would end the element early; the `<` is
// written as a unicode escape, which JSON parses back unchanged and HTML
// never sees as a tag.
const inlineJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("</", "\\u003C/").replaceAll("<!--", "\\u003C!--");

// The bundle copied to `into`, with the atlas inlined into `index.html`: one
// folder a static host serves, or a file:// URL opens.
export const writeStandalone = (assetsDir: string, atlas: Atlas, into: string): void => {
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const source = path.join(from, entry);
      const target = path.join(to, entry);
      if (statSync(source).isDirectory()) copy(source, target);
      else if (entry !== "index.html") copyFileSync(source, target);
    }
  };
  copy(assetsDir, into);
  const page = readFileSync(path.join(assetsDir, "index.html"), "utf8");
  const script = `<script id="${INLINE_ATLAS_ID}" type="application/json">${inlineJson(atlas)}</script>`;
  const inlined = page.includes("</head>")
    ? page.replace("</head>", `${script}\n</head>`)
    : `${script}\n${page}`;
  writeFileSync(path.join(into, "index.html"), inlined);
};
