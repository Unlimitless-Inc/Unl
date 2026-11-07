"use strict";
/*
 * Where things live.
 *
 * THE RECORD lives once per repository, not once per working copy: inside the repository's own git
 * directory (.git/unl), which every worktree of that clone shares. So several agents working in
 * several worktrees of one repository work from the same decisions, and a decision kept in one is
 * handed to the others on their very next action. Nothing in .git is ever committed, so the database
 * never enters history. A folder that is not a git repository keeps its record in .unl/local.
 *
 * THE VIEW lives in the working tree and is meant to be committed: .unl/decisions/ (one readable file
 * per decision) and Unl's own section in AGENTS.md and CLAUDE.md. The view is written from the record
 * and never the other way round, with one exception: a decision file that arrives through git (a
 * teammate kept it) is read in, checked against its address, and added to the record.
 *
 * Everything here is plain filesystem reads. No git command is spawned, because the hook calls this
 * on every action and must add almost nothing to it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

/** The nearest ancestor of `dir` that holds a .git entry, or null. */
function findGitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (exists(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The nearest ancestor of `dir` that already holds a .unl folder (a project set up outside git), or null. */
function findUnlRoot(dir) {
  let d = path.resolve(dir);
  const home = path.resolve(os.homedir());
  for (;;) {
    // The home folder holds ~/.unl (this machine's runtime), which is not a project.
    if (d !== home && exists(path.join(d, ".unl", "local"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The git directory every worktree of this clone shares. `.git` is a folder in an ordinary clone and
 * a one-line file ("gitdir: <path>") in a linked worktree or a submodule; a linked worktree's git
 * directory names the shared one in its `commondir` file.
 */
function gitCommonDir(root) {
  const dotgit = path.join(root, ".git");
  let st;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return dotgit;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotgit) || "");
  if (!m) return null;
  const gitdir = path.resolve(root, m[1].trim());
  const common = readText(path.join(gitdir, "commondir"));
  return common ? path.resolve(gitdir, common.trim()) : gitdir;
}

/**
 * The project a path belongs to: { root, storeDir, git }. `root` is the working tree the view is
 * written into; `storeDir` is where the record is. Null when `dir` is in no project at all.
 */
function locate(dir) {
  const gitRoot = findGitRoot(dir);
  if (gitRoot) {
    const common = gitCommonDir(gitRoot);
    if (common) return { root: gitRoot, storeDir: path.join(common, "unl"), git: true };
  }
  const unlRoot = findUnlRoot(dir);
  if (unlRoot) return { root: unlRoot, storeDir: path.join(unlRoot, ".unl", "local"), git: false };
  return null;
}

/** The project for a folder Unl is being set up in now: the git root if there is one, else the folder itself. */
function locateForInit(dir) {
  const found = locate(dir);
  if (found) return found;
  const root = path.resolve(dir);
  return { root, storeDir: path.join(root, ".unl", "local"), git: false };
}

const store = (storeDir) => ({
  dir: storeDir,
  db: path.join(storeDir, "db"),
  index: path.join(storeDir, "serve.json"),
  journal: path.join(storeDir, "journal"),
  lock: path.join(storeDir, "lock"),
});

const view = (root) => ({
  dir: path.join(root, ".unl"),
  decisions: path.join(root, ".unl", "decisions"),
  agents: path.join(root, "AGENTS.md"),
  claude: path.join(root, "CLAUDE.md"),
});

/** This machine's copy of the runtime the hooks and the MCP server run from. Never a key, never an account. */
function runtimeHome(env = process.env) {
  return path.join(env.UNL_HOME && env.UNL_HOME.trim() ? env.UNL_HOME.trim() : path.join(os.homedir(), ".unl"), "open");
}

/** Is Unl set up for this project? True once the first index has been written. */
const isSetUp = (project) => !!project && exists(store(project.storeDir).index);

module.exports = { locate, locateForInit, store, view, runtimeHome, isSetUp, findGitRoot, gitCommonDir, exists, readText };
