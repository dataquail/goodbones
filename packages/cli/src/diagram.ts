import * as path from "node:path";

import { type Atlas, focusOf, type View, viewOf, type ViewOptions } from "@goodbones/core";
import * as Result from "effect/Result";

// `architecture diagram`: one folder of the repository as a mermaid flowchart,
// with the policy laid over it — every edge admitted, ungoverned or a
// violation, drawn as such. What a pull request comments and a document
// embeds. The scan and the roll-up are the core's; this module reads the
// flags and picks the folder, and `run` does the scan and prints the text.

export const DIAGRAM_USAGE =
  "diagram [--root <folder>] [--depth 1|2] [--focus <file>]... [--designed] [--outside] [roots...]";

export type DiagramFlags = {
  // The folder to draw. Absent, the folder every `--focus` file is under,
  // else the one walk root, else the repository.
  readonly root: string | null;
  readonly focus: ReadonlyArray<string>;
  readonly depth: 1 | 2;
  readonly designed: boolean;
  // Whether to draw where edges leaving the folder go.
  readonly outside: boolean;
  // The directories to walk.
  readonly roots: ReadonlyArray<string>;
};

const normalizePath = (given: string): string =>
  given.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, "");

export const parseDiagramFlags = (
  argv: ReadonlyArray<string>,
): Result.Result<DiagramFlags, string> => {
  let root: string | null = null;
  const focus: Array<string> = [];
  let depth: 1 | 2 = 1;
  let designed = false;
  let outside = false;
  const roots: Array<string> = [];

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) break;
    const value = (): Result.Result<string, string> => {
      const next = args.shift();
      return next === undefined || next.startsWith("--")
        ? Result.fail(`${arg} needs a value`)
        : Result.succeed(next);
    };
    switch (arg) {
      case "--root": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        root = normalizePath(given.success);
        break;
      }
      case "--focus": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        focus.push(normalizePath(given.success));
        break;
      }
      case "--depth": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        if (given.success !== "1" && given.success !== "2") {
          return Result.fail(`--depth is 1 or 2, not "${given.success}"`);
        }
        depth = given.success === "1" ? 1 : 2;
        break;
      }
      case "--designed":
        designed = true;
        break;
      case "--outside":
        outside = true;
        break;
      case "--json":
        // Accepted for symmetry with the other commands; the output is text.
        break;
      default:
        if (arg.startsWith("--")) {
          return Result.fail(`unknown flag ${arg}. Usage: ${DIAGRAM_USAGE}`);
        }
        roots.push(normalizePath(arg));
    }
  }
  return Result.succeed({
    root,
    focus,
    depth,
    designed,
    outside,
    roots: roots.length > 0 ? roots : ["packages"],
  });
};

// The folder a render is of, and the view of it. Exposed so a test can read
// the view before it is rendered.
export const diagramView = (atlas: Atlas, flags: DiagramFlags): View => {
  const focus =
    flags.root ??
    (flags.focus.length > 0
      ? focusOf(atlas, flags.focus)
      : flags.roots.length === 1
        ? (flags.roots[0] ?? "")
        : "");
  const options: ViewOptions = {
    depth: flags.depth,
    outside: flags.outside ? "collapse" : "hide",
    designed: flags.designed,
  };
  return viewOf(atlas, focus, options);
};
