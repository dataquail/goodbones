import { type Language, type LoadedPolicy, loadPolicy } from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignPredicate } from "../ports/campaign-predicate.js";
import type { ReportSource } from "../ports/report-source.js";
import { campaignsExtension, campaignsOf } from "./extension.js";

// The family loaded the way a host loads it: composed into `loadPolicy` as an
// extension, decoding its own two keys, compiling and probing its own rules,
// and reading its own ledgers through the file system port. These are the
// tests that lived in the core's loader before the family moved out; what
// changed is that they compose the extension and read the state back with
// `campaignsOf`, rather than finding it on `LoadedPolicy` itself.

// A language that does not exist. Its extractor answers from a table and its
// resolver from another, which is all the loader ever asks of a language — so
// if this loads, a second real pack needs no change here.
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

const manifest = () => ({
  resolve: { scopes: [{ files: "^svc/", language: "go" }] },
  baseline: ".architecture-baseline.json",
  graph: { cycles: [{ name: "no-cycles", message: "…", within: "svc/**" }] },
  tree: {
    "svc/": {
      children: {
        "main.go": {},
        "domain/": {
          imports: { message: "domain reaches itself.", allow: ["svc/domain/**"] },
          children: { "*.go": {} },
        },
      },
    },
  },
});

type LoadOptions = {
  readonly files?: ReturnType<typeof makeFileSystemFake> | undefined;
  readonly functions?: ReadonlyMap<string, CampaignPredicate> | undefined;
  readonly reports?: ReportSource | undefined;
};

const load = (input: unknown, languages: ReadonlyArray<Language>, options: LoadOptions = {}) =>
  loadPolicy({
    repoRoot: "/repo",
    configPath: "/repo/architecture.config.mjs",
    manifest: input,
    languages,
    fileSystem: options.files ?? makeFileSystemFake([]),
    extensions: [
      campaignsExtension({
        ...(options.functions === undefined ? {} : { functions: options.functions }),
        ...(options.reports === undefined ? {} : { reports: options.reports }),
      }),
    ],
  });

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

// The campaign state, as a host reads it back.
const stateOf = (policy: LoadedPolicy) => campaignsOf(policy);

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
  const one = (
    objectiveOverrides: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) => withCampaigns({ "js-to-go": campaign(objectiveOverrides, overrides) });

  it("compiles a campaign, with the duration in milliseconds and the defaults filled", () => {
    const policy = unwrap(load(one(), [go()]));
    expect(stateOf(policy).campaignRules.map((rule) => rule.name)).toEqual(["campaign/js-to-go"]);
    expect(stateOf(policy).campaignRules[0]?.staleAfter).toBe(14 * 86_400_000);
    expect(stateOf(policy).campaignRules[0]?.onComplete).toBe("keep");
    expect(stateOf(policy).campaignRules[0]?.objectives.map((one) => one.name)).toEqual([
      "campaign/js-to-go/port-it",
    ]);
    expect(stateOf(policy).campaignRules[0]?.objectives[0]?.message).toBe("Port the file.");
    expect(stateOf(policy).campaignRules[0]?.perimeter).toBeNull();
    expect(stateOf(policy).campaignRules[0]?.phases).toEqual([]);
    expect(stateOf(policy).ledgerDir).toBe(".architecture-campaigns");
    expect(stateOf(policy).ledgers.size).toBe(0);
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
      "ledgers/js-to-go/plan.json": JSON.stringify({
        version: 1,
        campaign: "js-to-go",
        phases: [],
      }),
    });
    const withDir = stateOf(
      unwrap(load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], { files })),
    );
    expect(withDir.ledgers.get("js-to-go/port-it")?.sectors.scope?.holdouts).toEqual([
      "svc/legacy/util.js",
    ]);
    expect(withDir.sectorRecords.get("js-to-go/scope")?.sector).toBe("scope");
    expect(withDir.plans.get("js-to-go")?.phases).toEqual([]);
    expect(withDir.legacyLedgers.size).toBe(0);

    const malformed = makeFileSystemFake([], {
      "ledgers/js-to-go/port-it.json": '{"sectors": {}}',
    });
    const outcome = load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], { files: malformed });
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
    const policy = unwrap(
      load(withCampaigns({ "js-to-go": campaign() }, "ledgers"), [go()], { files }),
    );
    const ledger = stateOf(policy).ledgers.get("js-to-go/port-it");
    expect(ledger?.objective).toBe("port-it");
    expect(ledger?.sectors.scope?.holdouts).toEqual(["svc/legacy/util.js"]);
    expect(stateOf(policy).legacyLedgers.get("js-to-go")).toBe("ledgers/js-to-go.json");
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
    const reports: ReportSource = { diagnosticsOf: () => [] };
    const policy = unwrap(load(tsc, [go()], { reports }));
    expect(stateOf(policy).reports).toBe(reports);
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
    expect(detailOf(one({ holdout: "sector" }))).toMatch(
      /holdout is `file`, `declaration` or `match`/,
    );
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
            "no-shim": objective({
              match: { path: { file: "shim" } },
              probes: { fires: [{ path: "svc/shim.go" }] },
              ...extra,
            }),
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
      detailOf(
        ladder([
          { id: "open", intent: "?" },
          { id: "a", objectives: ["port-it"] },
        ]),
      ),
    ).toMatch(/phase "open" is open \(it names no objective\) and is not last/);
    expect(detailOf(ladder([{ id: "a" }]))).toMatch(
      /phase "a" names no objective and states no `intent`/,
    );
    expect(
      detailOf(
        ladder([
          { id: "a", objectives: ["port-it"] },
          { id: "b", objectives: ["port-it"] },
        ]),
      ),
    ).toMatch(/names the objective "port-it" in two phases/);
    expect(detailOf(ladder([{ id: "a", objectives: ["nope"] }]))).toMatch(
      /names an objective "nope" the campaign does not declare/,
    );
    expect(
      detailOf(
        ladder(
          [
            { id: "a", objectives: ["no-shim"] },
            { id: "b", objectives: ["port-it"] },
          ],
          { until: "zzz" },
        ),
      ),
    ).toMatch(/runs `until: zzz`, and no phase has that id/);
    expect(
      detailOf(
        ladder(
          [
            { id: "a", objectives: ["port-it"] },
            { id: "b", objectives: ["no-shim"] },
          ],
          { until: "a" },
        ),
      ),
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
    expect(stateOf(policy).campaignRules[0]?.phases.map((phase) => [phase.id, phase.objectives])).toEqual([
      ["a", ["port-it"]],
      ["b", ["no-shim"]],
      ["c", []],
    ]);
    expect(stateOf(policy).campaignRules[0]?.phases.every((phase) => phase.hash.length === 8)).toBe(true);
  });

  it("proves a match perimeter on a sector in its end shape, and refuses one proven only on the shape it leaves", () => {
    const perimeter = (fires: ReadonlyArray<unknown>) =>
      withCampaigns({
        "js-to-go": {
          scope: ["svc/**"],
          perimeter: {
            match: { exports: {} },
            holdout: "declaration",
            probes: { fires, ignores: [] },
          },
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
    expect(stateOf(policy).campaignRules[0]?.perimeter?.kind).toBe("match");
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
              "domain/": {
                layout: "open",
                children: {},
                imports: { message: "domain reaches itself.", allow: ["~/domain/**"] },
              },
            },
          },
        },
        objectives: { "port-it": objective() },
      },
    });
    const policy = unwrap(load(withEnd, [go()]));
    const [rule] = stateOf(policy).campaignRules;
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
