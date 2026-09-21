import * as Result from "effect/Result";

import {
  type Allowance,
  type CampaignProbe,
  type CampaignRule,
  type Detector,
  type ExportRule,
  type GraphConfig,
  type ImportRule,
  type MemberRule,
  type ObjectiveRule,
  OPEN_LAYOUT,
  type PerimeterRule,
  type PhaseRule,
  type SectorTerm,
  type StructureFolder,
  type StructureNaming,
  type StructureParity,
  type StructureRoot,
  type SurfaceRule,
} from "../domain/architecture-config.js";
import type { ManifestPath } from "../domain/manifest-location.js";
import { fragmentOf, type Substitution } from "./expand.js";
import { anchored, type CaptureIndex, globToRegexSource, prefixed } from "./glob.js";
import {
  type CampaignProbesSpec,
  type CampaignSpec,
  decodeManifestTree,
  type DetectorSpec,
  durationMs,
  globsOf,
  type ImportsSpec,
  type Manifest,
  type ManifestNode,
  type NamingSpec,
  type PhaseSpec,
  type SyntaxTermSpec,
} from "./manifest.js";

// The manifest is the authoring surface; these flat rules are the machine's.
// Lowering rather than interpreting keeps one evaluator, one probe mechanism and
// one set of semantics — the tree only decides what gets written.
export type LoweredRules = {
  readonly imports: ReadonlyArray<ImportRule>;
  readonly exports: ReadonlyArray<ExportRule>;
  readonly members: ReadonlyArray<MemberRule>;
  readonly surface: ReadonlyArray<SurfaceRule>;
  readonly graph: GraphConfig;
  // Campaigns pass through by their own id, as top-level `exports` rules do.
  readonly campaigns: ReadonlyArray<CampaignRule>;
  // The nodes that said "not tightened yet", by name — the adoption backlog,
  // and what `limits` puts a ceiling on.
  readonly adoption: {
    readonly unrestricted: ReadonlyArray<string>;
    readonly partial: ReadonlyArray<string>;
  };
  readonly structure: {
    readonly roots: ReadonlyArray<StructureRoot>;
    readonly folders: ReadonlyArray<StructureFolder>;
    readonly parity: ReadonlyArray<StructureParity>;
    readonly naming: ReadonlyArray<StructureNaming>;
  };
};

const FOLDER_KEY = /\/$/;

// The marker an open folder's allowlist carries: it admits any name, so it has
// no layout policy to prove.
export const ANY_FILE = OPEN_LAYOUT;

// The `from` side of a rule that applies to every file, wherever the repository
// happens to keep its packages.
const EVERY_FILE = "";

// A key may name several patterns that share one node: the four `*-ops`
// stereotypes carry identical policy, and saying it once is the point of writing
// the architecture as a tree.
const ALTERNATIVE = /\s*\|\s*/;

const isFolderKey = (key: string): boolean => FOLDER_KEY.test(key);

const stripSlash = (key: string): string => key.replace(FOLDER_KEY, "");

// Split first, then strip: `"http/ | cli/"` carries a trailing slash on every
// alternative, not only the last one.
const alternativesOf = (key: string): ReadonlyArray<string> =>
  key
    .split(ALTERNATIVE)
    .map(stripSlash)
    .filter((one) => one !== "");

const expandAliases = (glob: string, aliases: Readonly<Record<string, string>>): string => {
  for (const [alias, target] of Object.entries(aliases)) {
    if (glob === alias) return target;
    if (glob.startsWith(`${alias}/`)) return target + glob.slice(alias.length);
  }
  return glob;
};

type Frame = {
  // Regex source for this node's own path, unanchored.
  readonly pathSource: string;
  // Glob for this node's path, used to synthesise probes.
  readonly pathGlob: string;
  readonly captures: CaptureIndex;
  readonly nextGroup: number;
  // The allowlist in force, accumulated down the tree; `reset` is the only
  // thing that clears it. Each entry remembers the node that wrote it. A path
  // glob is compiled to a target pattern; a package is judged by its name and
  // never by where the language's resolver found it, so it carries none.
  readonly allowances: ReadonlyArray<Allowance>;
  readonly importsMessage: string;
  // Inherited like the allowlist: a tier states its naming convention once.
  readonly naming: NamingSpec | undefined;
};

// What lowering needs to know about a language: which scope ids name it, and
// what a source file of it is called. Structurally a `Language`, so the host
// passes its packs straight through; declared here so this tier never names
// the port.
export type ProbeLanguage = {
  readonly id: string;
  readonly extensions: ReadonlyArray<string>;
};

// A probe is the node's own path with its wildcards filled in, so a rule is
// proven against the shape it was written for and nobody hand-writes one.
const PROBE_WORDS = ["alpha", "beta", "gamma", "delta"];

const probePathOf = (pathGlob: string, leaf: string): string => {
  let word = 0;
  const filled = pathGlob
    .replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, () => {
      const value = PROBE_WORDS[word % PROBE_WORDS.length] ?? "alpha";
      word += 1;
      return value;
    })
    .replace(/\*\*/g, "deep")
    .replace(/\*/g, "zz");
  if (leaf === "") return filled;
  return filled === "" ? leaf : `${filled}/${leaf}`;
};

// The probe name must satisfy the rule's own `match`, or the rule cannot report
// it and the vacuity check fires on a healthy rule.
const probeMemberName = (match: string | ReadonlyArray<string> | undefined): string => {
  if (match === undefined) return "zzProbeMember";
  const first = globsOf(match)[0] ?? "";
  return `${first
    // A character class stands for one character, so the probe uses the first
    // one it admits: `use[A-Z]*` has to be proven with `useA…`, not `use[A-Z]…`.
    .replace(/\[\^?([^\]])[^\]]*\]/g, "$1")
    .replace(/\*/g, "")}ZzProbe`;
};

// Each convention pairs the shape a name must have with a name that does not
// have it, so the rule's probe is generated rather than written.
const CONVENTIONS: Readonly<
  Record<string, { readonly source: string; readonly violating: string; readonly shape: string }>
> = {
  "kebab-case": {
    source: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    violating: "zzProbeStray",
    shape: "lowercase words joined by hyphens",
  },
  camelCase: {
    source: "^[a-z][a-zA-Z0-9]*$",
    violating: "zz-probe-stray",
    shape: "a lowercase first word, then capitalised ones, with no separators",
  },
  PascalCase: {
    source: "^[A-Z][a-zA-Z0-9]*$",
    violating: "zz-probe-stray",
    shape: "capitalised words with no separators",
  },
  snake_case: {
    source: "^[a-z0-9]+(?:_[a-z0-9]+)*$",
    violating: "zzProbeStray",
    shape: "lowercase words joined by underscores",
  },
};

// The folder's file list already enforces the stereotype suffix; a naming rule
// is about the concept name in front of it, so the message says which part it
// is talking about.
const namingMessageOf = (spec: NamingSpec, subject: "file" | "folder"): string => {
  const what =
    subject === "folder" ? "This folder's name" : "The concept name in front of the stereotype";
  if (typeof spec === "string") {
    return `${what} is ${spec} here — ${CONVENTIONS[spec]?.shape ?? ""}.`;
  }
  if (spec.message !== undefined) return spec.message;
  if ("like" in spec) {
    return "A file here is named after its folder, so its concept name is the folder's own.";
  }
  return `${what} matches /${spec.regex}/ here.`;
};

// A custom convention still owes a counter-example. If none of these fails it,
// the pattern admits every name and the rule could never report anything —
// which is the vacuity this package refuses to load.
const VIOLATING_CANDIDATES = ["zzProbeStray", "zz-probe-stray", "ZZ_PROBE_STRAY", "zz probe.stray"];

