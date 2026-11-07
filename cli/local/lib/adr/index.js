"use strict";
/*
 * Import a repository's architecture decision records.
 *
 * WHAT IT DOES, IN ONE COMMAND. Finds the folders where the records are kept, reads each record
 * as the decision it is (its statement, its reason, what it applies to, when it was settled, what
 * it replaced and what replaced it), shows them back, and asks the one question only the person
 * can answer. What it hands on is a set of proposals. Nothing is kept until the person says so.
 *
 * WHO IT IS FOR. Anyone who has kept decisions by hand. They have been writing Unl's unit for
 * years and watching it go stale, because a file cannot tell an agent what it says before the
 * agent acts. The import is how that record starts being handed over.
 *
 *   readAdrs(root, opts)    read the folders, return records, flags and the question
 *   toCandidates(result)    the proposals, ready for a store to hold
 *   run(argv, io)           the command: text for a person, or JSON with --json
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseAdr } = require("./parse");
const { findAdrDirs, listRecordFiles, DIR_NAME, KNOWN_DIRS } = require("./discover");
const { linkRecords, allChains } = require("./chain");
const { findFlags, pickQuestion } = require("./flags");
const { toCandidates, keepable } = require("./candidates");
const { renderShowBack, renderFlags } = require("./show");

const posix = (p) => String(p).split(path.sep).join("/");
/** Folder names that hold documentation, so anything before them in a path is the package the records belong to. */
const DOC_PARTS = /^(?:docs?|documentation|adrs?|\.adr|decisions?|architecture|arch|design|dev|development|decision[-_ ]?records?|architecture[-_ ]?decisions?)$/i;

/** The package a record folder belongs to in a monorepo: the path in front of its documentation folders. */
function packageOf(dir) {
  const parts = posix(dir).split("/");
  const at = parts.findIndex((p) => DOC_PARTS.test(p));
  const head = at <= 0 ? [] : parts.slice(0, at);
  return head.length ? head.join("/") : null;
}

/**
 * The day each file first entered the repository, from git, for records that carry no date of
 * their own. A shallow clone has no history to read, so it gives none rather than the wrong day.
 */
function gitFirstDates(root, dir) {
  const dates = new Map();
  const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false") return dates;
    const log = git(["log", "--diff-filter=A", "--name-only", "--format=%x00%as", "--", dir]);
    let day = null;
    for (const line of log.split("\n")) {
      if (line.startsWith("\u0000")) { day = line.slice(1).trim(); continue; }
      const file = line.trim();
      if (file && day) dates.set(posix(file), day); // the log runs newest first, so the last write wins and is the oldest
    }
  } catch {}
  return dates;
}

/**
 * Read a repository's decision records.
 *
 * @param {string} root  the repository root
 * @param {{ dir?: string, git?: boolean, settled?: string[] }} [opts]
 *        `dir` names the record folder outright. `git: false` skips reading dates from history.
 *        `settled` lists the ids of flags the person has already answered.
 */
