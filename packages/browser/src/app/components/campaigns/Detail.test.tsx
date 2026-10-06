// @vitest-environment jsdom
import type { Nudge } from "@goodbones/campaigns";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CampaignCard, CampaignView } from "../../../model/campaigns.js";
import { Detail } from "./Detail.js";

// The detail panel over a campaign with shared files: a prerequisite says
// what it is and who waits on it, a phase says what it grows, a waiting
// sector's residue marks the prerequisite, and the working-tree block for
// the shared files lists the number that moved and the prerequisites.

afterEach(cleanup);

const objective = (
  id: string,
  phase: string | null,
  count: number,
  extra: Partial<CampaignCard["objectives"][number]> = {},
): CampaignCard["objectives"][number] => ({
  id,
  message: `fix ${id}`,
  intent: null,
  holdout: "file",
  phase,
  prerequisite: false,
  waiting: [],
  position: null,
  count,
  initial: count,
  allowed: 0,
  cleared: 0,
  closed: 0,
  progress: 0,
  lastCleared: null,
  concessions: 0,
  complete: count === 0,
  ledgered: true,
  measure: null,
  sectors: [],
  ...extra,
});

const sector = (
  name: string,
  phase: number,
  residue: Record<string, number>,
  extra: Partial<CampaignCard["sectors"][number]> = {},
): CampaignCard["sectors"][number] => ({
  name,
  legacy: false,
  shared: false,
  phase,
  phaseId: null,
  done: false,
  reached: null,
  since: null,
  roots: [],
  marker: null,
  files: ["a.ts"],
  residue,
  counts: residue,
  values: {},
  ladder: phase,
  stalled: false,
  attested: [],
  notes: [],
  hits: [],
  ...extra,
});

const campaign: CampaignCard = {
  id: "js-to-go",
  title: null,
  why: null,
  how: null,
  owner: null,
  scope: ["svc/**"],
  perimeter: "marker",
  staleAfterDays: null,
  onComplete: "keep",
  position: null,
  count: 2,
  progress: 0,
  steps: 1,
  stalled: false,
  complete: false,
  ledgered: true,
  missingLedger: false,
  arithmetic: true,
  phases: [
    {
      id: "ready",
      index: 0,
      defined: true,
      intent: null,
      attested: false,
      objectives: ["port-it", "has-pg"],
      onTouch: "advise",
      grows: ["lines"],
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
  ],
  objectives: [
    objective("port-it", "ready", 1),
    objective("has-pg", "ready", 1, {
      message: "Write the adapter.",
      holdout: "sector",
      prerequisite: true,
      waiting: ["scope"],
    }),
    objective("lines", null, 0, {
      holdout: "measure",
      measure: { direction: "down", value: 7, recorded: 7, target: null, tolerance: 0 },
    }),
  ],
  sectors: [
    sector("scope", 0, { "port-it": 1, "has-pg": 1, lines: 0 }, { phaseId: "ready" }),
    sector("shared", 2, { "has-pg": 1, lines: 0 }, { shared: true, files: ["svc/adapters/pg.go"] }),
  ],
  legacy: { files: 0, holdouts: 0 },
  shared: { files: 1, holdouts: 1 },
  drift: [],
  plan: { refined: [], changed: [], unreceipted: [] },
};

const nudgeOnShared: Nudge = {
  version: 1,
  mode: "ledger",
  base: null,
  touched: ["svc/adapters/pg.go"],
  sectors: [
    {
      campaign: "js-to-go",
      sector: "shared",
      phase: { id: null, index: 2, of: 2, open: false, attested: false, since: null },
      judged: { id: null, index: 2 },
      intent: null,
      objectives: [],
      shared: true,
      prerequisites: [{ objective: "has-pg", count: 1, phase: "ready", waiting: ["scope"] }],
      notes: [],
      onTouch: "advise",
      ask: "none",
      verdict: "ok",
      held: [],
      residue: { before: { "has-pg": 1, lines: 0 }, after: { "has-pg": 1, lines: 0 } },
      direction: "neutral",
      toward: {},
      holdouts: { total: 1, touched: 0, cap: 5, shown: [], sector: [] },
      added: [],
      removed: [],
      conceded: [],
      entered: [],
      measures: [
        {
          objective: "lines",
          direction: "down",
          before: 2,
          after: 5,
          recorded: 2,
          target: null,
          tolerance: 0,
          back: false,
          conceded: false,
          grows: true,
        },
      ],
      belongsInSector: [],
      unmatchedOwns: [],
    },
  ],
  unbirths: [],
  testsChecked: "unknown",
  ok: true,
};

const show = (nudge: Nudge | null, shown: Parameters<typeof Detail>[0]["shown"]): string => {
  const view: CampaignView = {
    version: 1,
    name: "repo",
    generatedAt: "2026-10-01T00:00:00.000Z",
    ledgerDir: ".architecture-campaigns",
    campaigns: [campaign],
    nudge,
  };
  const { container } = render(
    <Detail
      view={view}
      campaign={campaign}
      shown={shown}
      pinned={false}
      onPick={() => undefined}
    />,
  );
  return container.textContent;
};

describe("Detail", () => {
  it("says what a prerequisite is and who waits on it", () => {
    const text = show(null, { kind: "objective", id: "has-pg" });
    expect(text).toContain("prerequisite");
    expect(text).toContain("Read over the shared files and ledgered there, under shared.");
    expect(text).toContain("Held at ready until it is met: scope.");
  });

  it("shows a phase's onTouch and what it grows, and marks the prerequisite among its objectives", () => {
    const text = show(null, { kind: "phase", id: "ready" });
    expect(text).toContain("onTouchadvise");
    expect(text).toContain("growslines");
    expect(text).toContain("has-pg 1 left · 0% · prerequisite, met on the shared files");
  });

  it("marks the prerequisite in a waiting sector's residue", () => {
    const text = show(null, { kind: "sector", name: "scope" });
    expect(text).toContain("has-pg 1 left · a prerequisite: the shared files' to meet");
  });

  it("lists the shared files' number and prerequisites in the working-tree block", () => {
    const text = show(nudgeOnShared, { kind: "sector", name: "shared" });
    expect(text).toContain("What every sector shares.");
    expect(text).toContain("lines 2 → 5measured, not held");
    expect(text).toContain("Prerequisites, which hold every sector at the phase that names them:");
    expect(text).toContain("has-pg 1 — ready: scope");
  });
});
