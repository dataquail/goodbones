import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  attest,
  authorOf,
  baseSideAt,
  type CampaignEvaluation,
  campaignsOf,
  clear,
  concede,
  historyOf,
  note,
  nudgeOf,
  readDiff,
  renderCampaignRows,
  renderHistory,
  renderNudge,
  renderSectorView,
  sectorMovesOf,
  sectorViewOf,
  snapshotCampaignsOf,
} from "@goodbones/campaigns";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { type CliFailure, count, fail, report } from "../output.js";
import type { LoadedPolicy, VerbContext } from "./host.js";

// The campaign commands. `campaigns` alone is the status table; `status
// --changed` is the nudge; `attest` and `note` write a sector's record;
// `history` replays the ledgers' git history. The ledgers themselves are
// written by `objectives clear` (the ledger reconciled with the code
// wherever that is not a regression) and `objectives concede` (the one way
// a holdout is added by hand, with a reason).

const flagOf = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

const CAMPAIGN_SUBCOMMANDS = ["status", "attest", "note", "history", "clear", "concede"] as const;
const OBJECTIVE_SUBCOMMANDS = ["clear", "concede"] as const;
const VALUE_FLAGS = [
  "--reason",
  "--by",
  "--holdouts",
  "--entries",
  "--sector",
  "--campaign",
  "--evidence",
  "--base",
  "--since",
  "--hotfix",
] as const;

// The verbs the family shipped with, refused by name: each has a new name
// or no place.
const RETIRED: Readonly<Record<string, string>> = {
  init: "`campaigns init` is gone: `objectives clear <campaign>` writes a first ledger, recording each sector's initial.",
  prune: "`campaigns prune` is now `objectives clear`.",
  allow: "`campaigns allow` is now `objectives concede`.",
};

// The positionals after the subcommand, with the value flags and their
// values stepped over: whatever is left names the roots to walk, as it
// does for every other command.
const positionalsOf = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const positional: Array<string> = [];
  for (let at = 0; at < argv.length; at += 1) {
    const one = argv[at] ?? "";
    if ((VALUE_FLAGS as ReadonlyArray<string>).includes(one)) {
      at += 1;
      continue;
    }
    if (!one.startsWith("--")) positional.push(one);
  }
  return positional;
};

// `campaigns [status | attest <sector> <phase> | note <sector> "<text>" |
// history [<campaign>]] [roots…]`: the subcommand and its arguments come
// first.
const campaignArgsOf = (
  argv: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): {
  readonly subcommand: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly roots: ReadonlyArray<string>;
} => {
  const positional = positionalsOf(argv);
  const [first, ...rest] = positional;
  if (first === undefined) return { subcommand: undefined, args: [], roots: [] };
  if (first in RETIRED) return { subcommand: first, args: [], roots: rest };
  if (!(CAMPAIGN_SUBCOMMANDS as ReadonlyArray<string>).includes(first)) {
    return { subcommand: undefined, args: [], roots: positional };
  }
  switch (first) {
    case "attest":
      return { subcommand: first, args: rest.slice(0, 2), roots: rest.slice(2) };
    case "note":
      return { subcommand: first, args: rest.slice(0, 2), roots: rest.slice(2) };
    case "history": {
      const [second] = rest;
      return second !== undefined && ids.includes(second)
        ? { subcommand: first, args: [second], roots: rest.slice(1) }
        : { subcommand: first, args: [], roots: rest };
    }
    case "clear":
    case "concede": {
      const [second] = rest;
      return second !== undefined && ids.includes(second.split("/")[0] ?? "")
        ? { subcommand: first, args: [second], roots: rest.slice(1) }
        : { subcommand: first, args: [], roots: rest };
    }
    default:
      return { subcommand: first, args: [], roots: rest };
  }
};

