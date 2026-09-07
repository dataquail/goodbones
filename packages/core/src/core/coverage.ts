import { OPEN_LAYOUT } from "../domain/architecture-config.js";
import type { CompiledGraph } from "./graph.js";
import type { CompiledImportRule } from "./imports.js";
import type { CompiledMemberRule } from "./members.js";
import { firstFromMatch } from "./patterns.js";
import type { CompiledStructure } from "./structure.js";
import type { CompiledSurfaceRule } from "./surface.js";

// A probe proves a rule can fire. This is the other question: does the tree
// actually reach the files? A file no allowlist selects, in a folder no layout
// enumerates, is a file the policy has nothing to say about — and a policy that
// is 40% silence looks exactly like one that is 100% enforced, until counted.

export type FamilyCoverage = {
  readonly covered: number;
  readonly total: number;
};

export type StructureCoverage = {
  // Its folder's files are listed by name.
  readonly enumerated: number;
  // Its folder is claimed, and admits any name — `layout: "open"`.
  readonly open: number;
  readonly total: number;
};

export type Coverage = {
  readonly files: number;
  // Under an import allowlist. An `unrestricted` tier emits none, so this is
  // the honest count of files whose imports are actually bounded.
  readonly imports: FamilyCoverage;
  readonly structure: StructureCoverage;
  readonly members: FamilyCoverage;
  readonly surface: FamilyCoverage;
  // In the scope of a cycles or orphans rule.
  readonly graph: FamilyCoverage;
};

export type CoverageInputs = {
  readonly importRules: ReadonlyArray<CompiledImportRule>;
  readonly structure: CompiledStructure;
  readonly memberRules: ReadonlyArray<CompiledMemberRule>;
  readonly surfaceRules: ReadonlyArray<CompiledSurfaceRule>;
  readonly graph: CompiledGraph;
};

// An allowlist names no `to`: it fires when the target matches none of its
// `toNot`. A prohibition names one. Only the former bounds a file.
const isAllowlist = (rule: CompiledImportRule): boolean =>
  rule.to.length === 0 && rule.toNot.length > 0;

const dirnameOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

const selects = (
  rule: { from: ReadonlyArray<RegExp>; fromNot: ReadonlyArray<RegExp> },
  file: string,
) => firstFromMatch(rule, file) !== null;

// Which families reach one file. The one loop both `coverageOf` and
// `residueOf` run: the first counts, the second keeps the names.
export type Reach = {
  readonly file: string;
  readonly imports: boolean;
  // Enumerated and open are told apart, as `coverageOf` counts them.
  readonly structure: "enumerated" | "open" | null;
  readonly members: boolean;
  readonly surface: boolean;
  readonly graph: boolean;
};

export const reachOf = (
  policy: CoverageInputs,
  files: ReadonlyArray<string>,
): ReadonlyArray<Reach> => {
  const allowlists = policy.importRules.filter(isAllowlist);
  return files.map((file) => {
    const folder = dirnameOf(file);
    const governing = policy.structure.folders.filter((rule) =>
      rule.folder.some((pattern) => pattern.test(folder)),
    );
    const structure =
      governing.length === 0
        ? null
        : governing.every((rule) => rule.files.some((pattern) => pattern.source === OPEN_LAYOUT))
          ? "open"
          : "enumerated";
    return {
      file,
      imports: allowlists.some((rule) => selects(rule, file)),
      structure,
      members: policy.memberRules.some((rule) => selects(rule, file)),
      surface: policy.surfaceRules.some((rule) => selects(rule, file)),
      graph: [...policy.graph.cycles, ...policy.graph.orphans].some(
        (rule) =>
          rule.within.some((pattern) => pattern.test(file)) &&
          !rule.withinNot.some((pattern) => pattern.test(file)),
      ),
    };
  });
};

export const coverageOf = (policy: CoverageInputs, files: ReadonlyArray<string>): Coverage => {
  const reach = reachOf(policy, files);
  const count = (is: (one: Reach) => boolean): number => reach.filter(is).length;
  const total = files.length;
  return {
    files: total,
    imports: { covered: count((one) => one.imports), total },
    structure: {
      enumerated: count((one) => one.structure === "enumerated"),
      open: count((one) => one.structure === "open"),
      total,
    },
    members: { covered: count((one) => one.members), total },
    surface: { covered: count((one) => one.surface), total },
    graph: { covered: count((one) => one.graph), total },
  };
};

// The files no family reaches — counted by no family's coverage, so a file in
// an open folder under no allowlist is residue: claimed, not policed — and
// the folders wholly made of them, each the topmost such folder. A policy
// that is 40% silence looks exactly like one that is 100% enforced, until
// counted; this is what the silence is made of.
export type Residue = {
  readonly files: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<string>;
};

