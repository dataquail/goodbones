import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { exports, imports, source } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// Cold start: a module-shaped tree with no manifest. `infer` describes what
// the tree does today, and `check` against that description finds nothing —
// through the bin, off a terminal, with the manifest named two ways.

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    packages: { effect: ["Effect"] },
    files: {
      "src/server.ts": imports("./modules/auth/index.ts", "./modules/billing/index.ts", "node:fs"),
      "src/modules/auth/index.ts": imports("./commands/login.handler.ts"),
      "src/modules/auth/commands/login.handler.ts": imports(
        "../domain/user.ts",
        "../../../platform/db.ts",
      ),
      "src/modules/auth/domain/user.ts": exports("User"),
      "src/modules/billing/index.ts": imports("./commands/charge.handler.ts"),
      "src/modules/billing/commands/charge.handler.ts": imports(
        "../domain/invoice.ts",
        "../../auth/index.ts",
        "../../../platform/db.ts",
      ),
      "src/modules/billing/domain/invoice.ts": source({
        imports: [{ from: "effect/Effect", namespace: "Effect" }],
        exports: ["invoice"],
      }),
      "src/platform/db.ts": exports("db"),
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("inference", () => {
  it("asks nothing off a terminal, and says so", () => {
    const inferred = cli(repo, ["infer"]);
    expect(inferred.code, inferred.stderr).toBe(0);
    expect(inferred.stderr).toContain("not a terminal");
    expect(inferred.stdout).toContain("# yaml-language-server: $schema=");
    expect(inferred.stdout).toContain("auth/:");
    expect(inferred.stdout).not.toContain("{module}");
  });

  it("generalizes with --yes into a manifest ARCHITECTURE_CONFIG can name, which checks clean", () => {
    const inferred = cli(repo, ["infer", "--yes"]);
    expect(inferred.code, inferred.stderr).toBe(0);
    expect(inferred.stderr).not.toContain("not a terminal");
    // The captured key, and the tightening to the barrel.
    expect(inferred.stdout).toContain('"{module}/":');
    expect(inferred.stdout).toContain("src/modules/*/index.ts");

    repo.write("policy/inferred.yaml", inferred.stdout);
    const checked = check(repo, ["src"], { env: { ARCHITECTURE_CONFIG: "policy/inferred.yaml" } });
    expect(checked.code, checked.stderr).toBe(0);
    expect(checked.json.ok).toBe(true);
    expect(checked.json.violations).toEqual([]);
    expect(checked.json.unresolved).toEqual([]);
    expect(checked.json.manifest.path).toBe("policy/inferred.yaml");
    expect(checked.json.files).toBe(8);
  });

  it("writes the exhaustive manifest, which checks clean with zero violations", () => {
    const wrote = cli(repo, ["infer", "--exhaustive", "--write"]);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(wrote.stdout).toBe("");
    expect(wrote.stderr).toContain("wrote architecture.yaml");
    expect(repo.exists("architecture.yaml")).toBe(true);
    expect(repo.read("architecture.yaml")).toContain("billing/:");

    const checked = check(repo, ["src"]);
    expect(checked.code, checked.stderr).toBe(0);
    expect(checked.json.ok).toBe(true);
    expect(checked.json.violations).toEqual([]);
    expect(checked.json.adoption.unrestricted.length).toBeGreaterThan(0);
    // Every node is unrestricted, and the ceiling is that count, exactly.
    expect(repo.read("architecture.yaml")).toContain(
      `unrestricted: ${String(checked.json.adoption.unrestricted.length)}`,
    );
  });

  it("refuses to overwrite the manifest it wrote", () => {
    const again = cli(repo, ["infer", "--exhaustive", "--write"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
  });
});