// `objectives [clear [<campaign>[/<objective>]] | concede <campaign>[/<objective>]
// --reason <text>] [roots…]`.
const objectiveArgsOf = (
  argv: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): {
  readonly subcommand: string | undefined;
  readonly target: { campaign: string; objective: string | null } | null;
  readonly roots: ReadonlyArray<string>;
} => {
  const positional = positionalsOf(argv);
  const [first, second, ...rest] = positional;
  if (first === undefined || !(OBJECTIVE_SUBCOMMANDS as ReadonlyArray<string>).includes(first)) {
    return { subcommand: first, target: null, roots: positional.slice(1) };
  }
  const [campaign = "", objective] = (second ?? "").split("/");
  const named = second !== undefined && ids.includes(campaign);
  return {
    subcommand: first,
    target: named ? { campaign, objective: objective ?? null } : null,
    roots: named ? rest : second === undefined ? [] : [second, ...rest],
  };
};

// The one campaign, when there is one, else the one `--campaign` names.
const campaignFor = (
  policy: LoadedPolicy,
  argv: ReadonlyArray<string>,
): Result.Result<CampaignEvaluation["rule"], string> => {
  const named = flagOf(argv, "--campaign");
  if (named !== undefined) {
    const found = campaignsOf(policy).campaignRules.find((rule) => rule.id === named);
    return found === undefined
      ? Result.fail(`no campaign is named "${named}"`)
      : Result.succeed(found);
  }
  const [only] = campaignsOf(policy).campaignRules;
  if (campaignsOf(policy).campaignRules.length === 1 && only !== undefined)
    return Result.succeed(only);
  return Result.fail(
    `this policy declares ${String(campaignsOf(policy).campaignRules.length)} campaigns; say which with --campaign <id>.`,
  );
};

const objectiveFor = (
  rule: CampaignEvaluation["rule"],
  objective: string | null,
): Result.Result<string, string> => {
  if (objective !== null) {
    return rule.objectives.some((one) => one.id === objective)
      ? Result.succeed(objective)
      : Result.fail(`no objective of ${rule.id} is named "${objective}"`);
  }
  const [only] = rule.objectives;
  if (rule.objectives.length === 1 && only !== undefined) return Result.succeed(only.id);
  return Result.fail(
    `campaign ${rule.id} declares ${String(rule.objectives.length)} objectives; say which as ${rule.id}/<objective>.`,
  );
};

