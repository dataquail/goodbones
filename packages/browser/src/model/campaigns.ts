import type {
  Attestation,
  CampaignEvaluation,
  CampaignReport,
  Note,
  Nudge,
} from "@goodbones/campaigns";
import {
  campaignsOf,
  isDefinedPhase,
  isShared,
  ledgerKeyOf,
  LEGACY_SECTOR,
  snapshotCampaignsOf,
} from "@goodbones/campaigns";
import type { LoadedPolicy, ManifestLocator, ManifestPath } from "@goodbones/core";

import type { AtlasPosition } from "./atlas.js";

// The Campaign Browser's data: every campaign the policy declares, as the
// ladder the docs draw — phases in order, each recognized by its objectives;
// sectors standing at the first phase with residue for them; the end state
// last — with everything `architecture campaigns` and `check` say about
// each: the ledgers' counts, the holdouts by sector, what is new and what is
// stale, attestations, notes, stalls, and the nudge for the working tree.

export type ObjectiveSectorCard = {
  readonly sector: string;
  // Holdouts firing now, in window.
  readonly count: number;
  // The ledger's entries for this sector, relative to its root.
  readonly holdouts: ReadonlyArray<string>;
  // Firing and not in the ledger: unrecorded growth.
  readonly new: ReadonlyArray<string>;
  // In the ledger and no longer firing: cleared, waiting for `clear`.
  readonly stale: ReadonlyArray<string>;
  readonly drifted: number;
  readonly unrecorded: boolean;
  readonly initial: number | null;
  readonly cleared: number | null;
  readonly closed: number | null;
  readonly lastCleared: string | null;
  readonly measure: {
    readonly value: number | null;
    readonly recorded: number | null;
    readonly standing: "within" | "breached" | "surpassed" | "unrecorded" | "unmeasured";
  } | null;
};

export type ObjectiveCard = {
  readonly id: string;
  readonly message: string;
  // The objective's own intent; `null` when it states none.
  readonly intent: string | null;
  // `match`, `file`, `declaration`, `sector` — or `measure` for a scalar.
  readonly holdout: string;
  readonly phase: string | null;
  readonly position: AtlasPosition | null;
  readonly count: number;
  readonly initial: number;
  readonly allowed: number;
  readonly cleared: number;
  readonly closed: number;
  // `null` while no sector has entered the objective's window.
  readonly progress: number | null;
  readonly lastCleared: string | null;
  readonly concessions: number;
  readonly complete: boolean;
  readonly ledgered: boolean;
  readonly measure: {
    readonly direction: "down" | "up";
    readonly value: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
  } | null;
  readonly sectors: ReadonlyArray<ObjectiveSectorCard>;
};

export type PhaseCard = {
  readonly id: string;
  readonly index: number;
  readonly defined: boolean;
  readonly intent: string | null;
  readonly attested: boolean;
  readonly objectives: ReadonlyArray<string>;
  // Sectors derived to stand here.
  readonly sectors: number;
  readonly concessions: number;
  readonly position: AtlasPosition | null;
};

export type HitCard = {
  readonly objective: string;
  readonly file: string;
  readonly subject: string | null;
  readonly line: number | null;
  readonly entry: string;
  readonly message: string;
};

export type SectorCard = {
  readonly name: string;
  readonly legacy: boolean;
  // The campaign's shared: the files every sector shares, on no phase.
  readonly shared: boolean;
  // Index into `phases`; `phases.length` when every phase is done. For a
  // campaign with no phases, `0` and `done` says whether residue is nil.
  readonly phase: number;
  readonly phaseId: string | null;
  readonly done: boolean;
  readonly reached: string | null;
  readonly since: string | null;
  readonly roots: ReadonlyArray<string>;
  readonly marker: string | null;
  readonly files: ReadonlyArray<string>;
  // Holdouts per objective in window, and the raw counts for every objective.
  readonly residue: Readonly<Record<string, number>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly values: Readonly<Record<string, number>>;
  // Where the sector stands on the ladder: phases behind it, plus the share
  // of its current phase that is paid.
  readonly ladder: number;
  readonly stalled: boolean;
  readonly attested: ReadonlyArray<Attestation>;
  readonly notes: ReadonlyArray<Note>;
  readonly hits: ReadonlyArray<HitCard>;
};

