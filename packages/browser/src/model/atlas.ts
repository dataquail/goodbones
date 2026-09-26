import {
  anchored,
  type CompiledImportRule,
  cyclesIn,
  evaluateGraph,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  expandAliases,
  exportRulesSelecting,
  fingerprintOf,
  firstFromMatch,
  formatMessage,
  globToRegexSource,
  type Graph,
  hasGraphRules,
  type LoadedPolicy,
  type ManifestLocator,
  type ManifestNode,
  type ManifestPath,
  matchesAny,
  memberRulesSelecting,
  type ObservedEdge,
  prefixed,
  requiredSiblingsOf,
  rulesSelecting,
  slackOf,
  type SourceFacts,
  surfaceRulesSelecting,
  type Violation,
  type ViolationKind,
} from "@goodbones/core";
import * as Result from "effect/Result";

// The Architecture Browser's data: the repository as the manifest sees it.
// Every walked file with the node that governs it, every folder, every edge
// the resolver could follow with the verdict the policy gave it and the
// allowance that admitted it, every violation, and the manifest itself — its
// files' text, and each node's position in them — so a file in the tree and a
// line of `architecture.yaml` point at each other.
//
// Built from a loaded policy and the facts the host read; this module reads
// no file. The host hands in `factsOf` and the manifest's text.

export type AtlasPosition = {
  // Repo-relative path of the manifest file the position is in.
  readonly file: string;
  // 1-based, as editors count.
  readonly line: number;
  readonly column: number;
};

export type AtlasAllowance = {
  readonly kind: "allow" | "external";
  // As authored, after `use` expansion.
  readonly entry: string;
  // After alias expansion; the same as `entry` for an external.
  readonly expanded: string;
  // The `defs` fragment it arrived through, when the node wrote `use`.
  readonly fragment: string | null;
  // Whether any observed edge passes through it. An entry nothing uses is
  // slack: the signature of an allowlist widened to make a build green.
  readonly used: boolean;
};

export type AtlasNode = {
  // The slug rule names carry (`core/src/core`): the join key between a node
  // and every compiled rule lowered from it.
  readonly id: string;
  // The key as authored (`core/`), and the path of keys down to it.
  readonly key: string;
  readonly path: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly folder: boolean;
  readonly message: string | null;
  readonly layout: "open" | "enumerated";
  readonly partial: boolean;
  readonly position: AtlasPosition | null;
  readonly imports: {
    readonly message: string | null;
    readonly reset: boolean;
    readonly unrestricted: boolean;
    readonly allowances: ReadonlyArray<AtlasAllowance>;
    readonly deny: ReadonlyArray<{
      readonly match: ReadonlyArray<string>;
      readonly message: string;
    }>;
  } | null;
  readonly importedBy: {
    readonly message: string;
    readonly allow: ReadonlyArray<string>;
  } | null;
  readonly members: ReadonlyArray<{ readonly subject: string; readonly message: string }>;
  readonly surface: ReadonlyArray<{ readonly message: string }>;
  readonly requires: ReadonlyArray<string>;
  readonly children: ReadonlyArray<string>;
  // The compiled rules lowered from this node, by name.
  readonly rules: ReadonlyArray<string>;
  // Walked files this node is the deepest governor of.
  readonly files: number;
};

export type AtlasExternal = {
  readonly package: string;
  readonly specifiers: ReadonlyArray<string>;
  readonly status: EdgeStatus;
  readonly admittedBy: { readonly node: string; readonly entry: string } | null;
};

export type AtlasFile = {
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  // Under a walked root and of a language the policy loads. A file reached
  // from the walk but outside it (a shared config at the repository root) is
  // here for its edge to land on, and governed by nothing.
  readonly walked: boolean;
  // The deepest governing node, and every governing node root first.
  readonly node: string | null;
  readonly chain: ReadonlyArray<string>;
  // Names of the import rules selecting the file — the allowlist in force,
  // and the prohibitions and `importedBy` rules that speak to it.
  readonly importRules: ReadonlyArray<string>;
  readonly requires: ReadonlyArray<{
    readonly sibling: string;
    readonly present: boolean;
    readonly rule: string;
  }>;
  readonly externals: ReadonlyArray<AtlasExternal>;
  readonly builtins: ReadonlyArray<string>;
  readonly violations: number;
};