const violatingSampleFor = (spec: NamingSpec, ruleName: string): string => {
  if (typeof spec === "string") {
    const convention = CONVENTIONS[spec];
    if (convention === undefined) throw new Error(`unknown naming convention "${spec}"`);
    return convention.violating;
  }
  if ("like" in spec) return "zzprobestray";
  const matcher = new RegExp(spec.regex);
  const found = VIOLATING_CANDIDATES.find((candidate) => !matcher.test(candidate));
  if (found === undefined) {
    throw new Error(
      `naming rule "${ruleName}" states /${spec.regex}/, which admits every name this ` +
        `compiler can think of. A convention nothing can violate is a rule that never reports.`,
    );
  }
  return found;
};

// The probe is the node's own probe path with the subject replaced by a name the
// convention rejects — located by matching, so the compiler never has to reason
// about which segment of a glob the subject came from.
const namingProbeOf = (
  patternSource: string,
  subject: number,
  probe: string,
  violating: string,
): string => {
  const found = new RegExp(patternSource, "d").exec(probe);
  const span = found?.indices?.[subject];
  if (span === undefined) return probe;
  return probe.slice(0, span[0]) + violating + probe.slice(span[1]);
};

type Denial = {
  readonly match: string;
  readonly matchNot: ReadonlyArray<string>;
  readonly except: ReadonlyArray<string>;
  readonly message: string;
  // A concrete path the denial matches, so its probe aims at the shape it was
  // written for rather than at one generic target for every denial.
  readonly probe: string;
};

// Which `defs` fragment one key of a node's `imports` was written in, when it
// was written in one. Resolved per key, since `imports: { use: x, allow: […] }`
// takes `allow` from the reference site and `external` from the fragment.
type ImportsProvenance = (key: "allow" | "external") => string | undefined;

const mergeImports = (
  frame: Frame,
  spec: ImportsSpec | undefined,
  aliases: Readonly<Record<string, string>>,
  captures: CaptureIndex,
  nextGroup: number,
  node: string,
  provenance: ImportsProvenance,
): Pick<Frame, "allowances" | "importsMessage"> & {
  readonly deny: ReadonlyArray<Denial>;
} => {
  if (spec === undefined) {
    return { allowances: frame.allowances, deny: [], importsMessage: frame.importsMessage };
  }

  const compileAllow = (glob: string): string =>
    prefixed(
      globToRegexSource(expandAliases(glob, aliases), captures, { declaring: false, nextGroup })
        .source,
    );

  const via = (key: "allow" | "external"): Pick<Allowance, "fragment"> => {
    const fragment = provenance(key);
    return fragment === undefined ? {} : { fragment };
  };
  const own: ReadonlyArray<Allowance> = [
    ...globsOf(spec.allow ?? []).map((glob) => ({
      node,
      kind: "allow" as const,
      entry: expandAliases(glob, aliases),
      pattern: compileAllow(glob),
      ...via("allow"),
    })),
    ...(spec.external ?? []).map((name) => ({
      node,
      kind: "external" as const,
      entry: name,
      ...via("external"),
    })),
  ];
  const deny = (spec.deny ?? []).flatMap((entry) =>
    globsOf(entry.match).map((glob) => ({
      match: compileAllow(glob),
      matchNot: globsOf(entry.matchNot ?? []).map(compileAllow),
      except: globsOf(entry.except ?? []).map(compileAllow),
      message: entry.message,
      probe: probePathOf(expandAliases(glob, aliases), ""),
    })),
  );

  // `reset` drops inherited ALLOWANCES only. A prohibition always accumulates, so
  // resetting can never make a subtree quieter than its ancestors — the direction
  // a mistake here would be dangerous in.
  const dropping = spec.reset === true || spec.unrestricted === true;
  return {
    allowances: dropping ? own : [...frame.allowances, ...own],
    // Only what this node declares. A prohibition is emitted once, over its whole
    // subtree, so descendants neither re-emit it nor can escape it — which is
    // what makes `reset` structurally unable to make a subtree quieter.
    deny,
    importsMessage: spec.message ?? frame.importsMessage,
  };
};

export type LowerOptions = {
  // The `use` references the expansion replaced, so an allowance can say
  // which fragment it came through. A manifest lowered without them is one
  // whose every entry reads as authored where it sits.
  readonly substitutions?: ReadonlyArray<Substitution>;
};

