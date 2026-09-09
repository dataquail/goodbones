import * as Result from "effect/Result";

import {
  type Baseline,
  type BaselineFilter,
  decodeBaseline,
  EMPTY_BASELINE,
  makeBaselineFilter,
} from "../core/baseline.js";
import {
  type CompiledExportRule,
  compileExportRules,
  exportRulesFailingTheirProbe,
} from "../core/exports.js";
import {
  type CompiledGraph,
  compileGraphRules,
  graphRulesFailingTheirProbe,
} from "../core/graph.js";
import {
  type CompiledImportRule,
  compileImportRules,
  rulesFailingTheirProbe,
} from "../core/imports.js";
import {
  type CompiledMemberRule,
  compileMemberRules,
  memberRulesFailingTheirProbe,
} from "../core/members.js";
import {
  type CompiledStructure,
  compileStructure,
  structureRulesFailingTheirProbe,
} from "../core/structure.js";
import {
  type CompiledSurfaceRule,
  compileSurfaceRules,
  surfaceRulesFailingTheirProbe,
} from "../core/surface.js";
import type { ResolveScope } from "../domain/architecture-config.js";
import {
  ConfigInvalid,
  ImportUnresolved,
  type PatternInvalid,
} from "../domain/architecture-error.js";
import type { SourceFacts } from "../domain/facts.js";
import type { ManifestLocator } from "../domain/manifest-location.js";
import { type LoweredRules, lowerManifest } from "../manifest/compile.js";
import { decodeManifest, type Manifest } from "../manifest/manifest.js";
import type { FactExtractor } from "../ports/fact-extractor.js";
import type { FileSystem } from "../ports/file-system.js";
import type { Language } from "../ports/language.js";
import type { ModuleResolver } from "../ports/module-resolver.js";

// A manifest, read by a host, turned into the policy both adapters evaluate.
// Decoding, lowering, compiling and probing happen here, once, with whatever
// languages the host hands in — this tier never names one. The host reads the
// manifest file, constructs its language packs and the live file system, and
// hands them over; that is the whole of what a host has to know.

export type LoadedPolicy = {
  readonly repoRoot: string;
  readonly config: Manifest;
  readonly importRules: ReadonlyArray<CompiledImportRule>;
  readonly exportRules: ReadonlyArray<CompiledExportRule>;
  readonly memberRules: ReadonlyArray<CompiledMemberRule>;
  readonly surfaceRules: ReadonlyArray<CompiledSurfaceRule>;
  // Evaluated by the CLI only; compiled and probed here so a vacuous one fails
  // the plugin's load as well.
  readonly graph: CompiledGraph;
  readonly adoption: LoweredRules["adoption"];
  // The manifest's nodes, each with the pattern that selects its files — what
  // joins a rule's slug back to the tier the author wrote.
  readonly nodes: LoweredRules["nodes"];
  readonly layers: LoweredRules["layers"];
  readonly structure: CompiledStructure;
  readonly fileSystem: FileSystem;
  // The language packs this policy is evaluated with. The walker takes its
  // extensions from them, and lowering the shape of its probes.
  readonly languages: ReadonlyArray<Language>;
  // Violations this repository is carrying while it adopts the policy. Applied
  // at report time so a baselined finding costs nothing but a line in a file.
  readonly baseline: BaselineFilter;
  // Routes each file to the resolver of the scope that covers it.
  readonly resolver: ModuleResolver;
  // Routes each file to the extractor of the language whose scope covers it.
  // The CLI reads every file through this; the plugin reads oxlint's tree.
  readonly extractor: FactExtractor;
  readonly ignoreUnresolved: ReadonlyArray<RegExp>;
  // Deprecation notices from reading the manifest. The host prints them once.
  readonly notices: ReadonlyArray<string>;
};

export type LoadPolicyInput = {
  readonly repoRoot: string;
  // Where the manifest came from, for the error that names it.
  readonly configPath: string;
  // The manifest as the host read it — a module's default export, a parsed
  // document — before decoding.
  readonly manifest: unknown;
  // From a data file, where a path in the manifest was written, so a decode
  // error names a line. A module manifest has none to give.
  readonly locate?: ManifestLocator | undefined;
  readonly languages: ReadonlyArray<Language>;
  readonly fileSystem: FileSystem;
};

const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

type Route = {
  readonly scope: ResolveScope;
  readonly matches: RegExp;
  readonly language: Language;
};

