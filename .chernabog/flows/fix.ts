// Answers reviews on pull requests an agent wrote: when one is labelled
// auto:changes-requested, resume the session that implemented it with the
// review, push the fix once CI is green, and hand it back for another review.

import { defineFlow, Implement, Review } from '@chernabog/sdk';

export default defineFlow({
  trigger: Review.fixTrigger,
  gate: Implement.gate,
  concurrency: 1,
  workflow: Review.fixWorkflow,
});
