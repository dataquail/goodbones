// A commit that touched the paths a reader asked after, as git's log has it.
export type Commit = {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
  readonly files: ReadonlyArray<string>;
};