export type CampaignCard = {
  readonly id: string;
  readonly title: string | null;
  readonly why: string | null;
  readonly how: string | null;
  readonly owner: string | null;
  readonly scope: ReadonlyArray<string>;
  readonly perimeter: string | null;
  readonly staleAfterDays: number | null;
  readonly onComplete: "keep" | "remove";
  readonly position: AtlasPosition | null;
  readonly count: number;
  // With a ladder, the sectors' positions on it over its `steps`; with
  // none, cleared over everything ever ledgered.
  readonly progress: number;
  readonly steps: number;
  readonly stalled: boolean;
  readonly complete: boolean;
  readonly ledgered: boolean;
  readonly missingLedger: boolean;
  readonly arithmetic: boolean;
  readonly phases: ReadonlyArray<PhaseCard>;
  readonly objectives: ReadonlyArray<ObjectiveCard>;
  readonly sectors: ReadonlyArray<SectorCard>;
  readonly legacy: { readonly files: number; readonly holdouts: number };
  // `null` for a campaign that declares no shared files.
  readonly shared: { readonly files: number; readonly holdouts: number } | null;
  readonly drift: ReadonlyArray<{ readonly file: string; readonly sectors: ReadonlyArray<string> }>;
  readonly plan: {
    readonly refined: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<string>;
    readonly unreceipted: ReadonlyArray<string>;
  };
};

export type CampaignView = {
  readonly version: 1;
  readonly name: string;
  readonly generatedAt: string;
  readonly ledgerDir: string;
  readonly campaigns: ReadonlyArray<CampaignCard>;
  // `campaigns status --changed` over the working tree, when git answered.
  readonly nudge: Nudge | null;
};

export type CampaignViewInput = {
  readonly policy: LoadedPolicy;
  readonly name: string;
  readonly evaluations: ReadonlyArray<CampaignEvaluation>;
  readonly reports: ReadonlyArray<CampaignReport>;
  // The manifest as read, for the fields lowering does not keep (`how`).
  readonly manifest: unknown;
  readonly locate: ManifestLocator | undefined;
  readonly manifestPath: string;
  readonly nudge: Nudge | null;
  readonly now: number;
};

const dirnameOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