export const lowerManifest = (
  manifest: Manifest,
  languages: ReadonlyArray<ProbeLanguage> = [],
  options: LowerOptions = {},
): LoweredRules => {
  const aliases = manifest.aliases ?? {};
  const substitutions = options.substitutions ?? [];

  // The extension a synthetic probe file carries: the first extension of the
  // language whose scope covers the probe's folder. A probe is matched by its
  // folder, so the extension only makes it a file that language would have —
  // which matters exactly when an allowlist admits `**/*.<ext>`, and would
  // otherwise pass its probe while admitting every file.
  const extensionFor = (folder: string): string => {
    const scope = manifest.resolve.scopes.find((one) =>
      new RegExp(one.files).test(`${folder}/zzprobe`),
    );
    const language = languages.find((one) => one.id === scope?.language);
    return language?.extensions[0] ?? "";
  };

  // A synthetic file inside a folder glob: the folder with its wildcards filled,
  // then the stem, then whatever extension the folder's language uses.
  const probeIn = (folderGlob: string, stem: string): string =>
    probePathOf(folderGlob, `${stem}${extensionFor(probePathOf(folderGlob, ""))}`);

  // A synthetic file somewhere no node governs, written like a file of the
  // language at `likeFolder` so that it is refused by a rule about that
  // language's files and not merely by one about its own folder.
  const probeOutside = (stem: string, likeFolder = "packages/zzprobe"): string =>
    `packages/zzprobe/${stem}${extensionFor(likeFolder)}`;

  // The folder layout rule must be proven with a basename the folder rejects.
  // What that is depends on what the folder admits: a stray with the language's
  // own extension is a file a folder admitting every such file is happy with.
  const strayBasenameFor = (
    admitted: ReadonlyArray<string>,
    extension: string,
    ruleName: string,
  ): string => {
    const candidates = [`zzprobe-stray${extension}`, "zzprobe-stray", "zzprobe.stray.zz"];
    const rejected = candidates.find(
      (candidate) => !admitted.some((pattern) => new RegExp(pattern).test(candidate)),
    );
    if (rejected === undefined) {
      throw new Error(
        `"${ruleName}" admits every file name this compiler can think of, so it enumerates ` +
          `nothing. A folder that does not police its file names is \`layout: "open"\`; say so.`,
      );
    }
    return rejected;
  };
  const imports: Array<ImportRule> = [];
  const exports: Array<ExportRule> = [];
  const members: Array<MemberRule> = [];
  const surface: Array<SurfaceRule> = [];
  const unrestrictedNodes: Array<string> = [];
  const partialNodes: Array<string> = [];
  const roots: Array<StructureRoot> = [];
  const folders: Array<StructureFolder> = [];
  const parity: Array<StructureParity> = [];
  const namingRules: Array<StructureNaming> = [];

  const walk = (
    key: string,
    node: ManifestNode,
    parent: Frame,
    name: string,
    siblings: ReadonlyArray<string>,
    // Where this node sits in the expanded document, so its `imports` keys
    // can be traced back through any `use` that carried them.
    nodePath: ManifestPath,
  ): void => {
    const literalSiblings = siblings
      .filter((sibling) => sibling !== key)
      .flatMap(alternativesOf)
      .filter((sibling) => !/[*{]/.test(sibling));
    const alternatives = alternativesOf(key).map((one) => expandAliases(one, aliases));
    const [first = ""] = alternatives;

    if (node.partial === true) partialNodes.push(name);
    if (node.imports?.unrestricted === true) unrestrictedNodes.push(name);
    if (alternatives.length > 1 && alternatives.some((one) => one.includes("{"))) {
      throw new Error(
        `key "${key}" both names several patterns and declares a capture. A capture has to come ` +
          `from one place, so give the capturing pattern its own key.`,
      );
    }
    // The probe, the path and every descendant hang off the first alternative;
    // the rest only widen what the pattern matches.
    const joinedGlob = parent.pathGlob === "" ? first : `${parent.pathGlob}/${first}`;
    const compiledFirst = globToRegexSource(first, parent.captures, {
      declaring: true,
      nextGroup: parent.nextGroup,
    });
    const compiled =
      alternatives.length === 1
        ? compiledFirst
        : {
            captures: compiledFirst.captures,
            source: `(?:${alternatives
              .map(
                (one) =>
                  globToRegexSource(one, parent.captures, {
                    declaring: false,
                    nextGroup: parent.nextGroup,
                  }).source,
              )
              .join("|")})`,
          };
    // `(?!domain-services$|ports$)` — written by the compiler, from the fact that
    // those keys are siblings of this one.
    const guarded =
      literalSiblings.length > 0 && /[*{]/.test(first)
        ? `(?!(?:${literalSiblings.map((one) => one.replace(/[.+^$()|[\]\\*?{}]/g, "\\$&")).join("|")})(?:/|$))${compiled.source}`
        : compiled.source;
    const pathSource = parent.pathSource === "" ? guarded : `${parent.pathSource}/${guarded}`;
    const nextGroup =
      parent.nextGroup +
      (Object.keys(compiled.captures).length - Object.keys(parent.captures).length);

    const merged = mergeImports(
      parent,
      node.imports,
      aliases,
      compiled.captures,
      nextGroup,
      name,
      (field) => fragmentOf(substitutions, [...nodePath, "imports", field]),
    );
    const ownDenials = merged.deny;
    const frame: Frame = {
      pathSource,
      pathGlob: joinedGlob,
      captures: compiled.captures,
      nextGroup,
      allowances: merged.allowances,
      importsMessage: merged.importsMessage,
      naming: node.name ?? parent.naming,
    };

    const isFolder = isFolderKey(key) || node.children !== undefined;
    const selfPattern = anchored(pathSource);

    // Naming, in two shapes. A folder judges its own segment (when its key
    // declares a capture) and the concept name of every file directly inside
    // it; a file node judges what its own `*` matched, which is where "named
    // after its folder" lives.
    //
    // A file's concept name is its basename up to the FIRST dot, not what a `*`
    // matched: the key `*-live.<ext>` matches `todos.repository-live.<ext>`, whose
    // wildcard spans a stereotype segment as well as the concept.
    const naming = frame.naming;
    if (naming !== undefined) {
      const declaredHere = Object.keys(compiled.captures).filter(
        (one) => parent.captures[one] === undefined,
      );
      const lastDeclared = declaredHere[declaredHere.length - 1];
      const isLike = typeof naming === "object" && "like" in naming;

      const emit = (
        ruleName: string,
        patterns: ReadonlyArray<string>,
        subject: number,
        probe: string,
        sameAs?: number,
        judging: "file" | "folder" = "file",
      ): void => {
        namingRules.push({
          name: ruleName,
          message: namingMessageOf(naming, judging),
          probe: {
            path:
              sameAs === undefined
                ? namingProbeOf(
                    patterns[0] ?? "",
                    subject,
                    probe,
                    violatingSampleFor(naming, ruleName),
                  )
                : probe,
          },
          file: patterns,
          subject,
          ...(sameAs === undefined
            ? {
                convention:
                  typeof naming === "string"
                    ? (CONVENTIONS[naming]?.source ?? "")
                    : "regex" in naming
                      ? naming.regex
                      : "",
              }
            : { sameAs }),
        });
      };

      if (isFolder && !isLike) {
        if (lastDeclared !== undefined) {
          const subject = compiled.captures[lastDeclared];
          if (subject !== undefined) {
            emit(
              `${name}/naming-folder`,
              [prefixed(`${pathSource}/`)],
              subject,
              probeIn(joinedGlob, "zzprobe"),
              undefined,
              "folder",
            );
          }
        }
        emit(
          `${name}/naming`,
          [anchored(`${pathSource}/([^/.]+)[^/]*`)],
          nextGroup,
          probeIn(joinedGlob, "zzprobe"),
        );
      }

      if (!isFolder && isLike) {
        const namingCompiled = alternatives.map((one) =>
          globToRegexSource(one, parent.captures, {
            declaring: true,
            nextGroup: parent.nextGroup,
            capturing: true,
          }),
        );
        const [firstNaming] = namingCompiled;
        const subject = firstNaming?.wildcards[firstNaming.wildcards.length - 1];
        const sameAs =
          typeof naming === "object" && "like" in naming
            ? parent.captures[naming.like.replace(/[{}]/g, "")]
            : undefined;
        if (typeof naming === "object" && "like" in naming && sameAs === undefined) {
          throw new Error(
            `naming at "${key}" is like ${naming.like}, which no ancestor path declares.`,
          );
        }
        if (subject !== undefined && sameAs !== undefined) {
          emit(
            `${name}/naming`,
            namingCompiled.map((one) =>
              anchored(
                parent.pathSource === "" ? one.source : `${parent.pathSource}/${one.source}`,
              ),
            ),
            subject,
            probePathOf(joinedGlob, ""),
            sameAs,
          );
        }
      }
    }

    const childEntries = Object.entries(node.children ?? {});
    // The nearest descendants — at any depth — that state their own import
    // policy. A folder's allowlist covers its whole subtree except these, and
    // each of them emits a rule over its own subtree in turn. Descent stops at a
    // node that overrides, because everything below it is that node's business.
    const overridingDescendants = (
      from: ManifestNode,
      atPath: string,
      atCaptures: CaptureIndex,
      atGroup: number,
    ): ReadonlyArray<string> =>
      Object.entries(from.children ?? {}).flatMap(([childKey, child]) =>
        alternativesOf(childKey).flatMap((one) => {
          // `declaring` because a folder key may itself name a capture
          // (`{subdomain}/`). The extra group is harmless in an exclusion, which
          // is matched on its own rather than substituted into.
          const childCompiled = globToRegexSource(one, atCaptures, {
            declaring: true,
            nextGroup: atGroup,
          });
          const source = `${atPath}/${childCompiled.source}`;
          const childGroup =
            atGroup + (Object.keys(childCompiled.captures).length - Object.keys(atCaptures).length);
          if (child.imports !== undefined) {
            return [isFolderKey(childKey) ? prefixed(`${source}/`) : anchored(source)];
          }
          return isFolderKey(childKey)
            ? overridingDescendants(child, source, childCompiled.captures, childGroup)
            : [];
        }),
      );

    const overridingChildren = overridingDescendants(
      node,
      pathSource,
      compiled.captures,
      nextGroup,
    );

    if (isFolder) {
      const childKeys = childEntries;
      const fileKeys = childKeys.filter(([childKey]) => !isFolderKey(childKey));
      if (node.partial !== true) {
        const ruleName = `${name}/layout`;
        // An open folder still CLAIMS its folder — otherwise no rule governs
        // it and the taxonomy root fires — it just admits any file name.
        const admitted =
          node.layout === "open"
            ? [ANY_FILE]
            : fileKeys.flatMap(([childKey]) =>
                alternativesOf(childKey).map((one) =>
                  anchored(
                    globToRegexSource(one, compiled.captures, { declaring: false, nextGroup })
                      .source,
                  ),
                ),
              );
        const folderProbe = probePathOf(joinedGlob, "");
        const stray =
          node.layout === "open"
            ? `zzprobe-stray${extensionFor(folderProbe)}`
            : strayBasenameFor(admitted, extensionFor(folderProbe), ruleName);
        folders.push({
          name: ruleName,
          message: node.message ?? "This folder does not admit that file.",
          probe: { path: probePathOf(joinedGlob, stray) },
          folder: selfPattern,
          files: admitted,
        });
      }
      const siblingKeys = childKeys.map(([childKey]) => childKey);
      for (const [childKey, child] of childKeys) {
        walk(childKey, child, frame, `${name}/${alternativesOf(childKey)[0] ?? ""}`, siblingKeys, [
          ...nodePath,
          "children",
          childKey,
        ]);
      }
    }

    // Outbound. One allowlist stands in for every "may not reach X" rule that
    // would otherwise be written separately and far from here.
    //
    // Import policy belongs to a folder, so it lowers once per folder — matching
    // that folder's direct children — rather than once per file kind inside it.
    // A file node emits its own only when it says something its folder did not.
    const emitsOwnImports = isFolder ? node.imports !== undefined : node.imports !== undefined;
    const scope = isFolder ? prefixed(`${pathSource}/`) : selfPattern;
    const scopeProbe = isFolder ? probeIn(joinedGlob, "zzprobe") : probePathOf(joinedGlob, "");
    // The folder a probe of this node sits in, for "a file of the same language".
    const ownFolder = isFolder
      ? probePathOf(joinedGlob, "")
      : probePathOf(joinedGlob, "").replace(/\/[^/]*$/, "");

    const allow = frame.allowances.flatMap((one) =>
      one.pattern === undefined ? [] : [one.pattern],
    );
    const externals = frame.allowances
      .filter((one) => one.kind === "external")
      .map((one) => one.entry);
    const admitsEverything = allow.some((pattern) => pattern === "^.*" || pattern === "^");
    const hasAllowlist = frame.allowances.length > 0 && !admitsEverything;

    if (emitsOwnImports && node.imports?.unrestricted !== true && !hasAllowlist) {
      throw new Error(
        `"${name}" states an \`imports\` policy with no allowlist. If that is deliberate — the ` +
          `tier is not tightened yet and only its prohibitions apply — say \`unrestricted: true\`, ` +
          `so the gap is a sentence someone wrote rather than an omission nobody noticed.`,
      );
    }

    if (emitsOwnImports) {
      const exemptions = overridingChildren.length > 0 ? { fromNot: overridingChildren } : {};

      if (hasAllowlist) {
        imports.push({
          name: `${name}/imports`,
          message: frame.importsMessage,
          probe: { from: scopeProbe, to: probeOutside("nowhere", ownFolder) },
          from: scope,
          ...exemptions,
          toNot: allow,
          ...(externals.length > 0 ? { externals } : {}),
          allowances: frame.allowances,
        });
      }
    }

    // Prohibitions are emitted once, over this node's whole subtree, and carry no
    // exemptions: a node cannot opt out of an ancestor's prohibition.
    for (const [index, denial] of ownDenials.entries()) {
      imports.push({
        name: `${name}/deny-${String(index)}`,
        message: denial.message,
        probe: { from: scopeProbe, to: denial.probe },
        from: isFolder ? prefixed(`${pathSource}/`) : selfPattern,
        ...(denial.except.length > 0 ? { fromNot: [...denial.except] } : {}),
        to: denial.match,
        ...(denial.matchNot.length > 0 ? { toNot: [...denial.matchNot] } : {}),
      });
    }

    // Inbound. "This file is private to X" belongs beside the file, not in a
    // distant rule whose `from` side grows an exclusion for every new caller.
    if (node.importedBy !== undefined) {
      // An `importedBy` allowlist is matched against the IMPORTER, while the
      // captures on this node were declared by the TARGET's path — so a
      // `{capture}` here has nothing to resolve against and would compile to a
      // pattern that never matches, silently over-reporting. Refuse it rather
      // than emit a rule whose exemptions do not work.
      for (const allowed of globsOf(node.importedBy.allow)) {
        const referenced = allowed.match(/\{[a-zA-Z][a-zA-Z0-9]*\}/g) ?? [];
        if (referenced.length > 0) {
          throw new Error(
            `"${name}" allows ${referenced.join(", ")} in importedBy, but a capture from this ` +
              `node's own path cannot be used there: importedBy patterns are matched against the ` +
              `importing file, and ${referenced[0] ?? ""} was declared by this file's path. Use a ` +
              `wildcard (the barrel rules are what stop another module reaching in), or move the ` +
              `restriction to that importer's own node as an \`imports\` allowlist.`,
          );
        }
      }
      const asTarget = (glob: string) =>
        prefixed(
          globToRegexSource(expandAliases(glob, aliases), compiled.captures, {
            declaring: false,
            nextGroup,
          }).source,
        );
      // On a folder the restriction covers the whole subtree — "a module is
      // private" is a statement about everything under it, not about the folder
      // node itself.
      const exempt = globsOf(node.importedBy.matchNot ?? []).map((glob) =>
        anchored(
          `${pathSource}/${globToRegexSource(glob, compiled.captures, { declaring: false, nextGroup }).source}`,
        ),
      );
      imports.push({
        name: `${name}/imported-by`,
        message: node.importedBy.message,
        probe: { from: probeOutside("outsider", ownFolder), to: scopeProbe },
        from: EVERY_FILE,
        fromNot: globsOf(node.importedBy.allow).map(asTarget),
        to: isFolder ? prefixed(`${pathSource}/`) : selfPattern,
        ...(exempt.length > 0 ? { toNot: exempt } : {}),
      });
    }

    for (const [index, spec] of (node.members ?? []).entries()) {
      const asRegex = (globs: string | ReadonlyArray<string>) =>
        globsOf(globs).map((one) =>
          anchored(
            globToRegexSource(one, compiled.captures, { declaring: false, nextGroup }).source,
          ),
        );
      members.push({
        name: `${name}/members-${String(index)}`,
        message: spec.message,
        // An authored probe replaces the synthetic site: the name is the one
        // the author says the snippet declares, and the declaration is the
        // parser's to find.
        probe:
          spec.probe === undefined
            ? {
                from: scopeProbe,
                name: probeMemberName(spec.match),
                ...(spec.in === undefined ? {} : { in: "ZzProbeRepositoryShape" }),
                ...(spec.declares?.[0] === undefined ? {} : { declares: spec.declares[0] }),
              }
            : { from: scopeProbe, name: spec.probe.name, source: spec.probe.source },
        // On a folder the rule covers the subtree, as `imports` does — a
        // vocabulary is a statement about every file in a tier. Selecting the
        // folder's own path instead governed no file, and the probe, a folder
        // path, passed regardless.
        from: scope,
        subject: spec.subject,
        ...(spec.in === undefined ? {} : { in: asRegex(spec.in) }),
        ...(spec.declares === undefined ? {} : { declares: [...spec.declares] }),
        ...(spec.match === undefined ? {} : { match: asRegex(spec.match) }),
        ...(spec.matchNot === undefined ? {} : { matchNot: asRegex(spec.matchNot) }),
        ...(spec.allow === undefined ? {} : { allow: asRegex(spec.allow) }),
      });
    }

    for (const [index, spec] of (node.surface ?? []).entries()) {
      const ruleName = `${name}/surface-${String(index)}`;
      const asName = (globs: string | ReadonlyArray<string>) =>
        globsOf(globs).map((one) =>
          anchored(
            globToRegexSource(one, compiled.captures, { declaring: false, nextGroup }).source,
          ),
        );
      const asPath = (glob: string) =>
        prefixed(
          globToRegexSource(expandAliases(glob, aliases), compiled.captures, {
            declaring: false,
            nextGroup,
          }).source,
        );

      const demands = [spec.allow, spec.convention, spec.count].filter(
        (one) => one !== undefined,
      ).length;
      if (demands > 1) {
        throw new Error(
          `surface rule "${ruleName}" states more than one of allow, convention and count. ` +
            `A rule makes one demand; write one entry per demand.`,
        );
      }

      const kind = spec.kinds?.[0] ?? "named";
      const conventionSource =
        spec.convention === undefined
          ? undefined
          : typeof spec.convention === "string"
            ? CONVENTIONS[spec.convention]?.source
            : spec.convention.regex;

      // The synthetic probe: one site the rule must reject, or for `count`, a
      // surface of the wrong size. A count nothing can violate — no minimum, no
      // maximum — is a rule that never reports, and is refused here.
      const siteName =
        kind === "default"
          ? "default"
          : kind === "namespace"
            ? "*"
            : spec.convention !== undefined
              ? violatingSampleFor(spec.convention, ruleName)
              : probeMemberName(spec.match);
      const oneSite = {
        name: siteName,
        kind,
        ...(spec.declares?.[0] === undefined ? {} : { declares: spec.declares[0] }),
        ...(spec.reexport === undefined ? {} : { reexport: spec.reexport }),
      };
      const probeSites = (): ReadonlyArray<typeof oneSite> => {
        if (spec.count === undefined) return [oneSite];
        const min = spec.count.min ?? 0;
        if (min > 0) return [];
        if (spec.count.max === undefined) {
          throw new Error(
            `surface rule "${ruleName}" states a count with no minimum and no maximum, ` +
              `which nothing can violate.`,
          );
        }
        return Array.from({ length: spec.count.max + 1 }, (_, i) => ({
          ...oneSite,
          name: `${siteName}${String(i)}`,
        }));
      };

      surface.push({
        name: ruleName,
        message: spec.message,
        probe:
          spec.probe === undefined
            ? { from: scopeProbe, sites: probeSites() }
            : { from: scopeProbe, source: spec.probe.source },
        from: scope,
        ...(spec.except === undefined ? {} : { fromNot: globsOf(spec.except).map(asPath) }),
        ...(spec.kinds === undefined ? {} : { kinds: [...spec.kinds] }),
        ...(spec.declares === undefined ? {} : { declares: [...spec.declares] }),
        ...(spec.reexport === undefined ? {} : { reexport: spec.reexport }),
        ...(spec.match === undefined ? {} : { match: asName(spec.match) }),
        ...(spec.matchNot === undefined ? {} : { matchNot: asName(spec.matchNot) }),
        ...(spec.forbid === undefined ? {} : { forbid: spec.forbid }),
        ...(spec.allow === undefined ? {} : { allow: asName(spec.allow) }),
        ...(conventionSource === undefined ? {} : { convention: conventionSource }),
        ...(spec.count === undefined ? {} : { count: spec.count }),
      });
    }

    if (node.requires !== undefined && node.requires.length > 0) {
      const exempt = (node.requiresNot ?? []).map(
        (basename) =>
          `/${globToRegexSource(basename, compiled.captures, { declaring: false, nextGroup }).source}$`,
      );
      parity.push({
        name: `${name}/requires`,
        message: node.message ?? "This file needs its sibling.",
        probe: { path: probePathOf(joinedGlob, "") },
        file: selfPattern,
        ...(exempt.length > 0 ? { fileNot: exempt } : {}),
        requires: [...node.requires],
      });
    }
  };

  const emptyFrame: Frame = {
    pathSource: "",
    pathGlob: "",
    captures: {},
    nextGroup: 1,
    allowances: [],
    importsMessage: "This import is not on this folder's allowlist.",
    naming: undefined,
  };

  // Repo-wide prohibitions: `from` is every file, so no tier can be written
  // that escapes them.
  const globalFrame: Frame = { ...emptyFrame };
  for (const [index, denial] of mergeImports(
    globalFrame,
    { unrestricted: true, deny: manifest.deny ?? [] },
    aliases,
    {},
    1,
    "repo",
    () => undefined,
  ).deny.entries()) {
    imports.push({
      name: `repo/deny-${String(index)}`,
      message: denial.message,
      probe: { from: probeOutside("anywhere"), to: denial.probe },
      from: EVERY_FILE,
      ...(denial.except.length > 0 ? { fromNot: [...denial.except] } : {}),
      to: denial.match,
      ...(denial.matchNot.length > 0 ? { toNot: [...denial.matchNot] } : {}),
    });
  }

  for (const [key, node] of Object.entries(manifest.tree)) {
    // A taxonomy root is a region whose folders are enumerated. A key naming a
    // single file has no folders to deny, and an open tree governs every folder
    // it contains — neither has anything for a root to catch.
    if ((isFolderKey(key) || node.children !== undefined) && node.layout !== "open")
      roots.push({
        name: `${stripSlash(key)}/taxonomy`,
        message:
          node.message ??
          "This folder is not part of the taxonomy. Declare it in the manifest deliberately, or move the file into the folder that owns it.",
        probe: { path: probeIn(`${expandAliases(stripSlash(key), aliases)}/zzprobe`, "stray") },
        path: prefixed(
          globToRegexSource(
            expandAliases(stripSlash(key), aliases),
            {},
            {
              declaring: true,
              nextGroup: 1,
            },
          ).source,
        ),
      });
    walk(
      key,
      node,
      emptyFrame,
      stripSlash(key)
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      Object.keys(manifest.tree),
      ["tree", key],
    );
  }

  for (const rule of manifest.exports ?? []) {
    const asPattern = (glob: string) =>
      prefixed(
        globToRegexSource(expandAliases(glob, aliases), {}, { declaring: false, nextGroup: 1 })
          .source,
      );
    // The synthetic probe is a binding of the rule's first kind. A default
    // binding is only ever named `default` and a namespace one `*`, so a rule
    // that lists `symbols` alongside those kinds cannot cover its probe — and
    // is refused at load, which is right: it could never fire on such a form.
    const kind = rule.kinds?.[0] ?? "named";
    const symbol =
      rule.probe?.symbol ??
      (kind === "namespace" ? "*" : kind === "default" ? "default" : rule.symbols?.[0]) ??
      "zzProbeSymbol";
    exports.push({
      name: rule.name,
      message: rule.message,
      probe: {
        from: probeOutside("anywhere"),
        to: probePathOf(expandAliases(globsOf(rule.module)[0] ?? "", aliases), ""),
        symbol,
        kind,
        ...(rule.probe === undefined ? {} : { source: rule.probe.source }),
      },
      from: EVERY_FILE,
      ...(rule.except === undefined ? {} : { fromNot: globsOf(rule.except).map(asPattern) }),
      to: globsOf(rule.module).map(asPattern),
      ...(rule.symbols === undefined ? {} : { symbols: [...rule.symbols] }),
      ...(rule.kinds === undefined ? {} : { kinds: [...rule.kinds] }),
      ...(rule.fix === undefined ? {} : { fix: rule.fix }),
    });
  }

  // Graph rules pass through with their globs resolved, and a probe built from
  // the shape each is about: two files importing each other, a file nothing
  // imports, a direct edge from `from` to `to` that touches no `via`.
  const asGraphPattern = (glob: string) =>
    prefixed(
      globToRegexSource(expandAliases(glob, aliases), {}, { declaring: false, nextGroup: 1 })
        .source,
    );
  const asGraphPatterns = (globs: string | ReadonlyArray<string> | undefined) =>
    globs === undefined ? undefined : globsOf(globs).map(asGraphPattern);
  // A synthetic file inside a graph scope. A glob whose last segment names a
  // file shape (`src/**/*.<ext>`) is filled in place and keeps its extension; a
  // folder glob (`src/**`) gets a file of its language's added beneath it.
  const probeFileIn = (globs: string | ReadonlyArray<string>, stem: string): string => {
    const glob = expandAliases(globsOf(globs)[0] ?? "", aliases);
    const at = glob.lastIndexOf("/");
    const last = glob.slice(at + 1);
    if (!last.includes(".")) return probeIn(glob, stem);
    return probePathOf(
      at === -1 ? "" : glob.slice(0, at),
      last.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}|\*+/g, stem),
    );
  };
  const graph: GraphConfig = {
    cycles: (manifest.graph?.cycles ?? []).map((rule) => {
      const a = probeFileIn(rule.within, "zz-alpha");
      const b = probeFileIn(rule.within, "zz-beta");
      return {
        name: rule.name,
        message: rule.message,
        probe: {
          edges: [
            [a, b],
            [b, a],
          ],
        },
        within: globsOf(rule.within).map(asGraphPattern),
        ...(rule.withinNot === undefined
          ? {}
          : { withinNot: asGraphPatterns(rule.withinNot) ?? [] }),
      };
    }),
    orphans: (manifest.graph?.orphans ?? []).map((rule) => ({
      name: rule.name,
      message: rule.message,
      probe: { edges: [], files: [probeFileIn(rule.within, "zz-orphan")] },
      within: globsOf(rule.within).map(asGraphPattern),
      ...(rule.withinNot === undefined ? {} : { withinNot: asGraphPatterns(rule.withinNot) ?? [] }),
      entry: globsOf(rule.entry).map(asGraphPattern),
    })),
    reach: (manifest.graph?.reach ?? []).map((rule) => ({
      name: rule.name,
      message: rule.message,
      probe: {
        edges: [[probeFileIn(rule.from, "zz-origin"), probeFileIn(rule.to, "zz-target")]],
      },
      from: globsOf(rule.from).map(asGraphPattern),
      ...(rule.fromNot === undefined ? {} : { fromNot: asGraphPatterns(rule.fromNot) ?? [] }),
      to: globsOf(rule.to).map(asGraphPattern),
      ...(rule.toNot === undefined ? {} : { toNot: asGraphPatterns(rule.toNot) ?? [] }),
      ...(rule.via === undefined ? {} : { via: asGraphPatterns(rule.via) ?? [] }),
    })),
  };

  const campaigns = Object.entries(manifest.campaigns ?? {}).map(([id, campaign]) =>
    lowerCampaign(id, campaign, aliases, manifest.resolve, languages),
  );

  return {
    imports,
    exports,
    members,
    surface,
    graph,
    campaigns,
    adoption: { unrestricted: unrestrictedNodes, partial: partialNodes },
    structure: { roots, folders, parity, naming: namingRules },
  };
};

