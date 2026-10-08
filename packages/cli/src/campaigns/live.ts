import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import {
  campaignFailuresOf,
  campaignReportsOf,
  campaignsExtension,
  campaignsOf,
  campaignsSelecting,
  evaluateCampaigns,
  explainCampaignLines,
  explainObjective,
  hitsInWindow,
  ledgeredFilter,
  loadCampaignFunctions,
  makeReportSourceLive,
  measureFile,
  renderCampaignReports,
  renderCampaignRows,
  reportSpecsOf,
  snapshotCampaignsOf,
  valueOfParts,
  widenedExtensions,
} from "@goodbones/campaigns";

import type { CampaignsFamily, CampaignsHost } from "./host.js";
import { campaigns, objectives } from "./verbs.js";

// The campaigns family as this host runs it, over `@goodbones/campaigns`.
// The one module that loads the package: the composition root imports it
// through `importOptional`, so its absence is `none`, not a crash.

const firstSentence = (message: string): string =>
  `${(message.split(". ")[0] ?? message).replace(/\.$/, "")}.`;

const host: CampaignsHost = {
  widenedExtensions,
  readReports: async (policy) => {
    const { campaignRules, reports } = campaignsOf(policy);
    await Promise.all(reportSpecsOf(campaignRules).map((spec) => reports.read?.(spec)));
  },
  evaluate: evaluateCampaigns,
  hitsOf: (policy, evaluations) => {
    const isLedgered = ledgeredFilter(policy, evaluations);
    return evaluations.flatMap((evaluation) =>
      hitsInWindow(evaluation).map((hit) => ({
        violation: hit.violation,
        objective: hit.objective,
        sector: hit.sector,
        entry: hit.entry,
        ledgered: isLedgered(hit),
      })),
    );
  },
  reportsOf: campaignReportsOf,
  failuresOf: campaignFailuresOf,
  renderReports: renderCampaignReports,
  snapshotOf: snapshotCampaignsOf,
  renderRows: renderCampaignRows,
  // Each campaign selecting the file: the sector the file is in, its phase
  // and definedness, the objectives in window that fire on it and the
  // nearest remaining holdouts — which needs the campaign evaluated over its
  // files, since a sector's phase is derived from all of them — then each
  // objective's truth table: one line per leaf term and what it answered
  // here, so a detector that "should fire" and does not shows which term is
  // not saying what its author thinks.
  explainLines: (policy, relative, evaluate) => {
    const selected = campaignsSelecting(campaignsOf(policy).campaignRules, relative);
    if (selected.length === 0) return [];
    const evaluations = evaluate();
    return selected.flatMap((rule) => {
      const at = path.join(policy.repoRoot, relative);
      const text = existsSync(at) ? readFileSync(at, "utf8") : "";
      const input = {
        file: relative,
        text,
        facts: policy.extractor.factsOf(relative, text),
        resolver: policy.resolver,
        fileSystem: policy.fileSystem,
        syntax: policy.syntax.parse(relative, text),
        functions: campaignsOf(policy).functions,
        reports: campaignsOf(policy).reports,
      };
      const evaluation = evaluations.find((one) => one.rule.id === rule.id);
      return [
        ...(evaluation === undefined ? [] : explainCampaignLines(policy, evaluation, relative)),
        ...rule.objectives.flatMap((objective) => {
          const measure = objective.measure;
          if (measure !== null) {
            // A scalar: what this file adds to its sector's number.
            if (measure.kind === "command") return [];
            const parts = measureFile(measure, input);
            const here =
              measure.kind === "ratio"
                ? `${String(parts.of)} of ${String(parts.per)} here`
                : `${String(valueOfParts(measure, parts))} here`;
            return [
              `      ${objective.name} — ${firstSentence(objective.intent ?? objective.message)} (measure, ${objective.direction}; ${here})`,
            ];
          }
          const table = explainObjective(objective, input);
          if (table.length === 0) return [];
          const fired = table.length > 0 && table.every((line) => line.answer);
          return [
            `      ${objective.name} — ${firstSentence(objective.intent ?? objective.message)} (${objective.holdout}; ${fired ? "fires here" : "no hit"})`,
            ...table.map(
              (line) =>
                `          ${line.answer ? "✓" : "✗"} ${line.term}${line.count === undefined ? "" : ` (${String(line.count)})`}`,
            ),
          ];
        }),
      ];
    });
  },
  campaigns,
  objectives,
};

export const liveCampaigns: CampaignsFamily = {
  host,
  // The `fn` terms are imported here, before the policy loads: the core
  // receives the functions as a map and touches no module loader. A
  // manifest held as a value has no file for them to resolve against.
  compose: async (repoRoot, configPath, manifest) => {
    const reports = makeReportSourceLive(repoRoot);
    if (configPath === null) {
      return { manifest, extensions: [campaignsExtension({ reports })], uninstalled: [] };
    }
    const loaded = await loadCampaignFunctions(configPath, manifest);
    return {
      manifest: loaded.manifest,
      extensions: [campaignsExtension({ functions: loaded.functions, reports })],
      uninstalled: [],
    };
  },
};
