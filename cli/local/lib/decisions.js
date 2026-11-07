"use strict";
/*
 * Keeping, replacing and retiring decisions.
 *
 * ONLY A PERSON MAKES A DECISION. Everything in this file that writes a decision takes the person as
 * an argument and refuses without one. Agents and files reach the record as proposals (see
 * proposals in store.js); the functions here are what a person's yes calls.
 */
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");
const os = require("os");
const { writeDecision, proposalId } = require("./format");
const { slug, squash } = require("./text");
const store = require("./store");

/** Who is deciding, as this machine knows them: their git identity, else their login name. Never a model. */
function whoAmI(cwd = process.cwd()) {
  const git = (key) => {
    const r = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  };
  return git("user.email") || git("user.name") || (() => { try { return os.userInfo().username; } catch { return ""; } })() || "the person at this machine";
}

/**
 * A whole day that is on the calendar, as YYYY-MM-DD, or null. The record holds the day a decision was
 * settled in a date column, and a date column takes a whole day and nothing less. A record dated to the
 * month ("2021-08") is not padded to its first day to fit: the day stays empty and the month stays on the
 * decision as its record gave it (source.settled_on).
 */
function wholeDay(v) {
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(v == null ? "" : v));
  if (!m) return null;
  const real = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return real.getUTCMonth() === +m[2] - 1 && real.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The day a proposal read from a file was settled. `written` is the day its line was last written, from git.
 *
 * A decision record that states its own date is believed: that outranks the day its line was last written,
 * and it still does when the record gives only a month. The day is then left empty, never taken from the
 * line's history, because that would be a day the record did not give.
 *
 * A record with no date of its own is dated from git, and git gives two readings: the day the file first
 * appeared where it is, and the day its decision line was last written. A folder moved in one commit gives
 * every record in it the day of the move for the first, while the second follows the line back through the
 * move. A file cannot be younger than its own line, so the earlier of the two is the day kept.
 */
function settledDay(source, written) {
  const own = source && source.settled_on;
  if (!own) return written;
  if (source.date_from !== "git history") return wholeDay(own);
  const appeared = wholeDay(own);
  const line = wholeDay(written);
  return appeared && line ? (line < appeared ? line : appeared) : appeared || line;
}

/** Turn the fields of a decision into a row for the record, with its address computed. */
function buildDecision({ title, statement, why = null, scope = [], applies_to = {}, source = null, person, at = new Date(), proposerModel = null, proposedAt = null, derivedFrom = [], replaces = [], settled_on = null, generatedBy = null }) {
  if (!person || !String(person).trim()) throw new Error("a decision needs the person who made it");
  if (proposerModel && proposerModel === person) throw new Error("the model that proposed a decision cannot be the one that made it");
  const st = squash(statement);
  if (!st) throw new Error("a decision needs a statement");
  const ratifiedAt = (at instanceof Date ? at : new Date(at)).toISOString();
  const ruling_id = `${slug(title || st, 44)}-${createHash("sha256").update(st + "\n" + ratifiedAt).digest("hex").slice(0, 6)}`;
  const record = writeDecision({
    ruling: { id: ruling_id, title: squash(title || st).slice(0, 120), statement: st, authority_scope: scope },
    why: { overall_why: why ? squash(why) : null },
    provenance: {
      wasGeneratedBy: generatedBy, wasDerivedFrom: derivedFrom, ratifiedBy: String(person).trim(), ratifiedAt,
      proposerModel, proposedAt,
      wasRevisionOfAll: replaces.map((d) => d.ruling_id),
      ...(replaces.length === 1 ? { wasRevisionOf: replaces[0].ruling_id } : {}),
    },
  });
  return {
    id: record.id, ruling_id, title: record.ruling.title, statement: st, why: record.why.overall_why, scope,
    status: "canonical", ratified_by: record.provenance.ratifiedBy, ratified_at: ratifiedAt, settled_on: wholeDay(settled_on), record, applies_to, source,
  };
}

/** Where a rule read from a file came from, as one reference: file, lines and the content it was read at. */
const fileRef = (source) => (source && source.file ? `file:${source.file}#L${source.line_start}-L${source.line_end}` : null);

/**
 * Keep a decision on the person's yes. `replaces` are current decisions this one takes the place of:
 * they are marked replaced in the same transaction, so there is never a moment where both stand.
 */
async function keep(db, fields) {
  const olds = [];
  for (const ref of fields.replaces || []) {
    const { decision, matches } = await store.findDecision(db, typeof ref === "string" ? ref : ref.id);
    if (!decision) throw new Error(matches > 1 ? `"${ref}" matches more than one decision. Use more of its id.` : `No decision matches "${ref}".`);
    olds.push(decision);
  }
  const d = buildDecision({ ...fields, replaces: olds });
  let added = false;
  await db.tx(async (t) => {
    added = await store.insertDecision(t, d);
    for (const old of olds) await store.replaceDecision(t, old.id, d.id, { at: d.ratified_at, why: fields.replace_why || null });
  });
  return { decision: d, added, replaced: olds };
}

/** Retire a decision that no longer applies and has no successor. The row stays; it stops being handed out. */
async function retire(db, ref, { why = null } = {}) {
  const { decision, matches } = await store.findDecision(db, ref);
  if (!decision) throw new Error(matches > 1 ? `"${ref}" matches more than one decision. Use more of its id.` : `No decision matches "${ref}".`);
  const done = await store.replaceDecision(db, decision.id, null, { why });
  return { decision, done };
}

/** Record something as proposed, not decided. Returns the proposal row and whether it was new. */
async function propose(db, { title = null, content, why = null, scope = [], applies_to = {}, source = null, replaces = [], proposed_by = null }) {
  const c = squash(content);
  if (!c) throw new Error("a proposal needs its content");
  const p = { id: proposalId(c, why), title, content: c, why: why ? squash(why) : null, scope, applies_to, source, replaces, proposed_by };
  const added = await store.insertProposal(db, p);
  return { proposal: p, added };
}

/** The person says yes to a proposal: it becomes a decision made by them, and the proposal is closed pointing at it. */
async function keepProposal(db, proposal, { person, at = new Date(), why = undefined, settled_on = null }) {
  const out = await keep(db, {
    title: proposal.title || proposal.content, statement: proposal.content, why: why === undefined ? proposal.why : why,
    scope: proposal.scope || [], applies_to: proposal.applies_to || {}, source: proposal.source || null, person, at,
    // Read from the person's own file, or heard in the person's own words: nobody proposed it but them.
    proposerModel: proposal.proposed_by && !/^(import|person|noticed)$/.test(proposal.proposed_by) ? proposal.proposed_by : null,
    proposedAt: proposal.created_at ? new Date(proposal.created_at).toISOString() : null,
    derivedFrom: [fileRef(proposal.source)].filter(Boolean), generatedBy: proposal.id, replaces: proposal.replaces || [],
    settled_on: settledDay(proposal.source, settled_on),
  });
  await store.resolveProposal(db, proposal.id, "kept", out.decision.id);
  return out;
}

module.exports = { whoAmI, buildDecision, keep, retire, propose, keepProposal, fileRef, wholeDay, settledDay };
