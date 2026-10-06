import {
  campaignReportsOf,
  campaignsExtension,
  evaluateCampaigns,
  type Nudge,
} from "@goodbones/campaigns";
import { makeFileSystemFake } from "@goodbones/core/testing";
import { describe, expect, it } from "vitest";

import { campaignViewOf } from "./campaigns.js";
import { factsOf, FILES, loadFixture, locate, manifest } from "./fixture.test-helper.js";

// The Campaign Browser's data, against the fixture's campaign: a JavaScript
// straggler in a Go service, ledgered, with and without phases.

const STRAGGLER = "svc/legacy/util.js";

const campaign = (overrides: Record<string, unknown> = {}) => ({
  why: "Every service is Go.",
  how: "Port the file.",
  owner: "@svc",
  // Widened to `.js`: the straggler is of no language the policy loads.
  scope: { path: ["svc/**"], extensions: [".js"] },
  staleAfter: "14d",
  objectives: {
    "port-it": {
      holdout: "file",
      match: { path: { file: "\\.js$" } },
      probes: { fires: [{ path: STRAGGLER }], ignores: [{ path: "svc/main.go" }] },
    },
  },
  ...overrides,
});

const ledger = {
  version: 2,
  campaign: "js-to-go",
  objective: "port-it",
  created: "2026-09-15T00:00:00.000Z",
  sectors: {
    scope: {
      entered: "2026-09-15T00:00:00.000Z",
      initial: 2,
      cleared: 1,
      closed: 0,
      lastCleared: "2026-09-20T00:00:00.000Z",
      holdouts: [STRAGGLER],
    },
  },
  concessions: [],
};

const record = {
  version: 1,
  campaign: "js-to-go",
  sector: "scope",
  reached: null,
  since: "2026-09-15T00:00:00.000Z",
  attested: [],
  notes: [{ at: "2026-09-16T00:00:00.000Z", by: "a@b.c", phase: null, text: "start with util" }],
};

const viewOf = (overrides: Record<string, unknown> = {}, nudge: Nudge | null = null) => {
  const files = makeFileSystemFake([...FILES, STRAGGLER], {
    ".architecture-campaigns/js-to-go/port-it.json": JSON.stringify(ledger),
    ".architecture-campaigns/js-to-go/sectors/scope.json": JSON.stringify(record),
    [STRAGGLER]: "module.exports = 1;",
  });
  const input = manifest({ campaigns: { "js-to-go": campaign(overrides) } });
  const policy = loadFixture(input, { files, extensions: [campaignsExtension({})] });
  const walked = [...FILES, STRAGGLER];
  const evaluations = evaluateCampaigns(policy, ["svc"], walked, {
    textOf: (file) => files.readText(file) ?? "",
    factsOf,
  });
  return campaignViewOf({
    policy,
    name: "repo",
    evaluations,
    reports: campaignReportsOf(policy, evaluations),
    manifest: input,
    locate,
    manifestPath: "architecture.yaml",
    nudge,
    now: policy.now,
  });
};

