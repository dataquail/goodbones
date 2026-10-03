import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { breaches, listSourceFiles, type LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow, towardNextOf } from "../core/campaign-state.js";
import { distanceToTarget } from "../core/campaigns.js";
import { concededSector, ledgerPathOf, reconcileSector, serializeLedger } from "../core/ledger.js";
import {
  type Direction,
  directionOf,
  growsAt,
  isOpenPhase,
  ledgeredFor,
  objectivesInWindow,
  onTouchOf,
  type Residue as ResidueVector,
  sharedWindow,
} from "../core/phases.js";
import { isShared, LEGACY_SECTOR, parseSectorMarker, SECTOR_HOLDOUT } from "../core/sectors.js";
import type { OnTouch } from "../domain/config.js";
import { campaignsOf } from "../load/extension.js";
import { concedeMeasure, evaluateCampaigns, widenedExtensions } from "./campaigns.js";
import { commitOf, type Diff, distanceToHunks, materializeTree, textAt } from "./diff.js";
import { ledgerPhaseOf } from "./ledger-phase.js";
import {
  count,
  HOLDOUT_CAP,
  ledgerOf,
  measureLedgerOf,
  phaseIdOf,
  recordOf,
  writeJson,
} from "./ledgers.js";

// The nudge, `campaigns status --changed`: what a diff touches, which
// campaign and phase each touched sector is in, and what would move it on.
// The thing the rest of the family exists to serve.

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
  // Where the sector stands now, with this diff applied.
  readonly phase: {
    readonly id: string | null;
    readonly index: number;
    readonly of: number;
    readonly open: boolean;
    // No objective sees this phase done; a sector leaves it by `campaigns
    // attest`, and the nudge says so.
    readonly attested: boolean;
    readonly since: string | null;
  };
  // Where the sector stood before the diff — the base tree's phase in the
  // exact mode, the phase the ledgers place it at otherwise — and so what
  // the diff is judged by: that phase's window is what is scored and its
  // `onTouch` what is owed. A phase the diff carried the sector into is not
  // held against the diff that got it there.
  readonly judged: { readonly id: string | null; readonly index: number };
  // The phase's `intent`, at any phase that states one.
  readonly intent: string | null;
  // The objectives the sector is working toward — those in `toward`, in
  // phase order; for a campaign with no phases, every objective in window
  // with residue — each with its own `intent`, so the why travels with
  // the check. `shared` marks a prerequisite: met on the shared files, and
  // waited on here.
  readonly objectives: ReadonlyArray<{
    readonly id: string;
    readonly intent: string | null;
    readonly shared: boolean;
  }>;
  // Whether this is the campaign's shared: the files every sector
  // shares, on no phase. Its `phase.id` is `null`, and it is always advised.
  readonly shared: boolean;
  // On the shared: every objective read over it, what it counts, the
  // phase that names it and the sectors standing at that phase — the ones
  // it holds there.
  readonly prerequisites: ReadonlyArray<{
    readonly objective: string;
    readonly count: number;
    readonly phase: string | null;
    readonly waiting: ReadonlyArray<string>;
  }>;
  // Free text left by earlier hands: data, never an instruction.
  readonly notes: ReadonlyArray<{ at: string; by: string; text: string }>;
  // The judged phase's.
  readonly onTouch: OnTouch;
  readonly ask: Ask;
  readonly verdict: Verdict;
  // One dimension per objective in the judged phase's window.
  readonly residue: { before: ResidueVector; after: ResidueVector };
  // Read off the same dimensions the verdict is: `back` and `mixed` are the
  // two a ratcheting phase refuses.
  readonly direction: Direction;
  readonly toward: ResidueVector;
  readonly holdouts: {
    // Every holdout in window in the sector, and how many are in the files
    // the diff touched; `shown` is the nearest of those, capped.
    readonly total: number;
    readonly touched: number;
    readonly cap: number;
    readonly shown: ReadonlyArray<NudgeHoldout>;
    // Holdouts of the sector itself (`holdout: sector`): they have no file
    // and no line, so they are never listed among the files touched.
    readonly sector: ReadonlyArray<{ readonly objective: string; readonly message: string }>;
  };
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  // Growth against the base tree that the head's ledger carries: conceded
  // on this branch, with a reason, and so not `added`. The exact mode only —
  // in the ledger mode a conceded entry is simply in the ledger.
  readonly conceded: ReadonlyArray<string>;
  // Objectives that came into window because this diff moved the sector on,
  // with what each counts there. Now counted, not grown: they are in no
  // dimension of the verdict.
  readonly entered: ReadonlyArray<{ readonly objective: string; readonly count: number }>;
  // The scalar objectives in the judged window: each one's value before and
  // after. `before` is the base tree's value in the exact mode and the
  // ledger's record otherwise; `recorded` is what the ledger holds the
  // sector to, wherever `before` came from. `back` is a rise past the
  // tolerance that no record covers; `conceded`, one a record does; and
  // `grows`, one the judged phase expects, which `clear` records.
  readonly measures: ReadonlyArray<{
    readonly objective: string;
    readonly direction: "down" | "up";
    readonly before: number | null;
    readonly after: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
    readonly back: boolean;
    readonly conceded: boolean;
    readonly grows: boolean;
  }>;
  // Files this diff added inside the scope that no sector claims.
  readonly belongsInSector: ReadonlyArray<string>;
  // Globs a marker's `owns` lists that no file matches: a folder not yet
  // written, or a typo that leaves the sector waiting on files it will
  // never see.
  readonly unmatchedOwns: ReadonlyArray<string>;
};