// Each scope, paired with the language it names. A scope naming a language no
// pack answers to is refused here: every rule about that scope would otherwise
// be evaluated against nothing.
const routesOf = (
  configPath: string,
  scopes: ReadonlyArray<ResolveScope>,
  languages: ReadonlyArray<Language>,
): Result.Result<ReadonlyArray<Route>, ConfigInvalid> => {
  const routes: Array<Route> = [];
  for (const scope of scopes) {
    const language = languages.find((one) => one.id === scope.language);
    if (language === undefined) {
      return Result.fail(
        new ConfigInvalid({
          configPath,
          detail:
            `resolve scope ${JSON.stringify(scope.files)} names the language ` +
            `"${scope.language}", and no language pack by that name is loaded ` +
            `(loaded: ${languages.length === 0 ? "none" : languages.map((one) => one.id).join(", ")}).`,
        }),
      );
    }
    routes.push({ scope, matches: new RegExp(scope.files), language });
  }
  return Result.succeed(routes);
};

const routeFor = (routes: ReadonlyArray<Route>, file: string): Route | undefined =>
  routes.find((route) => route.matches.test(file));

// One resolver per scope, built by the scope's language, behind one port that
// picks the scope by the importing file.
const makeRouter = (
  configPath: string,
  repoRoot: string,
  routes: ReadonlyArray<Route>,
): Result.Result<ModuleResolver, ConfigInvalid> => {
  const resolvers: Array<readonly [Route, ModuleResolver]> = [];
  for (const route of routes) {
    const resolver = route.language.makeResolver(repoRoot, route.scope);
    if (Result.isFailure(resolver)) {
      return Result.fail(new ConfigInvalid({ configPath, detail: resolver.failure.message }));
    }
    resolvers.push([route, resolver.success]);
  }
  return Result.succeed({
    resolve: (fromFile, specifier) => {
      const found = resolvers.find(([route]) => route.matches.test(fromFile));
      if (found === undefined) {
        return Result.fail(
          new ImportUnresolved({
            fromFile,
            specifier,
            detail: "no resolve scope in the architecture config matches this file",
          }),
        );
      }
      return found[1].resolve(fromFile, specifier);
    },
  });
};

// A file is parsed by the language whose scope covers it. A file no scope
// covers reads as nothing — which, for a probe, is a failed probe with a
// message that says so.
const makeRoutingExtractor = (routes: ReadonlyArray<Route>): FactExtractor => ({
  factsOf: (file, text) =>
    routeFor(routes, file)?.language.extractor.factsOf(file, text) ?? NOTHING,
});

// The baseline is read through the port, so this tier touches no file itself.
// An absent or unreadable one carries nothing, which is the safe direction:
// every violation reports.
const readBaseline = (fileSystem: FileSystem, at: string | undefined): Baseline => {
  if (at === undefined) return EMPTY_BASELINE;
  const text = fileSystem.readText(at);
  if (text === null) return EMPTY_BASELINE;
  try {
    return decodeBaseline(JSON.parse(text) as unknown);
  } catch {
    return EMPTY_BASELINE;
  }
};

