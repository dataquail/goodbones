// Imports a module that may be absent because the package it needs is an
// optional peer the user did not install — `@goodbones/campaigns`, or the
// syntax matcher — and answers `null` when, and only when, that package is
// the one missing.
//
// `load` is the import itself, written at the call site, so it resolves from
// the host's own location; `peer` is the package whose absence is expected.
// The host may import its own glue module and still ask about the peer
// behind it. Any other failure is rethrown: a package that is installed but
// cannot find something it imports is a broken install, and passing it off
// as an absent one would turn a family off without a word.
export const importOptional = async <A>(
  load: () => Promise<A>,
  peer: string,
): Promise<A | null> => {
  try {
    return await load();
  } catch (cause) {
    if (isMissing(cause, peer)) return null;
    throw cause;
  }
};

// Node says `Cannot find package '<name>' imported from <file>` for a bare
// specifier that does not resolve, with the code `ERR_MODULE_NOT_FOUND`.
const isMissing = (cause: unknown, peer: string): boolean =>
  cause instanceof Error &&
  (cause as Error & { readonly code?: unknown }).code === "ERR_MODULE_NOT_FOUND" &&
  cause.message.includes(`'${peer}'`);
