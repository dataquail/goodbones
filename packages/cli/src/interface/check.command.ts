import type { ConformanceMeasure } from "@goodbones/core";
import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { type CliFailure, count, fail, report } from "../output.js";
import {
  type CheckReport,
  checkReport,
  describe,
  type Excess,
  excessesOf,
  overrunsOf,
  percent,
  type Shortfall,
  shortfallsOf,
} from "../report.js";

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
