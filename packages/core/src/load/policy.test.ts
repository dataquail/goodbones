import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { ConfigInvalid } from "../domain/architecture-error.js";
import { makeFactExtractorFake } from "../infrastructure/fact-extractor-fake.js";
import { makeFileSystemFake } from "../infrastructure/file-system-fake.js";
import { makeModuleResolverFake } from "../infrastructure/module-resolver-fake.js";
import type { Language } from "../ports/language.js";
import { loadPolicy } from "./policy.js";

// A language that does not exist. Its extractor answers from a table and its
// resolver from another, which is all the loader ever asks of a language — so
// if this loads, a second real pack needs no change here.
const PORT_SOURCE = "type Repo interface { FindOne() }";
const go = (facts: Parameters<typeof makeFactExtractorFake>[0] = {}): Language => ({
  id: "go",
  extensions: [".go"],
  ignoredFiles: [/_test\.go$/],
  packageMarkers: ["go.mod"],
  sourceRoots: [],
  extractor: makeFactExtractorFake(facts),
  fixes: [],
  makeResolver: () =>
    Result.succeed(makeModuleResolverFake({ "svc/domain/repo": "svc/domain/repo.go" })),
});

const manifest = (members: ReadonlyArray<unknown> = []) => ({
  resolve: { scopes: [{ files: "^svc/", language: "go" }] },
  baseline: ".architecture-baseline.json",
  graph: { cycles: [{ name: "no-cycles", message: "…", within: "svc/**" }] },
  tree: {
    "svc/": {
      children: {
        "main.go": {},
        "domain/": {
          imports: { message: "domain reaches itself.", allow: ["svc/domain/**"] },
          members,
          children: { "*.go": {} },
        },
      },
    },
  },
});

const load = (input: unknown, languages: ReadonlyArray<Language>, files = makeFileSystemFake([])) =>
  loadPolicy({
    repoRoot: "/repo",
    configPath: "/repo/architecture.config.mjs",
    manifest: input,
    languages,
    fileSystem: files,
  });

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

describe("loadPolicy with a language that is not TypeScript", () => {
  // The E1 acceptance test: a `*.go` child key, a Go scope, and every rule
  // passes its own probe — proven against a language lowering never heard of.
  it("compiles and probes a manifest whose files are all in another language", () => {
    const policy = unwrap(load(manifest(), [go()]));
    expect(policy.importRules.map((rule) => rule.name)).toEqual(["svc/domain/imports"]);
    expect(policy.importRules[0]?.probe.from).toBe("svc/domain/zzprobe.go");
    expect(policy.structure.folders.map((rule) => rule.name)).toEqual([
      "svc/layout",
      "svc/domain/layout",
    ]);
    expect(policy.languages.map((one) => one.id)).toEqual(["go"]);
  });

  it("resolves through the scope's language, and refuses a file no scope covers", () => {
    const policy = unwrap(load(manifest(), [go()]));
    expect(Result.isSuccess(policy.resolver.resolve("svc/main.go", "svc/domain/repo"))).toBe(true);
    expect(Result.isFailure(policy.resolver.resolve("web/index.ts", "svc/domain/repo"))).toBe(true);
  });

  // A source probe is parsed by the language whose scope covers the probe's
  // file. The fake stages what the snippet reads as; the rule must report it.
  it("parses a source probe through the scope's language", () => {
    const rule = {
      message: 'Port method "{name}" is not in the vocabulary.',
      subject: "members",
      in: "Repo",
      allow: ["FindMany"],
      probe: { source: PORT_SOURCE, name: "FindOne" },
    };
    const parses = go({
      [PORT_SOURCE]: {
        memberSites: [
          { file: "", subject: "members", name: "FindOne", in: "Repo", declares: "interface" },
        ],
      },
    });
    expect(unwrap(load(manifest([rule]), [parses])).memberRules).toHaveLength(1);
  });

  it("names the language and the scope when a source probe reads as nothing", () => {
    const rule = {
      message: "…",
      subject: "members",
      in: "Repo",
      allow: ["FindMany"],
      probe: { source: PORT_SOURCE, name: "FindOne" },
    };
    const outcome = load(manifest([rule]), [go()]);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /svc\/domain\/members-0 — probe parsed by go, selected by the scope "\^svc\/"/,
    );
  });

  // A fix is a rewrite in one language's syntax; a language that does not
  // carry it cannot honour a rule that names it.
  it("refuses an exports rule naming a fix no loaded language implements", () => {
    const withFix = {
      ...manifest(),
      exports: [
        {
          name: "subpaths",
          message: "…",
          module: "svc/domain/**",
          fix: "subpath-namespace-import",
        },
      ],
    };
    const outcome = load(withFix, [go()]);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /subpaths \(subpath-namespace-import\)/,
    );
    expect(
      Result.isSuccess(load(withFix, [{ ...go(), fixes: ["subpath-namespace-import"] }])),
    ).toBe(true);
  });

  it("refuses a scope naming a language no loaded pack answers to", () => {
    const outcome = load(manifest(), []);
    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(ConfigInvalid);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /"go", and no language pack by that name is loaded \(loaded: none\)/,
    );
  });

  // The baseline comes through the port, never off the disk from here.
  it("reads the baseline through the file system it is given", () => {
    const entry = "import|svc/domain/imports|svc/domain/repo.go|svc/main.go";
    const files = makeFileSystemFake([], {
      ".architecture-baseline.json": JSON.stringify({ version: 1, entries: [entry] }),
    });
    const policy = unwrap(load(manifest(), [go()], files));
    expect(
      policy.baseline.isBaselined({
        kind: "import",
        ruleName: "svc/domain/imports",
        message: "…",
        file: "svc/domain/repo.go",
        subject: "svc/main.go",
      }),
    ).toBe(true);
  });
});
