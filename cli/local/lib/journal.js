"use strict";
/*
 * The journal: what happened in a session, written by the hooks.
 *
 * The hooks do not open the database (see lock.js), so they cannot write to it. They append one line
 * per event to a file of their own session, and the record takes those lines in later. Appending a
 * short line is safe for many processes at once, and one file per session means a hook only ever reads
 * its own session's handful of lines.
 *
 * What is written: which decisions Unl handed over, when it spoke first, which file or command the
 * agent was acting on, how long the judge took, and whether the person said yes to keeping something.
 * The person's own words are kept only where they are the evidence for a yes. The journal stays on
 * this machine.
 *
 * THE ASK OF THE TURN is held beside the journal, in a file of its own, and never enters the journal or
 * the record. The judge reads a file about to change against what was asked, and a hook that runs before
 * an edit is not told what the person asked, so the hook that saw the ask leaves it here for the ones
 * that follow. The next ask overwrites it and the end of the turn removes it.
 */
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { store: storePaths } = require("./paths");

const safe = (s) => String(s || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "unknown";
const fileFor = (storeDir, session) => path.join(storePaths(storeDir).journal, safe(session) + ".jsonl");

/** Append one event. Never throws: a hook that cannot write its journal still must not break the agent's turn. */
function append(storeDir, session, event) {
  try {
    const file = fileFor(storeDir, session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { id: randomBytes(9).toString("hex"), session: String(session || "unknown"), at: new Date().toISOString(), ...event };
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return row;
  } catch {
    return null;
  }
}

/** Every event of one session, in order. A torn last line is skipped, never fatal. */
function read(storeDir, session) {
  let text = "";
  try { text = fs.readFileSync(fileFor(storeDir, session), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** Every session's events, for the record to take in. */
function readAll(storeDir) {
  const dir = storePaths(storeDir).journal;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  return names.flatMap((n) => read(storeDir, n.replace(/\.jsonl$/, "")));
}

const askFile = (storeDir, session) => path.join(storePaths(storeDir).journal, safe(session) + ".ask");

/** Hold what the person just asked, for this turn only. Never throws. */
function setAsk(storeDir, session, text, max = 2400) {
  try {
    const file = askFile(storeDir, session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(text || "").slice(0, max), { mode: 0o600 });
  } catch {}
}
/** What was asked this turn, or "" when nothing is held. */
function getAsk(storeDir, session) {
  try { return fs.readFileSync(askFile(storeDir, session), "utf8"); } catch { return ""; }
}
/** The turn is over: the ask is not kept. */
function clearAsk(storeDir, session) {
  try { fs.unlinkSync(askFile(storeDir, session)); } catch {}
}

/** What the record needs from an event. The person's words are dropped unless they are the evidence for a yes. */
function forRecord(e) {
  const data = { ...(e.data || {}) };
  if (e.kind !== "said_yes") delete data.text;
  return { id: e.id, session: e.session, at: e.at, kind: e.kind, decision: e.decision || null, host: e.host || null, root: e.root || null, data };
}

/** Sessions with nothing new for a week are folded in already; their files are removed so the folder stays small. */
function prune(storeDir, { olderThanMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const dir = storePaths(storeDir).journal;
  let removed = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (now - fs.statSync(f).mtimeMs > olderThanMs) { fs.unlinkSync(f); removed++; }
    }
  } catch {}
  return removed;
}

module.exports = { append, read, readAll, forRecord, prune, fileFor, setAsk, getAsk, clearAsk };
