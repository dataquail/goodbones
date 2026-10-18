import type { Graph, ModuleResolver, SourceFacts } from "@goodbones/core";
import * as Result from "effect/Result";

// The repository's import graph: every walked file, and the walked files each
// resolves to. An external, a builtin, a file outside the walked roots and an
// edge nobody can resolve are not in it — the first three are not the
// repository's shape, and the last is reported by `check` on its own.
export const buildGraph = (
  files: ReadonlyArray<string>,
  resolver: ModuleResolver,
  factsOf: (file: string) => SourceFacts,
): Graph => {
  const known = new Set(files);
  const edges = new Map<string, ReadonlyArray<string>>();

  for (const file of files) {
    const targets = new Set<string>();

    for (const specifier of factsOf(file).specifiers) {
      const resolved = resolver.resolve(file, specifier);

      if (Result.isFailure(resolved)) continue;

      if (resolved.success.kind === "local" && known.has(resolved.success.path)) {
        targets.add(resolved.success.path);
      }
    }

    edges.set(file, [...targets]);
  }

  return { files, edges };
};
