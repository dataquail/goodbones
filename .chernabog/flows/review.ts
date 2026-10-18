// Reviews pull requests labelled auto:needs-review. Each review runs in a fresh
// session of the agent named by flows.review.agent in config (a different agent
// from the one that wrote the code avoids a model approving its own work), is
// posted on the pull request, and moves its labels. The run then waits for the
// author's push or the staleness timeout, whichever comes first, and reviews
// again, up to limits.reviewRounds. It ends when a person merges, the timeout
// labels the pull request auto:stale, or the loop cap labels it auto:needs-human.

import { defineFlow, Review } from '@chernabog/sdk';

export default defineFlow({
  trigger: Review.trigger,
  concurrency: 1,
  workflow: Review.workflow,
});
