import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  type Baseline,
  baselineOf,
  breaches,
  CONFORMANCE_MEASURES,
  type ConformanceMeasure,
  countedFiles,
  type CoverageFamily,
  coverageOf,
  cyclesIn,
  decodeBaseline,
  decodeManifest,
  EMPTY_BASELINE,
  evaluateGraph,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  expandAliases,
  exportRulesSelecting,
  findManifestFile,
  fingerprintOf,
  formatManifestYaml,
  formatMessage,
  fractionsOf,
  globsOf,
  globToRegExp,
  type Graph,
  hasGraphRules,
  heightOf,
  listSourceFiles,
  makeBaselineFilter,
  MANIFEST_FILENAMES,
  MANIFEST_SCHEMA_ID,
  memberRulesSelecting,
  type ObservedEdge,
  readManifestFile,
  requiredSiblingsOf,
  residueOf,
  rulesSelecting,
  serializeBaseline,
  slackOf,
  type Snapshot,
  SNAPSHOT_VERSION,
  type SourceFacts,
  staleEntriesOf,
  surfaceRulesSelecting,
  vacancyOf,
  type Violation,
} from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { CampaignEvaluation, CampaignReport, VerbContext } from "./campaigns/host.js";
import { type LoadedPolicy, loadPolicyFromFile, manifestPathOf } from "./config-loader.js";
import { buildGraph } from "./graph.js";
import { infer } from "./infer.js";
import { type CliFailure, count, fail, report } from "./output.js";
import { sourceFactsOf } from "./source-facts.js";

// The policy, run with no linter in the loop.
//
// oxlint's JS plugin API is alpha, and a policy that can only be evaluated by
// one alpha host is a policy with a single point of failure. This adapter is the
// second way to ask the same question — and the only way to write a baseline,
// since that needs every finding at once rather than one file at a time.
//
// It covers all four families. The ones that need a syntax tree read it through
// the language pack's own parse rather than oxlint's; both adapters meet at the
// same vocabulary — a specifier, a binding, a member site — so they answer to
// the same core rather than to each other.

export type { CliFailure } from "./output.js";

// An edge the resolver could not turn into a file. It is reported on its own,
// since every import rule about it enforces nothing.
export type UnresolvedEdge = {
  readonly file: string;
  readonly specifier: string;
  readonly detail: string;
};

export type Findings = {
  readonly violations: ReadonlyArray<Violation>;
  // Every campaign, evaluated over the files it sees: its sectors, every
  // hit placed in one, each sector's phase. Kept apart from the violations:
  // a hit is debt a campaign is paying down, judged against its ledger
  // rather than the baseline.
  readonly campaigns: ReadonlyArray<CampaignEvaluation>;
  readonly unresolved: ReadonlyArray<UnresolvedEdge>;
  readonly files: number;
  // Every edge resolved from a file under an import rule — what the slack
  // report reads. An edge from a file no import rule selects is not here,
  // since no allowlist could have admitted it.
  readonly edges: ReadonlyArray<ObservedEdge>;
  // The import graph, when a graph rule needed it or the caller asked.
  readonly graph: Graph | null;
};

export type CollectOptions = {
  // Build the graph even when no rule needs it — the snapshot counts cycles
  // and orders violations by it.
  readonly graph?: boolean;
};

export const collectFindings = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: CollectOptions = {},
): Findings => {
  // A campaign may widen the walk past the packs' extensions; a file only a
  // campaign asked for is seen by the campaigns and by no other family.
  const walked = listSourceFiles(
    policy.repoRoot,
    roots,
    policy.languages,
    policy.campaigns.widenedExtensions(policy),
  );
  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  const files = walked.filter((file) => known.has(path.extname(file)));
  const violations: Array<Violation> = [];
  const unresolved: Array<UnresolvedEdge> = [];
  const edges: Array<ObservedEdge> = [];

  // Each file is read and parsed at most once, whether the per-file
  // families, the graph pass or a campaign asks first.
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    const cached = texts.get(file);
    if (cached !== undefined) return cached;
    const text = readFileSync(path.join(policy.repoRoot, file), "utf8");
    texts.set(file, text);
    return text;
  };
  const parsed = new Map<string, SourceFacts>();
  const factsOf = (file: string): SourceFacts => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const facts = policy.extractor.factsOf(file, textOf(file));
    parsed.set(file, facts);
    return facts;
  };

  // The graph is the whole repository resolved at once — the one question no
  // per-file adapter can ask — and is built only when a rule needs it.
  const graph =
    options.graph === true || hasGraphRules(policy.graph)
      ? buildGraph(files, policy.resolver, factsOf)
      : null;
  if (graph !== null && hasGraphRules(policy.graph)) {
    for (const violation of evaluateGraph(policy.graph, graph)) violations.push(violation);
  }

  // The campaigns, over every walked file, through the same caches.
  const campaigns = policy.campaigns.evaluate(policy, roots, walked, { textOf, factsOf });

  for (const file of files) {
    for (const violation of evaluateStructure(policy.structure, policy.fileSystem, file)) {
      violations.push(violation);
    }

    const selectedImports = rulesSelecting(policy.importRules, file);
    const selectedExports = exportRulesSelecting(policy.exportRules, file);
    const selectedMembers = memberRulesSelecting(policy.memberRules, file);
    const selectedSurface = surfaceRulesSelecting(policy.surfaceRules, file);
    if (
      selectedImports.length +
        selectedExports.length +
        selectedMembers.length +
        selectedSurface.length ===
      0
    ) {
      continue;
    }

    const facts = factsOf(file);

    for (const violation of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      violations.push(violation);
    }

    for (const site of facts.memberSites) {
      for (const violation of evaluateMemberSite(selectedMembers, site)) violations.push(violation);
    }

    for (const specifier of facts.specifiers) {
      const edge = { importer: file, specifier };

      // A file no import rule selects never needs its imports resolved, which
      // is what keeps resolution off the hot path for the bulk of the repo.
      if (selectedImports.length > 0) {
        const resolved = policy.resolver.resolve(file, specifier);
        if (Result.isFailure(resolved)) {
          if (policy.config.resolve.unresolved === "off") continue;
          if (policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))) continue;
          unresolved.push({ file, specifier, detail: resolved.failure.detail });
          continue;
        }
        edges.push({ importer: file, target: resolved.success });
        for (const violation of evaluateResolvedEdge(selectedImports, file, resolved.success)) {
          violations.push(violation);
        }
      }

      const bound = facts.bindings.get(specifier) ?? [];
      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        ...edge,
        bindings: bound,
      });
      if (!Result.isFailure(exported)) {
        for (const { violation } of exported.success) violations.push(violation);
      }
    }
  }

  return { violations, campaigns, unresolved, files: files.length, edges, graph };
};

