import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  compileExportRules,
  compileImportRules,
  compileMemberRules,
  compileStructure,
  compileSurfaceRules,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  exportRulesSelecting,
  globToRegExp,
  listWorkspaceProjects,
  type LoadedPolicy,
  memberRulesSelecting,
  rulesSelecting,
  type SnapshotCampaign,
  type SourceFacts,
  surfaceRulesSelecting,
  type Violation,
} from "@goodbones/core";
import * as Result from "effect/Result";

import { type CampaignEvaluation, evaluateCampaign, hitsInWindow } from "../core/campaign-state.js";
import {
  type CampaignInput,
  type CompiledCampaign,
  type CompiledObjective,
  detectorOf,
  measureDetectorsOf,
  needsSyntax,
} from "../core/campaigns.js";
import {
  attestedRecord,
  concededMeasure,
  concededSector,
  EMPTY_SECTOR_RECORD,
  isComplete,
  lastClearedOf,
  lastImprovedOf,
  ledgerPathOf,
  measureProgressOf,
  measureStandingOf,
  notedRecord,
  progressOf,
  reconcileSector,
  recordedOf,
  sectorClockOf,
  sectorRecordPathOf,
  serializeLedger,
  serializeMeasureLedger,
  serializeSectorRecord,
} from "../core/ledger.js";
import { isDefinedPhase, isOpenPhase } from "../core/phases.js";
import { LEGACY_SECTOR, type Sector } from "../core/sectors.js";
import type { PhaseRule } from "../domain/config.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";
import { lowerEndState } from "../manifest/lower.js";
import { type Commit, commitsTouching, gitEnv, readDiff, textAt } from "./diff.js";
import {
  count,
  describeValue,
  entriesOf,
  HOLDOUT_CAP,
  ledgerOf,
  measureLedgerOf,
  phaseIdOf,
  recordOf,
  writeJson,
} from "./ledgers.js";
import { commandValues } from "./measure-command.js";
import { campaignReportsOf } from "./report.js";

// The campaigns family, as the CLI runs it: every campaign evaluated over
// the files it sees, each objective's hits judged against its ledger per
// sector, the ledgers written by `objectives clear` and `objectives
// concede`, the per-sector record by `campaigns attest` and `campaigns
// note`, and — the thing the rest exists to serve — the nudge,
// `campaigns status --changed`, which tells whoever touched a sector which
// campaign it is in, what phase it is at, and what small thing in the files
// they touched would move it on.

// ---------------------------------------------------------------------------
// Evaluation

export type Readers = {
  readonly textOf: (file: string) => string;
  readonly factsOf: (file: string) => SourceFacts;
};

// The files a campaign sees: those in its scope with an extension a pack
// walks, or one the campaign's scope widens the walk to.
const filesFor = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  return files.filter(
    (file) =>
      rule.scope.some((pattern) => pattern.test(file)) &&
      (known.has(path.extname(file)) || rule.extensions.includes(path.extname(file))),
  );
};

// The extensions every campaign widens the walk to, for the walker.
export const widenedExtensions = (policy: LoadedPolicy): ReadonlyArray<string> => [
  ...new Set(campaignsOf(policy).campaignRules.flatMap((rule) => rule.extensions)),
];

const readersOf = (policy: LoadedPolicy): Readers => {
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    const cached = texts.get(file);
    if (cached !== undefined) return cached;
    let text = "";
    try {
      text = readFileSync(path.join(policy.repoRoot, file), "utf8");
    } catch {
      text = "";
    }
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
  return { textOf, factsOf };
};

