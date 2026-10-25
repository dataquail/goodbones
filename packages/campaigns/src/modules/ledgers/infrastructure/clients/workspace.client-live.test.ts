import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { makeWorkspaceClientLive } from "./workspace.client-live.js";

const scratch = (files: Readonly<Record<string, string>>): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-workspace-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }

  return root;
};

const TS = [{ extensions: [".ts"], ignoredFiles: [] }];

describe("makeWorkspaceClientLive", () => {
  it("walks the source files under the roots, with the extensions widened", () => {
    const root = scratch({ "src/a.ts": "", "src/b.js": "", "src/c.md": "", "other/d.ts": "" });
    const client = makeWorkspaceClientLive();

    expect(client.sourceFiles(root, ["src"], TS, [])).toEqual(["src/a.ts"]);
    expect([...client.sourceFiles(root, ["src"], TS, [".js"])].sort()).toEqual([
      "src/a.ts",
      "src/b.js",
    ]);
  });

  it("lists the projects by their project.json", () => {
    const root = scratch({ "libs/one/project.json": JSON.stringify({ name: "one" }) });

    expect(makeWorkspaceClientLive().projects(root, ["libs"])).toEqual([
      { name: "one", root: "libs/one" },
    ]);
  });
});