// Anything wrong with the policy — a bad shape, an uncompilable pattern, a rule
// that cannot report its own probe — is refused. A policy that loaded with a
// gap reports nothing there and looks exactly like a clean codebase.
export const loadPolicy = (
  input: LoadPolicyInput,
): Result.Result<LoadedPolicy, ConfigInvalid | PatternInvalid> => {
  const { configPath, fileSystem, languages, repoRoot } = input;

  const decoded = decodeManifest(configPath, input.manifest, { locate: input.locate });
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const config = decoded.success.manifest;

  const routes = routesOf(configPath, config.resolve.scopes, languages);
  if (Result.isFailure(routes)) return Result.fail(routes.failure);

  // The manifest is the authoring surface; these flat rules are the machine's.
  // The languages tell lowering what a source file in each scope is called, so
  // a synthetic probe is a file of the scope's language.
  const rules = lowerManifest(config, languages, {
    substitutions: decoded.success.substitutions,
    locate: input.locate,
  });

  // The ceilings. A tier that says "not tightened yet" is a sentence someone
  // wrote; a ceiling on how many may say so is what keeps the backlog from
  // becoming the architecture. Exceeding it is a policy that broke its own
  // promise, and is refused like any other invalid policy.
  const ceilings = [
    ["unrestricted", rules.adoption.unrestricted, config.limits?.unrestricted],
    ["partial", rules.adoption.partial, config.limits?.partial],
  ] as const;
  const exceeded = ceilings.flatMap(([label, nodes, ceiling]) =>
    ceiling !== undefined && nodes.length > ceiling
      ? [
          `${label}: ${String(nodes.length)} nodes against a ceiling of ${String(ceiling)} (${nodes.join(", ")})`,
        ]
      : [],
  );
  if (exceeded.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `the policy exceeds its own adoption ceiling — ${exceeded.join("; ")}. ` +
          `Tighten a tier, or raise the ceiling in \`limits\` on purpose.`,
      }),
    );
  }

  const importRules = compileImportRules(rules.imports);
  if (Result.isFailure(importRules)) return Result.fail(importRules.failure);

  const exportRules = compileExportRules(rules.exports);
  if (Result.isFailure(exportRules)) return Result.fail(exportRules.failure);

  // A fix is a rewrite in one language's module syntax. A rule naming one that
  // no loaded language implements would report as fixable and never fix.
  const unfixable = exportRules.success.filter((rule) => {
    const fix = rule.fix;
    return fix !== null && !languages.some((one) => one.fixes.includes(fix));
  });
  if (unfixable.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these exports rules name a fix no loaded language implements: ` +
          unfixable.map((rule) => `${rule.name} (${rule.fix ?? ""})`).join(", ") +
          `. Drop the fix, or load a language pack that carries it.`,
      }),
    );
  }

  const memberRules = compileMemberRules(rules.members);
  if (Result.isFailure(memberRules)) return Result.fail(memberRules.failure);

  const surfaceRules = compileSurfaceRules(rules.surface);
  if (Result.isFailure(surfaceRules)) return Result.fail(surfaceRules.failure);

  const graph = compileGraphRules(rules.graph);
  if (Result.isFailure(graph)) return Result.fail(graph.failure);

  const structure = compileStructure(rules.structure);
  if (Result.isFailure(structure)) return Result.fail(structure.failure);

  // A probe carrying a source snippet is parsed by the extractor of the
  // language whose scope covers the probe's file — the same extractor the CLI
  // reads that file through. The plugin reads through oxlint's tree instead,
  // and the parity suite is what holds that tree to this one.
  const extractor = makeRoutingExtractor(routes.success);
  const parsedBy = (rule: { readonly probe: { readonly from: string } }): string => {
    const route = routeFor(routes.success, rule.probe.from);
    return route === undefined
      ? ` — no resolve scope covers its probe ${JSON.stringify(rule.probe.from)}, so no language parsed it`
      : ` — probe parsed by ${route.language.id}, selected by the scope ${JSON.stringify(route.scope.files)}`;
  };
  const vacuous = [
    ...rulesFailingTheirProbe(importRules.success).map((rule) => rule.name),
    ...exportRulesFailingTheirProbe(exportRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...memberRulesFailingTheirProbe(memberRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...surfaceRulesFailingTheirProbe(surfaceRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...structureRulesFailingTheirProbe(structure.success),
    ...graphRulesFailingTheirProbe(graph.success),
  ];
  if (vacuous.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these rules do not report their own probe, so they enforce nothing: ` +
          `${vacuous.join(", ")}. Fix the rule or its probe — ` +
          `a rule that cannot flag a violation it was written for is worse than no rule. ` +
          `A probe with a source snippet fails when the parser reads no site of that name ` +
          `out of it; \`architecture facts\` shows what the parser reads.`,
      }),
    );
  }

  // A scope the language cannot build a resolver from — options it does not
  // understand — is a policy whose rules would be evaluated against the wrong
  // files, and is refused.
  const resolver = makeRouter(configPath, repoRoot, routes.success);
  if (Result.isFailure(resolver)) return Result.fail(resolver.failure);

  return Result.succeed({
    repoRoot,
    config,
    importRules: importRules.success,
    exportRules: exportRules.success,
    memberRules: memberRules.success,
    surfaceRules: surfaceRules.success,
    graph: graph.success,
    adoption: rules.adoption,
    nodes: rules.nodes,
    layers: rules.layers,
    structure: structure.success,
    fileSystem,
    languages,
    baseline: makeBaselineFilter(readBaseline(fileSystem, config.baseline)),
    resolver: resolver.success,
    extractor,
    ignoreUnresolved: (config.resolve.ignoreUnresolved ?? []).map(
      (pattern: string) => new RegExp(pattern),
    ),
    notices: decoded.success.notices,
  });
};
