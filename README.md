# Oxlint Utils

Architecture policy as one manifest of your repository — import boundaries over resolved module
paths, restricted export sites, what a file may export, folder taxonomy with sibling parity,
declared-member allowlists, and cycles, orphans and transitive reach over the whole import graph —
enforced by an oxlint plugin in the editor and a CLI in CI. Published as independent packages:

| Package                                        | What it does                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`@goodbones/core`](packages/core)             | The manifest schema, the evaluators, the ports a language pack implements, and the loader. Names no language.       |
| [`@goodbones/typescript`](packages/typescript) | The TypeScript language pack: facts through the TypeScript parser, resolution through `unrs-resolver`.              |
| [`@goodbones/cli`](packages/cli)               | The `architecture` CLI: `check`, `baseline`, `coverage`, `explain`, `facts`, and the graph family.                  |
| [`@goodbones/oxlint`](packages/oxlint)         | The oxlint plugin: `imports`, `exports`, `members`, `structure` and `surface` as five rules over the same manifest. |

📖 **[Documentation](https://dataquail.github.io/goodbones)**

```sh
pnpm add -D @goodbones/oxlint @goodbones/cli
```

## Repository layout

```
packages/
  core/         @goodbones/core
  typescript/   @goodbones/typescript
  cli/          @goodbones/cli
  oxlint/       @goodbones/oxlint
  explorer/     @goodbones/explorer — the viewer `architecture explore` serves
website/        Astro + Starlight documentation site (GitHub Pages)
scripts/        release tooling and the local oxlint rule plugin
```

This is an [Nx](https://nx.dev) workspace using pnpm workspaces. Packages are versioned and published
independently.

## Development

```sh
pnpm install

pnpm run build:packages   # tsc -b -> build/esm + build/dts
pnpm run test:packages    # vitest, per package
pnpm run check:all        # tsc -b, src and tests
pnpm lint                 # oxlint, type-aware, including this repo's own architecture policy
pnpm run lint:architecture # the same policy through the CLI, plus the graph rules and coverage floors
pnpm run architecture:coverage # how much of the tree the policy reaches, per family
pnpm run check:effect     # Effect language-service diagnostics

pnpm run precommit        # lint + test + check across the workspace

pnpm run dev:website      # docs site at localhost:4321
pnpm run build:website
```

Per-project targets run through Nx:

```sh
pnpm exec nx build @goodbones/core
pnpm exec nx test @goodbones/oxlint
pnpm exec nx affected -t test
```

## The repository lints itself

`architecture.yaml` at the root is a real policy over `packages/`, enforced by the plugin this
repository publishes and wired into `.oxlintrc.json`. `pnpm lint` therefore fails on a layering
violation — a `domain/` file reaching an adapter, a `core/` evaluator reaching a live implementation,
the core reaching the TypeScript pack, one host reaching the other — and the policy doubles as the
packages' largest test. Every family is in it: `pnpm run lint:architecture` runs the same policy
through the CLI, which adds the graph rules (no cycles, no dead modules, the pure tiers reach no
adapter) and the coverage floors the policy states for itself.

## How a package is built

`tsc -b tsconfig.build.json` emits `build/esm` (JavaScript) and `build/dts` (declarations). That is the
whole build — no bundler and no CommonJS output, because oxlint loads a JS plugin with a bare dynamic
`import()` and the CLI is a Node ESM entrypoint. The package root is the publish root; `files` narrows
it to `build/` plus the sources the source maps point at.

## Releasing

Versioning is driven by [conventional commits](https://www.conventionalcommits.org) and packages are
released independently. Pushing to `main` runs lint, test and typecheck, then `nx release`, which
versions each package that changed, tags it, and opens a GitHub release. Publishing to npm happens when
that release is created.

See [RELEASE.md](RELEASE.md).

## Contributing

Commits must follow conventional-commit format — `nx release` derives version bumps from them and
commitlint enforces it on every commit and in CI.

## License

MIT
