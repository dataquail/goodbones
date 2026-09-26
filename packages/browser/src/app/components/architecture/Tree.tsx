import type { AtlasEdge } from "../../../model/atlas.js";
import type { Arc, Relation, Row } from "./rows.js";

// The tree and its arcs: one row per visible file or folder, the edges drawn
// in a lane beside them. Every arc is there, greyed; the ones touching the
// focus come forward — out of it in the accent, into it in ink, refused in
// red — so a file's whole neighbourhood reads at a glance.

export const ROW = 24;
const LANE = 150;

type Props = {
  readonly rows: ReadonlyArray<Row>;
  readonly arcs: ReadonlyArray<Arc>;
  readonly focus: string | null;
  readonly focusIsFolder: boolean;
  readonly relations: ReadonlyMap<string, Relation>;
  readonly governedBy: string | null;
  readonly selected: string | null;
  readonly onHover: (path: string | null) => void;
  readonly onToggle: (folder: string) => void;
  readonly onSelect: (row: Row) => void;
};

type ArcClass = "out" | "in" | "within" | "dim";

const classify = (arc: Arc, focus: string | null, focusIsFolder: boolean): ArcClass => {
  if (focus === null) return "dim";
  const inside = (path: string): boolean =>
    focusIsFolder ? path === focus || path.startsWith(`${focus}/`) : path === focus;
  let out = false;
  let into = false;
  let within = false;
  for (const edge of arc.edges) {
    const fromIn = inside(edge.from);
    const toIn = inside(edge.to);
    if (fromIn && toIn) within = true;
    else if (fromIn) out = true;
    else if (toIn) into = true;
  }
  if (out) return "out";
  if (into) return "in";
  if (within) return "within";
  return "dim";
};

const ORDER: Readonly<Record<ArcClass, number>> = { dim: 0, within: 1, in: 2, out: 3 };

const arcPath = (from: number, to: number): string => {
  const y1 = from * ROW + ROW / 2;
  const y2 = to * ROW + ROW / 2;
  const span = Math.abs(from - to);
  const bulge = Math.min(LANE - 12, 18 + span * 5);
  return `M6 ${String(y1)} C ${String(6 + bulge)} ${String(y1)}, ${String(6 + bulge)} ${String(y2)}, 10 ${String(y2)}`;
};

const rowRelation = (row: Row, relations: ReadonlyMap<string, Relation>): Relation => {
  const own = relations.get(row.path);
  if (own !== undefined) return own;
  if (row.kind === "folder" && !row.expanded) {
    // A collapsed folder carries the strongest relation of what it hides.
    let best: Relation = null;
    for (const [path, relation] of relations) {
      if (!path.startsWith(`${row.path}/`)) continue;
      if (relation === "dep" || relation === "importer") return relation;
      best ??= relation;
    }
    return best;
  }
  return null;
};

const isGoverned = (row: Row, governedBy: string | null): boolean =>
  governedBy !== null &&
  (row.kind === "file"
    ? row.file.chain.includes(governedBy)
    : row.folder.node === governedBy || row.folder.declares.includes(governedBy));

export const Tree = ({
  arcs,
  focus,
  focusIsFolder,
  governedBy,
  onHover,
  onSelect,
  onToggle,
  relations,
  rows,
  selected,
}: Props): React.JSX.Element => {
  const height = Math.max(rows.length, 1) * ROW;
  const classified = arcs
    .map((arc) => ({ arc, kind: classify(arc, focus, focusIsFolder) }))
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return (
    <div
      className="tree"
      onMouseLeave={() => {
        onHover(null);
      }}
    >
      <ol className="rows" style={{ height }}>
        {rows.map((row) => {
          const relation = rowRelation(row, relations);
          const classes = ["row", row.kind];
          if (relation !== null) classes.push(relation);
          if (isGoverned(row, governedBy)) classes.push("governed");
          if (selected === row.path) classes.push("selected");
          const violations = row.kind === "file" ? row.file.violations : row.violations;
          return (
            <li
              key={row.path}
              className={classes.join(" ")}
              style={{ paddingLeft: 8 + row.depth * 14, height: ROW }}
              onMouseEnter={() => {
                onHover(row.path);
              }}
              onClick={() => {
                onSelect(row);
              }}
              title={row.path}
            >
              {row.kind === "folder" ? (
                <button
                  type="button"
                  className="chevron"
                  aria-label={row.expanded ? "collapse" : "expand"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(row.path);
                  }}
                >
                  {row.expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="chevron spacer" />
              )}
              <span className={`name ${row.kind === "file" && !row.file.walked ? "outside" : ""}`}>
                {row.name}
                {row.kind === "folder" ? "/" : ""}
              </span>
              {row.kind === "folder" && row.folder.declares.length > 0 ? (
                <span className="node-mark" title={`node: ${row.folder.declares.join(", ")}`}>
                  §
                </span>
              ) : null}
              {row.kind === "folder" && !row.expanded ? (
                <span className="meta">{row.files}</span>
              ) : null}
              {violations > 0 ? (
                <span className="badge refused" title={`${String(violations)} violation(s)`}>
                  {violations}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <svg
        className="arcs"
        width={LANE}
        height={height}
        viewBox={`0 0 ${String(LANE)} ${String(height)}`}
        aria-hidden="true"
      >
        <defs>
          {(["dim", "within", "in", "out", "refused"] as const).map((kind) => (
            <marker
              key={kind}
              id={`head-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className={`head ${kind}`} />
            </marker>
          ))}
        </defs>
        {classified.map(({ arc, kind }) => {
          const refused = arc.refused && kind !== "dim";
          const marker = refused ? "refused" : kind;
          return (
            <path
              key={`${String(arc.from)}>${String(arc.to)}`}
              d={arcPath(arc.from, arc.to)}
              className={`arc ${kind} ${arc.refused ? "refused" : ""}`}
              markerEnd={`url(#head-${marker})`}
            >
              <title>{describe(arc.edges)}</title>
            </path>
          );
        })}
      </svg>
    </div>
  );
};

const describe = (edges: ReadonlyArray<AtlasEdge>): string =>
  edges
    .slice(0, 6)
    .map((edge) => `${edge.from} → ${edge.to}${edge.status === "refused" ? " (refused)" : ""}`)
    .join("\n") + (edges.length > 6 ? `\n… ${String(edges.length - 6)} more` : "");
