import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";

import {
  type Atlas,
  atlasOf,
  type Baseline,
  baselineOf,
  type CoverageFamily,
  coverageOf,
  cyclesIn,
  decodeBaseline,
  decodeManifest,
  EMPTY_BASELINE,
  evaluateGraph,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  exportRulesSelecting,
  findManifestFile,
  fingerprintOf,
  formatManifestYaml,
  formatMessage,
  fractionsOf,
  governingNode,
  type Graph,
  hasGraphRules,
  heightOf,
  listSourceFiles,
  makeBaselineFilter,
  MANIFEST_FILENAMES,
  MANIFEST_SCHEMA_ID,
  memberRulesSelecting,
  type ObservedEdge,
  readManifestFile,
  renderMermaid,
  requiredSiblingsOf,
  residueOf,
  type ResolvedTarget,
  rulesSelecting,
  serializeBaseline,
  slackOf,
  type Snapshot,
  SNAPSHOT_VERSION,
  type SourceFacts,
  staleEntriesOf,
  surfaceRulesSelecting,
  vacancyOf,
  type Violation,
} from "@goodbones/core";
import { assetsDir } from "@goodbones/explorer/assets";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { type LoadedPolicy, loadPolicyFromFile, manifestPathOf } from "./config-loader.js";
import { diagramView, parseDiagramFlags } from "./diagram.js";
import { type ExploreRoutes, parseExploreFlags, respond, writeStandalone } from "./explore.js";
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

// An edge the resolver could not turn into a file. It is reported on its own,
// since every import rule about it enforces nothing.
export type UnresolvedEdge = {
  readonly file: string;
  readonly specifier: string;
  readonly detail: string;
};

// An `exports` violation names the symbol it is about; this remembers the
// edge it was found on, so the atlas can draw it there.
export type BindingViolation = {
  readonly importer: string;
  readonly target: string;
  readonly fingerprint: string;
};

export type Findings = {
  readonly violations: ReadonlyArray<Violation>;
  readonly unresolved: ReadonlyArray<UnresolvedEdge>;
  readonly files: number;
  // Every edge resolved from a file under an import rule — what the slack
  // report reads. An edge from a file no import rule selects is not here
  // unless `edges: "all"` asked for it, since no allowlist could have
  // admitted it.
  readonly edges: ReadonlyArray<ObservedEdge>;
  readonly bindingViolations: ReadonlyArray<BindingViolation>;
  // The import graph, when a graph rule needed it or the caller asked.
  readonly graph: Graph | null;
};

export type CollectOptions = {
  // Build the graph even when no rule needs it — the snapshot counts cycles
  // and orders violations by it.
  readonly graph?: boolean;
  // Resolve the edges of every file, the ones under no import rule included.
  // `check` skips those as an optimisation; the atlas needs them — they are
  // the ungoverned edges. An import none of them can resolve is not reported:
  // no rule is about it.
  readonly edges?: "governed" | "all";
};

export const collectFindings = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: CollectOptions = {},
): Findings => {
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  const violations: Array<Violation> = [];
  const unresolved: Array<UnresolvedEdge> = [];
  const edges: Array<ObservedEdge> = [];
  const bindingViolations: Array<BindingViolation> = [];
  const everyEdge = options.edges === "all";

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
  const graph =
    options.graph === true || hasGraphRules(policy.graph)
      ? buildGraph(files, policy.resolver, factsOf)
      : null;
  if (graph !== null && hasGraphRules(policy.graph)) {
    for (const violation of evaluateGraph(policy.graph, graph)) violations.push(violation);
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
      !everyEdge &&
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

      // A file no import rule selects never needs its imports resolved, which
      // is what keeps resolution off the hot path for the bulk of the repo.
      let target: ResolvedTarget | null = null;
      if (selectedImports.length > 0 || everyEdge) {
        const resolved = policy.resolver.resolve(file, specifier);
        if (Result.isFailure(resolved)) {
          if (selectedImports.length === 0) continue;
          if (policy.config.resolve.unresolved === "off") continue;
          if (policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))) continue;
          unresolved.push({ file, specifier, detail: resolved.failure.detail });
          continue;
        }
        target = resolved.success;
        edges.push({ importer: file, target });
        for (const violation of evaluateResolvedEdge(selectedImports, file, target)) {
          violations.push(violation);
        }
      }

      const bound = facts.bindings.get(specifier) ?? [];
      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        ...edge,
        bindings: bound,
      });
      if (!Result.isFailure(exported)) {
        for (const { violation } of exported.success) {
          violations.push(violation);
          if (target !== null) {
            bindingViolations.push({
              importer: file,
              target: target.path,
              fingerprint: fingerprintOf(violation),
            });
          }
        }
      }
    }
  }

  return { violations, unresolved, files: files.length, edges, bindingViolations, graph };
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

