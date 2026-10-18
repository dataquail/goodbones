// The package a `node_modules/` path belongs to, as an `imports.external` entry
// names it: `effect`, or `@scope/name`. The LAST `node_modules/` segment is the
// one that matters — under pnpm the store path is
// `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/…`, and the first
// segment after the first `node_modules/` would be `.pnpm`.
//
// This is npm's layout, and it belongs to the TypeScript side of the package:
// the policy only ever sees the name that comes out.
const LAST_NODE_MODULES = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g;

export const npmPackageOf = (repoRelativePath: string): string | undefined => {
  let found: string | undefined;

  for (const match of repoRelativePath.matchAll(LAST_NODE_MODULES)) found = match[1];

  return found;
};