export type Nudge = {
  readonly version: 1;
  readonly mode: "ledger" | "exact";
  readonly base: string | null;
  readonly touched: ReadonlyArray<string>;
  readonly sectors: ReadonlyArray<SectorNudge>;
  // Markers this diff deleted, with the sector each un-births.
  readonly unbirths: ReadonlyArray<{ campaign: string; sector: string; marker: string }>;
  // Always `unknown`: the tool runs no tests. Kept for readers of version 1.
  readonly testsChecked: "unknown";
  readonly ok: boolean;
};

// The base tree's side of the exact mode, reduced to what the nudge reads:
// each campaign's counts per sector and its hits in window — small enough
// to cache per commit.
export type BaseSide = ReadonlyArray<{
  readonly id: string;
  readonly sectors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly hits: ReadonlyArray<{ sector: string; objective: string; entry: string }>;
  // Each scalar objective's value per sector. Absent from a base side cached
  // before scalars existed, and then the ledger stands in for it.
  readonly values?: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  // Each sector's phase in the base tree, by id; `null` past every phase.
  // Absent from a base side cached before the nudge judged by it, and then
  // the ledgers stand in for it.
  readonly phases?: Readonly<Record<string, string | null>>;
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
    // `NaN` does not survive the JSON cache; `null` is "no number".
    values: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [
        state.name,
        Object.fromEntries(
          Object.entries(state.values).map(([id, value]) => [
            id,
            Number.isNaN(value) ? null : value,
          ]),
        ),
      ]),
    ),
    phases: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [
        state.name,
        phaseIdOf(evaluation.rule, state.phase),
      ]),
    ),
  }));

const isBetter = (direction: "down" | "up", from: number, to: number): boolean =>
  direction === "down" ? to < from : to > from;