// Everything `check` has to say, as one value: the two renderers below read
// it, and nothing else computes a finding. `version` is here so a document
// that grows this shape (a conformance snapshot) can say which one it grew.
export type ReportedViolation = Violation & {
  readonly fingerprint: string;
  readonly baselined: boolean;
};

export type CoverageReport = Readonly<
  Record<
    CoverageFamily,
    { readonly covered: number; readonly total: number; readonly floor?: number }
  >
>;

export type CheckReport = {
  readonly version: 1;
  readonly files: number;
  readonly roots: ReadonlyArray<string>;
  readonly ok: boolean;
  // The file the policy was read from, repo-relative, and a hash of its
  // bytes — the root file only, when the manifest is split with `include`.
  readonly manifest: { readonly path: string; readonly sha256: string };
  // Every finding, baselined ones included; `baselined` says which.
  readonly violations: ReadonlyArray<ReportedViolation>;
  readonly unresolved: ReadonlyArray<UnresolvedEdge>;
  // Baseline entries the code no longer produces.
  readonly stale: ReadonlyArray<string>;
  readonly coverage: CoverageReport;
  readonly adoption: {
    readonly unrestricted: ReadonlyArray<string>;
    readonly partial: ReadonlyArray<string>;
  };
};

const COVERAGE_FAMILIES: ReadonlyArray<CoverageFamily> = [
  "imports",
  "structure",
  "members",
  "surface",
  "graph",
];

const sha256Of = (file: string): string => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
};

export const checkReport = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): CheckReport => reportOf(policy, roots, manifestPath, collectFindings(policy, roots));

const reportOf = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
  findings: Findings,
): CheckReport => {
  const baseline = readBaseline(policy);
  const stale = staleEntriesOf(baseline, findings.violations);
  const { isBaselined } = makeBaselineFilter(baseline);
  const violations = findings.violations.map((violation) => ({
    ...violation,
    fingerprint: fingerprintOf(violation),
    baselined: isBaselined(violation),
  }));

  // The floors. A policy states how much of the tree it reaches, per
  // family; falling under is a policy that quietly stopped covering files.
  const floors = policy.config.limits?.coverage ?? {};
  const found = coverageOf(policy, listSourceFiles(policy.repoRoot, roots, policy.languages));
  const covered = (family: CoverageFamily): number =>
    family === "structure" ? found.structure.enumerated : found[family].covered;
  const coverage = Object.fromEntries(
    COVERAGE_FAMILIES.map((family) => {
      const floor = floors[family];
      return [
        family,
        {
          covered: covered(family),
          total: found.files,
          ...(floor === undefined ? {} : { floor }),
        },
      ];
    }),
  ) as CoverageReport;
  const shortfalls = shortfallsOf(coverage);

  const reportable = violations.filter((one) => !one.baselined).length;
  return {
    version: 1,
    files: findings.files,
    roots,
    ok:
      reportable === 0 &&
      findings.unresolved.length === 0 &&
      stale.length === 0 &&
      shortfalls.length === 0,
    manifest: {
      path: path.relative(policy.repoRoot, manifestPath).replaceAll(path.sep, "/"),
      sha256: sha256Of(manifestPath),
    },
    violations,
    unresolved: findings.unresolved,
    stale,
    coverage,
    adoption: {
      unrestricted: policy.adoption.unrestricted,
      partial: policy.adoption.partial,
    },
  };
};

// Why a report is not `ok`, in the order the text renderer explains it: a
// stale baseline first, since nothing else is trustworthy until the file
// describes something real.
type Shortfall = {
  readonly family: CoverageFamily;
  readonly actual: number;
  readonly floor: number;
};

const shortfallsOf = (coverage: CoverageReport): ReadonlyArray<Shortfall> =>
  COVERAGE_FAMILIES.flatMap((family) => {
    const { covered, floor, total } = coverage[family];
    const actual = total === 0 ? 1 : covered / total;
    return floor === undefined || actual >= floor ? [] : [{ family, actual, floor }];
  });

