import type { FileSystem } from "../ports/file-system.js";

// The files that exist, and optionally what some of them say. A file staged
// with contents exists; one staged by name alone exists and reads as nothing.
export const makeFileSystemFake = (
  present: Iterable<string>,
  contents: Readonly<Record<string, string>> = {},
): FileSystem => {
  const paths = new Set([...present, ...Object.keys(contents)]);
  return {
    exists: (repoRelativePath) => paths.has(repoRelativePath),
    readText: (repoRelativePath) => contents[repoRelativePath] ?? null,
    list: (repoRelativeDir) => {
      const prefix = repoRelativeDir === "" ? "" : `${repoRelativeDir}/`;
      return [
        ...new Set(
          [...paths]
            .filter((one) => one.startsWith(prefix))
            .map((one) => one.slice(prefix.length).split("/")[0] ?? ""),
        ),
      ]
        .filter((one) => one !== "")
        .sort();
    },
  };
};