// The nudge for one diff. The "before" side is the ledger, or the base tree
// evaluated whole in the exact mode; the "after" side is the tree now. A
// sector is judged by the phase it stood at before the diff: entering a
// later phase's window is what the campaign asks for, so what that window
// counts for the first time is listed as entered, and neither it nor the
// later phase's `onTouch` is held against the diff that got the sector there.
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
      // The phase the diff found the sector at. A base side that names a
      // phase the plan no longer has is no answer, and the ledgers stand in.
      const basePhase = baseEvaluation?.phases?.[name];
      const baseIndex =
        basePhase === undefined
          ? -1
          : basePhase === null
            ? rule.phases.length
            : rule.phases.findIndex((one) => one.id === basePhase);
      const judgedAt = baseIndex === -1 ? ledgerPhaseOf(policy, rule, name) : baseIndex;
      const judged = rule.phases[judgedAt];
      const judgedOpen = judged !== undefined && isOpenPhase(judged);
      // The shared files are advised, always: they are where the campaign builds
      // what it will later take away, and `check` still holds its holdouts.
      const shared = isShared(rule, name);
      const onTouch = shared ? "advise" : onTouchOf(rule, judgedAt);
      // A prerequisite is scored on the shared files, where it is ledgered: a
      // sector that waits on one is not judged by it.
      const dimensions = shared
        ? sharedWindow(rule)
        : objectivesInWindow(rule, judgedAt, state.position).filter((one) => !one.overShared);
      const entered = state.inWindow
        .filter((one) => !dimensions.includes(one) && ledgeredFor(rule, one, name))
        .map((one) => ({ objective: one.id, count: state.counts[one.id] ?? 0 }));
      const prerequisites = !shared
        ? []
        : rule.objectives
            .filter((one) => one.overShared)
            .map((one) => {
              const at = rule.phases.findIndex((two) => two.objectives.includes(one.id));
              return {
                objective: one.id,
                count: state.counts[one.id] ?? 0,
                phase: rule.phases[at]?.id ?? null,
                waiting:
                  at === -1
                    ? []
                    : [...evaluation.sectors.values()]
                        .filter(
                          (two) =>
                            two.phase === at &&
                            two.name !== LEGACY_SECTOR &&
                            !isShared(rule, two.name),
                        )
                        .map((two) => two.name)
                        .sort(),
              };
            });
      const toward = towardNextOf(rule, state);
      const working = (
        rule.phases.length === 0
          ? state.inWindow.filter((one) => (state.counts[one.id] ?? 0) > 0)
          : (phase?.objectives ?? []).flatMap((objectiveId) => {
              const one = rule.objectives.find((two) => two.id === objectiveId);
              return one === undefined || toward[objectiveId] === undefined ? [] : [one];
            })
      ).map((one) => ({ id: one.id, intent: one.intent, shared: one.overShared }));
      // Before: the base tree's count per objective in the judged window, or
      // the ledger's. A scalar's is its distance to target from the value
      // before. `held` is what a holdout dimension may stand at without
      // having gone back: the count before, or what the head's ledger
      // carries where a concession on this branch raised it.
      const before: Record<string, number> = {};
      const after: Record<string, number> = {};
      const held: Record<string, number> = {};
      const measures: Array<SectorNudge["measures"][number]> = [];
      for (const objective of dimensions) {
        after[objective.id] = state.counts[objective.id] ?? 0;
        if (objective.measure !== null) {
          const own = measureLedgerOf(policy, rule, objective)?.sectors[name];
          const recorded = own === undefined || own.closed !== null ? null : own.recorded;
          const baseValue =
            baseEvaluation?.values === undefined
              ? undefined
              : baseEvaluation.values[name]?.[objective.id];
          const was = baseValue !== undefined ? baseValue : recorded;
          const value = state.values[objective.id] ?? Number.NaN;
          const now_ = Number.isNaN(value) ? null : value;
          before[objective.id] =
            was === null ? (state.counts[objective.id] ?? 0) : distanceToTarget(objective, was);
          const past = (limit: number): boolean =>
            now_ === null ||
            breaches(
              { direction: objective.direction, limit, tolerance: objective.tolerance },
              now_,
            );
          const rose = was !== null && past(was);
          // A rise the head's ledger has receipted: conceded up to, so the
          // sector is within what it is held to.
          const conceded = rose && recorded !== null && !past(recorded);
          // A rise the judged phase expects: `clear` records it.
          const grows = rose && !conceded && (shared || growsAt(rule, judgedAt, objective.id));
          measures.push({
            objective: objective.id,
            direction: objective.direction,
            before: was,
            after: now_,
            recorded,
            target: objective.target,
            tolerance: objective.tolerance,
            back: rose && !conceded && !grows,
            conceded,
            grows,
          });
          continue;
        }
        const carried = ledgerOf(policy, rule, objective)?.sectors[name]?.holdouts.length ?? 0;
        if (baseEvaluation !== null) {
          before[objective.id] = baseEvaluation.sectors[name]?.[objective.id] ?? 0;
          held[objective.id] = Math.max(before[objective.id] ?? 0, carried);
        } else {
          before[objective.id] = carried;
          held[objective.id] = carried;
        }
      }
      const own = counted.filter((hit) => hit.sector === name);
      const positioned = own.filter((hit) => hit.entry !== SECTOR_HOLDOUT);
      const inTouched = positioned.filter((hit) => diff.touched.has(hit.violation.file));
      const ranked = inTouched
        .map((hit) => {
          const hunks = diff.touched.get(hit.violation.file) ?? [];
          const distance =
            hit.range === undefined
              ? Number.POSITIVE_INFINITY
              : distanceToHunks(hunks, hit.range.start.line + 1, hit.range.end.line + 1);
          return { hit, rank: hit.range === undefined ? 1 : 0, distance };
        })
        .sort((a, b) =>
          a.rank !== b.rank
            ? a.rank - b.rank
            : a.distance !== b.distance
              ? a.distance - b.distance
              : a.hit.entry.localeCompare(b.hit.entry),
        );
      const shown = ranked.slice(0, HOLDOUT_CAP).map(({ hit }) => ({
        file: hit.violation.file,
        subject: hit.violation.subject,
        objective: hit.objective,
        line: hit.range === undefined ? null : hit.range.start.line + 1,
        message: hit.violation.message,
      }));
      const ofSector = own
        .filter((hit) => hit.entry === SECTOR_HOLDOUT)
        .map((hit) => ({ objective: hit.objective, message: hit.violation.message }));
      // What this diff added and removed, among the touched files.
      const added: Array<string> = [];
      const removed: Array<string> = [];
      const conceded: Array<string> = [];
      let editsHoldout = false;
      for (const objective of dimensions) {
        if (objective.measure !== null) continue;
        const hits = evaluation.hits.filter(
          (hit) => hit.sector === name && hit.objective === objective.id,
        );
        const entries = hits.map((hit) => hit.entry);
        const ledger = ledgerOf(policy, rule, objective);
        const knownBefore =
          baseEvaluation === null
            ? new Set(ledger?.sectors[name]?.holdouts ?? [])
            : new Set(
                baseEvaluation.hits
                  .filter((hit) => hit.sector === name && hit.objective === objective.id)
                  .map((hit) => hit.entry),
              );
        const reconciled =
          ledger === undefined ? null : reconcileSector(ledger, name, entries, objective.unit);
        let unrecorded: ReadonlyArray<string>;
        let stale: ReadonlyArray<string>;
        let ledgered: ReadonlyArray<string>;
        if (baseEvaluation === null) {
          unrecorded = reconciled?.unrecorded ?? entries;
          stale = reconciled?.stale ?? [];
          ledgered = reconciled?.ledgered ?? [];
        } else {
          // Against the base tree: what it did not have is new, unless the
          // head's ledger carries it — conceded on this branch.
          const fresh = entries.filter((entry) => !knownBefore.has(entry));
          const receipted = new Set(
            fresh.filter((entry) => reconciled?.ledgered.includes(entry) ?? false),
          );
          for (const entry of fresh) {
            if (receipted.has(entry)) conceded.push(`${objective.id}: ${entry}`);
          }
          unrecorded = fresh.filter((entry) => !receipted.has(entry));
          stale = [...knownBefore].filter((entry) => !entries.includes(entry));
          ledgered = entries.filter((entry) => knownBefore.has(entry));
        }
        for (const entry of unrecorded) {
          const hit = hits.find((one) => one.entry === entry);
          if (hit !== undefined && diff.touched.has(hit.violation.file))
            added.push(`${objective.id}: ${entry}`);
        }
        for (const entry of stale) removed.push(`${objective.id}: ${entry}`);
        for (const hit of hits) {
          if (hit.range === undefined || !diff.touched.has(hit.violation.file)) continue;
          if (!knownBefore.has(hit.entry) && !ledgered.includes(hit.entry)) continue;
          const hunks = diff.touched.get(hit.violation.file) ?? [];
          if (distanceToHunks(hunks, hit.range.start.line + 1, hit.range.end.line + 1) === 0)
            editsHoldout = true;
        }
        if (stale.length > 0) editsHoldout = true;
      }
      // One judgement, and the verdict and the direction are both read off
      // it. A holdout dimension goes back by any rise past what it is held
      // to; a scalar by its tolerance, where no record covers the rise. Only
      // the holdouts are paid down: a scalar has none to touch.
      const scalar = new Set(measures.map((one) => one.objective));
      const back = [
        ...Object.keys(held).filter((id) => (after[id] ?? 0) > (held[id] ?? 0)),
        ...measures.filter((one) => one.back).map((one) => one.objective),
      ].sort();
      const better =
        Object.keys(held).some((id) => (after[id] ?? 0) < (before[id] ?? 0)) ||
        measures.some(
          (one) =>
            one.before !== null &&
            one.after !== null &&
            isBetter(one.direction, one.before, one.after),
        );
      const direction = directionOf(better, back.length > 0);
      const holdoutTotal = (vector: ResidueVector): number =>
        Object.entries(vector)
          .filter(([id]) => !scalar.has(id))
          .reduce((sum, [, n]) => sum + n, 0);
      const totalBefore = holdoutTotal(before);
      const totalAfter = holdoutTotal(after);
      let ask: Ask;
      let verdict: Verdict = "ok";
      if (judgedOpen) ask = "note";
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
        for (const objective of dimensions) {
          if (objective.measure !== null) {
            if (measures.some((one) => one.objective === objective.id && one.back)) {
              concedeMeasure(policy, evaluation, objective, name, {
                at: policy.now,
                by,
                reason: `hotfix: ${hotfix}`,
              });
            }
            continue;
          }
          const ledger = ledgerOf(policy, rule, objective);
          if (ledger === undefined) continue;
          const entries = evaluation.hits
            .filter((hit) => hit.sector === name && hit.objective === objective.id)
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
          attested: phase?.attested === true,
          since: record?.since ?? null,
        },
        judged: { id: phaseIdOf(rule, judgedAt), index: judgedAt },
        intent: phase?.intent ?? null,
        objectives: working,
        shared,
        prerequisites,
        notes: (record?.notes ?? [])
          .filter((one) => one.phase === phaseIdOf(rule, state.phase))
          .map((one) => ({ at: one.at, by: one.by, text: one.text })),
        onTouch,
        ask,
        verdict,
        residue: { before, after },
        direction,
        toward,
        holdouts: {
          total: own.length,
          touched: inTouched.length,
          cap: HOLDOUT_CAP,
          shown,
          sector: ofSector,
        },
        added: added.sort(),
        removed: removed.sort(),
        conceded: conceded.sort(),
        entered,
        measures,
        belongsInSector: name === LEGACY_SECTOR ? belongs.sort() : [],
        unmatchedOwns: state.sector.unmatchedOwns ?? [],
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
    const at = one.shared
      ? "held by every sector, on no phase"
      : one.phase.of === 0
        ? "its objectives"
        : `phase ${one.phase.id ?? "done"} (${String(one.phase.index + 1)} of ${String(one.phase.of)}${one.phase.open ? ", open" : one.phase.attested ? ", attested" : ""})`;
    const moved = one.judged.index !== one.phase.index;
    // An attested phase is never quiet: the sector is waiting on a hand,
    // and the one who touched it is the nearest.
    const quiet =
      one.holdouts.total === 0 &&
      one.measures.every((measure) => measure.before === measure.after) &&
      one.direction === "neutral" &&
      !moved &&
      !one.phase.open &&
      !one.phase.attested &&
      one.verdict === "ok" &&
      one.prerequisites.every((prerequisite) => prerequisite.count === 0) &&
      one.belongsInSector.length === 0;
    if (quiet) {
      say(`  ${one.sector} at ${at} · nothing in your files, diff neutral`);
      continue;
    }
    say(`  ${one.sector} — ${at}${days(one.phase.since, now)}`);
    if (moved) {
      say(
        `    this diff moves it from ${one.judged.id ?? "done"}: it is judged by the phase it was found at`,
      );
    }
    // The phase's intent, wherever one is stated; an open phase is nothing
    // but its intent, so there its absence is said too.
    if (one.phase.open || one.intent !== null) say(`    intent: ${one.intent ?? "(none stated)"}`);
    if (one.phase.open) {
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
    }
    if (one.phase.attested) {
      say(
        `    this phase is attested, not detected: no objective sees it done. When it is, record it —`,
        `      architecture campaigns attest ${one.sector} ${one.phase.id ?? ""} --reason "…" [--evidence <url>] --campaign ${one.campaign}`,
      );
    }
    const toward = residueOf(one.toward);
    if (toward !== "") say(`    toward the next phase: ${toward}`);
    // Each objective's own intent beside its count, so the why is read
    // where the check is.
    for (const objective of one.objectives) {
      if (objective.intent !== null) say(`      ${objective.id} — ${objective.intent}`);
      if (objective.shared) {
        say(
          `      ${objective.id}: a prerequisite — met on the shared files, and every sector at this phase waits on it`,
        );
      }
    }
    const owed = one.prerequisites.filter((prerequisite) => prerequisite.count > 0);
    if (owed.length > 0) {
      say(
        `    prerequisites, which hold every sector at the phase that names them:`,
        ...owed.map(
          (prerequisite) =>
            `      ${prerequisite.objective} ${String(prerequisite.count)}` +
            (prerequisite.phase === null
              ? " — named by no phase"
              : ` — ${prerequisite.phase}${prerequisite.waiting.length === 0 ? ", where no sector stands yet" : `: ${prerequisite.waiting.join(", ")}`}`),
        ),
      );
    }
    if (one.holdouts.sector.length > 0) {
      say(
        `    of the sector as a whole:`,
        ...one.holdouts.sector.map((h) => `      ${h.objective}: ${h.message}`),
        ...one.unmatchedOwns.map(
          (glob) => `      (its marker owns \`${glob}\`, which no file matches)`,
        ),
      );
    }
    if (one.holdouts.shown.length > 0) {
      say(
        `    in the files you touched, nearest your change (${String(one.holdouts.shown.length)} of ${String(one.holdouts.touched)}; ${String(one.holdouts.total)} in the sector):`,
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
    if (one.conceded.length > 0) {
      say(`    conceded on this branch, in the ledger: ${one.conceded.join(" · ")}`);
    }
    const counted = one.entered.filter((entry) => entry.count > 0);
    if (counted.length > 0) {
      say(
        `    now counted: ${counted.map((entry) => `${entry.objective} ${String(entry.count)}`).join(" · ")} — in window from ${one.phase.id ?? "here"}, not growth`,
      );
    }
    for (const measure of one.measures) {
      if (measure.before === measure.after && !measure.back) continue;
      // In the ledger mode `before` is the record; in the exact mode it is
      // the base tree's value, and the record is named beside it.
      const fromRecord = nudge.mode === "ledger";
      const bounds = [
        ...(fromRecord || measure.recorded === null
          ? []
          : [`recorded ${String(measure.recorded)}`]),
        ...(measure.target === null ? [] : [`target ${String(measure.target)}`]),
        ...(measure.tolerance === 0 ? [] : [`tolerance ${String(measure.tolerance)}`]),
      ];
      const was =
        measure.before === null
          ? "unrecorded"
          : `${fromRecord ? "recorded " : ""}${String(measure.before)}`;
      const is =
        measure.after === null
          ? "no number"
          : `${fromRecord ? "now " : ""}${String(measure.after)}`;
      say(
        `    ${measure.objective}: ${was} → ${is}` +
          (bounds.length === 0 ? "" : ` (${bounds.join(", ")})`) +
          (measure.back
            ? "  back"
            : measure.conceded
              ? "  conceded"
              : measure.grows
                ? one.shared
                  ? "  measured, not held"
                  : `  grows in ${one.judged.id ?? "this phase"}`
                : ""),
      );
    }
    for (const file of one.belongsInSector)
      say(`    ${file} landed in the legacy inside the scope: this belongs in a sector`);
    say(
      `    onTouch: ${one.onTouch}${moved ? ` (of ${one.judged.id ?? "done"})` : ""} — ${one.verdict}`,
    );
    say(`    ask: ${describeAsk(one.ask)}`);
  }
  say("", nudge.ok ? "ok" : "not ok");
  return lines;
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