// One family of an end state against one sector: the tree lowered with the
// sector's root, compiled, and evaluated over the sector's files the way
// the repository's own tree is.
const endStateViolations = (
  policy: LoadedPolicy,
  readers: Readers,
  sectors: ReadonlyArray<Sector>,
  sector: Sector,
  phase: PhaseRule,
): Readonly<Record<string, ReadonlyArray<Violation>>> => {
  const root = sector.roots[0] ?? "";
  const lowered = lowerEndState(
    phase.endState as Readonly<Record<string, unknown>>,
    root,
    sectors.map((one) => ({ name: one.name, root: one.roots[0] ?? "" })),
    policy.config.resolve,
    policy.languages,
    policy.config.aliases ?? {},
  );
  const unwrap = <A>(compiled: Result.Result<A, { readonly message: string }>): A => {
    if (Result.isFailure(compiled)) throw new Error(compiled.failure.message);
    return compiled.success;
  };
  const imports = unwrap(compileImportRules(lowered.imports));
  const exports = unwrap(compileExportRules(lowered.exports));
  const members = unwrap(compileMemberRules(lowered.members));
  const surface = unwrap(compileSurfaceRules(lowered.surface));
  const structure = unwrap(compileStructure(lowered.structure));
  const found: Record<string, Array<Violation>> = {
    imports: [],
    exports: [],
    members: [],
    surface: [],
    structure: [],
  };
  for (const file of sector.files) {
    for (const one of evaluateStructure(structure, policy.fileSystem, file)) {
      found.structure?.push(one);
    }
    const selectedImports = rulesSelecting(imports, file);
    const selectedExports = exportRulesSelecting(exports, file);
    const selectedMembers = memberRulesSelecting(members, file);
    const selectedSurface = surfaceRulesSelecting(surface, file);
    if (
      selectedImports.length +
        selectedExports.length +
        selectedMembers.length +
        selectedSurface.length ===
      0
    ) {
      continue;
    }
    const facts = readers.factsOf(file);
    for (const one of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      found.surface?.push(one);
    }
    for (const site of facts.memberSites) {
      for (const one of evaluateMemberSite(selectedMembers, site)) found.members?.push(one);
    }
    for (const specifier of facts.specifiers) {
      if (selectedImports.length > 0) {
        const resolved = policy.resolver.resolve(file, specifier);
        if (Result.isSuccess(resolved)) {
          for (const one of evaluateResolvedEdge(selectedImports, file, resolved.success)) {
            found.imports?.push(one);
          }
        }
      }
      const bound = facts.bindings.get(specifier) ?? [];
      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        importer: file,
        specifier,
        bindings: bound,
      });
      if (Result.isSuccess(exported)) {
        for (const { violation } of exported.success) found.exports?.push(violation);
      }
    }
  }
  return found;
};

// Every campaign, evaluated over the files under `roots`.
export const evaluateCampaigns = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  readers: Readers = readersOf(policy),
): ReadonlyArray<CampaignEvaluation> => {
  const projects = campaignsOf(policy).campaignRules.some((rule) => rule.perimeter?.kind === "nx")
    ? listWorkspaceProjects(policy.repoRoot, roots)
    : [];
  const commandValueOf = commandValues(policy.repoRoot);
  return campaignsOf(policy).campaignRules.map((rule) => {
    const detectors = [
      ...rule.objectives.flatMap((one) => {
        const detect = detectorOf(one);
        return [...(detect === null ? [] : [detect]), ...measureDetectorsOf(one)];
      }),
      ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
    ];
    const parses = needsSyntax(detectors);
    const inputOf = (file: string): CampaignInput => {
      const text = readers.textOf(file);
      return {
        file,
        text,
        facts: readers.factsOf(file),
        resolver: policy.resolver,
        fileSystem: policy.fileSystem,
        syntax: parses ? policy.syntax.parse(file, text) : null,
        functions: campaignsOf(policy).functions,
        reports: campaignsOf(policy).reports,
      };
    };
    const input = {
      files: filesFor(policy, rule, files),
      inputOf,
      readText: (file: string) => readers.textOf(file),
      globToRegExp,
      projects,
      recordOf: (sector: string) =>
        campaignsOf(policy).sectorRecords.get(ledgerKeyOf(rule.id, sector)),
      commandValueOf,
    };
    if (!rule.objectives.some((one) => one.endState !== null)) return evaluateCampaign(rule, input);
    // An end state's `{ sector, via }` entries need every sector's root, so
    // the sectors are discovered first and the tree is lowered per sector
    // once they are known. One family's violations are computed with the
    // rest of that sector's, and kept for the other families' asks.
    const known = [...evaluateCampaign(rule, input).index.sectors.values()];
    const endStates = new Map<string, Readonly<Record<string, ReadonlyArray<Violation>>>>();
    const evaluation = evaluateCampaign(rule, {
      ...input,
      endStateOf: (sector, phase, family) => {
        const key = `${sector.name}\u0000${phase.id}`;
        let found = endStates.get(key);
        if (found === undefined) {
          found = endStateViolations(policy, readers, known, sector, phase);
          endStates.set(key, found);
        }
        return found[family] ?? [];
      },
    });
    return evaluation;
  });
};

