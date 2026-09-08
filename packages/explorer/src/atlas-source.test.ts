import { describe, expect, it } from "vitest";

import { fetchAtlas, type Fetcher, loadAtlas, parseAtlas } from "./atlas-source.js";
import { FIXTURE } from "./fixture.test.js";

const serving =
  (body: unknown, ok = true): Fetcher =>
  () =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) });

describe("the atlas source", () => {
  it("prefers the document inlined into the page, and knows no server is there", async () => {
    const source = await loadAtlas(JSON.stringify(FIXTURE), serving({ nope: true }));
    expect(source.live).toBe(false);
    expect(source.atlas).toEqual(FIXTURE);
  });

  it("fetches from the server when nothing is inlined, and can ask again", async () => {
    const source = await loadAtlas(null, serving(FIXTURE));
    expect(source.live).toBe(true);
    expect(source.atlas.files).toHaveLength(4);
    expect(await fetchAtlas(serving(FIXTURE))).toEqual(FIXTURE);
    await expect(fetchAtlas(serving({}, false))).rejects.toThrow(/could not rebuild/);
  });

  it("refuses a document that is not an atlas, naming the likely cause", () => {
    expect(() => parseAtlas({ version: 2 })).toThrow(/different versions/);
    expect(() => parseAtlas({ ...FIXTURE, extra: 1 })).toThrow();
  });
});
