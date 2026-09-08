import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  type Coverage,
  coverageOf,
  coverageShortfalls,
  fractionsOf,
  residueOf,
  vacancyOf,
} from "./coverage.js";
import { compileGraphRules } from "./graph.js";
import { compileImportRules } from "./imports.js";
import { compileMemberRules } from "./members.js";
import { compileStructure } from "./structure.js";
import { compileSurfaceRules } from "./surface.js";

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const probe = { from: "src/core/zz.ts", to: "src/x.ts" };

const policy = {
  importRules: unwrap(
    compileImportRules([
      // An allowlist: no `to`, a `toNot`.
      { name: "core/imports", message: "…", probe, from: "^src/core/", toNot: ["^src/core/"] },
      // A prohibition: names a `to`. Bounds nothing on its own.
      { name: "deny", message: "…", probe, from: "^src/", to: "^src/secret/" },
    ]),
  ),
  structure: unwrap(
    compileStructure({
      folders: [
        {
          name: "core/layout",
          message: "…",
          probe: { path: "src/core/zz.ts" },
          folder: "^src/core$",
          files: "\\.ts$",
        },
        {
          name: "lib/layout",
          message: "…",
          probe: { path: "src/lib/zz.ts" },
          folder: "^src/lib$",
          files: "^.*$",
        },
      ],
    }),
  ),
  memberRules: unwrap(
    compileMemberRules([
      {
        name: "m",
        message: "…",
        probe: { from: "src/core/zz.ts", name: "x" },
        from: "^src/core/",
        subject: "calls",
      },
    ]),
  ),
  surfaceRules: unwrap(
    compileSurfaceRules([
      {
        name: "s",
        message: "…",
        probe: { from: "src/lib/zz.ts", sites: [{ name: "x", kind: "named" }] },
        from: "^src/lib/",
      },
    ]),
  ),
  graph: unwrap(
    compileGraphRules({
      cycles: [
        {
          name: "c",
          message: "…",
          probe: {
            edges: [
              ["src/core/a.ts", "src/core/b.ts"],
              ["src/core/b.ts", "src/core/a.ts"],
            ],
          },
          within: "^src/core/",
        },
      ],
    }),
  ),
};

const FILES = ["src/core/a.ts", "src/core/b.ts", "src/lib/c.ts", "src/other/d.ts"];

describe("coverageOf", () => {
  const found = coverageOf(policy, FILES);

  it("counts a file under an import allowlist, and not one under a prohibition alone", () => {
    expect(found.imports).toEqual({ covered: 2, total: 4 });
  });

  it("tells an enumerated folder from an open one from none", () => {
    expect(found.structure).toEqual({ enumerated: 2, open: 1, total: 4 });
  });

  it("counts the files each per-file family selects", () => {
    expect(found.members).toEqual({ covered: 2, total: 4 });
    expect(found.surface).toEqual({ covered: 1, total: 4 });
  });

  it("counts the files in a graph scope", () => {
    expect(found.graph).toEqual({ covered: 2, total: 4 });
  });

  it("reads an empty tree as fully covered, so a floor does not fail on nothing", () => {
    expect(fractionsOf(coverageOf(policy, [])).imports).toBe(1);
  });
});

describe("coverageShortfalls", () => {
  const found: Coverage = coverageOf(policy, FILES);

  it("reports each family under its floor, with the actual fraction", () => {
    expect(coverageShortfalls(found, { imports: 0.75, members: 0.5, surface: 0.5 })).toEqual([
      { family: "imports", actual: 0.5, floor: 0.75 },
      { family: "surface", actual: 0.25, floor: 0.5 },
    ]);
  });

  it("counts structure by enumerated folders only", () => {
    expect(coverageShortfalls(found, { structure: 0.75 })).toEqual([
      { family: "structure", actual: 0.5, floor: 0.75 },
    ]);
  });

  it("is quiet when no floor is stated", () => {
    expect(coverageShortfalls(found, {})).toEqual([]);
  });
});