const baselinePathOf = (policy: LoadedPolicy): string | null =>
  policy.config.baseline === undefined
    ? null
    : path.resolve(policy.repoRoot, policy.config.baseline);

const readBaseline = (policy: LoadedPolicy): Baseline => {
  const at = baselinePathOf(policy);
  if (at === null) return EMPTY_BASELINE;
  try {
    return decodeBaseline(JSON.parse(readFileSync(at, "utf8")) as unknown);
  } catch {
    return EMPTY_BASELINE;
  }
};

const describe = (violation: Violation): string =>
  `  ${violation.file}\n      ${formatMessage(violation)}`;

// Everything `check` has to say, as one value: the two renderers below read
// it, and nothing else computes a finding. `version` is here so a document
// that grows this shape (a conformance snapshot) can say which one it grew.
export type ReportedViolation = Violation & {
  readonly fingerprint: string;
  readonly baselined: boolean;
  // For a campaign hit: carried by the objective's ledger, so `check` does
  // not fail on it. The campaign analogue of `baselined`.
  readonly ledgered: boolean;
  // For a campaign hit: which objective, in which sector, and the ledger
  // entry it is keyed by there.
  readonly objective?: string;
  readonly sector?: string;
  readonly entry?: string;
};

// Per family: the files it reaches of those the limits count, the floor the
// manifest's `limits.coverage` states as a fraction, and the ceiling its
// `limits.unreached` states on the files left over.
export type CoverageReport = Readonly<
  Record<
    CoverageFamily,
    {
      readonly covered: number;
      readonly total: number;
      readonly floor?: number;
      readonly ceiling?: number;
    }
  >
>;

// The conformance measures as counts, each beside the ceiling the manifest's
// `limits.conformance` states for it. `conformance` names what each counts;
// `check` holds the counts to the ceilings.
export type ConformanceReport = Readonly<
  Record<ConformanceMeasure, { readonly count: number; readonly ceiling?: number }>
>;

export type CheckReport = {
  readonly version: 1;
  readonly files: number;
  // Walked files under the manifest's `limits.outside`: judged by every
  // rule, and left out of `coverage` and of the residue.
  readonly outside: number;
  readonly roots: ReadonlyArray<string>;
  readonly ok: boolean;
  // The file the policy was read from, repo-relative, and a hash of its
  // bytes — the root file only, when the manifest is split with `include`.
  readonly manifest: { readonly path: string; readonly sha256: string };
  // Every finding, baselined ones included; `baselined` says which.
  readonly violations: ReadonlyArray<ReportedViolation>;
  readonly unresolved: ReadonlyArray<UnresolvedEdge>;
  // Baseline entries the code no longer produces.
  readonly stale: ReadonlyArray<string>;
  readonly coverage: CoverageReport;
  readonly conformance: ConformanceReport;
  readonly adoption: {
    readonly unrestricted: ReadonlyArray<string>;
    readonly partial: ReadonlyArray<string>;
  };
  readonly campaigns: ReadonlyArray<CampaignReport>;
};

const COVERAGE_FAMILIES: ReadonlyArray<CoverageFamily> = [
  "imports",
  "structure",
  "members",
  "surface",
  "graph",
];

const sha256Of = (file: string): string => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
};

export const checkReport = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): CheckReport => reportOf(policy, roots, manifestPath, collectFindings(policy, roots)).report;

// The four conformance measures, as `conformance` names them: what no
// family reaches, what no file is under, what nothing imports through, and
// the fragment entries concentrated at fewer than half the nodes granted.
type Measures = {
  readonly residue: ReturnType<typeof residueOf>;
  readonly vacant: ReturnType<typeof vacancyOf>;
  readonly slack: ReturnType<typeof slackOf>["slack"];
  readonly concentration: ReturnType<typeof slackOf>["concentration"];
};

// The patterns the policy's `limits.outside` names, alias-expanded, each a
// subtree.
const outsideOf = (policy: LoadedPolicy): ReadonlyArray<RegExp> =>
  globsOf(policy.config.limits?.outside ?? []).map((glob) =>
    globToRegExp(expandAliases(glob, policy.config.aliases ?? {})),
  );

const measuresOf = (
  policy: LoadedPolicy,
  files: ReadonlyArray<string>,
  edges: ReadonlyArray<ObservedEdge>,
): Measures => {
  // Slack is measured over the walked files as well as the edges: an
  // allowlist that selects no file is vacant, and its entries are reported as
  // that rather than as lines nobody needs.
  const { concentration, slack } = slackOf(policy.importRules, edges, files);
  return {
    // Residue is a count of files, and counts the ones the limits count. A
    // node is live or vacant by every file under it, counted or not.
    residue: residueOf(policy, countedFiles(files, outsideOf(policy))),
    vacant: vacancyOf(policy.importRules, files),
    slack,
    concentration,
  };
};

// A fragment entry is concentrated when it is used at fewer than half the
// nodes granted it — the text report's threshold, and the ceiling's.
const isConcentrated = (one: { readonly usedAt: number; readonly of: number }): boolean =>
  one.usedAt * 2 < one.of;

const countsOf = (measures: Measures): Readonly<Record<ConformanceMeasure, number>> => ({
  residue: measures.residue.files.length,
  vacant: measures.vacant.length,
  slack: measures.slack.length,
  concentration: measures.concentration.filter(isConcentrated).length,
});

