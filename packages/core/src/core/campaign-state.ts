import type { PhaseRule } from "../domain/architecture-config.js";
import type { Violation } from "../domain/violation.js";
import {
  type CampaignHit,
  type CampaignInput,
  candidatesOf,
  type CompiledCampaign,
  type CompiledObjective,
  evaluateObjectives,
  perFileObjectivesOf,
} from "./campaigns.js";
import type { SectorRecord } from "./ledger.js";
import { positionOf } from "./ledger.js";
import {
  derivePhase,
  LEGACY_PHASE,
  objectivesInWindow,
  type Residue,
  type SectorPosition,
} from "./phases.js";
import {
  discoverSectors,
  entryOf,
  LEGACY_SECTOR,
  rootOf,
  type Sector,
  type SectorDiscovery,
  type SectorIndex,
  SECTOR_HOLDOUT,
  sectorNamed,
} from "./sectors.js";

// One campaign over the files in its scope: its sectors discovered, every
// objective evaluated — per file, or over a sector's files — every hit
// placed in its sector and keyed relative to the sector's root, and each
// sector's phase derived from what fired. The host supplies the file
// reading; nothing here touches one.

export type ObjectiveHit = CampaignHit & {
  readonly sector: string;
  // The ledger entry: relative to the sector's root.
  readonly entry: string;
};

export type SectorState = {
  readonly name: string;
  readonly sector: Sector;
  // The derived phase, as an index; `rule.phases.length` when done.
  readonly phase: number;
  readonly position: SectorPosition;
  readonly inWindow: ReadonlyArray<CompiledObjective>;
  // Every objective's hits in the sector, in window or not.
  readonly counts: Residue;
  // One dimension per objective in window.
  readonly residue: Residue;
};

export type CampaignEvaluation = {
  readonly rule: CompiledCampaign;
  readonly index: SectorIndex;
  // Every hit, whether or not its objective is in window for its sector.
  readonly hits: ReadonlyArray<ObjectiveHit>;
  readonly sectors: ReadonlyMap<string, SectorState>;
};

export type CampaignEvaluationInput = {
  // The files in the campaign's scope.
  readonly files: ReadonlyArray<string>;
  readonly inputOf: (file: string) => CampaignInput;
  readonly readText: (file: string) => string | null;
  readonly globToRegExp: SectorDiscovery["globToRegExp"];
  readonly projects?: SectorDiscovery["projects"];
  readonly recordOf: (sector: string) => SectorRecord | undefined;
  // For an `endState` objective: the violations of one family against the
  // tree lowered for this sector. Absent, an end state has no residue —
  // the plugin's position, which never evaluates one.
  readonly endStateOf?:
    | ((sector: Sector, phase: PhaseRule, family: string) => ReadonlyArray<Violation>)
    | undefined;
};

const sectorHit = (objective: CompiledObjective, sector: Sector): ObjectiveHit => ({
  violation: {
    kind: "campaign",
    ruleName: objective.name,
    message: objective.message,
    file: sector.files[0] ?? sector.roots[0] ?? "",
    subject: null,
  },
  campaign: objective.campaign,
  objective: objective.id,
  sector: sector.name,
  entry: SECTOR_HOLDOUT,
});

const under = (root: string, file: string): boolean =>
  root === "" || file === root || file.startsWith(`${root}/`);

