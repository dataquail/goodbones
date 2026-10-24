# 2. Modules of use-cases over a domain, in core, campaigns and the CLI

Status: accepted, 2026-10-24. Supersedes decisions 1, 2 and 9 of
[ADR 1](0001-use-cases-behind-ports-in-the-cli.md), and keeps its decisions 3 to 8.

## Context

It is hard to look at any one place in `src/` and see how goodbones behaves. The story of a
verb is spread across tiers named for technical roles, not for what the software does.
`objectives clear` runs through `cli/src/campaigns/verbs.ts`, `campaigns/src/host/clear.ts`
(ledger rules beside `rmSync` and `writeFileSync`), `host/ledgers.ts`, `load/extension.ts` and
`core/ledger.ts`. That last file was 1,178 lines holding four schemas, their invariants, their
JSON codecs and the paths they are stored at.

ADR 1 adopted chernabog's shape (`dataquail/chernabog`, its `src/modules/`, `architecture.yaml`
and ADRs 1 to 3) for the CLI only, and ruled out modules, a kernel and repositories, because
nothing in the CLI looked like a mutable aggregate. Looking past the CLI, goodbones does own
and write state: the campaign ledgers, the baseline and the manifest. ADR 1's reason for
leaving `core` and `campaigns` alone, that the policy's `exports` and `reach` rules and the
self-hosted campaigns name their paths, is a cost of each move, not a reason against it: the
rules and the ledgers move with the files, in the open.

## Decision

1. **The scope is `@goodbones/core`, `@goodbones/campaigns` and `@goodbones/cli`.**
   `@goodbones/typescript`, `@goodbones/ast-grep`, `@goodbones/oxlint` and
   `@goodbones/browser` don't move, and keep building and passing against the moved code.

2. **Who owns the data decides its model.**

   | What                                                                                         | Owner                                         | Written by goodbones?                                             | Model                           |
   | -------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- |
   | Campaign ledgers (`Ledger`, `MeasureLedger`), sector records, `plan.json`                    | goodbones                                     | yes: `objectives clear`, `objectives concede`, `campaigns attest` | aggregate + repository          |
   | The baseline (`.architecture-baseline.json`)                                                 | goodbones                                     | yes: `baseline`                                                   | aggregate + repository          |
   | The manifest (`architecture.yaml`, its `include`s, `.mjs`)                                   | its author, and goodbones when it authors one | yes: `init`, `migrate`                                            | aggregate + repository          |
   | The user's source: files, facts, the import graph                                            | the user's repository                         | never                                                             | client, returning value objects |
   | git, a `report` term's output, a `fn` term's module                                          | other programs                                | never                                                             | client, returning value objects |
   | Compiled rules, `LoadedPolicy`, violations, facts, the conformance snapshot, sectors, phases | derived                                       | no                                                                | value objects                   |
   | Fixed rules (the reserved sector names, `HOLDOUT_CAP`, `NOTE_CAP`)                           | the code                                      | no                                                                | domain constants                |

   Aggregates and repositories are for state goodbones owns, mutates or authors, and persists,
   and for nothing else. Data goodbones only reads comes in through a client port as value
   objects (read models). A pure rule that belongs to no entity is a domain service: a pure
   function in `domain/`, filed as chernabog files its value-object folders.

   The manifest repository's `findOne` handles storage: finding the file by name, reading
   YAML, JSON or `.mjs`, and resolving `include`. It returns a `ManifestRoot`. Turning the root
   into a `LoadedPolicy` (expand, decode, lower, compile, probe) is domain and use-case work.
   `ManifestRootOps` holds its invariants: a repository holds at most one manifest, `init` and
   `migrate` never overwrite one, and only a manifest that decodes is authored. `save` writes
   YAML only; a `.mjs` manifest is read, never written, and stays supported.

3. **The layout is chernabog's, per package.** `src/modules/<module>/` holds:
   - `domain/<aggregate-or-concept>/`: `x.root.ts`, `x.root-ops.ts` (pure operations in an
     `XRootOps` bag), `x.id.ts`, `x.value-object.ts`, `x.errors.ts`;
   - `domain/ports/{repositories,clients}/`: `x.repository.ts`, `x.client.ts`;
   - `use-cases/`: `<verb-noun>.use-case.ts` and `<name>.result.ts`;
   - `infrastructure/{repositories,clients}/`: `x.repository-live.ts`, `x.repository-fake.ts`,
     `x.repository-live.test.ts`, `x.mapper.ts`, and the same for clients.

   Primitives several modules share go in `src/kernel/` (`Violation` and its fingerprint,
   facts, globs, `ArchitectureError`, manifest positions). A client port several modules share
   goes in `src/ports/`, beside `kernel/`. Filenames are a kebab-case name and a dot-delimited
   stereotype.

4. **Ports are plain types, not Effect services** (ADR 1, decision 3, kept). A port has
   camelCase function members and is passed as an argument, so there is no `*.layer.ts`: a
   package's composition root builds the live ports. The core's `Language`, `FileSystem`,
   `ModuleResolver`, `FactExtractor` and `SyntaxMatcher` are public API, implemented by the
   TypeScript pack and by third-party hosts, and keep their names and shapes.