const reportOf = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
  findings: Findings,
): {
  readonly report: CheckReport;
  readonly measures: Measures;
  readonly files: ReadonlyArray<string>;
} => {
  const baseline = readBaseline(policy);
  const stale = staleEntriesOf(baseline, findings.violations);
  const { isBaselined } = makeBaselineFilter(baseline);
  const violations: Array<ReportedViolation> = [
    ...findings.violations.map((violation) => ({
      ...violation,
      fingerprint: fingerprintOf(violation),
      baselined: isBaselined(violation),
      ledgered: false,
    })),
    // The hits that count: those whose objective is in window for the
    // sector they fall in.
    ...policy.campaigns.hitsOf(policy, findings.campaigns).map((hit) => ({
      ...hit.violation,
      fingerprint: fingerprintOf(hit.violation),
      baselined: false,
      ledgered: hit.ledgered,
      objective: hit.objective,
      sector: hit.sector,
      entry: hit.entry,
    })),
  ];
  const campaigns = policy.campaigns.reportsOf(policy, findings.campaigns);

  // The floors. A policy states how much of the tree it reaches, per
  // family; falling under is a policy that quietly stopped covering files.
  // Both are held over the files the limits count: what `limits.outside`
  // names is judged by every rule and left out of these numbers.
  const floors = policy.config.limits?.coverage ?? {};
  const unreached = policy.config.limits?.unreached ?? {};
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  const counted = countedFiles(files, outsideOf(policy));
  const found = coverageOf(policy, counted);
  const covered = (family: CoverageFamily): number =>
    family === "structure" ? found.structure.enumerated : found[family].covered;
  const coverage = Object.fromEntries(
    COVERAGE_FAMILIES.map((family) => {
      const floor = floors[family];
      const ceiling = unreached[family];
      return [
        family,
        {
          covered: covered(family),
          total: found.files,
          ...(floor === undefined ? {} : { floor }),
          ...(ceiling === undefined ? {} : { ceiling }),
        },
      ];
    }),
  ) as CoverageReport;
  const shortfalls = shortfallsOf(coverage);
  const overruns = overrunsOf(coverage);

  // The ceilings. What no family reaches, what no file is under and what
  // nothing imports through are each a count the policy may hold itself
  // to; rising over one is a manifest that quietly widened.
  const ceilings = policy.config.limits?.conformance ?? {};
  const measures = measuresOf(policy, files, findings.edges);
  const counts = countsOf(measures);
  const conformance = Object.fromEntries(
    CONFORMANCE_MEASURES.map((measure) => {
      const ceiling = ceilings[measure];
      return [measure, { count: counts[measure], ...(ceiling === undefined ? {} : { ceiling }) }];
    }),
  ) as ConformanceReport;
  const excesses = excessesOf(conformance);

  const reportable = violations.filter((one) => !one.baselined && !one.ledgered).length;
  const report: CheckReport = {
    version: 1,
    files: findings.files,
    outside: files.length - counted.length,
    roots,
    ok:
      reportable === 0 &&
      findings.unresolved.length === 0 &&
      stale.length === 0 &&
      shortfalls.length === 0 &&
      overruns.length === 0 &&
      excesses.length === 0 &&
      policy.campaigns.failuresOf(campaigns).length === 0,
    manifest: {
      path: path.relative(policy.repoRoot, manifestPath).replaceAll(path.sep, "/"),
      sha256: sha256Of(manifestPath),
    },
    violations,
    unresolved: findings.unresolved,
    stale,
    coverage,
    conformance,
    adoption: {
      unrestricted: policy.adoption.unrestricted,
      partial: policy.adoption.partial,
    },
    campaigns,
  };
  return { report, measures, files };
};

// Why a report is not `ok`, in the order the text renderer explains it: a
// stale baseline first, since nothing else is trustworthy until the file
// describes something real.
type Shortfall = {
  readonly family: CoverageFamily;
  readonly actual: number;
  readonly floor: number;
};

const shortfallsOf = (coverage: CoverageReport): ReadonlyArray<Shortfall> =>
  COVERAGE_FAMILIES.flatMap((family) => {
    const { covered, floor, total } = coverage[family];
    const actual = total === 0 ? 1 : covered / total;
    return floor === undefined || !breaches({ direction: "up", limit: floor, tolerance: 0 }, actual)
      ? []
      : [{ family, actual, floor }];
  });

// A family leaving more files unreached than the ceiling the policy states
// for it. A count, so deleting files a rule reached changes nothing here,
// where it lowers the fraction a floor holds.
type Overrun = {
  readonly family: CoverageFamily;
  readonly unreached: number;
  readonly ceiling: number;
};

const overrunsOf = (coverage: CoverageReport): ReadonlyArray<Overrun> =>
  COVERAGE_FAMILIES.flatMap((family) => {
    const { ceiling, covered, total } = coverage[family];
    const unreached = total - covered;
    return ceiling === undefined ||
      !breaches({ direction: "down", limit: ceiling, tolerance: 0 }, unreached)
      ? []
      : [{ family, unreached, ceiling }];
  });

// A conformance measure over the ceiling the policy states for it.
type Excess = {
  readonly measure: ConformanceMeasure;
  readonly count: number;
  readonly ceiling: number;
};

const excessesOf = (conformance: ConformanceReport): ReadonlyArray<Excess> =>
  CONFORMANCE_MEASURES.flatMap((measure) => {
    const { ceiling, count } = conformance[measure];
    return ceiling === undefined ||
      !breaches({ direction: "down", limit: ceiling, tolerance: 0 }, count)
      ? []
      : [{ measure, count, ceiling }];
  });

const failureOf = (
  policy: LoadedPolicy,
  report: CheckReport,
  shortfalls: ReadonlyArray<Shortfall>,
): CliFailure | null => {
  if (report.stale.length > 0) return fail("stale baseline entries");
  const [campaignFailure] = policy.campaigns.failuresOf(report.campaigns);
  if (campaignFailure !== undefined) return fail(campaignFailure);
  if (shortfalls.length > 0) return fail("coverage below floor");
  if (overrunsOf(report.coverage).length > 0) return fail("unreached above ceiling");
  if (excessesOf(report.conformance).length > 0) return fail("conformance above ceiling");
  if (report.ok) return null;
  return fail("architecture violations");
};

// What each measure counts, as the failure names it.
const MEASURE_NOUNS: Readonly<Record<ConformanceMeasure, readonly [string, string]>> = {
  residue: ["file no family reaches", "files no family reaches"],
  vacant: ["node no file is under", "nodes no file is under"],
  slack: ["allowance nothing imports through", "allowances nothing imports through"],
  concentration: [
    "allowance used at fewer than half the nodes granted",
    "allowances used at fewer than half the nodes granted",
  ],
};