export const evaluateCampaign = (
  rule: CompiledCampaign,
  input: CampaignEvaluationInput,
): CampaignEvaluation => {
  const inputs = new Map<string, CampaignInput>();
  const inputOf = (file: string): CampaignInput => {
    const cached = inputs.get(file);
    if (cached !== undefined) return cached;
    const made = input.inputOf(file);
    inputs.set(file, made);
    return made;
  };

  const perimeter = rule.perimeter;
  const index = discoverSectors(rule, {
    files: input.files,
    readText: input.readText,
    globToRegExp: input.globToRegExp,
    projects: input.projects,
    perimeterMatches:
      perimeter?.kind === "match"
        ? (file) =>
            candidatesOf(perimeter.detect, perimeter.unit, inputOf(file)).map(
              (one) => one.key.split("#")[0] ?? one.key,
            )
        : undefined,
  });

  const hits: Array<ObjectiveHit> = [];
  const perFile = perFileObjectivesOf(rule);
  if (perFile.length > 0) {
    for (const file of input.files) {
      if (index.sectorOf(file) === null) continue;
      for (const hit of evaluateObjectives(perFile, inputOf(file))) {
        const sector = index.sectorOfHit(file, hit.violation.subject);
        if (sector === null) continue;
        const own = sectorNamed(index, sector);
        const root = own === null ? "" : rootOf(own, file);
        hits.push({ ...hit, sector, entry: entryOf(hit.violation, root) });
      }
    }
  }

  const names = [...index.sectors.keys(), ...(index.legacy.length > 0 ? [LEGACY_SECTOR] : [])];
  for (const name of names) {
    const sector = sectorNamed(index, name);
    if (sector === null) continue;
    for (const objective of rule.objectives) {
      const term = objective.sector;
      if (term !== null) {
        let holds: boolean;
        switch (term.kind) {
          case "has":
            holds = sector.files.some(
              (file) => candidatesOf(term.detect, "file", inputOf(file)).length > 0,
            );
            break;
          case "oneRoot": {
            const [root] = sector.roots;
            holds =
              root !== undefined && sector.files.every((file) => under(root, file));
            break;
          }
          case "oneHost":
            holds = sector.files.every((file) => term.hosts.some((host) => host.test(file)));
            break;
        }
        if (!holds) hits.push(sectorHit(objective, sector));
        continue;
      }
      if (objective.endState !== null && input.endStateOf !== undefined) {
        if (name === LEGACY_SECTOR || sector.roots.length !== 1) continue;
        const phase = rule.phases.find((one) => one.id === objective.endState?.phase);
        if (phase === undefined) continue;
        const root = sector.roots[0] ?? "";
        for (const violation of input.endStateOf(sector, phase, objective.endState.family)) {
          hits.push({
            violation: { ...violation, kind: "campaign", ruleName: objective.name },
            campaign: rule.id,
            objective: objective.id,
            sector: name,
            entry: entryOf(violation, root),
          });
        }
      }
    }
  }

  const sectors = new Map<string, SectorState>();
  for (const name of names) {
    const sector = sectorNamed(index, name);
    if (sector === null) continue;
    const counts: Record<string, number> = {};
    for (const objective of rule.objectives) counts[objective.id] = 0;
    for (const hit of hits) {
      if (hit.sector === name) counts[hit.objective] = (counts[hit.objective] ?? 0) + 1;
    }
    const position = positionOf(rule, input.recordOf(name));
    const phase =
      name === LEGACY_SECTOR
        ? Math.min(LEGACY_PHASE, rule.phases.length)
        : derivePhase(rule, (id) => counts[id] ?? 0, position);
    const inWindow = objectivesInWindow(rule, phase, position);
    const residue: Record<string, number> = {};
    for (const objective of inWindow) residue[objective.id] = counts[objective.id] ?? 0;
    sectors.set(name, { name, sector, phase, position, inWindow, counts, residue });
  }

  return { rule, index, hits, sectors };
};

// The hits that count: those whose objective is in window for their sector.
export const hitsInWindow = (evaluation: CampaignEvaluation): ReadonlyArray<ObjectiveHit> =>
  evaluation.hits.filter((hit) =>
    evaluation.sectors.get(hit.sector)?.inWindow.some((one) => one.id === hit.objective),
  );

// The residue toward the sector's next phase: the current phase's
// objectives that still have holdouts — what must reach zero to leave it.
export const towardNextOf = (rule: CompiledCampaign, state: SectorState): Residue => {
  const phase = rule.phases[state.phase];
  if (phase === undefined) return {};
  const toward: Record<string, number> = {};
  for (const id of phase.objectives) {
    const count = state.counts[id] ?? 0;
    if (count > 0) toward[id] = count;
  }
  return toward;
};
