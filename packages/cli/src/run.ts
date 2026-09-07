import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  type Baseline,
  baselineOf,
  coverageOf,
  coverageShortfalls,
  decodeBaseline,
  decodeManifest,
  EMPTY_BASELINE,
  evaluateGraph,
  evaluateMemberSite,
  evaluateSelectedBindings,
  evaluateSelectedEdge,
  evaluateStructure,
  evaluateSurface,
  exportRulesSelecting,
  findManifestFile,
  fingerprintOf,
  formatManifestYaml,
  formatMessage,
  fractionsOf,
  hasGraphRules,
  listSourceFiles,
  MANIFEST_FILENAMES,
  MANIFEST_SCHEMA_ID,
  memberRulesSelecting,
  readManifestFile,
  requiredSiblingsOf,
  rulesSelecting,
  serializeBaseline,
  type SourceFacts,
  staleEntriesOf,
  surfaceRulesSelecting,
  unbaselined,
  type Violation,
} from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { type LoadedPolicy, loadPolicyFromFile } from "./config-loader.js";
import { buildGraph } from "./graph.js";
import { infer } from "./infer.js";
import { sourceFactsOf } from "./source-facts.js";

// The policy, run with no linter in the loop.
//
// oxlint's JS plugin API is alpha, and a policy that can only be evaluated by
// one alpha host is a policy with a single point of failure. This adapter is the
// second way to ask the same question — and the only way to write a baseline,
// since that needs every finding at once rather than one file at a time.
//
// It covers all four families. The two that need a syntax tree read TypeScript's
// rather than oxlint's; both adapters meet at the same vocabulary — a specifier,
// a binding, a member site — so they answer to the same core rather than to each
// other.

export type CliFailure = { readonly _tag: "CliFailure"; readonly message: string };

const fail = (message: string): CliFailure => ({ _tag: "CliFailure", message });

export type Findings = {
  readonly violations: ReadonlyArray<Violation>;
  readonly unresolved: ReadonlyArray<string>;
  readonly files: number;
};

export const collectFindings = (policy: LoadedPolicy, roots: ReadonlyArray<string>): Findings => {
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  const violations: Array<Violation> = [];
  const unresolved: Array<string> = [];

  // Each file is parsed at most once, whether the per-file families or the
  // graph pass asks first.
  const parsed = new Map<string, SourceFacts>();
  const factsOf = (file: string): SourceFacts => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const facts = sourceFactsOf(policy.repoRoot, file, policy.extractor);
    parsed.set(file, facts);
    return facts;
  };

  // The graph is the whole repository resolved at once — the one question no
  // per-file adapter can ask — and is built only when a rule needs it.
  if (hasGraphRules(policy.graph)) {
    for (const violation of evaluateGraph(
      policy.graph,
      buildGraph(files, policy.resolver, factsOf),
    )) {
      violations.push(violation);
    }
  }

  for (const file of files) {
    for (const violation of evaluateStructure(policy.structure, policy.fileSystem, file)) {
      violations.push(violation);
    }

    const selectedImports = rulesSelecting(policy.importRules, file);
    const selectedExports = exportRulesSelecting(policy.exportRules, file);
    const selectedMembers = memberRulesSelecting(policy.memberRules, file);
    const selectedSurface = surfaceRulesSelecting(policy.surfaceRules, file);
    if (
      selectedImports.length +
        selectedExports.length +
        selectedMembers.length +
        selectedSurface.length ===
      0
    ) {
      continue;
    }

    const facts = factsOf(file);

    for (const violation of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      violations.push(violation);
    }

    for (const site of facts.memberSites) {
      for (const violation of evaluateMemberSite(selectedMembers, site)) violations.push(violation);
    }

    for (const specifier of facts.specifiers) {
      const edge = { importer: file, specifier };

      const imported = evaluateSelectedEdge(selectedImports, policy.resolver, edge);
      if (Result.isFailure(imported)) {
        if (policy.config.resolve.unresolved === "off") continue;
        if (policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))) continue;
        unresolved.push(`${file} → ${specifier} (${imported.failure.detail})`);
        continue;
      }
      for (const violation of imported.success) violations.push(violation);

      const bound = facts.bindings.get(specifier) ?? [];
      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        ...edge,
        bindings: bound,
      });
      if (!Result.isFailure(exported)) {
        for (const { violation } of exported.success) violations.push(violation);
      }
    }
  }

  return { violations, unresolved, files: files.length };
};

