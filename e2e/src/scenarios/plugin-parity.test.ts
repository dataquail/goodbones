import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import {
  EVERY_FAMILY_ROOTS,
  everyFamilyFiles,
  everyFamilyManifest,
} from "../fixtures/every-family.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// The same tree under oxlint, loading the built plugin the way a user's
// `.oxlintrc.json` does. Every per-file finding `check` reported has a
// diagnostic from the matching `architecture/*` rule on the same file, and
// nothing else is reported. The graph family is CLI-only by design: the
// plugin sees one file at a time and has no graph to evaluate.

const RULE_OF: Readonly<Record<string, string>> = {
  import: "architecture/imports",
  export: "architecture/exports",
  member: "architecture/members",
  structure: "architecture/structure",
  surface: "architecture/surface",
};

let repo: Repo;

beforeAll(() => {
  repo = createRepo({ files: everyFamilyFiles });
  repo.writeManifest(everyFamilyManifest(repo.profile));
});

afterAll(() => {
  repo.dispose();
});

describe("plugin parity", () => {
  it("reports every per-file finding check reported, on the same file, and nothing else", () => {
    const { json } = check(repo, EVERY_FAMILY_ROOTS);
    const linted = oxlint(repo, EVERY_FAMILY_ROOTS);
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
    expect(linted.code).toBe(1);

    const perFile = json.violations.filter((one) => one.kind !== "graph");
    const graph = json.violations.filter((one) => one.kind === "graph");
    expect(graph.length).toBe(3);

    // Each violation, as the plugin spells it: the rule, the file, and the
    // rule name in the message.
    const expected = perFile
      .map((one) => `${RULE_OF[one.kind] ?? one.kind} ${one.file} [${one.ruleName}]`)
      .sort();
    const reported = linted.diagnostics
      .map((one) => `${one.rule} ${one.file} ${one.message.split("]")[0] ?? ""}]`)
      .sort();
    expect(reported).toEqual(expected);

    // And the graph findings are the CLI's alone.
    for (const one of graph) {
      expect(
        linted.diagnostics.some((diagnostic) => diagnostic.message.includes(one.ruleName)),
      ).toBe(false);
    }
  });

  it("is clean under oxlint once check is clean of per-file findings", () => {
    const fixed = createRepo({
      files: {
        ...everyFamilyFiles,
        "src/ports/thing.repository.ts": { imports: [], exports: ["port"], declares: [] },
        "src/ports/thing.repository-live.ts": { imports: [], exports: ["live"], declares: [] },
        "src/thing.view.ts": { imports: [], exports: [], declares: [{ calls: "useAtomValue" }] },
      },
    });
    fixed.remove("src/ports/stray.ts");
    fixed.writeManifest(everyFamilyManifest(fixed.profile));
    try {
      const { json } = check(fixed, EVERY_FAMILY_ROOTS);
      expect(json.violations.filter((one) => one.kind !== "graph")).toEqual([]);
      // The cycle and the orphan remain, and the reach; check still fails.
      expect(json.ok).toBe(false);

      const linted = oxlint(fixed, EVERY_FAMILY_ROOTS);
      expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
      expect(linted.diagnostics).toEqual([]);
      expect(linted.code).toBe(0);
    } finally {
      fixed.dispose();
    }
  });

  it("refuses to load a manifest whose rule fails its probe, naming the rule", () => {
    const vacuous = createRepo({ files: everyFamilyFiles });
    // An authored probe the parser reads no such site out of: the rule can
    // never fire on what it was written for, and both hosts say so at load.
    vacuous.writeManifest({
      resolve: { scopes: [vacuous.profile.scope], unresolved: "error" },
      tree: {
        "src/": {
          layout: "open",
          imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
          children: {
            "*.view.ts": {
              members: [
                {
                  message: "`{name}` puts state in the View.",
                  subject: "calls",
                  match: "use[A-Z]*",
                  allow: ["useAtomValue"],
                  probe: { source: "export const nothing = 1;", name: "useState" },
                },
              ],
            },
          },
        },
      },
    });
    try {
      const checked = cli(vacuous, ["check", "--json", "src"]);
      expect(checked.code).toBe(1);
      expect(checked.stdout).toBe("");
      expect(checked.stderr).toContain("do not report their own probe");
      expect(checked.stderr).toContain("src/*.view.ts/members-0");

      const linted = oxlint(vacuous, ["src"]);
      expect(linted.loaded).toBe(false);
      expect(linted.code).not.toBe(0);
      const said = linted.stdout + linted.stderr;
      expect(said).toContain("Failed to load JS plugin");
      expect(said).toContain("src/*.view.ts/members-0");
    } finally {
      vacuous.dispose();
    }
  });

  it("fails to load without the built plugin", () => {
    const linted = oxlint(repo, ["src"], { plugin: `${repo.root}/no-such-plugin.js` });
    expect(linted.loaded).toBe(false);
    expect(linted.stdout + linted.stderr).toContain("Failed to load JS plugin");
  });
});
