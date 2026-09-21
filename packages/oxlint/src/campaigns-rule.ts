import * as path from "node:path";

import {
  type CampaignHit,
  type CampaignInput,
  campaignsSelecting,
  type CompiledCampaign,
  type CompiledObjective,
  derivePhase,
  detectorCandidatesOf,
  detectorOf,
  evaluateObjectives,
  formatMessage,
  ledgerKeyOf,
  LEGACY_PHASE,
  LEGACY_SECTOR,
  type LoadedPolicy,
  membershipOf,
  needsSyntax,
  objectivesInWindow,
  positionOf,
  reconcileSector,
  ReportUnavailable,
  sectorEntryOf,
  type SectorIndex,
} from "@goodbones/core";
import { sourceFactsOf } from "@goodbones/typescript";

import {
  factsOfProgram,
  type OxlintRule,
  type Program,
  type RuleContext,
  toRepoRelative,
} from "./oxlint-api.js";

// The campaigns family, one file at a time: every hit of an objective in
// window for the file's sector that its ledger does not carry, reported at
// the match's position with the objective's `how` as the message. The
// facts come from oxlint's tree through the pack's reader, as the other
// rules read them; the `syntax` term is answered by the same matcher the
// CLI uses, over `sourceCode.text` — "one engine" is this family's parity
// contract, rather than a corpus.
//
// The sector comes from the perimeter on this file (a marker or nx index
// the host built at load, for the two forms that need the other files),
// and the sector's phase from the ledgers — which objectives carry
// holdouts for it, and its record's `reached` and attestations — never
// from a walk. So the plugin's answer is the code as of the last `clear`,
// and the CLI's is the code now; between a fix and its `clear` they
// differ, and `check` fails on the stale holdout until they agree. A
// `has` objective and an end state are never reported here: their holdout
// is the sector, and they reach this file only as the phase they put it at.

// The sectors a host discovered at load, per campaign, for the perimeters
// that need the other files.
export type SectorIndexes = ReadonlyMap<string, SectorIndex>;

const unledgered = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
  root: string,
  hits: ReadonlyArray<CampaignHit>,
): ReadonlyArray<CampaignHit> => {
  const carried = new Set<CampaignHit>();
  const byObjective = new Map<string, Array<CampaignHit>>();
  for (const hit of hits) {
    byObjective.set(hit.objective, [...(byObjective.get(hit.objective) ?? []), hit]);
  }
  for (const [objectiveId, own] of byObjective) {
    const objective = rule.objectives.find((one) => one.id === objectiveId);
    const ledger = policy.ledgers.get(ledgerKeyOf(rule.id, objectiveId));
    if (objective === undefined || ledger === undefined) continue;
    const entries = own.map((hit) => sectorEntryOf(hit.violation, root));
    const known = new Set(reconcileSector(ledger, sector, entries, objective.unit).ledgered);
    own.forEach((hit, i) => {
      if (known.has(entries[i] ?? "")) carried.add(hit);
    });
  }
  return hits.filter((hit) => !carried.has(hit));
};

// The objectives in window for the sector, read off the ledgers. A sector
// no `clear` has placed — no record of it — stands at the first phase, as
// the legacy does, rather than deriving to the end from ledgers that
// carry nothing for it.
const inWindowFor = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
): ReadonlyArray<CompiledObjective> => {
  const record = policy.sectorRecords.get(ledgerKeyOf(rule.id, sector));
  const position = positionOf(rule, record);
  const counts = (objectiveId: string): number =>
    policy.ledgers.get(ledgerKeyOf(rule.id, objectiveId))?.sectors[sector]?.holdouts.length ?? 0;
  const phase =
    sector === LEGACY_SECTOR || record === undefined
      ? Math.min(LEGACY_PHASE, rule.phases.length)
      : derivePhase(rule, counts, position);
  return objectivesInWindow(rule, phase, position).filter((one) => one.detect !== null);
};

// A `report` a campaign names that cannot be read — a command the kernel
// refused to spawn, a file no step wrote — is one fact about the run, not
// one about each file the campaign selects. The live source keeps the
// failure per spec; this keeps which failures have been said, so the first
// selected file carries the notice and the rest stay quiet. Without it, a
// lint of eight hundred files is eight hundred copies of oxlint's generic
// "error running JS plugin", with the cause dropped by the terser formats.
const aside = (cause: ReportUnavailable): string =>
  `A report a campaign names could not be read, so no campaign naming it is judged in this ` +
  `run: ${cause.message}`;