const failureOf = (
  report: CheckReport,
  shortfalls: ReadonlyArray<Shortfall>,
): CliFailure | null => {
  if (report.stale.length > 0) return fail("stale baseline entries");
  if (shortfalls.length > 0) return fail("coverage below floor");
  if (report.ok) return null;
  return fail("architecture violations");
};

const renderText = (report: CheckReport): ReadonlyArray<string> => {
  const reportable = report.violations.filter((one) => !one.baselined);
  const carried = report.violations.length - reportable.length;
  const shortfalls = shortfallsOf(report.coverage);
  return [
    ...reportable.map(describe),
    ...report.unresolved.map(
      (one) => `  unresolved: ${one.file} → ${one.specifier} (${one.detail})`,
    ),
    "",
    `${String(report.files)} files, ${String(reportable.length)} violations` +
      (carried > 0 ? `, ${String(carried)} carried by the baseline` : ""),
    // The ratchet: a fixed violation must leave the baseline, or the floor
    // never rises and the file stops describing anything real.
    ...(report.stale.length === 0
      ? []
      : [
          "",
          `${String(report.stale.length)} baseline entries no longer fire. The code was fixed; prune them:`,
          ...report.stale.map((entry) => `  ${entry}`),
          "",
          "  architecture baseline    # rewrites the file from what still fires",
        ]),
    ...(shortfalls.length === 0
      ? []
      : [
          "",
          "coverage is below the floor the policy states for itself:",
          ...shortfalls.map(
            (one) => `  ${one.family}: ${percent(one.actual)} covered, floor ${percent(one.floor)}`,
          ),
          "",
          "  architecture coverage    # which files no rule reaches",
        ]),
  ];
};

export type CheckOptions = {
  readonly format: "text" | "json";
  readonly manifestPath: string;
};

export const check = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: CheckOptions,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const report_ = checkReport(policy, roots, options.manifestPath);
    // JSON is one object on stdout and nothing else there; the failure, when
    // there is one, is a sentence on stderr and the exit code, as in text.
    yield* report(
      options.format === "json" ? [JSON.stringify(report_, null, 2)] : renderText(report_),
    );
    const failure = failureOf(report_, shortfallsOf(report_.coverage));
    if (failure !== null) return yield* Effect.fail(failure);
  });

const percent = (fraction: number): string => `${String(Math.floor(fraction * 100))}%`;

// The conformance snapshot: `check`'s report grown with what no family
// reaches, what the allowlists permit and nothing uses, the cycle count and
// the size of the debt — the whole distance between the tree and the
// manifest, as one document another run can be compared against. Its shape
// is the core's `Snapshot`, and the schema published beside the manifest's.
export const snapshotOf = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): Snapshot => {
  const findings = collectFindings(policy, roots, { graph: true });
  const report_ = reportOf(policy, roots, manifestPath, findings);
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  const graph = findings.graph ?? { files, edges: new Map() };
  const heights = heightOf(graph);

  // Leaf edges first. A violation names a target when it is about an edge;
  // the cost of fixing it is roughly how much of the graph stands beneath
  // that target, so the ones nearest the ground come first and a reader
  // starting at the top of the list is starting where a fix stays local.
  // Ties keep the fingerprint order, so the list is the same on every run.
  const heightOfViolation = (one: ReportedViolation): number =>
    heights.get(one.subject ?? "") ?? heights.get(one.file) ?? 0;
  const violations = [...report_.violations].sort((left, right) => {
    const byHeight = heightOfViolation(left) - heightOfViolation(right);
    return byHeight !== 0 ? byHeight : left.fingerprint.localeCompare(right.fingerprint);
  });

  // Slack is measured over the walked files as well as the edges: an
  // allowlist that selects no file is vacant, and its entries are reported as
  // that rather than as lines nobody needs.
  const { concentration, slack } = slackOf(policy.importRules, findings.edges, files);

  return {
    version: SNAPSHOT_VERSION,
    manifest: report_.manifest,
    roots: report_.roots,
    files: report_.files,
    ok: report_.ok,
    coverage: report_.coverage,
    residue: residueOf(policy, files),
    vacant: vacancyOf(policy.importRules, files),
    violations,
    unresolved: report_.unresolved,
    stale: report_.stale,
    baseline: { size: readBaseline(policy).entries.length },
    cycles: cyclesIn(graph).length,
    slack,
    concentration,
    adoption: report_.adoption,
  };
};

