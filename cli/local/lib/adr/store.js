"use strict";
/*
 * Put a repository's decision records into the record, with their history intact.
 *
 * WHAT GOES IN. Every record that can be kept becomes a proposal, exactly like a rule read from a
 * rules file, and waits for the person's yes. Once kept, each one is tied to what it took the place
 * of, so the record ends up holding the same history the folder does: what was decided first, what
 * replaced it, and what stands today. A record the folder says was replaced or retired is kept and
 * marked so, which puts it on the record and means it is never handed over as in force.
 *
 * WHAT STAYS OUT. A record that was only proposed, was rejected, has a status that cannot be read,
 * or is waiting on the person's answer is not put in at all. It is still in its folder, and the
 * next read picks it up once it can be kept.
 *
 * WHERE KEEPING HAPPENS. Not here. A record read from a folder is kept by the same yes, through
 * the same one place, as a rule read from a rules file. What this file adds is run after any keep:
 * it marks what replaced what, from the records' own words.
 */
const store = require("../store");
const decisions = require("../decisions");
const { sameKey, triggers } = require("../extract");
const { squash } = require("../text");
const { toCandidates, keepable } = require("./candidates");
const { findFlags } = require("./flags");

/** Where the answers a person has already given are kept, so a question is asked once. */
const SETTLED = "adr_settled";

