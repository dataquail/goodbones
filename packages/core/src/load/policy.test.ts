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

describe("loadPolicy with campaigns", () => {
  // One campaign, one objective — the minimal form — with the objective's
  // fields overridable on their own.
  const objective = (overrides: Record<string, unknown> = {}) => ({
    holdout: "file",
    match: { path: { file: "\\.js$" } },
    probes: { fires: [{ path: "svc/legacy/util.js" }], ignores: [{ path: "svc/main.go" }] },
    ...overrides,
  });
  const campaign = (
    objectiveOverrides: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) => ({
    why: "Every service is Go.",
    how: "Port the file.",
    scope: ["svc/**"],
    staleAfter: "14d",
    objectives: { "port-it": objective(objectiveOverrides) },
    ...overrides,
  });
  const withCampaigns = (campaigns: Record<string, unknown>, ledger?: string) => ({
    ...manifest(),
    ...(ledger === undefined ? {} : { ledger }),
    campaigns,
  });
  const one = (objectiveOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
    withCampaigns({ "js-to-go": campaign(objectiveOverrides, overrides) });

  it("compiles a campaign, with the duration in milliseconds and the defaults filled", () => {
    const policy = unwrap(load(one(), [go()]));
    expect(policy.campaignRules.map((rule) => rule.name)).toEqual(["campaign/js-to-go"]);
    expect(policy.campaignRules[0]?.staleAfter).toBe(14 * 86_400_000);
    expect(policy.campaignRules[0]?.onComplete).toBe("keep");
    expect(policy.campaignRules[0]?.objectives.map((one) => one.name)).toEqual([
      "campaign/js-to-go/port-it",
    ]);
    expect(policy.campaignRules[0]?.objectives[0]?.message).toBe("Port the file.");
    expect(policy.campaignRules[0]?.perimeter).toBeNull();
    expect(policy.campaignRules[0]?.phases).toEqual([]);
    expect(policy.ledgerDir).toBe(".architecture-campaigns");
    expect(policy.ledgers.size).toBe(0);
  });

  it("refuses the family's first shape by name", () => {
    const listed = load(withCampaigns([{ id: "x" }] as never), [go()]);
    expect(Result.isFailure(listed) && listed.failure.message).toMatch(
      /`campaigns` is a list. A campaign is now a map keyed by its id/,
    );
    const flat = load(
      withCampaigns({ "js-to-go": { detect: { path: { file: "x" } }, unit: "file" } }),
      [go()],
    );
    expect(Result.isFailure(flat) && flat.failure.message).toMatch(
      /campaign "js-to-go" carries a `detect` and no `objectives`/,
    );
  });

  it("refuses a campaign whose fires probe does not fire", () => {
    const outcome = load(one({ probes: { fires: [{ path: "svc/main.go" }] } }), [go()]);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /campaign\/js-to-go\/port-it \(fires probe svc\/main.go did not fire\)/,
    );
  });

  it("names the term that admitted an ignores probe", () => {
    const outcome = load(
      one({
        match: { any: [{ path: { file: "\\.js$" } }, { path: { file: "main" } }] },
        probes: { fires: [{ path: "svc/legacy/util.js" }], ignores: [{ path: "svc/main.go" }] },
      }),
      [go()],
    );
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /ignores probe svc\/main.go fired, admitted by `path \/main\/`/,
    );
  });

  it("refuses a probe outside the campaign's own scope", () => {
    const outcome = load(one({ probes: { fires: [{ path: "web/util.js" }] } }), [go()]);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /probe web\/util.js is outside the campaign's own scope/,
    );
  });

  it("refuses a syntax term in a scope whose language has no matcher, naming the language", () => {
    const outcome = load(
      one({
        match: { syntax: { pattern: "$F($$$)" } },
        probes: { fires: [{ path: "svc/a.go", source: "f()" }] },
      }),
      [go()],
    );
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /`syntax` term in a scope whose language has no syntax matcher: campaign\/js-to-go\/port-it \(svc\/a.go: go carries no syntax matcher\)/,
    );
  });

  it("refuses a fn term the host did not load", () => {
    const outcome = load(
      one({
        match: { fn: "./campaigns/x.mjs#isLegacy" },
        probes: { fires: [{ path: "svc/a.go", source: "x" }] },
      }),
      [go()],
    );
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /predicate function the host did not load: \.\/campaigns\/x\.mjs#isLegacy/,
    );
  });

  it("reads each ledger through the file system, and refuses a malformed one", () => {
    const ledger = {
      version: 2,
      campaign: "js-to-go",
      objective: "port-it",
      created: "2026-09-15T00:00:00.000Z",
      sectors: {
        scope: {
          entered: "2026-09-15T00:00:00.000Z",
          initial: 1,
          cleared: 0,
          closed: 0,
          lastCleared: "2026-09-15T00:00:00.000Z",
          holdouts: ["svc/legacy/util.js"],
        },
      },
      concessions: [],
    };
    const record = {
      version: 1,
      campaign: "js-to-go",
      sector: "scope",
      reached: null,
      since: "2026-09-15T00:00:00.000Z",
      attested: [],
      notes: [],
    };
    const files = makeFileSystemFake([], {
      "ledgers/js-to-go/port-it.json": JSON.stringify(ledger),
      "ledgers/js-to-go/sectors/scope.json": JSON.stringify(record),
      "ledgers/js-to-go/plan.json": JSON.stringify({ version: 1, campaign: "js-to-go", phases: [] }),
    });
    const withDir = unwrap(load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], files));
    expect(withDir.ledgers.get("js-to-go/port-it")?.sectors.scope?.holdouts).toEqual([
      "svc/legacy/util.js",
    ]);
    expect(withDir.sectorRecords.get("js-to-go/scope")?.sector).toBe("scope");
    expect(withDir.plans.get("js-to-go")?.phases).toEqual([]);
    expect(withDir.legacyLedgers.size).toBe(0);

    const malformed = makeFileSystemFake([], { "ledgers/js-to-go/port-it.json": '{"sectors": {}}' });
    const outcome = load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], malformed);
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
      /the ledger ledgers\/js-to-go\/port-it.json does not decode/,
    );
  });

  it("reads a ledger in the family's first layout as the one objective's, and remembers where it was", () => {
    const old = {
      version: 1,
      id: "js-to-go",
      created: "2026-09-15T00:00:00.000Z",
      initial: 1,
      fixed: 0,
      lastProgress: "2026-09-15T00:00:00.000Z",
      regressions: [],
      entries: ["svc/legacy/util.js"],
    };
    const files = makeFileSystemFake([], { "ledgers/js-to-go.json": JSON.stringify(old) });
    const policy = unwrap(load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], files));
    const ledger = policy.ledgers.get("js-to-go/port-it");
    expect(ledger?.objective).toBe("port-it");
    expect(ledger?.sectors.scope?.holdouts).toEqual(["svc/legacy/util.js"]);
    expect(policy.legacyLedgers.get("js-to-go")).toBe("ledgers/js-to-go.json");
  });

  it("refuses a report term when the host provides no report source, and answers it through one", () => {
    const tsc = one({
      match: { report: { command: "tsc --noEmit", format: "tsc", codes: ["TS2551"] } },
      probes: {
        fires: [{ path: "svc/a.go", report: [{ line: 1, code: "TS2551", message: "m" }] }],
      },
    });
    const refused = load(tsc, [go()]);
    expect(Result.isFailure(refused) && refused.failure.message).toMatch(
      /hold a `report` term and the host provided no report source: campaign\/js-to-go/,
    );
    const reports = { diagnosticsOf: () => [] };
    const policy = unwrap(
      loadPolicy({
        repoRoot: "/repo",
        configPath: "/repo/architecture.config.mjs",
        manifest: tsc,
        languages: [go()],
        fileSystem: makeFileSystemFake([]),
        reports,
      }),
    );
    expect(policy.reports).toBe(reports);
  });

  it("refuses a report term naming both a command and a file, or neither, and a regex one without a pattern", () => {
    const detailOf = (manifest: unknown): string => {
      const loaded = load(manifest, [go()]);
      if (!Result.isFailure(loaded)) throw new Error("expected the manifest to be refused");
      return loaded.failure.detail;
    };
    expect(
      detailOf(one({ match: { report: { command: "x", file: "y", format: "tsc" } } })),
    ).toMatch(/exactly one of `command`/);
    expect(detailOf(one({ match: { report: { format: "tsc" } } }))).toMatch(
      /exactly one of `command`/,
    );
    expect(detailOf(one({ match: { report: { file: "out.txt", format: "regex" } } }))).toMatch(
      /`regex` report term needs a `pattern`/,
    );
  });

  it("refuses a probe with no source when the detector reads the file", () => {
    expect(() => load(one({ match: { content: { regex: "x" } } }), [go()])).toThrow(
      /probe \(svc\/legacy\/util.js\) with no `source`, and its detector holds a `content` term/,
    );
  });

  it("refuses an objective with both match and sector, or a sector holdout on a match", () => {
    const detailOf = (manifest: unknown): string => {
      const loaded = load(manifest, [go()]);
      if (!Result.isFailure(loaded)) throw new Error("expected the manifest to be refused");
      return loaded.failure.detail;
    };
    expect(detailOf(one({ sector: { oneRoot: true } }))).toMatch(/exactly one of `match`/);
    expect(detailOf(one({ holdout: "sector" }))).toMatch(/holdout is `file`, `declaration` or `match`/);
    expect(detailOf(one({ probes: { fires: [] } }))).toMatch(/at least one source it must report/);
  });

  // The shapes the design refuses at load: an open phase that is not last,
  // an objective named twice, an `until` with no phase or an empty window.
  it("refuses a ladder the design does not admit, naming the phase", () => {
    const ladder = (phases: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
      withCampaigns({
        "js-to-go": {
          scope: ["svc/**"],
          phases,
          objectives: {
            "port-it": objective(),
            "no-shim": objective({ match: { path: { file: "shim" } }, probes: { fires: [{ path: "svc/shim.go" }] }, ...extra }),
          },
        },
      });
    const detailOf = (manifest: unknown): string => {
      try {
        const loaded = load(manifest, [go()]);
        if (!Result.isFailure(loaded)) throw new Error("expected the manifest to be refused");
        return loaded.failure.detail;
      } catch (cause) {
        return String(cause);
      }
    };
    expect(
      detailOf(ladder([{ id: "open", intent: "?" }, { id: "a", objectives: ["port-it"] }])),
    ).toMatch(/phase "open" is open \(it names no objective\) and is not last/);
    expect(detailOf(ladder([{ id: "a" }]))).toMatch(/phase "a" names no objective and states no `intent`/);
    expect(
      detailOf(ladder([{ id: "a", objectives: ["port-it"] }, { id: "b", objectives: ["port-it"] }])),
    ).toMatch(/names the objective "port-it" in two phases/);
    expect(detailOf(ladder([{ id: "a", objectives: ["nope"] }]))).toMatch(
      /names an objective "nope" the campaign does not declare/,
    );
    expect(
      detailOf(ladder([{ id: "a", objectives: ["no-shim"] }, { id: "b", objectives: ["port-it"] }], { until: "zzz" })),
    ).toMatch(/runs `until: zzz`, and no phase has that id/);
    expect(
      detailOf(ladder([{ id: "a", objectives: ["port-it"] }, { id: "b", objectives: ["no-shim"] }], { until: "a" })),
    ).toMatch(/runs `until: a`, which is not after it/);
    // A well-formed ladder loads, defined and open apart.
    const policy = unwrap(
      load(
        ladder([
          { id: "a", objectives: ["port-it"] },
          { id: "b", objectives: ["no-shim"] },
          { id: "c", intent: "later" },
        ]),
        [go()],
      ),
    );
    expect(policy.campaignRules[0]?.phases.map((phase) => [phase.id, phase.objectives])).toEqual([
      ["a", ["port-it"]],
      ["b", ["no-shim"]],
      ["c", []],
    ]);
    expect(policy.campaignRules[0]?.phases.every((phase) => phase.hash.length === 8)).toBe(true);
  });

  it("proves a match perimeter on a sector in its end shape, and refuses one proven only on the shape it leaves", () => {
    const perimeter = (fires: ReadonlyArray<unknown>) =>
      withCampaigns({
        "js-to-go": {
          scope: ["svc/**"],
          perimeter: { match: { exports: {} }, holdout: "declaration", probes: { fires, ignores: [] } },
          objectives: { "port-it": objective() },
        },
      });
    const exporting = go({
      "export A": {
        exportSites: [
          { file: "svc/a.go", name: "A", kind: "named", declares: "function", reexport: false },
        ],
      },
    });
    const refused = load(perimeter([{ path: "svc/a.js", source: "export A" }]), [exporting]);
    expect(Result.isFailure(refused) && refused.failure.message).toMatch(
      /campaign\/js-to-go\/perimeter \(no fires probe is a sector in its end shape/,
    );
    const policy = unwrap(
      load(
        perimeter([
          { path: "svc/a.js", source: "export A" },
          { path: "svc/a.go", source: "export A" },
        ]),
        [exporting],
      ),
    );
    expect(policy.campaignRules[0]?.perimeter?.kind).toBe("match");
  });

  // A sector-relative tree is compiled and probed once at an abstract root;
  // one that lowers to no rule, or to a rule that cannot fire, is refused.
  it("compiles an endState at the abstract root and expands it into one objective per family", () => {
    const withEnd = withCampaigns({
      "js-to-go": {
        scope: ["svc/**"],
        perimeter: { glob: "svc/*/" },
        endState: {
          "~/": {
            layout: "open",
            children: {
              "domain/": { layout: "open", children: {}, imports: { message: "domain reaches itself.", allow: ["~/domain/**"] } },
            },
          },
        },
        objectives: { "port-it": objective() },
      },
    });
    const policy = unwrap(load(withEnd, [go()]));
    const [rule] = policy.campaignRules;
    expect(rule?.phases.map((phase) => [phase.id, phase.objectives])).toEqual([
      ["end", ["end-state-imports", "end-state-structure"]],
    ]);
    expect(rule?.objectives.find((one) => one.id === "end-state-imports")?.endState).toEqual({
      phase: "end",
      family: "imports",
    });
    expect(() =>
      load(
        withCampaigns({
          "js-to-go": {
            scope: ["svc/**"],
            perimeter: { glob: "svc/*/" },
            endState: {},
            objectives: { "port-it": objective() },
          },
        }),
        [go()],
      ),
    ).toThrow(/endState/);
  });
});
