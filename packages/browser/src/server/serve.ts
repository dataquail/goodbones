import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { type Handler } from "./handler.js";

// The bin's server: the prebuilt page from `build/site`, and the handler's
// routes in front of it. No framework — the page is static files and the
// data is four routes.

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export type ServeOptions = {
  readonly siteDir: string;
  readonly handler: Handler;
  readonly port: number;
  readonly host: string;
};

export type Served = {
  readonly server: Server;
  readonly url: string;
  readonly close: () => Promise<void>;
};

// A path inside the site directory, or nothing for one that escapes it.
const fileFor = (siteDir: string, pathname: string): string | null => {
  const decoded = decodeURIComponent(pathname);
  const wanted = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  const resolved = path.resolve(siteDir, `.${wanted}`);
  if (!resolved.startsWith(siteDir)) return null;
  if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  // `/architecture` for `architecture.html`, as the build's `format: file`
  // emits pages.
  const asPage = `${resolved}.html`;
  if (existsSync(asPage) && statSync(asPage).isFile()) return asPage;
  return null;
};

export const serve = (options: ServeOptions): Promise<Served> =>
  new Promise((resolve, reject) => {
    const siteDir = path.resolve(options.siteDir);
    const server = createServer((request, response) => {
      options
        .handler(request, response)
        .then((handled) => {
          if (handled) return;
          const url = new URL(request.url ?? "/", "http://localhost");
          const file = fileFor(siteDir, url.pathname);
          if (file === null) {
            response.statusCode = 404;
            response.setHeader("content-type", "text/plain; charset=utf-8");
            response.end("not found");
            return;
          }
          response.statusCode = 200;
          response.setHeader(
            "content-type",
            TYPES[path.extname(file)] ?? "application/octet-stream",
          );
          response.setHeader("cache-control", "no-cache");
          createReadStream(file).pipe(response);
        })
        .catch((cause: unknown) => {
          response.statusCode = 500;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(String(cause));
        });
    });
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address() as AddressInfo;
      const host = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
      resolve({
        server,
        url: `http://${host}:${String(address.port)}/`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
