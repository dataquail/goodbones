import { useEffect, useMemo, useRef, useState } from "react";

import type { Atlas, AtlasNode, AtlasPosition } from "../../../model/atlas.js";
import { tokenizeLines } from "./yaml-tokens.js";

// The manifest, rendered as it was written — every file `include` pulled in
// under its own tab — with each node's lines addressable: the line a node
// starts on is its anchor, the lines down to the next node are its own. A
// node's allowance no import uses is marked where it was written.

type Props = {
  readonly atlas: Atlas;
  readonly activeNode: string | null;
  readonly chain: ReadonlyArray<string>;
  readonly scrollTo: AtlasPosition | null;
  readonly selectedNode: string | null;
  readonly onHoverNode: (id: string | null) => void;
  readonly onSelectNode: (id: string | null) => void;
};

type Anchored = {
  readonly node: AtlasNode;
  readonly line: number;
  // The last line that is this node's own, before the next node begins.
  readonly end: number;
};

const anchorsOf = (
  nodes: ReadonlyArray<AtlasNode>,
  file: string,
  lines: number,
): ReadonlyArray<Anchored> => {
  const here = nodes
    .filter((node) => node.position?.file === file)
    .map((node) => ({ node, line: node.position?.line ?? 0 }))
    .sort((a, b) => (a.line !== b.line ? a.line - b.line : a.node.depth - b.node.depth));
  return here.map((one, index) => {
    const next = here.slice(index + 1).find((other) => other.line > one.line);
    return { node: one.node, line: one.line, end: next === undefined ? lines : next.line - 1 };
  });
};

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const ManifestPane = ({
  activeNode,
  atlas,
  chain,
  onHoverNode,
  onSelectNode,
  scrollTo,
  selectedNode,
}: Props): React.JSX.Element => {
  const files = atlas.manifest.files;
  const [tab, setTab] = useState(files[0]?.path ?? "");
  const wanted = scrollTo?.file ?? null;
  useEffect(() => {
    if (wanted !== null && files.some((file) => file.path === wanted)) setTab(wanted);
  }, [wanted, files]);
  useEffect(() => {
    if (!files.some((file) => file.path === tab)) setTab(files[0]?.path ?? "");
  }, [files, tab]);

  const active = files.find((file) => file.path === tab) ?? files[0];
  const lines = useMemo(() => (active === undefined ? [] : active.text.split("\n")), [active]);
  const tokens = useMemo(() => tokenizeLines(lines), [lines]);
  const anchors = useMemo(
    () => (active === undefined ? [] : anchorsOf(atlas.manifest.nodes, active.path, lines.length)),
    [active, atlas, lines.length],
  );
  const byLine = useMemo(() => new Map(anchors.map((one) => [one.line, one] as const)), [anchors]);
  const own = anchors.find((one) => one.node.id === activeNode) ?? null;
  const chainLines = useMemo(
    () => new Set(anchors.filter((one) => chain.includes(one.node.id)).map((one) => one.line)),
    [anchors, chain],
  );

  // The unused allowances, found where they were written.
  const slackLines = useMemo(() => {
    const found = new Map<number, string>();
    for (const anchor of anchors) {
      const unused = (anchor.node.imports?.allowances ?? []).filter((one) => !one.used);
      if (unused.length === 0) continue;
      for (let line = anchor.line; line <= anchor.end; line += 1) {
        const text = lines[line - 1] ?? "";
        for (const allowance of unused) {
          if (
            new RegExp(`(^|[\\s\\[,"'])${escapeRegExp(allowance.entry)}(["',\\]\\s]|$)`).test(text)
          ) {
            found.set(line, allowance.entry);
          }
        }
      }
    }
    return found;
  }, [anchors, lines]);

  // Bring the focused node's anchor into view when the focus moves.
  const listRef = useRef<HTMLOListElement | null>(null);
  const targetLine = scrollTo !== null && scrollTo.file === active?.path ? scrollTo.line : null;
  useEffect(() => {
    if (targetLine === null || listRef.current === null) return;
    const element = listRef.current.querySelector<HTMLElement>(
      `[data-line="${String(targetLine)}"]`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [targetLine, tab]);

  // The innermost node whose lines include this one.
  const nodeAtLine = (line: number): AtlasNode | null => {
    let best: Anchored | null = null;
    for (const anchor of anchors) {
      if (anchor.line <= line && (best === null || anchor.line >= best.line)) best = anchor;
    }
    return best?.node ?? null;
  };

  return (
    <div
      className="manifest"
      onMouseLeave={() => {
        onHoverNode(null);
      }}
    >
      <div className="pane-head tabs-row">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={file.path === active?.path ? "tab active" : "tab"}
            onClick={() => {
              setTab(file.path);
            }}
            title={file.path}
          >
            {file.path.split("/").slice(-2).join("/")}
          </button>
        ))}
      </div>
      <ol className="source" ref={listRef}>
        {lines.map((text, index) => {
          const line = index + 1;
          const anchor = byLine.get(line);
          const classes = ["line"];
          if (anchor !== undefined) classes.push("anchor");
          if (own !== null && line >= own.line && line <= own.end) classes.push("own");
          if (chainLines.has(line)) classes.push("chain");
          if (anchor?.node.id === selectedNode) classes.push("selected");
          const slack = slackLines.get(line);
          if (slack !== undefined) classes.push("slack");
          return (
            <li
              key={line}
              data-line={line}
              className={classes.join(" ")}
              onMouseEnter={() => {
                onHoverNode(nodeAtLine(line)?.id ?? null);
              }}
              onClick={() => {
                const node = nodeAtLine(line);
                onSelectNode(node === null ? null : node.id);
              }}
              title={
                slack !== undefined
                  ? `No import uses "${slack}": this allowance is slack.`
                  : anchor === undefined
                    ? undefined
                    : `${anchor.node.id} — ${String(anchor.node.files)} file(s) governed`
              }
            >
              <span className="ln">{line}</span>
              <span className="code">
                {text === ""
                  ? " "
                  : (tokens[index] ?? []).map((token, at) => (
                      <span key={at} className={`tk-${token.kind}`}>
                        {token.text}
                      </span>
                    ))}
              </span>
              {anchor !== undefined ? <span className="node-tag">{anchor.node.id}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