const describeExcess = (one: Excess): string => {
  const [singular, plural] = MEASURE_NOUNS[one.measure];
  return `  ${one.measure}: ${count(one.count, singular, plural)}, ceiling ${String(one.ceiling)}`;
};

const renderCampaigns = (policy: LoadedPolicy, report: CheckReport): ReadonlyArray<string> =>
  policy.campaigns.renderReports(
    report.campaigns,
    report.violations.flatMap((one) =>
      one.kind === "campaign" &&
      one.objective !== undefined &&
      one.sector !== undefined &&
      one.entry !== undefined
        ? [
            {
              violation: one,
              objective: one.objective,
              sector: one.sector,
              entry: one.entry,
              ledgered: one.ledgered,
            },
          ]
        : [],
    ),
  );

const renderText = (policy: LoadedPolicy, report: CheckReport): ReadonlyArray<string> => {
  const reportable = report.violations.filter((one) => one.kind !== "campaign" && !one.baselined);
  const carried =
    report.violations.filter((one) => one.kind !== "campaign").length - reportable.length;
  const shortfalls = shortfallsOf(report.coverage);
  const overruns = overrunsOf(report.coverage);
  const excesses = excessesOf(report.conformance);
  return [
    ...reportable.map(describe),
    ...report.unresolved.map(
      (one) => `  unresolved: ${one.file} → ${one.specifier} (${one.detail})`,
    ),
    "",
    `${String(report.files)} files, ${String(reportable.length)} violations` +
      (carried > 0 ? `, ${String(carried)} carried by the baseline` : ""),
    // The ratchet: a fixed violation must leave the baseline, or the floor
    // never rises and the file stops describing anything real.
    ...(report.stale.length === 0
      ? []
      : [
          "",
          `${String(report.stale.length)} baseline entries no longer fire. The code was fixed; prune them:`,
          ...report.stale.map((entry) => `  ${entry}`),
          "",
          "  architecture baseline    # rewrites the file from what still fires",
        ]),
    ...(shortfalls.length === 0
      ? []
      : [
          "",
          "coverage is below the floor the policy states for itself:",
          ...shortfalls.map(
            (one) => `  ${one.family}: ${percent(one.actual)} covered, floor ${percent(one.floor)}`,
          ),
          "",
          "  architecture coverage    # which files no rule reaches",
        ]),
    ...(overruns.length === 0
      ? []
      : [
          "",
          "more files are unreached than the ceiling the policy states for itself:",
          ...overruns.map(
            (one) =>
              `  ${one.family}: ${count(one.unreached, "file")} unreached, ceiling ${String(one.ceiling)}`,
          ),
          "",
          "  architecture coverage    # which files no rule reaches",
        ]),
    ...(excesses.length === 0
      ? []
      : [
          "",
          "conformance is above the ceiling the policy states for itself:",
          ...excesses.map(describeExcess),
          "",
          "  architecture conformance    # which files, nodes and allowances",
        ]),
    ...renderCampaigns(policy, report),
  ];
};

export type CheckOptions = {
  readonly format: "text" | "json";
  readonly manifestPath: string;
};

export const check = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: CheckOptions,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const report_ = checkReport(policy, roots, options.manifestPath);
    // JSON is one object on stdout and nothing else there; the failure, when
    // there is one, is a sentence on stderr and the exit code, as in text.
    yield* report(
      options.format === "json" ? [JSON.stringify(report_, null, 2)] : renderText(policy, report_),
    );
    const failure = failureOf(policy, report_, shortfallsOf(report_.coverage));
    if (failure !== null) return yield* Effect.fail(failure);
  });

const percent = (fraction: number): string => `${String(Math.floor(fraction * 100))}%`;

// The conformance snapshot: `check`'s report grown with what no family
// reaches, what the allowlists permit and nothing uses, the cycle count and
// the size of the debt — the whole distance between the tree and the
// manifest, as one document another run can be compared against. Its shape
// is the core's `Snapshot`, and the schema published beside the manifest's.
export const snapshotOf = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): Snapshot => {
  const findings = collectFindings(policy, roots, { graph: true });
  const { files, measures, report: report_ } = reportOf(policy, roots, manifestPath, findings);
  const graph = findings.graph ?? { files, edges: new Map() };
  const heights = heightOf(graph);

  // Leaf edges first. A violation names a target when it is about an edge;
  // the cost of fixing it is roughly how much of the graph stands beneath
  // that target, so the ones nearest the ground come first and a reader
  // starting at the top of the list is starting where a fix stays local.
  // Ties keep the fingerprint order, so the list is the same on every run.
  const heightOfViolation = (one: ReportedViolation): number =>
    heights.get(one.subject ?? "") ?? heights.get(one.file) ?? 0;
  const violations = [...report_.violations].sort((left, right) => {
    const byHeight = heightOfViolation(left) - heightOfViolation(right);
    return byHeight !== 0 ? byHeight : left.fingerprint.localeCompare(right.fingerprint);
  });

  const campaigns = policy.campaigns.snapshotOf(policy, findings.campaigns);

  return {
    version: SNAPSHOT_VERSION,
    manifest: report_.manifest,
    roots: report_.roots,
    files: report_.files,
    outside: report_.outside,
    ok: report_.ok,
    coverage: report_.coverage,
    conformance: report_.conformance,
    residue: measures.residue,
    vacant: measures.vacant,
    violations,
    unresolved: report_.unresolved,
    stale: report_.stale,
    baseline: { size: readBaseline(policy).entries.length },
    cycles: cyclesIn(graph).length,
    slack: measures.slack,
    concentration: measures.concentration,
    adoption: report_.adoption,
    campaigns,
  };
};

// The unreached ceiling beside a family's row, and the ratchet's nudge when
// the count has fallen under it: a ceiling is lowered by hand.
const unreachedMark = (covered: number, total: number, ceiling: number | undefined): string => {
  if (ceiling === undefined) return "";
  const left = total - covered;
  if (left > ceiling) return `  ${String(left)} unreached > ${String(ceiling)} ✗`;
  return `  ${String(left)} unreached ≤ ${String(ceiling)} ✓${left < ceiling ? `, lower it to ${String(left)}` : ""}`;
};

const outsideNote = (outside: number): string =>
  outside === 0 ? "" : `, ${count(outside, "file")} outside the limits`;

