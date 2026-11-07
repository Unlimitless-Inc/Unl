"use strict";
/*
 * Find the folders where a repository keeps its decision records.
 *
 * WHERE PEOPLE PUT THEM. adr-tools writes to doc/adr and records another place in a .adr-dir file.
 * MADR uses docs/decisions. log4brains uses docs/adr and names its folders in .log4brains.yml, one
 * per package in a monorepo. Everyone else picks a name close to those. So this looks in three
 * steps: the tool's own pointer file, then the well-known places, then a short walk for a folder
 * with one of the usual names or with files named like records.
 *
 * WHY A FOLDER MUST PROVE ITSELF. A folder called "decisions" can hold meeting notes. A folder is
 * taken only when files in it read as records, and the caller is told what was found and what was
 * left alone, so nothing is imported on the strength of a name.
 *
 * Reads the file system and nothing else. No network.
 */
const fs = require("fs");
const path = require("path");

/** Places a record folder usually lives, relative to the repository root. */
const KNOWN_DIRS = [
  "doc/adr", "docs/adr", "docs/adrs", "doc/adrs", "docs/decisions", "doc/decisions", "adr", "adrs", "decisions",
  "docs/architecture/decisions", "doc/architecture/decisions", "docs/architecture/adr", "docs/architecture/adrs",
  "architecture/decisions", "architecture/adr", "docs/architecture-decisions", "docs/architectural-decisions",
  "docs/arch", "docs/arch/adr", "docs/dev/adr", "docs/development/adr", "docs/design/adr", "docs/architecture",
  "documentation/adr", "documentation/decisions", ".adr", "docs/decision-records", "docs/adr/decisions",
];

/** Folder names that usually mean records, wherever they sit in the tree. */
const DIR_NAME = /^(?:adrs?|\.adr|decisions?|decision[-_ ]?records?|architecture[-_ ]?decisions?|architectural[-_ ]?decisions?|architecture[-_ ]?decision[-_ ]?records?)$/i;

/** File names that look like a record: a number or a date in front, or "adr" and a number. */
const RECORD_NAME = /^(?:(?:adr|madr)[-_ ]?\d{1,5}\b.*|\d{1,5}[-_. ].+|\d{8}[-_].+|\d{4}-\d{2}-\d{2}[-_].+)\.(?:md|markdown|mdx|rst)$/i;
const READABLE = /\.(?:md|markdown|mdx|rst)$/i;
/** Formats records are sometimes written in that this reader does not read. They are counted, never ignored. */
const UNREAD = /\.(?:adoc|asciidoc|org|textile|docx?|pdf)$/i;
/** Files that sit in a record folder and are not records. */
const NOT_A_RECORD = /^(?:readme|index|toc|summary|contents|overview|template|adr[-_ ]?template|_.*|changelog|contributing|license|backlog|agents|claude|gemini|copilot-instructions)\.(?:md|markdown|mdx|rst)$/i;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "vendor", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv", "env",
  "__pycache__", ".tox", "coverage", ".idea", ".vscode", "Pods", "bower_components", "third_party", "third-party", ".cache",
  "tmp", "temp", ".gradle", ".terraform", "site-packages", "_build", ".docusaurus", "public", "static", "assets", "logs",
]);

/**
 * Folders that hold a project other than this one: test fixtures and examples. A record folder inside one is
 * real in form and is not this repository's record, so the search does not go in (thomvaill/log4brains keeps
 * a whole fixture project, records and all, under its integration tests). Naming a folder outright with
 * --dir, or in a tool's own pointer file, still reads it wherever it sits.
 */
const NOT_THIS_PROJECT = /^(?:__)?(?:tests?|testing|testdata|fixtures?|mocks?|e2e|examples?|samples?|demos?)(?:__)?$|[-_.](?:tests?|fixtures?|examples?|samples?|e2e|testdata)$/i;

/** How deep the walk goes and how many folders it opens before it stops and says so. */
const WALK_DEPTH = 6;
const WALK_DIRS = 6000;
/** A record larger than this is not read. Real records are a few kilobytes; this bounds a mistaken file. */
const MAX_FILE_BYTES = 512_000;

const posix = (p) => p.split(path.sep).join("/");

