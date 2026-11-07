"use strict";
/*
 * Show a folder of decision records back to the person who wrote them.
 *
 * WHAT THEY SEE. Their own records, as decisions: which are in force with the reason each one
 * gives, which were replaced and by what, which were retired, ruled out or never decided. Then the
 * marks a file cannot make for itself: which carry no reason. Then one question, if there is one.
 *
 * WHY IT SAYS SO LITTLE. Everything here is the person's own writing, so the only new information
 * is what the records say about each other. A record with nothing wrong gets one line. A folder
 * with nothing wrong gets no question. Nothing is explained, because there is nothing to learn
 * before it is useful.
 *
 * Pure. An object in, text out.
 */
const path = require("path");
const { nameOf } = require("./flags");
const { allChains } = require("./chain");

const GROUPS = [
  ["current", "In force"],
  ["to_settle", "To settle"],
  ["replaced", "Replaced"],
  ["retired", "Retired"],
  ["ruled_out", "Ruled out"],
  ["proposed", "Not decided yet"],
  ["unclear", "Status not understood"],
];

const pad4 = (n) => (n == null ? "    " : String(n).padStart(4, "0"));

/** One line, no wider than `width`, cut at a word. The indent in front of it is kept. */
function clip(text, width) {
  const raw = String(text || "");
  const indent = (raw.match(/^\s*/) || [""])[0];
  const t = indent + raw.replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  return t.slice(0, Math.max(indent.length + 8, width - 4)).replace(/\s+\S*$/, "") + " ...";
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

/**
 * The show-back, as lines of plain text.
 *
 * @param result  what readAdrs returned
 * @param {{ width?: number, limit?: number, paint?: object }} [opts]
 *        `limit` caps the records listed under each heading (0 lists all). `paint` supplies
 *        `bold` and `dim` for a terminal that has colour; without it the text is plain.
 *        `question: false` leaves the one question off, for a caller that asks it itself.
 */
function renderShowBack(result, opts = {}) {
  const width = Math.max(60, Math.min(opts.width || 100, 160));
  const limit = opts.limit == null ? 12 : opts.limit;
  const bold = (opts.paint && opts.paint.bold) || ((s) => s);
  const dim = (opts.paint && opts.paint.dim) || ((s) => s);
  const out = [];
  const records = result.records;

  if (!records.length) {
    if (result.unread && result.unread.length) {
      out.push(`Unl found ${plural(result.unread.length, "file")} that may be decision records, in a format it does not read yet (${[...new Set(result.unread.map((f) => f.split(".").pop()))].join(", ")}).`);
      out.push(`They are in ${[...new Set(result.unread.map((f) => f.split("/").slice(0, -1).join("/")))].slice(0, 3).join(", ")}. Nothing was imported.`);
      return out.join("\n");
    }
    out.push("No decision records found here.");
    if (result.walkStopped) out.push("The repository is large, so the search for record folders stopped early. `--dir` names the folder outright.");
    const looked = (result.looked || []).slice(0, 6);
    if (looked.length) out.push(`Unl looked in ${looked.join(", ")} and in folders named like them.`);
    else out.push("Unl looked in docs/adr, docs/decisions, doc/adr and folders named like them.");
    return out.join("\n");
  }

  const dates = records.map((r) => r.date).filter(Boolean).sort();
  const span = dates.length ? (dates[0].slice(0, 4) === dates[dates.length - 1].slice(0, 4) ? `, written in ${dates[0].slice(0, 4)}` : `, written from ${dates[0].slice(0, 4)} to ${dates[dates.length - 1].slice(0, 4)}`) : "";
  const where = result.folders.length === 1 ? result.folders[0].dir : `${result.folders.length} folders`;
  out.push(bold(`Unl read ${plural(records.length, "decision record")} in ${where}${span}.`));
  if (result.folders.length > 1) for (const f of result.folders) out.push(dim(`  ${f.dir}  ${plural(f.records.length, "record")}`));

  const successor = (r) => {
    const names = r.replacedBy.map((t) => nameOf(t.record));
    if (names.length) return `replaced by ${names.join(" and ")}`;
    const said = r.relations.find((x) => x.rel === "superseded_by" && x.target);
    if (said && said.external) return "replaced by a record kept elsewhere";
    return "replaced, with nothing named in its place";
  };

  for (const [key, label] of GROUPS) {
    const group = records.filter((r) => r.lifecycle === key);
    if (!group.length) continue;
    out.push("");
    out.push(bold(`${label} (${group.length})`));
    const shown = limit ? group.slice(0, limit) : group;
    for (const r of shown) {
      const head = `  ${pad4(r.number)}  ${r.title || path.posix.basename(r.file)}`;
      const date = r.date ? `  ${dim(r.date)}` : "";
      if (key === "current") {
        out.push(clip(head, width - 12) + date);
        if (r.why) out.push(dim(`        why  ${clip(r.why, width - 14)}`));
      } else if (key === "replaced") {
        out.push(clip(`${head}, ${successor(r)}`, width));
      } else if (key === "to_settle") {
        const by = r.replacedBy.filter((t) => !t.saidBy.includes("older")).map((t) => nameOf(t.record));
        if (r.partlyReplaced) out.push(clip(`${head}, which was replaced in part`, width));
        else out.push(clip(`${head}, which ${by.join(" and ")} says it replaces`, width));
      } else if (key === "proposed") {
        out.push(clip(`${head} (${r.status.state === "draft" ? "a draft" : "proposed"})`, width));
      } else if (key === "unclear") {
        out.push(clip(r.statusMissing ? `${head}, which states no status where the others here do` : `${head}, whose status reads "${clip(r.status.raw, 60)}"`, width));
      } else {
        out.push(clip(head, width - 12) + date);
      }
    }
    if (shown.length < group.length) out.push(dim(`  and ${group.length - shown.length} more`));
  }

  const chains = allChains(records).filter((c) => c.records.length >= 3);
  if (chains.length) {
    out.push("");
    out.push(bold("Histories"));
    for (const c of chains.slice(0, 5)) out.push(clip(`  ${c.records.map((r) => (r.number != null ? pad4(r.number) : `"${r.title}"`)).join(" > ")}${c.loop ? " (and back again)" : ""}`, width));
  }

  const notes = [];
  const noReason = records.filter((r) => r.lifecycle === "current" && r.noReason);
  if (noReason.length) notes.push(`${plural(noReason.length, "record")} in force ${noReason.length === 1 ? "carries" : "carry"} no reason (${clip(noReason.slice(0, 8).map((r) => (r.number != null ? pad4(r.number) : `"${r.title}"`)).join(", "), width - 40)}${noReason.length > 8 ? " and more" : ""})`);
  const assumed = records.filter((r) => r.statusAssumed && r.folderHasStatuses);
  if (assumed.length) notes.push(`${plural(assumed.length, "record")} ${assumed.length === 1 ? "has" : "have"} no status and ${assumed.length === 1 ? "is" : "are"} shown as in force`);
  const unstated = records.filter((r) => r.statusAssumed && !r.folderHasStatuses);
  if (unstated.length) notes.push("no record here states a status, so each is shown as in force");
  const leftOut = result.folders.reduce((n, f) => n + f.leftOut.length, 0);
  if (result.unread && result.unread.length) notes.push(`${plural(result.unread.length, "file")} ${result.unread.length === 1 ? "is" : "are"} in a format Unl does not read yet (${[...new Set(result.unread.map((f) => f.split(".").pop()))].join(", ")})`);
  if (leftOut) notes.push(`${plural(leftOut, "file")} in ${result.folders.length === 1 ? "that folder" : "those folders"} ${leftOut === 1 ? "was" : "were"} not read as ${leftOut === 1 ? "a record" : "records"}`);
  if (result.walkStopped) notes.push("the repository is large, so the search for record folders stopped early");
  const quiet = (result.flags || []).filter((f) => !f.question);
  if (quiet.length) notes.push(`${plural(quiet.length, "other thing")} to check, listed with --flags`);
  if (notes.length) {
    out.push("");
    for (const n of notes) out.push(dim(`  ${n.charAt(0).toUpperCase()}${n.slice(1)}.`));
  }

  if (result.question && opts.question !== false) {
    out.push("");
    out.push(bold("One question only you can answer"));
    out.push(`  ${result.question.question}`);
    const more = (result.flags || []).filter((f) => f.question && f.id !== result.question.id).length;
    if (more) out.push(dim(`  ${plural(more, "more question")} can wait. They are listed with --flags.`));
  }
  return out.join("\n");
}

/** Every flag, one to a line, with the question each one asks when it asks one. */
function renderFlags(result) {
  const flags = result.flags || [];
  if (!flags.length) return "Nothing to check. The records agree with each other and with the repository.";
  const out = [`${plural(flags.length, "thing")} to check.`, ""];
  for (const f of flags) {
    out.push(`  ${f.question || f.says}`);
    if (f.options) out.push(`      ${f.options.join(" / ")}`);
  }
  return out.join("\n");
}

module.exports = { renderShowBack, renderFlags, clip };