const renderSnapshot = (policy: LoadedPolicy, snapshot: Snapshot): ReadonlyArray<string> => {
  const reportable = snapshot.violations.filter((one) => !one.baselined && !one.ledgered);
  const carried = snapshot.violations.length - reportable.length;
  const row = (family: CoverageFamily): string => {
    const { ceiling, covered, floor, total } = snapshot.coverage[family];
    const fraction = total === 0 ? 1 : covered / total;
    const mark =
      floor === undefined
        ? ""
        : fraction >= floor
          ? `  ≥ ${percent(floor)} ✓`
          : `  < ${percent(floor)} ✗`;
    return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(total)}  ${percent(fraction).padStart(4)}${mark}${unreachedMark(covered, total, ceiling)}`;
  };
  const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => [
    "",
    title,
    ...lines,
  ];
  const vacantWidth = Math.max(0, ...snapshot.vacant.map((one) => one.node.length));
  // The document carries every partly-used fragment entry; the text shows
  // the ones concentrated enough to read as a per-file rule written wide.
  const concentrated = snapshot.concentration.filter(isConcentrated);
  // The ceiling beside each measure that has one, and the ratchet's nudge
  // when the count has fallen under it: a ceiling is lowered by hand.
  const ceilingMark = (measure: ConformanceMeasure): string => {
    const { ceiling, count: actual } = snapshot.conformance[measure];
    if (ceiling === undefined) return "";
    if (actual > ceiling) return `  > ${String(ceiling)} ✗`;
    return `  ≤ ${String(ceiling)} ✓${actual < ceiling ? `, lower it to ${String(actual)}` : ""}`;
  };

  return [
    `${String(snapshot.files)} files under ${snapshot.roots.join(", ")}, against ${snapshot.manifest.path}${outsideNote(snapshot.outside)}`,
    ...section("coverage", COVERAGE_FAMILIES.map(row)),
    ...section(
      `residue: ${count(snapshot.residue.files.length, "file")} no family reaches` +
        (snapshot.residue.folders.length === 0
          ? ""
          : `, ${count(snapshot.residue.folders.length, "folder")} wholly`) +
        ceilingMark("residue"),
      [
        ...snapshot.residue.folders.map((folder) => `  ${folder}/`),
        ...snapshot.residue.files
          .filter(
            (file) => !snapshot.residue.folders.some((folder) => file.startsWith(`${folder}/`)),
          )
          .map((file) => `  ${file}`),
      ],
    ),
    ...section(
      `vacant: ${count(snapshot.vacant.length, "node")} ${snapshot.vacant.length === 1 ? "selects" : "select"} no file` +
        ceilingMark("vacant"),
      snapshot.vacant.map(
        (one) => `  ${one.node.padEnd(vacantWidth)}  ${count(one.allowances, "allowance")}`,
      ),
    ),
    ...section(
      `violations: ${count(reportable.length, "reportable")}` +
        (carried > 0 ? `, ${String(carried)} carried by the baseline or a ledger` : "") +
        (snapshot.stale.length > 0
          ? `, ${count(snapshot.stale.length, "stale entry", "stale entries")}`
          : "") +
        (reportable.length > 0 ? " — nearest the ground first" : ""),
      reportable.map(describe),
    ),
    ...(snapshot.unresolved.length === 0
      ? []
      : section(
          `unresolved: ${count(snapshot.unresolved.length, "import")} no rule can police`,
          snapshot.unresolved.map((one) => `  ${one.file} → ${one.specifier} (${one.detail})`),
        )),
    ...section(
      `slack: ${count(snapshot.slack.length, "allowance")} nothing imports through` +
        ceilingMark("slack"),
      snapshot.slack.map(
        (one) =>
          `  ${one.node}: ${one.kind} ${JSON.stringify(one.entry)}` +
          (one.of === undefined ? "" : `  (via use, at ${count(one.of, "node")})`),
      ),
    ),
    ...(concentrated.length === 0 && snapshot.conformance.concentration.ceiling === undefined
      ? []
      : section(
          `concentrated: ${count(concentrated.length, "allowance")} used at fewer than half the nodes granted` +
            ceilingMark("concentration"),
          concentrated.map(
            (one) =>
              `  ${one.fragment}: ${one.kind} ${JSON.stringify(one.entry)}  used at ${String(one.usedAt)} of ${count(one.of, "node")}`,
          ),
        )),
    ...(snapshot.campaigns.length === 0
      ? []
      : section(
          `campaigns: ${count(snapshot.campaigns.length, "campaign")}` +
            (snapshot.campaigns.some((one) => one.stalled)
              ? `, ${count(snapshot.campaigns.filter((one) => one.stalled).length, "stalled", "stalled")}`
              : "") +
            (snapshot.campaigns.some((one) => one.complete && one.ledgered)
              ? `, ${count(snapshot.campaigns.filter((one) => one.complete && one.ledgered).length, "complete", "complete")}`
              : ""),
          policy.campaigns.renderRows(snapshot.campaigns),
        )),
    "",
    `cycles: ${String(snapshot.cycles)}`,
    `baseline: ${count(snapshot.baseline.size, "entry", "entries")}`,
    `adoption: ${count(snapshot.adoption.unrestricted.length, "unrestricted tier")}, ${count(snapshot.adoption.partial.length, "partial tier")}`,
  ];
};

export type ConformanceOptions = CheckOptions;

// The report of the tree against the manifest. Unlike `check`, it never
// fails: it is a measurement, and the manifest it measures against may be one
// the tree was never expected to satisfy yet — `--against` names a target.
// `ok` in the document says what `check` would have done.
export const conformance = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: ConformanceOptions,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const snapshot = snapshotOf(policy, roots, options.manifestPath);
    yield* report(
      options.format === "json"
        ? [JSON.stringify(snapshot, null, 2)]
        : renderSnapshot(policy, snapshot),
    );
  });

// How much of the tree the policy reaches. A probe proves a rule can fire;
// this is whether the files are there to fire on. Reported per family, with the
// adoption backlog — the tiers that said "not tightened yet" — beneath it.
export const coverage = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    // The limits are held over the files they count, so that is what the
    // rows are over: what `limits.outside` names is said, and left out.
    const walked = listSourceFiles(policy.repoRoot, roots, policy.languages);
    const files = countedFiles(walked, outsideOf(policy));
    const found = coverageOf(policy, files);
    const fractions = fractionsOf(found);
    const floors = policy.config.limits?.coverage ?? {};
    const ceilings = policy.config.limits?.unreached ?? {};
    const row = (family: keyof typeof fractions, covered: number, note: string): string => {
      const floor = floors[family];
      const mark =
        floor === undefined
          ? ""
          : fractions[family] >= floor
            ? `  ≥ ${percent(floor)} ✓`
            : `  < ${percent(floor)} ✗`;
      return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(found.files)}  ${percent(fractions[family]).padStart(4)}  ${note}${mark}${unreachedMark(covered, found.files, ceilings[family])}`;
    };

    yield* report([
      `${String(walked.length)} files under ${roots.join(", ")}${outsideNote(walked.length - files.length)}`,
      "",
      row("imports", found.imports.covered, "under an import allowlist"),
      row(
        "structure",
        found.structure.enumerated,
        `in an enumerated folder (${String(found.structure.open)} in an open one, ${String(found.structure.total - found.structure.enumerated - found.structure.open)} in none)`,
      ),
      row("members", found.members.covered, "selected by a members rule"),
      row("surface", found.surface.covered, "selected by a surface rule"),
      row("graph", found.graph.covered, "in a cycles or orphans scope"),
      "",
      `  unrestricted tiers: ${policy.adoption.unrestricted.length === 0 ? "(none)" : policy.adoption.unrestricted.join(", ")}`,
      `  partial tiers:      ${policy.adoption.partial.length === 0 ? "(none)" : policy.adoption.partial.join(", ")}`,
    ]);
  });