// The keys of a `syntax` term that belong to the engine's rule; `where` is
// the one that does not.
const SYNTAX_RULE_KEYS = [
  "pattern",
  "kind",
  "regex",
  "nthChild",
  "inside",
  "has",
  "precedes",
  "follows",
  "all",
  "any",
  "not",
] as const;

const syntaxRuleOf = (term: SyntaxTermSpec): unknown =>
  Object.fromEntries(
    SYNTAX_RULE_KEYS.flatMap((key) => (term[key] === undefined ? [] : [[key, term[key]]])),
  );

// The leaf terms a path alone cannot exercise: each reads the file's text,
// its syntax, or its facts, so a probe for a detector holding one must carry
// a `source`.
const TERMS_NEEDING_SOURCE = ["content", "syntax", "exports", "members", "fn"] as const;

const leafTermsOf = (detector: DetectorSpec): ReadonlyArray<string> => {
  if ("all" in detector) return detector.all.flatMap(leafTermsOf);
  if ("any" in detector) return detector.any.flatMap(leafTermsOf);
  if ("not" in detector) return leafTermsOf(detector.not);
  return Object.keys(detector);
};

// The families an `endState` tree can expand into — one synthetic objective
// per family the lowered tree actually produces rules for.
const END_STATE_FAMILIES = ["imports", "exports", "members", "surface", "structure"] as const;
type EndStateFamily = (typeof END_STATE_FAMILIES)[number];

