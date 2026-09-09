import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { Atlas } from "@goodbones/core";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ExploreRoutes,
  INLINE_ATLAS_ID,
  parseExploreFlags,
  respond,
  writeStandalone,
} from "./explore.js";

// The server's handling, driven with an atlas of its own and a bundle of two
// files, never a listening socket.

const ATLAS: Atlas = {
  version: 1,
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src"],
  layers: [],
  nodes: [],
  files: [],
  edges: [],
  designed: [],
  violations: [],
  cycles: [],
  unresolved: [],
};

let assets: string;
let routes: ExploreRoutes;

beforeAll(() => {
  assets = mkdtempSync(path.join(tmpdir(), "explore-assets-"));
  mkdirSync(path.join(assets, "assets"));
  writeFileSync(
    path.join(assets, "index.html"),
    "<!doctype html><html><head><title>x</title></head><body><div id=root></div></body></html>",
  );
  writeFileSync(path.join(assets, "assets", "index.js"), "console.log(1)");
  routes = {
    atlas: () => Promise.resolve(ATLAS),
    facts: (file) =>
      Promise.resolve(
        file === "src/a.ts" ? { file, edges: [], memberSites: [], exportSites: [] } : null,
      ),
    assetsDir: assets,
  };
});

afterAll(() => {
  rmSync(assets, { force: true, recursive: true });
});

describe("parseExploreFlags", () => {
  it("reads the port, --open, --out and the roots, with defaults", () => {
    expect(
      parseExploreFlags(["--port", "5000", "--open", "--out", "dist/atlas", "src", "lib/"]),
    ).toEqual(Result.succeed({ port: 5000, open: true, out: "dist/atlas", roots: ["src", "lib"] }));
    expect(parseExploreFlags([])).toEqual(
      Result.succeed({ port: 4141, open: false, out: null, roots: ["packages"] }),
    );
  });

  it("refuses a port that is not one, and a flag it does not know", () => {
    expect(Result.isFailure(parseExploreFlags(["--port", "many"]))).toBe(true);
    expect(Result.isFailure(parseExploreFlags(["--port", "70000"]))).toBe(true);
    expect(Result.isFailure(parseExploreFlags(["--watch"]))).toBe(true);
  });
});

describe("respond", () => {
  it("serves the bundle, the page for any path it does not have, and never leaves the folder", async () => {
    const page = await respond(routes, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(String(page.body)).toContain("<div id=root>");

    const script = await respond(routes, "/assets/index.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");

    const deep = await respond(routes, "/anything/else?x=1#focus=src");
    expect(deep.status).toBe(200);
    expect(String(deep.body)).toContain("<div id=root>");

    // A path that climbs out is normalised to one inside, which is the page.
    const escape = await respond(routes, "/../../etc/passwd");
    expect(escape.headers["content-type"]).toContain("text/html");
    expect(String(escape.body)).not.toContain("root:");
  });

  it("rebuilds the atlas for every request, uncached", async () => {
    let built = 0;
    const counting: ExploreRoutes = {
      ...routes,
      atlas: () => {
        built += 1;
        return Promise.resolve(ATLAS);
      },
    };
    const first = await respond(counting, "/atlas.json");
    const second = await respond(counting, "/atlas.json");
    expect(built).toBe(2);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(String(second.body))).toEqual(ATLAS);
  });

  it("reports a scan that fails as a 500 with the reason, not a crash", async () => {
    const failing: ExploreRoutes = {
      ...routes,
      atlas: () => Promise.reject(new Error("the manifest does not load")),
    };
    const answer = await respond(failing, "/atlas.json");
    expect(answer.status).toBe(500);
    expect(String(answer.body)).toContain("the manifest does not load");
  });

  it("answers a file's facts, and 404 for a file the walk does not have", async () => {
    const found = await respond(routes, "/facts?file=src%2Fa.ts");
    expect(found.status).toBe(200);
    expect(JSON.parse(String(found.body))).toMatchObject({ file: "src/a.ts" });
    expect((await respond(routes, "/facts?file=src%2Fnope.ts")).status).toBe(404);
    expect((await respond(routes, "/facts")).status).toBe(400);
  });
});

describe("writeStandalone", () => {
  it("copies the bundle and inlines the atlas into the page, escaped", () => {
    const into = mkdtempSync(path.join(tmpdir(), "explore-out-"));
    const tricky: Atlas = {
      ...ATLAS,
      manifest: { path: "</script><script>alert(1)</script>", sha256: "<!--" },
    };
    writeStandalone(assets, tricky, into);
    const page = readFileSync(path.join(into, "index.html"), "utf8");
    expect(page).toContain(`<script id="${INLINE_ATLAS_ID}" type="application/json">`);
    expect(page).not.toContain("</script><script>alert");
    expect(page).toContain("\\u003C/script>");
    expect(readFileSync(path.join(into, "assets", "index.js"), "utf8")).toBe("console.log(1)");
    // What the page reads back is the atlas that was written.
    const inlined = /type="application\/json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
    expect(JSON.parse(inlined)).toEqual(tricky);
    rmSync(into, { force: true, recursive: true });
  });
});