export const writeBaseline = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const at = baselinePathOf(policy);
    if (at === null) {
      return yield* Effect.fail(
        fail("this policy declares no `baseline` path, so there is nowhere to write one"),
      );
    }

    const findings = collectFindings(policy, roots);
    const baseline = baselineOf(findings.violations);
    yield* Effect.sync(() => {
      writeFileSync(at, serializeBaseline(baseline));
    });
    yield* report([
      `${String(baseline.entries.length)} violations recorded in ${path.relative(policy.repoRoot, at)}.`,
      "Each one is debt the policy is carrying. Fixing one means deleting its line.",
    ]);
  });

// The question a tree config makes harder to answer than a flat one: given a
// file, what governs it? A flat config you grep; a tree you have to walk.
export const explain = (
  policy: LoadedPolicy,
  file: string,
  roots: ReadonlyArray<string> = ["packages"],
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path.relative(policy.repoRoot, path.resolve(policy.repoRoot, file));
    const selected = rulesSelecting(policy.importRules, relative);

    // An allowlist rule names no `to` — it fires when the target matches none of
    // its patterns. A prohibition names one.
    const allowlists = selected.filter(([rule]) => rule.to.length === 0 && rule.toNot.length > 0);
    const prohibitions = selected.filter(([rule]) => rule.to.length > 0);

    const owed = policy.structure.parity
      .filter(
        (rule) =>
          rule.file.some((pattern) => pattern.test(relative)) &&
          !rule.fileNot.some((pattern) => pattern.test(relative)),
      )
      .flatMap((rule) => requiredSiblingsOf(rule, relative));

    const governing = policy.structure.folders.filter((rule) =>
      rule.folder.some((pattern) => pattern.test(path.dirname(relative))),
    );

    const naming = policy.structure.naming.filter(
      (rule) =>
        rule.file.some((pattern) => pattern.test(relative)) &&
        !rule.fileNot.some((pattern) => pattern.test(relative)),
    );

    const firstSentence = (message: string) =>
      `${(message.split(". ")[0] ?? message).replace(/\.$/, "")}.`;
    const named = (rule: { readonly name: string; readonly message: string }): string =>
      `    ${rule.name} — ${firstSentence(rule.message)}`;

    // The families beyond imports and structure: which rules of each speak to
    // this file at all. What they are evaluated against is `facts`' answer.
    const restricted = exportRulesSelecting(policy.exportRules, relative).map(([rule]) => rule);
    const vocabulary = memberRulesSelecting(policy.memberRules, relative);
    const surface = surfaceRulesSelecting(policy.surfaceRules, relative);
    const scoped = (rule: { within: ReadonlyArray<RegExp>; withinNot: ReadonlyArray<RegExp> }) =>
      rule.within.some((pattern) => pattern.test(relative)) &&
      !rule.withinNot.some((pattern) => pattern.test(relative));
    const graph = [
      ...policy.graph.cycles.filter(scoped).map((rule) => `${named(rule)} (cycles)`),
      ...policy.graph.orphans.filter(scoped).map((rule) => `${named(rule)} (orphans)`),
      ...policy.graph.reach
        .filter(
          (rule) =>
            rule.from.some((pattern) => pattern.test(relative)) &&
            !rule.fromNot.some((pattern) => pattern.test(relative)),
        )
        .map((rule) => `${named(rule)} (reach)`),
    ];
    const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
      lines.length === 0 ? [] : ["", title, ...lines];

    // The campaigns selecting the file, evaluated over their files only
    // when one does: a sector's phase is derived from all of them.
    const campaignLines = policy.campaigns.explainLines(
      policy,
      relative,
      () => collectFindings(policy, roots).campaigns,
    );

    yield* report([
      relative,
      "",
      allowlists.length === 0
        ? "  may import: anything (no tier above this file states an allowlist)"
        : "  may import:",
      ...allowlists.flatMap(([rule]) => [
        `    — ${rule.name}`,
        ...rule.toNot.map((pattern) => `        ${pattern}`),
        ...[...rule.externals].map((name) => `        external: ${name}`),
      ]),
      "",
      "  may not import:",
      ...(prohibitions.length === 0
        ? ["    (nothing beyond the allowlist above)"]
        : prohibitions.map(([rule]) => `    ${rule.name} — ${firstSentence(rule.message)}`)),
      "",
      `  lives in: ${governing.length === 0 ? "a folder no rule governs" : governing.map((rule) => rule.name).join(", ")}`,
      ...(naming.length === 0
        ? []
        : [
            "  is named by:",
            ...naming.map(
              (rule) =>
                `    ${rule.name} — ${rule.sameAs !== null ? "its folder's own name" : (rule.convention?.source ?? "")}`,
            ),
          ]),
      ...(owed.length === 0 ? [] : ["  owes:", ...owed.map((one) => `    ${one}`)]),
      ...section("  may not name (exports):", restricted.map(named)),
      ...section("  vocabulary (members):", vocabulary.map(named)),
      ...section("  may export (surface):", surface.map(named)),
      ...section("  graph:", graph),
      ...section("  campaigns:", campaignLines),
    ]);
  });

