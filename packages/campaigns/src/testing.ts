// The fake for this family's one port, for tests that state what another
// tool reported and never run it. The fakes for the core's ports are under
// `@goodbones/core/testing`.
export { makeReportSourceFake } from "./infrastructure/report-source-fake.js";
export {
  makeObjectiveLedgersRepositoryFake,
  type ObjectiveLedgersRepositoryFake,
} from "./modules/ledgers/infrastructure/repositories/objective-ledgers.repository-fake.js";
export {
  makePlansRepositoryFake,
  type PlansRepositoryFake,
} from "./modules/ledgers/infrastructure/repositories/plans.repository-fake.js";
export {
  makeSectorRecordsRepositoryFake,
  type SectorRecordsRepositoryFake,
} from "./modules/ledgers/infrastructure/repositories/sector-records.repository-fake.js";
