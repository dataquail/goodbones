import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// A `report` term through both hosts: the bin runs the campaign's command
// once and anchors each diagnostic on the declaration at its position; the
// plugin, loading the same manifest, reports the same hits and goes silent
// once they are ledgered. The command is a script that prints tsc-style
// lines, so the fixture needs no compiler.

const manifest = (repo: Repo): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  campaigns: [
    {
      id: "type-errors",
      why: "The strict tsconfig cannot land while these remain.",
      how: "Fix the type error; do not add a cast.",
      scope: ["src/**"],
      unit: "match",
      detect: { report: { command: "node report.mjs", format: "tsc", codesNot: ["TS6133"] } },
      probes: {
        fires: [{ path: "src/a.ts", report: [{ line: 1, code: "TS2551", message: "m" }] }],
        ignores: [{ path: "src/b.ts", report: [{ line: 1, code: "TS6133", message: "m" }] }],
      },
      staleAfter: "30d",
    },
  ],
  tree: { "src/": { layout: "open", children: {} } },
});

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    files: {
      "src/a.ts":
        "export function parse(x: string) {\n  return x.nope;\n}\nexport const top = 1;\n",
      "src/b.ts": "export const fine = 1;\n",
      "report.mjs": [
        "process.stdout.write(\"src/a.ts(2,12): error TS2551: Property 'nope' does not exist.\\n\");",
        "process.stdout.write(\"src/a.ts(4,14): error TS6133: 'top' is declared but never used.\\n\");",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
    },
  });
  repo.writeManifest(manifest(repo));
});

afterAll(() => {
  repo.dispose();
});

describe("a report term", () => {
  it("anchors a diagnostic on its declaration, and both hosts report it until it is ledgered", () => {
    const before = check(repo, ["src"]);
    expect(before.code).toBe(1);
    const hits = before.json.violations.filter((one) => one.kind === "campaign");
    expect(hits.map((one) => one.fingerprint)).toEqual([
      expect.stringMatching(
        /^campaign\|campaign\/type-errors\|src\/a\.ts\|parse#TS2551#[0-9a-f]{8}$/,
      ),
    ]);

    const linted = oxlint(repo, ["src"]);
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
    expect(
      linted.diagnostics.map((one) => `${one.rule} ${one.file}`),
      JSON.stringify(linted.diagnostics, null, 2) + linted.stderr,
    ).toEqual(["architecture/campaigns src/a.ts"]);

    const init = cli(repo, ["campaigns", "init", "type-errors", "src"]);
    expect(init.code, init.stderr).toBe(0);
    const after = check(repo, ["src"]);
    expect(after.code, after.stderr).toBe(0);
    expect(oxlint(repo, ["src"]).diagnostics).toEqual([]);
  });

  it("fails to load when the command cannot run", () => {
    const broken = createRepo({ files: { "src/a.ts": "export const a = 1;\n" } });
    broken.writeManifest({
      ...manifest(broken),
      campaigns: [
        {
          id: "type-errors",
          why: "w",
          how: "h",
          scope: ["src/**"],
          unit: "match",
          detect: { report: { file: "missing-report.txt", format: "tsc" } },
          probes: {
            fires: [{ path: "src/a.ts", report: [{ line: 1, code: "TS1", message: "m" }] }],
          },
          staleAfter: "30d",
        },
      ],
    });
    try {
      const result = cli(broken, ["check", "--json", "src"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("the report file missing-report.txt cannot be read");
    } finally {
      broken.dispose();
    }
  });
});
