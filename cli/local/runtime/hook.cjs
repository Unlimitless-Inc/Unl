#!/usr/bin/env node
"use strict";
/*
 * Unl's hook: the part that runs inside the agent's own loop.
 *
 *   node hook.cjs <host>      host is claude, codex or cursor; the event arrives as JSON on stdin
 *
 * It does four things, and for most actions it does none of them and prints nothing:
 *
 *   when the person asks for something   hand the agent the kept decisions that bear on it
 *   when the agent is about to act       hand over a decision about that file or command; and if the
 *                                        action is the very thing a decision says not to do, speak
 *                                        first, once, before it happens
 *   when the person states a rule        notice it, and ask once whether to keep it
 *   when the turn ends                   leave one line saying what Unl handed over
 *
 * It reads the compiled index and its own session's journal. It opens the database only on the two
 * rare moments something is written: a rule was just noticed, or the person just said yes or no.
 *
 * WHAT BEARS IS CHOSEN BY THE PERSON'S OWN MODEL (lib/choose.js, lib/judge.js). At the ask, and the
 * first time a file is about to change in a turn, the wide net of candidates is put to the agent's own
 * command for one short turn, and what it picks is handed over: in full where it bears, as one line
 * where it might. Speaking first is never the judge's: a crossing is decided here, with no model, at
 * once. When the judge cannot answer in time, Unl hands what the work plainly names in full and the
 * nearest others as one line each, never the whole record, and says once that the judge could not be
 * asked. When the person has switched the judge off, Unl hands what the words of the ask and the place
 * of the file find.
 *
 * It never decides whether an action may happen. When it speaks first it stops ONE call so the decision
 * reaches the agent before the action instead of after, says so, and lets the same call through the
 * second time. Permission stays with the tool the agent runs in.
 *
 * It fails quiet: any fault here ends with no output and exit 0, because a broken helper must never
 * break the person's work.
 */
const path = require("path");
const { createHash } = require("crypto");
const LIB = path.join(__dirname, "..", "lib");
const paths = require(path.join(LIB, "paths"));
const { readIndex } = require(path.join(LIB, "index"));
const serve = require(path.join(LIB, "serve"));
const journal = require(path.join(LIB, "journal"));
const capture = require(path.join(LIB, "capture"));
const receipt = require(path.join(LIB, "receipt"));
const { choose } = require(path.join(LIB, "choose"));
const { day } = require(path.join(LIB, "view"));

const MAX_CONTEXT = 6000;

/**
 * The opt-in ping. It does nothing at all unless the person has turned it on. When it is on it writes
 * one line to a file here and hands the sending to a separate process, so this hook never touches a
 * network and never waits for one. A fault in it is swallowed like any other fault here.
 */
