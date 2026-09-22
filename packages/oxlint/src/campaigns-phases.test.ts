import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  type CampaignPolicy,
  type CampaignRule,
  CAMPAIGNS_EXTENSION_ID,
  clearedSector,
  compileCampaignRules,
  EMPTY_LEDGER,
  EMPTY_SECTOR_RECORD,
  type Ledger,
  ledgerKeyOf,
  NO_REPORTS,
  reachedRecord,
  type SectorRecord,
} from "@goodbones/campaigns";
import {
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  type LoadedPolicy,
  makeBaselineFilter,
} from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { makeCampaignsRule } from "./campaigns-rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

// The plugin sees one file, so a sector's phase comes from the ledgers: an
// objective named by a later phase is not reported while the sector's
// current phase still has residue, a holdout the ledger carries relative
// to the sector's root is silent, and a window the record says the sector
// has passed stays shut.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const rules: ReadonlyArray<CampaignRule> = [
  {
    name: "campaign/ladder",
    id: "ladder",
    scope: "^phased/",
    extensions: [],
    perimeter: { kind: "glob", glob: "^phased/[^/]+/" },
    phases: [
      { id: "a", objectives: ["no-io"], attested: false, concessions: [], hash: "a" },
      { id: "b", objectives: ["no-knex"], attested: false, concessions: [], hash: "b" },
      { id: "c", objectives: ["no-flag"], attested: false, concessions: [], hash: "c" },
    ],
    objectives: [
      {
        name: "campaign/ladder/no-io",
        id: "no-io",
        campaign: "ladder",
        message: "No I/O.",
        holdout: "match",
        match: { syntax: { rule: { pattern: "readFileSync($$$)" } } },
        probes: { fires: [], ignores: [] },
      },
      {
        name: "campaign/ladder/no-knex",
        id: "no-knex",
        campaign: "ladder",
        message: "Behind the port.",
        holdout: "match",
        match: { syntax: { rule: { pattern: "knex($$$)" } } },
        probes: { fires: [], ignores: [] },
      },
      {
        name: "campaign/ladder/no-flag",
        id: "no-flag",
        campaign: "ladder",
        message: "Drop the flag.",
        holdout: "file",
        match: { content: { regex: "dualWrite" } },
        until: "c",
        probes: { fires: [], ignores: [] },
      },
    ],
    onComplete: "keep",
  },
];

const compiled = compileCampaignRules(rules);
if (Result.isFailure(compiled)) throw compiled.failure;

const policyWith = (
  ledgers: ReadonlyMap<string, Ledger>,
  records: ReadonlyMap<string, SectorRecord> = new Map(),
): LoadedPolicy => ({
  repoRoot,
  config: { resolve: { scopes: [{ files: "", language: "typescript" }] }, tree: {} },
  importRules: [],
  exportRules: [],
  memberRules: [],
  surfaceRules: [],
  graph: EMPTY_GRAPH_RULES,
  adoption: { unrestricted: [], partial: [] },
  structure: EMPTY_STRUCTURE,
  extensions: new Map<string, unknown>([
    [
      CAMPAIGNS_EXTENSION_ID,
      {
        campaignRules: compiled.success,
        ledgers,
        legacyLedgers: new Map(),
        sectorRecords: records,
        plans: new Map(),
        ledgerDir: ".architecture-campaigns",
        functions: new Map(),
        reports: NO_REPORTS,
      } satisfies CampaignPolicy,
    ],
  ]),
  routeFor: () => undefined,
  now: 0,
  syntax: astGrepMatcher(),
  fileSystem: makeFileSystemFake([]),
  languages: [],
  extractor: makeFactExtractorFake({}),
  resolver: makeModuleResolverFake({}),
  ignoreUnresolved: [],
  notices: [],
  baseline: makeBaselineFilter(EMPTY_BASELINE),
});

const filename = path.join(repoRoot, "phased/billing/service.ts");
const CODE = "export function f() { readFileSync('x'); return knex('y'); }\n";

const ledger = (
  objective: string,
  sector: string,
  holdouts: ReadonlyArray<string>,
): [string, Ledger] => [
  ledgerKeyOf("ladder", objective),
  clearedSector(EMPTY_LEDGER("ladder", objective, 0), sector, holdouts, "match", 0, "inside"),
];

// The sector's record, as `clear` writes it, placed at a phase.
const [ladder] = compiled.success;
if (ladder === undefined) throw new Error("no campaign");
const placed = (phase: number): ReadonlyMap<string, SectorRecord> =>
  new Map([
    [
      ledgerKeyOf("ladder", "phased/billing"),
      reachedRecord(EMPTY_SECTOR_RECORD("ladder", "phased/billing", 0), ladder, phase, 0),
    ],
  ]);

// No `clear` has placed the sector: it stands at the first phase, and that
// phase's hit is unrecorded; the second phase's is not in window.
new RuleTester({ cwd: repoRoot }).run(
  "phases: a sector at its first phase reports that phase's objective only",
  makeCampaignsRule(policyWith(new Map())),
  {
    valid: [],
    invalid: [{ code: CODE, filename, errors: [{ message: "[campaign/ladder/no-io] No I/O." }] }],
  },
);

// With the I/O holdout ledgered under the sector's root-relative key, the
// sector still stands at `a` (a holdout remains), and is silent.
new RuleTester({ cwd: repoRoot }).run(
  "phases: a ledgered holdout is silent, and holds the sector at its phase",
  makeCampaignsRule(
    policyWith(new Map([ledger("no-io", "phased/billing", ["service.ts#f#00000000"])]), placed(0)),
  ),
  {
    valid: [{ code: CODE, filename }],
    invalid: [],
  },
);

// With `no-io` cleared for the sector, it stands at `b`: the knex call is
// the unrecorded hit now, and the flag objective — named by `c` — is not.
new RuleTester({ cwd: repoRoot }).run(
  "phases: a sector past its first phase is held to the next one",
  makeCampaignsRule(policyWith(new Map([ledger("no-io", "phased/billing", [])]), placed(1))),
  {
    valid: [],
    invalid: [
      {
        code: "export function f() { return knex('y'); }\nconst flag = dualWrite;\n",
        filename,
        errors: [{ message: "[campaign/ladder/no-knex] Behind the port." }],
      },
    ],
  },
);

// A file outside the perimeter's globs is legacy, held to the first phase.
new RuleTester({ cwd: repoRoot }).run(
  "phases: the legacy stands at the first phase",
  makeCampaignsRule(policyWith(new Map())),
  {
    valid: [
      { code: "export const x = knex('y');", filename: path.join(repoRoot, "phased/stray.ts") },
    ],
    invalid: [
      {
        code: "export const x = readFileSync('y');",
        filename: path.join(repoRoot, "phased/stray.ts"),
        errors: [{ message: "[campaign/ladder/no-io] No I/O." }],
      },
    ],
  },
);

// The record says the sector reached `c`: the flag's window is shut for it
// even though a plan edit sent it back to `a`.
new RuleTester({ cwd: repoRoot }).run(
  "phases: a passed window never reopens",
  makeCampaignsRule(
    policyWith(
      new Map([ledger("no-io", "phased/billing", []), ledger("no-knex", "phased/billing", [])]),
      placed(2),
    ),
  ),
  {
    valid: [{ code: "const flag = dualWrite;\n", filename }],
    invalid: [],
  },
);