export const makeCampaignsRule = (
  policy: LoadedPolicy,
  indexes: SectorIndexes = new Map(),
): OxlintRule => {
  // Per rule instance, which is per plugin load — one process — rather than
  // per `createOnce`, which a host may call more often than that.
  const said = new Set<string>();
  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  return {
    meta: {
      type: "problem" as const,
      docs: {
        description:
          "the campaigns: every place a pattern the repository is migrating away from still occurs, in a sector whose phase asks for it, that its ledger does not carry",
      },
      schema: [],
    },

    createOnce(context: RuleContext) {
      let file = "";
      let selected: ReadonlyArray<CompiledCampaign> = [];

      return {
        before() {
          file = toRepoRelative(policy.repoRoot, context.filename);
          if (file.startsWith("..")) return false;
          // A file the packs would not walk — one oxlint lints anyway — is
          // seen only by a campaign that widened its scope to it, so both
          // hosts answer about the same files.
          const extension = path.extname(file);
          selected = campaignsSelecting(policy.campaignRules, file).filter(
            (rule) =>
              known.size === 0 || known.has(extension) || rule.extensions.includes(extension),
          );
          return selected.length > 0;
        },

        Program(node: Program) {
          const text = context.sourceCode.text;
          const detectors = selected.flatMap((rule) => [
            ...rule.objectives.flatMap((one) => {
              const detect = detectorOf(one);
              return detect === null ? [] : [detect];
            }),
            ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
          ]);
          const input: CampaignInput = {
            file,
            text,
            facts: sourceFactsOf(factsOfProgram(file, node)),
            resolver: policy.resolver,
            fileSystem: policy.fileSystem,
            syntax: needsSyntax(detectors) ? policy.syntax.parse(file, text) : null,
            functions: policy.functions,
            reports: policy.reports,
          };
          // One campaign at a time, so a report one of them cannot read costs
          // that campaign's answer for this file and not its neighbours'.
          const unrecorded: Array<CampaignHit> = [];
          for (const rule of selected) {
            try {
              const perimeter = rule.perimeter;
              const anchors =
                perimeter?.kind === "match"
                  ? detectorCandidatesOf(perimeter.detect, perimeter.unit, input).map(
                      (one) => one.key.split("#")[0] ?? one.key,
                    )
                  : [];
              const place = membershipOf(rule, file, indexes.get(rule.id) ?? null, anchors);
              // Hits grouped by the sector they fall in, then judged
              // against that sector's window and ledger.
              const bySector = new Map<string, { root: string; hits: Array<CampaignHit> }>();
              const windows = new Map<string, ReadonlySet<string>>();
              const placedAt = (subject: string | null) => {
                const placement = place(subject);
                if (placement === null) return null;
                if (!windows.has(placement.sector)) {
                  windows.set(
                    placement.sector,
                    new Set(inWindowFor(policy, rule, placement.sector).map((one) => one.id)),
                  );
                }
                return placement;
              };
              const whole = placedAt(null);
              const candidates =
                whole === null
                  ? rule.objectives.filter((one) => one.detect !== null)
                  : rule.objectives.filter(
                      (one) =>
                        one.detect !== null && (windows.get(whole.sector)?.has(one.id) ?? false),
                    );
              if (perimeter?.kind !== "match" && whole === null) continue;
              for (const hit of evaluateObjectives(candidates, input)) {
                const placement = placedAt(hit.violation.subject);
                if (placement === null) continue;
                if (!(windows.get(placement.sector)?.has(hit.objective) ?? false)) continue;
                const group = bySector.get(placement.sector) ?? { root: placement.root, hits: [] };
                group.hits.push(hit);
                bySector.set(placement.sector, group);
              }
              for (const [sector, group] of bySector) {
                for (const hit of unledgered(policy, rule, sector, group.root, group.hits)) {
                  unrecorded.push(hit);
                }
              }
            } catch (cause) {
              if (!(cause instanceof ReportUnavailable)) throw cause;
              const message = aside(cause);
              if (said.has(message)) continue;
              said.add(message);
              context.report({ message, loc: { line: 1, column: 0 } });
            }
          }

          for (const hit of unrecorded) {
            // A match lands where it was found; a file-unit hit, on line 1, as
            // the structure rule places a finding about the file itself.
            const at = hit.range ?? { start: { line: 0, column: 0 } };
            context.report({
              message: formatMessage(hit.violation),
              loc: { line: at.start.line + 1, column: at.start.column },
            });
          }
        },
      };
    },
  };
};