function ping(event, count) {
  try {
    const t = require(path.join(LIB, "telemetry"));
    const unlVersion = require(path.join(__dirname, "..", "package.json")).version;
    const noted = event === "later_day" ? t.noteSession({ unlVersion }) : t.record(event, { count, unlVersion });
    if (noted) t.flushDetached();
  } catch {}
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const ends = (s) => (/[.!?]$/.test(s) ? s : s + ".");

// ── what each host sends, as one shape ──────────────────────────────────────────────────────────

/** The files a Codex patch touches and the lines it adds. Codex sends one patch as text, with no path field. */
function readPatch(text) {
  const files = [], added = [];
  for (const line of String(text || "").split("\n")) {
    const f = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
    if (f) files.push(f[1].trim());
    else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  return { files, added: added.join("\n") };
}

/**
 * Turn a host's hook payload into { type, session, cwd, ... } or null when it is an event Unl has no
 * part in. The host is read from the payload where the payload says (Cursor names itself), because
 * Cursor also runs hooks that were wired for Claude Code and calls them with its own shapes.
 */
function normalise(host, p) {
  if (!p || typeof p !== "object") return null;
  if (p.cursor_version) host = "cursor";
  const session = p.session_id || p.conversation_id || p.thread_id || "session";
  const cwd = p.cwd || (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || process.cwd();
  const name = String(p.hook_event_name || p.hookEventName || p.event || "");
  const base = { host, session, cwd, name };
  if (/^(UserPromptSubmit|beforeSubmitPrompt)$/.test(name)) return { ...base, type: "prompt", prompt: String(p.prompt || "") };
  if (/^(PreToolUse|preToolUse)$/.test(name)) {
    const tool = String(p.tool_name || "");
    let i = p.tool_input || {};
    if (typeof i === "string") { try { i = JSON.parse(i); } catch { i = {}; } }
    if (/^apply_patch$/i.test(tool)) {
      const patch = readPatch(i.command || i.patch || i.input);
      return patch.files.length ? { ...base, type: "before", tool, files: patch.files, file: patch.files[0], content: patch.added } : null;
    }
    if (/^(Bash|Shell|shell|local_shell|exec_command)$/.test(tool)) return { ...base, type: "before", tool, command: String(Array.isArray(i.command) ? i.command.join(" ") : i.command || i.cmd || "") };
    if (/^(Edit|Write|MultiEdit|NotebookEdit|StrReplace|str_replace_editor)$/.test(tool)) {
      const file = i.file_path || i.notebook_path || i.path || "";
      const content = [i.new_string, i.content, i.new_source, ...(Array.isArray(i.edits) ? i.edits.map((e) => e && e.new_string) : [])].filter((x) => typeof x === "string").join("\n");
      return { ...base, type: "before", tool, file: String(file), content };
    }
    return null;
  }
  if (name === "beforeShellExecution") return { ...base, type: "before", tool: "Shell", command: String(p.command || "") };
  if (/^(Stop|stop)$/.test(name)) return p.stop_hook_active ? null : { ...base, type: "stop" };
  if (name === "SessionStart") return { ...base, type: "start", source: String(p.source || "") };
  return null;
}

// ── the text Unl hands over ─────────────────────────────────────────────────────────────────────

/**
 * One decision as it is handed over: the words, the reason, when it was kept and by whom. It names who
 * decided because a decision can arrive through git from a teammate, and saying "you decided this" of
 * something a colleague decided would be untrue.
 */
const one = (e) => `"${ends(e.statement)}" The reason: ${e.why ? ends(e.why) : "none was given."} (kept ${day(e.kept)} by ${e.by})`;

/**
 * One decision as one line: what the judge was less sure of, or a sure match it did not pick. The words
 * and the reason are the record's own, cut to a length, and its id is the one step to the whole of it.
 */
const line = (e) => `- "${clip(ends(e.statement), 220)}" ${e.why ? `Why: ${clip(ends(e.why), 180)}` : "No reason was given."} (${e.short || String(e.id).slice(-8)})`;
const HELD_TAIL = "Each is one line. The unl tool `why`, or `npx unlimitless why <id>`, gives one in full, with who decided it and when.";

function handedText(hits, held = []) {
  const out = [];
  if (hits.length) {
    out.push(hits.length === 1
      ? "Unl, for this turn. This decision is kept for this project, and it bears on what was just asked."
      : "Unl, for this turn. These decisions are kept for this project, and they bear on what was just asked.");
    out.push(...hits.map((h, i) => `${hits.length > 1 ? `${i + 1}. ` : ""}${one(h.entry)}`));
  }
  if (held.length) {
    out.push(`${hits.length ? "Unl is less sure these bear." : `Unl, for this turn. ${held.length === 1 ? "This is" : "These are"} kept for this project and may bear on what was just asked.`} ${HELD_TAIL}`);
    out.push(...held.map((h) => line(h.entry)));
  }
  return out.join("\n");
}

function bearsText(hits, target, held = []) {
  const out = [];
  if (hits.length) out.push(`Unl. ${hits.length === 1 ? "A decision is" : "Decisions are"} kept for this project about ${target}.`, ...hits.map((h) => one(h.entry)));
  if (held.length) {
    out.push(`${hits.length ? "Unl is less sure these bear on it." : `Unl. ${held.length === 1 ? "This is" : "These are"} kept for this project and may bear on ${target}.`} ${HELD_TAIL}`);
    out.push(...held.map((h) => line(h.entry)));
  }
  return out.join("\n");
}

function crossingText(hit, target) {
  return [
    `Unl is speaking before this happens. This was decided for this project on ${day(hit.entry.kept)} by ${hit.entry.by}:`,
    `"${ends(hit.entry.statement)}"`,
    `The reason: ${hit.entry.why ? ends(hit.entry.why) : "none was given."}`,
    `${target} is what that decision is about.`,
    "Unl stopped this one call so the decision reaches you before the action and not after. It has not forbidden anything: the same call made again goes through, and the receipt for this session will say that it did.",
  ].join("\n");
}

function changedText(gone, touched) {
  const lines = [`Unl. A decision you were given earlier in this session has changed. "${ends(gone.statement)}"`];
  if (gone.by) lines.push(`It was replaced on ${day(gone.at)} by: "${ends(gone.by.statement)}" The reason: ${gone.by.why ? ends(gone.by.why) : "none was given."}`);
  else lines.push(`It no longer applies since ${day(gone.at)}${gone.why ? `. ${ends(gone.why)}` : "."}`);
  if (touched.length) lines.push(`Since it was handed to you, this session has worked on: ${touched.slice(0, 8).join(", ")}.`);
  return lines.join("\n");
}

/**
 * Where a decision being handed over is one of a pair the person has not chosen between, the other
 * comes with it and the pair is named. Unl does not pick which of two decisions stands.
 */
function withClashes(index, hits) {
  const have = new Set(hits.map((h) => h.entry.id));
  const notes = [];
  const extra = [];
  for (const [a, b] of index.clashes || []) {
    const inA = have.has(a), inB = have.has(b);
    if (!inA && !inB) continue;
    const ea = index.decisions.find((d) => d.id === a), eb = index.decisions.find((d) => d.id === b);
    if (!ea || !eb) continue;
    if (!inA) { extra.push({ entry: ea, kind: "pair", matched: [] }); have.add(a); }
    if (!inB) { extra.push({ entry: eb, kind: "pair", matched: [] }); have.add(b); }
    notes.push(`"${ea.title}" and "${eb.title}" cannot both hold, and the person has not yet said which stands. Ask them before relying on either.`);
  }
  return { hits: [...hits, ...extra], notes };
}

// ── the events ──────────────────────────────────────────────────────────────────────────────────

function sessionState(events) {
  const seen = new Set();
  for (const e of events) if ((e.kind === "handed" || e.kind === "spoke_first") && e.decision) seen.add(e.decision);
  const lastPrompt = [...events].reverse().find((e) => e.kind === "prompt") || null;
  const turn = lastPrompt ? events.slice(events.lastIndexOf(lastPrompt)) : events;
  return { seen, lastPrompt, turn };
}

/** Decisions this session was handed that have since been replaced or retired, not yet told. */
function changedNotices(ctx) {
  const told = new Set(ctx.events.filter((e) => e.kind === "changed_notice").map((e) => e.decision));
  const out = [];
  for (const id of ctx.state.seen) {
    const gone = ctx.index.gone[id];
    if (!gone || told.has(id)) continue;
    const first = ctx.events.find((e) => (e.kind === "handed" || e.kind === "spoke_first") && e.decision === id);
    const touched = [...new Set(ctx.events.filter((e) => e.kind === "acting" && e.at >= first.at && e.data && e.data.target).map((e) => e.data.target))];
    out.push({ id, text: changedText(gone, touched) });
  }
  return out;
}

const judgeFault = (e) => e.kind === "fault" && e.data && e.data.where === "judge";

/**
 * May the judge be asked now? A judge that is down (its command missing, or an answer that is not one)
 * costs one wait in a turn and not one before every file. A slow answer is not a judge that is down: after
 * one call runs out of time the turn tries once more, and after a second it goes by the net for the rest
 * of the turn. Three faults in a
 * row and it is not asked again this session. Each new ask tries once more, because a slow start is not a
 * broken judge.
 */
function judgeMayRun(ctx, { newTurn = false } = {}) {
  const inTurn = ctx.state.turn.filter(judgeFault);
  if (!newTurn && (inTurn.length >= 2 || inTurn.some((e) => e.data.reason !== "timeout"))) return false;
  const last = ctx.events.filter((e) => (e.kind === "judged" && e.data && e.data.ms) || judgeFault(e)).slice(-3);
  return !(last.length === 3 && last.every(judgeFault));
}

/**
 * Write down what the judge did for this call: how long it took and what it read, why it could not
 * answer, or that it was not asked because it had already failed (`after_fault`). A reading of the serve
 * needs all three: a turn the judge sat out must never read as one it chose.
 */
function noteJudge(ctx, picked, on, target = null) {
  const { ev, project } = ctx;
  const note = (kind, data) => journal.append(project.storeDir, ev.session, { kind, host: ev.host, root: project.root, data });
  ctx.path = picked.off ? "off" : picked.path;
  if (picked.fault) note("fault", { where: "judge", reason: picked.fault.reason, message: clip(picked.fault.detail, 200), ms: picked.fault.ms, on, target });
  else if (picked.call) { ctx.judged = picked.call; note("judged", { on, target, ...picked.call, hand: picked.full.length, hold: picked.held.length }); }
  else if (picked.path === "net") note("judged", { on, target, after_fault: true });
  else if (picked.path === "judge" && target) note("judged", { on, target, candidates: 0 });
}

/** The record is opened only here: when something is to be written. Returns null on any fault. */
async function withRecord(ctx, fn) {
  try {
    const store = require(path.join(LIB, "store"));
    return await store.withStore(ctx.project.storeDir, fn);
  } catch (e) {
    journal.append(ctx.project.storeDir, ctx.ev.session, { kind: "fault", host: ctx.ev.host, data: { where: "record", message: clip(e && e.message ? e.message : e, 200) } });
    return null;
  }
}

async function onPrompt(ctx) {
  const { ev, index, events, state, project } = ctx;
  const context = [];
  const user = [];
  const note = (kind, extra = {}) => journal.append(project.storeDir, ev.session, { kind, host: ev.host, root: project.root, ...extra });
  const prompt = ev.prompt;
  let consumed = false;
  // The turn starts here: everything Unl does for this prompt is journalled after this line, so the
  // receipt at the end of the turn counts it.
  note("prompt", { data: { words: prompt.split(/\s+/).filter(Boolean).length } });
  ping("later_day");

  // 1. An answer to "keep this?" from the turn before.
  const offered = [...state.turn].reverse().find((e) => e.kind === "offer");
  const agentProposal = !offered && state.lastPrompt ? [...index.proposals].reverse().find((p) => p.by && !/^(import|noticed)$/.test(p.by) && p.at > state.lastPrompt.at) : null;
  const pending = offered ? { id: offered.data.proposal || "import", content: offered.data.content, batch: offered.data.batch === "import" } : agentProposal ? { id: agentProposal.id, content: agentProposal.content } : null;
  const settledAlready = pending && events.some((e) => (e.kind === "said_yes" || e.kind === "said_no") && e.data && e.data.proposal === pending.id);
  if (pending && pending.batch && !settledAlready) {
    // The rules read from files when nobody was at a terminal: the person is answering about all of them.
    const a = capture.answer(prompt);
    if (a && a.answer === "yes") {
      consumed = true;
      const keptAll = await withRecord(ctx, async (db) => {
        const store = require(path.join(LIB, "store"));
        const decisions = require(path.join(LIB, "decisions"));
        const ops = require(path.join(LIB, "ops"));
        const { blameLines } = require(path.join(LIB, "init"));
        const person = decisions.whoAmI(project.root);
        const at = new Date();
        const blame = new Map();
        const out = [];
        for (const p of (await store.listProposals(db, "open")).filter((x) => x.proposed_by === "import")) {
          const f = p.source && p.source.file;
          if (f && !blame.has(f)) blame.set(f, blameLines(project.root, f));
          const wrote = f ? blame.get(f).get(p.source.line_start) || null : null;
          out.push((await decisions.keepProposal(db, { ...p, source: { ...(p.source || {}), ...(wrote ? { written: wrote.date, author: wrote.author } : {}), yes: "in a session" } }, { person, at, settled_on: wrote ? wrote.date : null })).decision);
        }
        await ops.settle(db, project);
        return out;
      });
      if (keptAll && keptAll.length) {
        ping("decision_kept", keptAll.length);
        note("said_yes", { data: { proposal: "import", text: clip(prompt, 600) } });
        for (const d of keptAll) note("kept", { decision: d.id });
        user.push(`Unl kept ${keptAll.length} ${keptAll.length === 1 ? "decision" : "decisions"} from your rules files.`);
        context.push(`Unl. The person said yes, so the ${keptAll.length} ${keptAll.length === 1 ? "rule" : "rules"} read from their rules files ${keptAll.length === 1 ? "is" : "are"} now kept as decisions for this project.`);
      }
    } else if (a && a.answer === "no") {
      consumed = true;
      note("said_no", { data: { proposal: "import" } });
    }
  } else if (pending && !settledAlready) {
    const a = capture.answer(prompt);
    if (a && a.answer === "yes") {
      consumed = true;
      const kept = await withRecord(ctx, async (db) => {
        const store = require(path.join(LIB, "store"));
        const decisions = require(path.join(LIB, "decisions"));
        const ops = require(path.join(LIB, "ops"));
        const { words } = require(path.join(LIB, "text"));
        const { proposal } = await store.findProposal(db, pending.id);
        if (!proposal || proposal.status !== "open") return null;
        const said = capture.reasonOf(a.rest);
        const why = said.split(/\s+/).filter(Boolean).length >= 3 ? said : proposal.why || capture.reasonIn(proposal.content);
        // The agent, asked in the same turn, may have proposed the same change itself and named the decision
        // it replaces. The person's one yes answers both, so that replacement is kept and nothing is left waiting.
        const about = new Set(words(proposal.content));
        const alongside = offered && state.lastPrompt
          ? (await store.listProposals(db, "open")).filter((p) => p.id !== proposal.id && p.proposed_by && !/^(import|noticed)$/.test(p.proposed_by)
            && new Date(p.created_at) > new Date(state.lastPrompt.at) && (p.replaces || []).length && words(p.content).some((w) => about.has(w)))
          : [];
        const replaces = [...new Set([...(proposal.replaces || []), ...alongside.flatMap((p) => p.replaces)])];
        const out = await decisions.keepProposal(db, { ...proposal, replaces, source: { ...(proposal.source || {}), yes: "in a session" } }, { person: decisions.whoAmI(project.root), why });
        for (const p of alongside) await store.resolveProposal(db, p.id, "kept", out.decision.id);
        await ops.settle(db, project);
        return out.decision;
      });
      if (kept) {
        ping("decision_kept", 1);
        note("said_yes", { data: { proposal: pending.id, text: clip(prompt, 600) } });
        note("kept", { decision: kept.id });
        note("handed", { decision: kept.id, data: { on: "just kept" } });
        const was = (index.decisions.find((d) => kept.record.provenance.wasRevisionOfAll.includes(d.rid)) || null);
        user.push(`Unl kept "${kept.title}".${was ? ` It replaces "${was.title}".` : ""}${kept.why ? "" : " No reason was given, so it is kept without one."}`);
        context.push(`Unl. The person said yes, so this is now kept for this project: "${ends(kept.statement)}" Their reason: ${kept.why ? ends(kept.why) : "none was given."}${was ? ` It replaces: "${ends(was.statement)}" That one no longer stands.` : ""}`);
        if (was) note("changed_notice", { decision: was.id });
      }
    } else if (a && a.answer === "no") {
      consumed = true;
      await withRecord(ctx, async (db) => {
        const store = require(path.join(LIB, "store"));
        const { refreshIndex } = require(path.join(LIB, "index"));
        await store.resolveProposal(db, pending.id, "skipped");
        await refreshIndex(db, project.storeDir);
      });
      note("said_no", { data: { proposal: pending.id } });
    }
  }

  // 2. A decision handed earlier that has changed since.
  for (const c of changedNotices(ctx)) { context.push(c.text); note("changed_notice", { decision: c.id }); }

  // 2b. Rules were read from files when nobody was at a terminal to say yes. Ask once, here, where the person is.
  if (!consumed && index.waiting_import > 0 && !index.asked_import && !capture.NOT_THE_PERSON.test(prompt)) {
    const asked = await withRecord(ctx, async (db) => {
      const store = require(path.join(LIB, "store"));
      const { refreshIndex } = require(path.join(LIB, "index"));
      if (await store.getMeta(db, "import_asked_at")) return false;
      await store.setMeta(db, "import_asked_at", new Date().toISOString());
      await refreshIndex(db, project.storeDir);
      return true;
    });
    if (asked) {
      consumed = true;
      const n = index.waiting_import;
      note("offer", { data: { batch: "import", count: n, content: `${n} rules read from the rules files` } });
      user.push(`Unl read ${n} ${n === 1 ? "rule" : "rules"} from your rules files and has kept none of them, because nobody had said yes. Reply "keep" to keep them as your decisions, or "skip". (\`npx unlimitless review\` goes through them one at a time.)`);
      context.push(`Unl. ${n} ${n === 1 ? "rule was" : "rules were"} read from this project's rules files and ${n === 1 ? "is" : "are"} not kept as decisions yet. Unl has asked the person whether to keep them. If their next message is a yes, Unl keeps them from that yes; nothing is kept without it.`);
    }
  }

  // 3. The person re-explaining something already kept, changing it, or stating something new.
  if (!consumed) {
    const touch = capture.touches(index, prompt);
    if (touch && touch.kind === "same") {
      const e = touch.entry;
      const before = events.find((x) => (x.kind === "handed" || x.kind === "spoke_first") && x.decision === e.id);
      user.push(`Unl already keeps this, since ${day(e.kept)}: "${e.title}".${before ? ` Your agent was handed it at ${String(before.at).slice(11, 16)} UTC in this session.` : " Your agent has it now."}`);
      context.push(`Unl. The person has just restated a decision that is already kept (since ${day(e.kept)}): ${one(e)}${before ? " It was handed to you earlier in this session." : ""}`);
      if (!before) note("handed", { decision: e.id, data: { on: "restated" } });
      note("sniff", { decision: e.id });
      state.seen.add(e.id);
    } else {
      const sentence = touch ? touch.sentence : capture.standing(prompt);
      if (sentence) {
        const old = touch ? touch.entry : null;
        const made = await withRecord(ctx, async (db) => {
          const decisions = require(path.join(LIB, "decisions"));
          const { refreshIndex } = require(path.join(LIB, "index"));
          const store = require(path.join(LIB, "store"));
          const { triggers, titleOf } = require(path.join(LIB, "extract"));
          const { proposal, added } = await decisions.propose(db, { title: titleOf(sentence), content: sentence, applies_to: triggers(sentence), replaces: old ? [old.id] : [], proposed_by: "noticed", source: { said: "in a session", session: ev.session, host: ev.host } });
          const row = (await store.findProposal(db, proposal.id)).proposal;
          await refreshIndex(db, project.storeDir);
          // Asked once: something the person already declined is not asked again.
          return added && row && row.status === "open" ? proposal : null;
        });
        if (made) {
          const once = " Unl's line to the person is a note beside your reply, not a second question: do not ask them yourself whether to keep it. One answer to you, such as \"keep, <why>\", carries it.";
          note("offer", { data: { proposal: made.id, content: made.content, replaces: old ? old.id : null } });
          if (old) {
            user.push(`Unl: "${made.content}" reads as a change to something already kept, "${old.title}" (${day(old.kept)}). If you are changing it, reply "keep" with one line on why and the new one replaces it. Otherwise reply "skip".`);
            context.push(`Unl. The person just said: "${made.content}" That is close to a decision already kept, but not the same: ${one(old)} Unl has asked them whether the new one replaces it. Until they answer, the kept one has not been changed, and their latest words are the freshest sign of what they want.${once}`);
            if (!state.seen.has(old.id)) { note("handed", { decision: old.id, data: { on: "possible change" } }); state.seen.add(old.id); }
          } else {
            user.push(`Unl: "${made.content}" reads as a decision. Reply "keep" with one line on why and it is kept for next time, or "skip".`);
            context.push(`Unl. The person just said something that reads as a standing decision: "${made.content}" It is not kept. Unl has asked them whether to keep it. If their next message is a yes, Unl keeps it from their own words; nothing is kept without that yes.${once}`);
          }
        }
      }
    }
  }

  // 4. What bears on what was asked. An answer to Unl's own question, or a word or two ("continue"), is
  // not an ask: the judge is not troubled with it, and the ask the turn is working from stays as it was.
  const anAsk = !consumed && prompt.split(/\s+/).filter(Boolean).length >= 3;
  if (anAsk) journal.setAsk(project.storeDir, ev.session, prompt);
  const picked = await choose(index, { prompt }, { host: ev.host, seen: state.seen, skipJudge: !anAsk ? "not-an-ask" : judgeMayRun(ctx, { newTurn: true }) ? null : "after-fault" });
  noteJudge(ctx, picked, "prompt");
  const found = withClashes(index, [...picked.full, ...picked.held]);
  const fresh = (h) => !state.seen.has(h.entry.id);
  const hits = [...picked.full, ...found.hits.filter((h) => h.kind === "pair")].filter(fresh);
  const held = picked.held.filter(fresh);
  if (hits.length || held.length) {
    context.push([handedText(hits, held), ...found.notes].join("\n"));
    for (const h of hits) note("handed", { decision: h.entry.id, data: { on: "prompt", why: h.by || h.kind, matched: (h.matched || []).slice(0, 6) } });
    for (const h of held) note("handed", { decision: h.entry.id, data: { on: "prompt", why: h.by || h.kind, form: "line", matched: (h.matched || []).slice(0, 6) } });
  }
  return { context: context.join("\n\n"), user: user.join(" ") };
}

async function onBefore(ctx) {
  const { ev, index, events, state, project } = ctx;
  const note = (kind, extra = {}) => journal.append(project.storeDir, ev.session, { kind, host: ev.host, root: project.root, ...extra });
  const inside = (f) => { const r = path.relative(project.root, path.resolve(ev.cwd, f)).replace(/\\/g, "/"); return r && !r.startsWith("..") ? r : null; };
  // A patch can touch several files. The one a decision says not to touch is the one that matters; else the first.
  const rels = (ev.files || (ev.file ? [ev.file] : [])).map(inside).filter(Boolean);
  let rel = rels[0] || null;
  for (const r of rels) if (serve.forAction(index, { path: r }, { seen: new Set() }).some((h) => h.kind === "crossing")) { rel = r; break; }
  const target = ev.command ? `The command \`${clip(ev.command.replace(/\s+/g, " "), 160)}\`` : rel ? `The file ${rel}` : null;
  if (!target) return {};
  // An agent about to keep a decision itself, or to write the record by hand. Only a person does that.
  const fence = serve.againstTheFence({ command: ev.command, path: rels.find((r) => serve.againstTheFence({ path: r })) || rel });
  if (fence) {
    const key = createHash("sha256").update(`fence\n${ev.command || rel}`).digest("hex").slice(0, 16);
    if (events.some((e) => e.kind === "spoke_first" && e.data && e.data.key === key)) {
      if (!events.some((e) => e.kind === "went_ahead" && e.data && e.data.key === key)) note("went_ahead", { data: { key, fence: true, target: ev.command ? clip(ev.command, 120) : rel } });
      return {};
    }
    note("spoke_first", { data: { key, fence: true, target: ev.command ? `\`${clip(ev.command.replace(/\s+/g, " "), 120)}\`` : rel } });
    return { deny: [
      "Unl is speaking before this happens. Only a person keeps, changes or retires a decision.",
      `${target} would do that from an agent's hands: it touches ${fence}.`,
      "To put a decision forward, use the unl tool `propose` and let the person answer. Their yes is what keeps it.",
      "Unl stopped this one call so that reaches you before the action and not after. It has not forbidden anything: the same call made again goes through, and the receipt for this session will say that it did.",
    ].join("\n") };
  }
  for (const r of rels) note("acting", { data: { target: r } });
  // The first thing the agent does after Unl spoke first is what a receipt calls "what it did next". Only
  // that one action is written down, and a command is cut short: a journal is no place to keep commands.
  const lastSpoke = [...events].reverse().find((e) => e.kind === "spoke_first");
  if (lastSpoke && !events.some((e) => e.kind === "next" && e.data && e.data.after === lastSpoke.id)) {
    const same = lastSpoke.data && lastSpoke.data.key === createHash("sha256").update(`${lastSpoke.decision || "fence"}\n${ev.command || rel}`).digest("hex").slice(0, 16);
    note("next", { decision: lastSpoke.decision || null, data: { after: lastSpoke.id, tool: ev.tool, target: ev.command ? `\`${clip(ev.command.replace(/\s+/g, " "), 120)}\`` : rel, same: !!same } });
  }
  const hits = serve.forAction(index, { path: rel, command: ev.command, content: ev.content }, { seen: state.seen });
  const context = changedNotices(ctx).map((c) => { note("changed_notice", { decision: c.id }); return c.text; });
  const crossing = hits.find((h) => h.kind === "crossing");
  if (crossing) {
    const key = createHash("sha256").update(`${crossing.entry.id}\n${ev.command || rel}`).digest("hex").slice(0, 16);
    const spokeThis = events.some((e) => e.kind === "spoke_first" && e.data && e.data.key === key);
    const wentOn = events.some((e) => e.kind === "went_ahead" && e.decision === crossing.entry.id);
    if (spokeThis) {
      // The same call again, after Unl spoke: the agent has the decision and has chosen. Let it through and say so in the receipt.
      if (!events.some((e) => e.kind === "went_ahead" && e.data && e.data.key === key)) note("went_ahead", { decision: crossing.entry.id, data: { key, target: ev.command ? clip(ev.command, 120) : rel } });
    } else if (!wentOn) {
      note("spoke_first", { decision: crossing.entry.id, data: { key, tool: ev.tool, target: ev.command ? `\`${clip(ev.command.replace(/\s+/g, " "), 120)}\`` : rel, matched: crossing.matched } });
      ping("spoke_first", 1);
      return { deny: crossingText(crossing, target), context: context.join("\n\n") };
    }
  }
  // What bears on this action. A command is read by its own words, with no model: there are many of them
  // and the ones that matter are the crossings above. A file is put to the judge the first time it is
  // about to change in a turn, with what was asked and the lines about to be written; after that only a
  // name the new lines add is looked for, because the file has been read for this turn already.
  const fresh = (h) => !state.seen.has(h.entry.id);
  let full = hits.filter((h) => h.kind === "bears" && fresh(h));
  let held = [];
  if (!ev.command && rel) {
    const read = state.turn.some((e) => (e.kind === "judged" || judgeFault(e)) && e.data && e.data.target === rel);
    if (read) full = full.filter((h) => h.what === "content");
    else {
      const picked = await choose(index, { prompt: journal.getAsk(project.storeDir, ev.session), path: rel, content: ev.content }, { host: ev.host, seen: state.seen, skipJudge: judgeMayRun(ctx) ? null : "after-fault" });
      noteJudge(ctx, picked, "file", rel);
      full = picked.full.filter(fresh);
      held = picked.held.filter(fresh);
    }
  }
  const pairs = withClashes(index, [...full, ...held]);
  const bears = [...full, ...pairs.hits.filter((h) => h.kind === "pair")].filter(fresh);
  if (bears.length || held.length) {
    context.push([bearsText(bears, ev.command ? "this command" : rel, held), ...pairs.notes].join("\n"));
    for (const h of bears) note("handed", { decision: h.entry.id, data: { on: ev.command ? "command" : rel, why: h.by || h.kind, matched: (h.matched || []).slice(0, 6) } });
    for (const h of held) note("handed", { decision: h.entry.id, data: { on: rel, why: h.by || h.kind, form: "line", matched: (h.matched || []).slice(0, 6) } });
  }
  return { context: context.join("\n\n") };
}

/**
 * The end of a turn says nothing to the person (Neil, 6 Nov item 1: one line a session,
 * nothing per turn, under). It only lets go of what was asked this turn.
 */
function onStop(ctx) {
  journal.clearAsk(ctx.project.storeDir, ctx.ev.session);
  return {};
}

/**
 * THE ONE LINE A SESSION. Claude Code runs a hook when a session ends and throws away anything it says
 * (its hooks reference, SessionEnd: "Claude Code discards their JSON output fields, such as
 * systemMessage"; the one way to show text there prints it as the hook having failed). So the line for a
 * session is said when the next session in this project starts, once, about the session before it. The
 * once-a-session note that the judge could not be asked rides on the same line. `unl receipt` reads the
 * latest session at any time.
 */
function onStart(ctx) {
  const { ev, project } = ctx;
  const all = journal.readAll(project.storeDir);
  const shown = new Set(all.filter((e) => e.kind === "receipt_shown" && e.data && e.data.of).map((e) => e.data.of));
  const last = new Map();
  for (const e of all) if (e.session !== ev.session && e.kind !== "receipt_shown" && (!last.has(e.session) || e.at > last.get(e.session))) last.set(e.session, e.at);
  const before = [...last.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
  if (!before || shown.has(before[0])) return {};
  const events = all.filter((e) => e.session === before[0]);
  const said = receipt.sessionLine(events, events.find(judgeFault));
  if (!said) return {};
  journal.append(project.storeDir, ev.session, { kind: "receipt_shown", host: ev.host, root: project.root, data: { of: before[0] } });
  return { user: said };
}

// ── what each host expects back ─────────────────────────────────────────────────────────────────

function render(ev, out) {
  const context = out.context ? clip(out.context, MAX_CONTEXT) : "";
  if (ev.host === "cursor") return renderCursor(ev, out, context);
  if (!context && !out.user && !out.deny) return "";
  const o = {};
  if (ev.type === "prompt") {
    if (context) o.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context };
    if (out.user) o.systemMessage = out.user;
  } else if (ev.type === "before") {
    if (out.deny) o.hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: clip([out.deny, context].filter(Boolean).join("\n\n"), MAX_CONTEXT) };
    else if (context) o.hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: context };
  } else if (ev.type === "start") {
    if (out.user) o.systemMessage = out.user;
  }
  return Object.keys(o).length ? JSON.stringify(o) : "";
}

/**
 * Cursor's own response shape. Cursor treats an empty reply from a hook that guards an action as a
 * failed hook, so here Unl always answers, and the answer for "nothing to say" is a plain allow.
 * Cursor is not handed the line a session says, so there is no receipt there; `unl receipt` reads it.
 */
function renderCursor(ev, out, context) {
  if (ev.type === "prompt") return JSON.stringify({ continue: true, ...(context ? { additional_context: context } : {}), ...(out.user ? { user_message: out.user } : {}) });
  if (ev.type === "before") {
    if (out.deny) { const reason = clip([out.deny, context].filter(Boolean).join("\n\n"), MAX_CONTEXT); return JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }); }
    return JSON.stringify({ permission: "allow", ...(context ? { additional_context: context } : {}) });
  }
  return "{}";
}

