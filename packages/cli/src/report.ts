import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  type Baseline,
  breaches,
  CONFORMANCE_MEASURES,
  type ConformanceMeasure,
  countedFiles,
  type CoverageFamily,
  coverageOf,
  cyclesIn,
  decodeBaseline,
  EMPTY_BASELINE,
  expandAliases,
  fingerprintOf,
  formatMessage,
  globsOf,
  globToRegExp,
  heightOf,
  listSourceFiles,
  makeBaselineFilter,
  type ObservedEdge,
  residueOf,
  slackOf,
  type Snapshot,
  SNAPSHOT_VERSION,
  staleEntriesOf,
  vacancyOf,
  type Violation,
} from "@goodbones/core";

import type { CampaignReport } from "./campaigns/host.js";
import type { LoadedPolicy } from "./config-loader.js";
import { collectFindings, type Findings, type UnresolvedEdge } from "./findings.js";
import { count } from "./output.js";

export const baselinePathOf = (policy: LoadedPolicy): string | null =>
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

export const describe = (violation: Violation): string =>
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

export const COVERAGE_FAMILIES: ReadonlyArray<CoverageFamily> = [
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
export const outsideOf = (policy: LoadedPolicy): ReadonlyArray<RegExp> =>
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
export const isConcentrated = (one: { readonly usedAt: number; readonly of: number }): boolean =>
  one.usedAt * 2 < one.of;

const countsOf = (measures: Measures): Readonly<Record<ConformanceMeasure, number>> => ({
  residue: measures.residue.files.length,
  vacant: measures.vacant.length,
  slack: measures.slack.length,
  concentration: measures.concentration.filter(isConcentrated).length,
});

export const reportOf = (
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
export type Shortfall = {
  readonly family: CoverageFamily;
  readonly actual: number;
  readonly floor: number;
};

export const shortfallsOf = (coverage: CoverageReport): ReadonlyArray<Shortfall> =>
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

export const overrunsOf = (coverage: CoverageReport): ReadonlyArray<Overrun> =>
  COVERAGE_FAMILIES.flatMap((family) => {
    const { ceiling, covered, total } = coverage[family];
    const unreached = total - covered;

    return ceiling === undefined ||
      !breaches({ direction: "down", limit: ceiling, tolerance: 0 }, unreached)
      ? []
      : [{ family, unreached, ceiling }];
  });

// A conformance measure over the ceiling the policy states for it.
export type Excess = {
  readonly measure: ConformanceMeasure;
  readonly count: number;
  readonly ceiling: number;
};

export const excessesOf = (conformance: ConformanceReport): ReadonlyArray<Excess> =>
  CONFORMANCE_MEASURES.flatMap((measure) => {
    const { ceiling, count } = conformance[measure];

    return ceiling === undefined ||
      !breaches({ direction: "down", limit: ceiling, tolerance: 0 }, count)
      ? []
      : [{ measure, count, ceiling }];
  });

export const percent = (fraction: number): string => `${String(Math.floor(fraction * 100))}%`;

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
export const unreachedMark = (
  covered: number,
  total: number,
  ceiling: number | undefined,
): string => {
  if (ceiling === undefined) return "";
  const left = total - covered;

  if (left > ceiling) return `  ${String(left)} unreached > ${String(ceiling)} ✗`;

  return `  ${String(left)} unreached ≤ ${String(ceiling)} ✓${left < ceiling ? `, lower it to ${String(left)}` : ""}`;
};

export const outsideNote = (outside: number): string =>
  outside === 0 ? "" : `, ${count(outside, "file")} outside the limits`;