describe("campaignViewOf", () => {
  it("draws the minimal campaign: one objective, the scope as its one sector, no phases", () => {
    const view = viewOf();
    expect(view.ledgerDir).toBe(".architecture-campaigns");
    expect(view.campaigns).toHaveLength(1);
    const [card] = view.campaigns;
    expect(card).toMatchObject({
      id: "js-to-go",
      why: "Every service is Go.",
      how: "Port the file.",
      owner: "@svc",
      perimeter: null,
      staleAfterDays: 14,
      count: 1,
      progress: 0.5,
      ledgered: true,
      missingLedger: false,
      arithmetic: true,
      complete: false,
      stalled: false,
      phases: [],
    });
    expect(card?.objectives).toHaveLength(1);
    expect(card?.objectives[0]).toMatchObject({
      id: "port-it",
      holdout: "file",
      phase: null,
      count: 1,
      initial: 2,
      cleared: 1,
      progress: 0.5,
      lastCleared: "2026-09-20T00:00:00.000Z",
      ledgered: true,
      measure: null,
    });
    expect(card?.objectives[0]?.sectors).toEqual([
      {
        sector: "scope",
        count: 1,
        holdouts: [STRAGGLER],
        new: [],
        stale: [],
        drifted: 0,
        unrecorded: false,
        initial: 2,
        cleared: 1,
        closed: 0,
        lastCleared: "2026-09-20T00:00:00.000Z",
        measure: null,
      },
    ]);
  });

  it("places each sector with its files, residue, hits and the record left for it", () => {
    const [card] = viewOf().campaigns;
    expect(card?.sectors).toHaveLength(1);
    const [sector] = card?.sectors ?? [];
    expect(sector).toMatchObject({
      name: "scope",
      legacy: false,
      phase: 0,
      phaseId: null,
      done: false,
      reached: null,
      since: "2026-09-15T00:00:00.000Z",
      residue: { "port-it": 1 },
      stalled: false,
      notes: record.notes,
    });
    expect(sector?.files).toEqual([...FILES, STRAGGLER].sort());
    expect(sector?.hits).toEqual([
      {
        objective: "port-it",
        file: STRAGGLER,
        subject: null,
        line: null,
        entry: STRAGGLER,
        message: "Port the file.",
      },
    ]);
  });

  it("lays out phases in order, defined then open, and derives each sector's phase", () => {
    const [card] = viewOf({
      phases: [
        { id: "port", objectives: ["port-it"] },
        { id: "then", intent: "something after" },
      ],
    }).campaigns;
    expect(card?.phases).toEqual([
      {
        id: "port",
        index: 0,
        defined: true,
        intent: null,
        attested: false,
        objectives: ["port-it"],
        onTouch: null,
        grows: [],
        sectors: 1,
        concessions: 0,
        position: null,
      },
      {
        id: "then",
        index: 1,
        defined: false,
        intent: "something after",
        attested: false,
        objectives: [],
        onTouch: null,
        grows: [],
        sectors: 0,
        concessions: 0,
        position: null,
      },
    ]);
    expect(card?.objectives[0]?.phase).toBe("port");
    expect(card?.objectives[0]).toMatchObject({ prerequisite: false, waiting: [] });
    expect(card?.sectors[0]).toMatchObject({ phase: 0, phaseId: "port", done: false });
  });

  it("marks a prerequisite, the sectors it holds, and what a phase grows", () => {
    // The adapters are the shared files; a rule read over them is named by
    // the first phase, and the one sector stands there until it is met.
    const [card] = viewOf({
      shared: ["svc/adapters/**"],
      phases: [
        { id: "ready", objectives: ["port-it", "has-pg"], grows: ["lines"], onTouch: "advise" },
        { id: "then", intent: "something after" },
      ],
      objectives: {
        "port-it": {
          holdout: "file",
          match: { path: { file: "\\.js$" } },
          probes: { fires: [{ path: STRAGGLER }], ignores: [{ path: "svc/main.go" }] },
        },
        "has-pg": {
          over: "shared",
          holdout: "sector",
          sector: { has: { path: { file: "mysql" } } },
        },
        lines: { measure: { lines: true }, direction: "down" },
      },
    }).campaigns;
    expect(card?.phases[0]).toMatchObject({ onTouch: "advise", grows: ["lines"] });
    expect(card?.objectives.find((one) => one.id === "has-pg")).toMatchObject({
      prerequisite: true,
      phase: "ready",
      waiting: ["scope"],
    });
    expect(card?.objectives.find((one) => one.id === "port-it")).toMatchObject({
      prerequisite: false,
      waiting: [],
    });
    const shared = card?.sectors.find((one) => one.name === "shared");
    expect(shared).toMatchObject({ shared: true, done: false, phaseId: null });
    expect(shared?.files).toEqual(["svc/adapters/pg.go"]);
    expect(card?.shared).toEqual({ files: 1, holdouts: 1 });
  });

  // Only the nudge weighs work done ahead, but the page loads the same
  // manifest: an objective's own `onAhead` must not keep it from drawing.
  it("draws a campaign whose objective sets its own onAhead", () => {
    const [card] = viewOf({
      onAhead: "ratchet",
      phases: [
        { id: "fenced", intent: "fenced off", attested: true },
        { id: "port", objectives: ["port-it"] },
      ],
      objectives: {
        "port-it": {
          holdout: "file",
          onAhead: "ignore",
          match: { path: { file: "\\.js$" } },
          probes: { fires: [{ path: STRAGGLER }], ignores: [{ path: "svc/main.go" }] },
        },
      },
    }).campaigns;
    expect(card?.phases.map((phase) => phase.id)).toEqual(["fenced", "port"]);
    expect(card?.objectives[0]).toMatchObject({ id: "port-it", phase: "port" });
  });

  it("carries the nudge through untouched", () => {
    const nudge: Nudge = {
      version: 1,
      mode: "ledger",
      base: null,
      touched: [STRAGGLER],
      sectors: [],
      unbirths: [],
      testsChecked: "unknown",
      ok: true,
    };
    expect(viewOf({}, nudge).nudge).toBe(nudge);
    expect(viewOf().nudge).toBeNull();
  });
});
