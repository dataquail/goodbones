// A stable digest of a value: FNV-1a over its canonical JSON, keys sorted,
// so two values that say the same thing in a different order hash alike.
// It is how a phase's definition is compared against what the plan file
// recorded, and nothing security rests on it.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = (one: unknown): unknown =>
  Array.isArray(one)
    ? one.map(canonical)
    : isRecord(one)
      ? Object.fromEntries(
          Object.keys(one)
            .sort()
            .map((key) => [key, canonical(one[key])]),
        )
      : one;

export const digest = (value: unknown): string => {
  const text = JSON.stringify(canonical(value));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
