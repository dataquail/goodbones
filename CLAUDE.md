# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Nx + pnpm monorepo publishing architecture-policy tooling: a policy written as one manifest of
the repository (`architecture.yaml`), enforced by an oxlint plugin and a CLI. Five packages,
all under `packages/`:

- **`@goodbones/core`** (`packages/core`) — the manifest schema, the evaluators for the five
  per-file families (`imports`, `exports`, `members`, `surface`, `structure`), the `graph` family
  (cycles, orphans, transitive reach) and the `campaigns` family (a migration as a detector and a
  ledger), the `limits` ratchets, the ports a language pack implements, a fake per port under
  `@goodbones/core/testing`, and `loadPolicy`. It names no language.
- **`@goodbones/typescript`** (`packages/typescript`) — the TypeScript language pack: facts read
  through oxc-parser, specifiers resolved through `unrs-resolver`, behind the core's
  `Language` port.
- **`@goodbones/cli`** (`packages/cli`) — the `architecture` bin: `check`, `conformance`, `baseline`,
  `campaigns`, `coverage`, `explain`, `facts`, `init`, `infer`, `migrate`. Being the one host that sees every file at
  once, it is where the graph family is evaluated, and where the conformance snapshot (residue, slack,
  cycle count, leaf-first violations; schema in `packages/core/schema/conformance.schema.json`) is built.
- **`@goodbones/ast-grep`** (`packages/ast-grep`) — the syntax matcher: the core's `SyntaxMatcher`
  port over `@ast-grep/napi`, for the `campaigns` family's `syntax` term. A host composes it into
  the TypeScript pack (`typescriptLanguage({ syntax: astGrepMatcher() })`); the pack never names it.
- **`@goodbones/oxlint`** (`packages/oxlint`) — the plugin: six oxlint rules over the same manifest.

Both hosts depend on the core and the pack and never on each other. `website/` is an Astro + Starlight
docs site deployed to GitHub Pages at <https://dataquail.github.io/goodbones>.

**The repository enforces its own architecture with the packages it publishes.**
`architecture.yaml` at the root is a real policy over `packages/`, wired into `.oxlintrc.json` as
the `architecture` JS plugin, so `pnpm lint` fails on a layering violation. That makes the policy the
packages' largest test: a change that breaks lowering or resolution breaks the lint run here first.
Every family is in it, deliberately — `imports` and `structure` for the layering, `members` for
"`core/` and `domain/` never touch the file system" and "a port member is camelCase", `exports` for
"a live adapter is constructed only at the composition root" and "no namespace import or `export *`
between tiers", `surface` for "no default exports, no `export *`", `graph` for no cycles, no dead
modules, "the pure tiers reach no adapter", "the core reaches no other package" and "the two hosts
never reach each other", `limits` with both adoption ceilings at zero and coverage floors at the
numbers the day they were written, and one `campaigns` entry with a real ledger — so a family whose
extraction quietly narrows breaks this lint run, not a user's.

**The campaigns family tracks a migration as an object.** A campaign (`campaigns:` in the manifest)
is a detector — `all`/`any`/`not` over `path`, `imports`, `exports`, `members`, `requires`, `content`,
`syntax` (an ast-grep rule) and `fn` (`module#export`) terms — with a unit (`file`, `declaration`,
`match`), probes it must fire on and stay silent on, and a ledger under `.architecture-campaigns/`
(`<id>.json`) of every place the pattern still occurs. The ledger only shrinks on its own:
`architecture campaigns prune` removes, `campaigns allow --reason` is the one way an entry is added
and it records a regression, and `check` verifies `entries.length === initial + Σ delta − fixed`. A
fixed entry is stale and fails `check` like a stale baseline entry. The plugin evaluates this family
by parsing `sourceCode.text` with the same ast-grep matcher the CLI uses — the only family the
plugin parses with anything but oxlint's tree — so its parity contract is "one engine", pinned by
`packages/oxlint/src/campaigns-parity.test.ts`. This repository runs one campaign on itself
(`lowering-reports-not-throws`, over `packages/core/src/manifest/**`); its ledger is committed, and
changing the count means pruning or allowing, in the open. `ARCHITECTURE_NOW` pins the clock the
stall check reads. The TypeScript pack walks `.ts`-family files only, so a campaign over `.js` files
has nothing to see until the pack's extensions widen — a separate decision.