export type AtlasFolder = {
  readonly path: string;
  readonly name: string;
  readonly parent: string | null;
  readonly depth: number;
  // The deepest node governing files in this folder.
  readonly node: string | null;
  // Nodes whose own path is exactly this folder.
  readonly declares: ReadonlyArray<string>;
};

export type EdgeStatus = "allowed" | "refused" | "ungoverned";

export type AtlasEdge = {
  readonly from: string;
  readonly to: string;
  readonly specifiers: ReadonlyArray<string>;
  readonly status: EdgeStatus;
  readonly admittedBy: {
    readonly node: string;
    readonly entry: string;
    readonly fragment: string | null;
  } | null;
  readonly refusedBy: ReadonlyArray<{ readonly rule: string; readonly message: string }>;
};

export type AtlasViolation = {
  readonly fingerprint: string;
  readonly kind: ViolationKind;
  readonly rule: string;
  readonly file: string;
  readonly subject: string | null;
  readonly message: string;
  readonly baselined: boolean;
};

export type AtlasRule = {
  readonly family: "exports" | "cycles" | "orphans" | "reach";
  readonly name: string;
  readonly message: string;
  readonly position: AtlasPosition | null;
};

export type Atlas = {
  readonly version: 1;
  readonly name: string;
  readonly generatedAt: string;
  readonly roots: ReadonlyArray<string>;
  readonly manifest: {
    readonly path: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
    readonly aliases: Readonly<Record<string, string>>;
    readonly nodes: ReadonlyArray<AtlasNode>;
    readonly rules: ReadonlyArray<AtlasRule>;
  };
  readonly files: ReadonlyArray<AtlasFile>;
  readonly folders: ReadonlyArray<AtlasFolder>;
  readonly edges: ReadonlyArray<AtlasEdge>;
  readonly violations: ReadonlyArray<AtlasViolation>;
  readonly unresolved: ReadonlyArray<{
    readonly file: string;
    readonly specifier: string;
    readonly detail: string;
  }>;
  readonly cycles: number;
};

export type AtlasInput = {
  readonly policy: LoadedPolicy;
  readonly name: string;
  readonly roots: ReadonlyArray<string>;
  // The walked files of the policy's languages, repo-relative.
  readonly files: ReadonlyArray<string>;
  readonly factsOf: (file: string) => SourceFacts;
  // Where a manifest value was written, and the files it was written in.
  readonly locate: ManifestLocator | undefined;
  readonly manifestPath: string;
  readonly manifestFiles: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly now: number;
};