export const objectives = (context: VerbContext): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const { argv, defaultRoots, policy } = context;
    const parsed = objectiveArgsOf(
      argv,
      campaignsOf(policy).campaignRules.map((rule) => rule.id),
    );
    const roots = parsed.roots.length > 0 ? parsed.roots : defaultRoots;
    if (campaignsOf(policy).campaignRules.length === 0) {
      return yield* report(["this policy declares no campaigns."]);
    }
    const evaluations = (): ReadonlyArray<CampaignEvaluation> => context.evaluate(roots);

    switch (parsed.subcommand) {
      case "clear": {
        const targets =
          parsed.target === null
            ? campaignsOf(policy).campaignRules
            : campaignsOf(policy).campaignRules.filter(
                (rule) => rule.id === parsed.target?.campaign,
              );
        const by = authorOf(flagOf(argv, "--by")) ?? "unknown";
        const all = evaluations();
        const lines: Array<string> = [];
        for (const rule of targets) {
          const evaluation = all.find((one) => one.rule.id === rule.id);
          if (evaluation === undefined) continue;
          const only = parsed.target?.objective ?? null;
          if (only !== null && !rule.objectives.some((one) => one.id === only)) {
            return yield* Effect.fail(fail(`no objective of ${rule.id} is named "${only}"`));
          }
          const outcomes = yield* Effect.try({
            try: () => clear(policy, evaluation, only, by),
            catch: (cause) => fail(String(cause)),
          });
          // Where each sector went, read off the ledgers as they stood: a
          // clear of one objective places no sector, so it says nothing.
          const moves = only === null ? sectorMovesOf(policy, evaluation) : [];
          for (const outcome of outcomes) {
            const parts = [
              ...(outcome.entered.length > 0
                ? [
                    `${count(outcome.entered.length, "sector")} entered (${outcome.entered.join(", ")})`,
                  ]
                : []),
              ...(outcome.cleared > 0 ? [`${count(outcome.cleared, "holdout")} cleared`] : []),
              ...(outcome.rewritten > 0
                ? [`${count(outcome.rewritten, "holdout")} rewritten`]
                : []),
              ...(outcome.closed > 0 ? [`${count(outcome.closed, "holdout")} closed`] : []),
              ...(outcome.rebaselined.length > 0
                ? [
                    `${count(outcome.rebaselined.length, "sector")} re-baselined (${outcome.rebaselined.join(", ")})`,
                  ]
                : []),
            ];
            if (outcome.measure !== undefined) {
              const moved = [
                ...(outcome.entered.length > 0
                  ? [
                      `${count(outcome.entered.length, "sector")} entered (${outcome.entered.join(", ")})`,
                    ]
                  : []),
                ...(outcome.measure.improved.length > 0
                  ? [
                      `${count(outcome.measure.improved.length, "sector")} improved (${outcome.measure.improved
                        .map((one) => `${one.sector} ${String(one.from)} → ${String(one.to)}`)
                        .join(", ")})`,
                    ]
                  : []),
                ...(outcome.measure.grown.length > 0
                  ? [
                      `${count(outcome.measure.grown.length, "sector")} grown (${outcome.measure.grown
                        .map(
                          (one) =>
                            `${one.sector} ${String(one.from)} → ${String(one.to)}, ${one.phase === null ? "measured, not held" : `as ${one.phase} expects`}`,
                        )
                        .join(", ")})`,
                    ]
                  : []),
                ...(outcome.closed > 0 ? [`${count(outcome.closed, "sector")} closed`] : []),
                ...(outcome.rebaselined.length > 0
                  ? [
                      `${count(outcome.rebaselined.length, "sector")} re-baselined (${outcome.rebaselined.join(", ")})`,
                    ]
                  : []),
              ];
              lines.push(
                `${outcome.campaign}/${outcome.objective}: ${moved.length === 0 ? "nothing to clear" : moved.join(", ")}; held to ${String(outcome.measure.recorded)}.`,
              );
              continue;
            }
            lines.push(
              `${outcome.campaign}/${outcome.objective}: ${parts.length === 0 ? "nothing to clear" : parts.join(", ")}; ${count(outcome.left, "holdout")} left.`,
            );
          }
          for (const move of moves) {
            lines.push(
              `${move.campaign}: ${move.sector} ${move.back ? "went back" : "moved"} ${move.from ?? "done"} → ${move.to ?? "done"}` +
                (move.passed.length === 0
                  ? "."
                  : `, passing ${move.passed.join(", ")} in the same clear: nothing there was ever counted for it.`),
            );
          }
        }
        return yield* report(lines);
      }
      case "concede": {
        if (parsed.target === null) {
          return yield* Effect.fail(
            fail(
              "objectives concede needs a campaign: `objectives concede <campaign>[/<objective>] --reason <text>`",
            ),
          );
        }
        const rule = campaignsOf(policy).campaignRules.find(
          (one) => one.id === parsed.target?.campaign,
        );
        if (rule === undefined)
          return yield* Effect.fail(fail(`no campaign is named "${parsed.target.campaign}"`));
        const objective = objectiveFor(rule, parsed.target.objective);
        if (Result.isFailure(objective)) return yield* Effect.fail(fail(objective.failure));
        const reason = flagOf(argv, "--reason");
        if (reason === undefined) {
          return yield* Effect.fail(
            fail(
              "objectives concede needs --reason <text>: growth is recorded with why, or not at all.",
            ),
          );
        }
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null) {
          return yield* Effect.fail(
            fail("objectives concede needs an author: pass --by <email>, or set git's user.email."),
          );
        }
        const evaluation = evaluations().find((one) => one.rule.id === rule.id);
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.id} was not evaluated`));
        // `--holdouts` concedes a subset and refuses the rest: a pull
        // request that legitimately adds one hit while another is an
        // accident.
        const chosen =
          (flagOf(argv, "--holdouts") ?? flagOf(argv, "--entries"))
            ?.split(",")
            .map((one) => one.trim()) ?? null;
        const outcome = concede(
          policy,
          evaluation,
          objective.success,
          chosen,
          flagOf(argv, "--sector") ?? null,
          {
            at: policy.now,
            by,
            reason,
          },
        );
        if (Result.isFailure(outcome)) return yield* Effect.fail(fail(outcome.failure));
        // A concession that sends a sector back a phase says so, and names
        // the attestations it revoked on the way.
        const sentBack = outcome.success.sentBack.flatMap((one) => [
          "",
          `this concession moves ${one.sector} back ${one.from ?? "done"} → ${one.to ?? "done"}.`,
          ...(one.revoked.length === 0
            ? []
            : [
                `It revokes ${one.sector}'s attestation of ${one.revoked.join(", ")}: what was attested no longer holds. Once it does again, attest it anew:`,
                ...one.revoked.map(
                  (phase) =>
                    `  architecture campaigns attest ${one.sector} ${phase} --reason "…" --campaign ${rule.id}`,
                ),
              ]),
        ]);
        const scalar =
          rule.objectives.find((one) => one.id === objective.success)?.measure !== null;
        if (scalar) {
          if (outcome.success.conceded.length === 0) {
            return yield* report([
              `${rule.id}/${objective.success}: nothing to concede; no sector measures past its record.`,
            ]);
          }
          return yield* report([
            `${rule.id}/${objective.success}: a rise conceded in ${count(outcome.success.conceded.length, "sector")}, recorded by ${by}.`,
            ...outcome.success.conceded.map((one) => `  ${one.sector} · ${one.entry}`),
            ...(outcome.success.left.length === 0
              ? []
              : [
                  "",
                  `${count(outcome.success.left.length, "sector")} left past the record; check still fails on them.`,
                ]),
            ...sentBack,
          ]);
        }
        if (outcome.success.conceded.length === 0) {
          return yield* report([
            `${rule.id}/${objective.success}: nothing to concede; every hit is in the ledger.`,
          ]);
        }
        return yield* report([
          `${rule.id}/${objective.success}: ${count(outcome.success.conceded.length, "holdout")} conceded, recorded by ${by}.`,
          ...outcome.success.conceded.map((one) => `  ${one.sector} · ${one.entry}`),
          ...(outcome.success.left.length === 0
            ? []
            : [
                "",
                `${count(outcome.success.left.length, "hit")} left unrecorded; check still fails on them.`,
              ]),
          ...sentBack,
        ]);
      }
      default:
        return yield* Effect.fail(
          fail(
            `unknown objectives subcommand "${parsed.subcommand ?? ""}". Try: objectives clear [<campaign>[/<objective>]] | objectives concede <campaign>[/<objective>] --reason <text> [--by <email>] [--sector <name>] [--holdouts a,b]`,
          ),
        );
    }
  });