function listDir(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The folders a tool's own pointer file names: adr-tools' .adr-dir and log4brains' .log4brains.yml. */
function pointerDirs(root) {
  const out = [];
  // A pointer file is a small file of the repository's own. One that is a link to somewhere else, a device
  // or a pipe is not read: a link to a pipe never returns, and a link out of the tree is not this project's word.
  const readOwn = (name) => {
    try {
      const st = fs.lstatSync(path.join(root, name));
      if (!st.isFile() || st.size > 65536) return null;
      return fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      return null;
    }
  };
  const adrDir = readOwn(".adr-dir");
  if (adrDir != null) {
    const dir = adrDir.split("\n")[0].trim();
    if (dir) out.push({ dir: posix(path.normalize(dir)), via: ".adr-dir" });
  }
  for (const name of [".log4brains.yml", ".log4brains.yaml"]) {
    const text = readOwn(name);
    if (text == null) continue;
    // Only the adrFolder lines are needed, and each carries its value on the same line.
    for (const m of text.matchAll(/^\s*adrFolder\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/gm)) {
      const dir = posix(path.normalize(m[1].trim())).replace(/^\.\//, "");
      if (dir) out.push({ dir, via: name });
    }
  }
  return out;
}

/** Folders worth opening, found by a bounded walk: a usual name, or two or more files named like records. */
function walkForDirs(root) {
  const found = [];
  let opened = 0;
  let stopped = false;
  const queue = [{ rel: "", depth: 0 }];
  while (queue.length) {
    const { rel, depth } = queue.shift();
    if (opened++ >= WALK_DIRS) { stopped = true; break; }
    const entries = listDir(path.join(root, rel));
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const named = files.filter((f) => RECORD_NAME.test(f)).length;
    const base = rel.split("/").pop() || "";
    if (rel && (DIR_NAME.test(base) || named >= 2)) found.push(rel);
    if (depth >= WALK_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name) || NOT_THIS_PROJECT.test(e.name) || (e.name.startsWith(".") && e.name !== ".adr")) continue;
      queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
    }
  }
  return { found, stopped };
}

/**
 * Every readable file under a record folder, a few levels down, with what was passed over and why.
 * A sub-folder that is a record folder in its own right is left to its own listing, so each file
 * is read once and belongs to the folder closest to it.
 */
function listRecordFiles(root, dir, others = new Set()) {
  const files = [];
  const leftOut = [];
  const visit = (rel, depth) => {
    for (const e of listDir(path.join(root, rel)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
      const child = rel && rel !== "." ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 3 && !others.has(child) && !SKIP_DIRS.has(e.name) && !NOT_THIS_PROJECT.test(e.name) && !/^(?:templates?|img|images|assets|diagrams|attachments|\..*)$/i.test(e.name)) visit(child, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!READABLE.test(e.name)) {
        if (UNREAD.test(e.name)) leftOut.push({ file: child, why: "a format Unl does not read yet" });
        continue;
      }
      if (NOT_A_RECORD.test(e.name)) { leftOut.push({ file: child, why: "an index or a template, not a record" }); continue; }
      let size = 0;
      try {
        size = fs.statSync(path.join(root, child)).size;
      } catch {
        continue;
      }
      if (size === 0) { leftOut.push({ file: child, why: "empty" }); continue; }
      if (size > MAX_FILE_BYTES) { leftOut.push({ file: child, why: "too large to be a record" }); continue; }
      files.push(child);
    }
  };
  visit(dir, 0);
  return { files, leftOut };
}

/**
 * The candidate record folders of a repository. A folder is only a candidate here: the caller
 * reads its files and keeps the folders that hold records.
 *
 * @param {string} root  the repository root
 * @param {{ dir?: string }} [opts]  `dir` names the folder outright and skips the search
 */
function findAdrDirs(root, opts = {}) {
  if (opts.dir) {
    const rel = posix(path.relative(root, path.resolve(root, opts.dir))) || ".";
    return { dirs: [{ dir: rel, via: "named" }], walkStopped: false };
  }
  const seen = new Map();
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {}
  const add = (dir, via) => {
    const rel = posix(path.normalize(dir)).replace(/\/+$/, "");
    if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel) || seen.has(rel)) return;
    let real;
    try {
      if (!fs.statSync(path.join(root, rel)).isDirectory()) return;
      // On a file system that ignores case, "adr" and "ADR" are one folder. Its real spelling is the one kept.
      real = posix(path.relative(realRoot, fs.realpathSync.native(path.join(root, rel))));
    } catch {
      return;
    }
    if (!real || real.startsWith("..") || seen.has(real)) return;
    seen.set(real, via);
  };
  for (const p of pointerDirs(root)) add(p.dir, p.via);
  for (const d of KNOWN_DIRS) add(d, "a usual place");
  const walk = walkForDirs(root);
  for (const d of walk.found) add(d, "found by name");
  const dirs = [...seen.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return { dirs: dirs.map((d) => ({ dir: d, via: seen.get(d) })), walkStopped: walk.stopped };
}

module.exports = { findAdrDirs, listRecordFiles, KNOWN_DIRS, DIR_NAME, RECORD_NAME, NOT_A_RECORD, NOT_THIS_PROJECT, MAX_FILE_BYTES };