// The other half of `explain`. `explain` says which rules select a file; this
// says what those rules are evaluated against — every edge the parser found,
// the names carried across each, every declared member and called name. A rule
// that "should fire" and does not is one of two mistakes, and this is how to
// tell them apart: the pattern does not select the site, or the site is not a
// fact the adapter extracts.
export const facts = (
  policy: LoadedPolicy,
  file: string,
  format: "text" | "json" = "text",
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path
      .relative(policy.repoRoot, path.resolve(policy.repoRoot, file))
      .replaceAll(path.sep, "/");

    const read = yield* Effect.try({
      try: () => sourceFactsOf(policy.repoRoot, relative, policy.extractor),
      catch: (cause) => fail(`could not read ${relative}: ${String(cause)}`),
    });

    const edges = read.specifiers.map((specifier) => ({
      specifier,
      bindings: read.bindings.get(specifier) ?? [],
    }));
    const declared = read.memberSites.filter((site) => site.subject === "members");
    const called = read.memberSites.filter((site) => site.subject === "calls");

    if (format === "json") {
      return yield* report([
        JSON.stringify(
          { file: relative, edges, memberSites: read.memberSites, exportSites: read.exportSites },
          null,
          2,
        ),
      ]);
    }

    yield* report([
      relative,
      "",
      edges.length === 0 ? "  edges: (none)" : "  edges:",
      ...edges.flatMap(({ bindings, specifier }) => [
        `    ${specifier}`,
        ...(bindings.length === 0
          ? ["        (no bindings)"]
          : bindings.map((binding) => `        ${binding.kind.padEnd(9)} ${binding.symbol}`)),
      ]),
      "",
      declared.length === 0 ? "  members: (none)" : "  members:",
      ...declared.map((site) => `    ${site.in ?? ""}.${site.name}  (${site.declares ?? "other"})`),
      "",
      called.length === 0 ? "  calls: (none)" : "  calls:",
      ...called.map((site) => `    ${site.name}`),
      "",
      read.exportSites.length === 0 ? "  exports: (none)" : "  exports:",
      ...read.exportSites.map(
        (site) =>
          `    ${site.kind.padEnd(9)} ${site.name}  (${site.reexport ? "re-export" : site.declares})`,
      ),
    ]);
  });

const SCHEMA_HEADER = `# yaml-language-server: $schema=${MANIFEST_SCHEMA_ID}\n`;

// A first manifest: one open root that reaches itself, the ceilings at zero,
// and a comment per section naming the page that explains it. Tight enough to
// fire on the first external import — which is the moment the author learns
// where the allowlist is — and small enough to read in one sitting.
const STARTER_MANIFEST = `${SCHEMA_HEADER}#
# The architecture policy: one manifest of this repository.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/
#
# A key ending in \`/\` is a folder; anything else is a file. The default is
# tight: a folder admits only the children it lists, and a file may import only
# what it or an ancestor allows. Laxity is opted into, by name, at the node that
# wants it. Quote every glob — \`*\` and \`@\` mean something else to YAML bare.

# How an import specifier becomes a file. Every pattern below is matched
# against a resolved path, so this is what makes the rest mean anything.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/resolution/
resolve:
  scopes:
    - files: ""
      language: typescript
      options: { tsconfig: tsconfig.json }
  unresolved: error

# Violations this repository is carrying while it adopts the policy, keyed by
# fingerprint. Written by \`architecture baseline\`; the floor only rises.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/baseline/
baseline: .architecture-baseline.json

# Ceilings on how many tiers may say "not tightened yet". At zero, raising one
# is a line in this file a reviewer sees. The same block takes coverage floors
# and ceilings on what \`architecture conformance\` measures, once there are
# numbers to write.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/adoption/
limits:
  unrestricted: 0
  partial: 0

# Refactors the repository is running, each an object: objectives (a
# detector with a ledger under \`.architecture-campaigns/\` of every place the
# pattern still occurs), over sectors the code births through a perimeter,
# through phases toward an end. Fill one in, then
# \`architecture objectives clear <id>\` to write its ledgers.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/campaigns/
# campaigns:
#   js-to-ts:
#     why: The strict tsconfig cannot land while any src file is JavaScript.
#     how: Rename to .ts, add types at the module boundary, leave the body alone.
#     scope: { path: "src/**", extensions: [.js, .jsx] }
#     perimeter: file
#     objectives:
#       is-ts:
#         intent: A JavaScript file is one the strict compiler never checks.
#         holdout: file
#         match: { path: { file: "\\\\.(js|jsx)$" } }
#         probes: { fires: [{ path: src/legacy/util.js }], ignores: [{ path: src/util.ts }] }
#     staleAfter: 14d
#     onComplete: remove

# The repository. One open root, reaching itself and the runtime; run
# \`architecture check\` to see what else it reaches, and write that down here.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/imports/
tree:
  "src/":
    message: "src/ is the whole program. Nothing in it is layered yet."
    layout: open
    imports:
      message: "This import is not on the allowlist."
      allow: ["src/**", "node:**"]
      # npm packages this tier may reach, by name.
      external: []
    children: {}
`;

// A starter manifest, for a repository that has none.
export const init = (repoRoot: string): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const present = MANIFEST_FILENAMES.filter((name) => existsSync(path.resolve(repoRoot, name)));
    if (present.length > 0) {
      return yield* Effect.fail(
        fail(
          `${present.join(", ")} already exists. \`init\` writes a starter manifest for a ` +
            `repository that has none, and does not overwrite one.`,
        ),
      );
    }
    yield* Effect.sync(() => {
      writeFileSync(path.resolve(repoRoot, "architecture.yaml"), STARTER_MANIFEST);
    });
    yield* report([
      "wrote architecture.yaml.",
      "",
      "  architecture check       # what src/ reaches today; add it to the allowlist by name",
      "  architecture coverage    # how much of the tree the policy reaches",
    ]);
  });