// The id a family's synthetic objective carries, `end-state-<family>`, and
// its ledger file's name.
export const endStateObjectiveId = (family: EndStateFamily): string => `end-state-${family}`;

// The abstract root an `endState` is compiled and probed at, once, before
// any sector exists to lower it for.
export const END_STATE_ROOT = "~";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A sector-relative tree lowered for one sector: every `~/` becomes the
// sector's root, and an allow entry `{ sector, via }` — another sector,
// through its port — becomes that sector's `via` path for each sector the
// name selects. The result is an ordinary manifest fragment, lowered by the
// same pass as the repository's own tree.
export const lowerEndState = (
  tree: Readonly<Record<string, unknown>>,
  root: string,
  sectors: ReadonlyArray<{ readonly name: string; readonly root: string }>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
  aliases: Readonly<Record<string, string>> = {},
): LoweredRules => {
  const rebase = (glob: string): string =>
    glob === "~" || glob === "~/"
      ? `${root}/`
      : glob.startsWith("~/")
        ? `${root}/${glob.slice(2)}`
        : glob;
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) {
      return value.flatMap((item: unknown) => {
        if (key === "allow" && isRecord(item) && typeof item.via === "string") {
          const named = item.sector;
          const via = item.via.startsWith("~/") ? item.via.slice(2) : String(item.via);
          return sectors
            .filter((one) => named === "*" || named === undefined || one.name === named)
            .filter((one) => one.root !== root)
            .map((one) => `${one.root}/${via}`);
        }
        return [walk(item, key)];
      });
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          key === "children" || key === "" ? rebaseKey(childKey) : childKey,
          walk(child, childKey),
        ]),
      );
    }
    return typeof value === "string" ? rebase(value) : value;
  };
  const rebaseKey = (key: string): string => (key === "~/" ? `${root}/` : key);
  const rebased = decodeManifestTree(walk(tree, ""));
  if (Result.isFailure(rebased)) {
    throw new Error(`the endState does not decode as a tree:\n${rebased.failure}`);
  }
  const manifest: Manifest = { resolve, aliases, tree: rebased.success };
  return lowerManifest(manifest, languages, {});
};