async function run(host, payload) {
  // The judge's own short turn runs an agent, and that agent may run hooks. Unl does nothing inside it,
  // so a judge can never start a judge.
  if (process.env.UNL_JUDGE_CHILD === "1") return "";
  const ev = normalise(host, payload);
  if (!ev) return "";
  const project = paths.locate(ev.cwd);
  if (!paths.isSetUp(project)) return "";
  const index = readIndex(project.storeDir);
  if (!index) return "";
  const events = journal.read(project.storeDir, ev.session);
  const ctx = { ev, project, index, events, state: sessionState(events) };
  const out = ev.type === "prompt" ? await onPrompt(ctx) : ev.type === "before" ? await onBefore(ctx) : ev.type === "stop" ? onStop(ctx) : ev.type === "start" ? onStart(ctx) : {};
  const text = render(ev, out || {});
  if (process.env.UNL_TRACE === "1") trace(ctx, out || {}, text);
  return text;
}

/**
 * For a measurement, never for ordinary use: with UNL_TRACE=1 every call leaves one row saying what it
 * did, so a harness can score the serve without reading prose. The row says which decisions this call
 * placed in the agent's context (and nothing it left out), in what form, whether it spoke to the person,
 * how many characters it added, and which path chose them: "judge" when the person's own model was
 * asked and answered, "net" when it could not answer and the top of the wide net stood in, "off" when
 * the person switched the judge off, "words" when this agent is not asked at this moment or what was typed
 * is not an ask, and "serve" for a call with nothing to choose (a command, a crossing, the end of a
 * turn). The judge's own cost for the call rides beside it, so the tokens handed to the
 * agent and the tokens spent choosing them are read side by side and neither hides in the other.
 */