// The same manifest as a data file. Nothing is hoisted into `defs` — which
// subtrees are worth naming is the author's call — and comments do not
// survive, since no tool carries them across; the report says so.
export const migrate = (
  repoRoot: string,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const from = yield* Effect.try({
      try: () =>
        configFilename === undefined
          ? findManifestFile(repoRoot)
          : path.resolve(repoRoot, configFilename),
      catch: (cause) => fail(String(cause)),
    });
    if (![".mjs", ".js", ".cjs"].includes(path.extname(from))) {
      return yield* Effect.fail(
        fail(
          `${path.basename(from)} is already a data file. \`migrate\` reads a JavaScript ` +
            `manifest and writes the same policy as architecture.yaml.`,
        ),
      );
    }
    const to = path.resolve(repoRoot, "architecture.yaml");
    if (existsSync(to)) {
      return yield* Effect.fail(
        fail("architecture.yaml already exists; `migrate` does not overwrite it."),
      );
    }

    const read = yield* Effect.tryPromise({
      try: () => readManifestFile(from),
      catch: (cause) => fail(String(cause)),
    });
    // Written only if it decodes: a manifest that does not load as a module
    // is not going to load as YAML either, and the error names why.
    const decoded = decodeManifest(from, read.manifest);
    if (Result.isFailure(decoded)) return yield* Effect.fail(fail(decoded.failure.message));

    yield* Effect.sync(() => {
      writeFileSync(to, `${SCHEMA_HEADER}\n${formatManifestYaml(read.manifest)}`);
    });
    yield* report([
      `wrote architecture.yaml from ${path.basename(from)}.`,
      "",
      "Comments were not carried over; port the ones worth keeping by hand.",
      `Then delete ${path.basename(from)}: a repository with two manifests is refused.`,
    ]);
  });

// The campaign commands, answered by the family the host was composed with:
// `campaigns` alone is the status table, `status --changed` the nudge,
// `attest` and `note` write a sector's record, `history` replays the ledgers;
// `objectives clear` and `objectives concede` write the ledgers. Without
// `@goodbones/campaigns` installed, each says what to install.
const verbContext = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): VerbContext => ({
  policy,
  defaultRoots,
  argv,
  evaluate: (roots) => collectFindings(policy, roots).campaigns,
  reload: (repoRoot) => loadPolicyFromFile(repoRoot, configFilename),
  manifestPath: manifestPathOf(policy.repoRoot, configFilename),
});

export const objectives = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  policy.campaigns.objectives(verbContext(policy, defaultRoots, argv));

export const campaigns = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  policy.campaigns.campaigns(verbContext(policy, defaultRoots, argv, configFilename));

// The commands that judge a campaign, and so ask its report source.
const READS_REPORTS: ReadonlySet<string> = new Set([
  "check",
  "conformance",
  "baseline",
  "campaigns",
  "objectives",
  "explain",
]);

export const run = (
  repoRoot: string,
  argv: ReadonlyArray<string>,
  // From ARCHITECTURE_CONFIG. Absent, the manifest is discovered by name.
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const [command = "check", ...rest] = argv;

    // The three commands that write a manifest rather than read one.
    if (command === "init") return yield* init(repoRoot);
    if (command === "migrate") return yield* migrate(repoRoot, configFilename);
    if (command === "infer") {
      yield* infer(repoRoot, rest, configFilename);
      return;
    }

    // `--against <file>` measures the tree against a manifest other than the
    // repository's own — the target the team is moving toward. Only
    // `conformance` takes it: a `check` against a manifest nobody is held to
    // yet would fail for no one's benefit.
    const againstAt = rest.indexOf("--against");
    const against = againstAt === -1 ? undefined : rest[againstAt + 1];
    if (againstAt !== -1 && (against === undefined || against.startsWith("--"))) {
      return yield* Effect.fail(fail("--against needs a manifest path"));
    }
    if (against !== undefined && command !== "conformance") {
      return yield* Effect.fail(
        fail(`--against is a \`conformance\` flag; ${command} does not take it`),
      );
    }
    const manifestFilename = against ?? configFilename;

    const policy = yield* Effect.tryPromise({
      try: () => loadPolicyFromFile(repoRoot, manifestFilename),
      catch: (cause) => fail(String(cause)),
    });
    yield* Effect.sync(() => {
      for (const notice of policy.notices) process.stderr.write(`deprecated: ${notice}\n`);
    });

    // Every `report` a campaign names is read now, before any file asks:
    // a term's several commands run at once rather than one after another
    // the first time a campaign selects a file. What cannot be read is kept
    // for the campaign to report; a report that does not parse is refused.
    if (READS_REPORTS.has(command)) {
      yield* Effect.tryPromise({
        try: () => policy.campaigns.readReports(policy),
        catch: (cause) => fail(String(cause)),
      });
    }

    const json = rest.includes("--json");
    const positional = rest.filter(
      (argument, index) =>
        argument !== "--json" &&
        argument !== "--against" &&
        (againstAt === -1 || index !== againstAt + 1),
    );
    const roots = positional.length > 0 ? positional : ["packages"];

    switch (command) {
      case "campaigns":
        return yield* campaigns(policy, ["packages"], rest, configFilename);
      case "objectives":
        return yield* objectives(policy, ["packages"], rest);
      case "check":
        return yield* check(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, configFilename),
        });
      case "conformance":
        return yield* conformance(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, manifestFilename),
        });
      case "baseline":
        return yield* writeBaseline(policy, roots);
      case "explain": {
        const [file, ...explainRoots] = positional;
        if (file === undefined) return yield* Effect.fail(fail("explain needs a file path"));
        return yield* explain(policy, file, explainRoots.length > 0 ? explainRoots : ["packages"]);
      }
      case "coverage":
        return yield* coverage(policy, roots);
      case "facts": {
        const [file] = positional;
        if (file === undefined) return yield* Effect.fail(fail("facts needs a file path"));
        return yield* facts(policy, file, json ? "json" : "text");
      }
      default:
        return yield* Effect.fail(
          fail(
            `unknown command "${command}". Try: check [--json] | conformance [--json] [--against <manifest>] | baseline | campaigns [status --changed | attest | note | history] | objectives [clear | concede] | coverage | explain <file> | facts <file> [--json] | init | infer | migrate`,
          ),
        );
    }
  });

export const fingerprint = fingerprintOf;
