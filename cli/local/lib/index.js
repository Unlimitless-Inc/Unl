"use strict";
/*
 * The serving index: the record, compiled for the hooks.
 *
 * The hooks run before every action an agent takes, sometimes for several agents at once. They must add
 * almost nothing to an action and must never touch the database folder (see lock.js). So after every
 * change to the record, the current decisions are compiled into one small JSON file. The hooks read
 * that file and nothing else. It is a view of the record, like the rules files are: rebuilt from the
 * database, never edited, and replaced in one atomic rename so a reader never sees half of one.
 */
const fs = require("fs");
const path = require("path");
const { counts } = require("./text");
const { shortId } = require("./format");
const store = require("./store");
const { store: storePaths } = require("./paths");

const INDEX_VERSION = 1;

/** The words that tell one decision from the others, most telling first. */
function keyTerms(tf, df, n, k = 8) {
  return [...tf.entries()]
    .map(([w, c]) => [w, c * Math.log(1 + (n - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5))])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([w]) => w);
}

/** A name that points at a place in the code: a path with a folder or an extension, or an identifier. Not a tool's name. */
const CODE_NAME = /[/_]|::|\(\)|\.[a-z]{1,5}$|[a-z][A-Z]/;

/**
 * Is a decision about a particular thing, or does it apply to every change equally?
 *
 * "Handlers live in src/handlers/ and stay thin" is about a particular thing: it bears on work in that
 * folder and on little else. "Use pnpm, never npm" and "Write commit messages in the imperative" apply to
 * every change equally. The difference decides who carries the decision to the agent. A standing rule
 * belongs in the rules file, which the agent reads on every turn anyway, and handing it again on a turn is
 * noise (measured: a third of everything wrongly handed at the ask, on 20 real repositories). A particular
 * decision is the kind worth handing at the moment it bears.
 *
 * Decided from what the decision names, with no model: it is particular when it names a place in the
 * code (a path with a folder or an extension, a set of files it is scoped to, or an identifier). Naming a
 * tool does not make it particular.
 */
function kindOf(applies_to) {
  const a = applies_to || {};
  // A line about the project and not a rule (extract.js isLine). Only a judge hands one of these.
  if (a.describes) return "describes";
  if ((a.paths || []).some((p) => p.fromFile ? !/^\*\*?(\/\*)?$/.test(p.glob) : /\/|\.[a-z0-9]{1,5}$/i.test(String(p.glob).replace(/\/\*\*$/, "/")))) return "particular";
  if ((a.terms || []).some((t) => CODE_NAME.test(t.text))) return "particular";
  return "standing";
}

/** Compile rows from the record into the index object. Pure. */
function buildIndex({ decisions, proposals = [], flags = [], askedImport = false, judge = null }, { now = new Date() } = {}) {
  const current = decisions.filter((d) => d.status === "canonical");
  const docs = current.map((d) => counts(`${d.title} ${d.statement} ${d.why || ""}`));
  const df = new Map();
  for (const tf of docs) for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = current.length;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const entry = (d, i) => {
    const a = d.applies_to || {};
    const tf = docs[i];
    return {
      id: d.id, short: shortId(d.id), rid: d.ruling_id, title: d.title, statement: d.statement, why: d.why || null,
      kind: kindOf(a),
      kept: new Date(d.ratified_at).toISOString(), by: d.ratified_by, from: d.source && d.source.file ? d.source.file : null,
      // The day it was settled, where the record it came from says: a receipt shows this, not the day Unl first held it.
      // Where its record gives a month and no day, the month is what a receipt says ("Aug 2021").
      settled: d.settled_on ? new Date(d.settled_on).toISOString().slice(0, 10) : d.source && /^\d{4}-\d{2}$/.test(String(d.source.settled_on || "")) ? d.source.settled_on : null,
      // Where it was read from, to the line: a measurement of the serve needs to tie each decision back to its source.
      lines: d.source && d.source.line_start ? [d.source.line_start, d.source.line_end || d.source.line_start] : null,
      paths: (a.paths || []).map((p) => ({ glob: p.glob, avoid: !!p.avoid })),
      commands: (a.commands || []).map((c) => ({ text: c.text, avoid: !!c.avoid })),
      terms: (a.terms || []).map((t) => ({ text: t.text, avoid: !!t.avoid })),
      words: Object.fromEntries(tf), len: [...tf.values()].reduce((x, y) => x + y, 0), key: keyTerms(tf, df, n),
      replaces: (d.record.provenance.wasRevisionOfAll || []).map((rid) => { const old = decisions.find((x) => x.ruling_id === rid); return old ? { id: old.id, statement: old.statement } : { id: null, statement: rid }; }),
    };
  };
  const gone = {};
  for (const d of decisions.filter((x) => x.status === "superseded")) {
    const by = d.replaced_by ? byId.get(d.replaced_by) : null;
    gone[d.id] = { statement: d.statement, title: d.title, at: d.replaced_at ? new Date(d.replaced_at).toISOString() : null, by: by ? { id: by.id, title: by.title, statement: by.statement, why: by.why || null } : null, why: d.retired_why || null };
  }
  const entries = current.map(entry);
  return {
    version: INDEX_VERSION, built_at: now.toISOString(), count: n,
    avg_len: n ? entries.reduce((s, e) => s + e.len, 0) / n : 0,
    df: Object.fromEntries(df),
    decisions: entries,
    gone,
    // Pairs the person has not yet chosen between. Handing over one of a pair without the other would be taking a side.
    clashes: flags.filter((f) => f.status === "open" && f.kind === "contradiction" && (f.decision_ids || []).length === 2).map((f) => f.decision_ids),
    proposals: proposals.filter((p) => p.status === "open").map((p) => ({ id: p.id, short: shortId(p.id), content: p.content, why: p.why || null, by: p.proposed_by || null, at: new Date(p.created_at || now).toISOString(), replaces: p.replaces || [] })),
    flags: flags.filter((f) => f.status === "open").length,
    // Rules read from files that nobody has said yes to yet, and whether the person has been asked about them.
    waiting_import: proposals.filter((p) => p.status === "open" && p.proposed_by === "import").length,
    asked_import: !!askedImport,
    // Whether the person's own model is asked which decisions bear (judge.js). On unless they switched it off.
    judge: { mode: judge && judge.mode === "off" ? "off" : "on", model: (judge && judge.model) || null },
  };
}

/** The judge setting as the record holds it. Anything unreadable reads as the default: on, the agent's own model. */
async function judgeSetting(db) {
  try { const v = JSON.parse((await store.getMeta(db, "judge")) || "null"); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** Write the index in one atomic step. */
function writeIndex(storeDir, index) {
  const file = storePaths(storeDir).index;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, file);
  return file;
}

/** Read the index. Null when Unl is not set up here, or the file cannot be read (the hooks then stay silent). */
function readIndex(storeDir) {
  try {
    const index = JSON.parse(fs.readFileSync(storePaths(storeDir).index, "utf8"));
    return index && index.version === INDEX_VERSION ? index : null;
  } catch {
    return null;
  }
}

/** Rebuild the index from the open record. Call after every write, inside the same open. */
async function refreshIndex(db, storeDir) {
  const index = buildIndex({ decisions: await store.listDecisions(db), proposals: await store.listProposals(db, "open"), flags: await store.listFlags(db, "open"), askedImport: !!(await store.getMeta(db, "import_asked_at")), judge: await judgeSetting(db) });
  writeIndex(storeDir, index);
  return index;
}

module.exports = { buildIndex, writeIndex, readIndex, refreshIndex, judgeSetting, keyTerms, kindOf, INDEX_VERSION };
