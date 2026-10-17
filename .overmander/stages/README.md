# Steps

A flow runs a step from this directory with `step("name", input)`. Each runs in its own process.

- **Effect step:** `name.ts`, exporting `defineStage({ name, input, output, run })` from `@overmander/sdk` as its default. It gets the SDK's services and types.
- **Shell step:** an executable `name`. It reads `{ input, repo, run }` as JSON on stdin and prints its output as JSON on the last line of stdout.

Either way: exit 0 to continue, 78 to skip the run, anything else to fail it. A step that crashes partway runs again, so it must be safe to repeat.
