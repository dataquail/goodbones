import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule, ObjectiveRule } from "../domain/architecture-config.js";
import type { SourceFacts } from "../domain/facts.js";
import { makeFileSystemFake } from "../infrastructure/file-system-fake.js";
import { makeModuleResolverFake } from "../infrastructure/module-resolver-fake.js";
import { makeReportSourceFake } from "../infrastructure/report-source-fake.js";
import { evaluateCampaign, hitsInWindow, towardNextOf } from "./campaign-state.js";
import { type CampaignInput, compileCampaignRule, type CompiledCampaign } from "./campaigns.js";
import { EMPTY_SECTOR_RECORD, reachedRecord, type SectorRecord } from "./ledger.js";
import { LEGACY_SECTOR } from "./sectors.js";

// The manifest's glob translation is the manifest tier's; a core test
// stands in one just wide enough for a marker's `owns`.
const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replace(/[.]/g, "\\.")
      .replace(/\*\*/g, ".*")
      .replace(/(?<!\.)\*/g, "[^/]*")}`,
  );

const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

// Files are judged by their text: a `content` term over a word.
const inputOf =
  (texts: Readonly<Record<string, string>>) =>
  (file: string): CampaignInput => ({
    file,
    text: texts[file] ?? "",
    facts: NOTHING,
    resolver: makeModuleResolverFake({}),
    fileSystem: makeFileSystemFake([]),
    syntax: null,
    functions: new Map(),
    reports: makeReportSourceFake({}),
  });

const contentObjective = (
  id: string,
  word: string,
  extra: Partial<ObjectiveRule> = {},
): ObjectiveRule => ({
  name: `campaign/c/${id}`,
  id,
  campaign: "c",
  message: `no ${word}`,
  holdout: "file",
  match: { content: { regex: word } },
  probes: { fires: [], ignores: [] },
  ...extra,
});

// A presence: the sector is the holdout until one of its files says the word.
const hasObjective = (id: string, word: string): ObjectiveRule => ({
  name: `campaign/c/${id}`,
  id,
  campaign: "c",
  message: `has ${word}`,
  holdout: "sector",
  sector: { has: { content: { regex: word } } },
  probes: { fires: [], ignores: [] },
});

const campaign = (overrides: Partial<CampaignRule>): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/c",
    id: "c",
    scope: "^src/",
    extensions: [],
    phases: [],
    objectives: [],
    onComplete: "keep",
    ...overrides,
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const phase = (id: string, objectives: ReadonlyArray<string>, intent?: string) => ({
  id,
  objectives,
  attested: false,
  concessions: [],
  hash: id,
  ...(intent === undefined ? {} : { intent }),
});

describe("one campaign over its files", () => {
  const texts = {
    "src/billing/context.ts": "export const sector = { name: 'billing' };",
    "src/billing/a.ts": "knex io",
    "src/billing/b.ts": "knex",
    "src/orders/context.ts": "",
    "src/orders/a.ts": "clean",
    "src/services/old.ts": "io knex",
  };
  const rule = campaign({
    perimeter: { kind: "marker", marker: "^.*/context\\.ts$" },
    phases: [phase("domain", ["no-io"]), phase("repository", ["no-knex"]), phase("done", [], "?")],
    objectives: [
      contentObjective("no-io", "io"),
      contentObjective("no-knex", "knex"),
      hasObjective("has-test", "test"),
    ],
  });
  const evaluation = evaluateCampaign(rule, {
    files: Object.keys(texts),
    inputOf: inputOf(texts),
    readText: (file) => (file in texts ? texts[file as keyof typeof texts] : null),
    globToRegExp,
    recordOf: () => undefined,
  });

  it("places every hit in its sector, keyed from the sector's root", () => {
    expect(
      evaluation.hits
        .map((hit) => [hit.sector, hit.objective, hit.entry])
        .sort((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([
      ["billing", "has-test", "~"],
      ["billing", "no-io", "a.ts"],
      ["billing", "no-knex", "a.ts"],
      ["billing", "no-knex", "b.ts"],
      ["legacy", "has-test", "~"],
      ["legacy", "no-io", "src/services/old.ts"],
      ["legacy", "no-knex", "src/services/old.ts"],
      ["orders", "has-test", "~"],
    ]);
  });

  it("derives each sector's phase, and the legacy stands at the first", () => {
    const phases = [...evaluation.sectors.values()].map((one) => [one.name, one.phase]);
    expect(phases).toEqual([
      ["billing", 0],
      ["orders", 2],
      [LEGACY_SECTOR, 0],
    ]);
    expect(evaluation.sectors.get("billing")?.residue).toEqual({ "no-io": 1, "has-test": 1 });
    expect(evaluation.sectors.get("orders")?.residue).toEqual({
      "no-io": 0,
      "no-knex": 0,
      "has-test": 1,
    });
    // The legacy is held to the first phase's objectives and the unnamed one.
    expect(evaluation.sectors.get(LEGACY_SECTOR)?.residue).toEqual({ "no-io": 1, "has-test": 1 });
  });

  it("counts only the hits whose objective is in window for the sector", () => {
    const counted = hitsInWindow(evaluation).map((hit) => `${hit.sector}/${hit.objective}`);
    expect(counted).not.toContain("billing/no-knex");
    expect(counted).not.toContain("legacy/no-knex");
    expect(counted).toContain("billing/no-io");
  });

  it("reports the residue toward the next phase: the current phase's objectives with holdouts", () => {
    const billing = evaluation.sectors.get("billing");
    const orders = evaluation.sectors.get("orders");
    if (billing === undefined || orders === undefined) throw new Error("sectors missing");
    expect(towardNextOf(rule, billing)).toEqual({ "no-io": 1 });
    expect(towardNextOf(rule, orders)).toEqual({});
  });

  it("reads the sector's record: a passed window stays shut", () => {
    const flagged = campaign({
      perimeter: { kind: "marker", marker: "^.*/context\\.ts$" },
      phases: [phase("a", ["has-flag"]), phase("b", ["no-flag"])],
      objectives: [
        contentObjective("has-flag", "flag", { until: "b" }),
        contentObjective("no-flag", "flag"),
      ],
    });
    const record: SectorRecord = reachedRecord(
      EMPTY_SECTOR_RECORD("c", "billing", 0),
      flagged,
      1,
      0,
    );
    const placed = evaluateCampaign(flagged, {
      files: ["src/billing/context.ts", "src/billing/a.ts"],
      inputOf: inputOf({ "src/billing/a.ts": "flag" }),
      readText: () => "",
      globToRegExp,
      recordOf: (sector: string) => (sector === "billing" ? record : undefined),
    });
    expect(placed.sectors.get("billing")?.phase).toBe(1);
    expect(placed.sectors.get("billing")?.residue).toEqual({ "no-flag": 1 });
  });
});