async function settledAnswers(db) {
  try {
    const v = JSON.parse((await store.getMeta(db, SETTLED)) || "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}

/** The ids of the questions already answered, to hand to readAdrs so they are not raised again. */
async function settledIds(db) {
  return (await settledAnswers(db)).map((x) => x.id);
}

async function noteAnswer(db, flag, answer, at = new Date()) {
  const all = (await settledAnswers(db)).filter((x) => x.id !== flag.id);
  all.push({ id: flag.id, kind: flag.kind, files: flag.files, answer, at: (at instanceof Date ? at : new Date(at)).toISOString() });
  await store.setMeta(db, SETTLED, JSON.stringify(all));
}

/** What a proposal carries about the record it came from. `line_start` and `line_end` are where the decision is written. */
function sourceOf(c) {
  return {
    file: c.source.file, line_start: c.source.lines[0], line_end: c.source.lines[1], sha256: c.source.digest,
    kind: "adr", key: c.key, lifecycle: c.lifecycle, settled_on: c.settled.on, date_from: c.settled.source,
    decided_by: c.settled.by, replaces: c.replaces, status: c.source.status, why_lines: c.source.whyLines,
  };
}

/** What a record applies to: whatever its own words name, and the package its folder belongs to. */
function appliesTo(c) {
  const t = triggers(`${c.statement} ${c.why || ""}`.replace(/\n/g, " "));
  const pkg = (c.scope || []).find((s) => s.includes("/"));
  if (pkg && !t.paths.some((p) => p.glob === `${pkg}/**`)) t.paths.push({ glob: `${pkg}/**`, text: pkg, avoid: false, fromFile: true });
  return t;
}

/**
 * Propose every record that can be kept. Idempotent: a record already proposed or kept is not
 * proposed twice, and one in force whose words match a rule already in force is left to that rule.
 *
 * A RECORD IS TOLD APART BY THE FILE IT IS, NOT BY ITS WORDS. Two records can say the same sentence: a
 * folder that went from tabs to spaces and back holds "We will use tabs." twice, and two records can
 * both read 'Chosen option: "Option 1"'. Told apart by their words, the second was taken for the first
 * and never proposed, and in the first of those folders nothing ended in force. Two decisions cannot
 * hold one sentence, so a record whose words are already another's is kept with its own title in
 * front: "Go back to tabs. We will use tabs."
 *
 * @returns {{ found: number, added: number, waiting: object[], folders: object[] }}
 */
async function proposeAdrs(db, project, result) {
  void project;
  const candidates = toCandidates(result);
  // What the folder says now comes first: a record edited since it was kept or proposed is followed before
  // anything new is proposed, so a stale proposal never stands beside the one that replaces it.
  const followed = await followRecords(db, result, candidates);
  const mine = new Map();        // a record's key -> the words already proposed or kept for it
  const recordWords = new Map(); // words -> the key of the record that has them
  const ruleWords = new Set();   // words of a rule in force, or waiting, that came from no record
  const note = (source, words, live) => {
    if (source && source.kind === "adr" && source.key) {
      if (!mine.has(source.key)) mine.set(source.key, new Set());
      mine.get(source.key).add(words);
      if (!recordWords.has(words)) recordWords.set(words, source.key);
    } else if (live) ruleWords.add(words);
  };
  for (const d of await store.listDecisions(db)) note(d.source, sameKey(d.statement), d.status === "canonical");
  for (const p of await store.listProposals(db, "open")) note(p.source, sameKey(p.content), true);
  let found = 0;
  let added = 0;
  const waiting = [];
  for (const c of candidates) {
    if (!keepable(c)) { waiting.push(c); continue; }
    found++;
    const words = sameKey(c.statement);
    const named = `${c.title}. ${c.statement}`;
    const had = mine.get(c.key);
    if (had && (had.has(words) || had.has(sameKey(named)))) continue;
    if (c.lifecycle === "current" && ruleWords.has(words)) continue;
    const taken = ruleWords.has(words) || (recordWords.has(words) && recordWords.get(words) !== c.key);
    const content = taken ? named : c.statement;
    const { proposal, added: isNew } = await decisions.propose(db, { title: c.title, content, why: c.why, scope: c.scope, applies_to: appliesTo(c), source: sourceOf(c), proposed_by: "import" });
    note(sourceOf(c), sameKey(content), true);
    // The same words were proposed before and closed because the record moved away from them. The record has
    // come back to them, so the proposal is open again: a closed row must not keep its words out for good.
    if (isNew || (await store.reopenProposal(db, proposal.id, sourceOf(c), CLOSED_BY_RECORD))) added++;
  }
  for (const r of result.records) await store.markSource(db, r.file, r.digest);
  return { found, added, waiting, followed, folders: result.folders.map((f) => ({ dir: f.dir, records: f.records.length, left_out: f.leftOut.length })) };
}

/** What a proposal closed by its own record says, so only that closing is ever undone by the record. A person's no is never reopened. */
const CLOSED_BY_RECORD = "its record no longer says this";

/**
 * Follow a record that changed after it was kept or proposed. Run on every read, before anything is proposed.
 *
 * A KEPT RECORD SAYS WHAT ITS FILE SAYS NOW. What a kept decision knows of itself (where its record stands,
 * its status, what it takes the place of) is refreshed from the current read of its file, so a record kept as
 * Accepted and later marked Deprecated, Rejected or Superseded is followed by settleChains, which takes it out
 * of force. The decision itself is never rewritten: its words, its reason and its address stay as the person
 * kept them. A record whose sentence was edited is proposed again in its new words, and when the person keeps
 * that, it takes the place of the old wording (settleChains). Until then, what they kept stands.
 *
 * A WAITING PROPOSAL IS CLOSED WHEN ITS RECORD NO LONGER SUPPORTS IT: the record now reads as rejected,
 * proposed or unreadable, or its words or reason were edited. The current read is proposed in its place.
 *
 * AN ANSWER HOLDS ONLY WHILE ITS QUESTION IS RAISED. "Yes, it is still in force", given while a successor was
 * only proposed, answered that situation. Once the folder no longer raises the question (the successor was
 * accepted, or the record was edited to say what stands), the answer is dropped and the records' own words
 * govern again. If the question comes back it is asked again, because it is a new situation.
 */
async function followRecords(db, result, candidates) {
  const out = { refreshed: 0, closed: 0, answers_dropped: 0 };
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const files = new Set(result.records.map((r) => r.file));
  // Every question the folder raises now, answered or not, so an answer can be held to its question.
  const raised = new Set(findFlags(result.records, { root: result.root }).map((f) => f.id));
  const answers = await settledAnswers(db);
  const gone = new Set(answers.filter((a) => Array.isArray(a.files) && a.files.length && a.files.every((f) => files.has(f)) && !raised.has(a.id)).map((a) => a.id));
  if (gone.size) {
    await store.setMeta(db, SETTLED, JSON.stringify(answers.filter((a) => !gone.has(a.id))));
    out.answers_dropped = gone.size;
  }
  const wordsOf = (c) => [sameKey(c.statement), sameKey(`${c.title}. ${c.statement}`)];

  for (const d of await store.listDecisions(db, { status: "canonical" })) {
    if (!isAdr(d)) continue;
    const c = byKey.get(d.source.key);
    if (!c) continue;
    const next = { ...d.source };
    if (next.answered && gone.has(next.answered)) delete next.answered;
    // A record answered for is left exactly as the person said, for as long as their answer holds.
    if (!next.answered) Object.assign(next, { lifecycle: c.lifecycle, status: c.source.status, replaces: c.replaces });
    if (wordsOf(c).includes(sameKey(d.statement))) Object.assign(next, { sha256: c.source.digest, line_start: c.source.lines[0], line_end: c.source.lines[1], why_lines: c.source.whyLines });
    if (JSON.stringify(next) === JSON.stringify(d.source)) continue;
    await store.setDecisionSource(db, d.id, next);
    out.refreshed++;
  }

  for (const p of await store.listProposals(db, "open")) {
    if (!isAdr(p)) continue;
    const c = byKey.get(p.source.key);
    if (!c || p.source.sha256 === c.source.digest) continue;
    const same = keepable(c) && wordsOf(c).includes(sameKey(p.content)) && (c.why ? squash(c.why) : null) === (p.why || null);
    if (same) await store.setProposalSource(db, p.id, { ...p.source, ...sourceOf(c) });
    else if (await store.closeProposal(db, p.id, CLOSED_BY_RECORD)) out.closed++;
  }
  return out;
}

const isAdr = (p) => !!(p && p.source && p.source.kind === "adr");

/**
 * When a kept record took the place of another. Where the newer record carries the day its own folder
 * gives, that is the day the older one stopped being in force. The day of the import is not: a record
 * replaced in 2019 would otherwise read "replaced" on the day it was read, in the rules file and in
 * what an agent is told. With no such day, it is the moment the newer one was kept.
 */
const tookPlaceAt = (d) => {
  const day = decisions.wholeDay(d.settled_on);
  return day ? `${day}T00:00:00.000Z` : d.ratified_at;
};

/**
 * Make the kept decision records agree with the history their folder gives. Run after every keep,
 * whichever way the yes was given, so the order things were kept in never matters.
 *
 * A kept record takes the place of the kept records it names. A record its own folder calls
 * replaced or retired, with no successor kept and none still waiting, stops being in force. A
 * record the person was asked about and answered for is left exactly as they said.
 *
 * Idempotent: run twice, the second run changes nothing.
 */
async function settleChains(db) {
  const adrs = (await store.listDecisions(db)).filter(isAdr);
  const out = { replaced: 0, retired: 0 };
  if (!adrs.length) return out;
  const byKey = new Map();
  for (const d of adrs) {
    if (!byKey.has(d.source.key)) byKey.set(d.source.key, []);
    byKey.get(d.source.key).push(d);
  }
  // One record is one decision in force. When its sentence was edited and the person kept the new wording,
  // the wording kept last takes the place of the one before it, on the day the new wording was kept.
  for (const group of byKey.values()) {
    const live = group.filter((d) => d.status === "canonical");
    if (live.length < 2) continue;
    const when = (d) => `${new Date(d.ratified_at).toISOString()}|${new Date(d.created_at || d.ratified_at).toISOString()}`;
    const newest = live.reduce((a, b) => (when(b) > when(a) ? b : a));
    for (const old of live) {
      if (old === newest) continue;
      if (await store.replaceDecision(db, old.id, newest.id, { at: newest.ratified_at, why: "its own record was rewritten, and this is what it says now" })) { old.status = "superseded"; out.replaced++; }
    }
  }
  for (const d of adrs) {
    for (const k of d.source.replaces || []) {
      for (const old of byKey.get(k) || []) {
        if (old.id === d.id || old.status !== "canonical" || old.source.answered) continue;
        // Only the newer record says it replaced this one, and this one still reads as in force. A first read
        // holds such a record back and asks; a later read asks the same question rather than settling it here.
        if (old.source.lifecycle === "to_settle") continue;
        // Which end said so is kept: a record that never said it was replaced is not made to have said it.
        const why = old.source.lifecycle === "replaced" ? "its own record says it was replaced" : `the record that replaced it says so ("${String(d.title).slice(0, 80)}")`;
        if (await store.replaceDecision(db, old.id, d.id, { at: tookPlaceAt(d), why })) { old.status = "superseded"; out.replaced++; }
      }
    }
  }
  const waiting = (await store.listProposals(db, "open")).filter(isAdr);
  for (const d of adrs) {
    if (d.status !== "canonical" || d.source.answered) continue;
    const life = d.source.lifecycle;
    // A record taken back to proposed, or to a status Unl cannot read, is left as the person kept it: their
    // yes stands until their record says it no longer applies. Rejected says that.
    if (life !== "retired" && life !== "replaced" && life !== "ruled_out") continue;
    // Its successor has been read and is waiting for the person's yes: it is replaced when that is kept.
    if (life !== "ruled_out" && waiting.some((p) => (p.source.replaces || []).includes(d.source.key))) continue;
    const quoted = d.source.status ? ` ("${String(d.source.status).slice(0, 80)}")` : "";
    const why = life === "retired"
      ? `its own record says it no longer applies${quoted}`
      : life === "ruled_out"
        ? `its own record now says it was rejected${quoted}`
        : "its own record says it was replaced, and names nothing Unl could find in its place";
    await decisions.retire(db, d.id, { why });
    d.status = "superseded";
    out.retired++;
  }
  return out;
}

/**
 * The choices a question offers, where the answer is one of a few. A question that needs words
 * ("What replaced it?") has none: it is shown, and the person answers it with `unl replace` or by
 * editing the record.
 */
function choicesFor(flag) {
  switch (flag.kind) {
    case "reads_in_force_but_replaced": return ["the newer one stands and the older is replaced", "both stand"];
    case "each_replaced_the_other": return ["the first stands", "the second stands", "neither stands"];
    case "replaced_by_unsettled": return ["yes, it is still in force", "no, it is not"];
    case "same_role_two_choices": return ["both stand", "only the first stands", "only the second stands"];
    case "path_gone": return ["yes, it is still in force", "no, it no longer applies"];
    default: return null;
  }
}

/**
 * Apply the person's answer to the one question. `choice` counts from 1. Returns what was done, in
 * words, or null when the answer was not one of the choices and nothing was changed.
 */
async function answer(db, project, result, flag, choice, { person, at = new Date() } = {}) {
  void project;
  if (!person || !String(person).trim()) throw new Error("an answer needs the person who gave it");
  const choices = choicesFor(flag);
  const n = Number(choice);
  if (!choices || !Number.isInteger(n) || n < 1 || n > choices.length) return null;
  const cands = new Map(toCandidates(result).map((c) => [c.source.file, c]));
  const [first, second] = flag.files.map((f) => cands.get(f));
  if (!first) return null;
  /** The decision a record became, preferring the one in force when it was kept more than once. */
  const decisionOf = async (c) => {
    if (!c) return null;
    const mine = (await store.listDecisions(db)).filter((d) => d.source && d.source.kind === "adr" && d.source.key === c.key);
    return mine.find((d) => d.status === "canonical") || mine[mine.length - 1] || null;
  };
  /** Keep a record as in force, on the person's word. Used for one that was held back, or one the folder had retired. */
  const keepNow = async (c) => {
    const made = await decisions.propose(db, { title: c.title, content: c.statement, why: c.why, scope: c.scope, applies_to: appliesTo(c), source: { ...sourceOf(c), lifecycle: "current", answered: flag.id, yes: "at a terminal" }, proposed_by: "import" });
    return (await decisions.keepProposal(db, made.proposal, { person, at, settled_on: c.settled.on || null })).decision;
  };
  const inForce = async (c) => {
    const d = await decisionOf(c);
    return d && d.status === "canonical" ? d : keepNow(c);
  };
  let did = null;
  if (flag.kind === "reads_in_force_but_replaced" && second) {
    // The files are the older record, then the newer one that says it replaced it.
    if (n === 1) {
      // The newer stands. It is kept on the person's word if it was not kept already, and the older is kept
      // as replaced by it. The first version kept the older as in force before it looked for the newer, so
      // where the newer had not been kept the answer came out as "Both stand", the opposite of what was said.
      const newer = await inForce(second);
      const older = (await decisionOf(first)) || (await keepNow(first));
      if (older.status === "canonical") await store.replaceDecision(db, older.id, newer.id, { why: "the person said the newer record stands" });
      did = `"${second.title}" stands, and "${first.title}" is kept as replaced by it.`;
    } else {
      await inForce(first);
      did = `Both stand. "${first.title}" is kept as in force.`;
    }
  } else if (flag.kind === "replaced_by_unsettled" || flag.kind === "path_gone") {
    if (n === 1) {
      await inForce(first);
      did = `"${first.title}" is kept as in force.`;
    } else {
      const d = await decisionOf(first);
      if (d && d.status === "canonical") await decisions.retire(db, d.id, { why: "the person said it no longer applies" });
      did = `"${first.title}" is not in force.`;
    }
  } else if (flag.kind === "each_replaced_the_other" && second) {
    if (n === 3) did = "Neither stands.";
    else {
      const c = n === 1 ? first : second;
      await inForce(c);
      did = `"${c.title}" stands.`;
    }
  } else if (flag.kind === "same_role_two_choices" && second) {
    if (n === 1) did = "Both stand.";
    else {
      const [win, lose] = n === 2 ? [first, second] : [second, first];
      const w = await inForce(win);
      const l = await decisionOf(lose);
      if (l && l.status === "canonical") await store.replaceDecision(db, l.id, w.id, { why: "the person chose between two records" });
      did = `"${win.title}" stands, and "${lose.title}" is kept as replaced by it.`;
    }
  }
  if (did) await noteAnswer(db, flag, choices[n - 1], at);
  return did;
}

module.exports = { proposeAdrs, settleChains, answer, choicesFor, settledIds, settledAnswers, noteAnswer, isAdr, sourceOf };