// ---------------------------------------------------------------------------
// The conformance snapshot's campaigns

export const snapshotCampaignsOf = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ReadonlyArray<SnapshotCampaign> =>
  campaignReportsOf(policy, evaluations).map((report, i) => {
    const evaluation = evaluations[i];
    if (evaluation === undefined) throw new Error("report without evaluation");
    const { rule } = evaluation;
    const ledgers = rule.objectives.map((objective) => ledgerOf(policy, rule, objective));
    const scalar = new Set(
      rule.objectives.filter((one) => one.measure !== null).map((one) => one.id),
    );
    const objectives = rule.objectives.map((objective, j) => {
      const ledger = ledgers[j];
      const own = report.objectives[j];
      const phase = rule.phases.find((one) => one.objectives.includes(objective.id))?.id ?? null;
      if (objective.measure !== null) {
        // A scalar: the holdout counts are all 0, and the number is under
        // `measure`. Met when every sector in window is at its target.
        const measured = measureLedgerOf(policy, rule, objective);
        const met =
          objective.target !== null &&
          (own?.sectors ?? []).every(
            (one) => (evaluation.sectors.get(one.sector)?.counts[objective.id] ?? 1) === 0,
          );
        return {
          id: objective.id,
          phase,
          initial: 0,
          allowed: 0,
          count: 0,
          cleared: 0,
          closed: 0,
          progress: measured === undefined ? 0 : measureProgressOf(measured, objective.target),
          lastCleared: measured === undefined ? null : lastImprovedOf(measured),
          concessions: measured?.concessions.length ?? 0,
          complete: met,
          ledgered: measured !== undefined,
          measure: {
            direction: objective.direction,
            value: own?.measure?.value ?? 0,
            recorded: own?.measure?.recorded ?? (measured === undefined ? 0 : recordedOf(measured)),
            target: objective.target,
            tolerance: objective.tolerance,
          },
        };
      }
      if (ledger === undefined) {
        return {
          id: objective.id,
          phase,
          initial: own?.count ?? 0,
          allowed: 0,
          count: own?.count ?? 0,
          cleared: 0,
          closed: 0,
          progress: 0,
          lastCleared: null,
          concessions: 0,
          complete: (own?.count ?? 0) === 0,
          ledgered: false,
        };
      }
      const sectors = Object.values(ledger.sectors);
      return {
        id: objective.id,
        phase,
        initial: sectors.reduce((sum, one) => sum + one.initial, 0),
        allowed: ledger.concessions.reduce(
          (sum, one) => sum + Math.max(0, "delta" in one ? one.delta : one.to - one.from),
          0,
        ),
        count: sectors.reduce((sum, one) => sum + one.holdouts.length, 0),
        cleared: sectors.reduce((sum, one) => sum + one.cleared, 0),
        closed: sectors.reduce((sum, one) => sum + one.closed, 0),
        progress: progressOf(ledger),
        lastCleared: lastClearedOf(ledger),
        concessions: ledger.concessions.length,
        complete: isComplete(ledger),
        ledgered: true,
      };
    });
    const totalInitial = objectives.reduce(
      (sum, one) => sum + one.initial + one.allowed - one.closed,
      0,
    );
    const totalCount = objectives.reduce((sum, one) => sum + one.count, 0);
    const sectors = [...evaluation.sectors.values()].filter((one) => one.name !== LEGACY_SECTOR);
    const legacy = evaluation.sectors.get(LEGACY_SECTOR);
    return {
      id: rule.id,
      ...(rule.title === null ? {} : { title: rule.title }),
      ...(rule.owner === null ? {} : { owner: rule.owner }),
      count: totalCount,
      progress: totalInitial <= 0 ? 1 : 1 - totalCount / totalInitial,
      objectives,
      phases: rule.phases.map((phase, index) => ({
        id: phase.id,
        defined: isDefinedPhase(phase),
        attested: phase.attested,
        sectors: sectors.filter((one) => one.phase === index).length,
      })),
      sectors: sectors.map((state) => {
        const record = recordOf(policy, rule, state.name);
        const residueTotal = Object.values(state.residue).reduce((sum, one) => sum + one, 0);
        const clock = [
          ...ledgers.flatMap((ledger) => {
            const own = ledger?.sectors[state.name];
            return own === undefined ? [] : [own.lastCleared];
          }),
          ...(record === undefined ? [] : [sectorClockOf(record)]),
        ].reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
        return {
          name: state.name,
          phase: phaseIdOf(rule, state.phase),
          reached: record?.reached ?? null,
          files: state.sector.files.length,
          residue: state.residue,
          stalled:
            rule.staleAfter !== null &&
            residueTotal > 0 &&
            clock !== null &&
            policy.now - Date.parse(clock) > rule.staleAfter,
        };
      }),
      legacy: {
        files: evaluation.index.legacy.length,
        holdouts:
          legacy === undefined
            ? 0
            : Object.entries(legacy.residue)
                .filter(([id]) => !scalar.has(id))
                .reduce((a, [, n]) => a + n, 0),
      },
      plan: report.plan,
      stalled: report.stalled,
      complete: report.complete,
      onComplete: rule.onComplete,
      ledgered: rule.objectives.every((objective, j) =>
        objective.measure === null
          ? ledgers[j] !== undefined
          : measureLedgerOf(policy, rule, objective) !== undefined,
      ),
    };
  });

