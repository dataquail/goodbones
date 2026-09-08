import { type Atlas, decodeAtlas } from "@goodbones/core";
import * as Result from "effect/Result";

// Where the atlas comes from: inlined into the page by `explore --out`, or
// served beside it by `explore`. The document is decoded against the core's
// codec either way, so a viewer and a CLI of different versions fail loudly
// rather than draw the wrong thing.

export const INLINE_ATLAS_ID = "goodbones-atlas";

export type AtlasSource = {
  readonly atlas: Atlas;
  // Whether a server stands behind the page: a rescan and the facts of a
  // file are only possible then.
  readonly live: boolean;
};

export const parseAtlas = (json: unknown): Atlas => {
  const decoded = decodeAtlas(json);
  if (Result.isFailure(decoded)) {
    throw new Error(
      `this is not an atlas this viewer can read — the CLI that wrote it and this viewer may ` +
        `be different versions: ${String(decoded.failure)}`,
    );
  }
  return decoded.success;
};

export type Fetcher = (url: string) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

export const fetchAtlas = async (fetcher: Fetcher): Promise<Atlas> => {
  const response = await fetcher("atlas.json");
  if (!response.ok) throw new Error("the server could not rebuild the atlas; see its output");
  return parseAtlas(await response.json());
};

// The inlined document when the page carries one, else the server's.
export const loadAtlas = async (inline: string | null, fetcher: Fetcher): Promise<AtlasSource> => {
  if (inline !== null && inline.trim() !== "") {
    return { atlas: parseAtlas(JSON.parse(inline)), live: false };
  }
  return { atlas: await fetchAtlas(fetcher), live: true };
};
