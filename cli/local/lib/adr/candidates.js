"use strict";
/*
 * Turn the records that were read into proposals a person can keep.
 *
 * WHY A PROPOSAL AND NOT A DECISION. Reading a folder is not deciding anything. What comes out of
 * here is a set of proposals, each built only from the person's own record, and each one stays a
 * proposal until the person says to keep it. Keeping is not done here. The install has one place
 * that builds a kept record and computes its address, and an ADR goes through that place like
 * anything else, so there is one copy of that arithmetic and not two.
 *
 * WHAT A PROPOSAL CARRIES, AND WHERE IN THE RECORD IT CAME FROM.
 *   the title                      title
 *   the Decision section           statement, in the author's words
 *   the Context, or "because ..."  why
 *   decision drivers               points of type constraint
 *   options not chosen             points of type rejected_alternative, with what was said against each
 *   options weighed, none chosen   points of type option_weighed
 *   consequences                   points of type consequence
 *   the context, beside a reason   points of type context
 *   tags, package                  scope
 *   deciders                       settled.by, a list
 *   the record's own date          settled.on, a day with no time
 *   Superseded by / Supersedes     replacedBy and replaces
 *   the file, its lines, its hash  source
 *
 * A record that was only proposed, or was rejected, is still a proposal here and says so in
 * `lifecycle`. Whether something ruled out is worth keeping is the person's call.
 */
const path = require("path");

const posix = (p) => String(p).split(path.sep).join("/");

/** The identifier a record keeps as a decision: where it lives, without its extension. Stable while the file stays put. */
function keyOf(record) {
  return "adr:" + posix(record.file).replace(/\.(?:md|markdown|mdx|rst)$/i, "");
}

/**
 * One proposal per record.
 *
 * @returns proposals, each:
 *   { key, title, statement, why, noReason, scope, points, settled: { on, source, by },
 *     lifecycle, replaces: [key], replacedBy: [key], flags: [flag id],
 *     source: { kind: "adr", file, lines, whyLines, digest, form, number, status } }
 */
function toCandidates(result) {
  const flagsByFile = new Map();
  for (const f of result.flags || []) for (const file of f.files) {
    if (!flagsByFile.has(file)) flagsByFile.set(file, []);
    flagsByFile.get(file).push(f.id);
  }
  return result.records.map((r) => {
    const statement = r.statement || r.title;
    const scope = [...new Set([...(r.pkg ? [r.pkg] : []), ...r.tags])];
    return {
      key: keyOf(r),
      title: r.title,
      statement,
      why: r.why || null,
      noReason: !r.why && !r.points.some((p) => p.type === "consequence" || p.type === "context"),
      scope,
      points: r.points.map((p) => (p.because ? { type: p.type, statement: p.statement, because: p.because } : { type: p.type, statement: p.statement })),
      settled: { on: r.date || null, source: r.dateSource || null, by: r.deciders },
      lifecycle: r.lifecycle,
      replaces: r.replaces.map((t) => keyOf(t.record)).sort(),
      replacedBy: r.replacedBy.map((t) => keyOf(t.record)).sort(),
      flags: flagsByFile.get(r.file) || [],
      source: { kind: "adr", file: posix(r.file), lines: r.lines.decision || r.lines.file, whyLines: r.whySource === "context" && r.lines.context ? r.lines.context : r.lines.decision, digest: r.digest, form: r.form, number: r.number, status: r.status.raw || null },
    };
  });
}

/** Can this proposal be kept as a decision in force or as history? False for one that waits on the person or was never decided. */
function keepable(candidate) {
  return ["current", "replaced", "retired"].includes(candidate.lifecycle);
}

module.exports = { toCandidates, keepable, keyOf };
