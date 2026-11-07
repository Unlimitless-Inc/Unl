"use strict";
/*
 * What git can and cannot say about when a line was written.
 *
 * A shallow copy holds the newest commits and nothing before them. `git clone --depth 1` makes one, and so
 * do most CI checkouts and many of the sandboxes agents work in. Git still answers "who wrote this line,
 * and when" in such a copy: it names the oldest commit the copy holds, because that is where its history
 * stops. The answer is the day the copy was cut, not the day the line was written, and it reads exactly
 * like a real one.
 *
 * A decision carries the day it was written and who wrote it, and a receipt shows that day to other
 * people. So a date or an author that comes from a commit at the edge of a shallow copy is not known,
 * and is left out rather than kept as a fact. Commits inside the copy's depth are real and are still read.
 *
 * Reads git and the file system. No network.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const edges = new Map();

/**
 * The commits where this copy's history stops. An empty set for a copy with its whole history, and for a
 * folder that is not in git. `null` when the copy is shallow and its edge cannot be read, which means no
 * commit in it can be trusted for a date.
 */
function historyEdge(root) {
  const key = path.resolve(root);
  if (edges.has(key)) return edges.get(key);
  let edge = new Set();
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
  try {
    const shallow = git("rev-parse", "--is-shallow-repository");
    if (shallow.status === 0 && String(shallow.stdout || "").trim() === "true") {
      edge = null;
      const where = git("rev-parse", "--git-path", "shallow");
      if (where.status === 0) {
        const text = fs.readFileSync(path.resolve(root, String(where.stdout || "").trim()), "utf8");
        edge = new Set(text.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)));
      }
    }
  } catch {
    // Shallow, and the edge could not be read: nothing is trusted. Not shallow: `edge` is still the empty set.
  }
  edges.set(key, edge);
  return edge;
}

/** True when a date or an author read from this commit cannot be trusted, because the copy's history stops there. */
function atEdge(root, sha) {
  const edge = historyEdge(root);
  return edge === null || edge.has(String(sha || ""));
}

module.exports = { historyEdge, atEdge };