const renderSnapshot = (snapshot: Snapshot): ReadonlyArray<string> => {
  const reportable = snapshot.violations.filter((one) => !one.baselined);
  const carried = snapshot.violations.length - reportable.length;
  const count = (n: number, noun: string, plural = `${noun}s`): string =>
    `${String(n)} ${n === 1 ? noun : plural}`;
  const row = (family: CoverageFamily): string => {
    const { covered, floor, total } = snapshot.coverage[family];
    const fraction = total === 0 ? 1 : covered / total;
    const mark =
      floor === undefined
        ? ""
        : fraction >= floor
          ? `  ≥ ${percent(floor)} ✓`
          : `  < ${percent(floor)} ✗`;
    return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(total)}  ${percent(fraction).padStart(4)}${mark}`;
  };
  const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => [
    "",
    title,
    ...lines,
  ];
  const vacantWidth = Math.max(0, ...snapshot.vacant.map((one) => one.node.length));
  // The document carries every partly-used fragment entry; the text shows
  // the ones concentrated enough to read as a per-file rule written wide.
  const concentrated = snapshot.concentration.filter((one) => one.usedAt * 2 < one.of);

  return [
    `${String(snapshot.files)} files under ${snapshot.roots.join(", ")}, against ${snapshot.manifest.path}`,
    ...section("coverage", COVERAGE_FAMILIES.map(row)),
    ...section(
      `residue: ${count(snapshot.residue.files.length, "file")} no family reaches` +
        (snapshot.residue.folders.length === 0
          ? ""
          : `, ${count(snapshot.residue.folders.length, "folder")} wholly`),
      [
        ...snapshot.residue.folders.map((folder) => `  ${folder}/`),
        ...snapshot.residue.files
          .filter(
            (file) => !snapshot.residue.folders.some((folder) => file.startsWith(`${folder}/`)),
          )
          .map((file) => `  ${file}`),
      ],
    ),
    ...section(
      `vacant: ${count(snapshot.vacant.length, "node")} ${snapshot.vacant.length === 1 ? "selects" : "select"} no file`,
      snapshot.vacant.map(
        (one) => `  ${one.node.padEnd(vacantWidth)}  ${count(one.allowances, "allowance")}`,
      ),
    ),
    ...section(
      `violations: ${count(reportable.length, "reportable")}` +
        (carried > 0 ? `, ${String(carried)} carried by the baseline` : "") +
        (snapshot.stale.length > 0
          ? `, ${count(snapshot.stale.length, "stale entry", "stale entries")}`
          : "") +
        (reportable.length > 0 ? " — nearest the ground first" : ""),
      reportable.map(describe),
    ),
    ...(snapshot.unresolved.length === 0
      ? []
      : section(
          `unresolved: ${count(snapshot.unresolved.length, "import")} no rule can police`,
          snapshot.unresolved.map((one) => `  ${one.file} → ${one.specifier} (${one.detail})`),
        )),
    ...section(
      `slack: ${count(snapshot.slack.length, "allowance")} nothing imports through`,
      snapshot.slack.map(
        (one) =>
          `  ${one.node}: ${one.kind} ${JSON.stringify(one.entry)}` +
          (one.of === undefined ? "" : `  (via use, at ${count(one.of, "node")})`),
      ),
    ),
    ...(concentrated.length === 0
      ? []
      : section(
          `concentrated: ${count(concentrated.length, "allowance")} used at fewer than half the nodes granted`,
          concentrated.map(
            (one) =>
              `  ${one.fragment}: ${one.kind} ${JSON.stringify(one.entry)}  used at ${String(one.usedAt)} of ${count(one.of, "node")}`,
          ),
        )),
    "",
    `cycles: ${String(snapshot.cycles)}`,
    `baseline: ${count(snapshot.baseline.size, "entry", "entries")}`,
    `adoption: ${count(snapshot.adoption.unrestricted.length, "unrestricted tier")}, ${count(snapshot.adoption.partial.length, "partial tier")}`,
  ];
};

// The atlas: the tree as it is with the manifest laid over it — every walked
// file, every resolved edge with its status, every allowance resolved against
// the walk. What `check` computes and throws away, kept as one document for
// the renderers. Every judgement in it is an evaluator's; this only walks,
// parses, resolves and hands the answers to the core.
export const atlasDocument = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): Atlas => {
  const findings = collectFindings(policy, roots, { graph: true, edges: "all" });
  const report_ = reportOf(policy, roots, manifestPath, findings);
  const files = listSourceFiles(policy.repoRoot, roots, policy.languages);
  return atlasOf({
    manifest: report_.manifest,
    roots,
    nodes: policy.nodes,
    policy,
    files,
    edges: findings.edges,
    violations: report_.violations,
    bindingViolations: findings.bindingViolations,
    unresolved: findings.unresolved,
    graph: findings.graph ?? { files, edges: new Map() },
  });
};

export const atlas = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  manifestPath: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    yield* report([JSON.stringify(atlasDocument(policy, roots, manifestPath), null, 2)]);
  });

// One folder as a mermaid flowchart with the policy laid over it: the atlas,
// rolled up to that folder's children by the core, rendered as text. The
// flags say which folder and how deep; `diagram.ts` reads them.
export const diagram = (
  policy: LoadedPolicy,
  argv: ReadonlyArray<string>,
  manifestPath: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const parsed = parseDiagramFlags(argv);
    if (Result.isFailure(parsed)) return yield* Effect.fail(fail(parsed.failure));
    const flags = parsed.success;
    const view = diagramView(atlasDocument(policy, flags.roots, manifestPath), flags);
    if (view.members.length === 0) {
      return yield* Effect.fail(
        fail(
          `nothing to draw: ${view.focus === "" ? "the walk" : view.focus} holds no walked file. ` +
            `Name a folder under ${flags.roots.join(", ")} with --root.`,
        ),
      );
    }
    yield* report([renderMermaid(view).trimEnd()]);
  });

// What `facts` prints, as a value: the panel in the viewer shows it for a
// file, through the server.
const factsJsonOf = (policy: LoadedPolicy, relative: string): unknown => {
  const read = sourceFactsOf(policy.repoRoot, relative, policy.extractor);
  return {
    file: relative,
    edges: read.specifiers.map((specifier) => ({
      specifier,
      bindings: read.bindings.get(specifier) ?? [],
    })),
    memberSites: read.memberSites,
    exportSites: read.exportSites,
  };
};

// The viewer, over this repository's atlas. Served on a port, with the atlas
// rebuilt on every request so a rescan reflects an edit without a restart —
// the policy is reloaded too, so an edit to the manifest shows as well — or
// written to a folder with the atlas inlined, for a static host. The
// request handling is `explore.ts`'s and is tested there with no socket;
// this opens the port and hands it the routes.
export const explore = (
  policy: LoadedPolicy,
  argv: ReadonlyArray<string>,
  manifestPath: string,
  reload: () => Promise<LoadedPolicy>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const parsed = parseExploreFlags(argv);
    if (Result.isFailure(parsed)) return yield* Effect.fail(fail(parsed.failure));
    const flags = parsed.success;
    const assets = assetsDir();

    if (flags.out !== null) {
      const into = path.resolve(policy.repoRoot, flags.out);
      const atlas = atlasDocument(policy, flags.roots, manifestPath);
      yield* Effect.try({
        try: () => {
          writeStandalone(assets, atlas, into);
        },
        catch: (cause) => fail(`could not write ${into}: ${String(cause)}`),
      });
      return yield* report([
        `wrote the viewer with the atlas inlined to ${path.relative(policy.repoRoot, into)}/.`,
        `Open ${path.join(path.relative(policy.repoRoot, into), "index.html")} in a browser, or host the folder.`,
      ]);
    }

    let current = policy;
    const routes: ExploreRoutes = {
      atlas: async () => {
        // A manifest that no longer loads keeps the last policy that did; the
        // atlas is still drawn, and the error goes to the terminal.
        try {
          current = await reload();
        } catch (cause) {
          process.stderr.write(`could not reload the policy: ${String(cause)}\n`);
        }
        return atlasDocument(current, flags.roots, manifestPath);
      },
      facts: (file) => {
        const relative = file.replaceAll(path.sep, "/");
        const walked = listSourceFiles(current.repoRoot, flags.roots, current.languages);
        return Promise.resolve(walked.includes(relative) ? factsJsonOf(current, relative) : null);
      },
      assetsDir: assets,
    };

    const server = createServer((request, response) => {
      respond(routes, request.url ?? "/")
        .then((answer) => {
          response.writeHead(answer.status, answer.headers);
          response.end(answer.body);
        })
        .catch((cause: unknown) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(cause));
        });
    });
    const port = yield* Effect.callback<number, CliFailure>((resume) => {
      server.once("error", (cause) => {
        resume(
          Effect.fail(fail(`could not listen on port ${String(flags.port)}: ${cause.message}`)),
        );
      });
      server.listen(flags.port, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed(
            typeof address === "object" && address !== null ? address.port : flags.port,
          ),
        );
      });
    });
    const url = `http://127.0.0.1:${String(port)}/`;
    yield* report([
      `architecture explore: ${url}`,
      `  drawing ${flags.roots.join(", ")} against ${path.relative(policy.repoRoot, manifestPath)}.`,
      "  The atlas is rebuilt on every load; press ctrl-c to stop.",
    ]);
    if (flags.open) {
      yield* Effect.sync(() => {
        const opener =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "explorer"
              : "xdg-open";
        spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
      });
    }
    // The command is the server: it ends when the process does.
    return yield* Effect.never;
  });

