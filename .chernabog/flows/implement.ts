// Implements queued issues: claim the oldest one labelled auto:eligible or
// auto:ship, let the agent implement it in a worktree, run the local gate,
// open the pull request, wait for CI and hand off for review, which asks one
// reviewer from the team's pool. An auto:ship issue's pull request carries the
// label too, so its approving reviewer merges it.
//
// Each block is a durable activity from @chernabog/sdk. Reorder them, leave
// one out, or put a step of your own from .chernabog/stages/ in between with
// `step("name", input, OutputSchema)`. Side effects belong inside activities or
// steps, never in the workflow body, which runs again whenever the run resumes.
//
// This file is chernabog's implement recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("claim", "local-gate-1") are the keys a run
// in flight resumes by, so renaming one restarts that step.

import { defineFlow, GitHub, Implement, Repo, reportAs, Skip } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Issues labelled auto:eligible, then ones labelled auto:ship, the automated
// path, whose pull request chernabog merges once it's approved. Oldest first;
// with a board, only those whose Status is its readyStatus.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const eligible = yield* github.queuedIssuesLabelled(repo.labels.eligible);

  const shipping = (yield* github.queuedIssuesLabelled(repo.labels.ship)).filter(
    (issue) => !eligible.some((queued) => queued.number === issue.number),
  );

  return [
    ...eligible.map((issue) => Implement.issueItem(issue)),
    ...shipping.map((issue) => Implement.issueItem(issue, Option.some(repo.labels.ship))),
  ];
}).pipe(reportAs("trigger"));

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const queued = yield* Implement.queuedBy(item);
      const { branch } = yield* Implement.claim(issue, queued);
      let pullRequest = Option.none<number>();

      const toPerson = (reason: string) =>
        Implement.handToHuman(issue, reason, pullRequest).pipe(
          Effect.flatMap(Implement.endForPerson),
        );

      return yield* Effect.gen(function* () {
        const worktree = yield* Implement.prepareWorktree(branch);
        const outcome = yield* Implement.implementWithAgent(issue, worktree);

        if (outcome.status === "needs-clarification") {
          return yield* Implement.askForClarification(issue, outcome, queued).pipe(
            Effect.flatMap(Implement.endForPerson),
          );
        }

        return yield* Effect.gen(function* () {
          yield* Implement.localGate(worktree);
          yield* Implement.push("push", worktree, branch);
          const opened = yield* Implement.openPullRequest(issue, outcome, queued);
          pullRequest = Option.some(opened.number);
          yield* Implement.waitForCi(opened.number, worktree, {
            ...Implement.thisRunsSession,
            branch,
          });

          return yield* Implement.handOff(issue, opened, outcome);
        }).pipe(
          Effect.catchTags({
            NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
            // Nothing to push, a push the token may not make (its message
            // says the fix), CI that never finishes, or a pull request closed
            // under the run: each is a person's to look into.
            NothingCommitted: (nothing) =>
              toPerson(`the agent finished without committing anything on ${nothing.branch}`),
            PushRejected: (rejected) => toPerson(rejected.message),
            CiTimedOut: (timedOut) => toPerson(timedOut.message),
            PullRequestClosed: (closed) => toPerson(closed.message),
          }),
        );
      }).pipe(
        // Any other failure once the issue is claimed hands it to a person, rather
        // than leaving it claimed with nobody working on it.
        Effect.catchTag("StepFailed", (failed) => toPerson(`${failed.step}: ${failed.message}`)),
      );
    }).pipe(
      // An issue deleted or transferred under the run leaves nothing to do.
      Effect.catchTag("NotFound", (gone) => Effect.fail(new Skip({ reason: gone.message }))),
    ),
});
