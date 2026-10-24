// Unsticks pull requests this persona wrote that conflict with their base
// branch. GitHub runs no CI on a conflicting pull request, so it would wait
// for checks that never start, and it can't merge. An agent merges the base
// into the branch in the author's worktree, resolves the conflicts and commits
// the merge; chernabog runs the local gate, pushes (a plain push: the merge
// only adds commits, so nothing is rewritten) and waits for CI. A run of
// another flow waiting on the pull request's CI, such as implement's, carries
// on from there.
//
// A pull request labelled auto:needs-human is a person's and is left alone,
// as is one that a run of another flow owns.

import {
  activity,
  Agent,
  defineFlow,
  GitHub,
  Implement,
  NeedsHuman,
  PullRequest,
  renderPrompt,
  Repo,
  reportAs,
  Review,
  Run,
  StepFailed,
  type Json,
  type WorkItem,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// GitHub computes mergeability in the background: `mergeable_state` is
// "dirty" for a conflict, and "unknown" until it has looked, which the next
// tick sees again.
const MergeState = Schema.Struct({ mergeable_state: Schema.String });

const ConflictItem = Schema.Struct({
  pullRequest: Schema.Finite,
  headRef: Schema.String,
  baseRef: Schema.String,
});

type ConflictItem = typeof ConflictItem.Type;

const decodeIn =
  <A>(schema: Schema.Codec<A, Json>, step: string) =>
  (json: Json) =>
    Schema.decodeEffect(schema)(json).pipe(
      Effect.mapError((issue) => new StepFailed({ step, message: issue.message })),
    );

// Open pull requests this persona wrote that conflict with their base. The
// key carries the head, so a conflict that comes back after a later push is
// new work.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const items: Array<WorkItem> = [];

  for (const pull of yield* Review.authoredByMe) {
    if (pull.labels.includes(repo.labels.needsHuman) || (yield* Review.ownedByARun(pull))) {
      continue;
    }

    const state = yield* github
      .request("GET", `/repos/${repo.slug}/pulls/${pull.number}`, Option.none())
      .pipe(Effect.flatMap(decodeIn(MergeState, "trigger")));

    if (state.mergeable_state !== "dirty") {
      continue;
    }

    items.push({
      key: `pr-${pull.number}-${pull.headSha.slice(0, 7)}`,
      title: pull.title,
      url: pull.url,
      data: { pullRequest: pull.number, headRef: pull.headRef, baseRef: pull.baseRef },
    });
  }

  return items;
}).pipe(reportAs("trigger"));

const Resolution = Schema.Struct({
  status: Schema.Literals(["resolved", "needs-human"]),
  summary: Schema.String,
});

const resolutionJsonSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["resolved", "needs-human"],
      description: "resolved once the merge is committed; needs-human when a person must decide",
    },
    summary: {
      type: "string",
      description:
        "Which files conflicted and how you resolved each, or what a person must decide and why",
    },
  },
  required: ["status", "summary"],
  additionalProperties: false,
} satisfies Json;

// The agent merges the base into the branch and commits the merge, in its own session.
const resolve = (conflict: ConflictItem, worktree: string, sessionId: string) =>
  activity(
    "resolve",
    Effect.gen(function* () {
      const repo = yield* Repo;

      const prompt = yield* renderPrompt("resolve-conflicts", {
        repo: repo.slug,
        pullRequest: conflict.pullRequest,
        branch: conflict.headRef,
        base: conflict.baseRef,
        humanOnly: repo.humanOnly,
        notes: repo.notes,
        localGate: repo.localGate,
      });

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId,
        resumePrompt: Option.none(),
        outputSchema: Option.some(resolutionJsonSchema),
        adapter: Option.none(),
      });

      return yield* Schema.decodeUnknownEffect(Resolution)(result.output).pipe(
        Effect.mapError(
          (issue) => new StepFailed({ step: "resolve", message: `agent answer: ${issue.message}` }),
        ),
      );
    }),
    Resolution,
  );

const unstick = (conflict: ConflictItem) =>
  Effect.gen(function* () {
    const run = yield* Run;
    const sessionId = Implement.sessionIdFor(run.runId, "resolve-conflicts");
    // The local gate and CI send failures back to the session that resolved the conflict.
    const session = { sessionId: Option.some(sessionId), adapter: Option.none<string>() };

    const worktree = yield* Review.prepareAuthorWorktree(conflict.headRef);
    const resolution = yield* resolve(conflict, worktree, sessionId);

    if (resolution.status === "needs-human") {
      return yield* new NeedsHuman({
        reason: `the merge conflict needs a person:\n\n${resolution.summary}`,
      });
    }

    yield* Implement.localGate(worktree, { id: "resolve", session });
    yield* Implement.push("push-resolved", worktree, conflict.headRef);
    yield* PullRequest.comment(
      conflict.pullRequest,
      `Merged \`${conflict.baseRef}\` into this branch to resolve its conflicts.\n\n${resolution.summary}`,
    );
    yield* Implement.waitForCi(
      conflict.pullRequest,
      worktree,
      { ...session, branch: conflict.headRef },
      { id: "resolve" },
    );

    return `#${conflict.pullRequest}: merged ${conflict.baseRef} and resolved its conflicts`;
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const conflict = yield* Schema.decodeUnknownEffect(ConflictItem)(item.data).pipe(
      Effect.mapError((issue) => new StepFailed({ step: "item", message: issue.message })),
    );

    const toPerson = (reason: string) => PullRequest.handToPerson(conflict.pullRequest, reason);

    // Anything that stops it hands the pull request to a person.
    return yield* unstick(conflict).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
        NothingCommitted: (nothing) =>
          toPerson(`the agent committed no merge on ${nothing.branch}`),
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
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
