import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Collected } from "./collect.js";
import { makeHandler } from "./handler.js";
import { serve, type Served } from "./serve.js";
import { makeSource } from "./source.js";

// The routes, driven over a socket: the models as JSON, the status, a 404
// for a route that is not there, the feed announcing itself and then each
// change, a computation that fails answering 500 once and trying again.

const collected = (stamp: string): Collected =>
  ({
    atlas: { version: 1, name: "repo", generatedAt: stamp, files: [], edges: [] },
    campaigns: { version: 1, name: "repo", generatedAt: stamp, ledgerDir: ".l", campaigns: [] },
  }) as unknown as Collected;

let computed = 0;
let failNext = false;
const source = makeSource({
  repoRoot: "/nowhere",
  roots: ["svc"],
  compute: () => {
    computed += 1;
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("the manifest does not decode"));
    }
    return Promise.resolve(collected(`stamp-${String(computed)}`));
  },
});

let server: Server;
let base: string;

beforeAll(async () => {
  const handler = makeHandler(source);
  server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 418;
        response.end("not mine");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  source.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe.sequential("the handler", () => {
  it("serves both models and the status, computing once", async () => {
    const atlas = await (await fetch(`${base}/__goodbones/atlas.json`)).json();
    const campaigns = await (await fetch(`${base}/__goodbones/campaigns.json`)).json();
    const status = await (await fetch(`${base}/__goodbones/status.json`)).json();
    expect(atlas).toMatchObject({ name: "repo", generatedAt: "stamp-1" });
    expect(campaigns).toMatchObject({ ledgerDir: ".l" });
    expect(status).toEqual({ name: "repo", generatedAt: "stamp-1", live: false });
    expect(computed).toBe(1);
  });

  it("leaves other paths to whoever is next, and names a route it does not have", async () => {
    expect((await fetch(`${base}/index.html`)).status).toBe(418);
    const missing = await fetch(`${base}/__goodbones/nope.json`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no such route: /__goodbones/nope.json" });
  });

  it("recomputes after an invalidation, and the feed says so", async () => {
    const events = await fetch(`${base}/__goodbones/events`);
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const body = events.body as ReadableStream<Uint8Array> | null;
    if (body === null) throw new Error("no body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const read = async (): Promise<string> => {
      const chunk: Uint8Array | undefined = (await reader.read()).value;
      return chunk === undefined ? "" : decoder.decode(chunk);
    };
    expect(await read()).toBe('event: hello\ndata: {"live":false}\n\n');

    source.invalidate(["svc/main.go"]);
    const changed = await read();
    expect(changed.startsWith("event: changed\ndata: ")).toBe(true);
    expect(JSON.parse(changed.slice("event: changed\ndata: ".length))).toMatchObject({
      files: ["svc/main.go"],
    });
    await reader.cancel();

    const atlas = await (await fetch(`${base}/__goodbones/atlas.json`)).json();
    expect(atlas).toMatchObject({ generatedAt: "stamp-2" });
  });

  it("answers 500 with the failure once, then tries again", async () => {
    source.invalidate([]);
    failNext = true;
    const failed = await fetch(`${base}/__goodbones/atlas.json`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "the manifest does not decode" });
    const again = await fetch(`${base}/__goodbones/atlas.json`);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ generatedAt: "stamp-4" });
  });
});

describe("serve", () => {
  let site: string;
  let served: Served;
  beforeAll(async () => {
    site = mkdtempSync(path.join(tmpdir(), "goodbones-site-"));
    writeFileSync(path.join(site, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(path.join(site, "app.js"), "export const x = 1;");
    served = await serve({
      siteDir: site,
      handler: makeHandler(source),
      port: 0,
      host: "127.0.0.1",
    });
  });
  afterAll(async () => {
    await served.close();
    rmSync(site, { force: true, recursive: true });
  });

  it("serves the page, its assets by type, the routes, and a 404 for the rest", async () => {
    const page = await fetch(served.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("<title>t</title>");
    const script = await fetch(`${served.url}app.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await fetch(`${served.url}__goodbones/status.json`)).status).toBe(200);
    expect((await fetch(`${served.url}missing.css`)).status).toBe(404);
    expect((await fetch(`${served.url}..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });
});