5. **A repository speaks the persistence vocabulary only:** `findAll`, `findOne`, `save`,
   `remove`. A finder that answers a question is an op on the aggregate. A use-case loads,
   calls ops, and saves. The JSON on disk (ledgers, sector records, plans, the baseline, the
   manifest) doesn't change by a byte, and the mapper owns that format.

6. **A use-case** is one `<verbNoun>UseCase` per file (ADR 1, decision 4, kept, and widened
   to every package). It never prints, writes to stdout or stderr, or sets an exit code. It
   returns a result and fails with a tagged error or a `CliFailure`. **A use-case never
   imports another use-case, in its own package or another** (chernabog's ADR 3). What
   several do together, an interface or a composition root composes. So a CLI command for a
   campaigns verb calls the campaigns package's use-case through `cli/src/campaigns/host.ts`,
   and the CLI doesn't wrap it in a use-case of its own.

7. **Where the use-cases are:**
   - `campaigns`: one per verb its `host/` serves today: clear, concede, attest, status and
     the nudge, report, explain, sector view. They replace `host/`.
   - `core`: the operations a host invokes, at least loading a policy and authoring a
     manifest.
   - `cli`: one per verb it owns: check, conformance, coverage, baseline, explain, facts,
     init, migrate, infer.

   The shared text renderers in `campaigns/host/` (`renderSectorView`, `explainCampaignLines`,
   `renderCampaignRows` and the rest) are presenters, not use-cases: pure functions from a
   result to lines, in a presentation tier the hosts import. No use-case calls one.

8. **Results stay plain readonly types where they are serialized** (ADR 1, decision 6,
   kept). Aggregate roots may be `Schema.Class` values or the existing `Schema.Struct` codecs.

9. **The rule-family evaluators stay pure domain services.** They already never touch the
   file system. Regrouping the core into one module per family means splitting
   `manifest/compile.ts` across every family, so it is the last layer, and optional.

10. **The policy enforces the shape from each tier's first file** (ADR 1, decision 7, kept).
    Each package's `architecture.yaml` gains, in the pull request that adds the tier it
    governs: the stereotype filename rules; the repository-vocabulary `members` rule; the
    `requires` obligations (a `.root-ops.ts` and a `.use-case.ts` each owe a sibling
    `.test.ts`, and a port owes its `-live.ts`, `-fake.ts` and `-live.test.ts`); an aggregate
    importing no other aggregate; no use-case importing another; `no-talking` in `domain/` and
    `use-cases/`; and the `domain-reaches-no-adapter` and `use-cases-reach-no-adapter` graph
    rules. They are chernabog's defs, ported. `limits.conformance.vacant` is 0, so a rule for a
    tier that does not exist yet waits for it.

11. **The migration is a series of layers, one reviewable pull request each:** this ADR and
    the ledger aggregates; `campaigns/host/` into use-cases and a presentation tier; the
    manifest aggregate; the baseline aggregate; one CLI use-case per verb over client ports;
    the core's `kernel/` and policy module; and, optionally, one core module per rule family.

## Constraints every layer keeps

- **No public change** (ADR 1, decision 8, kept): no `exports` or `bin` change, no manifest
  schema change (the generated JSON Schemas stay byte-identical), no change to a CLI flag, its
  output, `--json` or an exit code. Every name a package barrel exports today stays exported;
  an alias re-export is fine. Commits are `refactor(<pkg>)` or `docs`.
- **The optional peers.** No module a host loads up front imports `@goodbones/campaigns` or
  `@goodbones/ast-grep` at run time, and the hosts' `campaigns/` glue keeps its
  `host.ts`/`live.ts`/`none.ts` shape.
- **The self-hosted campaigns move with their files.** Moving a file a campaign is scoped to
  re-scopes the campaign and settles its ledger in the open, by `objectives clear` or
  `objectives concede --reason`, never by hand. `host-campaigns-shrinks` keeps its intent, that
  no single host module grows past its count, wherever that code lands.

## Consequences

- A verb reads top to bottom in one use-case: load through a repository or a client, decide
  in the domain, save through a repository, return a result.
- The ledgers are the first aggregates, in `packages/campaigns/src/modules/ledgers/`. Their
  live repositories read through the core's `FileSystem` port, so the oxlint plugin and the
  browser keep reading ledgers through their own file systems, and write with `node:fs` under
  the repository root. The extension's `load` is the family's composition point inside
  `loadPolicy`: it builds them, reads every ledger through them, and carries them on
  `CampaignPolicy` for the verbs that save.
- Until the campaigns package has a kernel, an aggregate may name the package's old pure tiers
  (`domain/`, `core/`) for the primitives that still live there, such as `CompiledCampaign`.
  The policy says so, and the allowance leaves as those tiers move.
- What ADR 1 left behind and this ADR takes up: modules, a kernel and repositories over
  aggregates. What stays behind: `*.layer.ts` files and Effect service ports (decision 4), and
  plan/apply wizards, since no verb here prompts.