export type ConformanceOptions = CheckOptions;

// The report of the tree against the manifest. Unlike `check`, it never
// fails: it is a measurement, and the manifest it measures against may be one
// the tree was never expected to satisfy yet — `--against` names a target.
// `ok` in the document says what `check` would have done.
export const conformance = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: ConformanceOptions,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const snapshot = snapshotOf(policy, roots, options.manifestPath);
    yield* report(
      options.format === "json" ? [JSON.stringify(snapshot, null, 2)] : renderSnapshot(snapshot),
    );
  });

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

    // The tier, before the rules: the deepest manifest node whose path holds
    // the file, and the sentence its author wrote about it.
    const governing_ = governingNode(policy.nodes, relative);

    yield* report([
      relative,
      "",
      governing_ === null
        ? "  governed by: no node (the manifest's tree does not reach this file)"
        : `  governed by: ${governing_.path}` +
          (governing_.file === undefined ? "" : ` (${governing_.file})`),
      ...(governing_?.message === undefined ? [] : [`      ${governing_.message}`]),
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

    // `--against <file>` measures the tree against a manifest other than the
    // repository's own — the target the team is moving toward. Only
    // `conformance` takes it: a `check` against a manifest nobody is held to
    // yet would fail for no one's benefit.
    const againstAt = rest.indexOf("--against");
    const against = againstAt === -1 ? undefined : rest[againstAt + 1];
    if (againstAt !== -1 && (against === undefined || against.startsWith("--"))) {
      return yield* Effect.fail(fail("--against needs a manifest path"));
    }
    if (against !== undefined && command !== "conformance") {
      return yield* Effect.fail(
        fail(`--against is a \`conformance\` flag; ${command} does not take it`),
      );
    }
    const manifestFilename = against ?? configFilename;

    const policy = yield* Effect.tryPromise({
      try: () => loadPolicyFromFile(repoRoot, manifestFilename),
      catch: (cause) => fail(String(cause)),
    });
    yield* Effect.sync(() => {
      for (const notice of policy.notices) process.stderr.write(`deprecated: ${notice}\n`);
    });

    const json = rest.includes("--json");
    const positional = rest.filter(
      (argument, index) =>
        argument !== "--json" &&
        argument !== "--against" &&
        (againstAt === -1 || index !== againstAt + 1),
    );
    const roots = positional.length > 0 ? positional : ["packages"];

    switch (command) {
      case "check":
        return yield* check(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, configFilename),
        });
      case "conformance":
        return yield* conformance(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, manifestFilename),
        });
      // The document is JSON in either spelling; `--json` is accepted so the
      // flag reads the same as on `check` and `conformance`.
      case "atlas":
        return yield* atlas(policy, roots, manifestPathOf(repoRoot, configFilename));
      // `diagram` reads its own flags: a folder to draw, a depth, the files
      // to centre on.
      case "diagram":
        return yield* diagram(policy, rest, manifestPathOf(repoRoot, configFilename));
      case "explore":
        return yield* explore(policy, rest, manifestPathOf(repoRoot, configFilename), () =>
          loadPolicyFromFile(repoRoot, configFilename),
        );
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
        const [file] = positional;
        if (file === undefined) return yield* Effect.fail(fail("facts needs a file path"));
        return yield* facts(policy, file, json ? "json" : "text");
      }
      default:
        return yield* Effect.fail(
          fail(
            `unknown command "${command}". Try: check [--json] | conformance [--json] [--against <manifest>] | atlas | diagram | explore | baseline | coverage | explain <file> | facts <file> [--json] | init | infer | migrate`,
          ),
        );
    }
  });

export const fingerprint = fingerprintOf;
