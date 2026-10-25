import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { makeBaseSidesClientLive } from "./base-sides.client-live.js";

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-base-sides-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const side = [{ id: "tidy", sectors: { a: { x: 1 } }, hits: [] }];

describe("makeBaseSidesClientLive", () => {
  it("keeps a side by commit under node_modules/.cache/goodbones/", () => {
    const root = scratch();
    mkdirSync(path.join(root, "node_modules"));
    const client = makeBaseSidesClientLive(root);

    expect(client.read("abc")).toBeNull();
    client.write("abc", side);

    expect(client.read("abc")).toEqual(side);
    expect(existsSync(path.join(root, "node_modules/.cache/goodbones/base-abc.json"))).toBe(true);
  });

  it("keeps nothing in a repository with no node_modules", () => {
    const root = scratch();
    const client = makeBaseSidesClientLive(root);
    client.write("abc", side);

    expect(client.read("abc")).toBeNull();
  });

  it("reads an unreadable cache as none", () => {
    const root = scratch();
    mkdirSync(path.join(root, "node_modules/.cache/goodbones"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/.cache/goodbones/base-abc.json"), "{ not json");

    expect(makeBaseSidesClientLive(root).read("abc")).toBeNull();
  });
});
