import { describe, expect, it } from "vitest";

import { breaches, shortfallOf, standingOf } from "./bound.js";

describe("a bound", () => {
  it("holds a ceiling from above and a floor from below", () => {
    const ceiling = { direction: "down", limit: 10, tolerance: 0 } as const;
    expect(standingOf(ceiling, 10)).toBe("within");
    expect(standingOf(ceiling, 11)).toBe("breached");
    expect(standingOf(ceiling, 9)).toBe("surpassed");
    const floor = { direction: "up", limit: 0.8, tolerance: 0 } as const;
    expect(breaches(floor, 0.79)).toBe(true);
    expect(breaches(floor, 0.8)).toBe(false);
    expect(standingOf(floor, 0.9)).toBe("surpassed");
  });

  it("counts anything within the tolerance, either way, as at the limit", () => {
    const wobbly = { direction: "down", limit: 100, tolerance: 5 } as const;
    expect(standingOf(wobbly, 105)).toBe("within");
    expect(standingOf(wobbly, 95)).toBe("within");
    expect(standingOf(wobbly, 105.5)).toBe("breached");
    expect(standingOf(wobbly, 94)).toBe("surpassed");
  });

  it("measures the shortfall in the direction that is worse", () => {
    expect(shortfallOf({ direction: "down", limit: 10, tolerance: 0 }, 13)).toBe(3);
    expect(shortfallOf({ direction: "up", limit: 10, tolerance: 0 }, 13)).toBe(-3);
  });
});