const percent = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

// The status table: one row per campaign, its phase distribution beneath
// when it has phases, its objectives beneath that. Stalled and complete
// first, then by progress.
export const renderCampaignRows = (
  campaigns: ReadonlyArray<SnapshotCampaign>,
): ReadonlyArray<string> => {
  const state = (one: SnapshotCampaign): string =>
    !one.ledgered ? "no ledger" : one.complete ? "complete" : one.stalled ? "stalled" : "";
  const ordered = [...campaigns].sort((left, right) => {
    const rank = (one: SnapshotCampaign): number =>
      one.stalled ? 0 : one.complete && one.ledgered ? 1 : 2;
    const byRank = rank(left) - rank(right);
    return byRank !== 0 ? byRank : left.progress - right.progress;
  });
  return ordered.flatMap((one) => {
    const width = Math.max(0, ...one.objectives.map((objective) => objective.id.length));
    return [
      `  ${one.id}  ${percent(one.progress).padStart(4)}  ${String(one.count).padStart(5)} left` +
        (one.owner === undefined ? "" : `  ${one.owner}`) +
        (state(one) === "" ? "" : `  ${state(one)}`),
      ...(one.phases.length === 0
        ? []
        : [
            `    phases: ${one.phases
              .map(
                (phase) =>
                  `${phase.id}${phase.defined ? (phase.attested ? " (attested)" : "") : " (open)"} ${String(phase.sectors)}`,
              )
              .join(" → ")}` +
              (one.legacy.files > 0 ? `  · legacy ${count(one.legacy.files, "file")}` : ""),
          ]),
      ...one.objectives.map((objective) =>
        objective.measure !== undefined
          ? `    ${objective.id.padEnd(width)}  ${percent(objective.progress).padStart(4)}  measures ${String(objective.measure.value)}, held to ${String(objective.measure.recorded)}` +
            (objective.measure.target === null
              ? ""
              : `, target ${String(objective.measure.target)}`) +
            (objective.ledgered ? "" : "  no ledger")
          : `    ${objective.id.padEnd(width)}  ${percent(objective.progress).padStart(4)}  ${String(objective.count).padStart(5)} left` +
            `  ${String(objective.cleared)} cleared  ${String(objective.allowed)} conceded` +
            (objective.closed > 0 ? `  ${String(objective.closed)} closed` : "") +
            (objective.ledgered ? "" : "  no ledger"),
      ),
    ];
  });
};

// ---------------------------------------------------------------------------
// Writing the ledgers

// The author of a concession: `--by`, else git's user.email, else the
// GIT_AUTHOR_EMAIL the environment carries. Without one the record is
// refused rather than written blank, since the record is the point.
export const authorOf = (given: string | undefined): string | null => {
  if (given !== undefined && given !== "") return given;
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email !== "") return email;
  } catch {
    // git absent, or no email configured
  }
  const fromEnvironment = process.env.GIT_AUTHOR_EMAIL;
  return fromEnvironment === undefined || fromEnvironment === "" ? null : fromEnvironment;
};

