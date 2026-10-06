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
  type SourceFacts,
  surfaceRulesSelecting,
  type Violation,
} from "@goodbones/core";
import * as Result from "effect/Result";

import { type CampaignEvaluation, evaluateCampaign } from "../core/campaign-state.js";
import {
  type CampaignInput,
  type CompiledCampaign,
  detectorOf,
  measureDetectorsOf,
  needsSyntax,
} from "../core/campaigns.js";
import {
  attestedRecord,
  EMPTY_SECTOR_RECORD,
  ledgerPathOf,
  notedRecord,
  sectorRecordPathOf,
  serializeSectorRecord,
} from "../core/ledger.js";
import { type Sector } from "../core/sectors.js";
import type { PhaseRule } from "../domain/config.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";
import { lowerEndState } from "../manifest/lower.js";
import { type Commit, commitsTouching, gitEnv, readDiff, textAt } from "./diff.js";
import { count, phaseIdOf, recordOf, writeJson } from "./ledgers.js";
import { commandValues } from "./measure-command.js";

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
  if (Result.isFailure(after)) return Result.fail(after.failure);
  const at = sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector);
  writeJson(policy.repoRoot, at, serializeSectorRecord(after.success));
  return Result.succeed(at);
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

export { readDiff };