export const campaigns = (context: VerbContext): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const { argv, defaultRoots, policy } = context;
    const parsed = campaignArgsOf(
      argv,
      campaignsOf(policy).campaignRules.map((rule) => rule.id),
    );
    const roots = parsed.roots.length > 0 ? parsed.roots : defaultRoots;
    if (campaignsOf(policy).campaignRules.length === 0) {
      return yield* report(["this policy declares no campaigns."]);
    }
    const json = argv.includes("--json");
    const retired = parsed.subcommand === undefined ? undefined : RETIRED[parsed.subcommand];
    if (retired !== undefined) return yield* Effect.fail(fail(retired));
    // A positional that is no path is refused, not walked: most often it is
    // a sector's name, and `--sector` is what asks about one.
    for (const root of parsed.roots) {
      if (existsSync(path.resolve(policy.repoRoot, root))) continue;
      const named = context.evaluate(defaultRoots).some((one) => one.sectors.has(root));
      return yield* Effect.fail(
        fail(
          `campaigns: ${root} is not a path in the repository, so there is nothing to walk there.` +
            (named ? ` It names a sector: \`campaigns status --sector ${root}\`.` : ""),
        ),
      );
    }
    const sector = flagOf(argv, "--sector");
    if (parsed.subcommand === "status" && sector !== undefined) {
      const only = argv.includes("--campaign") ? campaignFor(policy, argv) : null;
      if (only !== null && Result.isFailure(only)) return yield* Effect.fail(fail(only.failure));
      const views = context
        .evaluate(roots)
        .filter((one) => only === null || one.rule.id === only.success.id)
        .flatMap((one) => {
          const view = sectorViewOf(policy, one, sector);
          return view === null ? [] : [view];
        });
      if (views.length === 0) {
        return yield* Effect.fail(
          fail(`campaigns: no campaign under ${roots.join(", ")} has a sector named ${sector}.`),
        );
      }
      return yield* report(
        json
          ? [JSON.stringify({ version: 1, sectors: views }, null, 2)]
          : views.flatMap((view, i) => [...(i === 0 ? [] : [""]), ...renderSectorView(view)]),
      );
    }

    // `status` without `--changed` is the overview, in text or JSON: the
    // nudge alone is scoped to a diff.
    const subcommand =
      parsed.subcommand === "status" && !argv.includes("--changed") ? undefined : parsed.subcommand;
    switch (subcommand) {
      case undefined: {
        const snapshot = { campaigns: snapshotCampaignsOf(policy, context.evaluate(roots)) };
        if (json) {
          // Each campaign as the conformance snapshot carries it: its
          // burn-down, its ladder, and a row per sector.
          return yield* report([
            JSON.stringify({ version: 1, campaigns: snapshot.campaigns }, null, 2),
          ]);
        }
        return yield* report([
          `${count(snapshot.campaigns.length, "campaign")} under ${roots.join(", ")}`,
          "",
          ...renderCampaignRows(snapshot.campaigns),
          "",
          "  architecture campaigns status --changed [--base <ref>] [--json]   # what a diff touches, and what to do",
          "  architecture campaigns status --sector <sector> [--json]          # where one sector stands, and what holds it",
          "  architecture objectives clear [<campaign>[/<objective>]]        # reconcile the ledgers with the code",
          '  architecture objectives concede <campaign>[/<objective>] --reason "<why>"   # record why a count may rise',
          '  architecture campaigns attest <sector> <phase> --reason "<why>" [--evidence <url>]',
          '  architecture campaigns note <sector> "<text>"',
          "  architecture campaigns history [<campaign>] [--since <ref>]",
        ]);
      }
      case "status": {
        const base = flagOf(argv, "--base") ?? null;
        const diff = yield* Effect.try({
          try: () => readDiff(policy.repoRoot, base),
          catch: (cause) => fail(`could not read the diff: ${String(cause)}`),
        });
        const current = context.evaluate(roots);
        const baseSide =
          base === null
            ? null
            : yield* Effect.tryPromise({
                try: () => baseSideAt(policy, base, roots, context.reload),
                catch: (cause) =>
                  fail(`could not evaluate the base tree at ${base}: ${String(cause)}`),
              });
        // The ledger mode's "before" for work done ahead of the plan is the
        // HEAD tree, evaluated once per commit and cached: no ledger counts
        // the holdouts of a phase a sector has not entered.
        const headTree =
          base !== null || !current.some((one) => one.rule.phases.length > 0)
            ? null
            : yield* Effect.tryPromise({
                try: () => baseSideAt(policy, "HEAD", roots, context.reload),
                catch: (cause) => fail(`could not evaluate the tree at HEAD: ${String(cause)}`),
              });
        const hotfix = flagOf(argv, "--hotfix") ?? null;
        const nudge = nudgeOf(
          policy,
          current,
          diff,
          baseSide,
          hotfix,
          hotfix === null ? null : authorOf(flagOf(argv, "--by")),
          headTree,
        );
        yield* report(json ? [JSON.stringify(nudge, null, 2)] : renderNudge(nudge, policy.now));
        if (!nudge.ok) {
          const ahead = nudge.sectors.some((one) => one.verdict === "ahead");
          const back = nudge.sectors.some(
            (one) => one.verdict !== "ok" && one.verdict !== "ahead" && one.verdict !== "hotfix",
          );
          return yield* Effect.fail(
            fail(
              [
                ...(back ? ["the diff sends a sector back under its onTouch"] : []),
                ...(ahead ? ["the diff works ahead of a sector's phase under its onAhead"] : []),
              ].join("; "),
            ),
          );
        }
        return;
      }
      case "attest": {
        const [sector, phase] = parsed.args;
        if (sector === undefined || phase === undefined) {
          return yield* Effect.fail(
            fail(
              'campaigns attest needs a sector and a phase: `campaigns attest <sector> <phase> --reason "<why>"`',
            ),
          );
        }
        const reason = flagOf(argv, "--reason");
        if (reason === undefined)
          return yield* Effect.fail(fail("campaigns attest needs --reason <text>."));
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null)
          return yield* Effect.fail(
            fail("campaigns attest needs an author: pass --by <email>, or set git's user.email."),
          );
        const rule = campaignFor(policy, argv);
        if (Result.isFailure(rule)) return yield* Effect.fail(fail(rule.failure));
        const evaluation = context.evaluate(roots).find((one) => one.rule.id === rule.success.id);
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.success.id} was not evaluated`));
        const written = attest(policy, evaluation, sector, phase, {
          reason,
          evidence: flagOf(argv, "--evidence"),
          by,
        });
        if (Result.isFailure(written)) return yield* Effect.fail(fail(written.failure));
        return yield* report([
          `${rule.success.id}: sector ${sector} attested at ${phase} by ${by}, in ${written.success}.`,
          "Run `objectives clear` to move it on.",
        ]);
      }
      case "note": {
        const [sector, text] = parsed.args;
        if (sector === undefined || text === undefined) {
          return yield* Effect.fail(
            fail('campaigns note needs a sector and a text: `campaigns note <sector> "<text>"`'),
          );
        }
        const by = authorOf(flagOf(argv, "--by"));
        if (by === null)
          return yield* Effect.fail(
            fail("campaigns note needs an author: pass --by <email>, or set git's user.email."),
          );
        const rule = campaignFor(policy, argv);
        if (Result.isFailure(rule)) return yield* Effect.fail(fail(rule.failure));
        const evaluation = context.evaluate(roots).find((one) => one.rule.id === rule.success.id);
        if (evaluation === undefined)
          return yield* Effect.fail(fail(`campaign ${rule.success.id} was not evaluated`));
        const written = note(policy, evaluation, sector, text, by);
        if (Result.isFailure(written)) return yield* Effect.fail(fail(written.failure));
        return yield* report([
          `${rule.success.id}: note left on ${sector}, in ${written.success}.`,
        ]);
      }
      case "history": {
        const [named] = parsed.args;
        const targets =
          named === undefined
            ? campaignsOf(policy).campaignRules
            : campaignsOf(policy).campaignRules.filter((rule) => rule.id === named);
        const manifestPath = path
          .relative(policy.repoRoot, context.manifestPath)
          .replaceAll(path.sep, "/");
        const lines: Array<string> = [];
        for (const rule of targets) {
          const rows = historyOf(policy, rule, flagOf(argv, "--since") ?? null, [manifestPath]);
          if (json) {
            lines.push(JSON.stringify({ campaign: rule.id, rows }, null, 2));
            continue;
          }
          if (lines.length > 0) lines.push("");
          for (const line of renderHistory(rule, rows)) lines.push(line);
        }
        return yield* report(lines);
      }
      case "clear":
      case "concede":
        // The ledger verbs answer under `objectives`; accepted here too.
        return yield* objectives(context);
      default:
        return yield* Effect.fail(
          fail(
            `unknown campaigns subcommand "${parsed.subcommand}". Try: campaigns | campaigns status --changed | campaigns attest <sector> <phase> --reason <text> | campaigns note <sector> "<text>" | campaigns history [<campaign>]`,
          ),
        );
    }
  });