export type ConcedeOutcome = {
  readonly objective: string;
  readonly conceded: ReadonlyArray<{ sector: string; entry: string }>;
  readonly left: ReadonlyArray<{ sector: string; entry: string }>;
};

// `concede`: the unrecorded hits join the ledger, each sector's with a
// concession naming the reason and the author. `chosen` narrows to some.
export const concede = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objectiveId: string,
  chosen: ReadonlyArray<string> | null,
  sector: string | null,
  record: { at: number; by: string; reason: string },
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;
  const objective = rule.objectives.find((one) => one.id === objectiveId);
  if (objective === undefined)
    return Result.fail(`no objective of ${rule.id} is named "${objectiveId}"`);
  if (objective.measure !== null) {
    if (chosen !== null) {
      return Result.fail(
        `${rule.id}/${objectiveId} is a scalar objective: it has no holdouts to choose among. Narrow with --sector.`,
      );
    }
    return concedeMeasure(policy, evaluation, objective, sector, record);
  }
  let ledger = ledgerOf(policy, rule, objective);
  if (ledger === undefined) {
    return Result.fail(
      `objective ${rule.id}/${objectiveId} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
    );
  }
  const counted = hitsInWindow(evaluation);
  const unrecorded: Array<{ sector: string; entry: string }> = [];
  for (const [name, state] of evaluation.sectors) {
    if (!state.inWindow.some((one) => one.id === objective.id)) continue;
    if (sector !== null && name !== sector) continue;
    const entries = entriesOf(counted, objective.id, name);
    for (const entry of reconcileSector(ledger, name, entries, objective.unit).unrecorded) {
      unrecorded.push({ sector: name, entry });
    }
  }
  const wanted =
    chosen === null
      ? unrecorded
      : unrecorded.filter(
          (one) => chosen.includes(one.entry) || chosen.includes(`${one.sector}:${one.entry}`),
        );
  if (chosen !== null) {
    const unknown = chosen.filter(
      (one) => !unrecorded.some((two) => two.entry === one || `${two.sector}:${two.entry}` === one),
    );
    if (unknown.length > 0) {
      return Result.fail(
        `these are not unrecorded hits of ${rule.id}/${objectiveId}: ${unknown.join(", ")}`,
      );
    }
  }
  const bySector = new Map<string, Array<string>>();
  for (const one of wanted)
    bySector.set(one.sector, [...(bySector.get(one.sector) ?? []), one.entry]);
  for (const [name, entries] of bySector) ledger = concededSector(ledger, name, entries, record);
  if (wanted.length > 0) {
    writeJson(
      policy.repoRoot,
      ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
      serializeLedger(ledger),
    );
  }
  return Result.succeed({
    objective: objectiveId,
    conceded: wanted,
    left: unrecorded.filter((one) => !wanted.includes(one)),
  });
};

// `concede` for a scalar objective: each sector in window whose value is
// worse than its record past the tolerance is held to its value from now,
// with a concession naming the reason and the author. A sector the ledger
// has not recorded is `clear`'s to enter first.
export const concedeMeasure = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  sector: string | null,
  record: { at: number; by: string; reason: string },
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;
  let ledger = measureLedgerOf(policy, rule, objective);
  if (ledger === undefined) {
    return Result.fail(
      `objective ${rule.id}/${objective.id} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
    );
  }
  const conceded: Array<{ sector: string; entry: string }> = [];
  const left: Array<{ sector: string; entry: string }> = [];
  for (const [name, state] of evaluation.sectors) {
    if (!state.inWindow.some((one) => one.id === objective.id)) continue;
    const value = state.values[objective.id] ?? Number.NaN;
    const standing = Number.isNaN(value)
      ? "unmeasured"
      : measureStandingOf(ledger, name, value, objective.tolerance);
    if (standing !== "breached") continue;
    const from = ledger.sectors[name]?.recorded ?? value;
    const entry = `${String(from)} → ${String(value)}`;
    if (sector !== null && name !== sector) {
      left.push({ sector: name, entry });
      continue;
    }
    ledger = concededMeasure(ledger, name, value, record);
    conceded.push({ sector: name, entry });
  }
  if (conceded.length > 0) {
    writeJson(
      policy.repoRoot,
      ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
      serializeMeasureLedger(ledger),
    );
  }
  return Result.succeed({ objective: objective.id, conceded, left });
};