## Commands

```bash
# Build (tsc -b -> build/esm + build/dts), in dependency order
pnpm run build:packages
pnpm exec nx build @goodbones/core

# Test
pnpm run test:packages
pnpm exec nx test @goodbones/oxlint

# Typecheck (tsc -b, src and tests)
pnpm run check:all
pnpm exec nx check @goodbones/cli

# Lint — oxlint, type-aware. Warnings are tolerated; errors are not.
pnpm lint
pnpm run lint:fix

# Effect language-service diagnostics (separate from lint)
pnpm run check:effect

# The same policy through the CLI, with no linter in the loop
pnpm run lint:architecture
pnpm run architecture:explain packages/core/src/core/imports.ts
pnpm run architecture:facts packages/core/src/core/imports.ts   # what the parser read
pnpm run architecture:coverage                                                     # how much of the tree the policy reaches

# Everything, as the pre-commit hook runs it
pnpm run precommit

# The end-to-end suite: generated repositories through the built bin and oxlint (not in precommit)
pnpm run e2e
FC_NUM_RUNS=3 FC_END_ON_FAILURE=1 pnpm run e2e   # the property tier, quickly
FC_SEED=<n> FC_NUM_RUNS=1 pnpm run e2e           # replay one property failure

# Docs site
pnpm run dev:website
pnpm run build:website
```

## Things that will bite you

**Every package's tsconfigs reset `paths` to `{}` on purpose.** oxlint and Node load the emitted
JavaScript with bare imports, and tsc does not rewrite path aliases on emit — a `@/…` specifier that
typechecks would be a runtime `ERR_MODULE_NOT_FOUND`. Relative specifiers run within a package; across
packages a bare `@goodbones/core` runs, resolved through the pnpm workspace link to the sibling's
`build/`. The `paths` in `tsconfig.base.json` are for the root typecheck only. Each package's
`tsconfig.src.json` and `tsconfig.build.json` carry a `references` entry per dependency so `tsc -b`
builds the dependency's declarations first — and `references` is not inherited through `extends`, so
both files repeat it.

**A cross-package import goes through the barrel.** `@goodbones/core` is `packages/core/src/index.ts`
and `@goodbones/core/testing` is the fakes; the root policy refuses a deep import into a sibling's
`src/`, as a consumer outside the repo would find one refused by the `exports` map. Tests alias the
bare names to `src` (`vitest.shared.ts`); `TEST_DIST=1` points them at `build/esm`.

**`@goodbones/ast-grep` is a native dependency.** `@ast-grep/napi` ships a platform binary as an
optional dependency and is in `pnpm.onlyBuiltDependencies`; a fresh checkout on an unsupported platform
fails at install, not at lint. The package has never been published and goes through First Publish
before any host version that depends on it is released, as `@goodbones/explorer` did.

**`packages/oxlint/build/esm/plugin.js` is the plugin entrypoint**, the package's default export (and
its `./plugin` subpath). `packages/cli/build/esm/main.js` is the `architecture` bin. Both are in the
`exports`/`bin` maps, so renaming or moving those source files is a breaking change.

**The plugin must be built before any lint.** oxlint imports JavaScript, so a stale `build/` enforces a
stale policy while still linting green, and a missing one fails every package's lint with "Failed to
load JS plugin". Two things close that: the `lint` script builds every package first, and `nx.json`'s
`targetDefaults.lint` declares `dependsOn: ["build", { projects: ["@goodbones/oxlint"], target:
"build" }]`, so linting `core` on a clean checkout builds the plugin (and, through `^build`, the core
and the pack) before oxlint starts. Depending on a project's own build alone is what passed locally
and failed in CI.

**`tsconfig.resolve.json` is not part of any build.** It exists so the architecture plugin can resolve
specifiers, and it mirrors `tsconfig.base.json`'s `paths` _without_ the trailing extension those carry —
a mapped target is a template, so a `.ts`-suffixed mapping would make `pkg/x.js` look for `x.js.ts`.
Changing `paths` in one file and not the other is how rules silently stop resolving.

