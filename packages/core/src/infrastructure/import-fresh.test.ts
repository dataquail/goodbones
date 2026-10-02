import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { importFresh } from "./import-fresh.js";

// The module loader keeps a module for the life of the process. A host that
// lives long has to see the file as it is now.

const scratch = mkdtempSync(path.join(tmpdir(), "goodbones-import-fresh-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

describe("importFresh", () => {
  it("reads an edited module again, and an unchanged one from the loader", async () => {
    const file = path.join(scratch, "measure.mjs");
    writeFileSync(file, "export const lines = () => 400;\n");
    const first = (await importFresh(file)) as { lines: () => number };
    expect(first.lines()).toBe(400);
    // Unchanged on disk: the same module, not a second evaluation.
    expect(await importFresh(file)).toBe(first);

    writeFileSync(file, "export const lines = () => 62700;\n");
    const second = (await importFresh(file)) as { lines: () => number };
    expect(second.lines()).toBe(62700);
    expect(second).not.toBe(first);
  });

  it("fails on a file that is not there, as an import does", async () => {
    await expect(importFresh(path.join(scratch, "absent.mjs"))).rejects.toThrow();
  });
});
