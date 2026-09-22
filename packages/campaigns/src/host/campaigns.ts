import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  listSourceFiles,
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

import {
  type CampaignEvaluation,
  evaluateCampaign,
  hitsInWindow,
  type ObjectiveHit,
  towardNextOf,
} from "../core/campaign-state.js";
import {
  type CampaignInput,
  type CompiledCampaign,
  type CompiledObjective,
  detectorOf,
  needsSyntax,
} from "../core/campaigns.js";
import {
  attestedRecord,
  clearedSector,
  concededSector,
  EMPTY_LEDGER,
  EMPTY_SECTOR_RECORD,
  isComplete,
  isStalled,
  lastClearedOf,
  type Ledger,
  ledgerArithmeticHolds,
  ledgerPathOf,
  notedRecord,
  planDiffOf,
  planOf,
  planPathOf,
  progressOf,
  reachedRecord,
  rebaselinedSector,
  reconcileSector,
  sectorArithmeticHolds,
  sectorClockOf,
  type SectorRecord,
  sectorRecordPathOf,
  serializeLedger,
  serializePlanRecord,
  serializeSectorRecord,
} from "../core/ledger.js";
import {
  compareResidue,
  type Direction,
  isDefinedPhase,
  isOpenPhase,
  onTouchOf,
  type Residue as ResidueVector,
  worsened,
} from "../core/phases.js";
import { LEGACY_SECTOR, parseSectorMarker, type Sector } from "../core/sectors.js";
import type { OnTouch, PhaseRule } from "../domain/config.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";
import { lowerEndState } from "../manifest/lower.js";
import {
  type Commit,
  commitOf,
  commitsTouching,
  type Diff,
  distanceToHunks,
  materializeTree,
  readDiff,
  textAt,
} from "./diff.js";

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
  return campaignsOf(policy).campaignRules.map((rule) => {
    const detectors = [
      ...rule.objectives.flatMap((one) => {
        const detect = detectorOf(one);
        return detect === null ? [] : [detect];
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
      recordOf: (sector: string) => campaignsOf(policy).sectorRecords.get(ledgerKeyOf(rule.id, sector)),
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

const ledgerOf = (policy: LoadedPolicy, rule: CompiledCampaign, objective: CompiledObjective) =>
  campaignsOf(policy).ledgers.get(ledgerKeyOf(rule.id, objective.id));

const recordOf = (policy: LoadedPolicy, rule: CompiledCampaign, sector: string) =>
  campaignsOf(policy).sectorRecords.get(ledgerKeyOf(rule.id, sector));

const phaseIdOf = (rule: CompiledCampaign, phase: number): string | null =>
  rule.phases[phase]?.id ?? null;

// ---------------------------------------------------------------------------
// The report `check` reads

export type SectorObjectiveReport = {
  readonly sector: string;
  readonly count: number;
  // Entries the ledger does not carry — unrecorded growth.
  readonly new: ReadonlyArray<string>;
  // Holdouts no entry produces — cleared, and waiting for `clear`.
  readonly stale: ReadonlyArray<string>;
  readonly drifted: number;
  // The sector is in the objective's window and the ledger has not seen it.
  readonly unrecorded: boolean;
  readonly arithmetic: boolean;
};

export type ObjectiveReport = {
  readonly id: string;
  readonly count: number;
  readonly ledgered: boolean;
  readonly sectors: ReadonlyArray<SectorObjectiveReport>;
};

export type SectorReport = {
  readonly name: string;
  readonly phase: string | null;
  readonly reached: string | null;
  readonly files: number;
  readonly residue: ResidueVector;
};

export type CampaignReport = {
  readonly id: string;
  // Holdouts in window, every objective and sector summed.
  readonly count: number;
  readonly new: ReadonlyArray<{ objective: string; sector: string; entry: string }>;
  readonly stale: ReadonlyArray<{ objective: string; sector: string; entry: string }>;
  readonly drifted: number;
  // No ledger for an objective with hits, or a sector in window the ledger
  // has not seen: `objectives clear` has not been run.
  readonly missingLedger: boolean;
  readonly arithmetic: boolean;
  readonly complete: boolean;
  readonly stalled: boolean;
  readonly onComplete: "keep" | "remove";
  readonly objectives: ReadonlyArray<ObjectiveReport>;
  readonly sectors: ReadonlyArray<SectorReport>;
  // Files two sectors claim.
  readonly drift: ReadonlyArray<{ readonly file: string; readonly sectors: ReadonlyArray<string> }>;
  readonly plan: {
    refined: ReadonlyArray<string>;
    changed: ReadonlyArray<string>;
    unreceipted: ReadonlyArray<string>;
  };
};

const entriesOf = (
  hits: ReadonlyArray<ObjectiveHit>,
  objective: string,
  sector: string,
): ReadonlyArray<string> =>
  hits
    .filter((hit) => hit.objective === objective && hit.sector === sector)
    .map((hit) => hit.entry);

const sectorNames = (evaluation: CampaignEvaluation): ReadonlyArray<string> => [
  ...evaluation.sectors.keys(),
];

export const campaignReportsOf = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ReadonlyArray<CampaignReport> =>
  evaluations.map((evaluation) => {
    const { rule } = evaluation;
    const counted = hitsInWindow(evaluation);
    let missingLedger = false;
    const objectives: Array<ObjectiveReport> = rule.objectives.map((objective) => {
      const ledger = ledgerOf(policy, rule, objective);
      const sectors: Array<SectorObjectiveReport> = [];
      for (const name of sectorNames(evaluation)) {
        const state = evaluation.sectors.get(name);
        if (state === undefined) continue;
        const inWindow = state.inWindow.some((one) => one.id === objective.id);
        const entries = entriesOf(counted, objective.id, name);
        const recorded = ledger?.sectors[name] !== undefined;
        if (!inWindow) {
          // Past the window: what the ledger still carries is closed by
          // `clear`, and nothing here counts.
          const carried = ledger?.sectors[name]?.holdouts ?? [];
          if (ledger !== undefined && carried.length > 0) {
            sectors.push({
              sector: name,
              count: 0,
              new: [],
              stale: carried,
              drifted: 0,
              unrecorded: false,
              arithmetic: sectorArithmeticHolds(ledger, name),
            });
          }
          continue;
        }
        if (ledger === undefined || !recorded) {
          if (entries.length > 0 || ledger !== undefined) missingLedger = true;
          sectors.push({
            sector: name,
            count: entries.length,
            new: [...new Set(entries)].sort(),
            stale: [],
            drifted: 0,
            unrecorded: true,
            arithmetic: true,
          });
          continue;
        }
        const state_ = reconcileSector(ledger, name, entries, objective.unit);
        sectors.push({
          sector: name,
          count: entries.length,
          new: state_.unrecorded,
          stale: state_.stale,
          drifted: state_.drifted.length,
          unrecorded: false,
          arithmetic: sectorArithmeticHolds(ledger, name),
        });
      }
      // Sectors the ledger carries that the code no longer births: closed
      // on the next `clear`, stale until then.
      for (const name of Object.keys(ledger?.sectors ?? {})) {
        if (evaluation.sectors.has(name)) continue;
        const holdouts = ledger?.sectors[name]?.holdouts ?? [];
        if (holdouts.length === 0) continue;
        sectors.push({
          sector: name,
          count: 0,
          new: [],
          stale: holdouts,
          drifted: 0,
          unrecorded: false,
          arithmetic: true,
        });
      }
      return {
        id: objective.id,
        count: sectors.reduce((sum, one) => sum + one.count, 0),
        ledgered: ledger !== undefined,
        sectors,
      };
    });
    const flat = (pick: (one: SectorObjectiveReport) => ReadonlyArray<string>) =>
      objectives.flatMap((objective) =>
        objective.sectors.flatMap((one) =>
          pick(one).map((entry) => ({ objective: objective.id, sector: one.sector, entry })),
        ),
      );
    const ledgers = rule.objectives.flatMap((objective) => {
      const ledger = ledgerOf(policy, rule, objective);
      return ledger === undefined ? [] : [ledger];
    });
    const sectorClock = [...evaluation.sectors.keys()]
      .map((name) => recordOf(policy, rule, name))
      .filter((one): one is SectorRecord => one !== undefined)
      .map(sectorClockOf)
      .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
    const count = objectives.reduce((sum, one) => sum + one.count, 0);
    return {
      id: rule.id,
      count,
      new: flat((one) => one.new),
      stale: flat((one) => one.stale),
      drifted: objectives.reduce(
        (sum, one) => sum + one.sectors.reduce((inner, two) => inner + two.drifted, 0),
        0,
      ),
      missingLedger,
      arithmetic: ledgers.every(ledgerArithmeticHolds),
      complete: count === 0 && ledgers.every(isComplete),
      stalled:
        ledgers.length > 0 &&
        ledgers.some((ledger) => isStalled(rule, ledger, policy.now, sectorClock)),
      onComplete: rule.onComplete,
      objectives,
      sectors: [...evaluation.sectors.values()].map((state) => ({
        name: state.name,
        phase: phaseIdOf(rule, state.phase),
        reached: recordOf(policy, rule, state.name)?.reached ?? null,
        files: state.sector.files.length,
        residue: state.residue,
      })),
      drift: evaluation.index.drift,
      plan: planDiffOf(rule, campaignsOf(policy).plans.get(rule.id)),
    };
  });

// Which hits in window are carried by a ledger, exactly or by anchor.
export const ledgeredFilter = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ((hit: ObjectiveHit) => boolean) => {
  const carried = new Set<ObjectiveHit>();
  for (const evaluation of evaluations) {
    const { rule } = evaluation;
    for (const objective of rule.objectives) {
      const ledger = ledgerOf(policy, rule, objective);
      if (ledger === undefined) continue;
      for (const name of sectorNames(evaluation)) {
        const own = hitsInWindow(evaluation).filter(
          (hit) => hit.objective === objective.id && hit.sector === name,
        );
        const { ledgered } = reconcileSector(
          ledger,
          name,
          own.map((hit) => hit.entry),
          objective.unit,
        );
        const known = new Set(ledgered);
        for (const hit of own) if (known.has(hit.entry)) carried.add(hit);
      }
    }
  }
  return (hit) => carried.has(hit);
};

// Why a campaign report is not ok, in the order `check` explains it.
export const campaignFailuresOf = (
  campaigns: ReadonlyArray<CampaignReport>,
): ReadonlyArray<string> => [
  ...campaigns
    .filter((one) => one.drift.length > 0)
    .map((one) => `campaign ${one.id}: a file is in two sectors`),
  ...campaigns
    .filter((one) => one.plan.unreceipted.length > 0)
    .map((one) => `campaign ${one.id}: a defined phase changed without a concession`),
  ...campaigns.filter((one) => one.stale.length > 0).map(() => "stale ledger entries"),
  ...campaigns.filter((one) => !one.arithmetic).map(() => "ledger arithmetic does not hold"),
  ...campaigns.filter((one) => one.missingLedger).map((one) => `campaign ${one.id} has no ledger`),
  ...campaigns
    .filter((one) => !one.missingLedger && one.new.length > 0)
    .map(() => "unrecorded campaign growth"),
  ...campaigns
    .filter((one) => one.complete && !one.missingLedger && one.onComplete === "remove")
    .map((one) => `campaign ${one.id} is complete and declared onComplete: remove`),
];

const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${String(n)} ${n === 1 ? noun : plural}`;

// A campaign's failures, as `check` prints them, with the command that
// answers each.
export const renderCampaignReports = (
  reports: ReadonlyArray<CampaignReport>,
  hits: ReadonlyArray<{
    readonly violation: Violation;
    readonly objective: string;
    readonly sector: string;
    readonly entry: string;
    readonly ledgered: boolean;
  }>,
): ReadonlyArray<string> =>
  reports.flatMap((campaign): ReadonlyArray<string> => {
    const lines: Array<string> = [];
    const say = (...more: ReadonlyArray<string>): void => {
      for (const one of more) lines.push(one);
    };
    const at = (objective: string, sector: string, entry: string): string =>
      `  ${objective} · ${sector} · ${entry}`;
    if (campaign.drift.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.drift.length, "file is", "files are")} in two sectors. A perimeter nests another; narrow one:`,
        ...campaign.drift.map((one) => `  ${one.file}  (${one.sectors.join(", ")})`),
      );
    }
    if (campaign.plan.unreceipted.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.plan.unreceipted.length, "defined phase")} changed since the last clear with no concession: ${campaign.plan.unreceipted.join(", ")}. Add a \`concessions\` entry to the phase with a reason and a date, then run \`objectives clear\`.`,
      );
    }
    if (campaign.missingLedger) {
      const unrecorded = campaign.objectives.flatMap((objective) =>
        objective.sectors
          .filter((one) => one.unrecorded && (one.count > 0 || objective.ledgered))
          .map((one) => `  ${objective.id} · ${one.sector}  (${count(one.count, "hit")})`),
      );
      say(
        "",
        `campaign ${campaign.id}: ${count(unrecorded.length, "sector")} in an objective's window that no ledger has seen. Record them before they count as growth:`,
        ...unrecorded,
        "",
        `  architecture objectives clear ${campaign.id}`,
      );
    }
    if (campaign.new.length > 0 && !campaign.missingLedger) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.new.length, "new hit")} the ledger does not carry. Fix them, or record why the count may rise:`,
        ...campaign.new.flatMap((one) => {
          const hit = hits.find(
            (two) =>
              two.objective === one.objective &&
              two.sector === one.sector &&
              two.entry === one.entry,
          );
          return [
            at(one.objective, one.sector, one.entry),
            ...(hit === undefined ? [] : [`      ${hit.violation.file}: ${hit.violation.message}`]),
          ];
        }),
        "",
        `  architecture objectives concede ${campaign.id} --reason "<why>"`,
      );
    }
    if (campaign.stale.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.stale.length, "ledger entry", "ledger entries")} no longer fire, or fire past their window. The code was fixed, or the sector moved on; clear them:`,
        ...campaign.stale.map((one) => at(one.objective, one.sector, one.entry)),
        "",
        `  architecture objectives clear ${campaign.id}`,
      );
    }
    if (!campaign.arithmetic) {
      say(
        "",
        `campaign ${campaign.id}: a ledger does not add up (holdouts ≠ initial + conceded − cleared − closed). A holdout was added by hand; remove it, or record it with \`objectives concede\`.`,
      );
    }
    const complete = campaign.complete && !campaign.missingLedger;
    if (complete && campaign.onComplete === "remove") {
      say(
        "",
        `campaign ${campaign.id} is complete and declares onComplete: remove. Delete it from the manifest, and its ledgers.`,
      );
    }
    if (campaign.stalled) {
      say(
        "",
        `notice: campaign ${campaign.id} has stalled — nothing has left a ledger, and no sector has been attested or noted, within its staleAfter.`,
      );
    }
    if (complete && campaign.onComplete === "keep") {
      say("", `notice: campaign ${campaign.id} is complete, and stays as a guard.`);
    }
    if (campaign.plan.changed.length > 0 && campaign.plan.unreceipted.length === 0) {
      say(
        "",
        `notice: campaign ${campaign.id}: plan changed — ${campaign.plan.changed.join(", ")} (receipted; the next clear re-baselines the sectors in window).`,
      );
    }
    if (campaign.plan.refined.length > 0) {
      say(
        "",
        `notice: campaign ${campaign.id}: plan refined — ${campaign.plan.refined.join(", ")}.`,
      );
    }
    return lines;
  });

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
    const objectives = rule.objectives.map((objective, j) => {
      const ledger = ledgers[j];
      const own = report.objectives[j];
      const phase = rule.phases.find((one) => one.objectives.includes(objective.id))?.id ?? null;
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
          legacy === undefined ? 0 : Object.values(legacy.residue).reduce((a, b) => a + b, 0),
      },
      plan: report.plan,
      stalled: report.stalled,
      complete: report.complete,
      onComplete: rule.onComplete,
      ledgered: ledgers.every((one) => one !== undefined),
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
                (phase) => `${phase.id}${phase.defined ? "" : " (open)"} ${String(phase.sectors)}`,
              )
              .join(" → ")}` +
              (one.legacy.files > 0 ? `  · legacy ${count(one.legacy.files, "file")}` : ""),
          ]),
      ...one.objectives.map(
        (objective) =>
          `    ${objective.id.padEnd(width)}  ${percent(objective.progress).padStart(4)}  ${String(objective.count).padStart(5)} left` +
          `  ${String(objective.cleared)} cleared  ${String(objective.allowed)} conceded` +
          (objective.closed > 0 ? `  ${String(objective.closed)} closed` : "") +
          (objective.ledgered ? "" : "  no ledger"),
      ),
    ];
  });
};

// ---------------------------------------------------------------------------
// Writing the ledgers

const writeJson = (repoRoot: string, at: string, text: string): void => {
  const absolute = path.resolve(repoRoot, at);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
};

// The author of a concession: `--by`, else git's user.email, else the
// GIT_AUTHOR_EMAIL the environment carries. Without one the record is
// refused rather than written blank, since the record is the point.
export const authorOf = (given: string | undefined): string | null => {
  if (given !== undefined && given !== "") return given;
  try {
    const email = execFileSync("git", ["config", "user.email"], {
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

export type ClearOutcome = {
  readonly campaign: string;
  readonly objective: string;
  readonly cleared: number;
  readonly rewritten: number;
  readonly closed: number;
  readonly entered: ReadonlyArray<string>;
  readonly rebaselined: ReadonlyArray<string>;
  readonly left: number;
};

// `clear`: the ledger reconciled with the code wherever that is not a
// regression. Stale holdouts leave and drifted ones are rewritten; a sector
// newly in an objective's window is recorded with its initial; a sector
// past a window has its holdouts closed; a phase concession authorizes a
// re-baseline of the sectors in that phase's window; the furthest phase
// each sector has reached is recorded, and so is the plan. Unrecorded
// growth is left where it is — `concede` is the one way it enters.
export const clear = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  only: string | null,
  by: string,
): ReadonlyArray<ClearOutcome> => {
  const { rule } = evaluation;
  const counted = hitsInWindow(evaluation);
  const plan = planDiffOf(rule, campaignsOf(policy).plans.get(rule.id));
  const outcomes: Array<ClearOutcome> = [];
  for (const objective of rule.objectives) {
    if (only !== null && objective.id !== only) continue;
    const before =
      ledgerOf(policy, rule, objective) ?? EMPTY_LEDGER(rule.id, objective.id, policy.now);
    let ledger = before;
    const entered: Array<string> = [];
    const rebaselined: Array<string> = [];
    const phase = rule.phases.find((one) => one.objectives.includes(objective.id));
    // The phase naming the objective, when it changed with a receipt.
    const receipted =
      phase !== undefined && plan.changed.includes(phase.id) && !plan.unreceipted.includes(phase.id)
        ? phase
        : null;
    let rewritten = 0;
    for (const [name, state] of evaluation.sectors) {
      const inWindow = state.inWindow.some((one) => one.id === objective.id);
      const entries = entriesOf(counted, objective.id, name);
      if (!inWindow) {
        ledger = clearedSector(ledger, name, entries, objective.unit, policy.now, "outside");
        continue;
      }
      if (ledger.sectors[name] === undefined) entered.push(name);
      else rewritten += reconcileSector(ledger, name, entries, objective.unit).drifted.length;
      if (receipted !== null && ledger.sectors[name] !== undefined) {
        const concession = receipted.concessions.at(-1);
        const next = rebaselinedSector(ledger, name, entries, {
          at: policy.now,
          by,
          reason: `phase ${receipted.id} changed: ${concession?.reason ?? ""}`,
        });
        if (next !== ledger) rebaselined.push(name);
        ledger = next;
        continue;
      }
      ledger = clearedSector(ledger, name, entries, objective.unit, policy.now, "inside");
    }
    // Sectors the code no longer births are past every window.
    for (const name of Object.keys(ledger.sectors)) {
      if (!evaluation.sectors.has(name)) {
        ledger = clearedSector(ledger, name, [], objective.unit, policy.now, "outside");
      }
    }
    const sum = (one: Ledger, pick: (sector: Ledger["sectors"][string]) => number): number =>
      Object.values(one.sectors).reduce((total, sector) => total + pick(sector), 0);
    outcomes.push({
      campaign: rule.id,
      objective: objective.id,
      cleared: sum(ledger, (one) => one.cleared) - sum(before, (one) => one.cleared),
      rewritten,
      closed: sum(ledger, (one) => one.closed) - sum(before, (one) => one.closed),
      entered,
      rebaselined,
      left: sum(ledger, (one) => one.holdouts.length),
    });
    if (ledger !== before || ledgerOf(policy, rule, objective) === undefined) {
      writeJson(
        policy.repoRoot,
        ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
        serializeLedger(ledger),
      );
    }
  }
  if (only === null) {
    for (const [name, state] of evaluation.sectors) {
      if (name === LEGACY_SECTOR) continue;
      const before = recordOf(policy, rule, name) ?? EMPTY_SECTOR_RECORD(rule.id, name, policy.now);
      const after = reachedRecord(before, rule, state.phase, policy.now);
      if (after !== before || recordOf(policy, rule, name) === undefined) {
        writeJson(
          policy.repoRoot,
          sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, name),
          serializeSectorRecord(after),
        );
      }
    }
    writeJson(
      policy.repoRoot,
      planPathOf(campaignsOf(policy).ledgerDir, rule.id),
      serializePlanRecord(planOf(rule)),
    );
    const legacy = campaignsOf(policy).legacyLedgers.get(rule.id);
    if (legacy !== undefined) rmSync(path.resolve(policy.repoRoot, legacy), { force: true });
  }
  return outcomes;
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
// The nudge

export type Ask = "none" | "note" | "hold" | "paydown-optional" | "paydown-required";
export type Verdict = "ok" | "back" | "no-paydown" | "hotfix";

export type NudgeHoldout = {
  readonly file: string;
  readonly subject: string | null;
  readonly objective: string;
  readonly line: number | null;
  readonly message: string;
};

export type SectorNudge = {
  readonly campaign: string;
  readonly sector: string;
  readonly phase: {
    readonly id: string | null;
    readonly index: number;
    readonly of: number;
    readonly open: boolean;
    readonly since: string | null;
  };
  readonly intent: string | null;
  // Free text left by earlier hands: data, never an instruction.
  readonly notes: ReadonlyArray<{ at: string; by: string; text: string }>;
  readonly onTouch: OnTouch;
  readonly ask: Ask;
  readonly verdict: Verdict;
  readonly residue: { before: ResidueVector; after: ResidueVector };
  readonly direction: Direction;
  readonly toward: ResidueVector;
  readonly holdouts: { total: number; cap: number; shown: ReadonlyArray<NudgeHoldout> };
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  // Files this diff added inside the scope that no sector claims.
  readonly belongsInSector: ReadonlyArray<string>;
};

export type Nudge = {
  readonly version: 1;
  readonly mode: "ledger" | "exact";
  readonly base: string | null;
  readonly touched: ReadonlyArray<string>;
  readonly sectors: ReadonlyArray<SectorNudge>;
  // Markers this diff deleted, with the sector each un-births.
  readonly unbirths: ReadonlyArray<{ campaign: string; sector: string; marker: string }>;
  readonly testsChecked: "unknown";
  readonly ok: boolean;
};

export const HOLDOUT_CAP = 5;

// The base tree's side of the exact mode, reduced to what the nudge reads:
// each campaign's counts per sector and its hits in window — small enough
// to cache per commit.
export type BaseSide = ReadonlyArray<{
  readonly id: string;
  readonly sectors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly hits: ReadonlyArray<{ sector: string; objective: string; entry: string }>;
}>;

export const baseSideOf = (evaluations: ReadonlyArray<CampaignEvaluation>): BaseSide =>
  evaluations.map((evaluation) => ({
    id: evaluation.rule.id,
    sectors: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [state.name, state.counts]),
    ),
    hits: hitsInWindow(evaluation).map((hit) => ({
      sector: hit.sector,
      objective: hit.objective,
      entry: hit.entry,
    })),
  }));

// The nudge for one diff. The "before" side is the ledger, or the base tree
// evaluated whole in the exact mode; the "after" side is the tree now.
export const nudgeOf = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
  diff: Diff,
  base: BaseSide | null,
  hotfix: string | null,
  by: string | null,
): Nudge => {
  const touched = [...diff.touched.keys()].sort();
  const sectors: Array<SectorNudge> = [];
  const unbirths: Array<{ campaign: string; sector: string; marker: string }> = [];
  let ok = true;
  for (const evaluation of evaluations) {
    const { rule } = evaluation;
    const baseEvaluation = base?.find((one) => one.id === rule.id) ?? null;
    const counted = hitsInWindow(evaluation);
    const perimeter = rule.perimeter;
    if (perimeter?.kind === "marker") {
      for (const file of diff.deleted) {
        if (!perimeter.marker.some((one) => one.test(file))) continue;
        const text = textAt(policy.repoRoot, diff.base ?? "HEAD", file);
        let name = path.basename(path.dirname(file));
        try {
          name = parseSectorMarker(text ?? "")?.name ?? name;
        } catch {
          // unreadable: the folder's name stands
        }
        unbirths.push({ campaign: rule.id, sector: name, marker: file });
      }
    }
    const touchedSectors = new Set<string>();
    const belongs: Array<string> = [];
    for (const file of touched) {
      const sector = evaluation.index.sectorOf(file);
      if (sector === null) continue;
      touchedSectors.add(sector);
      if (sector === LEGACY_SECTOR && diff.added.includes(file)) belongs.push(file);
    }
    for (const name of [...touchedSectors].sort()) {
      const state = evaluation.sectors.get(name);
      if (state === undefined) continue;
      const record = recordOf(policy, rule, name);
      const phase = rule.phases[state.phase];
      const open = phase !== undefined && isOpenPhase(phase);
      const onTouch = onTouchOf(rule, state.phase);
      // Before: the ledger's count per objective in window, or the base tree's.
      const before: Record<string, number> = {};
      for (const objective of state.inWindow) {
        if (baseEvaluation !== null) {
          before[objective.id] = baseEvaluation.sectors[name]?.[objective.id] ?? 0;
        } else {
          before[objective.id] =
            ledgerOf(policy, rule, objective)?.sectors[name]?.holdouts.length ?? 0;
        }
      }
      const after = state.residue;
      const direction = compareResidue(before, after);
      const own = counted.filter((hit) => hit.sector === name);
      const inTouched = own.filter((hit) => diff.touched.has(hit.violation.file));
      const ranked = inTouched
        .map((hit) => {
          const hunks = diff.touched.get(hit.violation.file) ?? [];
          const rank = hit.range === undefined ? (hit.entry === "~" ? 2 : 1) : 0;
          const distance =
            hit.range === undefined
              ? Number.POSITIVE_INFINITY
              : distanceToHunks(hunks, hit.range.start.line + 1, hit.range.end.line + 1);
          return { hit, rank, distance };
        })
        .sort((a, b) =>
          a.rank !== b.rank
            ? a.rank - b.rank
            : a.distance !== b.distance
              ? a.distance - b.distance
              : a.hit.entry.localeCompare(b.hit.entry),
        );
      const sectorLevel = own.filter((hit) => hit.entry === "~");
      const shownSource = [
        ...ranked.map((one) => one.hit),
        ...sectorLevel.filter((hit) => !inTouched.includes(hit)),
      ];
      const shown = shownSource.slice(0, HOLDOUT_CAP).map((hit) => ({
        file: hit.violation.file,
        subject: hit.violation.subject,
        objective: hit.objective,
        line: hit.range === undefined ? null : hit.range.start.line + 1,
        message: hit.violation.message,
      }));
      // What this diff added and removed, among the touched files.
      const added: Array<string> = [];
      const removed: Array<string> = [];
      let editsHoldout = false;
      for (const objective of state.inWindow) {
        const entries = own.filter((hit) => hit.objective === objective.id).map((hit) => hit.entry);
        const ledger = ledgerOf(policy, rule, objective);
        const knownBefore =
          baseEvaluation === null
            ? new Set(ledger?.sectors[name]?.holdouts ?? [])
            : new Set(
                baseEvaluation.hits
                  .filter((hit) => hit.sector === name && hit.objective === objective.id)
                  .map((hit) => hit.entry),
              );
        const state_ =
          ledger === undefined && baseEvaluation === null
            ? {
                unrecorded: entries,
                stale: [] as ReadonlyArray<string>,
                ledgered: [] as ReadonlyArray<string>,
              }
            : baseEvaluation === null && ledger !== undefined
              ? reconcileSector(ledger, name, entries, objective.unit)
              : {
                  unrecorded: entries.filter((entry) => !knownBefore.has(entry)),
                  stale: [...knownBefore].filter((entry) => !entries.includes(entry)),
                  ledgered: entries.filter((entry) => knownBefore.has(entry)),
                };
        for (const entry of state_.unrecorded) {
          const hit = own.find((one) => one.objective === objective.id && one.entry === entry);
          if (hit !== undefined && diff.touched.has(hit.violation.file))
            added.push(`${objective.id}: ${entry}`);
        }
        for (const entry of state_.stale) removed.push(`${objective.id}: ${entry}`);
        for (const hit of inTouched) {
          if (hit.objective !== objective.id || hit.range === undefined) continue;
          if (!knownBefore.has(hit.entry) && !state_.ledgered.includes(hit.entry)) continue;
          const hunks = diff.touched.get(hit.violation.file) ?? [];
          if (distanceToHunks(hunks, hit.range.start.line + 1, hit.range.end.line + 1) === 0)
            editsHoldout = true;
        }
        if (state_.stale.length > 0) editsHoldout = true;
      }
      const back = worsened(before, after);
      const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
      const totalAfter = Object.values(after).reduce((a, b) => a + b, 0);
      let ask: Ask;
      let verdict: Verdict = "ok";
      if (open) ask = "note";
      else if (onTouch === "advise") ask = "none";
      else if (onTouch === "ratchet") {
        ask = "hold";
        if (back.length > 0) verdict = "back";
      } else {
        ask = editsHoldout ? "paydown-required" : "paydown-optional";
        if (back.length > 0) verdict = "back";
        else if (editsHoldout && totalAfter >= totalBefore) verdict = "no-paydown";
      }
      if (verdict !== "ok" && hotfix !== null && by !== null) {
        // The escape: the growth is conceded, with a reason naming the hotfix.
        for (const objective of state.inWindow) {
          const ledger = ledgerOf(policy, rule, objective);
          if (ledger === undefined) continue;
          const entries = own
            .filter((hit) => hit.objective === objective.id)
            .map((hit) => hit.entry);
          const { unrecorded } = reconcileSector(ledger, name, entries, objective.unit);
          if (unrecorded.length === 0) continue;
          writeJson(
            policy.repoRoot,
            ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
            serializeLedger(
              concededSector(ledger, name, unrecorded, {
                at: policy.now,
                by,
                reason: `hotfix: ${hotfix}`,
              }),
            ),
          );
        }
        verdict = "hotfix";
      }
      if (verdict !== "ok" && verdict !== "hotfix") ok = false;
      sectors.push({
        campaign: rule.id,
        sector: name,
        phase: {
          id: phaseIdOf(rule, state.phase),
          index: state.phase,
          of: rule.phases.length,
          open,
          since: record?.since ?? null,
        },
        intent: phase?.intent ?? null,
        notes: (record?.notes ?? [])
          .filter((one) => one.phase === phaseIdOf(rule, state.phase))
          .map((one) => ({ at: one.at, by: one.by, text: one.text })),
        onTouch,
        ask,
        verdict,
        residue: { before, after },
        direction,
        toward: towardNextOf(rule, state),
        holdouts: { total: own.length, cap: HOLDOUT_CAP, shown },
        added: added.sort(),
        removed: removed.sort(),
        belongsInSector: name === LEGACY_SECTOR ? belongs.sort() : [],
      });
    }
  }
  return {
    version: 1,
    mode: base === null ? "ledger" : "exact",
    base: diff.base,
    touched,
    sectors,
    unbirths,
    testsChecked: "unknown",
    ok,
  };
};

const days = (from: string | null, now: number): string => {
  if (from === null) return "";
  const elapsed = Math.floor((now - Date.parse(from)) / 86_400_000);
  return `, ${count(elapsed, "day")} here`;
};

const describeAsk = (ask: Ask): string => {
  switch (ask) {
    case "none":
      return "none — the holdouts above are context; paydown is welcome in its own commit, not asked for";
    case "note":
      return "note";
    case "hold":
      return "hold — leave the sector no worse; paydown is welcome in its own commit, not asked for";
    case "paydown-optional":
      return "paydown-optional — this diff edits no holdout; paydown is welcome in its own commit";
    case "paydown-required":
      return "paydown-required — this diff edits a holdout, so the sector must leave with fewer";
  }
};

export const renderNudge = (nudge: Nudge, now: number): ReadonlyArray<string> => {
  if (nudge.sectors.length === 0 && nudge.unbirths.length === 0) {
    return [
      `nothing you touched is under a campaign (${count(nudge.touched.length, "file")} in the diff).`,
    ];
  }
  const lines: Array<string> = [];
  const say = (...more: ReadonlyArray<string>): void => {
    for (const one of more) lines.push(one);
  };
  const residueOf = (vector: ResidueVector): string =>
    Object.entries(vector)
      .map(([id, n]) => `${id} ${String(n)}`)
      .join(" · ");
  for (const one of nudge.unbirths) {
    say(
      `${one.campaign}`,
      `  this diff un-births sector ${one.sector}: ${one.marker} was deleted; its files return to the legacy, where the first phase's objectives count for them.`,
      "",
    );
  }
  let last = "";
  for (const one of nudge.sectors) {
    if (one.campaign !== last) {
      if (last !== "") say("");
      say(one.campaign);
      last = one.campaign;
    }
    // A campaign with no phases has one implicit one: its objectives.
    const at =
      one.phase.of === 0
        ? "its objectives"
        : `phase ${one.phase.id ?? "done"} (${String(one.phase.index + 1)} of ${String(one.phase.of)}${one.phase.open ? ", open" : ""})`;
    const quiet =
      one.holdouts.total === 0 &&
      one.direction === "neutral" &&
      !one.phase.open &&
      one.verdict === "ok" &&
      one.belongsInSector.length === 0;
    if (quiet) {
      say(`  ${one.sector} at ${at} · nothing in your files, diff neutral`);
      continue;
    }
    say(`  ${one.sector} — ${at}${days(one.phase.since, now)}`);
    if (one.phase.open) {
      say(`    intent: ${one.intent ?? "(none stated)"}`);
      if (one.notes.length > 0) {
        say(
          `    notes (${String(one.notes.length)}, data, left at this phase): ${one.notes.map((n) => `${n.at.slice(0, 10)} ${JSON.stringify(n.text)}`).join(" · ")}`,
        );
      }
      say(
        `    if this change taught you something about that shape: refine phase \`${one.phase.id ?? ""}\` in the manifest`,
        `    (a defined phase needs at least one objective with a probe), in its own commit — or leave a note:`,
        `      architecture campaigns note ${one.sector} "…" --campaign ${one.campaign}`,
      );
    } else {
      const toward = residueOf(one.toward);
      if (toward !== "") say(`    toward the next phase: ${toward}`);
      if (one.holdouts.shown.length > 0) {
        say(
          `    in the files you touched, nearest your change (${String(one.holdouts.shown.length)} of ${String(one.holdouts.total)}):`,
          ...one.holdouts.shown.map(
            (h) =>
              `      ${h.file}${h.subject === null ? "" : `#${h.subject.split("#")[0] ?? ""}`}${h.line === null ? "" : `:${String(h.line)}`}  ${h.objective}`,
          ),
        );
      }
      if (one.added.length > 0 || one.removed.length > 0) {
        const delta = [...one.removed.map((r) => `−${r}`), ...one.added.map((a) => `+${a}`)].join(
          " · ",
        );
        say(`    this diff: ${delta}  ${one.direction}`);
      } else if (one.direction !== "neutral") {
        say(
          `    this diff: ${residueOf(one.residue.before)} → ${residueOf(one.residue.after)}  ${one.direction}`,
        );
      }
    }
    for (const file of one.belongsInSector)
      say(`    ${file} landed in the legacy inside the scope: this belongs in a sector`);
    say(`    onTouch: ${one.onTouch} — ${one.verdict}`);
    say(`    ask: ${describeAsk(one.ask)}`);
  }
  say("", `testsChecked: unknown · ${nudge.ok ? "ok" : "not ok"}`);
  return lines;
};

