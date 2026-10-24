// Reviews again when the author asks: a pull request this persona reviewed
// requests its review once more. It resumes the session of its own review,
// says which findings are remediated, and approves, which merges an auto:ship
// pull request when that's safe, or requests changes again and hands the pull
// request to a person. limits.reviewRounds caps the re-reviews, and a pull
// request labelled auto:needs-human is left alone.
//
// This file is chernabog's re-review recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("find-review", "review-2") are the keys a
// run in flight resumes by, so renaming one restarts that step.

import {
  defineFlow,
  PullRequest,
  Repo,
  reportAs,
  Review,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Pull requests that ask this persona again after it reviewed them, one item
// per request, unless a person has them (auto:needs-human): asking again
// during a dispute doesn't restart the loop.
const trigger = Effect.gen(function* () {
  const repo = yield* Repo;

  return (yield* Review.reviewRequests).flatMap(({ pull, reviewed }) =>
    Option.toArray(
      Option.liftPredicate(
        Review.reviewItem(pull, `pr-${pull.number}-review-${reviewed + 1}`),
        () => reviewed > 0 && !pull.labels.includes(repo.labels.needsHuman),
      ),
    ),
  );
}).pipe(reportAs("trigger"));

// Chernabog merges only pull requests on the automated path (auto:ship), and
// only when that's safe; a person merges any other.
const mergeIfShipping = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* PullRequest.shipping(pullRequest))) {
      return `#${pullRequest} approved; a person merges`;
    }

    return yield* PullRequest.merge(pullRequest, { method: "squash" }).pipe(
      Effect.catchTag("MergeRefused", (refused) =>
        PullRequest.handToPerson(pullRequest, refused.message),
      ),
    );
  });

// A first review, for a pull request with no review of this persona's to resume.
const reviewAfresh = (pullRequest: number) =>
  Effect.gen(function* () {
    const review = yield* Review.round(pullRequest, 1, { role: "reviewer" });
    yield* Review.doneReviewing(pullRequest);

    if (review.verdict === "approve") {
      return yield* mergeIfShipping(pullRequest);
    }

    return `#${pullRequest}: review 1 requested changes`;
  });

const listed = (findings: ReadonlyArray<Review.Finding>, remediated: boolean) =>
  findings.flatMap((finding) =>
    Option.toArray(
      Option.liftPredicate(`- ${finding.finding}`, () => finding.remediated === remediated),
    ),
  );

const reReviews = (count: number) => {
  if (count === 1) {
    return "1 re-review";
  }

  return `${count} re-reviews`;
};

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const { pullRequest } = yield* Review.pullRequestOf(item);
    const earlier = yield* Review.latestOwnReview(pullRequest);

    // No review of its own to resume, as one posted before markers named their reviewer: review afresh.
    if (Option.isNone(earlier) || Option.isNone(Option.fromUndefinedOr(earlier.value.sessionId))) {
      return yield* reviewAfresh(pullRequest);
    }

    const round = earlier.value.round ?? 1;
    const done = round - 1;

    if (done >= repo.limits.reviewRounds) {
      return yield* PullRequest.handToPerson(
        pullRequest,
        `asked to review again after ${reReviews(done)}, and limits.reviewRounds is ${repo.limits.reviewRounds}, so a person decides. Review ${round}'s findings are in its review above.`,
      );
    }

    const rechecked = yield* Review.recheck(pullRequest, earlier.value);
    yield* Review.doneReviewing(pullRequest);
    yield* PullRequest.comment(
      pullRequest,
      [
        `Review ${round}'s findings, re-reviewed.`,
        "",
        "Remediated:",
        ...listed(rechecked.findings, true),
        "",
        "Still open:",
        ...listed(rechecked.findings, false),
      ].join("\n"),
    );

    if (rechecked.verdict === "approve") {
      return yield* mergeIfShipping(pullRequest);
    }

    return yield* PullRequest.handToPerson(
      pullRequest,
      `review ${rechecked.round ?? 2} still requests changes after a round of fixes`,
    );
  }).pipe(
    // A pull request closed, or gone, while the review ran leaves nothing to do.
    Effect.catchTags({
      PullRequestClosed: (closed) => Effect.fail(new Skip({ reason: closed.message })),
      NotFound: (gone) => Effect.fail(new Skip({ reason: gone.message })),
    }),
  );

export default defineFlow({
  trigger,
  concurrency: 1,
  // Its trigger finds only pull requests that ask this persona for a review.
  ownWork: true,
  workflow,
});
