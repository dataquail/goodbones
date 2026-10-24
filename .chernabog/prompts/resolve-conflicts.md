# Resolve the merge conflicts on pull request #{{pullRequest}} in {{repo}}

You are running **unattended** in the worktree of branch `{{branch}}`, the head of pull request #{{pullRequest}}. Nobody is watching and nobody will answer questions. The branch conflicts with `{{base}}`, so GitHub runs no CI on it and it can't merge. Merge `{{base}}` into the branch, resolve the conflicts, commit the merge, and give your final answer. Chernabog does the rest: it runs the local gate, pushes, and waits for CI, and sends you back here if either fails.

## Steps

1. `git fetch origin {{base}}`, then `git merge --no-ff origin/{{base}}`.
2. Resolve each conflicted file so it keeps **both** sides' intent: the pull request's change, applied on top of what `{{base}}` now has. Read the pull request's own commits (`git log origin/{{base}}..HEAD`) and what changed on `{{base}}` since the branch was cut (`git log HEAD..origin/{{base}}`) to understand each side before choosing.
3. Generated files are regenerated, never hand-merged. For a lockfile (`pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `yarn.lock`), take `{{base}}`'s version (`git checkout --theirs <lockfile>`), then rerun the pull request's dependency change on top of it with the package manager, for example the same `pnpm update …` or `pnpm add …` its commits describe. Then check the install is reproducible (`pnpm install --frozen-lockfile`, or the equivalent).
4. Make sure nothing is left: no conflict markers (`git diff --check`, and `grep -rn '^<<<<<<< \|^>>>>>>> '` over the files that conflicted), and `git status` shows no unmerged paths.
5. Commit the merge with git's default merge message (`git commit --no-edit`). Run the local gate below before you answer.

## Ground rules

- **Never** rebase, reset, amend, force-push, push, or switch branches. Chernabog pushes `{{branch}}` for you, and the merge must only add commits on top of what is already pushed.
- Don't widen the pull request: resolve conflicts, and change nothing the conflict doesn't require. If `{{base}}` changed an API the pull request uses, adapt the pull request's code to it, and say so in your summary.
- Answer `needs-human` instead of guessing when the two sides contradict each other in a way only a person can settle, for example both rewrite the same logic differently, or one deletes what the other changes. Then abort the merge (`git merge --abort`) so the branch is left as it was.
- Stop with `needs-human` before any change that needs one of these decisions:

{{humanOnly}}

## Repo notes

{{notes}}

## The local gate

Chernabog runs these after you answer; run them yourself first.

{{localGate}}

## Your answer

`status`: `resolved` once the merge is committed and the local gate passes, or `needs-human`. `summary`: which files conflicted and how you resolved each one, or what a person must decide and why.
