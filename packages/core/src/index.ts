// The core's public surface: the manifest vocabulary, the evaluators per
// family, the ports a language pack implements, and the loader that turns a
// manifest into a policy. A host composes these with a language pack and the
// live file system; a language pack implements the ports. Nothing here names a
// language. The fakes are under `@goodbones/core/testing`.
export {
  type Baseline,
  type BaselineFilter,
  baselineOf,
  decodeBaseline,
  EMPTY_BASELINE,
  makeBaselineFilter,
  serializeBaseline,
  staleEntriesOf,
  unbaselined,
} from "./core/baseline.js";
export {
  type CampaignHit,
  type CampaignInput,
  campaignsFailingTheirProbe,
  campaignsSelecting,
  compileCampaignRule,
  compileCampaignRules,
  type CompiledCampaign,
  type CompiledDetector,
  evaluateCampaign,
  evaluateCampaigns,
  explainCampaign,
  type FailedProbe,
  leafTermsOf,
  matchKeyOf,
  probeInputOf,
  type TermAnswer,
} from "./core/campaigns.js";
export {
  type Coverage,
  type CoverageFamily,
  type CoverageFloors,
  coverageOf,
  coverageShortfalls,
  fractionsOf,
  type Reach,
  reachOf,
  type Residue,
  residueOf,
  type Vacancy,
  vacancyOf,
} from "./core/coverage.js";
export {
  type BindingEdge,
  type CompiledExportRule,
  compileExportRule,
  compileExportRules,
  evaluateBindingEdge,
  evaluateSelectedBindings,
  exportRulesFailingTheirProbe,
  exportRulesSelecting,
  type ExportViolation,
  type SelectedExportRule,
} from "./core/exports.js";
export {
  type CompiledGraph,
  compileGraphRules,
  cyclesIn,
  EMPTY_GRAPH_RULES,
  evaluateGraph,
  type Graph,
  graphRulesFailingTheirProbe,
  hasGraphRules,
  heightOf,
} from "./core/graph.js";
export {
  type CompiledImportRule,
  compileImportRule,
  compileImportRules,
  evaluateImportEdge,
  evaluateResolvedEdge,
  evaluateSelectedEdge,
  type ImportEdge,
  probeTargetOf,
  rulesFailingTheirProbe,
  rulesSelecting,
  type SelectedRule,
} from "./core/imports.js";
export {
  allowed,
  decodeLedger,
  EMPTY_LEDGER,
  entryOf,
  isComplete,
  isStalled,
  type Ledger,
  ledgerArithmeticHolds,
  ledgerOf,
  Ledger as LedgerSchema,
  newEntriesOf,
  progressOf,
  pruned,
  reconcile,
  type Reconciliation,
  type Regression,
  type RegressionRecord,
  serializeLedger,
  staleEntriesOf as staleLedgerEntriesOf,
} from "./core/ledger.js";
export {
  type CompiledMemberRule,
  compileMemberRules,
  evaluateMemberSite,
  memberRulesFailingTheirProbe,
  memberRulesSelecting,
} from "./core/members.js";
export {
  type Concentration,
  type ObservedEdge,
  type Slack,
  slackOf,
  type SlackReport,
} from "./core/slack.js";
export {
  type CompiledStructure,
  compileStructure,
  EMPTY_STRUCTURE,
  evaluateStructure,
  requiredSiblingsOf,
  structureRulesFailingTheirProbe,
} from "./core/structure.js";
export {
  type CompiledSurfaceRule,
  compileSurfaceRules,
  evaluateSurface,
  surfaceRulesFailingTheirProbe,
  surfaceRulesSelecting,
} from "./core/surface.js";
export {
  type Allowance,
  type BindingKind,
  type CampaignProbe,
  type CampaignRule,
  type CampaignUnit,
  type DeclarationKind,
  type Detector,
  type ExportFix,
  type ExportRule,
  type GraphConfig,
  type GraphCycleRule,
  type GraphOrphanRule,
  type GraphReachRule,
  type ImportProbe,
  type ImportProbeTarget,
  type ImportRule,
  type MemberRule,
  type MemberSubject,
  type ProbeDiagnostic,
  type ResolveConfig,
  type ResolveScope,
  type StructureConfig,
  type SurfaceRule,
} from "./domain/architecture-config.js";
export {
  ConfigInvalid,
  ImportUnresolved,
  PatternInvalid,
  ScopeInvalid,
} from "./domain/architecture-error.js";
export {
  type Binding,
  type ExportSite,
  type MemberSite,
  type SourceFacts,
} from "./domain/facts.js";
export {
  type ManifestLocator,
  type ManifestPath,
  type ManifestPosition,
  renderManifestPath,
} from "./domain/manifest-location.js";
export {
  type Diagnostic,
  indexByFile,
  parseReport,
  type ParseReportOptions,
  type ReportFormat,
} from "./domain/report.js";
export {
  decodeSnapshot,
  type Snapshot,
  SNAPSHOT_SCHEMA_ID,
  SNAPSHOT_VERSION,
  type SnapshotCampaign,
  type SnapshotConcentration,
  snapshotJsonSchema,
  Snapshot as SnapshotSchema,
  type SnapshotSlack,
  type SnapshotVacancy,
  type SnapshotViolation,
} from "./domain/snapshot.js";
export {
  fingerprintOf,
  formatMessage,
  type Violation,
  type ViolationKind,
} from "./domain/violation.js";
export {
  loadCampaignFunctions,
  type LoadedCampaignFunctions,
} from "./infrastructure/campaign-functions.js";
export { makeFileSystemLive } from "./infrastructure/file-system-live.js";
export {
  findManifestFile,
  formatManifestYaml,
  MANIFEST_FILENAMES,
  type ManifestFile,
  readManifestFile,
} from "./infrastructure/manifest-file.js";
export {
  expandIncludes,
  type IncludedManifest,
  type IncludeReader,
  type SourceDocument,
} from "./infrastructure/manifest-include.js";
export { makeReportSourceLive } from "./infrastructure/report-source-live.js";
export {
  listPackageRoots,
  listSourceFiles,
  type PackagedLanguage,
  type PackageRoot,
  type WalkedLanguage,
} from "./infrastructure/walk.js";
export { type LoadedPolicy, loadPolicy, type LoadPolicyInput } from "./load/policy.js";
export {
  type LoweredRules,
  lowerManifest,
  type LowerOptions,
  type ProbeLanguage,
} from "./manifest/compile.js";
export {
  type ExpandedManifest,
  type ExpandIssue,
  expandManifest,
  type Origin,
  originOf,
  type Substitution,
} from "./manifest/expand.js";
export {
  type Candidate,
  candidatesOf,
  type Generalization,
  type InferInput,
  inferManifest,
  type InferOptions,
  type InferPackage,
  type Inferred,
  type InferredTarget,
  singularOf,
} from "./manifest/infer.js";
export {
  MANIFEST_NODE_SCHEMA_ID,
  MANIFEST_SCHEMA_ID,
  manifestJsonSchema,
  manifestNodeJsonSchema,
} from "./manifest/json-schema.js";
export {
  type CampaignSpec,
  type DecodedManifest,
  decodeManifest,
  type DecodeManifestOptions,
  DEFAULT_LEDGER_DIR,
  type DetectorSpec,
  durationMs,
  type Manifest,
  type ManifestNode,
  Manifest as ManifestSchema,
} from "./manifest/manifest.js";
export {
  type CampaignPredicate,
  type CampaignPredicateInput,
  type CampaignSubject,
  type Range,
} from "./ports/campaign-predicate.js";
export { type FactExtractor } from "./ports/fact-extractor.js";
export { type FileSystem } from "./ports/file-system.js";
export { type Language } from "./ports/language.js";
export {
  type DependencyKind,
  type ModuleResolver,
  type ResolvedTarget,
} from "./ports/module-resolver.js";
export { NO_REPORTS, type ReportSource, type ReportSpec } from "./ports/report-source.js";
export {
  type Position,
  type SyntaxMatch,
  type SyntaxMatcher,
  type SyntaxTree,
} from "./ports/syntax-matcher.js";
