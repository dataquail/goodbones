import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { importOptional } from "./import-optional.js";

// Each test gets a directory holding a module that imports a bare specifier,
// with whatever `node_modules/` it writes beside it — so the import is
// resolved by Node from that module's location, as a host's import of its
// peer is. The tests run concurrently, so no directory is shared.
const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fixture = (): {
  readonly writePackage: (name: string, source: string) => void;
  readonly writeGlue: (peer: string) => string;
} => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "import-optional-")));
  roots.push(root);
  return {
    writePackage: (name, source) => {
      writePackage(root, name, source);
    },
    writeGlue: (peer) => writeGlue(root, peer),
  };
};

const writePackage = (root: string, name: string, source: string): void => {
  const dir = path.join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./index.js" }),
  );
  writeFileSync(path.join(dir, "index.js"), source);
};

// The host's glue: a module of its own that imports the peer.
const writeGlue = (root: string, peer: string): string => {
  const file = path.join(root, "glue.js");
  writeFileSync(file, `export { answer } from "${peer}";\n`);
  return pathToFileURL(file).href;
};

const loadGlue = (url: string) => (): Promise<{ readonly answer: number }> =>
  import(/* @vite-ignore */ url) as Promise<{ readonly answer: number }>;

describe("importOptional", () => {
  it("answers the module when the peer is installed", async () => {
    const { writeGlue, writePackage } = fixture();
    writePackage("@scope/peer", "export const answer = 42;\n");
    const loaded = await importOptional(loadGlue(writeGlue("@scope/peer")), "@scope/peer");
    expect(loaded?.answer).toBe(42);
  });

  it("answers null when the peer is not installed", async () => {
    const { writeGlue } = fixture();
    const loaded = await importOptional(loadGlue(writeGlue("@scope/absent")), "@scope/absent");
    expect(loaded).toBeNull();
  });

  it("rethrows when the peer is installed but something it imports is missing", async () => {
    const { writeGlue, writePackage } = fixture();
    writePackage("@scope/broken", 'export { answer } from "@scope/inner";\n');
    await expect(
      importOptional(loadGlue(writeGlue("@scope/broken")), "@scope/broken"),
    ).rejects.toThrow(/@scope\/inner/);
  });

  it("rethrows a failure that is not a missing module", async () => {
    const { writeGlue, writePackage } = fixture();
    writePackage("@scope/throws", 'throw new Error("boom");\n');
    await expect(
      importOptional(loadGlue(writeGlue("@scope/throws")), "@scope/throws"),
    ).rejects.toThrow("boom");
  });
});