const positionAt = (
  locate: ManifestLocator | undefined,
  manifestPath: string,
  path: ManifestPath,
): AtlasPosition | null => {
  const found = locate?.(path);
  if (found === null || found === undefined) return null;
  const directory = dirnameOf(manifestPath);
  const file =
    found.file === undefined
      ? manifestPath
      : directory === ""
        ? found.file
        : `${directory}/${found.file}`;
  return { file, line: found.line, column: found.column };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (value: unknown, ...keys: ReadonlyArray<string>): string | null => {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : null;
};

const DAY = 24 * 60 * 60 * 1000;

export const campaignViewOf = (input: CampaignViewInput): CampaignView => {
  const { policy } = input;
  const state = campaignsOf(policy);
  const snapshots = snapshotCampaignsOf(policy, input.evaluations);
  const position = (path: ManifestPath) => positionAt(input.locate, input.manifestPath, path);

  const campaigns = input.evaluations.map((evaluation, index): CampaignCard => {
    const { rule } = evaluation;
    const report = input.reports[index];
    const snapshot = snapshots[index];
    if (report === undefined || snapshot === undefined) {
      throw new Error(`campaign ${rule.id} was evaluated without a report`);
    }
    const scalar = new Set(
      rule.objectives.filter((one) => one.measure !== null).map((one) => one.id),
    );

    const objectives = rule.objectives.map((objective, j): ObjectiveCard => {
      const own = report.objectives[j];
      const summary = snapshot.objectives[j];
      const ledger = state.ledgers.get(ledgerKeyOf(rule.id, objective.id));
      const sectors = (own?.sectors ?? []).map((sector): ObjectiveSectorCard => {
        const held = ledger?.sectors[sector.sector];
        return {
          sector: sector.sector,
          count: sector.count,
          holdouts: held?.holdouts ?? [],
          new: sector.new,
          stale: sector.stale,
          drifted: sector.drifted,
          unrecorded: sector.unrecorded,
          initial: held?.initial ?? null,
          cleared: held?.cleared ?? null,
          closed: held?.closed ?? null,
          lastCleared: held?.lastCleared ?? null,
          measure: sector.measure ?? null,
        };
      });
      return {
        id: objective.id,
        message: objective.message,
        intent: objective.intent,
        holdout: objective.measure !== null ? "measure" : (objective.holdout ?? "match"),
        phase: summary?.phase ?? null,
        position: position(["campaigns", rule.id, "objectives", objective.id]),
        count: summary?.count ?? own?.count ?? 0,
        initial: summary?.initial ?? 0,
        allowed: summary?.allowed ?? 0,
        cleared: summary?.cleared ?? 0,
        closed: summary?.closed ?? 0,
        progress: summary?.progress ?? null,
        lastCleared: summary?.lastCleared ?? null,
        concessions: summary?.concessions ?? 0,
        complete: summary?.complete ?? false,
        ledgered: summary?.ledgered ?? false,
        measure:
          own?.measure === undefined
            ? null
            : {
                direction: own.measure.direction,
                value: own.measure.value,
                recorded: own.measure.recorded,
                target: own.measure.target,
                tolerance: own.measure.tolerance,
              },
        sectors,
      };
    });

    const phases = rule.phases.map((phase, i): PhaseCard => ({
      id: phase.id,
      index: i,
      defined: isDefinedPhase(phase),
      intent: phase.intent ?? null,
      attested: phase.attested,
      objectives: [...phase.objectives],
      sectors: snapshot.phases[i]?.sectors ?? 0,
      concessions: phase.concessions.length,
      position: position(["campaigns", rule.id, "phases", i]),
    }));

    const hitsOf = (sector: string): ReadonlyArray<HitCard> =>
      evaluation.hits
        .filter((hit) => hit.sector === sector)
        .map((hit) => ({
          objective: hit.objective,
          file: hit.violation.file,
          subject: hit.violation.subject,
          line: hit.range === undefined ? null : hit.range.start.line + 1,
          entry: hit.entry,
          message: hit.violation.message,
        }))
        .sort((a, b) => {
          const byFile = a.file.localeCompare(b.file);
          return byFile !== 0 ? byFile : a.entry.localeCompare(b.entry);
        });

    const sectors = [...evaluation.sectors.values()].map((sectorState): SectorCard => {
      const record = state.sectorRecords.get(ledgerKeyOf(rule.id, sectorState.name));
      const summary = snapshot.sectors.find((one) => one.name === sectorState.name);
      const residueTotal = Object.entries(sectorState.residue)
        .filter(([id]) => !scalar.has(id))
        .reduce((sum, [, n]) => sum + n, 0);
      const scalarOpen = Object.entries(sectorState.counts).some(
        ([id, n]) => scalar.has(id) && n > 0,
      );
      return {
        name: sectorState.name,
        legacy: sectorState.name === LEGACY_SECTOR,
        shared: isShared(rule, sectorState.name),
        phase: sectorState.phase,
        phaseId: rule.phases[sectorState.phase]?.id ?? null,
        // The shared files stand on no phase, so it is never past them.
        done: isShared(rule, sectorState.name)
          ? false
          : rule.phases.length === 0
            ? residueTotal === 0 && !scalarOpen
            : sectorState.phase >= rule.phases.length,
        reached: record?.reached ?? null,
        since: record?.since ?? null,
        roots: sectorState.sector.roots,
        marker: sectorState.sector.marker,
        files: [...sectorState.sector.files].sort(),
        residue: sectorState.residue,
        counts: sectorState.counts,
        values: sectorState.values,
        ladder: summary?.position ?? 0,
        stalled: summary?.stalled ?? false,
        attested: record?.attested ?? [],
        notes: record?.notes ?? [],
        hits: hitsOf(sectorState.name),
      };
    });

    return {
      id: rule.id,
      title: rule.title,
      why: rule.why,
      how: stringAt(input.manifest, "campaigns", rule.id, "how"),
      owner: rule.owner,
      scope: rule.scope.map((one) => one.source),
      perimeter: rule.perimeter?.kind ?? null,
      staleAfterDays: rule.staleAfter === null ? null : Math.round(rule.staleAfter / DAY),
      onComplete: rule.onComplete,
      position: position(["campaigns", rule.id]),
      count: snapshot.count,
      progress: snapshot.progress,
      steps: snapshot.steps,
      stalled: report.stalled,
      complete: report.complete,
      ledgered: snapshot.ledgered,
      missingLedger: report.missingLedger,
      arithmetic: report.arithmetic,
      phases,
      objectives,
      sectors,
      legacy: snapshot.legacy,
      shared: snapshot.shared ?? null,
      drift: report.drift,
      plan: report.plan,
    };
  });

  return {
    version: 1,
    name: input.name,
    generatedAt: new Date(input.now).toISOString(),
    ledgerDir: state.ledgerDir,
    campaigns,
    nudge: input.nudge,
  };
};
