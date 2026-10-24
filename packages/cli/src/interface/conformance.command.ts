import type { ConformanceMeasure, CoverageFamily, Snapshot } from "@goodbones/core";
import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { type CliFailure, count, report } from "../output.js";
import {
  COVERAGE_FAMILIES,
  describe,
  isConcentrated,
  outsideNote,
  percent,
  snapshotOf,
  unreachedMark,
} from "../report.js";
import type { CheckOptions } from "./check.command.js";

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
