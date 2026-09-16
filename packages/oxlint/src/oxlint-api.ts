import * as path from "node:path";

import {
  type ProgramBody,
  type ReadFacts,
  readProgram,
  type SyntaxNode,
} from "@goodbones/typescript";
import type { RuleTester } from "oxlint/plugins-dev";

// oxlint publishes no plugin types, so the exact `Context`, node and fixer shapes
// are recovered from `RuleTester`'s own signature — the one public surface that
// names them. Hand-rolling them drifts silently against an alpha API.
export type OxlintRule = Parameters<RuleTester["run"]>[1];
export type RuleContext = Parameters<Extract<OxlintRule, { createOnce: unknown }>["createOnce"]>[0];

type Diagnostic = Parameters<RuleContext["report"]>[0];
export type ReportableNode = Extract<Diagnostic, { node: unknown }>["node"];
export type Fixer = Parameters<NonNullable<Diagnostic["fix"]>>[0];

// The root of the tree oxlint hands a rule, and the one the pack's reader
// walks.
export type Program = RuleContext["sourceCode"]["ast"];

export const toRepoRelative = (repoRoot: string, filename: string): string =>
  path.relative(repoRoot, filename).replaceAll(path.sep, "/");

// A diagnostic is placed by the node's range, which every node of oxlint's
// tree carries; a node from another parse carries `start` and `end`.
export const at = (node: SyntaxNode): ReportableNode => ({
  range: node.range ?? [node.start, node.end],
});

// The facts of one file, read once and shared by every rule that runs on it:
// oxlint deserialises a file's tree once and hands the same `Program` to each
// rule, so the tree is the key.
const read = new WeakMap<Program, ReadFacts>();

export const factsOfProgram = (file: string, program: Program): ReadFacts => {
  const found = read.get(program);
  if (found !== undefined) return found;
  // oxlint's node types are `@oxc-project/types`' with `parent` required on
  // every node — the same tree, generated from the same source. Each node
  // type assigns on its own; the compiler gives up relating the two
  // ~190-member recursive unions as wholes, so the boundary is asserted once,
  // here. The parity suite is what proves the trees are one.
  const facts = readProgram(file, program as ProgramBody);
  read.set(program, facts);
  return facts;
};
