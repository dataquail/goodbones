import type {
  Atlas,
  AtlasEdge,
  SnapshotViolation,
  View,
  ViewEdge,
  ViewNode,
} from "@goodbones/core";
import { type ReactElement, useEffect, useState } from "react";

import type { Selection } from "./hash-state.js";
import type { Highlight } from "./highlight.js";

// The side panel: what the selected thing is, in the manifest's own words. An
// edge lists the imports beneath it and what admitted or refused each; a node
// shows the tier that governs it, the sentence its author wrote, what the
// policy has to say about it, and — when a server is there to ask — what the
// parser read out of a file; a violation is its message, its route when it
// has one, and what the canvas is lighting; a cycle is its members.

export type Facts = {
  readonly file: string;
  readonly edges: ReadonlyArray<{
    readonly specifier: string;
    readonly bindings: ReadonlyArray<{ readonly symbol: string; readonly kind: string }>;
  }>;
  readonly memberSites: ReadonlyArray<{
    readonly subject: string;
    readonly name: string;
    readonly in?: string;
  }>;
  readonly exportSites: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly declares: string;
    readonly reexport: boolean;
  }>;
};

// Whether a server's answer is the shape the panel reads. Anything else is
// shown as unavailable rather than drawn.
export const isFacts = (value: unknown): value is Facts => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.file === "string" &&
    Array.isArray(record.edges) &&
    record.edges.every(
      (one: unknown) =>
        typeof one === "object" &&
        one !== null &&
        Array.isArray((one as Record<string, unknown>).bindings),
    ) &&
    Array.isArray(record.memberSites) &&
    Array.isArray(record.exportSites)
  );
};

export type PanelProps = {
  readonly atlas: Atlas;
  readonly view: View;
  readonly selection: Selection | null;
  readonly highlight: Highlight | null;
  // Fetches a file's facts from the server, or null when there is none.
  readonly factsOf: ((file: string) => Promise<Facts>) | null;
  readonly onNavigate: (focus: string) => void;
  readonly onSelect: (selection: Selection | null) => void;
};

type Select = (selection: Selection) => void;

const findNode = (view: View, id: string): ViewNode | undefined => {
  for (const member of view.members) {
    if (member.id === id) return member;
    const child = member.children?.find((one) => one.id === id);
    if (child !== undefined) return child;
  }
  return view.outside.find((one) => one.id === id);
};

const FileLink = ({ file, onSelect }: { readonly file: string; readonly onSelect: Select }) => (
  <button
    type="button"
    className="link"
    onClick={() => {
      onSelect({ kind: "node", id: file });
    }}
  >
    {file}
  </button>
);

const ViolationItem = ({
  onSelect,
  violation,
}: {
  readonly violation: SnapshotViolation;
  readonly onSelect: Select;
}): ReactElement => (
  <li className={violation.baselined ? "baselined" : "violation"}>
    <button
      type="button"
      className="link fingerprint"
      title="select this violation — a reach route is traced on the canvas"
      onClick={() => {
        onSelect({ kind: "violation", fingerprint: violation.fingerprint });
      }}
    >
      <code>{violation.fingerprint}</code>
    </button>
    <p>{violation.message}</p>
  </li>
);

