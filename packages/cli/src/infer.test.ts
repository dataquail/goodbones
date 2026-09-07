import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Manifest } from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromManifest } from "./config-loader.js";
import { infer, type InferIo, parseInferFlags } from "./infer.js";
import { collectFindings, run } from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Outside this repository, so the run over this repository below does not
// find the fixture, and with a package store of its own so an external
// resolves the way one does anywhere.
const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "architecture-infer-")));
// This repository, which is the acceptance test: `infer` over it describes
// what it does, and `check` against that description finds nothing.
const thisRepository = path.resolve(here, "../../..");

// A module-shaped application with no manifest. Two modules share a shape
// and one sibling does not; one module reaches the other through its barrel;
// one import resolves to nothing.
const FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "app", type: "module" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  "node_modules/effect/package.json": JSON.stringify({
    name: "effect",
    exports: { "./Effect": "./Effect.js" },
  }),
  "node_modules/effect/Effect.js": "export const succeed = (x) => x;\n",
  "src/server.ts":
    'import { login } from "./modules/auth/index.ts";\nimport { charge } from "./modules/billing/index.ts";\nimport * as fs from "node:fs";\nexport const s = [login, charge, fs];\n',
  "src/modules/auth/index.ts":
    'import { login } from "./commands/login.handler.ts";\nexport { login };\n',
  "src/modules/auth/commands/login.handler.ts":
    'import type { User } from "../domain/user.ts";\nimport { db } from "../../../platform/db.ts";\nexport const login = (user: User) => [user, db];\n',
  "src/modules/auth/domain/user.ts": "export type User = { id: string };\n",
  "src/modules/billing/index.ts":
    'import { charge } from "./commands/charge.handler.ts";\nexport { charge };\n',
  "src/modules/billing/commands/charge.handler.ts":
    'import { invoice } from "../domain/invoice.ts";\nimport { login } from "../../auth/index.ts";\nimport { db } from "../../../platform/db.ts";\nexport const charge = () => [invoice, login, db];\n',
  "src/modules/billing/domain/invoice.ts":
    'import * as Effect from "effect/Effect";\nexport const invoice = Effect.succeed(1);\n',
  "src/modules/shared-kernel/util.ts":
    'import "nope-not-here";\nimport { db } from "../../platform/db.ts";\nexport const u = db;\n',
  "src/platform/db.ts": "export const db = 1;\n",
};

const write = (file: string, source: string) => {
  const at = path.join(repoRoot, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

beforeAll(() => {
  mkdirSync(repoRoot, { recursive: true });
  for (const [file, source] of Object.entries(FILES)) write(file, source);
});

afterAll(() => {
  rmSync(repoRoot, { force: true, recursive: true });
});

// A terminal that records what it was asked and answers from a script.
const scripted = (answers: ReadonlyArray<boolean>, interactive = true) => {
  const asked: Array<string> = [];
  const printed: Array<string> = [];
  const errors: Array<string> = [];
  const io: InferIo = {
    out: (text) => printed.push(text),
    err: (line) => errors.push(line),
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answers[asked.length - 1] ?? false);
    },
    interactive,
  };
  return { io, asked, printed, errors };
};

const silent = scripted([], false).io;

const inferIn = (root: string, argv: ReadonlyArray<string>, io: InferIo = silent) =>
  Effect.runPromise(infer(root, argv, undefined, io));

const failureOf = async (root: string, argv: ReadonlyArray<string>): Promise<string> => {
  const exit = await Effect.runPromiseExit(infer(root, argv, undefined, silent));
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return JSON.stringify(exit.cause);
};

// What `check` would say against the inferred manifest, without writing it.
const findingsAgainst = (root: string, manifest: Manifest, roots: ReadonlyArray<string>) => {
  const loaded = loadPolicyFromManifest(root, manifest);
  if (Result.isFailure(loaded)) throw new Error(String(loaded.failure));
  return collectFindings(loaded.success, roots);
};