const baselinePathOf = (policy: LoadedPolicy): string | null =>
  policy.config.baseline === undefined
    ? null
    : path.resolve(policy.repoRoot, policy.config.baseline);

const readBaseline = (policy: LoadedPolicy): Baseline => {
  const at = baselinePathOf(policy);
  if (at === null) return EMPTY_BASELINE;
  try {
    return decodeBaseline(JSON.parse(readFileSync(at, "utf8")) as unknown);
  } catch {
    return EMPTY_BASELINE;
  }
};

const report = (lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`);
  });

const describe = (violation: Violation): string =>
  `  ${violation.file}\n      ${formatMessage(violation)}`;

export const check = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const findings = collectFindings(policy, roots);
    const baseline = readBaseline(policy);
    const reportable = unbaselined(baseline, findings.violations);
    const stale = staleEntriesOf(baseline, findings.violations);

    yield* report(reportable.map(describe));
    yield* report(findings.unresolved.map((one) => `  unresolved: ${one}`));

    const carried = findings.violations.length - reportable.length;
    yield* report([
      "",
      `${String(findings.files)} files, ${String(reportable.length)} violations` +
        (carried > 0 ? `, ${String(carried)} carried by the baseline` : ""),
    ]);

    if (stale.length > 0) {
      // The ratchet: a fixed violation must leave the baseline, or the floor
      // never rises and the file stops describing anything real.
      yield* report([
        "",
        `${String(stale.length)} baseline entries no longer fire. The code was fixed; prune them:`,
        ...stale.map((entry) => `  ${entry}`),
        "",
        "  architecture baseline    # rewrites the file from what still fires",
      ]);
      return yield* Effect.fail(fail("stale baseline entries"));
    }

    // The floors. A policy states how much of the tree it reaches, per
    // family; falling under is a policy that quietly stopped covering files.
    const floors = policy.config.limits?.coverage;
    const shortfalls =
      floors === undefined
        ? []
        : coverageShortfalls(
            coverageOf(policy, listSourceFiles(policy.repoRoot, roots, policy.languages)),
            floors,
          );
    if (shortfalls.length > 0) {
      yield* report([
        "",
        "coverage is below the floor the policy states for itself:",
        ...shortfalls.map(
          (one) => `  ${one.family}: ${percent(one.actual)} covered, floor ${percent(one.floor)}`,
        ),
        "",
        "  architecture coverage    # which files no rule reaches",
      ]);
      return yield* Effect.fail(fail("coverage below floor"));
    }

    if (reportable.length > 0 || findings.unresolved.length > 0) {
      return yield* Effect.fail(fail("architecture violations"));
    }
  });

const percent = (fraction: number): string => `${String(Math.floor(fraction * 100))}%`;

// How much of the tree the policy reaches. A probe proves a rule can fire;
// this is whether the files are there to fire on. Reported per family, with the
// adoption backlog — the tiers that said "not tightened yet" — beneath it.
export const coverage = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
    const found = coverageOf(policy, files);
    const fractions = fractionsOf(found);
    const floors = policy.config.limits?.coverage ?? {};
    const row = (family: keyof typeof fractions, covered: number, note: string): string => {
      const floor = floors[family];
      const mark =
        floor === undefined
          ? ""
          : fractions[family] >= floor
            ? `  ≥ ${percent(floor)} ✓`
            : `  < ${percent(floor)} ✗`;
      return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(found.files)}  ${percent(fractions[family]).padStart(4)}  ${note}${mark}`;
    };

    yield* report([
      `${String(found.files)} files under ${roots.join(", ")}`,
      "",
      row("imports", found.imports.covered, "under an import allowlist"),
      row(
        "structure",
        found.structure.enumerated,
        `in an enumerated folder (${String(found.structure.open)} in an open one, ${String(found.structure.total - found.structure.enumerated - found.structure.open)} in none)`,
      ),
      row("members", found.members.covered, "selected by a members rule"),
      row("surface", found.surface.covered, "selected by a surface rule"),
      row("graph", found.graph.covered, "in a cycles or orphans scope"),
      "",
      `  unrestricted tiers: ${policy.adoption.unrestricted.length === 0 ? "(none)" : policy.adoption.unrestricted.join(", ")}`,
      `  partial tiers:      ${policy.adoption.partial.length === 0 ? "(none)" : policy.adoption.partial.join(", ")}`,
    ]);
  });

