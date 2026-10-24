// Answers a review that asks for changes on a pull request this persona
// wrote, in the session that wrote the code. It considers the findings first:
// when it disagrees, it replies with its reasons and hands the pull request to
// a person, without pushing. Otherwise it makes the changes, runs the local
// gate, pushes, waits for CI and asks the reviewer again, whose re-review
// takes it from there.
//
// This file is chernabog's address-review recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("consider-review-1", "push-review-1") are
// the keys a run in flight resumes by, so renaming one restarts that step.

import {
  defineFlow,
  Implement,
  NeedsHuman,
  PullRequest,
  Repo,
  reportAs,
  Review,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Pull requests this persona wrote whose latest approval or request for
// changes asks for changes on the current head, so nothing was pushed since.
// A person has one labelled auto:needs-human, and a run of another flow one it
// owns; both are left alone.
const trigger = Effect.gen(function* () {
  const repo = yield* Repo;
  const items: Array<WorkItem> = [];

  for (const pull of yield* Review.authoredByMe) {
    if (pull.labels.includes(repo.labels.needsHuman)) {
      continue;
    }

    const decisive = yield* Review.decisiveReviews(pull.number);
    const latest = Arr.last(decisive);

    if (
      !Option.exists(
        latest,
        (review) => review.state === "CHANGES_REQUESTED" && review.commitSha === pull.headSha,
      )
    ) {
      continue;
    }

    if (yield* Review.ownedByARun(pull)) {
      continue;
    }

    for (const review of Option.toArray(latest)) {
      items.push(Review.addressItem(pull, review, decisive.length));
    }
  }

  return items;
}).pipe(reportAs("trigger"));

const answerReview = (address: Review.AddressItem) =>
  Effect.gen(function* () {
    const review = yield* Review.changesAsked(address);
    const round = review.round ?? 1;
    const author = yield* Review.authorSession(address.pullRequest);

    // A pull request a person worked on with the agent reopens their session in front of them.
    const session = {
      sessionId: Option.some(author.sessionId),
      adapter: Option.some(author.adapter),
      withPerson: author.withPerson === true,
    };

    const worktree = yield* Review.prepareAuthorWorktree(address.headRef);
    const decision = yield* Implement.considerFindings(address.pullRequest, review, session);

    // A dispute is a person's to settle: it never pushes, nor asks the reviewer again.
    if (decision.status === "decline") {
      yield* PullRequest.comment(
        address.pullRequest,
        `Not addressing review ${round}:\n\n${decision.reasons}`,
      );

      return yield* new NeedsHuman({
        reason: `the author disputes review ${round}; see its reasons above`,
      });
    }

    const outcome = yield* Implement.addressFindings(address.pullRequest, review, session);

    if (outcome.status === "needs-clarification") {
      return yield* new NeedsHuman({
        reason: `the author agent needs a person to answer review ${round}:\n\n${outcome.questions ?? outcome.summary}`,
      });
    }

    yield* Review.checkChanged(address.pullRequest, round, address.reviewedSha, worktree);
    yield* Implement.localGate(worktree, { id: `review-${round}`, session });
    // Only a fix made in front of a person may touch humanOnlyPaths.
    yield* Implement.push(`push-review-${round}`, worktree, address.headRef, {
      withPerson: session.withPerson,
    });
    yield* Implement.waitForCi(
      address.pullRequest,
      worktree,
      { ...session, branch: address.headRef },
      { id: `review-${round}` },
    );
    yield* Review.askAgain(address.pullRequest, round, address.reviewer, outcome.summary);

    return `#${address.pullRequest}: addressed review ${round}; asked ${address.reviewer} to review again`;
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const address = yield* Review.addressItemOf(item);

    const toPerson = (reason: string) => PullRequest.handToPerson(address.pullRequest, reason);

    // Anything that stops it hands the pull request to a person, unless it closed meanwhile.
    return yield* answerReview(address).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
        NothingCommitted: (nothing) =>
          toPerson(`the author agent committed nothing on ${nothing.branch}`),
        // Its message says how to fix the token, such as one without the workflow scope.
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
        PullRequestClosed: (closed) => Effect.fail(new Skip({ reason: closed.message })),
        NotFound: (gone) => Effect.fail(new Skip({ reason: gone.message })),
      }),
    );
  });

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  workflow,
});
