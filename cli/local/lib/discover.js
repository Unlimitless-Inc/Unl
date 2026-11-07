"use strict";
/*
 * Which files to read. Only the places people write rules for their agents and conventions for their
 * project. Never source code, tests or the build: an agent can read those itself, and a record of
 * decisions is not a copy of the repository.
 */
const fs = require("fs");
const path = require("path");

const ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md", "CONTRIBUTING.md", "README.md"];
const DIRS = [".cursor/rules", ".claude/rules"];
const MAX_FILES = 40;
const MAX_BYTES = 256000;

function discover(root) {
  const found = [];
  const add = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.isFile() && st.size > 0 && st.size <= MAX_BYTES) found.push(rel.split(path.sep).join("/"));
    } catch {}
  };
  for (const f of ROOT_FILES) add(f);
  for (const d of DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const e of entries.sort()) if (/\.(md|mdc|markdown|txt)$/i.test(e)) add(path.join(d, e));
  }
  return [...new Set(found)].slice(0, MAX_FILES);
}

module.exports = { discover, ROOT_FILES, DIRS };