const EdgeRow = ({
  atlas,
  edge,
  onSelect,
}: {
  readonly atlas: Atlas;
  readonly edge: AtlasEdge;
  readonly onSelect: Select;
}): ReactElement => {
  const violations = (edge.violations ?? []).flatMap((fingerprint) => {
    const found = atlas.violations.find((one) => one.fingerprint === fingerprint);
    return found === undefined ? [] : [found];
  });
  return (
    <li className={`edge-row ${edge.status}`}>
      <div className="edge-ends">
        <FileLink file={edge.from} onSelect={onSelect} />
        <span className="arrow">→</span>
        <FileLink file={edge.to} onSelect={onSelect} />
      </div>
      {edge.status === "admitted" && edge.admittedBy !== undefined && (
        <div className="why">
          admitted by <code>{edge.admittedBy.kind}</code> <code>{edge.admittedBy.entry}</code> at{" "}
          <code>{edge.admittedBy.node}</code>
          {edge.admittedBy.fragment === undefined ? "" : ` via use: ${edge.admittedBy.fragment}`}
        </div>
      )}
      {edge.status === "ungoverned" && (
        <div className="why">no import allowlist selects the importer</div>
      )}
      {violations.length > 0 && (
        <ul className="facts">
          {violations.map((one) => (
            <ViolationItem key={one.fingerprint} violation={one} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
};

const EdgePanel = ({
  atlas,
  edge,
  onSelect,
}: {
  readonly atlas: Atlas;
  readonly edge: ViewEdge;
  readonly onSelect: Select;
}): ReactElement => (
  <>
    <h2>
      <span className={`status ${edge.status}`}>{edge.status}</span> {edge.from} → {edge.to}
    </h2>
    <p className="muted">
      {edge.status === "designed"
        ? "An allowance nothing imports through: permission the tree does not need."
        : `${String(edge.count)} ${edge.count === 1 ? "import" : "imports"} beneath this edge.`}
    </p>
    {edge.worst !== null && (
      <p className="worst">
        <code>{edge.worst.fingerprint}</code>
        <br />
        {edge.worst.message}
      </p>
    )}
    <ul className="edge-list">
      {edge.underlying.map((one) => (
        <EdgeRow key={`${one.from}|${one.to}`} atlas={atlas} edge={one} onSelect={onSelect} />
      ))}
    </ul>
  </>
);

const FactsBlock = ({ facts }: { readonly facts: Facts }): ReactElement => (
  <details open>
    <summary>what the parser read</summary>
    <h3>edges</h3>
    <ul className="facts">
      {facts.edges.length === 0 && <li className="muted">(none)</li>}
      {facts.edges.map((one) => (
        <li key={one.specifier}>
          <code>{one.specifier}</code>
          {one.bindings.length > 0 && (
            <span className="muted">
              {" "}
              {one.bindings.map((binding) => `${binding.kind} ${binding.symbol}`).join(", ")}
            </span>
          )}
        </li>
      ))}
    </ul>
    <h3>members and calls</h3>
    <ul className="facts">
      {facts.memberSites.length === 0 && <li className="muted">(none)</li>}
      {facts.memberSites.map((one, index) => (
        <li key={`${one.subject}-${one.in ?? ""}-${one.name}-${String(index)}`}>
          <span className="muted">{one.subject}</span> {one.in === undefined ? "" : `${one.in}.`}
          {one.name}
        </li>
      ))}
    </ul>
    <h3>exports</h3>
    <ul className="facts">
      {facts.exportSites.length === 0 && <li className="muted">(none)</li>}
      {facts.exportSites.map((one, index) => (
        <li key={`${one.kind}-${one.name}-${String(index)}`}>
          <span className="muted">{one.kind}</span> {one.name}{" "}
          <span className="muted">({one.reexport ? "re-export" : one.declares})</span>
        </li>
      ))}
    </ul>
  </details>
);

// The cycles that run through a node: any component with a member beneath it.
const cyclesThrough = (atlas: Atlas, node: ViewNode): ReadonlyArray<number> =>
  atlas.cycles.flatMap((cycle, index) =>
    cycle.some((file) => (node.kind === "file" ? file === node.id : file.startsWith(`${node.id}/`)))
      ? [index]
      : [],
  );

const NodePanel = ({
  atlas,
  factsOf,
  node,
  onNavigate,
  onSelect,
}: {
  readonly atlas: Atlas;
  readonly node: ViewNode;
  readonly factsOf: PanelProps["factsOf"];
  readonly onNavigate: (focus: string) => void;
  readonly onSelect: Select;
}): ReactElement => {
  const governing = atlas.nodes.find((one) => one.name === node.node);
  const isFile = node.kind === "file";
  const violations = atlas.violations.filter((one) =>
    isFile ? one.file === node.id : one.file.startsWith(`${node.id}/`),
  );
  const cycles = cyclesThrough(atlas, node);
  const edgesFrom = isFile ? atlas.edges.filter((one) => one.from === node.id) : [];
  const edgesTo = isFile ? atlas.edges.filter((one) => one.to === node.id) : [];

  const [facts, setFacts] = useState<Facts | "loading" | "unavailable" | null>(null);
  useEffect(() => {
    if (!isFile || factsOf === null) {
      setFacts(null);
      return;
    }
    let cancelled = false;
    setFacts("loading");
    factsOf(node.id)
      .then((read) => {
        if (!cancelled) setFacts(read);
      })
      .catch(() => {
        if (!cancelled) setFacts("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, isFile, factsOf]);

  return (
    <>
      <h2>
        <span className={`kind ${node.kind}`}>{node.kind}</span> {node.id === "" ? "/" : node.id}
      </h2>
      {node.kind === "folder" || node.kind === "outside" ? (
        <p>
          <button
            type="button"
            className="link"
            onClick={() => {
              onNavigate(node.id);
            }}
          >
            open this folder
          </button>
          {" · "}
          {node.files} {node.files === 1 ? "file" : "files"}
          {node.residue > 0 ? `, ${String(node.residue)} no family reaches` : ""}
        </p>
      ) : null}
      {governing === undefined ? (
        <p className="muted">
          {node.kind === "package" || node.kind === "builtin"
            ? "Outside the walk."
            : "No manifest node governs everything here."}
        </p>
      ) : (
        <section>
          <h3>
            governed by <code>{governing.path}</code>
            {governing.file === undefined ? "" : <span className="muted"> ({governing.file})</span>}
          </h3>
          {governing.message !== undefined && <p className="message">{governing.message}</p>}
          {(governing.unrestricted || governing.partial) && (
            <p className="muted">
              {governing.unrestricted ? "unrestricted: this tier states no allowlist yet. " : ""}
              {governing.partial ? "partial: this folder does not enumerate its files." : ""}
            </p>
          )}
          {governing.allowances.length > 0 && (
            <>
              <h3>may import</h3>
              <ul className="facts">
                {governing.allowances.map((one) => (
                  <li key={`${one.kind} ${one.entry}`}>
                    <span className="muted">{one.kind}</span> <code>{one.entry}</code>
                    {one.fragment === undefined ? (
                      ""
                    ) : (
                      <span className="muted"> via use: {one.fragment}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {governing.families.length > 0 && (
            <p className="muted">writes: {governing.families.join(", ")}</p>
          )}
        </section>
      )}
      {violations.length > 0 && (
        <section>
          <h3>violations</h3>
          <ul className="facts">
            {violations.map((one) => (
              <ViolationItem key={one.fingerprint} violation={one} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      )}
      {cycles.length > 0 && (
        <section>
          <h3>cycles</h3>
          <ul className="facts">
            {cycles.map((index) => (
              <li key={index}>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    onSelect({ kind: "cycle", index });
                  }}
                >
                  ↻ {atlas.cycles[index]?.length ?? 0} files
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {isFile && (
        <section>
          <h3>imports ({edgesFrom.length})</h3>
          <ul className="edge-list">
            {edgesFrom.map((one) => (
              <EdgeRow key={`${one.from}|${one.to}`} atlas={atlas} edge={one} onSelect={onSelect} />
            ))}
          </ul>
          <h3>imported by ({edgesTo.length})</h3>
          <ul className="edge-list">
            {edgesTo.map((one) => (
              <EdgeRow key={`${one.from}|${one.to}`} atlas={atlas} edge={one} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      )}
      {facts === "loading" && <p className="muted">reading the file…</p>}
      {facts === "unavailable" && (
        <p className="muted">the server could not read this file's facts</p>
      )}
      {facts !== null && facts !== "loading" && facts !== "unavailable" && (
        <FactsBlock facts={facts} />
      )}
    </>
  );
};

const ViolationPanel = ({
  highlight,
  onSelect,
  violation,
}: {
  readonly violation: SnapshotViolation;
  readonly highlight: Highlight | null;
  readonly onSelect: Select;
}): ReactElement => (
  <>
    <h2>
      <span className={`status ${violation.baselined ? "admitted" : "violation"}`}>
        {violation.kind}
      </span>{" "}
      {violation.ruleName}
    </h2>
    <p className="message">{violation.message}</p>
    <p>
      <code>{violation.fingerprint}</code>
    </p>
    <p className="muted">
      {violation.baselined ? "Carried by the baseline. " : ""}
      in <FileLink file={violation.file} onSelect={onSelect} />
      {violation.subject === null ? (
        ""
      ) : (
        <>
          {" "}
          · subject <code>{violation.subject}</code>
        </>
      )}
    </p>
    {violation.route !== undefined && (
      <section>
        <h3>route, {violation.route.length - 1} hops</h3>
        <ol className="route">
          {violation.route.map((file) => (
            <li key={file}>
              <FileLink file={file} onSelect={onSelect} />
            </li>
          ))}
        </ol>
      </section>
    )}
    {highlight !== null && highlight.missing.length > 0 && (
      <p className="muted">
        Not in this view: {highlight.missing.join(", ")}. Turn on outside, or open the folder they
        are in.
      </p>
    )}
  </>
);

const CyclePanel = ({
  highlight,
  members,
  onSelect,
}: {
  readonly members: ReadonlyArray<string>;
  readonly highlight: Highlight | null;
  readonly onSelect: Select;
}): ReactElement => (
  <>
    <h2>
      <span className="status ungoverned">cycle</span> {members.length} files
    </h2>
    <p className="muted">
      These files import each other, directly or through others. A cycle is a module boundary that
      does not exist.
    </p>
    <ul className="facts">
      {members.map((file) => (
        <li key={file}>
          <FileLink file={file} onSelect={onSelect} />
        </li>
      ))}
    </ul>
    {highlight !== null && highlight.missing.length > 0 && (
      <p className="muted">Not in this view: {highlight.missing.join(", ")}.</p>
    )}
  </>
);

export const Panel = (props: PanelProps): ReactElement => {
  const { atlas, highlight, selection, view } = props;
  const onSelect: Select = props.onSelect;
  let body: ReactElement;
  if (selection === null) {
    body = (
      <>
        <h2>{view.focus === "" ? "the repository" : view.focus}</h2>
        <p className="muted">
          {view.members.length} {view.members.length === 1 ? "member" : "members"},{" "}
          {view.edges.length} {view.edges.length === 1 ? "edge" : "edges"}. Click a folder to open
          it, a file or an edge to read about it.
        </p>
        <p className="muted">
          {atlas.violations.filter((one) => !one.baselined).length} violations in the atlas,{" "}
          {atlas.cycles.length} cycles, {atlas.designed.filter((one) => !one.used).length} unused
          allowances.
        </p>
        {atlas.cycles.length > 0 && (
          <section>
            <h3>cycles</h3>
            <ul className="facts">
              {atlas.cycles.map((cycle, index) => (
                <li key={cycle.join("|")}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onSelect({ kind: "cycle", index });
                    }}
                  >
                    ↻ {cycle.length} files, from {cycle[0]}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  } else if (selection.kind === "edge") {
    const edge = view.edges.find((one) => one.from === selection.from && one.to === selection.to);
    body =
      edge === undefined ? (
        <p className="muted">that edge is not in this view</p>
      ) : (
        <EdgePanel atlas={atlas} edge={edge} onSelect={onSelect} />
      );
  } else if (selection.kind === "violation") {
    const violation = atlas.violations.find((one) => one.fingerprint === selection.fingerprint);
    body =
      violation === undefined ? (
        <p className="muted">the atlas has no such violation</p>
      ) : (
        <ViolationPanel violation={violation} highlight={highlight} onSelect={onSelect} />
      );
  } else if (selection.kind === "cycle") {
    const members = atlas.cycles[selection.index];
    body =
      members === undefined ? (
        <p className="muted">the atlas has no such cycle</p>
      ) : (
        <CyclePanel members={members} highlight={highlight} onSelect={onSelect} />
      );
  } else {
    const node = findNode(view, selection.id);
    body =
      node === undefined ? (
        <p className="muted">that node is not in this view</p>
      ) : (
        <NodePanel
          atlas={atlas}
          node={node}
          factsOf={props.factsOf}
          onNavigate={props.onNavigate}
          onSelect={onSelect}
        />
      );
  }
  return (
    <aside className="panel">
      {selection !== null && (
        <button
          type="button"
          className="link clear"
          onClick={() => {
            props.onSelect(null);
          }}
        >
          ← clear selection
        </button>
      )}
      {body}
    </aside>
  );
};