export const residueOf = (policy: CoverageInputs, files: ReadonlyArray<string>): Residue => {
  const unreached = reachOf(policy, files)
    .filter(
      (one) =>
        !one.imports &&
        one.structure !== "enumerated" &&
        !one.members &&
        !one.surface &&
        !one.graph,
    )
    .map((one) => one.file)
    .sort();
  return { files: unreached, folders: foldersWhollyIn(unreached, files) };
};

// Every ancestor folder of a file, nearest first, the root (`""`) excluded.
const ancestorsOf = (file: string): ReadonlyArray<string> => {
  const folders: Array<string> = [];
  let folder = dirnameOf(file);
  while (folder !== "") {
    folders.push(folder);
    folder = dirnameOf(folder);
  }
  return folders;
};

// The topmost folders every walked file of which is in `subset`. Each is
// reported once, with none of its subfolders, and a lone file's folder counts
// — a folder with one file the policy ignores is a folder the policy ignores.
const foldersWhollyIn = (
  subset: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const walked = new Map<string, number>();
  for (const file of files) {
    for (const folder of ancestorsOf(file)) walked.set(folder, (walked.get(folder) ?? 0) + 1);
  }
  const inSubset = new Map<string, number>();
  for (const file of subset) {
    for (const folder of ancestorsOf(file)) {
      inSubset.set(folder, (inSubset.get(folder) ?? 0) + 1);
    }
  }
  const whole = [...inSubset.entries()]
    .filter(([folder, count]) => walked.get(folder) === count)
    .map(([folder]) => folder)
    .sort();
  return whole.filter(
    (folder) => !whole.some((other) => other !== folder && folder.startsWith(`${other}/`)),
  );
};

// A floor the policy states for itself, per family, as a fraction. Structure
// counts enumerated folders only: an open one is claimed, not policed by name.
export type CoverageFloors = {
  readonly imports?: number;
  readonly structure?: number;
  readonly members?: number;
  readonly surface?: number;
  readonly graph?: number;
};

export type CoverageFamily = keyof CoverageFloors;

// Residue is files no node reaches; this is nodes no file reaches. A node
// that states an import allowlist and selects no walked file grants
// permission to nothing: every allowance on it is unused by construction,
// which is not slack — there is no line to delete, only a node that is a
// tier declared ahead of its first file, or a pattern that no longer
// matches. Which of the two, the reader decides; the report tells both
// apart from slack so nothing has to be read twice.
export type Vacancy = ReadonlyArray<{
  readonly node: string;
  // Distinct entries the node wrote, `allow` and `external` together.
  readonly allowances: number;
}>;

// The nodes whose allowances no live rule carries. A node's allowlist is
// inherited by every descendant's rule until one `reset`s, so a node whose
// own rule steps aside for an overriding child still reaches that child's
// files through the child's rule — and is not vacant while the child has any.
export const vacantNodesOf = (
  rules: ReadonlyArray<CompiledImportRule>,
  files: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const declaring = new Set<string>();
  const reached = new Set<string>();
  for (const rule of rules) {
    if (rule.allowances.length === 0) continue;
    const live = files.some((file) => selects(rule, file));
    for (const { node } of rule.allowances) {
      declaring.add(node);
      if (live) reached.add(node);
    }
  }
  return new Set([...declaring].filter((node) => !reached.has(node)));
};

// Every vacant node with how many entries it wrote, in the order the
// allowlists declared them.
export const vacancyOf = (
  rules: ReadonlyArray<CompiledImportRule>,
  files: ReadonlyArray<string>,
): Vacancy => {
  const vacant = vacantNodesOf(rules, files);
  const entries = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const { entry, kind, node } of rule.allowances) {
      if (!vacant.has(node)) continue;
      const written = entries.get(node) ?? new Set<string>();
      written.add(`${kind} ${entry}`);
      entries.set(node, written);
    }
  }
  return [...entries.entries()].map(([node, written]) => ({ node, allowances: written.size }));
};

export const fractionOf = (covered: number, total: number): number =>
  total === 0 ? 1 : covered / total;

export const fractionsOf = (coverage: Coverage): Readonly<Record<CoverageFamily, number>> => ({
  imports: fractionOf(coverage.imports.covered, coverage.imports.total),
  structure: fractionOf(coverage.structure.enumerated, coverage.structure.total),
  members: fractionOf(coverage.members.covered, coverage.members.total),
  surface: fractionOf(coverage.surface.covered, coverage.surface.total),
  graph: fractionOf(coverage.graph.covered, coverage.graph.total),
});

export type Shortfall = {
  readonly family: CoverageFamily;
  readonly actual: number;
  readonly floor: number;
};

export const coverageShortfalls = (
  coverage: Coverage,
  floors: CoverageFloors,
): ReadonlyArray<Shortfall> => {
  const actual = fractionsOf(coverage);
  const families: ReadonlyArray<CoverageFamily> = [
    "imports",
    "structure",
    "members",
    "surface",
    "graph",
  ];
  return families.flatMap((family) => {
    const floor = floors[family];
    if (floor === undefined || actual[family] >= floor) return [];
    return [{ family, actual: actual[family], floor }];
  });
};