function trace(ctx, out, text) {
  const before = new Set(ctx.events.map((e) => e.id));
  const mine = journal.read(ctx.project.storeDir, ctx.ev.session).filter((e) => !before.has(e.id));
  const handed = [...new Set(mine.filter((e) => (e.kind === "handed" || e.kind === "spoke_first") && e.decision).map((e) => e.decision))];
  journal.append(ctx.project.storeDir, ctx.ev.session, {
    kind: "call", host: ctx.ev.host, root: ctx.project.root,
    data: {
      event: ctx.ev.type, tool: ctx.ev.tool || null, handed,
      form: out.deny ? "stopped_once" : out.context ? "context" : "nothing",
      spoke_to_person: !!out.user || mine.some((e) => e.kind === "offer"),
      asked: mine.filter((e) => e.kind === "offer").map((e) => (e.data && (e.data.batch ? "keep_rules_read_from_files" : e.data.replaces ? "keep_a_change" : "keep_a_new_decision"))),
      chars_to_agent: (out.context || "").length + (out.deny || "").length, chars_to_person: (out.user || "").length,
      path: ctx.path || "serve", silent: !text,
      judge: ctx.judged ? { ms: ctx.judged.ms, tokens_in: ctx.judged.tokens_in, tokens_out: ctx.judged.tokens_out, model: ctx.judged.model, candidates: ctx.judged.candidates } : null,
    },
  });
}

function main() {
  const host = process.argv[2] || "claude";
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", async () => {
    let text = "";
    try { text = await run(host, JSON.parse(raw || "{}")); } catch { text = ""; }
    if (text) process.stdout.write(text + "\n");
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { run, normalise, render, renderCursor, readPatch, sessionState, crossingText, handedText, bearsText, changedText };
