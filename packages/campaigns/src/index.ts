// The campaigns family: a refactor tracked as an object in the repository —
// `objectives`, each a detector with a ledger that only shrinks on its own,
// over `sectors` the code declares through a `perimeter`, through ordered
// `phases` toward an end.
//
// It is a family @goodbones/core does not own. A host composes it:
//
//   loadPolicy({ …, extensions: [campaignsExtension({ functions, reports })] })
//
// and reads its state back with `campaignsOf(policy)`. The core carries the
// value and never looks inside it, which is what keeps a policy that only
// states architecture from paying for any of this.
export {
  concedeMeasure,
  explainCampaignLines,
  growsFor,
  ledgeredFilter,
  ledgerPhaseOf,
  sendBack,
} from "./compat/policy-signatures.js";
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
  compileCampaignRule,
  compileCampaignRules,
  type CompiledCampaign,
  type CompiledDetector,
  type CompiledMeasure,
  type CompiledMeasureSource,
  type CompiledObjective,
  type CompiledPerimeter,
  type CompiledSectorTerm,
  compileObjective,
  candidatesOf as detectorCandidatesOf,
  detectorOf,
  distanceToTarget,
  evaluateObjective,
  evaluateObjectives,
  explainDetector,
  explainObjective,
  type FailedProbe,
  leafTermsOf,
  matchKeyOf,
  measureDetectorsOf,
  measureFile,
  type MeasureParts,
  needsSyntax,
  numberFromOutput,
  perFileMeasuresOf,
  perFileObjectivesOf,
  probeInputOf,
  reportSpecsOf,
  roundMeasure,
  type TermAnswer,
  valueOfParts,
} from "./core/campaigns.js";
export {
  compareResidue,
  derivePhase,
  type Direction,
  directionOf,
  donePhaseOf,
  growsAt,
  inWindow,
  isDefinedPhase,
  isOpenPhase,
  isShut,
  ledgeredFor,
  LEGACY_PHASE,
  objectivesInWindow,
  onTouchOf,
  type Residue as ResidueVector,
  type SectorPosition,
  sharedWindow,
  UNPLACED,
  type Window,
  windowOf,
  worsened,
} from "./core/phases.js";
export {
  discoverSectors,
  fixedPrefixOf,
  IMPLICIT_SECTOR,
  isShared,
  LEGACY_SECTOR,
  membershipOf,
  parseSectorMarker,
  type Placement,
  rootOf,
  type Sector,
  SECTOR_HOLDOUT,
  type SectorDiscovery,
  entryOf as sectorEntryOf,
  type SectorIndex,
  type SectorMarker,
  sectorNamed,
  SHARED_SECTOR,
  withoutExtension,
} from "./core/sectors.js";
export {
  type CampaignProbe,
  type CampaignProbes,
  type CampaignRule,
  type CampaignUnit,
  type Detector,
  type Holdout,
  type Measure,
  type MeasureDirection,
  type MeasureSource,
  type ObjectiveRule,
  type OnTouch,
  type PerimeterRule,
  type PhaseConcession,
  type PhaseRule,
  type ProbeDiagnostic,
  type SectorTerm,
} from "./domain/config.js";
export {
  type Diagnostic,
  indexByFile,
  parseReport,
  type ParseReportOptions,
  type ReportFormat,
  uniqueDiagnostics,
} from "./domain/report.js";
export {
  loadCampaignFunctions,
  type LoadedCampaignFunctions,
} from "./infrastructure/campaign-functions.js";
export { makeReportSourceLive } from "./infrastructure/report-source-live.js";
export {
  type CampaignClients,
  type CampaignPolicy,
  CAMPAIGNS_EXTENSION_ID,
  campaignsOf,
  type LedgerReaders,
  type LedgerRepositories,
  widenedExtensions,
} from "./load/campaign-policy.js";
export { campaignsExtension, type CampaignsExtensionOptions } from "./load/extension.js";
export {
  END_STATE_ROOT,
  endStateObjectiveId,
  lowerCampaigns,
  lowerEndState,
} from "./manifest/lower.js";
export {
  type CampaignProbeSpec,
  type CampaignProbesSpec,
  CampaignsManifest,
  type CampaignSpec,
  DEFAULT_LEDGER_DIR,
  type DetectorSpec,
  durationMs,
  type EndStateSpec,
  type MeasureSourceSpec,
  type ObjectiveSpec,
  type PerimeterSpec,
  type PhaseSpec,
  type SectorTermSpec,
  type SyntaxTermSpec,
} from "./manifest/spec.js";
export {
  type BaseSide,
  baseSideOf,
} from "./modules/ledgers/domain/base-side/base-side.value-object.js";
export type { Commit } from "./modules/ledgers/domain/git/commit.value-object.js";
export {
  type Diff,
  distanceToHunks,
  type Hunk,
  parseDiff,
} from "./modules/ledgers/domain/git/diff.value-object.js";
export { LedgerUnreadable } from "./modules/ledgers/domain/ledger/ledger.errors.js";
export type { LedgerId } from "./modules/ledgers/domain/ledger/ledger.id.js";
export {
  type Concession,
  EMPTY_LEDGER,
  type Ledger,
  Ledger as LedgerSchema,
  type SectorLedger,
} from "./modules/ledgers/domain/ledger/ledger.root.js";
export {
  allowedOf,
  clearedOf,
  clearedSector,
  closedOf,
  concededSector,
  type ConcessionRecord,
  deltaOf,
  holdoutsOf,
  initialOf,
  isComplete,
  isStalled,
  lastClearedOf,
  ledgerArithmeticHolds,
  progressOf,
  rebaselinedSector,
  reconcileSector,
  type Reconciliation,
  sectorArithmeticHolds,
} from "./modules/ledgers/domain/ledger/ledger.root-ops.js";
export {
  EMPTY_MEASURE_LEDGER,
  type MeasureConcession,
  type MeasureLedger,
  MeasureLedger as MeasureLedgerSchema,
  type MeasureSectorLedger,
} from "./modules/ledgers/domain/measure-ledger/measure-ledger.root.js";
export {
  clearedMeasure,
  concededMeasure,
  lastImprovedOf,
  measureArithmeticHolds,
  measureLedgerArithmeticHolds,
  measureProgressOf,
  measureStandingOf,
  recordedOf,
} from "./modules/ledgers/domain/measure-ledger/measure-ledger.root-ops.js";
export { PlanUnreadable } from "./modules/ledgers/domain/plan/plan.errors.js";
export type { PlanRecord } from "./modules/ledgers/domain/plan/plan.root.js";
export { type PlanDiff, planDiffOf, planOf } from "./modules/ledgers/domain/plan/plan.root-ops.js";
export type { BaseSidesClient } from "./modules/ledgers/domain/ports/clients/base-sides.client.js";
export type { GitClient } from "./modules/ledgers/domain/ports/clients/git.client.js";
export type { MeasureCommandsClient } from "./modules/ledgers/domain/ports/clients/measure-commands.client.js";
export type { WorkspaceClient } from "./modules/ledgers/domain/ports/clients/workspace.client.js";
export type { ObjectiveLedgersRepository } from "./modules/ledgers/domain/ports/repositories/objective-ledgers.repository.js";
export type { PlansRepository } from "./modules/ledgers/domain/ports/repositories/plans.repository.js";
export type { SectorRecordsRepository } from "./modules/ledgers/domain/ports/repositories/sector-records.repository.js";
export { SectorRecordUnreadable } from "./modules/ledgers/domain/sector-record/sector-record.errors.js";
export {
  type Attestation,
  EMPTY_SECTOR_RECORD,
  type Note,
  type SectorRecord,
} from "./modules/ledgers/domain/sector-record/sector-record.root.js";
export {
  attestedRecord,
  NOTE_CAP,
  NOTE_LENGTH,
  notedRecord,
  positionOf,
  reachedRecord,
  sectorClockOf,
} from "./modules/ledgers/domain/sector-record/sector-record.root-ops.js";
export { type Readers } from "./modules/ledgers/domain/services/campaign-evaluation.service.js";
export {
  type CampaignLedgers,
  HOLDOUT_CAP,
  ledgerKeyOf,
  type LedgerOverrides,
} from "./modules/ledgers/domain/services/campaign-ledgers.service.js";
export {
  campaignFailuresOf,
  type CampaignReport,
  type ObjectiveReport,
  type SectorObjectiveReport,
  type SectorReport,
} from "./modules/ledgers/domain/services/campaign-report.service.js";
export {
  type ConcessionReceipt,
  type SentBack,
} from "./modules/ledgers/domain/services/concession.service.js";
export {
  authorOf,
  commitOf,
  commitsTouching,
  gitPathsOf,
  materializeTree,
  readDiff,
  textAt,
} from "./modules/ledgers/infrastructure/clients/git.client-live.js";
export {
  decodeLedger,
  decodeMeasureLedger,
  isLegacyLedger,
  isMeasureLedger,
  ledgerPathOf,
  legacyLedgerPathOf,
  serializeLedger,
  serializeMeasureLedger,
} from "./modules/ledgers/infrastructure/repositories/ledger.mapper.js";
export {
  decodePlanRecord,
  planPathOf,
  serializePlanRecord,
} from "./modules/ledgers/infrastructure/repositories/plan.mapper.js";
export {
  decodeSectorRecord,
  encodeSectorName,
  sectorRecordPathOf,
  serializeSectorRecord,
} from "./modules/ledgers/infrastructure/repositories/sector-record.mapper.js";
export {
  attestSectorUseCase as attest,
  attestSectorUseCase,
} from "./modules/ledgers/use-cases/attest-sector.use-case.js";
export type { CampaignExplanation } from "./modules/ledgers/use-cases/campaign-explanation.result.js";
export type { ClearOutcome } from "./modules/ledgers/use-cases/clear-objectives.result.js";
export {
  clearObjectivesUseCase as clear,
  clearObjectivesUseCase,
} from "./modules/ledgers/use-cases/clear-objectives.use-case.js";
export type { ConcedeOutcome } from "./modules/ledgers/use-cases/concede-objective.result.js";
export {
  concedeObjectiveUseCase as concede,
  concedeObjectiveUseCase,
} from "./modules/ledgers/use-cases/concede-objective.use-case.js";
export {
  evaluateCampaignsUseCase as evaluateCampaigns,
  evaluateCampaignsUseCase,
} from "./modules/ledgers/use-cases/evaluate-campaigns.use-case.js";
export { explainCampaignUseCase } from "./modules/ledgers/use-cases/explain-campaign.use-case.js";
export type { HistoryRow } from "./modules/ledgers/use-cases/history.result.js";
export {
  noteSectorUseCase as note,
  noteSectorUseCase,
} from "./modules/ledgers/use-cases/note-sector.use-case.js";
export type {
  Ask,
  Nudge,
  NudgeHoldout,
  SectorNudge,
  Verdict,
} from "./modules/ledgers/use-cases/nudge.result.js";
export {
  nudgeChangesUseCase,
  nudgeChangesUseCase as nudgeOf,
} from "./modules/ledgers/use-cases/nudge-changes.use-case.js";
export {
  previewSectorMovesUseCase,
  previewSectorMovesUseCase as sectorMovesOf,
} from "./modules/ledgers/use-cases/preview-sector-moves.use-case.js";
export {
  readBaseSideUseCase as baseSideAt,
  readBaseSideUseCase,
} from "./modules/ledgers/use-cases/read-base-side.use-case.js";
export {
  replayHistoryUseCase as historyOf,
  replayHistoryUseCase,
} from "./modules/ledgers/use-cases/replay-history.use-case.js";
export {
  reportCampaignsUseCase as campaignReportsOf,
  reportCampaignsUseCase,
} from "./modules/ledgers/use-cases/report-campaigns.use-case.js";
export type { SectorMove } from "./modules/ledgers/use-cases/sector-moves.result.js";
export type { SectorView } from "./modules/ledgers/use-cases/sector-view.result.js";
export {
  snapshotCampaignsUseCase as snapshotCampaignsOf,
  snapshotCampaignsUseCase,
} from "./modules/ledgers/use-cases/snapshot-campaigns.use-case.js";
export {
  viewSectorUseCase as sectorViewOf,
  viewSectorUseCase,
} from "./modules/ledgers/use-cases/view-sector.use-case.js";
export { type CampaignMeasure } from "./ports/campaign-measure.js";
export {
  type CampaignPredicate,
  type CampaignPredicateInput,
  type CampaignSubject,
  type Range,
} from "./ports/campaign-predicate.js";
export {
  NO_REPORTS,
  type ReportSource,
  reportSourcesOf,
  type ReportSpec,
} from "./ports/report-source.js";
export { renderCampaignExplanation } from "./presentation/campaign-explanation.presenter.js";
export { renderCampaignReports } from "./presentation/campaign-reports.presenter.js";
export { renderCampaignRows } from "./presentation/campaign-rows.presenter.js";
export { renderHistory } from "./presentation/history.presenter.js";
export { renderNudge } from "./presentation/nudge.presenter.js";
export { renderSectorView } from "./presentation/sector-view.presenter.js";