export const writeBaseline = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const at = baselinePathOf(policy);
    if (at === null) {
      return yield* Effect.fail(
        fail("this policy declares no `baseline` path, so there is nowhere to write one"),
      );
    }

    const findings = collectFindings(policy, roots);
    const baseline = baselineOf(findings.violations);
    yield* Effect.sync(() => {
      writeFileSync(at, serializeBaseline(baseline));
    });
    yield* report([
      `${String(baseline.entries.length)} violations recorded in ${path.relative(policy.repoRoot, at)}.`,
      "Each one is debt the policy is carrying. Fixing one means deleting its line.",
    ]);
  });

// The question a tree config makes harder to answer than a flat one: given a
// file, what governs it? A flat config you grep; a tree you have to walk.
export const explain = (policy: LoadedPolicy, file: string): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path.relative(policy.repoRoot, path.resolve(policy.repoRoot, file));
    const selected = rulesSelecting(policy.importRules, relative);

    // An allowlist rule names no `to` — it fires when the target matches none of
    // its patterns. A prohibition names one.
    const allowlists = selected.filter(([rule]) => rule.to.length === 0 && rule.toNot.length > 0);
    const prohibitions = selected.filter(([rule]) => rule.to.length > 0);

    const owed = policy.structure.parity
      .filter(
        (rule) =>
          rule.file.some((pattern) => pattern.test(relative)) &&
          !rule.fileNot.some((pattern) => pattern.test(relative)),
      )
      .flatMap((rule) => requiredSiblingsOf(rule, relative));

    const governing = policy.structure.folders.filter((rule) =>
      rule.folder.some((pattern) => pattern.test(path.dirname(relative))),
    );

    const naming = policy.structure.naming.filter(
      (rule) =>
        rule.file.some((pattern) => pattern.test(relative)) &&
        !rule.fileNot.some((pattern) => pattern.test(relative)),
    );

    const firstSentence = (message: string) => `${message.split(". ")[0] ?? message}.`;
    const named = (rule: { readonly name: string; readonly message: string }): string =>
      `    ${rule.name} — ${firstSentence(rule.message)}`;

    // The families beyond imports and structure: which rules of each speak to
    // this file at all. What they are evaluated against is `facts`' answer.
    const restricted = exportRulesSelecting(policy.exportRules, relative).map(([rule]) => rule);
    const vocabulary = memberRulesSelecting(policy.memberRules, relative);
    const surface = surfaceRulesSelecting(policy.surfaceRules, relative);
    const scoped = (rule: { within: ReadonlyArray<RegExp>; withinNot: ReadonlyArray<RegExp> }) =>
      rule.within.some((pattern) => pattern.test(relative)) &&
      !rule.withinNot.some((pattern) => pattern.test(relative));
    const graph = [
      ...policy.graph.cycles.filter(scoped).map((rule) => `${named(rule)} (cycles)`),
      ...policy.graph.orphans.filter(scoped).map((rule) => `${named(rule)} (orphans)`),
      ...policy.graph.reach
        .filter(
          (rule) =>
            rule.from.some((pattern) => pattern.test(relative)) &&
            !rule.fromNot.some((pattern) => pattern.test(relative)),
        )
        .map((rule) => `${named(rule)} (reach)`),
    ];
    const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
      lines.length === 0 ? [] : ["", title, ...lines];

    yield* report([
      relative,
      "",
      allowlists.length === 0
        ? "  may import: anything (no tier above this file states an allowlist)"
        : "  may import:",
      ...allowlists.flatMap(([rule]) => [
        `    — ${rule.name}`,
        ...rule.toNot.map((pattern) => `        ${pattern}`),
        ...[...rule.externals].map((name) => `        external: ${name}`),
      ]),
      "",
      "  may not import:",
      ...(prohibitions.length === 0
        ? ["    (nothing beyond the allowlist above)"]
        : prohibitions.map(([rule]) => `    ${rule.name} — ${firstSentence(rule.message)}`)),
      "",
      `  lives in: ${governing.length === 0 ? "a folder no rule governs" : governing.map((rule) => rule.name).join(", ")}`,
      ...(naming.length === 0
        ? []
        : [
            "  is named by:",
            ...naming.map(
              (rule) =>
                `    ${rule.name} — ${rule.sameAs !== null ? "its folder's own name" : (rule.convention?.source ?? "")}`,
            ),
          ]),
      ...(owed.length === 0 ? [] : ["  owes:", ...owed.map((one) => `    ${one}`)]),
      ...section("  may not name (exports):", restricted.map(named)),
      ...section("  vocabulary (members):", vocabulary.map(named)),
      ...section("  may export (surface):", surface.map(named)),
      ...section("  graph:", graph),
    ]);
  });