**Adding a layer means adding a node to `architecture.yaml`, and so does adding a package.** A
new folder under a `src/` that no node governs trips the taxonomy-root catch-all rather than being
quietly unpoliced; a new package under `packages/` is a new `~/<name>/` node with its own import
allowlist (written in `packages/<name>/architecture.yaml` and included from the root, like the
four that exist), plus a `paths` pair in `tsconfig.base.json` and `tsconfig.resolve.json`, an entry in
`vitest.workspace.ts`, and a reference in the root `tsconfig.json` and `tsconfig.build.json`. Before
trusting a rule you just wrote, plant the violation it exists to catch and watch `pnpm lint` fail — the
probe check proves a rule _can_ fire, not that it fires on what you meant.

**The manifest is a data file, and `packages/core/schema/architecture.schema.json` is generated from
its codec.** `readManifestFile` reads `architecture.yaml`/`.yml`/`.json` through the `yaml` parser
(YAML 1.2 core schema, merge keys on, unknown tags refused) and `.mjs` through `import()`; both
hosts discover the file by name in that order and refuse a repository holding two. `defs`/`use`
are expanded on the raw value before decoding (`manifest/expand.ts`), so they work in every form.
The JSON Schemas (the manifest's, and `architecture-node.schema.json` for an included file) are
emitted by `pnpm run schema:manifest` and `manifest/json-schema.test.ts` fails when a committed
file is behind the codec — so a change to the manifest schema is followed by regenerating them,
and the docs site copies both to `/schema/` at build. Decode errors name a line through the
locator the YAML reader hands `loadPolicy`; a module manifest gets the path only.

**The manifest may be split with `include`, and this repository's is.** `{ include: <path> }`
anywhere in the manifest is replaced by that file's value before `defs`/`use` expand
(`infrastructure/manifest-include.ts`); the path is relative to the file that wrote it, an
included file is YAML/JSON only, nothing may stand beside `include`, and a list item naming a
list is spliced. The root `architecture.yaml` includes `packages/<name>/architecture.yaml` for
each package's tree node — so a package's layering rules are edited in the package, and the
root stays the index. A position inside an included file carries the file
(`ManifestPosition.file`), which is how an error names `packages/core/architecture.yaml:12:5`.

**`e2e/` is the suite that runs what a user installs, and it lives outside `packages/` on
purpose.** The root policy's scope is `^packages/` and its walker roots are `packages`, so the
harness and its generated fixtures are governed by no rule and seen by no walk — a fixture under
`packages/cli/` raced the self-hosting `infer` test once. Every fixture is written to a
realpath'd temp directory (macOS's `/var` is a symlink, and the resolver realpaths its answers)
with its externals stubbed under the fixture's own `node_modules/`. The harness never imports
`@goodbones/*` source: `e2e/src/cli.ts` spawns `packages/cli/build/esm/main.js`, `e2e/src/oxlint.ts`
runs the `oxlint` binary with `packages/oxlint/build/esm/plugin.js` named by absolute path, and
`e2e/src/install.ts` extracts `pnpm pack` tarballs into the fixture. Assertions are on
`check --json`, never on the prose. The `e2e` Nx target depends on every build and is never
cached or affected-filtered. It runs in CI on push to `main` only — it takes several minutes,
so it is not on pull requests and not in `precommit` — and `release` needs it, so a red suite
blocks the publish. Run `pnpm run e2e` locally before merging anything that touches a build.
`e2e/src/profile.ts` is the seam a second language fills — a profile and a `resolve.scopes`
entry; the scenarios do not change. The property tier (`e2e/src/properties/`) is metamorphic
only — never a model of the evaluators — and a failing seed shrinks for a long time, so
`FC_END_ON_FAILURE=1` is how to see the failure first. Running `oxlint` from inside `e2e/`
fails to load the plugin: the plugin reads the manifest from the working directory, so lint
from the repository root.

**Imports use explicit `.js` extensions.** `moduleResolution` is `NodeNext` and the package is ESM —
`import { x } from "./thing.js"` referring to `thing.ts` is correct, not a mistake to "fix".

