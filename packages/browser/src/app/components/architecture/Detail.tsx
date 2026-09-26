import type { Atlas, AtlasFile, AtlasFolder, AtlasNode, EdgeStatus } from "../../../model/atlas.js";
import type { Selection } from "./selection.js";

// What the manifest says about the thing under the pointer, in the CLI's
// words: what it may import and why each import passed or did not, who
// imports it, what it owes, and every violation on it. With nothing under
// the pointer, the repository as a whole.

type Props = {
  readonly atlas: Atlas;
  readonly selected: Selection | null;
  readonly hovered: Selection | null;
  readonly onSelect: (selection: Selection | null) => void;
};

const same = (a: Selection | null, b: Selection | null): boolean =>
  a !== null &&
  b !== null &&
  a.kind === b.kind &&
  (a.kind === "node" ? a.id === (b as { id: string }).id : a.path === (b as { path: string }).path);

export const Detail = ({ atlas, hovered, onSelect, selected }: Props): React.JSX.Element => {
  const shown = hovered ?? selected;
  const pinned = shown !== null && same(shown, selected);
  return (
    <div className="detail">
      {shown === null ? (
        <Overview atlas={atlas} onSelect={onSelect} />
      ) : (
        <>
          <div className="pane-head">
            <span className="eyebrow">{shown.kind}</span>
            {pinned ? (
              <button
                type="button"
                className="small"
                onClick={() => {
                  onSelect(null);
                }}
              >
                unpin
              </button>
            ) : (
              <span className="hint">click to pin</span>
            )}
          </div>
          {shown.kind === "file" ? (
            <FileDetail atlas={atlas} path={shown.path} onSelect={onSelect} />
          ) : shown.kind === "folder" ? (
            <FolderDetail atlas={atlas} path={shown.path} onSelect={onSelect} />
          ) : (
            <NodeDetail atlas={atlas} id={shown.id} onSelect={onSelect} />
          )}
        </>
      )}
    </div>
  );
};

