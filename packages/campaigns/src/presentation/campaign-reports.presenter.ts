import type { Violation } from "@goodbones/core";

import {
  type CampaignReport,
  neverCleared,
  unrecordedSectorsOf,
} from "../modules/ledgers/domain/services/campaign-report.service.js";
import { count } from "./lines.js";

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
          .filter(
            (one) =>
              one.unrecorded && (one.count > 0 || objective.ledgered || one.measure !== undefined),
          )
          .map(
            (one) =>
              `  ${objective.id} · ${one.sector}  (${
                one.measure === undefined
                  ? count(one.count, "hit")
                  : `measures ${one.measure.value === null ? "no number" : String(one.measure.value)}`
              })`,
          ),
      );

      say(
        "",
        neverCleared(campaign)
          ? `campaign ${campaign.id}: ${count(unrecorded.length, "sector")} in an objective's window that no ledger has seen. Record them before they count as growth:`
          : `campaign ${campaign.id}: ${unrecordedSectorsOf(campaign).join(", ")} entered a window since the last clear, and its objectives have no ledger entries for it yet. Record what is there before it counts as growth:`,
        ...unrecorded,
        "",
        `  architecture objectives clear ${campaign.id}`,
      );
    }

    if (campaign.unmeasured.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.unmeasured.length, "sector")} where a scalar objective measured no number — a function that answered something other than a number of zero or more, or a command that did not run or printed none:`,
        ...campaign.unmeasured.map((one) => `  ${one.objective} · ${one.sector}`),
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
        `campaign ${campaign.id}: a ledger does not add up (holdouts ≠ initial + conceded − cleared − closed; for a scalar, recorded ≠ initial + risen − improved). The ledger was edited by hand; restore it, or record the change with \`objectives concede\`.`,
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