describe("residueOf", () => {
  it("names the files no family reaches, and the folders made only of them", () => {
    // src/other/d.ts: under a prohibition alone, in a folder no rule governs,
    // selected by nothing, in no graph scope.
    expect(residueOf(policy, FILES)).toEqual({ files: ["src/other/d.ts"], folders: ["src/other"] });
  });

  it("counts a file in an open folder as residue when nothing else reaches it", () => {
    // src/lib/c.ts is in an open folder and selected by a surface rule; take
    // the rule away and the folder is claimed but not policed.
    const without = { ...policy, surfaceRules: [] };
    expect(residueOf(without, FILES).files).toEqual(["src/lib/c.ts", "src/other/d.ts"]);
  });

  it("reports the topmost folder wholly unreached, once", () => {
    const deep = [...FILES, "src/other/deep/e.ts", "src/other/deep/er/f.ts"];
    expect(residueOf(policy, deep).folders).toEqual(["src/other"]);
  });

  it("does not name a folder some file of which is reached", () => {
    const mixed = [...FILES, "src/other/core-ish.ts"];
    const reachesIt = {
      ...policy,
      memberRules: unwrap(
        compileMemberRules([
          {
            name: "m2",
            message: "…",
            probe: { from: "src/other/core-ish.ts", name: "x" },
            from: "^src/other/core-ish",
            subject: "calls",
          },
        ]),
      ),
    };
    expect(residueOf(reachesIt, mixed)).toEqual({ files: ["src/other/d.ts"], folders: [] });
  });

  it("is empty over an empty tree", () => {
    expect(residueOf(policy, [])).toEqual({ files: [], folders: [] });
  });
});

describe("vacancyOf", () => {
  const allowance = (node: string, entry: string) => ({
    node,
    kind: "allow" as const,
    entry,
    pattern: `^${entry.replace("/**", "(/.*)?$")}`,
  });
  // `src` allows `src/**`; `src/core/` inherits it and adds `lib/**`;
  // `src/ghost/` resets to its own. Written flat, as lowering emits them.
  const rules = unwrap(
    compileImportRules([
      {
        name: "src/imports",
        message: "…",
        probe,
        from: "^src/",
        fromNot: ["^src/core/", "^src/ghost/"],
        toNot: ["^src(/.*)?$"],
        allowances: [allowance("src", "src/**")],
      },
      {
        name: "src/core/imports",
        message: "…",
        probe,
        from: "^src/core/",
        toNot: ["^src(/.*)?$", "^lib(/.*)?$"],
        allowances: [allowance("src", "src/**"), allowance("src/core", "lib/**")],
      },
      {
        name: "src/ghost/imports",
        message: "…",
        probe: { from: "src/ghost/zz.ts", to: "src/x.ts" },
        from: "^src/ghost/",
        toNot: ["^vendor(/.*)?$"],
        externals: ["lodash"],
        allowances: [
          allowance("src/ghost", "vendor/**"),
          { node: "src/ghost", kind: "external", entry: "lodash" },
        ],
      },
      // A prohibition states no allowlist and is never vacant.
      { name: "deny", message: "…", probe, from: "^src/", to: "^src/secret/" },
    ]),
  );

  it("names an allowlisted node that selects no walked file, with what it wrote", () => {
    expect(vacancyOf(rules, FILES)).toEqual([{ node: "src/ghost", allowances: 2 }]);
  });

  it("does not name a node with a file under it", () => {
    expect(vacancyOf(rules, [...FILES, "src/ghost/g.ts"])).toEqual([]);
  });

  // `src`'s own rule steps aside under `src/core/`, but its allowlist is
  // inherited there, so a file under core is a file `src` grants permission to.
  it("keeps a parent whose only files sit under an overriding child", () => {
    expect(vacancyOf(rules, ["src/core/a.ts"])).toEqual([{ node: "src/ghost", allowances: 2 }]);
  });

  it("names every allowlisted node over an empty tree, in declaration order", () => {
    expect(vacancyOf(rules, [])).toEqual([
      { node: "src", allowances: 1 },
      { node: "src/core", allowances: 1 },
      { node: "src/ghost", allowances: 2 },
    ]);
  });
});
