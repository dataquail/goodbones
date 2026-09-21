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
  type CampaignEvaluation,
  type CampaignEvaluationInput,
  evaluateCampaign,
  hitsInWindow,
  type ObjectiveHit,
  type SectorState,
  towardNextOf,
} from "./core/campaign-state.js";
export {
  type CampaignHit,
  type CampaignInput,
  campaignsFailingTheirProbe,
  campaignsSelecting,
  candidatesOf as detectorCandidatesOf,
  compileCampaignRule,
  compileCampaignRules,
  type CompiledCampaign,
  type CompiledDetector,
  type CompiledObjective,
  type CompiledPerimeter,
  type CompiledSectorTerm,
  compileObjective,
  detectorOf,
  evaluateObjective,
  evaluateObjectives,
  explainDetector,
  explainObjective,
  type FailedProbe,
  leafTermsOf,
  matchKeyOf,
  needsSyntax,
  perFileObjectivesOf,
  probeInputOf,
  reportSpecsOf,
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
  allowedOf,
  type Attestation,
  attestedRecord,
  clearedOf,
  clearedSector,
  closedOf,
  type Concession,
  type ConcessionRecord,
  concededSector,
  decodeLedger,
  decodePlanRecord,
  decodeSectorRecord,
  deltaOf,
  EMPTY_LEDGER,
  EMPTY_SECTOR_RECORD,
  encodeSectorName,
  holdoutsOf,
  initialOf,
  isComplete,
  isLegacyLedger,
  isStalled,
  lastClearedOf,
  type Ledger,
  ledgerArithmeticHolds,
  ledgerPathOf,
  Ledger as LedgerSchema,
  legacyLedgerPathOf,
  NOTE_CAP,
  NOTE_LENGTH,
  type Note,
  notedRecord,
  type PlanDiff,
  planDiffOf,
  planOf,
  planPathOf,
  type PlanRecord,
  positionOf,
  progressOf,
  reachedRecord,
  rebaselinedSector,
  reconcileSector,
  type Reconciliation,
  sectorArithmeticHolds,
  sectorClockOf,
  type SectorLedger,
  type SectorRecord,
  sectorRecordPathOf,
  serializeLedger,
  serializePlanRecord,
  serializeSectorRecord,
} from "./core/ledger.js";
export {
  compareResidue,
  derivePhase,
  type Direction,
  donePhaseOf,
  inWindow,
  isDefinedPhase,
  isOpenPhase,
  isShut,
  LEGACY_PHASE,
  objectivesInWindow,
  onTouchOf,
  type Residue as ResidueVector,
  type SectorPosition,
  UNPLACED,
  type Window,
  windowOf,
  worsened,
} from "./core/phases.js";
export {
  discoverSectors,
  entryOf as sectorEntryOf,
  fixedPrefixOf,
  IMPLICIT_SECTOR,
  LEGACY_SECTOR,
  parseSectorMarker,
  rootOf,
  type Sector,
  type SectorDiscovery,
  SECTOR_HOLDOUT,
  type SectorIndex,
  type SectorMarker,
  sectorNamed,
  withoutExtension,
} from "./core/sectors.js";
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
  type CampaignProbes,
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
  ReportUnavailable,
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
  uniqueDiagnostics,
} from "./domain/report.js";
export {
  CONFORMANCE_MEASURES,
  type ConformanceMeasure,
  decodeSnapshot,
  type Snapshot,
  SNAPSHOT_SCHEMA_ID,
  SNAPSHOT_VERSION,
  type SnapshotCampaign,
  type SnapshotObjective,
  type SnapshotPhase,
  type SnapshotSector,
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
  listWorkspaceProjects,
  type PackagedLanguage,
  type PackageRoot,
  type WalkedLanguage,
  type WorkspaceProject,
} from "./infrastructure/walk.js";
export {
  ledgerKeyOf,
  type LoadedPolicy,
  loadPolicy,
  type LoadPolicyInput,
} from "./load/policy.js";
export {
  END_STATE_ROOT,
  endStateObjectiveId,
  lowerEndState,
  type LoweredRules,
  lowerManifest,
  type LowerOptions,
  type ProbeLanguage,
} from "./manifest/compile.js";
export { globToRegExp } from "./manifest/glob.js";
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
  type ObjectiveSpec,
  type PerimeterSpec,
  type PhaseSpec,
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
export {
  NO_REPORTS,
  type ReportSource,
  reportSourcesOf,
  type ReportSpec,
} from "./ports/report-source.js";
export {
  type Position,
  type SyntaxMatch,
  type SyntaxMatcher,
  type SyntaxTree,
} from "./ports/syntax-matcher.js";
