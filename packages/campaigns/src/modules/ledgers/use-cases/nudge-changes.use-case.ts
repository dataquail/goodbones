import * as path from "node:path";

import { breaches, type LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import {
  type CampaignEvaluation,
  hitsInWindow,
  towardNextOf,
} from "../../../core/campaign-state.js";
import { type CompiledCampaign, distanceToTarget } from "../../../core/campaigns.js";
import {
  directionOf,
  growsAt,
  isOpenPhase,
  ledgeredFor,
  objectivesInWindow,
  onAheadOf,
  onTouchOf,
  type Residue as ResidueVector,
  sharedWindow,
  windowOf,
} from "../../../core/phases.js";
import {
  isShared,
  LEGACY_SECTOR,
  parseSectorMarker,
  SECTOR_HOLDOUT,
  sectorOfDeleted,
} from "../../../core/sectors.js";
import { type CampaignPolicy, campaignsOf } from "../../../load/campaign-policy.js";
import type { BaseSide } from "../domain/base-side/base-side.value-object.js";
import { type Diff, distanceToHunks } from "../domain/git/diff.value-object.js";
import type { Ledger } from "../domain/ledger/ledger.root.js";
import {
  concededSector,
  reconcileEntries,
  reconcileSector,
} from "../domain/ledger/ledger.root-ops.js";
import type { MeasureLedger } from "../domain/measure-ledger/measure-ledger.root.js";
import type { SectorRecord } from "../domain/sector-record/sector-record.root.js";
import {
  entriesOf,
  HOLDOUT_CAP,
  ledgerOf,
  type LedgerOverrides,
  ledgerPhaseOf,
  measureLedgerOf,
  phaseIdOf,
  recordOf,
} from "../domain/services/campaign-ledgers.service.js";
import { concededMeasuresOf, sendBackOf } from "../domain/services/concession.service.js";
import type { Ask, Nudge, SectorNudge, Verdict } from "./nudge.result.js";

// The nudge, `campaigns status --changed`: what a diff touches, which
// campaign and phase each touched sector is in, and what would move it on.
// The thing the rest of the family exists to serve. HEAD's ledgers are read
// through git, and a `--hotfix` concedes what the diff grew, through the
// ledgers' repositories.

const isBetter = (direction: "down" | "up", from: number, to: number): boolean =>
  direction === "down" ? to < from : to > from;

// HEAD's ledgers and records for one campaign: what the ledger mode reads
// a working tree's own concessions against, since the working tree's
// ledgers already carry them. `null` when HEAD has none of the campaign's
// ledgers — never committed, or in the first layout — and so no answer.
type HeadSide = {
  readonly overrides: LedgerOverrides;
  readonly record: (sector: string) => SectorRecord | undefined;
};

const headSideOf = (campaigns: CampaignPolicy, rule: CompiledCampaign): HeadSide | null => {
  const head = campaigns.readersAt("HEAD");
  const ledgers = new Map<string, Ledger | undefined>();
  const measures = new Map<string, MeasureLedger | undefined>();

  // A ledger absent at HEAD, unreadable there, or of the other kind is no
  // answer for its objective.
  for (const objective of rule.objectives) {
    const found = head.ledgers.findOne({ campaign: rule.id, objective: objective.id });
    const ledger = Result.isSuccess(found) ? (found.success ?? undefined) : undefined;

    if (objective.measure !== null) {
      measures.set(objective.id, ledger !== undefined && "kind" in ledger ? ledger : undefined);
    } else {
      ledgers.set(objective.id, ledger !== undefined && !("kind" in ledger) ? ledger : undefined);
    }
  }

  const any = [...ledgers.values(), ...measures.values()].some((one) => one !== undefined);

  if (!any) return null;
  const records = head.sectorRecords.findAll(rule.id);
  const found = Result.isSuccess(records) ? records.success : [];

  return {
    overrides: { ledgers, measures },
    record: (sector) => found.find((one) => one.sector === sector),
  };
};

// The ledger mode: what the working tree conceded for a sector, against
// HEAD's ledgers.
const headConcessionsOf = (
  campaigns: CampaignPolicy,
  rule: CompiledCampaign,
  head: HeadSide,
  name: string,
): ReadonlyArray<string> => {
  const found: Array<string> = [];

  const fresh = <T>(now: ReadonlyArray<T>, then: ReadonlyArray<T>): ReadonlyArray<T> => {
    const known = new Set(then.map((one) => JSON.stringify(one)));

    return now.filter((one) => !known.has(JSON.stringify(one)));
  };

  for (const objective of rule.objectives) {
    if (objective.measure !== null) {
      const then = head.overrides.measures?.get(objective.id)?.concessions ?? [];
      const now = measureLedgerOf(campaigns, rule, objective)?.concessions ?? [];

      for (const one of fresh(now, then)) {
        if (one.sector === name) {
          found.push(`${objective.id}: ${String(one.from)} → ${String(one.to)}`);
        }
      }

      continue;
    }

    const then = head.overrides.ledgers?.get(objective.id)?.concessions ?? [];
    const now = ledgerOf(campaigns, rule, objective)?.concessions ?? [];

    for (const one of fresh(now, then)) {
      if (one.sector !== name) continue;

      if ("holdouts" in one) {
        for (const entry of one.holdouts) found.push(`${objective.id}: ${entry}`);
      } else {
        found.push(`${objective.id}: re-baselined ${String(one.from)} → ${String(one.to)}`);
      }
    }
  }

  return found;
};

// On the shared: every objective read over it, what it counts, the phase
// that names it and the sectors standing at that phase.
const prerequisitesOf = (
  rule: CompiledCampaign,
  evaluation: CampaignEvaluation,
  counts: ResidueVector,
): SectorNudge["prerequisites"] =>
  rule.objectives.flatMap((one) => {
    if (!one.overShared) return [];
    const at = rule.phases.findIndex((two) => two.objectives.includes(one.id));

    return [
      {
        objective: one.id,
        count: counts[one.id] ?? 0,
        phase: rule.phases[at]?.id ?? null,
        waiting:
          at === -1
            ? []
            : [...evaluation.sectors.values()]
                .flatMap((two) =>
                  two.phase === at && two.name !== LEGACY_SECTOR && !isShared(rule, two.name)
                    ? [two.name]
                    : [],
                )
                .sort(),
      },
    ];
  });

// The nudge for one diff. The "before" side is the ledger, or the base tree
// evaluated whole in the exact mode; the "after" side is the tree now. A
// sector is judged by the phase it stood at before the diff: entering a
// later phase's window is what the campaign asks for, so what that window
// counts for the first time is listed as entered, and neither it nor the
// later phase's `onTouch` is held against the diff that got the sector there.
export const nudgeChangesUseCase = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
  diff: Diff,
  base: BaseSide | null,
  hotfix: string | null,
  by: string | null,
  // The ledger mode's "before" for work done ahead of the plan: the HEAD
  // tree, evaluated, since no ledger counts what a sector has not entered.
  headTree: BaseSide | null = null,
): Nudge => {
  const campaigns = campaignsOf(policy);
  const touched = [...diff.touched.keys()].sort();
  const sectors: Array<SectorNudge> = [];
  const unbirths: Array<{ campaign: string; sector: string; marker: string }> = [];
  let ok = true;

  for (const evaluation of evaluations) {
    const { rule } = evaluation;
    const baseEvaluation = base?.find((one) => one.id === rule.id) ?? null;
    const before_ = baseEvaluation ?? headTree?.find((one) => one.id === rule.id) ?? null;
    // Read from git once, and only when the diff touches a sector of this
    // campaign.
    let headRead: HeadSide | null | undefined;

    const headOf = (): HeadSide | null => {
      if (headRead === undefined) headRead = base === null ? headSideOf(campaigns, rule) : null;

      return headRead;
    };

    const counted = hitsInWindow(evaluation);
    const perimeter = rule.perimeter;

    if (perimeter?.kind === "marker") {
      for (const file of diff.deleted) {
        if (!perimeter.marker.some((one) => one.test(file))) continue;
        const text = campaigns.clients.git.textAt(diff.base ?? "HEAD", file);
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

    // A sector finishes by deleting its files, so a diff that only deletes
    // is touching the sector the files stood in.
    for (const file of diff.deleted) {
      const sector = sectorOfDeleted(rule, evaluation.index, file);

      if (sector !== null) touchedSectors.add(sector);
    }

    for (const name of [...touchedSectors].sort()) {
      const state = evaluation.sectors.get(name);

      if (state === undefined) continue;
      const record = recordOf(campaigns, rule, name);
      const head = headOf();
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

      // In the ledger mode, the working tree's ledgers carry its own
      // concessions; where HEAD's placed the sector is where the diff found
      // it, when that is further on.
      const placed = ledgerPhaseOf(campaigns, rule, name);

      const placedAtHead =
        head === null || record === undefined
          ? placed
          : ledgerPhaseOf(campaigns, rule, name, {
              ...head.overrides,
              record: { at: head.record(name) },
            });

      const judgedAt = baseIndex === -1 ? Math.max(placed, placedAtHead) : baseIndex;

      // What the working tree's concessions did to where the ledgers place
      // the sector, and the attestations they revoked on the way.
      let sentBack: SectorNudge["sentBack"] =
        baseIndex === -1 && placedAtHead > placed
          ? {
              from: phaseIdOf(rule, placedAtHead),
              to: phaseIdOf(rule, placed),
              revoked: (record?.attested ?? [])
                .filter(
                  (one) =>
                    one.revoked !== undefined &&
                    (head?.record(name)?.attested ?? []).some(
                      (two) =>
                        two.phase === one.phase && two.at === one.at && two.revoked === undefined,
                    ),
                )
                .map((one) => one.phase),
            }
          : null;

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

      const prerequisites = !shared ? [] : prerequisitesOf(rule, evaluation, state.counts);

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
          const own = measureLedgerOf(campaigns, rule, objective)?.sectors[name];
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

        const carried = ledgerOf(campaigns, rule, objective)?.sectors[name]?.holdouts.length ?? 0;

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
        const ledger = ledgerOf(campaigns, rule, objective);

        const knownBefore =
          baseEvaluation === null
            ? new Set(ledger?.sectors[name]?.holdouts ?? [])
            : new Set(entriesOf(baseEvaluation.hits, objective.id, name));

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
          // Against the base tree, reconciled as a ledger is — a holdout
          // that drifted or was renamed is the same one: what it did not
          // have is new, unless the head's ledger carries it — conceded on
          // this branch.
          const againstBase = reconcileEntries([...knownBefore], entries, objective.unit);
          const fresh = againstBase.unrecorded;

          const receipted = new Set(
            fresh.filter((entry) => reconciled?.ledgered.includes(entry) ?? false),
          );

          for (const entry of fresh) {
            if (receipted.has(entry)) conceded.push(`${objective.id}: ${entry}`);
          }

          unrecorded = fresh.filter((entry) => !receipted.has(entry));
          stale = againstBase.stale;
          ledgered = againstBase.ledgered;
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

      // The ledger mode: what the working tree conceded for the sector,
      // against HEAD's ledgers. Its own ledgers already carry it, so it is
      // neither added nor back — and it is the one thing a reviewer must see.
      if (baseEvaluation === null && head !== null) {
        for (const one of headConcessionsOf(campaigns, rule, head, name)) conceded.push(one);
      }

      // One judgement, and the verdict and the direction are both read off
      // it. A holdout dimension goes back by any rise past what it is held
      // to; a scalar by its tolerance, where no record covers the rise. Only
      // the holdouts are paid down: a scalar has none to touch.
      const scalar = new Set(measures.map((one) => one.objective));

      const back = [
        ...Object.keys(held).filter((id) => (after[id] ?? 0) > (held[id] ?? 0)),
        ...measures.flatMap((one) => (one.back ? [one.objective] : [])),
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
      // At an open phase the windows still open are earlier phases': each
      // dimension that went back is held by the phase that named it, so the
      // last phase is no gap in the ratchet. One no phase names is held by
      // the open phase's own word.
      const heldBy: Array<SectorNudge["held"][number]> = [];

      if (judgedOpen && !shared) {
        for (const id of back) {
          const objective = rule.objectives.find((one) => one.id === id);

          if (objective === undefined) continue;
          const from = windowOf(rule, objective).from;
          const owed = from === -1 ? onTouch : onTouchOf(rule, from);

          if (owed !== "advise") {
            heldBy.push({ objective: id, phase: rule.phases[from]?.id ?? null, onTouch: owed });
          }
        }
      }

      if (judgedOpen) {
        ask = "note";

        if (heldBy.length > 0) verdict = "back";
      } else if (onTouch === "advise") ask = "none";
      else if (onTouch === "ratchet") {
        ask = "hold";

        if (back.length > 0) verdict = "back";
      } else {
        ask = editsHoldout ? "paydown-required" : "paydown-optional";

        if (back.length > 0) verdict = "back";
        else if (editsHoldout && totalAfter >= totalBefore) verdict = "no-paydown";
      }

      if (verdict !== "ok" && hotfix !== null && by !== null) {
        // The escape: the growth is conceded, with a reason naming the hotfix
        // — and, like any concession, it may send the sector back.
        const written = new Map<string, Ledger>();
        const receipt = { at: policy.now, by, reason: `hotfix: ${hotfix}` };

        for (const objective of dimensions) {
          if (objective.measure !== null) {
            if (measures.some((one) => one.objective === objective.id && one.back)) {
              const ledger = measureLedgerOf(campaigns, rule, objective);

              if (ledger !== undefined) {
                const done = concededMeasuresOf(ledger, evaluation, objective, name, receipt);

                if (done.conceded.length > 0) campaigns.repositories.ledgers.save(done.ledger);

                const back = sendBackOf(
                  campaigns,
                  rule,
                  done.conceded.map((one) => one.sector),
                  { measures: new Map([[objective.id, done.ledger]]) },
                  { ...receipt, reason: `conceded ${objective.id}: ${receipt.reason}` },
                );

                for (const record of back.records)
                  campaigns.repositories.sectorRecords.save(record);
                const [moved] = back.sent;

                if (moved !== undefined) sentBack = moved;
              }
            }

            continue;
          }

          const ledger = ledgerOf(campaigns, rule, objective);

          if (ledger === undefined) continue;

          const entries = entriesOf(evaluation.hits, objective.id, name);

          const { unrecorded } = reconcileSector(ledger, name, entries, objective.unit);

          if (unrecorded.length === 0) continue;

          const next = concededSector(ledger, name, unrecorded, receipt);

          written.set(objective.id, next);
          campaigns.repositories.ledgers.save(next);
        }

        const back = sendBackOf(campaigns, rule, [name], { ledgers: written }, receipt);

        for (const record of back.records) campaigns.repositories.sectorRecords.save(record);
        const [moved] = back.sent;

        if (moved !== undefined) sentBack = moved;
        verdict = "hotfix";
      }

      // Ahead of the plan: a holdout paid down of an objective whose phase
      // lies past where the sector stands after the diff. Work done in order
      // carries the sector into the phase it pays, so this is only work done
      // out of it — what a missing attestation, or an earlier phase's
      // residue, holds back. The legacy and the shared files stand on no
      // rung to be ahead of, and a scalar has no holdout to pay.
      const ahead: Array<SectorNudge["ahead"][number]> = [];

      if (before_ !== null && !shared && name !== LEGACY_SECTOR) {
        for (const objective of rule.objectives) {
          if (objective.measure !== null || objective.overShared) continue;

          if (dimensions.includes(objective)) continue;
          const { from } = windowOf(rule, objective);

          if (from === -1 || from <= state.phase) continue;
          const was = before_.sectors[name]?.[objective.id];
          const now = state.counts[objective.id] ?? 0;
          const owes = onAheadOf(rule, judgedAt, objective);

          if (was !== undefined && now < was && owes !== "ignore") {
            ahead.push({
              objective: objective.id,
              phase: rule.phases[from]?.id ?? null,
              before: was,
              after: now,
              onAhead: owes,
            });
          }
        }
      }

      const onAhead = onAheadOf(rule, judgedAt);

      if (ahead.some((one) => one.onAhead === "ratchet") && verdict === "ok") verdict = "ahead";

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
        held: heldBy,
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
        ahead,
        onAhead,
        sentBack:
          sentBack === null
            ? null
            : { from: sentBack.from, to: sentBack.to, revoked: sentBack.revoked },
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
