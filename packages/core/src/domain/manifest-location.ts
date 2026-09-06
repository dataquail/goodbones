// Where in the manifest file a value was written. A decode error that names a
// path is something the reader has to find; one that names a line is something
// an editor can jump to. The host that read the file knows its lines; the
// decoder knows the path — the locator is how the second asks the first.

// A path into the manifest as the decoder sees it: object keys and array
// indices, root first.
export type ManifestPath = ReadonlyArray<PropertyKey>;

export type ManifestPosition = {
  // 1-based, as editors count.
  readonly line: number;
  readonly column: number;
  // The file the position is in, when it is not the manifest itself: a
  // manifest assembled from several files through `include` answers with the
  // included file's path, relative to the manifest's own directory. Absent
  // for a position in the manifest file.
  readonly file?: string | undefined;
};

// Answers with the position of the value at `path`, or the nearest ancestor
// that exists when the path names something the file does not contain (a
// missing key), or `null` when the source has no positions to give.
export type ManifestLocator = (path: ManifestPath) => ManifestPosition | null;

const isIdentifier = (key: string): boolean => /^[A-Za-z_$][\w$]*$/.test(key);

// `tree["~/core/"].members[0].subject` — dotted where a key reads as a name,
// bracketed where it does not, so a node key that is a path pattern stays
// legible.
export const renderManifestPath = (path: ManifestPath): string =>
  path.length === 0
    ? "(root)"
    : path
        .map((segment, index) => {
          if (typeof segment === "number") return `[${String(segment)}]`;
          const key = String(segment);
          if (isIdentifier(key)) return index === 0 ? key : `.${key}`;
          return `[${JSON.stringify(key)}]`;
        })
        .join("");