**`oxlint` and `@effect/tsgo` move together.** The `prepare` step runs `effect-tsgo patch --oxlint`,
and that patch targets one exact oxlint version, so a bump is the pair (`1.81.0` with `@effect/tsgo`
`^0.40.0`). Do not go below 1.78.0: 1.77.0's language server panics building the "disable this rule"
quick-fix for any JS-plugin diagnostic (oxc #25278), so the architecture rules ran in CI and never
surfaced in the editor. `.vscode/` points the editor at `oxc.oxc-vscode` for the same reason.

**`oxlint` and `oxc-parser` move together.** The pack parses with `oxc-parser`, pinned exactly to
the version released with the pinned `oxlint` (`1.81.0` with `oxc-parser` `0.148.0`; both carry
`@oxc-project/types@0.148.0`), because the plugin reads oxlint's tree through the pack's reader
and the reader is written against one ESTree. `packages/oxlint/src/parity.test.ts` is what fails
when either is bumped alone — a node renamed or a field moved in one parser and not the other —
so a bump of either runs it. `oxc-parser` ships prebuilt platform binaries as optional dependencies
with no install script, so it needs no `onlyBuiltDependencies` entry.

**No package depends on `typescript`, and none should.** Every package builds with the workspace's
`tsc`, which is tsgo (the root's `typescript` is `@typescript/native` 7.x). The pack once depended on
real `typescript` 5.x for its parser API, and that package's bin shadowed the root's: letting it build
with 5.x made CI flaky — `tsc -b` in `cli` and `oxlint`, each seeing the pack's outputs "generated with
a different version", re-emitted them in parallel, and one read the other's half-written declaration
file. The root keeps a `typescript` 5.x devDependency for tooling only; a package that adds one brings
the shadow back.

**`no-redeclare` is off on purpose.** From oxlint 1.79.0 the rule reports TypeScript declaration
merging — `export const X = Schema.Struct(…)` beside `export type X = …`, which is how every schema in
`src/domain/` is written. Upstream closed it as not planned (oxc #25936). A real redeclaration is
TS2451, and the compiler owns it.

**`effect` is an exact dependency** (`4.0.0-beta.94`), pinned again in the root `pnpm.overrides`. Effect
4 betas are mutually incompatible; bumping it is a coordinated breaking change.

**`references` is not inherited through `extends`**, so `tsconfig.build.json` and the root
`tsconfig.build.json` repeat what the plain `tsconfig.json` already lists.

## Conventions

- **Prettier**: double quotes, `printWidth: 100`, semicolons. (Note this differs from most dataquail
  repos — it matches the upstream these packages were extracted from.)
- **oxlint**, not ESLint. Local rules live in `scripts/lint-rules/` and are loaded as an oxlint JS
  plugin under the `local/` prefix. The config extends `@effect/tsgo`'s recommended preset, which is
  where the `effecttsgo/*` rules come from.
- **Conventional commits** are enforced by commitlint and drive `nx release` version bumps.
- **Nx targets** are declared in each `project.json` and delegate to the package's own npm scripts, so
  `pnpm --filter … run build` and `nx build …` do the same thing. Each `package.json` sets
  `"nx": { "includedScripts": [] }` so Nx does not also infer targets from the scripts.
- **Docs are namespaced per package.** `website/src/content/docs/architecture-rules/**` belongs to this
  package; a second library gets its own directory and its own sidebar group rather than being folded
  into this one.

## Architecture notes

`@goodbones/core` is laid out hexagonally, and the layering is the thing to preserve:

- `src/domain/` — the manifest schema, the error types, the `Violation` and its line-independent
  fingerprint. No I/O.
- `src/core/` — the pure evaluators (`imports`, `exports`, `members`, `surface`, `structure`, `graph`,
  `campaigns`, `coverage`, `baseline`, `ledger`, `patterns`). Given facts, they return violations;
  they never read a file.
- `src/manifest/` — compiling the manifest tree down to flat, resolved rules (`lowerManifest`).
- `src/load/` — `loadPolicy`: decode, lower, compile and probe a manifest the host has already
  read, with the language packs and the `FileSystem` the host hands in. Language-neutral; the
  resolver and the extractor it returns route each file to the scope's language.
- `src/ports/` — the `FileSystem`, `ModuleResolver`, `FactExtractor`, `SyntaxMatcher`,
  `CampaignPredicate` and `Language` ports.
- `src/infrastructure/` — a fake per port (exported as `@goodbones/core/testing`; tests drive them),
  and the four things the core does on this host without a language: the live file system, the
  walker, reading the manifest file, and importing the `fn` terms' modules (`campaign-functions.ts`).

The other three packages sit around it:

- `@goodbones/typescript` implements the ports for one language and assembles them into
  `typescriptLanguage()`. Its extractor is what the CLI reads every file through and what the
  loader parses authored probes with. It parses with `oxc-parser` and exports the reader,
  `readProgram`, that turns an ESTree `Program` into facts with the node each came from; the
  plugin calls the same reader on oxlint's tree, so there is one reader over one tree shape. A
  syntax error does not throw: oxc returns an empty program, so a file that does not parse
  contributes no facts. Only the two hosts' `config-loader.ts` construct the pack; the core never
  imports it (a `reach` rule in the repo policy says so).
- `@goodbones/cli` and `@goodbones/oxlint` — the two hosts. Both answer to the same core,
  deliberately, so an alpha oxlint plugin API is not a single point of failure. The plugin reads
  oxlint's tree through the pack's reader rather than parsing again, and
  `packages/oxlint/src/parity.test.ts` holds oxlint's parse and oxc-parser's to one answer — it
  lives in the plugin because it is the plugin's contract with the pack.

Two properties are load-bearing and pinned by tests:

- **Every compiled rule carries a probe** generated from its own node path, and the plugin **refuses to
  load** if any probe fails. A rule that has drifted into matching nothing is a load-time error, not
  something a separate script might notice later. A `members`, `exports` or `surface` rule may carry
  an authored `probe: { source }` instead, parsed at load — the only way to prove a rule fires on a
  declaration shape, since a synthetic probe never meets a parser.
- **The baseline is a ratchet, not a suppression list.** Entries are keyed by fingerprint, and fixing a
  violation fails the build until its entry is removed, so the floor only rises.
- **The graph family is CLI-only, by design.** The plugin sees one file at a time; `architecture check`
  builds the import graph (parsing each file once) and is a superset of the plugin, not a mirror.
  Both adapters compile and probe graph rules at load, so a vacuous one fails `oxlint` too.

## Releasing

`nx release` with `projectsRelationship: "independent"`. Push to `main` → version + tag + GitHub
release; creating that release triggers the npm publish from `packages/<name>` (not a `dist/`
subdirectory — the manifest's `files` is what narrows the tarball). `updateDependents: auto` bumps
`cli` and `oxlint` when `core` or `typescript` changes. See `RELEASE.md`.

**`main` releases only packages the registry already knows.** The release job asks npm about each
package and passes the existing ones to `nx release --projects`; a never-published package goes through
First Publish, deliberately. And `updateDependents: auto` versions a package's dependents with it — an
unreleased dependent gets a stable patch bump and a tag with no publish — so a first publish names the
whole set (`core`, `typescript`, `cli`, `oxlint`) in one run; the preflight refuses otherwise.

**A package that has never been released does not go through that path.** It has no git tag and no
registry version to derive from, so it is bootstrapped by the **First Publish** workflow
(`workflow_dispatch` → `scripts/first-publish.sh`), which passes nx's `--first-release` and refuses any
package that is already on the registry. After that one run the package is normal.

**`--preid` is passed once, on the first publish, and never again.** Once a package's current version
is a prerelease, nx resolves every subsequent bump as `prerelease` on its own, so the ordinary flow
keeps cutting betas with no flag anywhere. Leaving beta is therefore a deliberate
`nx release minor` — there is nothing to unset — which is the property you want from a "not ready yet"
state. Don't add a preid to `on-push.yml` trying to make betas stick; they already do.

**The npm dist-tag is derived from the version, not configured** (`scripts/dist-tag.mjs`, used by both
publish scripts). npm applies `latest` to whatever it is given unless `--tag` says otherwise and never
looks at the version, so an untagged beta becomes what `npm install` resolves to — which is exactly
what happened to `@effect-server-utils/cqrs` (`latest -> 0.1.0-beta.4`).

**`.npmrc` sets `provenance=true` unconditionally, and npm errors rather than degrades without a
trusted CI to attest from.** Any publish outside Actions — including a Verdaccio rehearsal — needs
`NPM_CONFIG_PROVENANCE=false`, and gives up the attestation to get it.