// The other half of `explain`. `explain` says which rules select a file; this
// says what those rules are evaluated against — every edge the parser found,
// the names carried across each, every declared member and called name. A rule
// that "should fire" and does not is one of two mistakes, and this is how to
// tell them apart: the pattern does not select the site, or the site is not a
// fact the adapter extracts.
export const facts = (
  policy: LoadedPolicy,
  file: string,
  format: "text" | "json" = "text",
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path
      .relative(policy.repoRoot, path.resolve(policy.repoRoot, file))
      .replaceAll(path.sep, "/");

    const read = yield* Effect.try({
      try: () => sourceFactsOf(policy.repoRoot, relative, policy.extractor),
      catch: (cause) => fail(`could not read ${relative}: ${String(cause)}`),
    });

    const edges = read.specifiers.map((specifier) => ({
      specifier,
      bindings: read.bindings.get(specifier) ?? [],
    }));
    const declared = read.memberSites.filter((site) => site.subject === "members");
    const called = read.memberSites.filter((site) => site.subject === "calls");

    if (format === "json") {
      return yield* report([
        JSON.stringify(
          { file: relative, edges, memberSites: read.memberSites, exportSites: read.exportSites },
          null,
          2,
        ),
      ]);
    }

    yield* report([
      relative,
      "",
      edges.length === 0 ? "  edges: (none)" : "  edges:",
      ...edges.flatMap(({ bindings, specifier }) => [
        `    ${specifier}`,
        ...(bindings.length === 0
          ? ["        (no bindings)"]
          : bindings.map((binding) => `        ${binding.kind.padEnd(9)} ${binding.symbol}`)),
      ]),
      "",
      declared.length === 0 ? "  members: (none)" : "  members:",
      ...declared.map((site) => `    ${site.in ?? ""}.${site.name}  (${site.declares ?? "other"})`),
      "",
      called.length === 0 ? "  calls: (none)" : "  calls:",
      ...called.map((site) => `    ${site.name}`),
      "",
      read.exportSites.length === 0 ? "  exports: (none)" : "  exports:",
      ...read.exportSites.map(
        (site) =>
          `    ${site.kind.padEnd(9)} ${site.name}  (${site.reexport ? "re-export" : site.declares})`,
      ),
    ]);
  });

const SCHEMA_HEADER = `# yaml-language-server: $schema=${MANIFEST_SCHEMA_ID}\n`;

// A first manifest: one open root that reaches itself, the ceilings at zero,
// and a comment per section naming the page that explains it. Tight enough to
// fire on the first external import — which is the moment the author learns
// where the allowlist is — and small enough to read in one sitting.
const STARTER_MANIFEST = `${SCHEMA_HEADER}#
# The architecture policy: one manifest of this repository.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/
#
# A key ending in \`/\` is a folder; anything else is a file. The default is
# tight: a folder admits only the children it lists, and a file may import only
# what it or an ancestor allows. Laxity is opted into, by name, at the node that
# wants it. Quote every glob — \`*\` and \`@\` mean something else to YAML bare.

# How an import specifier becomes a file. Every pattern below is matched
# against a resolved path, so this is what makes the rest mean anything.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/resolution/
resolve:
  scopes:
    - files: ""
      language: typescript
      options: { tsconfig: tsconfig.json }
  unresolved: error

# Violations this repository is carrying while it adopts the policy, keyed by
# fingerprint. Written by \`architecture baseline\`; the floor only rises.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/baseline/
baseline: .architecture-baseline.json

# Ceilings on how many tiers may say "not tightened yet". At zero, raising one
# is a line in this file a reviewer sees.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/adoption/
limits:
  unrestricted: 0
  partial: 0

# The repository. One open root, reaching itself and the runtime; run
# \`architecture check\` to see what else it reaches, and write that down here.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/imports/
tree:
  "src/":
    message: "src/ is the whole program. Nothing in it is layered yet."
    layout: open
    imports:
      message: "This import is not on the allowlist."
      allow: ["src/**", "node:**"]
      # npm packages this tier may reach, by name.
      external: []
    children: {}
`;