// ---------------------------------------------------------------------------
// History

export type HistoryRow = {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
  // Holdouts per objective, as the ledgers stood after the commit.
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
          sectors?: Record<string, { holdouts?: Array<unknown> }>;
          entries?: Array<unknown>;
        };
        counts[objective.id] =
          raw.entries?.length ??
          Object.values(raw.sectors ?? {}).reduce(
            (sum, one) => sum + (one.holdouts?.length ?? 0),
            0,
          );
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
      : ` — phase ${phase?.id ?? "done"} (${String(state.phase + 1)} of ${String(rule.phases.length)}${phase !== undefined && isOpenPhase(phase) ? ", open" : ""})`;
  const own = hitsInWindow(evaluation)
    .filter((hit) => hit.sector === sector && hit.violation.file === file)
    .sort((a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0));
  const firing = new Set(own.map((hit) => hit.objective));
  const record = recordOf(policy, rule, sector);
  return [
    `    ${rule.name}: sector ${sector}${at}${record?.reached === undefined || record.reached === null ? "" : `, reached ${record.reached}`}`,
    `      in window: ${state.inWindow.length === 0 ? "(nothing)" : state.inWindow.map((one) => `${one.id}${firing.has(one.id) ? " ✗" : ""}`).join(", ")}`,
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

// ---------------------------------------------------------------------------
// The base tree, for the exact mode

// The campaigns evaluated over the tree at `ref`, through a policy loaded
// from that tree, so `imports`, `requires`, `report` and `fn` terms say what
// the base tree said. A full tool run for a `report`-backed objective, so
// the answer is cached per commit under `node_modules/.cache/goodbones/`.
export const baseSideAt = async (
  policy: LoadedPolicy,
  ref: string,
  roots: ReadonlyArray<string>,
  load: (repoRoot: string) => Promise<LoadedPolicy>,
): Promise<BaseSide> => {
  let sha: string | null = null;
  try {
    sha = commitOf(policy.repoRoot, ref);
  } catch {
    sha = null;
  }
  const cacheAt =
    sha === null
      ? null
      : path.join(policy.repoRoot, "node_modules", ".cache", "goodbones", `base-${sha}.json`);
  if (cacheAt !== null && existsSync(cacheAt)) {
    try {
      return JSON.parse(readFileSync(cacheAt, "utf8")) as BaseSide;
    } catch {
      // an unreadable cache is recomputed
    }
  }
  const tree = materializeTree(policy.repoRoot, ref);
  try {
    const base = await load(tree.root);
    const files = listSourceFiles(tree.root, roots, base.languages, widenedExtensions(base));
    const side = baseSideOf(evaluateCampaigns(base, roots, files));
    if (cacheAt !== null && existsSync(path.join(policy.repoRoot, "node_modules"))) {
      mkdirSync(path.dirname(cacheAt), { recursive: true });
      writeFileSync(cacheAt, JSON.stringify(side));
    }
    return side;
  } finally {
    tree.dispose();
  }
};

export { readDiff };
