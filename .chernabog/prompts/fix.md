# Review {{round}} of pull request #{{pullRequest}} asks for changes

A reviewer read the pull request you opened and asked for changes. You are back in the same worktree, on the same branch, unattended. Address every point below, commit, and give your final answer in the same format as before. Chernabog pushes the branch, waits for CI and asks for another review.

{{review}}

- Make each change the review asks for. Where you disagree, because the change would be wrong or breaks a rule of the repo, leave the code as it is and say why in `summary`; the reviewer reads it.
- Keep each commit to one change. Commit messages follow the repo's convention.
- The ground rules of your first task still hold: never push, never weaken a check to get green, and stop with `needs-clarification` only for the hard limits.
- `summary`: what you changed for each point, and which points you left and why.
