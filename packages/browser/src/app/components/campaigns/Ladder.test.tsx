// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CampaignCard } from "../../../model/campaigns.js";
import { columnOfSector, columnsOf, Ladder } from "./Ladder.js";

// The ladder: one column per phase and one for the end, sectors in the
// column of their phase, and a hover that lights what relates.

afterEach(cleanup);

const objective = (
  id: string,
  phase: string | null,
  count: number,
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
  initial: count + 1,
  allowed: 0,
  cleared: 1,
  closed: 0,
  progress: 0.5,
  lastCleared: null,
  concessions: 0,
  complete: count === 0,
  ledgered: true,
  measure: null,
  sectors: [],
});

const sector = (
  name: string,
  phase: number,
  done: boolean,
  residue: Record<string, number>,
): CampaignCard["sectors"][number] => ({
  name,
  legacy: name === "legacy",
  shared: false,
  phase,
  phaseId: null,
  done,
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
});

const campaign = (): CampaignCard => ({
  id: "billing",
  title: null,
  why: null,
  how: null,
  owner: null,
  scope: ["src/**"],
  perimeter: "marker",
  staleAfterDays: null,
  onComplete: "keep",
  position: null,
  count: 3,
  progress: 0.4,
  steps: 2,
  stalled: false,
  complete: false,
  ledgered: true,
  missingLedger: false,
  arithmetic: true,
  phases: [
    {
      id: "domain",
      index: 0,
      defined: true,
      intent: null,
      attested: false,
      objectives: ["no-io"],
      onTouch: null,
      grows: [],
      sectors: 2,
      concessions: 0,
      position: null,
    },
    {
      id: "repo",
      index: 1,
      defined: true,
      intent: null,
      attested: false,
      objectives: ["no-sql"],
      onTouch: null,
      grows: [],
      sectors: 1,
      concessions: 0,
      position: null,
    },
    {
      id: "later",
      index: 2,
      defined: false,
      intent: "cut over",
      attested: false,
      objectives: [],
      onTouch: null,
      grows: [],
      sectors: 0,
      concessions: 0,
      position: null,
    },
  ],
  objectives: [objective("no-io", "domain", 2), objective("no-sql", "repo", 1)],
  sectors: [
    sector("legacy", 0, false, { "no-io": 1 }),
    sector("orders", 0, false, { "no-io": 1, "no-sql": 1 }),
    sector("billing", 1, false, { "no-sql": 1 }),
    sector("shipping", 3, true, {}),
  ],
  legacy: { files: 1, holdouts: 1 },
  shared: null,
  drift: [],
  plan: { refined: [], changed: [], unreceipted: [] },
});

describe.sequential("Ladder", () => {
  it("lays the columns out: the phases, then the end, with no standing column when every objective is phased", () => {
    const columns = columnsOf(campaign());
    expect(columns.map((one) => one.kind)).toEqual(["phase", "phase", "phase", "end"]);
    expect(columnOfSector(campaign(), columns, campaign().sectors[3] as never)).toBe(3);
    expect(columnOfSector(campaign(), columns, campaign().sectors[2] as never)).toBe(1);
  });

  it("puts a phaseless campaign's objectives in a standing column", () => {
    const standing = { ...campaign(), phases: [], objectives: [objective("only", null, 1)] };
    expect(columnsOf(standing).map((one) => one.kind)).toEqual(["standing", "end"]);
    expect(
      columnOfSector(standing, columnsOf(standing), sector("scope", 0, false, { only: 1 })),
    ).toBe(0);
    expect(columnOfSector(standing, columnsOf(standing), sector("scope", 0, true, {}))).toBe(1);
  });

  it("draws every phase, objective and sector, and lights what a hovered objective touches", () => {
    const onHover = vi.fn();
    const { container, rerender } = render(
      <Ladder
        campaign={campaign()}
        nudged={new Set(["orders"])}
        hover={null}
        selected={null}
        onHover={onHover}
        onPick={() => undefined}
      />,
    );
    expect(container.querySelectorAll("g.phase-box")).toHaveLength(3);
    expect(container.querySelectorAll("g.chip-box")).toHaveLength(2);
    expect(container.querySelectorAll("g.sector-box")).toHaveLength(4);
    expect(container.querySelector("g.sector-box.legacy")).not.toBeNull();
    expect(container.querySelector("g.sector-box.done")).not.toBeNull();
    expect(container.querySelector("g.sector-box.nudged")).not.toBeNull();

    const chip = container.querySelectorAll("g.chip-box")[1];
    if (chip === undefined) throw new Error("no chip");
    fireEvent.mouseEnter(chip);
    expect(onHover).toHaveBeenCalledWith({ kind: "objective", id: "no-sql" });

    rerender(
      <Ladder
        campaign={campaign()}
        nudged={new Set()}
        hover={{ kind: "objective", id: "no-sql" }}
        selected={null}
        onHover={onHover}
        onPick={() => undefined}
      />,
    );
    const lit = [...container.querySelectorAll("g.sector-box.lit")].map((one) => one.textContent);
    expect(lit.some((text) => text.includes("orders"))).toBe(true);
    expect(lit.some((text) => text.includes("billing"))).toBe(true);
    expect(lit.some((text) => text.includes("legacy"))).toBe(false);
    expect(container.querySelector("svg.ladder.focused")).not.toBeNull();
  });
});
