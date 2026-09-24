import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  attest,
  authorOf,
  baseSideAt,
  type CampaignEvaluation,
  campaignFailuresOf,
  type CampaignReport,
  campaignReportsOf,
  campaignsOf,
  campaignsSelecting,
  clear,
  concede,
  evaluateCampaigns,
  explainCampaignLines,
  explainObjective,
  historyOf,
  hitsInWindow,
  ledgeredFilter,
  measureFile,
  note,
  nudgeOf,
  readDiff,
  renderCampaignReports,
  renderCampaignRows,
  renderHistory,
  renderNudge,
  reportSpecsOf,
  snapshotCampaignsOf,
  valueOfParts,
  widenedExtensions,
} from "@goodbones/campaigns";
import {
  type Baseline,
  baselineOf,
  breaches,
  CONFORMANCE_MEASURES,
  type ConformanceMeasure,
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
  exportRulesSelecting,
  findManifestFile,
  fingerprintOf,
  formatManifestYaml,
  formatMessage,
  fractionsOf,
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

import { type LoadedPolicy, loadPolicyFromFile, manifestPathOf } from "./config-loader.js";
import { buildGraph } from "./graph.js";
import { infer } from "./infer.js";
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

export type CliFailure = { readonly _tag: "CliFailure"; readonly message: string };

const fail = (message: string): CliFailure => ({ _tag: "CliFailure", message });

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
    widenedExtensions(policy),
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
  const campaigns = evaluateCampaigns(policy, roots, walked, { textOf, factsOf });

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

const report = (lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`);
  });

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

export type CoverageReport = Readonly<
  Record<
    CoverageFamily,
    { readonly covered: number; readonly total: number; readonly floor?: number }
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
    residue: residueOf(policy, files),
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
  const isLedgered = ledgeredFilter(policy, findings.campaigns);
  const violations: Array<ReportedViolation> = [
    ...findings.violations.map((violation) => ({
      ...violation,
      fingerprint: fingerprintOf(violation),
      baselined: isBaselined(violation),
      ledgered: false,
    })),
    // The hits that count: those whose objective is in window for the
    // sector they fall in.
    ...findings.campaigns.flatMap((evaluation) =>
      hitsInWindow(evaluation).map((hit) => ({
        ...hit.violation,
        fingerprint: fingerprintOf(hit.violation),
        baselined: false,
        ledgered: isLedgered(hit),
        objective: hit.objective,
        sector: hit.sector,
        entry: hit.entry,
      })),
    ),
  ];
  const campaigns = campaignReportsOf(policy, findings.campaigns);

  // The floors. A policy states how much of the tree it reaches, per
  // family; falling under is a policy that quietly stopped covering files.
  const floors = policy.config.limits?.coverage ?? {};
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  const found = coverageOf(policy, files);
  const covered = (family: CoverageFamily): number =>
    family === "structure" ? found.structure.enumerated : found[family].covered;
  const coverage = Object.fromEntries(
    COVERAGE_FAMILIES.map((family) => {
      const floor = floors[family];
      return [
        family,
        {
          covered: covered(family),
          total: found.files,
          ...(floor === undefined ? {} : { floor }),
        },
      ];
    }),
  ) as CoverageReport;
  const shortfalls = shortfallsOf(coverage);

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
    roots,
    ok:
      reportable === 0 &&
      findings.unresolved.length === 0 &&
      stale.length === 0 &&
      shortfalls.length === 0 &&
      excesses.length === 0 &&
      campaignFailuresOf(campaigns).length === 0,
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
  report: CheckReport,
  shortfalls: ReadonlyArray<Shortfall>,
): CliFailure | null => {
  if (report.stale.length > 0) return fail("stale baseline entries");
  const [campaignFailure] = campaignFailuresOf(report.campaigns);
  if (campaignFailure !== undefined) return fail(campaignFailure);
  if (shortfalls.length > 0) return fail("coverage below floor");
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

const renderCampaigns = (report: CheckReport): ReadonlyArray<string> =>
  renderCampaignReports(
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

const renderText = (report: CheckReport): ReadonlyArray<string> => {
  const reportable = report.violations.filter((one) => one.kind !== "campaign" && !one.baselined);
  const carried =
    report.violations.filter((one) => one.kind !== "campaign").length - reportable.length;
  const shortfalls = shortfallsOf(report.coverage);
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
    ...(excesses.length === 0
      ? []
      : [
          "",
          "conformance is above the ceiling the policy states for itself:",
          ...excesses.map(describeExcess),
          "",
          "  architecture conformance    # which files, nodes and allowances",
        ]),
    ...renderCampaigns(report),
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
      options.format === "json" ? [JSON.stringify(report_, null, 2)] : renderText(report_),
    );
    const failure = failureOf(report_, shortfallsOf(report_.coverage));
    if (failure !== null) return yield* Effect.fail(failure);
  });

const percent = (fraction: number): string => `${String(Math.floor(fraction * 100))}%`;

const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${String(n)} ${n === 1 ? noun : plural}`;

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

  const campaigns = snapshotCampaignsOf(policy, findings.campaigns);

  return {
    version: SNAPSHOT_VERSION,
    manifest: report_.manifest,
    roots: report_.roots,
    files: report_.files,
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

const renderSnapshot = (snapshot: Snapshot): ReadonlyArray<string> => {
  const reportable = snapshot.violations.filter((one) => !one.baselined && !one.ledgered);
  const carried = snapshot.violations.length - reportable.length;
  const row = (family: CoverageFamily): string => {
    const { covered, floor, total } = snapshot.coverage[family];
    const fraction = total === 0 ? 1 : covered / total;
    const mark =
      floor === undefined
        ? ""
        : fraction >= floor
          ? `  ≥ ${percent(floor)} ✓`
          : `  < ${percent(floor)} ✗`;
    return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(total)}  ${percent(fraction).padStart(4)}${mark}`;
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
    `${String(snapshot.files)} files under ${snapshot.roots.join(", ")}, against ${snapshot.manifest.path}`,
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
          renderCampaignRows(snapshot.campaigns),
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
      options.format === "json" ? [JSON.stringify(snapshot, null, 2)] : renderSnapshot(snapshot),
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
    const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
    const found = coverageOf(policy, files);
    const fractions = fractionsOf(found);
    const floors = policy.config.limits?.coverage ?? {};
    const row = (family: keyof typeof fractions, covered: number, note: string): string => {
      const floor = floors[family];
      const mark =
        floor === undefined
          ? ""
          : fractions[family] >= floor
            ? `  ≥ ${percent(floor)} ✓`
            : `  < ${percent(floor)} ✗`;
      return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(found.files)}  ${percent(fractions[family]).padStart(4)}  ${note}${mark}`;
    };

    yield* report([
      `${String(found.files)} files under ${roots.join(", ")}`,
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

    // Each campaign selecting the file: the sector the file is in, its
    // phase and definedness, the objectives in window that fire on it and
    // the nearest remaining holdouts — which needs the campaign evaluated
    // over its files, since a sector's phase is derived from all of them —
    // then each objective's truth table: one line per leaf term and what
    // it answered here, so a detector that "should fire" and does not shows
    // which term is not saying what its author thinks.
    const selectedCampaigns = campaignsSelecting(campaignsOf(policy).campaignRules, relative);
    const evaluations =
      selectedCampaigns.length === 0 ? [] : collectFindings(policy, roots).campaigns;
    const campaignLines = selectedCampaigns.flatMap((rule) => {
      const at = path.join(policy.repoRoot, relative);
      const text = existsSync(at) ? readFileSync(at, "utf8") : "";
      const input = {
        file: relative,
        text,
        facts: policy.extractor.factsOf(relative, text),
        resolver: policy.resolver,
        fileSystem: policy.fileSystem,
        syntax: policy.syntax.parse(relative, text),
        functions: campaignsOf(policy).functions,
        reports: campaignsOf(policy).reports,
      };
      const evaluation = evaluations.find((one) => one.rule.id === rule.id);
      return [
        ...(evaluation === undefined ? [] : explainCampaignLines(policy, evaluation, relative)),
        ...rule.objectives.flatMap((objective) => {
          const measure = objective.measure;
          if (measure !== null) {
            // A scalar: what this file adds to its sector's number.
            if (measure.kind === "command") return [];
            const parts = measureFile(measure, input);
            const here =
              measure.kind === "ratio"
                ? `${String(parts.of)} of ${String(parts.per)} here`
                : `${String(valueOfParts(measure, parts))} here`;
            return [
              `      ${objective.name} — ${firstSentence(objective.why ?? objective.message)} (measure, ${objective.direction}; ${here})`,
            ];
          }
          const table = explainObjective(objective, input);
          if (table.length === 0) return [];
          const fired = table.length > 0 && table.every((line) => line.answer);
          return [
            `      ${objective.name} — ${firstSentence(objective.why ?? objective.message)} (${objective.holdout}; ${fired ? "fires here" : "no hit"})`,
            ...table.map(
              (line) =>
                `          ${line.answer ? "✓" : "✗"} ${line.term}${line.count === undefined ? "" : ` (${String(line.count)})`}`,
            ),
          ];
        }),
      ];
    });

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

// The campaign commands. `campaigns` alone is the status table; `status
// --changed` is the nudge; `attest` and `note` write a sector's record;
// `history` replays the ledgers' git history. The ledgers themselves are
// written by `objectives clear` (the ledger reconciled with the code
// wherever that is not a regression) and `objectives concede` (the one way
// a holdout is added by hand, with a reason).

const flagOf = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

const CAMPAIGN_SUBCOMMANDS = ["status", "attest", "note", "history", "clear", "concede"] as const;
const OBJECTIVE_SUBCOMMANDS = ["clear", "concede"] as const;
const VALUE_FLAGS = [
  "--reason",
  "--by",
  "--holdouts",
  "--entries",
  "--sector",
  "--campaign",
  "--evidence",
  "--base",
  "--since",
  "--hotfix",
] as const;

// The verbs the family shipped with, refused by name: each has a new name
// or no place.
const RETIRED: Readonly<Record<string, string>> = {
  init: "`campaigns init` is gone: `objectives clear <campaign>` writes a first ledger, recording each sector's initial.",
  prune: "`campaigns prune` is now `objectives clear`.",
  allow: "`campaigns allow` is now `objectives concede`.",
};

// The positionals after the subcommand, with the value flags and their
// values stepped over: whatever is left names the roots to walk, as it
// does for every other command.
const positionalsOf = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const positional: Array<string> = [];
  for (let at = 0; at < argv.length; at += 1) {
    const one = argv[at] ?? "";
    if ((VALUE_FLAGS as ReadonlyArray<string>).includes(one)) {
      at += 1;
      continue;
    }
    if (!one.startsWith("--")) positional.push(one);
  }
  return positional;
};

// `campaigns [status | attest <sector> <phase> | note <sector> "<text>" |
// history [<campaign>]] [roots…]`: the subcommand and its arguments come
// first.
export const campaignArgsOf = (
  argv: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): {
  readonly subcommand: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly roots: ReadonlyArray<string>;
} => {
  const positional = positionalsOf(argv);
  const [first, ...rest] = positional;
  if (first === undefined) return { subcommand: undefined, args: [], roots: [] };
  if (first in RETIRED) return { subcommand: first, args: [], roots: rest };
  if (!(CAMPAIGN_SUBCOMMANDS as ReadonlyArray<string>).includes(first)) {
    return { subcommand: undefined, args: [], roots: positional };
  }
  switch (first) {
    case "attest":
      return { subcommand: first, args: rest.slice(0, 2), roots: rest.slice(2) };
    case "note":
      return { subcommand: first, args: rest.slice(0, 2), roots: rest.slice(2) };
    case "history": {
      const [second] = rest;
      return second !== undefined && ids.includes(second)
        ? { subcommand: first, args: [second], roots: rest.slice(1) }
        : { subcommand: first, args: [], roots: rest };
    }
    case "clear":
    case "concede": {
      const [second] = rest;
      return second !== undefined && ids.includes(second.split("/")[0] ?? "")
        ? { subcommand: first, args: [second], roots: rest.slice(1) }
        : { subcommand: first, args: [], roots: rest };
    }
    default:
      return { subcommand: first, args: [], roots: rest };
  }
};

// `objectives [clear [<campaign>[/<objective>]] | concede <campaign>[/<objective>]
// --reason <text>] [roots…]`.
export const objectiveArgsOf = (
  argv: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): {
  readonly subcommand: string | undefined;
  readonly target: { campaign: string; objective: string | null } | null;
  readonly roots: ReadonlyArray<string>;
} => {
  const positional = positionalsOf(argv);
  const [first, second, ...rest] = positional;
  if (first === undefined || !(OBJECTIVE_SUBCOMMANDS as ReadonlyArray<string>).includes(first)) {
    return { subcommand: first, target: null, roots: positional.slice(1) };
  }
  const [campaign = "", objective] = (second ?? "").split("/");
  const named = second !== undefined && ids.includes(campaign);
  return {
    subcommand: first,
    target: named ? { campaign, objective: objective ?? null } : null,
    roots: named ? rest : second === undefined ? [] : [second, ...rest],
  };
};

// The one campaign, when there is one, else the one `--campaign` names.
const campaignFor = (
  policy: LoadedPolicy,
  argv: ReadonlyArray<string>,
): Result.Result<CampaignEvaluation["rule"], string> => {
  const named = flagOf(argv, "--campaign");
  if (named !== undefined) {
    const found = campaignsOf(policy).campaignRules.find((rule) => rule.id === named);
    return found === undefined
      ? Result.fail(`no campaign is named "${named}"`)
      : Result.succeed(found);
  }
  const [only] = campaignsOf(policy).campaignRules;
  if (campaignsOf(policy).campaignRules.length === 1 && only !== undefined) return Result.succeed(only);
  return Result.fail(
    `this policy declares ${String(campaignsOf(policy).campaignRules.length)} campaigns; say which with --campaign <id>.`,
  );
};

const objectiveFor = (
  rule: CampaignEvaluation["rule"],
  objective: string | null,
): Result.Result<string, string> => {
  if (objective !== null) {
    return rule.objectives.some((one) => one.id === objective)
      ? Result.succeed(objective)
      : Result.fail(`no objective of ${rule.id} is named "${objective}"`);
  }
  const [only] = rule.objectives;
  if (rule.objectives.length === 1 && only !== undefined) return Result.succeed(only.id);
  return Result.fail(
    `campaign ${rule.id} declares ${String(rule.objectives.length)} objectives; say which as ${rule.id}/<objective>.`,
  );
};

export const objectives = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const parsed = objectiveArgsOf(
      argv,
      campaignsOf(policy).campaignRules.map((rule) => rule.id),
    );
    const roots = parsed.roots.length > 0 ? parsed.roots : defaultRoots;
    if (campaignsOf(policy).campaignRules.length === 0) {
      return yield* report(["this policy declares no campaigns."]);
    }
    const evaluations = (): ReadonlyArray<CampaignEvaluation> =>
      collectFindings(policy, roots).campaigns;

    switch (parsed.subcommand) {
      case "clear": {
        const targets =
          parsed.target === null
            ? campaignsOf(policy).campaignRules
            : campaignsOf(policy).campaignRules.filter((rule) => rule.id === parsed.target?.campaign);
        const by = authorOf(flagOf(argv, "--by")) ?? "unknown";
        const all = evaluations();
        const lines: Array<string> = [];
        for (const rule of targets) {
          const evaluation = all.find((one) => one.rule.id === rule.id);
          if (evaluation === undefined) continue;
          const only = parsed.target?.objective ?? null;
          if (only !== null && !rule.objectives.some((one) => one.id === only)) {
            return yield* Effect.fail(fail(`no objective of ${rule.id} is named "${only}"`));
          }
          const outcomes = yield* Effect.try({
            try: () => clear(policy, evaluation, only, by),
            catch: (cause) => fail(String(cause)),
          });
          for (const outcome of outcomes) {
            const parts = [
              ...(outcome.entered.length > 0
                ? [
                    `${count(outcome.entered.length, "sector")} entered (${outcome.entered.join(", ")})`,
                  ]
                : []),
              ...(outcome.cleared > 0 ? [`${count(outcome.cleared, "holdout")} cleared`] : []),
              ...(outcome.rewritten > 0
                ? [`${count(outcome.rewritten, "holdout")} rewritten`]
                : []),
              ...(outcome.closed > 0 ? [`${count(outcome.closed, "holdout")} closed`] : []),
              ...(outcome.rebaselined.length > 0
                ? [
                    `${count(outcome.rebaselined.length, "sector")} re-baselined (${outcome.rebaselined.join(", ")})`,
                  ]
                : []),
            ];
            if (outcome.measure !== undefined) {
              const moved = [
                ...(outcome.entered.length > 0
                  ? [
                      `${count(outcome.entered.length, "sector")} entered (${outcome.entered.join(", ")})`,
                    ]
                  : []),
                ...(outcome.measure.improved.length > 0
                  ? [
                      `${count(outcome.measure.improved.length, "sector")} improved (${outcome.measure.improved
                        .map((one) => `${one.sector} ${String(one.from)} → ${String(one.to)}`)
                        .join(", ")})`,
                    ]
                  : []),
                ...(outcome.closed > 0 ? [`${count(outcome.closed, "sector")} closed`] : []),
                ...(outcome.rebaselined.length > 0
                  ? [
                      `${count(outcome.rebaselined.length, "sector")} re-baselined (${outcome.rebaselined.join(", ")})`,
                    ]
                  : []),
              ];
              lines.push(
                `${outcome.campaign}/${outcome.objective}: ${moved.length === 0 ? "nothing to clear" : moved.join(", ")}; held to ${String(outcome.measure.recorded)}.`,
              );
              continue;
            }
            lines.push(
              `${outcome.campaign}/${outcome.objective}: ${parts.length === 0 ? "nothing to clear" : parts.join(", ")}; ${count(outcome.left, "holdout")} left.`,
            );
          }
        }
        return yield* report(lines);
      }
      case "concede": {
        if (parsed.target === null) {
          return yield* Effect.fail(
            fail(
              "objectives concede needs a campaign: `objectives concede <campaign>[/<objective>] --reason <text>`",
            ),
          );
        }
        const rule = campaignsOf(policy).campaignRules.find((one) => one.id === parsed.target?.campaign);
        if (rule === undefined)
          return yield* Effect.fail(fail(`no campaign is named "${parsed.target.campaign}"`));
        const objective = objectiveFor(rule, parsed.target.objective);
        if (Result.isFailure(objective)) return yield* Effect.fail(fail(objective.failure));
        const reason = flagOf(argv, "--reason");
        if (reason === undefined) {
          return yield* Effect.fail(
            fail(
              "objectives concede needs --reason <text>: growth is recorded with why, or not at all.",
            ),
          );
        }
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null) {
          return yield* Effect.fail(
            fail("objectives concede needs an author: pass --by <email>, or set git's user.email."),
          );
        }
        const evaluation = evaluations().find((one) => one.rule.id === rule.id);
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.id} was not evaluated`));
        // `--holdouts` concedes a subset and refuses the rest: a pull
        // request that legitimately adds one hit while another is an
        // accident.
        const chosen =
          (flagOf(argv, "--holdouts") ?? flagOf(argv, "--entries"))
            ?.split(",")
            .map((one) => one.trim()) ?? null;
        const outcome = concede(
          policy,
          evaluation,
          objective.success,
          chosen,
          flagOf(argv, "--sector") ?? null,
          {
            at: policy.now,
            by,
            reason,
          },
        );
        if (Result.isFailure(outcome)) return yield* Effect.fail(fail(outcome.failure));
        const scalar =
          rule.objectives.find((one) => one.id === objective.success)?.measure !== null;
        if (scalar) {
          if (outcome.success.conceded.length === 0) {
            return yield* report([
              `${rule.id}/${objective.success}: nothing to concede; no sector measures past its record.`,
            ]);
          }
          return yield* report([
            `${rule.id}/${objective.success}: a rise conceded in ${count(outcome.success.conceded.length, "sector")}, recorded by ${by}.`,
            ...outcome.success.conceded.map((one) => `  ${one.sector} · ${one.entry}`),
            ...(outcome.success.left.length === 0
              ? []
              : [
                  "",
                  `${count(outcome.success.left.length, "sector")} left past the record; check still fails on them.`,
                ]),
          ]);
        }
        if (outcome.success.conceded.length === 0) {
          return yield* report([
            `${rule.id}/${objective.success}: nothing to concede; every hit is in the ledger.`,
          ]);
        }
        return yield* report([
          `${rule.id}/${objective.success}: ${count(outcome.success.conceded.length, "holdout")} conceded, recorded by ${by}.`,
          ...outcome.success.conceded.map((one) => `  ${one.sector} · ${one.entry}`),
          ...(outcome.success.left.length === 0
            ? []
            : [
                "",
                `${count(outcome.success.left.length, "hit")} left unrecorded; check still fails on them.`,
              ]),
        ]);
      }
      default:
        return yield* Effect.fail(
          fail(
            `unknown objectives subcommand "${parsed.subcommand ?? ""}". Try: objectives clear [<campaign>[/<objective>]] | objectives concede <campaign>[/<objective>] --reason <text> [--by <email>] [--sector <name>] [--holdouts a,b]`,
          ),
        );
    }
  });

export const campaigns = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const parsed = campaignArgsOf(
      argv,
      campaignsOf(policy).campaignRules.map((rule) => rule.id),
    );
    const roots = parsed.roots.length > 0 ? parsed.roots : defaultRoots;
    if (campaignsOf(policy).campaignRules.length === 0) {
      return yield* report(["this policy declares no campaigns."]);
    }
    const json = argv.includes("--json");
    const retired = parsed.subcommand === undefined ? undefined : RETIRED[parsed.subcommand];
    if (retired !== undefined) return yield* Effect.fail(fail(retired));

    switch (parsed.subcommand) {
      case undefined: {
        const snapshot = snapshotOf(policy, roots, manifestPathOf(policy.repoRoot, configFilename));
        return yield* report([
          `${count(snapshot.campaigns.length, "campaign")} under ${roots.join(", ")}`,
          "",
          ...renderCampaignRows(snapshot.campaigns),
          "",
          "  architecture campaigns status --changed [--base <ref>] [--json]   # what a diff touches, and what to do",
          "  architecture objectives clear [<campaign>[/<objective>]]        # reconcile the ledgers with the code",
          '  architecture objectives concede <campaign>[/<objective>] --reason "<why>"   # record why a count may rise',
          '  architecture campaigns attest <sector> <phase> --reason "<why>" [--evidence <url>]',
          '  architecture campaigns note <sector> "<text>"',
          "  architecture campaigns history [<campaign>] [--since <ref>]",
        ]);
      }
      case "status": {
        if (!argv.includes("--changed")) {
          return yield* Effect.fail(
            fail("campaigns status takes --changed: the nudge is scoped to a diff."),
          );
        }
        const base = flagOf(argv, "--base") ?? null;
        const diff = yield* Effect.try({
          try: () => readDiff(policy.repoRoot, base),
          catch: (cause) => fail(`could not read the diff: ${String(cause)}`),
        });
        const current = collectFindings(policy, roots).campaigns;
        const baseSide =
          base === null
            ? null
            : yield* Effect.tryPromise({
                try: () =>
                  baseSideAt(policy, base, roots, (repoRoot) =>
                    loadPolicyFromFile(repoRoot, configFilename),
                  ),
                catch: (cause) =>
                  fail(`could not evaluate the base tree at ${base}: ${String(cause)}`),
              });
        const hotfix = flagOf(argv, "--hotfix") ?? null;
        const nudge = nudgeOf(
          policy,
          current,
          diff,
          baseSide,
          hotfix,
          hotfix === null ? null : authorOf(flagOf(argv, "--by")),
        );
        yield* report(json ? [JSON.stringify(nudge, null, 2)] : renderNudge(nudge, policy.now));
        if (!nudge.ok)
          return yield* Effect.fail(fail("the diff sends a sector back under its onTouch"));
        return;
      }
      case "attest": {
        const [sector, phase] = parsed.args;
        if (sector === undefined || phase === undefined) {
          return yield* Effect.fail(
            fail(
              'campaigns attest needs a sector and a phase: `campaigns attest <sector> <phase> --reason "<why>"`',
            ),
          );
        }
        const reason = flagOf(argv, "--reason");
        if (reason === undefined)
          return yield* Effect.fail(fail("campaigns attest needs --reason <text>."));
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null)
          return yield* Effect.fail(
            fail("campaigns attest needs an author: pass --by <email>, or set git's user.email."),
          );
        const rule = campaignFor(policy, argv);
        if (Result.isFailure(rule)) return yield* Effect.fail(fail(rule.failure));
        const evaluation = collectFindings(policy, roots).campaigns.find(
          (one) => one.rule.id === rule.success.id,
        );
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.success.id} was not evaluated`));
        const written = attest(policy, evaluation, sector, phase, {
          reason,
          evidence: flagOf(argv, "--evidence"),
          by,
        });
        if (Result.isFailure(written)) return yield* Effect.fail(fail(written.failure));
        return yield* report([
          `${rule.success.id}: sector ${sector} attested at ${phase} by ${by}, in ${written.success}.`,
          "Run `objectives clear` to move it on.",
        ]);
      }
      case "note": {
        const [sector, text] = parsed.args;
        if (sector === undefined || text === undefined) {
          return yield* Effect.fail(
            fail('campaigns note needs a sector and a text: `campaigns note <sector> "<text>"`'),
          );
        }
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null)
          return yield* Effect.fail(
            fail("campaigns note needs an author: pass --by <email>, or set git's user.email."),
          );
        const rule = campaignFor(policy, argv);
        if (Result.isFailure(rule)) return yield* Effect.fail(fail(rule.failure));
        const evaluation = collectFindings(policy, roots).campaigns.find(
          (one) => one.rule.id === rule.success.id,
        );
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.success.id} was not evaluated`));
        const written = note(policy, evaluation, sector, text, by);
        if (Result.isFailure(written)) return yield* Effect.fail(fail(written.failure));
        return yield* report([
          `${rule.success.id}: note left on ${sector}, in ${written.success}.`,
        ]);
      }
      case "history": {
        const [named] = parsed.args;
        const targets =
          named === undefined
            ? campaignsOf(policy).campaignRules
            : campaignsOf(policy).campaignRules.filter((rule) => rule.id === named);
        const manifestPath = path
          .relative(policy.repoRoot, manifestPathOf(policy.repoRoot, configFilename))
          .replaceAll(path.sep, "/");
        const lines: Array<string> = [];
        for (const rule of targets) {
          const rows = historyOf(policy, rule, flagOf(argv, "--since") ?? null, [manifestPath]);
          if (json) {
            lines.push(JSON.stringify({ campaign: rule.id, rows }, null, 2));
            continue;
          }
          if (lines.length > 0) lines.push("");
          for (const line of renderHistory(rule, rows)) lines.push(line);
        }
        return yield* report(lines);
      }
      case "clear":
      case "concede":
        // The ledger verbs answer under `objectives`; accepted here too.
        return yield* objectives(policy, defaultRoots, argv);
      default:
        return yield* Effect.fail(
          fail(
            `unknown campaigns subcommand "${parsed.subcommand}". Try: campaigns | campaigns status --changed | campaigns attest <sector> <phase> --reason <text> | campaigns note <sector> "<text>" | campaigns history [<campaign>]`,
          ),
        );
    }
  });

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
        try: () =>
          Promise.all(
            reportSpecsOf(campaignsOf(policy).campaignRules).map((spec) => campaignsOf(policy).reports.read?.(spec)),
          ),
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
