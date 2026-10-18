// Implements queued issues: claim the oldest one labelled auto:eligible, let
// the agent implement it in a worktree, run the local gate, open the pull
// request, wait for CI and hand off for review.
//
// Each block is a durable activity from @chernabog/sdk. Reorder them, leave
// one out, or put a step of your own from .chernabog/stages/ in between with
// `step("name", input, OutputSchema)`. Side effects belong inside activities or
// steps, never in the workflow body, which runs again whenever the run resumes.

import { defineFlow, Implement } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

export default defineFlow({
  trigger: Implement.trigger,
  gate: Implement.gate,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      const worktree = yield* Implement.prepareWorktree(branch);
      const outcome = yield* Implement.implementWithAgent(issue, worktree);

      if (outcome.status === 'needs-clarification') return yield* Implement.askForClarification(issue, outcome).pipe(Effect.flatMap(Implement.endForPerson));

      let pullRequest = Option.none<number>();

      return yield* Effect.gen(function* () {
        yield* Implement.localGate(worktree);
        yield* Implement.push('push', worktree, branch);
        const opened = yield* Implement.openPullRequest(issue, outcome);
        pullRequest = Option.some(opened.number);
        yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch });

        return yield* Implement.handOff(issue, opened, outcome);
      }).pipe(
        Effect.catchTag('NeedsHuman', (needsHuman) =>
          Implement.handToHuman(issue, needsHuman.reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson)),
        ),
      );
    }),
});