// A starter manifest, for a repository that has none.
export const init = (repoRoot: string): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const present = MANIFEST_FILENAMES.filter((name) => existsSync(path.resolve(repoRoot, name)));
    if (present.length > 0) {
      return yield* Effect.fail(
        fail(
          `${present.join(", ")} already exists. \`init\` writes a starter manifest for a ` +
            `repository that has none, and does not overwrite one.`,
        ),
      );
    }
    yield* Effect.sync(() => {
      writeFileSync(path.resolve(repoRoot, "architecture.yaml"), STARTER_MANIFEST);
    });
    yield* report([
      "wrote architecture.yaml.",
      "",
      "  architecture check       # what src/ reaches today; add it to the allowlist by name",
      "  architecture coverage    # how much of the tree the policy reaches",
    ]);
  });

// The same manifest as a data file. Nothing is hoisted into `defs` — which
// subtrees are worth naming is the author's call — and comments do not
// survive, since no tool carries them across; the report says so.
export const migrate = (
  repoRoot: string,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const from = yield* Effect.try({
      try: () =>
        configFilename === undefined
          ? findManifestFile(repoRoot)
          : path.resolve(repoRoot, configFilename),
      catch: (cause) => fail(String(cause)),
    });
    if (![".mjs", ".js", ".cjs"].includes(path.extname(from))) {
      return yield* Effect.fail(
        fail(
          `${path.basename(from)} is already a data file. \`migrate\` reads a JavaScript ` +
            `manifest and writes the same policy as architecture.yaml.`,
        ),
      );
    }
    const to = path.resolve(repoRoot, "architecture.yaml");
    if (existsSync(to)) {
      return yield* Effect.fail(
        fail("architecture.yaml already exists; `migrate` does not overwrite it."),
      );
    }

    const read = yield* Effect.tryPromise({
      try: () => readManifestFile(from),
      catch: (cause) => fail(String(cause)),
    });
    // Written only if it decodes: a manifest that does not load as a module
    // is not going to load as YAML either, and the error names why.
    const decoded = decodeManifest(from, read.manifest);
    if (Result.isFailure(decoded)) return yield* Effect.fail(fail(decoded.failure.message));

    yield* Effect.sync(() => {
      writeFileSync(to, `${SCHEMA_HEADER}\n${formatManifestYaml(read.manifest)}`);
    });
    yield* report([
      `wrote architecture.yaml from ${path.basename(from)}.`,
      "",
      "Comments were not carried over; port the ones worth keeping by hand.",
      `Then delete ${path.basename(from)}: a repository with two manifests is refused.`,
    ]);
  });

export const run = (
  repoRoot: string,
  argv: ReadonlyArray<string>,
  // From ARCHITECTURE_CONFIG. Absent, the manifest is discovered by name.
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const [command = "check", ...rest] = argv;

    // The three commands that write a manifest rather than read one.
    if (command === "init") return yield* init(repoRoot);
    if (command === "migrate") return yield* migrate(repoRoot, configFilename);
    if (command === "infer") {
      yield* infer(repoRoot, rest, configFilename);
      return;
    }

    const policy = yield* Effect.tryPromise({
      try: () => loadPolicyFromFile(repoRoot, configFilename),
      catch: (cause) => fail(String(cause)),
    });
    yield* Effect.sync(() => {
      for (const notice of policy.notices) process.stderr.write(`deprecated: ${notice}\n`);
    });

    const roots = rest.length > 0 ? rest : ["packages"];

    switch (command) {
      case "check":
        return yield* check(policy, roots);
      case "baseline":
        return yield* writeBaseline(policy, roots);
      case "explain": {
        const [file] = rest;
        if (file === undefined) return yield* Effect.fail(fail("explain needs a file path"));
        return yield* explain(policy, file);
      }
      case "coverage":
        return yield* coverage(policy, roots);
      case "facts": {
        const [file] = rest.filter((argument) => argument !== "--json");
        if (file === undefined) return yield* Effect.fail(fail("facts needs a file path"));
        return yield* facts(policy, file, rest.includes("--json") ? "json" : "text");
      }
      default:
        return yield* Effect.fail(
          fail(
            `unknown command "${command}". Try: check | baseline | coverage | explain <file> | facts <file> [--json] | init | infer | migrate`,
          ),
        );
    }
  });

export const fingerprint = fingerprintOf;