// Which families a tree yields at all, decided once at the abstract root.
const endStateFamiliesOf = (
  tree: Readonly<Record<string, unknown>>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
): ReadonlyArray<EndStateFamily> => {
  const lowered = lowerEndState(tree, END_STATE_ROOT, [], resolve, languages);
  const structure =
    lowered.structure.roots.length +
    lowered.structure.folders.length +
    lowered.structure.parity.length +
    lowered.structure.naming.length;
  return END_STATE_FAMILIES.filter((family) =>
    family === "structure" ? structure > 0 : lowered[family].length > 0,
  );
};

// A stable digest of a phase's definition — its position, its objectives
// and their detectors — so a change to a defined phase is visible against
// what the plan file recorded. FNV-1a over the canonical JSON.
const digest = (value: unknown): string => {
  const canonical = (one: unknown): unknown =>
    Array.isArray(one)
      ? one.map(canonical)
      : isRecord(one)
        ? Object.fromEntries(
            Object.keys(one)
              .sort()
              .map((key) => [key, canonical(one[key])]),
          )
        : one;
  const text = JSON.stringify(canonical(value));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

// A campaign lowered: its globs resolved — `scope`, `legacy`, a perimeter's
// glob or marker, and inside each objective a path-shaped `resolves` the way
// graph rules resolve theirs, `exports`/`members` names the way `surface`
// and `members` rules do, the rest carried as written — its phases checked
// for the shapes the design refuses, and an `endState` expanded into one
// synthetic objective per family. The `fn` string is kept verbatim for the
// loader, which holds the function it names.
const lowerCampaign = (
  id: string,
  campaign: CampaignSpec,
  aliases: Readonly<Record<string, string>>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
): CampaignRule => {
  const asPath = (glob: string): string =>
    prefixed(
      globToRegexSource(expandAliases(glob, aliases), {}, { declaring: false, nextGroup: 1 })
        .source,
    );
  const asName = (globs: string | ReadonlyArray<string>): ReadonlyArray<string> =>
    globsOf(globs).map((one) =>
      anchored(globToRegexSource(one, {}, { declaring: false, nextGroup: 1 }).source),
    );
  const asWhole = (globs: string | ReadonlyArray<string>): ReadonlyArray<string> =>
    globsOf(globs).map((one) =>
      anchored(
        globToRegexSource(expandAliases(one, aliases), {}, { declaring: false, nextGroup: 1 })
          .source,
      ),
    );
  const refuse = (detail: string): never => {
    throw new Error(`campaign "${id}" ${detail}`);
  };

  const lower = (detector: DetectorSpec, objective: string): Detector => {
    if ("all" in detector) return { all: detector.all.map((one) => lower(one, objective)) };
    if ("any" in detector) return { any: detector.any.map((one) => lower(one, objective)) };
    if ("not" in detector) return { not: lower(detector.not, objective) };
    if ("path" in detector) {
      const { convention, ...rest } = detector.path;
      const conventionSource =
        convention === undefined
          ? undefined
          : typeof convention === "string"
            ? CONVENTIONS[convention]?.source
            : convention.regex;
      if (convention !== undefined && conventionSource === undefined) {
        refuse(`(${objective}) names an unknown convention "${String(convention)}".`);
      }
      if (conventionSource !== undefined && rest.subject === undefined) {
        refuse(
          `(${objective}) states a path convention with no \`subject\`: say which ` +
            `capture group of \`file\` holds the name the convention is about.`,
        );
      }
      return {
        path: {
          file: globsOf(rest.file),
          ...(rest.fileNot === undefined ? {} : { fileNot: globsOf(rest.fileNot) }),
          ...(rest.subject === undefined ? {} : { subject: rest.subject }),
          ...(conventionSource === undefined ? {} : { convention: conventionSource }),
        },
      };
    }
    if ("imports" in detector) {
      const { resolves, symbols } = detector.imports;
      return {
        imports: {
          resolves: typeof resolves === "string" ? asPath(resolves) : resolves,
          ...(symbols === undefined ? {} : { symbols: [...symbols] }),
        },
      };
    }
    if ("exports" in detector) {
      const term = detector.exports;
      return {
        exports: {
          ...(term.name === undefined ? {} : { name: asName(term.name) }),
          ...(term.kinds === undefined ? {} : { kinds: [...term.kinds] }),
          ...(term.declares === undefined ? {} : { declares: [...term.declares] }),
          ...(term.reexport === undefined ? {} : { reexport: term.reexport }),
        },
      };
    }
    if ("members" in detector) {
      const term = detector.members;
      return {
        members: {
          subject: term.subject,
          ...(term.name === undefined ? {} : { name: asName(term.name) }),
          ...(term.in === undefined ? {} : { in: asName(term.in) }),
          ...(term.declares === undefined ? {} : { declares: [...term.declares] }),
        },
      };
    }
    if ("requires" in detector) return { requires: [...detector.requires] };
    if ("content" in detector) return { content: { regex: detector.content.regex } };
    if ("report" in detector) {
      // Exactly one of `command` and `file`, and a pattern for `regex`: the
      // manifest schema refused anything else at decode.
      const term = detector.report;
      return {
        report: {
          ...(term.command === undefined ? {} : { command: globsOf(term.command) }),
          ...(term.file === undefined ? {} : { file: globsOf(term.file) }),
          format: term.format,
          ...(term.pattern === undefined ? {} : { pattern: term.pattern }),
          ...(term.codes === undefined ? {} : { codes: [...term.codes] }),
          ...(term.codesNot === undefined ? {} : { codesNot: [...term.codesNot] }),
        },
      };
    }
    if ("syntax" in detector) {
      const { where } = detector.syntax;
      const narrowed =
        where === undefined
          ? {}
          : {
              where: Object.fromEntries(
                Object.entries(where).map(([capture, narrowing]) => [
                  capture,
                  {
                    ...(narrowing.regex === undefined ? {} : { regex: narrowing.regex }),
                    ...(narrowing.binding === undefined
                      ? {}
                      : {
                          binding: {
                            resolves:
                              typeof narrowing.binding.resolves === "string"
                                ? asPath(narrowing.binding.resolves)
                                : narrowing.binding.resolves,
                            ...(narrowing.binding.member === undefined
                              ? {}
                              : { member: [...narrowing.binding.member] }),
                          },
                        }),
                  },
                ]),
              ),
            };
      return { syntax: { rule: syntaxRuleOf(detector.syntax), ...narrowed } };
    }
    return { fn: detector.fn };
  };

  // A probe without a source proves only the path; a detector that reads
  // the file needs the file. Refused here, with the term named, rather than
  // at load as a probe that mysteriously never fires.
  const checkProbes = (
    what: string,
    detector: DetectorSpec,
    probes: CampaignProbesSpec | undefined,
  ): { fires: ReadonlyArray<CampaignProbe>; ignores: ReadonlyArray<CampaignProbe> } => {
    const leaves = leafTermsOf(detector);
    const needsSource = TERMS_NEEDING_SOURCE.filter((term) => leaves.includes(term));
    const all = [...(probes?.fires ?? []), ...(probes?.ignores ?? [])];
    const sourceless = all.find((probe) => probe.source === undefined);
    if (needsSource.length > 0 && sourceless !== undefined) {
      refuse(
        `(${what}) has a probe (${sourceless.path}) with no \`source\`, and its ` +
          `detector holds a ${needsSource.map((term) => `\`${term}\``).join(", ")} term, which ` +
          `a path alone cannot exercise. Give every probe a source.`,
      );
    }
    return { fires: [...(probes?.fires ?? [])], ignores: [...(probes?.ignores ?? [])] };
  };

  const scopeSpec = campaign.scope ?? "**";
  const scopeGlobs =
    typeof scopeSpec === "string" || Array.isArray(scopeSpec)
      ? globsOf(scopeSpec as string | ReadonlyArray<string>)
      : globsOf((scopeSpec as { readonly path: string | ReadonlyArray<string> }).path);
  const extensions =
    typeof scopeSpec === "string" || Array.isArray(scopeSpec)
      ? []
      : [...((scopeSpec as { readonly extensions?: ReadonlyArray<string> }).extensions ?? [])];

  const objectives: Array<ObjectiveRule> = Object.entries(campaign.objectives).map(
    ([objectiveId, spec]) => {
      const name = `campaign/${id}/${objectiveId}`;
      const message = spec.how ?? campaign.how ?? `${objectiveId} (${id})`;
      const why = spec.why ?? campaign.why;
      const base = {
        name,
        id: objectiveId,
        campaign: id,
        message,
        ...(why === undefined ? {} : { why }),
        holdout: spec.holdout,
        ...(spec.until === undefined ? {} : { until: spec.until }),
      };
      if (spec.match !== undefined) {
        return {
          ...base,
          match: lower(spec.match, objectiveId),
          probes: checkProbes(objectiveId, spec.match, spec.probes),
        };
      }
      const term = spec.sector ?? refuse(`(${objectiveId}) has neither \`match\` nor \`sector\`.`);
      const sector: SectorTerm =
        "has" in term
          ? { has: lower(term.has, objectiveId) }
          : "oneRoot" in term
            ? { oneRoot: true }
            : { oneHost: globsOf(term.oneHost).map(asPath) };
      return {
        ...base,
        sector,
        probes:
          "has" in term
            ? checkProbes(objectiveId, term.has, spec.probes)
            : { fires: [...(spec.probes?.fires ?? [])], ignores: [...(spec.probes?.ignores ?? [])] },
      };
    },
  );

  // The perimeter, its globs resolved. A `match` perimeter is proven like
  // an objective; the loader adds the end-shape check, which needs the
  // objectives evaluated on the probe.
  const perimeterSpec = campaign.perimeter;
  const perimeter: PerimeterRule | undefined =
    perimeterSpec === undefined
      ? undefined
      : perimeterSpec === "file"
        ? { kind: "file" }
        : perimeterSpec === "nx"
          ? { kind: "nx" }
          : "glob" in perimeterSpec
            ? { kind: "glob", glob: globsOf(perimeterSpec.glob).map(asPath) }
            : "marker" in perimeterSpec
              ? {
                  kind: "marker",
                  marker: asWhole(perimeterSpec.marker),
                  ...(perimeterSpec.probes === undefined
                    ? {}
                    : {
                        probes: {
                          fires: globsOf(perimeterSpec.probes.fires ?? []),
                          ignores: globsOf(perimeterSpec.probes.ignores ?? []),
                        },
                      }),
                }
              : {
                  kind: "match",
                  match: lower(perimeterSpec.match, "perimeter"),
                  unit: perimeterSpec.holdout ?? "declaration",
                  probes: checkProbes("perimeter", perimeterSpec.match, perimeterSpec.probes),
                };
  if (perimeter?.kind === "match" && perimeter.probes.fires.length === 0) {
    refuse(
      `has a \`match\` perimeter with no \`probes.fires\`. A perimeter is the sector's identity ` +
        `across every phase, so it is proven on a sector in its end shape as well as its first.`,
    );
  }

  // The phases. An `endState` written on the campaign belongs to the last
  // phase; a campaign with none and an end state gets one phase, `end`.
  const phaseSpecs: Array<PhaseSpec> = [...(campaign.phases ?? [])];
  if (campaign.endState !== undefined) {
    const last = phaseSpecs.at(-1);
    if (last === undefined) phaseSpecs.push({ id: "end", endState: campaign.endState });
    else if (last.endState !== undefined) {
      refuse(`writes an \`endState\` on the campaign and on its last phase; write one.`);
    } else phaseSpecs[phaseSpecs.length - 1] = { ...last, endState: campaign.endState };
  }
  const objectiveIds = new Set(objectives.map((one) => one.id));
  const namedBy = new Map<string, string>();
  const phases: Array<PhaseRule> = [];
  phaseSpecs.forEach((phase, index) => {
    if (phases.some((one) => one.id === phase.id)) {
      refuse(`names the phase "${phase.id}" twice.`);
    }
    for (const objectiveId of phase.objectives ?? []) {
      if (!objectiveIds.has(objectiveId)) {
        refuse(`phase "${phase.id}" names an objective "${objectiveId}" the campaign does not declare.`);
      }
      const already = namedBy.get(objectiveId);
      if (already !== undefined) {
        refuse(
          `names the objective "${objectiveId}" in two phases ("${already}" and "${phase.id}"); ` +
            `an objective belongs to at most one.`,
        );
      }
      namedBy.set(objectiveId, phase.id);
    }
    const expanded: Array<string> = [...(phase.objectives ?? [])];
    if (phase.endState !== undefined) {
      const families = endStateFamiliesOf(phase.endState, resolve, languages);
      if (families.length === 0) {
        refuse(`phase "${phase.id}" carries an \`endState\` that lowers to no rule at all.`);
      }
      for (const family of families) {
        const objectiveId = endStateObjectiveId(family);
        if (objectiveIds.has(objectiveId)) {
          refuse(`declares an objective "${objectiveId}", which its endState needs for itself.`);
        }
        objectiveIds.add(objectiveId);
        namedBy.set(objectiveId, phase.id);
        expanded.push(objectiveId);
        objectives.push({
          name: `campaign/${id}/${objectiveId}`,
          id: objectiveId,
          campaign: id,
          message:
            campaign.how ??
            `The sector's end state, as phase "${phase.id}" writes it: a ${family} violation against the sector-relative tree.`,
          holdout: "declaration",
          endState: { phase: phase.id, family },
          probes: { fires: [], ignores: [] },
        });
      }
    }
    const defined = expanded.length > 0 || phase.attested === true;
    if (!defined && phase.intent === undefined) {
      refuse(
        `phase "${phase.id}" names no objective and states no \`intent\`. An open phase is a ` +
          `stated intent; a defined one names at least one objective (or is attested).`,
      );
    }
    if (!defined && index !== phaseSpecs.length - 1) {
      refuse(
        `phase "${phase.id}" is open (it names no objective) and is not last. A plan that has ` +
          `not been written cannot sit in the middle of one that has.`,
      );
    }
    phases.push({
      id: phase.id,
      ...(phase.intent === undefined ? {} : { intent: phase.intent }),
      objectives: expanded,
      attested: phase.attested === true,
      ...(phase.onTouch === undefined ? {} : { onTouch: phase.onTouch }),
      ...(phase.endState === undefined ? {} : { endState: phase.endState }),
      concessions: [...(phase.concessions ?? [])],
      hash: "",
    });
  });
  // A window: from the phase that names the objective until the phase
  // `until` names, exclusive. Refused when `until` names no phase, or one
  // at or before the naming phase — the two ways a remove or a reorder
  // leaves a window empty.
  for (const objective of objectives) {
    if (objective.until === undefined) continue;
    const to = phases.findIndex((one) => one.id === objective.until);
    if (to === -1) {
      refuse(
        `objective "${objective.id}" runs \`until: ${objective.until}\`, and no phase has that id.`,
      );
    }
    const from = phases.findIndex((one) => one.id === namedBy.get(objective.id));
    if (from !== -1 && to <= from) {
      refuse(
        `objective "${objective.id}" is named by phase "${phases[from]?.id ?? ""}" and runs ` +
          `\`until: ${objective.until}\`, which is not after it; the window is empty.`,
      );
    }
  }
  const hashed = phases.map((phase, index) => ({
    ...phase,
    hash: digest({
      index,
      id: phase.id,
      attested: phase.attested,
      endState: phase.endState ?? null,
      objectives: phase.objectives.map((objectiveId) => {
        const objective = objectives.find((one) => one.id === objectiveId);
        return {
          id: objectiveId,
          holdout: objective?.holdout,
          match: objective?.match ?? null,
          sector: objective?.sector ?? null,
          until: objective?.until ?? null,
        };
      }),
    }),
  }));
  // The end is the last phase, so a change to it is a change to that
  // phase's hash already; a campaign with no phases has an end that is
  // every objective, digested as a phase of its own would be.
  if (perimeter?.kind === "marker" && hashed.some((phase) => phase.endState !== undefined)) {
    // A marker may list the globs it owns, so its sectors may have several
    // roots — and a sector-relative tree needs one. Refused at lowering,
    // where the two are in view together; `one-root` as an earlier phase's
    // objective is how a campaign gets there.
    refuse(
      `carries an \`endState\` over a \`marker\` perimeter. A marker may list the globs it owns, ` +
        `so a sector may have several roots, and a sector-relative tree needs one: use a ` +
        `\`glob\`, \`file\` or \`nx\` perimeter, or reach one root first with a \`oneRoot\` objective.`,
    );
  }

  return {
    name: `campaign/${id}`,
    id,
    ...(campaign.title === undefined ? {} : { title: campaign.title }),
    ...(campaign.why === undefined ? {} : { why: campaign.why }),
    ...(campaign.owner === undefined ? {} : { owner: campaign.owner }),
    scope: scopeGlobs.map(asPath),
    extensions,
    ...(campaign.legacy === undefined ? {} : { legacy: globsOf(campaign.legacy).map(asPath) }),
    ...(perimeter === undefined ? {} : { perimeter }),
    ...(campaign.onTouch === undefined ? {} : { onTouch: campaign.onTouch }),
    phases: hashed,
    objectives,
    ...(campaign.staleAfter === undefined ? {} : { staleAfter: durationMs(campaign.staleAfter) }),
    onComplete: campaign.onComplete ?? "keep",
  };
};