// `attest`: a step no detector sees is recorded done for a sector — with a
// reason and evidence — and only while the sector stands at that phase, so
// it cannot be recorded ahead and passed through on arrival.
export const attest = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  sector: string,
  phaseId: string,
  entry: { reason: string; evidence: string | undefined; by: string },
): Result.Result<string, string> => {
  const { rule } = evaluation;
  const state = evaluation.sectors.get(sector);
  if (state === undefined)
    return Result.fail(`campaign ${rule.id} has no sector named "${sector}"`);
  const phase = rule.phases.find((one) => one.id === phaseId);
  if (phase === undefined) return Result.fail(`campaign ${rule.id} has no phase "${phaseId}"`);
  if (!phase.attested)
    return Result.fail(
      `phase ${phaseId} is not an attested phase; its objectives decide when a sector leaves it.`,
    );
  const current = phaseIdOf(rule, state.phase);
  if (current !== phaseId) {
    return Result.fail(
      `sector ${sector} stands at ${current ?? "the end"}, not ${phaseId}. An attestation is accepted only while the sector is at that phase.`,
    );
  }
  const before = recordOf(policy, rule, sector) ?? EMPTY_SECTOR_RECORD(rule.id, sector, policy.now);
  const after = attestedRecord(before, {
    phase: phaseId,
    reason: entry.reason,
    ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
    at: policy.now,
    by: entry.by,
  });
  writeJson(
    policy.repoRoot,
    sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector),
    serializeSectorRecord(after),
  );
  return Result.succeed(sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector));
};

// `note`: a dated remark for the next person or agent to touch the sector,
// recorded under the phase it was left at.
export const note = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  sector: string,
  text: string,
  by: string,
): Result.Result<string, string> => {
  const { rule } = evaluation;
  const state = evaluation.sectors.get(sector);
  if (state === undefined)
    return Result.fail(`campaign ${rule.id} has no sector named "${sector}"`);
  const before = recordOf(policy, rule, sector) ?? EMPTY_SECTOR_RECORD(rule.id, sector, policy.now);
  const after = notedRecord(before, {
    phase: phaseIdOf(rule, state.phase),
    text,
    by,
    at: policy.now,
  });
  writeJson(
    policy.repoRoot,
    sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector),
    serializeSectorRecord(after),
  );
  return Result.succeed(sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector));
};

// ---------------------------------------------------------------------------
// History

export type HistoryRow = {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
  // Holdouts per objective, as the ledgers stood after the commit; for a
  // scalar, the value its open sectors were held to.
  readonly counts: Readonly<Record<string, number>>;
  readonly planChanged: boolean;
};

// The series replayed from the ledgers' and the manifest's git history:
// a step function of human actions — every `clear`, `concede`, `attest`,
// `note` and plan edit — annotated where the plan changed.
export const historyOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  since: string | null,
  manifestPaths: ReadonlyArray<string>,
): ReadonlyArray<HistoryRow> => {
  const dir = `${campaignsOf(policy).ledgerDir}/${rule.id}`;
  const legacy = `${campaignsOf(policy).ledgerDir}/${rule.id}.json`;
  const commits = commitsTouching(policy.repoRoot, [dir, legacy, ...manifestPaths], since);
  return commits.map((commit: Commit) => {
    const counts: Record<string, number> = {};
    for (const objective of rule.objectives) {
      const text =
        textAt(
          policy.repoRoot,
          commit.sha,
          ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
        ) ?? (rule.objectives.length === 1 ? textAt(policy.repoRoot, commit.sha, legacy) : null);
      if (text === null) continue;
      try {
        const raw = JSON.parse(text) as {
          kind?: string;
          sectors?: Record<
            string,
            { holdouts?: Array<unknown>; recorded?: number; closed?: number | null }
          >;
          entries?: Array<unknown>;
        };
        // A scalar's column is what its open sectors were held to.
        counts[objective.id] =
          raw.kind === "measure"
            ? Math.round(
                Object.values(raw.sectors ?? {})
                  .filter((one) => one.closed === null || one.closed === undefined)
                  .reduce((sum, one) => sum + (one.recorded ?? 0), 0) * 1e6,
              ) / 1e6
            : (raw.entries?.length ??
              Object.values(raw.sectors ?? {}).reduce(
                (sum, one) => sum + (one.holdouts?.length ?? 0),
                0,
              ));
      } catch {
        // an unreadable ledger at that commit contributes nothing
      }
    }
    return {
      sha: commit.sha.slice(0, 10),
      at: commit.at,
      subject: commit.subject,
      counts,
      planChanged: commit.files.some((file) => manifestPaths.includes(file)),
    };
  });
};

