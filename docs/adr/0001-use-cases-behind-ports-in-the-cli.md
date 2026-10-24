# 1. Use-cases behind ports in the CLI

Status: accepted, 2026-10-23.

## Context

goodbones has no record of how its application layer should be shaped.
`@goodbones/core` and `@goodbones/campaigns` are laid out hexagonally (`domain/`, `ports/`,
`core/`, `infrastructure/`) and the root `architecture.yaml` polices them. `@goodbones/cli` is
not. Every verb (`check`, `conformance`, `coverage`, `baseline`, `explain`, `facts`, `init`,
`migrate`) lives inline in `packages/cli/src/run.ts`, about 1,500 lines. One function reads the
baseline from disk, computes the report, renders text or JSON and decides the exit code.
`init`, `migrate` and `baseline` call `node:fs` directly beside the logic that decides what
to write.

chernabog has just made the same move: use-cases over a domain, behind ports, driven by
inbound adapters, with goodbones enforcing the layering (chernabog's
`docs/adr/0001-ddd-use-cases-and-ports.md`, `0002-the-sweep-into-modules.md` and
`0003-use-cases-dont-compose-and-recovery-over-clean-stops.md`). This ADR records how much of
that shape the CLI takes and what it leaves behind, before any code moves, so each follow-up
pull request has one place to point to.

## Decision

1. **The scope is `@goodbones/cli`.** `@goodbones/core` and `@goodbones/campaigns` are already
   hexagonal and policed. Their file paths are named by the root policy's `exports` and
   `reach` rules and keyed in the campaign ledgers under `.architecture-campaigns/`, so they
   don't move. `@goodbones/browser`, `@goodbones/oxlint`, `@goodbones/typescript` and
   `@goodbones/ast-grep` are out of scope.

2. **The layout.** `packages/cli/src/` gets five tiers:
   - `domain/`: the CLI's own pure types and functions: findings, the check and coverage
     reports, shortfalls, overruns and excesses, and the conformance snapshot's
     assembly. No I/O, no Effect services.
   - `ports/`: one `type` per thing the CLI does to the outside world that the core does not
     already give it, for example a baseline store and a manifest store.
   - `infrastructure/`: one `*-live.ts` and one `*-fake.ts` per port.
   - `use-cases/`: one use-case per file (decision 4).
   - `interface/`: one command per verb (decision 5).

   These stay where they are: `main.ts` (the published bin, `build/esm/main.js`),
   `config-loader.ts` (the composition root, named in the root `architecture.yaml`), `run.ts`
   (dispatch from argv to a command), `output.ts` (`CliFailure` and the line writer) and
   `campaigns/` (the optional-peer glue, behind `campaigns/host.ts`).

3. **Ports are plain types, as the core's are.** A port is a `type` with camelCase function
   members, like the core's `FileSystem`. It is passed in as an argument, not provided as an
   Effect `Context.Service`, and has one `*-live.ts` and one `*-fake.ts` in `infrastructure/`.
   This deliberately differs from chernabog, which uses Effect services: the rest of goodbones
   passes ports as values (`loadPolicy`'s `fileSystem`, a language pack's `syntax`), and the
   CLI should read like its dependencies.

4. **A use-case** is a function `<verbNoun>UseCase` in `use-cases/<verb-noun>.use-case.ts`,
   and a file holds exactly one. It takes a `LoadedPolicy` plus the ports it needs. It returns
   a plain readonly result type, declared in `use-cases/<name>.result.ts` when it isn't already
   a domain type, and fails with a `CliFailure` or a tagged error. It never prints, writes to
   stdout or stderr, sets `process.exitCode` or exits. **A use-case never imports another
   use-case.** Whatever several use-cases do together, `interface/` or `run.ts` composes, as
   chernabog's ADR 3 decides for the same reason: a caller would inherit its callee's result
   shape, so reshaping one verb's output could change another verb's behaviour.

5. **The interface renders.** `interface/<verb>.command.ts` turns flags into arguments, calls
   one use-case, renders text or `--json`, and maps a failure to a `CliFailure`. The JSON a
   `--json` flag prints is the use-case's result serialized as it is today, byte for byte.

6. **Results stay plain types, not `Schema.Class`.** `check --json` and `conformance --json`
   are published formats (`packages/core/schema/conformance.schema.json`), and the e2e suite
   asserts on them. A class could change key order or add fields, and either is a change to a
   published format.

7. **The policy tightens as tiers appear, never ahead of them.** `limits.conformance.vacant`
   is 0, so a tier's node is added to `packages/cli/architecture.yaml` in the same pull request
   as its first file. `slack` is at its ceiling, so every allowance a new node states must be
   used by a file in that pull request. Coverage floors only rise.

8. **No public change.** The CLI's flags, output, exit codes and stderr sentences don't
   change. No package's `exports`, `bin` or manifest schema changes. Every commit in this
   series is `refactor(cli): …` or `docs: …`, never `feat`, because packages are versioned
   from their commits.

9. **Left behind from chernabog:** modules (`src/modules/<module>/`), a kernel, `*.layer.ts`
   files, Effect service ports, plan/apply wizards (no CLI verb here prompts), and repositories
   over aggregates (nothing here is a mutable aggregate). The only stateful files the CLI
   writes are the baseline and `architecture.yaml`, and each sits behind a store port. Adopt
   one of these later when a concrete need shows up, not for symmetry.

## Consequences

- The work is incremental, one verb or tier per pull request, each a `refactor(cli)` that
  leaves `pnpm lint`, `pnpm lint:architecture` and the e2e suite green. `run.ts` shrinks to
  dispatch as the verbs move out of it.
- A use-case is tested against fakes from `infrastructure/` and the core's
  `@goodbones/core/testing`, without a fixture tree on disk. The existing `run.test.ts` and
  e2e assertions on `--json` stay as they are, and are what proves the output didn't move.
- Because ports are values, a test or a second host builds a use-case's dependencies with a
  plain object. There is no layer graph to assemble, and nothing in the CLI needs an Effect
  runtime beyond what it runs today.
- The rule that a use-case never imports another, and that `domain/` reaches no port or
  adapter, become `imports` and `graph` rules in `packages/cli/architecture.yaml` with the
  tiers they govern, so the layering is enforced by the packages this repository publishes.
- The campaigns glue keeps its own shape (`host.ts`, `live.ts`, `none.ts`). Moving it into
  the tiers would have to keep both `@goodbones/campaigns` and `@goodbones/ast-grep` out of
  every module the bin loads up front, and is not part of this series.