describe("parseInferFlags", () => {
  it("reads every flag, and a bare argument as a root", () => {
    const flags = parseInferFlags([
      "--depth",
      "3",
      "--root",
      "src",
      "lib",
      "--tsconfig",
      "tsconfig.build.json",
      "--write",
      "--yes",
      "--collapse",
    ]);
    expect(flags).toEqual(
      Result.succeed({
        depth: 3,
        roots: ["src", "lib"],
        tsconfig: "tsconfig.build.json",
        write: true,
        answers: "yes",
        collapse: true,
      }),
    );
  });

  it("refuses what it does not understand", () => {
    expect(Result.isFailure(parseInferFlags(["--depth", "two"]))).toBe(true);
    expect(Result.isFailure(parseInferFlags(["--depth"]))).toBe(true);
    expect(Result.isFailure(parseInferFlags(["--bogus"]))).toBe(true);
  });
});

describe("infer, over a repository with no manifest", () => {
  it("describes the tree exhaustively when no terminal is there to ask, and says so", async () => {
    const { errors, io, printed } = scripted([], false);
    const outcome = await inferIn(repoRoot, [], io);

    expect(printed.join("")).toBe(outcome.yaml);
    expect(outcome.yaml).toContain("# yaml-language-server: $schema=");
    expect(outcome.yaml).toContain("auth/:");
    expect(outcome.yaml).toContain("billing/:");
    expect(outcome.yaml).not.toContain("{module}");
    expect(outcome.generalized).toEqual([]);
    expect(errors.some((line) => line.includes("not a terminal"))).toBe(true);
  });

  it("writes a manifest `check` accepts with zero violations", async () => {
    const outcome = await inferIn(repoRoot, ["--exhaustive"]);
    const findings = findingsAgainst(repoRoot, outcome.manifest, ["src"]);

    expect(findings.violations).toEqual([]);
    expect(findings.files).toBe(outcome.files);
  });

  it("resolves through the tsconfig at the root, and emits that scope with unresolved loud", async () => {
    const outcome = await inferIn(repoRoot, ["--exhaustive"]);
    expect(outcome.manifest.resolve).toEqual({
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
      unresolved: "error",
    });
    expect(outcome.manifest.baseline).toBe(".architecture-baseline.json");
  });

  it("lists externals by package and builtins by name", async () => {
    const outcome = await inferIn(repoRoot, ["--exhaustive"]);
    const billing = outcome.manifest.tree["src/"]?.children?.["modules/"]?.children?.["billing/"];
    expect(billing?.imports?.external).toEqual(["effect"]);
    expect(outcome.manifest.tree["src/"]?.imports?.allow).toContain("node:fs");
  });

  it("reports the imports it could not resolve, which no allowlist covers", async () => {
    const { errors, io } = scripted([], false);
    const outcome = await inferIn(repoRoot, ["--exhaustive"], io);

    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]).toContain("src/modules/shared-kernel/util.ts → nope-not-here");
    expect(errors.some((line) => line.includes("could not be resolved"))).toBe(true);
    // And `check` agrees: that edge is the one thing it reports.
    expect(findingsAgainst(repoRoot, outcome.manifest, ["src"]).unresolved).toHaveLength(1);
  });

  it("writes the floors as the coverage it reaches today", async () => {
    const outcome = await inferIn(repoRoot, ["--exhaustive"]);
    // `platform/db.ts` imports nothing, so no allowlist can be written for
    // it and no allowlist reaches it: eight of nine files, floored.
    expect(outcome.manifest.limits?.coverage).toEqual({ imports: 0.88, graph: 1 });
    expect(outcome.manifest.limits?.unrestricted).toBe(5);
  });

  it("asks about siblings that share a shape, and about the tightening, in that order", async () => {
    const { asked, io } = scripted([true, true]);
    const outcome = await inferIn(repoRoot, [], io);

    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("auth, billing");
    expect(asked[0]).toContain("src/modules/{module}/");
    expect(asked[1]).toContain("src/modules/*/index.ts");
    expect(outcome.generalized).toEqual([
      {
        parent: "src/modules",
        members: ["auth", "billing"],
        capture: "module",
        crossReach: "index.ts",
      },
    ]);
    expect(outcome.yaml).toContain('"{module}/":');
    expect(outcome.yaml).toContain("src/modules/*/index.ts");
    expect(outcome.yaml).not.toContain("billing/:");
  });

  it("takes no for an answer, either question", async () => {
    const looser = scripted([true, false]);
    const loose = await inferIn(repoRoot, [], looser.io);
    expect(loose.yaml).toContain('"{module}/":');
    expect(loose.yaml).toContain("src/modules/*/**");
    expect(loose.yaml).not.toContain("src/modules/*/index.ts");

    const declining = scripted([false]);
    const exhaustive = await inferIn(repoRoot, [], declining.io);
    expect(declining.asked).toHaveLength(1);
    expect(exhaustive.yaml).not.toContain("{module}");
  });

  it("accepts every generalization with --yes, and what it writes still checks clean", async () => {
    const { asked, io } = scripted([]);
    const outcome = await inferIn(repoRoot, ["--yes"], io);

    expect(asked).toEqual([]);
    expect(outcome.generalized).toHaveLength(1);
    expect(findingsAgainst(repoRoot, outcome.manifest, ["src"]).violations).toEqual([]);
  });

  it("stops at the depth it is given", async () => {
    const shallow = await inferIn(repoRoot, ["--exhaustive", "--depth", "0"]);
    expect(shallow.nodes).toBe(1);
    expect(shallow.manifest.tree["src/"]?.children).toEqual({
      "**/": { layout: "open", children: {} },
    });
    expect(findingsAgainst(repoRoot, shallow.manifest, ["src"]).violations).toEqual([]);
  });

  it("writes architecture.yaml once, and refuses to overwrite it", async () => {
    const at = path.join(repoRoot, "architecture.yaml");
    try {
      const { errors, io } = scripted([], false);
      await inferIn(repoRoot, ["--exhaustive", "--write"], io);
      expect(existsSync(at)).toBe(true);
      expect(errors[0]).toContain("wrote architecture.yaml");

      // The file it wrote is the manifest `check` reads.
      const checked = await Effect.runPromiseExit(run(repoRoot, ["check", "src"]));
      expect(Exit.isFailure(checked)).toBe(true); // the one unresolved import
      expect(JSON.stringify(checked)).toContain("architecture violations");

      expect(await failureOf(repoRoot, ["--exhaustive", "--write"])).toContain("already exists");
    } finally {
      rmSync(at, { force: true });
    }
  });

  it("refuses a root that is not a folder, and a tsconfig that is not there", async () => {
    expect(await failureOf(repoRoot, ["--root", "nope"])).toContain("not a folder");
    expect(await failureOf(repoRoot, ["--tsconfig", "tsconfig.nope.json"])).toContain(
      "does not exist",
    );
  });

  it("is reached through the command line", async () => {
    const exit = await Effect.runPromiseExit(run(repoRoot, ["infer", "--bogus"]));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("unknown flag --bogus");
  });
});

describe("infer, over this repository", () => {
  // The four `src/` trees, named: the other CLI test files write their
  // fixtures under `packages/cli/` while this runs, and a walk of `packages`
  // would see a different set of files on each pass.
  const SOURCES = [
    "packages/core/src",
    "packages/typescript/src",
    "packages/cli/src",
    "packages/oxlint/src",
  ];

  it("describes what the tree does, and `check` against that finds nothing", async () => {
    const outcome = await inferIn(thisRepository, ["--exhaustive", ...SOURCES]);
    const findings = findingsAgainst(thisRepository, outcome.manifest, SOURCES);

    expect(findings.violations).toEqual([]);
    expect(findings.unresolved).toEqual([]);
    expect(findings.files).toBe(outcome.files);
    // The aliases and the resolver come from the manifest that is there.
    expect(Object.keys(outcome.manifest.tree)).toEqual(["@core/", "@ts/", "@cli/", "@ox/"]);
    expect(outcome.manifest.limits?.coverage?.imports).toBe(1);
  }, 60_000);
});