export const renderHistory = (
  rule: CompiledCampaign,
  rows: ReadonlyArray<HistoryRow>,
): ReadonlyArray<string> => {
  if (rows.length === 0)
    return [`${rule.id}: no history — no commit has touched its ledgers or the manifest.`];
  const width = Math.max(...rule.objectives.map((one) => one.id.length), 4);
  return [
    `${rule.id}: ${count(rows.length, "commit")}`,
    "",
    `  ${"when".padEnd(10)}  ${"sha".padEnd(10)}  ${rule.objectives.map((one) => one.id.padStart(width)).join("  ")}  plan`,
    ...rows.map(
      (row) =>
        `  ${row.at.slice(0, 10)}  ${row.sha}  ${rule.objectives
          .map((one) => String(row.counts[one.id] ?? "·").padStart(width))
          .join("  ")}  ${row.planChanged ? "changed" : ""}  ${row.subject}`,
    ),
  ];
};

// ---------------------------------------------------------------------------
// The explain paragraph

export const explainCampaignLines = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  file: string,
): ReadonlyArray<string> => {
  const { rule } = evaluation;
  const sector = evaluation.index.sectorOf(file);
  if (sector === null) return [];
  const state = evaluation.sectors.get(sector);
  if (state === undefined) return [];
  const phase = rule.phases[state.phase];
  const at =
    rule.phases.length === 0
      ? ""
      : ` — phase ${phase?.id ?? "done"} (${String(state.phase + 1)} of ${String(rule.phases.length)}${phase !== undefined && isOpenPhase(phase) ? ", open" : phase?.attested === true ? ", attested" : ""})`;
  const own = hitsInWindow(evaluation)
    .filter((hit) => hit.sector === sector && hit.violation.file === file)
    .sort((a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0));
  const firing = new Set(own.map((hit) => hit.objective));
  const record = recordOf(policy, rule, sector);
  return [
    `    ${rule.name}: sector ${sector}${at}${record?.reached === undefined || record.reached === null ? "" : `, reached ${record.reached}`}`,
    ...(phase?.intent === undefined ? [] : [`      intent: ${phase.intent}`]),
    ...(phase?.attested === true
      ? [
          `      attested, not detected: architecture campaigns attest ${sector} ${phase.id} --reason "…" --campaign ${rule.id}`,
        ]
      : []),
    `      in window: ${state.inWindow.length === 0 ? "(nothing)" : state.inWindow.map((one) => `${one.id}${firing.has(one.id) ? " ✗" : ""}`).join(", ")}`,
    ...state.inWindow
      .filter((one) => one.measure !== null)
      .map((one) => {
        const recorded = measureLedgerOf(policy, rule, one)?.sectors[sector];
        return `      ${one.id}: the sector measures ${describeValue(state.values[one.id] ?? Number.NaN)}${recorded === undefined || recorded.closed !== null ? ", unrecorded" : `, held to ${String(recorded.recorded)}`}${one.target === null ? "" : `, target ${String(one.target)}`}`;
      }),
    ...(own.length === 0
      ? []
      : [
          `      nearest holdouts in this file:`,
          ...own
            .slice(0, HOLDOUT_CAP)
            .map(
              (hit) =>
                `        ${hit.range === undefined ? "" : `:${String(hit.range.start.line + 1)}  `}${hit.objective}${hit.violation.subject === null ? "" : `  ${hit.violation.subject}`}`,
            ),
        ]),
  ];
};

export { readDiff };
