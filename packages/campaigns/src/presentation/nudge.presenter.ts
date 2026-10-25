import type { Residue as ResidueVector } from "../core/phases.js";
import type { Ask, Nudge } from "../modules/ledgers/use-cases/nudge.result.js";
import { count } from "./lines.js";

const days = (from: string | null, now: number): string => {
  if (from === null) return "";
  const elapsed = Math.floor((now - Date.parse(from)) / 86_400_000);

  return `, ${count(elapsed, "day")} here`;
};

const describeAsk = (ask: Ask): string => {
  switch (ask) {
    case "none":
      return "none — the holdouts above are context; paydown is welcome in its own commit, not asked for";
    case "note":
      return "note";
    case "hold":
      return "hold — leave the sector no worse; paydown is welcome in its own commit, not asked for";
    case "paydown-optional":
      return "paydown-optional — this diff edits no holdout; paydown is welcome in its own commit";
    case "paydown-required":
      return "paydown-required — this diff edits a holdout, so the sector must leave with fewer";
  }
};

export const renderNudge = (nudge: Nudge, now: number): ReadonlyArray<string> => {
  if (nudge.sectors.length === 0 && nudge.unbirths.length === 0) {
    return [
      `nothing you touched is under a campaign (${count(nudge.touched.length, "file")} in the diff).`,
    ];
  }

  const lines: Array<string> = [];

  const say = (...more: ReadonlyArray<string>): void => {
    for (const one of more) lines.push(one);
  };

  const residueOf = (vector: ResidueVector): string =>
    Object.entries(vector)
      .map(([id, n]) => `${id} ${String(n)}`)
      .join(" · ");

  for (const one of nudge.unbirths) {
    say(
      `${one.campaign}`,
      `  this diff un-births sector ${one.sector}: ${one.marker} was deleted; its files return to the legacy, where the first phase's objectives count for them.`,
      "",
    );
  }

  let last = "";

  for (const one of nudge.sectors) {
    if (one.campaign !== last) {
      if (last !== "") say("");
      say(one.campaign);
      last = one.campaign;
    }

    // A campaign with no phases has one implicit one: its objectives.
    const at = one.shared
      ? "held by every sector, on no phase"
      : one.phase.of === 0
        ? "its objectives"
        : `phase ${one.phase.id ?? "done"} (${String(one.phase.index + 1)} of ${String(one.phase.of)}${one.phase.open ? ", open" : one.phase.attested ? ", attested" : ""})`;

    const moved = one.judged.index !== one.phase.index;

    // An attested phase is never quiet: the sector is waiting on a hand,
    // and the one who touched it is the nearest.
    const quiet =
      one.holdouts.total === 0 &&
      one.measures.every((measure) => measure.before === measure.after) &&
      one.direction === "neutral" &&
      !moved &&
      !one.phase.open &&
      !one.phase.attested &&
      one.verdict === "ok" &&
      one.prerequisites.every((prerequisite) => prerequisite.count === 0) &&
      one.belongsInSector.length === 0 &&
      one.ahead.length === 0 &&
      one.conceded.length === 0 &&
      one.sentBack === null;

    if (quiet) {
      say(`  ${one.sector} at ${at} · nothing in your files, diff neutral`);
      continue;
    }

    say(`  ${one.sector} — ${at}${days(one.phase.since, now)}`);

    if (moved) {
      say(
        `    this diff moves it from ${one.judged.id ?? "done"}: it is judged by the phase it was found at`,
      );
    }

    // The phase's intent, wherever one is stated; an open phase is nothing
    // but its intent, so there its absence is said too.
    if (one.phase.open || one.intent !== null) say(`    intent: ${one.intent ?? "(none stated)"}`);

    if (one.phase.open) {
      if (one.notes.length > 0) {
        say(
          `    notes (${String(one.notes.length)}, data, left at this phase): ${one.notes.map((n) => `${n.at.slice(0, 10)} ${JSON.stringify(n.text)}`).join(" · ")}`,
        );
      }

      say(
        `    if this change taught you something about that shape: refine phase \`${one.phase.id ?? ""}\` in the manifest`,
        `    (a defined phase needs at least one objective with a probe), in its own commit — or leave a note:`,
        `      architecture campaigns note ${one.sector} "…" --campaign ${one.campaign}`,
      );
    }

    if (one.phase.attested) {
      say(
        `    this phase is attested, not detected: no objective sees it done. When it is, record it —`,
        `      architecture campaigns attest ${one.sector} ${one.phase.id ?? ""} --reason "…" [--evidence <url>] --campaign ${one.campaign}`,
      );
    }

    const toward = residueOf(one.toward);

    if (toward !== "") say(`    toward the next phase: ${toward}`);

    // Each objective's own intent beside its count, so the why is read
    // where the check is.
    for (const objective of one.objectives) {
      if (objective.intent !== null) say(`      ${objective.id} — ${objective.intent}`);

      if (objective.shared) {
        say(
          `      ${objective.id}: a prerequisite — met on the shared files, and every sector at this phase waits on it`,
        );
      }
    }

    const owed = one.prerequisites.filter((prerequisite) => prerequisite.count > 0);

    if (owed.length > 0) {
      say(
        `    prerequisites, which hold every sector at the phase that names them:`,
        ...owed.map(
          (prerequisite) =>
            `      ${prerequisite.objective} ${String(prerequisite.count)}` +
            (prerequisite.phase === null
              ? " — named by no phase"
              : ` — ${prerequisite.phase}${prerequisite.waiting.length === 0 ? ", where no sector stands yet" : `: ${prerequisite.waiting.join(", ")}`}`),
        ),
      );
    }

    if (one.holdouts.sector.length > 0) {
      say(
        `    of the sector as a whole:`,
        ...one.holdouts.sector.map((h) => `      ${h.objective}: ${h.message}`),
        ...one.unmatchedOwns.map(
          (glob) => `      (its marker owns \`${glob}\`, which no file matches)`,
        ),
      );
    }

    if (one.holdouts.shown.length > 0) {
      say(
        `    in the files you touched, nearest your change (${String(one.holdouts.shown.length)} of ${String(one.holdouts.touched)}; ${String(one.holdouts.total)} in the sector):`,
        ...one.holdouts.shown.map(
          (h) =>
            `      ${h.file}${h.subject === null ? "" : `#${h.subject.split("#")[0] ?? ""}`}${h.line === null ? "" : `:${String(h.line)}`}  ${h.objective}`,
        ),
      );
    }

    if (one.added.length > 0 || one.removed.length > 0) {
      const delta = [...one.removed.map((r) => `−${r}`), ...one.added.map((a) => `+${a}`)].join(
        " · ",
      );

      say(`    this diff: ${delta}  ${one.direction}`);
    } else {
      // No entry to name, but a count that moved — a holdout outside the
      // files touched, say. Only the dimensions that moved, and only the
      // holdouts: a scalar has its own line below.
      const scalar = new Set(one.measures.map((measure) => measure.objective));

      const moved = Object.keys(one.residue.after).filter(
        (id) => !scalar.has(id) && (one.residue.before[id] ?? 0) !== (one.residue.after[id] ?? 0),
      );

      if (moved.length > 0) {
        const pick = (vector: ResidueVector): ResidueVector =>
          Object.fromEntries(moved.map((id) => [id, vector[id] ?? 0]));

        say(
          `    this diff: ${residueOf(pick(one.residue.before))} → ${residueOf(pick(one.residue.after))}  ${one.direction}`,
        );
      }
    }

    if (one.conceded.length > 0) {
      say(
        `    conceded ${nudge.mode === "ledger" ? "in the working tree" : "on this branch"}, in the ledger: ${one.conceded.join(" · ")}`,
      );
    }

    if (one.sentBack !== null) {
      say(
        `    the concession sends ${one.sector} back ${one.sentBack.from ?? "done"} → ${one.sentBack.to ?? "done"}` +
          (one.sentBack.revoked.length === 0
            ? ""
            : `, and revokes the attestation of ${one.sentBack.revoked.join(", ")}: what was attested no longer holds, so attest it again once it does`),
      );
    }

    const counted = one.entered.filter((entry) => entry.count > 0);

    if (counted.length > 0) {
      say(
        `    now counted: ${counted.map((entry) => `${entry.objective} ${String(entry.count)}`).join(" · ")} — in window from ${one.phase.id ?? "here"}, not growth`,
      );
    }

    for (const measure of one.measures) {
      if (measure.before === measure.after && !measure.back) continue;
      // In the ledger mode `before` is the record; in the exact mode it is
      // the base tree's value, and the record is named beside it.
      const fromRecord = nudge.mode === "ledger";

      const bounds = [
        ...(fromRecord || measure.recorded === null
          ? []
          : [`recorded ${String(measure.recorded)}`]),
        ...(measure.target === null ? [] : [`target ${String(measure.target)}`]),
        ...(measure.tolerance === 0 ? [] : [`tolerance ${String(measure.tolerance)}`]),
      ];

      const was =
        measure.before === null
          ? "unrecorded"
          : `${fromRecord ? "recorded " : ""}${String(measure.before)}`;

      const is =
        measure.after === null
          ? "no number"
          : `${fromRecord ? "now " : ""}${String(measure.after)}`;

      say(
        `    ${measure.objective}: ${was} → ${is}` +
          (bounds.length === 0 ? "" : ` (${bounds.join(", ")})`) +
          (measure.back
            ? "  back"
            : measure.conceded
              ? "  conceded"
              : measure.grows
                ? one.shared
                  ? "  measured, not held"
                  : `  grows in ${one.judged.id ?? "this phase"}`
                : ""),
      );
    }

    if (one.ahead.length > 0) {
      // One weight for the line when every entry owes the same; each its own
      // when they differ.
      const weights = new Set(one.ahead.map((a) => a.onAhead));
      const shared = weights.size === 1 ? [...weights][0] : undefined;
      say(
        `    ahead of plan: ${one.ahead.map((a) => `${a.objective} −${String(a.before - a.after)} belongs to ${a.phase ?? "no phase"}${shared === undefined ? ` (${a.onAhead})` : ""}`).join(" · ")}; ` +
          `${one.sector} is at ${one.phase.id ?? "done"}${one.phase.attested ? " (not yet attested)" : ""}` +
          (shared === undefined ? "" : ` — onAhead: ${shared}`),
      );
    }

    for (const file of one.belongsInSector)
      say(`    ${file} landed in the legacy inside the scope: this belongs in a sector`);

    if (one.held.length > 0) {
      say(
        `    went back at an open phase, held by the phase that named it: ${one.held.map((h) => `${h.objective} (${h.phase ?? "no phase"}, ${h.onTouch})`).join(" · ")}`,
      );
    }

    say(
      `    onTouch: ${one.onTouch}${moved ? ` (of ${one.judged.id ?? "done"})` : ""} — ${one.verdict}`,
    );
    say(`    ask: ${describeAsk(one.ask)}`);
  }

  say("", nudge.ok ? "ok" : "not ok");

  return lines;
};