const FOLDER_KEY = /\/$/;
const ALTERNATIVE = /\s*\|\s*/;
const WILDCARD = /[*{]/;

const stripSlash = (key: string): string => key.replace(FOLDER_KEY, "");

const alternativesOf = (key: string): ReadonlyArray<string> =>
  key
    .split(ALTERNATIVE)
    .map(stripSlash)
    .filter((one) => one !== "");

const escapeRegExp = (literal: string): string => literal.replace(/[.+^$()|[\]\\*?{}]/g, "\\$&");

const dirnameOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

// One manifest node, compiled the way lowering compiles it: the same regex
// source for its path, so the files this atlas says a node governs are the
// files its rules select.
type WalkedNode = {
  readonly node: AtlasNode;
  readonly matches: (file: string) => boolean;
  readonly isExactly: (folder: string) => boolean;
  readonly wildcards: number;
};

type Frame = {
  readonly pathSource: string;
  readonly captures: Readonly<Record<string, number>>;
  readonly nextGroup: number;
};

const positionAt = (
  locate: ManifestLocator | undefined,
  manifestPath: string,
  path: ManifestPath,
): AtlasPosition | null => {
  const found = locate?.(path);
  if (found === null || found === undefined) return null;
  const directory = dirnameOf(manifestPath);
  const file =
    found.file === undefined
      ? manifestPath
      : directory === ""
        ? found.file
        : `${directory}/${found.file}`;
  return { file, line: found.line, column: found.column };
};

const walkTree = (
  policy: LoadedPolicy,
  locate: ManifestLocator | undefined,
  manifestPath: string,
  unusedKeys: ReadonlySet<string>,
): ReadonlyArray<WalkedNode> => {
  const aliases = policy.config.aliases ?? {};
  const walked: Array<WalkedNode> = [];
  const allowlistOf = (id: string): CompiledImportRule | undefined =>
    policy.importRules.find((rule) => rule.name === `${id}/imports`);
  const ruleNames = [
    ...policy.importRules.map((rule) => rule.name),
    ...policy.memberRules.map((rule) => rule.name),
    ...policy.surfaceRules.map((rule) => rule.name),
    ...policy.structure.roots.map((rule) => rule.name),
    ...policy.structure.folders.map((rule) => rule.name),
    ...policy.structure.parity.map((rule) => rule.name),
    ...policy.structure.naming.map((rule) => rule.name),
  ];

  const walk = (
    key: string,
    node: ManifestNode,
    parent: Frame,
    id: string,
    parentId: string | null,
    path: string,
    depth: number,
    siblings: ReadonlyArray<string>,
    nodePath: ManifestPath,
  ): void => {
    const literalSiblings = siblings
      .filter((sibling) => sibling !== key)
      .flatMap(alternativesOf)
      .filter((sibling) => !WILDCARD.test(sibling));
    const alternatives = alternativesOf(key).map((one) => expandAliases(one, aliases));
    const [first = ""] = alternatives;
    const compiledFirst = globToRegexSource(first, parent.captures, {
      declaring: true,
      nextGroup: parent.nextGroup,
    });
    const source =
      alternatives.length === 1
        ? compiledFirst.source
        : `(?:${alternatives
            .map(
              (one) =>
                globToRegexSource(one, parent.captures, {
                  declaring: false,
                  nextGroup: parent.nextGroup,
                }).source,
            )
            .join("|")})`;
    const guarded =
      literalSiblings.length > 0 && WILDCARD.test(first)
        ? `(?!(?:${literalSiblings.map(escapeRegExp).join("|")})(?:/|$))${source}`
        : source;
    const pathSource = parent.pathSource === "" ? guarded : `${parent.pathSource}/${guarded}`;
    const nextGroup =
      parent.nextGroup +
      (Object.keys(compiledFirst.captures).length - Object.keys(parent.captures).length);
    const frame: Frame = { pathSource, captures: compiledFirst.captures, nextGroup };
    const isFolder = FOLDER_KEY.test(key) || node.children !== undefined;
    const self = new RegExp(anchored(pathSource));
    const under = new RegExp(prefixed(`${pathSource}/`));

    const children = Object.entries(node.children ?? {});
    const childIds = children.map(([childKey]) => `${id}/${alternativesOf(childKey)[0] ?? ""}`);

    const allowlist = allowlistOf(id);
    const own = (allowlist?.allowances ?? []).filter((one) => one.node === id);
    const imports =
      node.imports === undefined
        ? null
        : {
            message: node.imports.message ?? null,
            reset: node.imports.reset === true,
            unrestricted: node.imports.unrestricted === true,
            allowances: own.map((one) => ({
              kind: one.kind,
              entry: one.entry,
              expanded: one.kind === "allow" ? expandAliases(one.entry, aliases) : one.entry,
              fragment: one.fragment ?? null,
              used: !unusedKeys.has(
                `${one.fragment ?? one.node}\u0000${one.kind}\u0000${one.entry}`,
              ),
            })),
            deny: (node.imports.deny ?? []).map((one) => ({
              match: typeof one.match === "string" ? [one.match] : [...one.match],
              message: one.message,
            })),
          };

    walked.push({
      node: {
        id,
        key,
        path,
        parent: parentId,
        depth,
        folder: isFolder,
        message: node.message ?? null,
        layout: node.layout === "open" ? "open" : "enumerated",
        partial: node.partial === true,
        position: positionAt(locate, manifestPath, nodePath),
        imports,
        importedBy:
          node.importedBy === undefined
            ? null
            : {
                message: node.importedBy.message,
                allow:
                  typeof node.importedBy.allow === "string"
                    ? [node.importedBy.allow]
                    : [...node.importedBy.allow],
              },
        members: (node.members ?? []).map((one) => ({
          subject: one.subject,
          message: one.message,
        })),
        surface: (node.surface ?? []).map((one) => ({ message: one.message })),
        requires: [...(node.requires ?? [])],
        children: childIds,
        rules: ruleNames.filter(
          (name) => name.startsWith(`${id}/`) && !name.slice(id.length + 1).includes("/"),
        ),
        files: 0,
      },
      matches: isFolder ? (file) => under.test(file) : (file) => self.test(file),
      isExactly: (folder) => isFolder && self.test(folder),
      wildcards: (first.match(/[*{]/g) ?? []).length,
    });

    for (const [childKey, child] of children) {
      walk(
        childKey,
        child,
        frame,
        `${id}/${alternativesOf(childKey)[0] ?? ""}`,
        id,
        `${path}${childKey}`,
        depth + 1,
        children.map(([one]) => one),
        [...nodePath, "children", childKey],
      );
    }
  };

  const roots = Object.entries(policy.config.tree);
  for (const [key, node] of roots) {
    walk(
      key,
      node,
      { pathSource: "", captures: {}, nextGroup: 1 },
      stripSlash(key)
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      null,
      key,
      0,
      roots.map(([one]) => one),
      ["tree", key],
    );
  }
  return walked;
};

// The deepest node whose path covers the file, root first. Ties at a depth
// go to the key with fewer wildcards: `src/` over `**/`.
const chainOf = (nodes: ReadonlyArray<WalkedNode>, file: string): ReadonlyArray<AtlasNode> => {
  const matching = nodes.filter((one) => one.matches(file));
  const byDepth = new Map<number, WalkedNode>();
  for (const one of matching) {
    const held = byDepth.get(one.node.depth);
    if (held === undefined || one.wildcards < held.wildcards) byDepth.set(one.node.depth, one);
  }
  const chain = [...byDepth.values()].sort((a, b) => a.node.depth - b.node.depth);
  // A node only governs through its ancestors: drop anything whose parent is
  // not the previous link.
  const linked: Array<AtlasNode> = [];
  for (const one of chain) {
    const previous = linked[linked.length - 1];
    if (previous === undefined ? one.node.parent === null : one.node.parent === previous.id) {
      linked.push(one.node);
    }
  }
  return linked;
};

const admittedBy = (
  allowlist: CompiledImportRule | undefined,
  captures: RegExpExecArray | null,
  target: { readonly kind: string; readonly path: string; readonly package?: string },
): { node: string; entry: string; fragment: string | null } | null => {
  if (allowlist === undefined || captures === null) return null;
  for (const allowance of allowlist.allowances) {
    if (allowance.kind === "external") {
      if (target.kind === "external" && target.package === allowance.entry) {
        return {
          node: allowance.node,
          entry: allowance.entry,
          fragment: allowance.fragment ?? null,
        };
      }
      continue;
    }
    if (allowance.pattern !== undefined && matchesAny([allowance.pattern], captures, target.path)) {
      return { node: allowance.node, entry: allowance.entry, fragment: allowance.fragment ?? null };
    }
  }
  return null;
};

export const buildAtlas = (input: AtlasInput): Atlas => {
  const { factsOf, policy } = input;
  const known = new Set(input.files);
  const violations: Array<Violation> = [];
  const unresolved: Array<Atlas["unresolved"][number]> = [];
  const observed: Array<ObservedEdge> = [];
  const edgeMap = new Map<string, AtlasEdge>();
  const externalsOf = new Map<string, Array<AtlasExternal>>();
  const builtinsOf = new Map<string, Array<string>>();
  const importRulesOf = new Map<string, ReadonlyArray<string>>();
  const requiresOf = new Map<string, AtlasFile["requires"]>();
  const outside = new Set<string>();
  const graphEdges = new Map<string, ReadonlyArray<string>>();

  for (const file of input.files) {
    const facts = factsOf(file);
    const selectedImports = rulesSelecting(policy.importRules, file);
    const selectedExports = exportRulesSelecting(policy.exportRules, file);
    const selectedMembers = memberRulesSelecting(policy.memberRules, file);
    const selectedSurface = surfaceRulesSelecting(policy.surfaceRules, file);
    const allowlist = selectedImports
      .map(([rule]) => rule)
      .find((rule) => rule.to.length === 0 && rule.toNot.length > 0);
    const captures = allowlist === undefined ? null : firstFromMatch(allowlist, file);
    importRulesOf.set(
      file,
      selectedImports.map(([rule]) => rule.name),
    );

    for (const violation of evaluateStructure(policy.structure, policy.fileSystem, file)) {
      violations.push(violation);
    }
    for (const violation of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      violations.push(violation);
    }
    for (const site of facts.memberSites) {
      for (const violation of evaluateMemberSite(selectedMembers, site)) violations.push(violation);
    }
    requiresOf.set(
      file,
      policy.structure.parity
        .filter(
          (rule) =>
            rule.file.some((pattern) => pattern.test(file)) &&
            !rule.fileNot.some((pattern) => pattern.test(file)),
        )
        .flatMap((rule) =>
          requiredSiblingsOf(rule, file).map((sibling) => ({
            sibling,
            present: policy.fileSystem.exists(sibling),
            rule: rule.name,
          })),
        ),
    );

    const targets = new Set<string>();
    for (const specifier of facts.specifiers) {
      const resolved = policy.resolver.resolve(file, specifier);
      if (Result.isFailure(resolved)) {
        if (
          policy.config.resolve.unresolved !== "off" &&
          !policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))
        ) {
          unresolved.push({ file, specifier, detail: resolved.failure.detail });
        }
        continue;
      }
      const target = resolved.success;
      const refused =
        selectedImports.length === 0 ? [] : evaluateResolvedEdge(selectedImports, file, target);
      for (const violation of refused) violations.push(violation);
      if (selectedImports.length > 0) observed.push({ importer: file, target });
      const status: EdgeStatus =
        refused.length > 0 ? "refused" : allowlist === undefined ? "ungoverned" : "allowed";

      const bound = facts.bindings.get(specifier) ?? [];
      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        importer: file,
        specifier,
        bindings: bound,
      });
      if (!Result.isFailure(exported)) {
        for (const { violation } of exported.success) violations.push(violation);
      }

      if (target.kind === "builtin") {
        const held = builtinsOf.get(file) ?? [];
        if (!held.includes(target.path)) held.push(target.path);
        builtinsOf.set(file, held);
        continue;
      }
      if (target.kind === "external") {
        const name = target.package ?? target.path;
        const held = externalsOf.get(file) ?? [];
        const existing = held.find((one) => one.package === name);
        if (existing === undefined) {
          const by = admittedBy(allowlist, captures, target);
          held.push({
            package: name,
            specifiers: [specifier],
            status,
            admittedBy: by === null ? null : { node: by.node, entry: by.entry },
          });
        } else {
          held.splice(held.indexOf(existing), 1, {
            ...existing,
            specifiers: [...existing.specifiers, specifier],
            status: existing.status === "refused" ? "refused" : status,
          });
        }
        externalsOf.set(file, held);
        continue;
      }
      if (!known.has(target.path)) outside.add(target.path);
      else targets.add(target.path);
      const key = `${file}\u0000${target.path}`;
      const held = edgeMap.get(key);
      const refusedBy = refused.map((violation) => ({
        rule: violation.ruleName,
        message: formatMessage(violation),
      }));
      if (held === undefined) {
        edgeMap.set(key, {
          from: file,
          to: target.path,
          specifiers: [specifier],
          status,
          admittedBy: admittedBy(allowlist, captures, target),
          refusedBy,
        });
      } else {
        edgeMap.set(key, {
          ...held,
          specifiers: [...held.specifiers, specifier],
          status: held.status === "refused" || status === "refused" ? "refused" : held.status,
          refusedBy: [
            ...held.refusedBy,
            ...refusedBy.filter((one) => !held.refusedBy.some((two) => two.rule === one.rule)),
          ],
        });
      }
    }
    graphEdges.set(file, [...targets]);
  }

  const graph: Graph = { files: input.files, edges: graphEdges };
  if (hasGraphRules(policy.graph)) {
    for (const violation of evaluateGraph(policy.graph, graph)) violations.push(violation);
  }
  const cycles = cyclesIn(graph).length;

  const slack = slackOf(policy.importRules, observed, input.files);
  const unusedKeys = new Set(
    slack.slack.map((one) => `${one.fragment ?? one.node}\u0000${one.kind}\u0000${one.entry}`),
  );
  const nodes = walkTree(policy, input.locate, input.manifestPath, unusedKeys);
  const governed = new Map<string, number>();

  const violationsByFile = new Map<string, number>();
  for (const violation of violations) {
    violationsByFile.set(violation.file, (violationsByFile.get(violation.file) ?? 0) + 1);
  }

  const fileOf = (path: string, walked: boolean): AtlasFile => {
    const chain = walked ? chainOf(nodes, path) : [];
    const node = chain[chain.length - 1]?.id ?? null;
    if (node !== null) governed.set(node, (governed.get(node) ?? 0) + 1);
    return {
      path,
      name: basenameOf(path),
      folder: dirnameOf(path),
      walked,
      node,
      chain: chain.map((one) => one.id),
      importRules: importRulesOf.get(path) ?? [],
      requires: requiresOf.get(path) ?? [],
      externals: externalsOf.get(path) ?? [],
      builtins: builtinsOf.get(path) ?? [],
      violations: violationsByFile.get(path) ?? 0,
    };
  };
  const files = [
    ...input.files.map((path) => fileOf(path, true)),
    ...[...outside].sort().map((path) => fileOf(path, false)),
  ].sort((a, b) => a.path.localeCompare(b.path));

  const folderPaths = new Set<string>();
  for (const file of files) {
    let folder = file.folder;
    while (folder !== "" && !folderPaths.has(folder)) {
      folderPaths.add(folder);
      folder = dirnameOf(folder);
    }
  }
  const folders: ReadonlyArray<AtlasFolder> = [...folderPaths].sort().map((path) => {
    const chain = chainOf(nodes, `${path}/zzprobe`);
    return {
      path,
      name: basenameOf(path),
      parent: dirnameOf(path) === "" ? null : dirnameOf(path),
      depth: path.split("/").length - 1,
      node: chain[chain.length - 1]?.id ?? null,
      declares: nodes.filter((one) => one.isExactly(path)).map((one) => one.node.id),
    };
  });

  const position = (path: ManifestPath) => positionAt(input.locate, input.manifestPath, path);
  const rules: Array<AtlasRule> = [
    ...(policy.config.exports ?? []).map((rule, index) => ({
      family: "exports" as const,
      name: rule.name,
      message: rule.message,
      position: position(["exports", index]),
    })),
    ...(policy.config.graph?.cycles ?? []).map((rule, index) => ({
      family: "cycles" as const,
      name: rule.name,
      message: rule.message,
      position: position(["graph", "cycles", index]),
    })),
    ...(policy.config.graph?.orphans ?? []).map((rule, index) => ({
      family: "orphans" as const,
      name: rule.name,
      message: rule.message,
      position: position(["graph", "orphans", index]),
    })),
    ...(policy.config.graph?.reach ?? []).map((rule, index) => ({
      family: "reach" as const,
      name: rule.name,
      message: rule.message,
      position: position(["graph", "reach", index]),
    })),
  ];

  return {
    version: 1,
    name: input.name,
    generatedAt: new Date(input.now).toISOString(),
    roots: input.roots,
    manifest: {
      path: input.manifestPath,
      files: input.manifestFiles,
      aliases: policy.config.aliases ?? {},
      nodes: nodes.map((one) => ({ ...one.node, files: governed.get(one.node.id) ?? 0 })),
      rules,
    },
    files,
    folders,
    edges: [...edgeMap.values()].sort((a, b) => {
      const byFrom = a.from.localeCompare(b.from);
      return byFrom !== 0 ? byFrom : a.to.localeCompare(b.to);
    }),
    violations: violations
      .map((violation) => ({
        fingerprint: fingerprintOf(violation),
        kind: violation.kind,
        rule: violation.ruleName,
        file: violation.file,
        subject: violation.subject,
        message: formatMessage(violation),
        baselined: policy.baseline.isBaselined(violation),
      }))
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    unresolved,
    cycles,
  };
};