const Overview = ({
  atlas,
  onSelect,
}: {
  atlas: Atlas;
  onSelect: Props["onSelect"];
}): React.JSX.Element => {
  const refused = atlas.violations.filter((one) => !one.baselined);
  return (
    <>
      <div className="pane-head">
        <span className="eyebrow">repository</span>
      </div>
      <h2 className="mono">{atlas.name}</h2>
      <p className="muted">
        {atlas.files.filter((file) => file.walked).length} files under {atlas.roots.join(", ")},{" "}
        {atlas.edges.length} edges, {atlas.manifest.nodes.length} nodes in {atlas.manifest.path}
        {atlas.manifest.files.length > 1
          ? ` and ${String(atlas.manifest.files.length - 1)} included file(s)`
          : ""}
        .
      </p>
      <dl className="facts">
        <dt>violations</dt>
        <dd className={refused.length > 0 ? "bad" : "good"}>
          {refused.length}
          {atlas.violations.length > refused.length
            ? ` (+${String(atlas.violations.length - refused.length)} baselined)`
            : ""}
        </dd>
        <dt>unresolved</dt>
        <dd className={atlas.unresolved.length > 0 ? "bad" : "good"}>{atlas.unresolved.length}</dd>
        <dt>cycles</dt>
        <dd className={atlas.cycles > 0 ? "bad" : "good"}>{atlas.cycles}</dd>
      </dl>
      <h3>How to read it</h3>
      <p className="muted">
        Hover a file: its imports come forward in the accent, its importers in ink, a refused edge
        in red, and the node that governs it lights up in the manifest. Hover a line of the
        manifest: every file that node governs lights up in the tree. Click either to keep it.
      </p>
      <h3>Nodes</h3>
      <ul className="list">
        {atlas.manifest.nodes
          .filter((node) => node.depth === 0)
          .map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onSelect({ kind: "node", id: node.id });
                }}
              >
                {node.path}
              </button>
              <span className="muted">
                {" "}
                {node.files === 0 ? "" : `${String(node.files)} files`}
              </span>
            </li>
          ))}
      </ul>
      {atlas.manifest.rules.length > 0 ? (
        <>
          <h3>Repository-wide rules</h3>
          <ul className="list">
            {atlas.manifest.rules.map((rule) => (
              <li key={`${rule.family}:${rule.name}`} title={rule.message}>
                <span className="family">{rule.family}</span>{" "}
                <span className="mono">{rule.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {refused.length > 0 ? (
        <>
          <h3>Violations</h3>
          <ul className="list">
            {refused.slice(0, 40).map((one) => (
              <li key={one.fingerprint} className="violation">
                <button
                  type="button"
                  className="link mono"
                  onClick={() => {
                    onSelect({ kind: "file", path: one.file });
                  }}
                >
                  {one.file}
                </button>
                <div className="muted small">{one.message}</div>
              </li>
            ))}
            {refused.length > 40 ? <li className="muted">… {refused.length - 40} more</li> : null}
          </ul>
        </>
      ) : null}
    </>
  );
};

const statusWord = (status: EdgeStatus): string =>
  status === "allowed" ? "allowed" : status === "refused" ? "refused" : "no allowlist";

const NodeCrumbs = ({
  atlas,
  chain,
  onSelect,
}: {
  atlas: Atlas;
  chain: ReadonlyArray<string>;
  onSelect: Props["onSelect"];
}): React.JSX.Element => (
  <div className="crumbs">
    {chain.map((id, index) => {
      const node = atlas.manifest.nodes.find((one) => one.id === id);
      return (
        <span key={id}>
          {index > 0 ? <span className="muted"> › </span> : null}
          <button
            type="button"
            className="link mono"
            onClick={() => {
              onSelect({ kind: "node", id });
            }}
            title={node?.message ?? id}
          >
            {node?.key ?? id}
          </button>
        </span>
      );
    })}
    {chain.length === 0 ? <span className="muted">governed by no node</span> : null}
  </div>
);

const FileDetail = ({
  atlas,
  onSelect,
  path,
}: {
  atlas: Atlas;
  path: string;
  onSelect: Props["onSelect"];
}): React.JSX.Element | null => {
  const file: AtlasFile | undefined = atlas.files.find((one) => one.path === path);
  if (file === undefined) return null;
  const node = file.node === null ? null : atlas.manifest.nodes.find((one) => one.id === file.node);
  const out = atlas.edges.filter((edge) => edge.from === path);
  const into = atlas.edges.filter((edge) => edge.to === path);
  const violations = atlas.violations.filter((one) => one.file === path);
  const unresolved = atlas.unresolved.filter((one) => one.file === path);
  // The allowlist in force: every allowance down the chain, nearest last.
  const allowances = file.chain
    .map((id) => atlas.manifest.nodes.find((one) => one.id === id))
    .filter((one): one is AtlasNode => one !== undefined && one.imports !== null);
  return (
    <>
      <h2 className="mono path">{file.path}</h2>
      {!file.walked ? (
        <p className="muted">Outside the walk: reached from it, governed by nothing.</p>
      ) : null}
      <NodeCrumbs atlas={atlas} chain={file.chain} onSelect={onSelect} />
      {node?.message !== null && node?.message !== undefined ? (
        <p className="message">{node.message}</p>
      ) : null}

      <h3>May import</h3>
      {allowances.length === 0 ? (
        <p className="muted">anything — no node above this file states an allowlist</p>
      ) : (
        allowances.map((one) => (
          <div key={one.id} className="allowlist">
            <div className="muted small">
              from <span className="mono">{one.key}</span>
              {one.imports?.reset === true ? " (reset)" : ""}
              {one.imports?.unrestricted === true ? " (unrestricted)" : ""}
            </div>
            <ul className="chips">
              {(one.imports?.allowances ?? []).map((allowance) => (
                <li
                  key={`${allowance.kind}:${allowance.entry}`}
                  className={`chip ${allowance.kind} ${allowance.used ? "" : "slack"}`}
                  title={
                    allowance.used
                      ? allowance.kind === "external"
                        ? "a package"
                        : allowance.expanded
                      : "slack: no import uses this entry"
                  }
                >
                  {allowance.entry}
                </li>
              ))}
              {(one.imports?.deny ?? []).map((denial) => (
                <li key={denial.message} className="chip deny" title={denial.message}>
                  deny {denial.match.join(" | ")}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <h3>Imports</h3>
      {out.length + file.externals.length + file.builtins.length === 0 ? (
        <p className="muted">nothing</p>
      ) : (
        <ul className="list">
          {out.map((edge) => (
            <li key={edge.to} className={`edge-row ${edge.status}`}>
              <span className={`verdict ${edge.status}`}>
                {edge.status === "refused" ? "✗" : "✓"}
              </span>
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onSelect({ kind: "file", path: edge.to });
                }}
              >
                {edge.to}
              </button>
              <div className="muted small">
                {edge.status === "refused"
                  ? edge.refusedBy.map((one) => one.message).join(" ")
                  : edge.admittedBy === null
                    ? statusWord(edge.status)
                    : `admitted by ${edge.admittedBy.entry} on ${edge.admittedBy.node}${edge.admittedBy.fragment === null ? "" : ` (via ${edge.admittedBy.fragment})`}`}
              </div>
            </li>
          ))}
          {file.externals.map((external) => (
            <li key={external.package} className={`edge-row ${external.status}`}>
              <span className={`verdict ${external.status}`}>
                {external.status === "refused" ? "✗" : "✓"}
              </span>
              <span className="mono">{external.package}</span>
              <span className="muted small"> external · {external.specifiers.join(", ")}</span>
              <div className="muted small">
                {external.admittedBy === null
                  ? statusWord(external.status)
                  : `admitted by ${external.admittedBy.entry} on ${external.admittedBy.node}`}
              </div>
            </li>
          ))}
          {file.builtins.map((builtin) => (
            <li key={builtin} className="edge-row">
              <span className="verdict allowed">·</span>
              <span className="mono">{builtin}</span>
              <span className="muted small"> builtin</span>
            </li>
          ))}
          {unresolved.map((one) => (
            <li key={one.specifier} className="edge-row refused">
              <span className="verdict refused">?</span>
              <span className="mono">{one.specifier}</span>
              <div className="muted small">unresolved: {one.detail}</div>
            </li>
          ))}
        </ul>
      )}

      <h3>Imported by</h3>
      {into.length === 0 ? (
        <p className="muted">nothing in the walk</p>
      ) : (
        <ul className="list">
          {into.map((edge) => (
            <li key={edge.from} className={`edge-row ${edge.status}`}>
              <span className={`verdict ${edge.status}`}>
                {edge.status === "refused" ? "✗" : "✓"}
              </span>
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onSelect({ kind: "file", path: edge.from });
                }}
              >
                {edge.from}
              </button>
            </li>
          ))}
        </ul>
      )}

      {file.requires.length > 0 ? (
        <>
          <h3>Owes</h3>
          <ul className="list">
            {file.requires.map((owed) => (
              <li key={owed.sibling} className={owed.present ? "" : "bad"}>
                <span className={`verdict ${owed.present ? "allowed" : "refused"}`}>
                  {owed.present ? "✓" : "✗"}
                </span>
                <span className="mono">{owed.sibling}</span>
                <span className="muted small"> {owed.rule}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {file.importRules.length > 0 ? (
        <>
          <h3>Import rules selecting it</h3>
          <ul className="chips">
            {file.importRules.map((rule) => (
              <li key={rule} className="chip rule mono">
                {rule}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Violations</h3>
      {violations.length === 0 ? (
        <p className="good">none</p>
      ) : (
        <ul className="list">
          {violations.map((one) => (
            <li key={one.fingerprint} className={`violation ${one.baselined ? "baselined" : ""}`}>
              <span className="family">{one.kind}</span> {one.message}
              {one.baselined ? <span className="muted small"> (baselined)</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

const FolderDetail = ({
  atlas,
  onSelect,
  path,
}: {
  atlas: Atlas;
  path: string;
  onSelect: Props["onSelect"];
}): React.JSX.Element | null => {
  const folder: AtlasFolder | undefined = atlas.folders.find((one) => one.path === path);
  if (folder === undefined) return null;
  const within = atlas.files.filter((file) => file.path.startsWith(`${path}/`));
  const chain =
    within[0]?.chain.filter((id) => {
      const node = atlas.manifest.nodes.find((one) => one.id === id);
      return node?.folder === true;
    }) ?? (folder.node === null ? [] : [folder.node]);
  const violations = atlas.violations.filter((one) => one.file.startsWith(`${path}/`));
  const out = atlas.edges.filter(
    (edge) => edge.from.startsWith(`${path}/`) && !edge.to.startsWith(`${path}/`),
  );
  const into = atlas.edges.filter(
    (edge) => edge.to.startsWith(`${path}/`) && !edge.from.startsWith(`${path}/`),
  );
  const declared = folder.declares
    .map((id) => atlas.manifest.nodes.find((one) => one.id === id))
    .filter((one): one is AtlasNode => one !== undefined);
  return (
    <>
      <h2 className="mono path">{folder.path}/</h2>
      <NodeCrumbs atlas={atlas} chain={chain} onSelect={onSelect} />
      {declared.map((node) => (
        <div key={node.id} className="declared">
          <div className="muted small">
            declares node <span className="mono">{node.path}</span>
            {node.position === null ? "" : ` · ${node.position.file}:${String(node.position.line)}`}
          </div>
          {node.message !== null ? <p className="message">{node.message}</p> : null}
        </div>
      ))}
      <dl className="facts">
        <dt>files</dt>
        <dd>{within.length}</dd>
        <dt>edges out</dt>
        <dd>{out.length}</dd>
        <dt>edges in</dt>
        <dd>{into.length}</dd>
        <dt>violations</dt>
        <dd className={violations.length > 0 ? "bad" : "good"}>{violations.length}</dd>
      </dl>
      <h3>Reaches</h3>
      <ul className="list">
        {[...new Set(out.map((edge) => folderOf(edge.to)))].sort().map((target) => (
          <li key={target}>
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onSelect({ kind: "folder", path: target });
              }}
            >
              {target}/
            </button>
          </li>
        ))}
        {out.length === 0 ? <li className="muted">nothing outside itself</li> : null}
      </ul>
      <h3>Reached from</h3>
      <ul className="list">
        {[...new Set(into.map((edge) => folderOf(edge.from)))].sort().map((source) => (
          <li key={source}>
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onSelect({ kind: "folder", path: source });
              }}
            >
              {source}/
            </button>
          </li>
        ))}
        {into.length === 0 ? <li className="muted">nothing outside itself</li> : null}
      </ul>
    </>
  );
};

const folderOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/")));

const NodeDetail = ({
  atlas,
  id,
  onSelect,
}: {
  atlas: Atlas;
  id: string;
  onSelect: Props["onSelect"];
}): React.JSX.Element | null => {
  const node = atlas.manifest.nodes.find((one) => one.id === id);
  if (node === undefined) return null;
  const chain: Array<string> = [];
  let cursor: AtlasNode | undefined = node;
  while (cursor !== undefined) {
    chain.unshift(cursor.id);
    cursor =
      cursor.parent === null
        ? undefined
        : atlas.manifest.nodes.find((one) => one.id === cursor?.parent);
  }
  const governed = atlas.files.filter((file) => file.chain.includes(id));
  const violations = atlas.violations.filter((one) => node.rules.includes(one.rule));
  return (
    <>
      <h2 className="mono path">{node.path}</h2>
      <NodeCrumbs atlas={atlas} chain={chain} onSelect={onSelect} />
      <dl className="facts">
        <dt>id</dt>
        <dd className="mono">{node.id}</dd>
        <dt>kind</dt>
        <dd>
          {node.folder ? `folder, layout ${node.layout}` : "file"}
          {node.partial ? ", partial" : ""}
        </dd>
        <dt>written at</dt>
        <dd className="mono">
          {node.position === null ? "—" : `${node.position.file}:${String(node.position.line)}`}
        </dd>
        <dt>governs</dt>
        <dd>{governed.length} files</dd>
      </dl>
      {node.message !== null ? <p className="message">{node.message}</p> : null}
      {node.imports !== null ? (
        <>
          <h3>imports</h3>
          {node.imports.message !== null ? (
            <p className="muted small">{node.imports.message}</p>
          ) : null}
          <ul className="chips">
            {node.imports.allowances.map((allowance) => (
              <li
                key={`${allowance.kind}:${allowance.entry}`}
                className={`chip ${allowance.kind} ${allowance.used ? "" : "slack"}`}
                title={allowance.used ? allowance.expanded : "slack: no import uses this entry"}
              >
                {allowance.entry}
              </li>
            ))}
            {node.imports.deny.map((denial) => (
              <li key={denial.message} className="chip deny" title={denial.message}>
                deny {denial.match.join(" | ")}
              </li>
            ))}
          </ul>
          {node.imports.reset ? <p className="muted small">reset: inherits no allowance</p> : null}
          {node.imports.unrestricted ? (
            <p className="muted small">unrestricted: no allowlist yet</p>
          ) : null}
        </>
      ) : null}
      {node.importedBy !== null ? (
        <>
          <h3>importedBy</h3>
          <p className="muted small">{node.importedBy.message}</p>
          <ul className="chips">
            {node.importedBy.allow.map((entry) => (
              <li key={entry} className="chip allow">
                {entry}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {node.members.length > 0 ? (
        <>
          <h3>members</h3>
          <ul className="list">
            {node.members.map((rule, index) => (
              <li key={index}>
                <span className="family">{rule.subject}</span> {rule.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {node.surface.length > 0 ? (
        <>
          <h3>surface</h3>
          <ul className="list">
            {node.surface.map((rule, index) => (
              <li key={index}>{rule.message}</li>
            ))}
          </ul>
        </>
      ) : null}
      {node.requires.length > 0 ? (
        <>
          <h3>requires</h3>
          <ul className="chips">
            {node.requires.map((one) => (
              <li key={one} className="chip">
                {one}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Rules lowered from it</h3>
      <ul className="chips">
        {node.rules.map((rule) => (
          <li key={rule} className="chip rule mono">
            {rule}
          </li>
        ))}
        {node.rules.length === 0 ? <li className="muted">none</li> : null}
      </ul>
      <h3>Violations of its rules</h3>
      {violations.length === 0 ? (
        <p className="good">none</p>
      ) : (
        <ul className="list">
          {violations.map((one) => (
            <li key={one.fingerprint} className="violation">
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onSelect({ kind: "file", path: one.file });
                }}
              >
                {one.file}
              </button>
              <div className="muted small">{one.message}</div>
            </li>
          ))}
        </ul>
      )}
      {governed.length > 0 ? (
        <>
          <h3>Files</h3>
          <ul className="list compact">
            {governed.slice(0, 60).map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="link mono"
                  onClick={() => {
                    onSelect({ kind: "file", path: file.path });
                  }}
                >
                  {file.path}
                </button>
              </li>
            ))}
            {governed.length > 60 ? <li className="muted">… {governed.length - 60} more</li> : null}
          </ul>
        </>
      ) : null}
    </>
  );
};