function readAdrs(root, opts = {}) {
  const abs = path.resolve(root);
  const { dirs, walkStopped } = findAdrDirs(abs, opts);
  const others = new Set(dirs.map((d) => d.dir));
  const folders = [];
  const unread = [];
  for (const d of dirs) {
    const { files, leftOut } = listRecordFiles(abs, d.dir, others);
    const records = [];
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(abs, file), "utf8");
      } catch {
        leftOut.push({ file, why: "could not be read" });
        continue;
      }
      const r = parseAdr(text, file);
      // Some folders file records by where they stand ("proposed/", "rejected/"). A record that states no status takes its folder's.
      if (r.kind === "adr" && !r.has.status) {
        const filed = file.slice(d.dir.length + 1).split("/").slice(0, -1).map((p) => (p.match(/^(proposed|drafts?|rejected|superseded|deprecated|accepted)(?:[-_ ]adrs?)?$/i) || [])[1]).filter(Boolean).pop();
        if (filed) {
          const state = /^draft/i.test(filed) ? "draft" : filed.toLowerCase();
          r.status = { raw: `in the folder ${file.slice(d.dir.length + 1).split("/").slice(0, -1).join("/")}`, state, understood: true, fromFolder: true };
          r.has.status = true;
          r.proven = true;
        }
      }
      if (r.kind === "adr") records.push(r);
      else leftOut.push({ file, why: r.kind === "template" ? "a blank template, not a record" : "it has no status and no decision, so it is not a record" });
    }
    // A folder must prove itself: a name people use for records needs one record, any other folder needs two.
    const sure = d.via === "named" || d.via.startsWith(".") || DIR_NAME.test(d.dir.split("/").pop());
    // In a folder not named for records, a file is a record only on its own words: a status, or a part that
    // says a decision was made. A dated incident report with "Recommendations" is neither, and nor is a
    // numbered chapter with "Background". Both were read as decisions in force before this (alphagov/gsp).
    if (!sure) {
      for (const r of records.filter((x) => !x.proven)) leftOut.push({ file: r.file, why: "it states no status and no decision, and its folder is not one named for records" });
      records.splice(0, records.length, ...records.filter((r) => r.proven));
    }
    // A file with a record's name and none of a record's parts counts only beside records that have them, and never to qualify a folder.
    const strong = records.filter((r) => !r.weak).length;
    if (strong < records.length - strong) {
      for (const r of records.filter((x) => x.weak)) leftOut.push({ file: r.file, why: "it has no status and no decision, so it is not a record" });
      records.splice(0, records.length, ...records.filter((r) => !r.weak));
    }
    for (const l of leftOut) if (/format Unl does not read/.test(l.why) && (sure || /^(?:adr|madr)?[-_ ]?\d{2,}/i.test(l.file.split("/").pop()))) unread.push(l.file);
    if (records.filter((r) => !r.weak).length >= (sure ? 1 : 2)) folders.push({ dir: d.dir, via: d.via, pkg: packageOf(d.dir), records, leftOut });
  }

  const records = [];
  for (const f of folders) {
    const gitDates = opts.git === false || f.records.every((r) => r.date) ? new Map() : gitFirstDates(abs, f.dir);
    for (const r of f.records) {
      r.folder = f.dir;
      r.pkg = f.pkg;
      if (!r.date && gitDates.has(posix(r.file))) { r.date = gitDates.get(posix(r.file)); r.dateSource = "git history"; }
      r.noReason = !r.why && !r.points.some((p) => p.type === "consequence" || p.type === "context");
      records.push(r);
    }
  }
  records.sort((a, b) => a.folder.localeCompare(b.folder) || (a.number == null) - (b.number == null) || (a.number || 0) - (b.number || 0) || String(a.date || "").localeCompare(String(b.date || "")) || a.file.localeCompare(b.file));
  for (const f of folders) f.records = records.filter((r) => r.folder === f.dir);

  linkRecords(records);
  const flags = findFlags(records, { root: abs, settled: opts.settled });
  return {
    root: abs,
    folders,
    records,
    flags,
    question: pickQuestion(flags),
    chains: allChains(records).length,
    unread,
    looked: KNOWN_DIRS.slice(0, 5),
    walkStopped,
  };
}

/** What `--json` prints: the proposals and everything said about them, with nothing that is only for display. */
function toJson(result) {
  return {
    folders: result.folders.map((f) => ({ dir: f.dir, found: f.via, package: f.pkg, records: f.records.length, left_out: f.leftOut })),
    proposals: toCandidates(result),
    flags: result.flags,
    question: result.question,
    not_read_yet: result.unread,
    search_stopped_early: result.walkStopped,
  };
}

const HELP = [
  "Read this repository's architecture decision records and show them back as decisions.",
  "",
  "Usage: npx unlimitless adr [path] [--dir <folder>] [--flags] [--all] [--json] [--no-git]",
  "",
  "  path          the repository to read (default: this folder)",
  "  --dir <f>     the record folder, when it is somewhere unusual",
  "  --flags       list everything worth checking, not only the one question",
  "  --all         list every record, however many there are",
  "  --json        print the proposals as JSON",
  "  --no-git      do not read dates from git history",
  "",
  "Nothing is kept until you say so.",
].join("\n");

/**
 * The command. Returns the exit code and never throws at the person.
 *
 * @param {string[]} argv  the arguments after `adr`
 * @param {{ out?: (s: string) => void, cwd?: string, columns?: number, paint?: object, settled?: string[] }} [io]
 *        `settled` lists the questions the person has already answered, so they are not shown again.
 */
function run(argv = [], io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + "\n"));
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v == null ? "" : v; };
  if (flag("--help") || flag("-h")) { out(HELP); return 0; }
  const json = flag("--json");
  const listFlags = flag("--flags");
  const all = flag("--all");
  const noGit = flag("--no-git");
  const dir = value("--dir");
  if (dir === "") { out("npx unlimitless adr: --dir needs a folder.\n\n" + HELP); return 2; }
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) { out(`npx unlimitless adr: there is no option "${unknown}".\n\n${HELP}`); return 2; }
  const root = path.resolve(io.cwd || process.cwd(), args[0] || ".");
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {}
  if (!isDir) { out(`npx unlimitless adr: ${args[0] || root} is not a folder.`); return 2; }
  if (dir) {
    let ok = false;
    try {
      ok = fs.statSync(path.resolve(root, dir)).isDirectory();
    } catch {}
    if (!ok) { out(`npx unlimitless adr: ${dir} is not a folder in ${root}.`); return 2; }
  }
  const result = readAdrs(root, { dir: dir || undefined, git: !noGit, settled: io.settled });
  if (json) { out(JSON.stringify(toJson(result), null, 2)); return 0; }
  out(renderShowBack(result, { width: io.columns || 100, limit: all ? 0 : 12, paint: io.paint }));
  if (listFlags) out("\n" + renderFlags(result));
  return 0;
}

module.exports = { readAdrs, toCandidates, keepable, toJson, run, renderShowBack, renderFlags, packageOf, HELP };

if (require.main === module) process.exit(run(process.argv.slice(2)));
