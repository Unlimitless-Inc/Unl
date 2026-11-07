#!/usr/bin/env node
"use strict";
/*
 * unl, on your own machine. No login, no account, no key, at install or in use.
 *
 *   init                 set Unl up in this project: read your rules files, keep them on your yes, wire your agent
 *                        (Claude Code, and Cursor through it; add --codex or --cursor for those two on their own)
 *   status               what Unl holds here and what is waiting for you
 *   list                 the decisions kept for this project
 *   why <id>             one decision in full: its reason, who decided, what it replaced
 *   keep "<decision>" --why "<reason>" [--replaces <id>] [--for <path>]...
 *   keep <id>            say yes to something that was proposed
 *   replace <id> "<decision>" --why "<reason>"
 *   retire <id> --why "<reason>"
 *   review               go through what is waiting: possible decisions, and decisions that cannot both hold
 *   sync                 take in decisions that arrived through git, and rewrite the files
 *   remove [--files]     take Unl out of this project: its hooks and its record; with --files, the decision files too
 *   receipt              what Unl handed your agent in the latest session
 *   receipt --copy       the moment Unl spoke first, ready to paste into a post (--short, --markdown)
 *   adr                  read the project's architecture decision records and show them back as decisions
 *   telemetry            the opt-in ping: what it would send, and on, off, show, reset
 *   serve --prompt "..." | --path <file> | --command "..."   show what Unl would hand over, and why
 *   judge [on|off]       have your agent's own model choose which decisions bear (on), or go by the words of the ask (off)
 *   export               every kept decision as a record in the open decision format
 *   up                   move up to the hosted Unl: the one command, and what it carries across
 *
 * Everything a command changes, it says. Only you make a decision: an agent can propose one, and it
 * waits here until you say yes.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const LIB = path.join(__dirname, "..", "lib");
const paths = require(path.join(LIB, "paths"));
const { shortId, decisionId, proposalId } = require(path.join(LIB, "format"));
const { day } = require(path.join(LIB, "view"));

const say = (s = "") => process.stdout.write(s + "\n");
const fail = (s) => { process.stderr.write(`unl: ${s}\n`); process.exitCode = 1; };

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

/** Split argv into flags (with their values) and plain words. `multi` flags may repeat. */
function parse(argv, valued = [], multi = []) {
  const flags = new Set(), values = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a) || multi.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (multi.includes(a)) (values[a] = values[a] || []).push(v); else values[a] = v;
    } else if (a.startsWith("-") && a.length > 1 && !/^-?\d/.test(a)) flags.add(a);
    else words.push(a);
  }
  return { flags, values, words };
}

/**
 * Keeping, replacing and retiring are the person's acts, so these commands run only where a person is:
 * at a terminal. An agent's shell has none. That does not make Unl a sandbox (an agent that can run
 * commands as you can do what you can), but it means a decision is never kept by a command an agent
 * happened to run.
 */
function needPerson(what) {
  if (!process.stdin.isTTY) throw new Error(`${what} needs a person at a terminal. An agent can put a decision forward with the unl tool \`propose\`, and the person then says yes.`);
}

function here() {
  const project = paths.locate(process.cwd());
  if (!paths.isSetUp(project)) throw new Error("Unl is not set up in this project yet. Run `npx unlimitless init` here first.");
  return project;
}

const lineOf = (d) => `${shortId(d.id)}  ${d.title}${d.why ? "" : "  (no reason yet)"}`;

async function cmdInit(argv) {
  const { init } = require(path.join(LIB, "init"));
  const { flags } = parse(argv);
  await init({ cwd: process.cwd(), flags, io: { say, ask, tty: !!process.stdin.isTTY } });
}

async function cmdStatus() {
  const project = paths.locate(process.cwd());
  if (!paths.isSetUp(project)) return say("Unl is not set up in this project. Run `npx unlimitless init` here.");
  const ops = require(path.join(LIB, "ops"));
  const out = await ops.sync(project, { write: false });
  const index = out.index;
  say(`Unl in ${project.root}`);
  say(`  ${index.count} ${index.count === 1 ? "decision" : "decisions"} kept, ${Object.keys(index.gone).length} replaced over time`);
  if (index.proposals.length) say(`  ${index.proposals.length} proposed and waiting for your yes (\`npx unlimitless review\`)`);
  const clashes = out.flags.filter((f) => f.kind === "contradiction").length;
  const dead = out.flags.filter((f) => f.kind === "dead_reference").length;
  const bare = out.flags.filter((f) => f.kind === "no_reason").length;
  if (clashes) say(`  ${clashes} ${clashes === 1 ? "pair" : "pairs"} that cannot both hold (\`npx unlimitless review\`)`);
  if (dead) say(`  ${dead} ${dead === 1 ? "names" : "name"} something that is no longer in the project`);
  if (bare) say(`  ${bare} without a reason yet`);
  if (out.arrived) say(`  ${out.arrived} arrived through git since last time`);
  say(`  The record is in ${project.storeDir} and never leaves this machine.`);
}

async function cmdList(argv) {
  const { flags } = parse(argv);
  const project = here();
  const store = require(path.join(LIB, "store"));
  const rows = await store.withStore(project.storeDir, (db) => store.listDecisions(db, flags.has("--all") ? {} : { status: "canonical" }));
  // The records in the published format, each with where it came from and what it applies to (both outside the format).
  if (flags.has("--json")) return say(JSON.stringify(rows.map((d) => ({ record: d.record, source: d.source, applies_to: d.applies_to })), null, 2));
  if (!rows.length) return say("No decisions are kept here yet.");
  for (const d of rows) say(`${lineOf(d)}${d.status === "superseded" ? "  [replaced]" : ""}`);
}

async function cmdWhy(argv) {
  const { words, flags } = parse(argv);
  if (!words[0]) throw new Error("say which decision: npx unlimitless why <id>");
  const project = here();
  const store = require(path.join(LIB, "store"));
  await store.withStore(project.storeDir, async (db) => {
    const { decision: d, matches } = await store.findDecision(db, words[0]);
    if (!d) throw new Error(matches > 1 ? `"${words[0]}" matches more than one decision. Use more of its id.` : `No decision matches "${words[0]}".`);
    if (flags.has("--json")) return say(JSON.stringify(d.record, null, 2));
    const all = await store.listDecisions(db);
    const byRid = new Map(all.map((x) => [x.ruling_id, x]));
    say(d.title);
    if (d.statement.replace(/[.!?]+$/, "") !== d.title.replace(/[.!?]+$/, "")) say(`\n${d.statement}`);
    say(`\nWhy: ${d.why ? d.why.charAt(0).toUpperCase() + d.why.slice(1) : "no reason has been given yet."}`);
    say(`Kept ${day(d.ratified_at)} by ${d.ratified_by}${d.source && d.source.file ? `, read from ${d.source.file} line ${d.source.line_start}` : ""}.`);
    if (d.settled_on) say(`First written ${day(d.settled_on)}${d.source && d.source.author ? ` by ${d.source.author}` : ""}.`);
    if (d.source && d.source.yes) say(`The yes was given ${d.source.yes}.`);
    for (const rid of d.record.provenance.wasRevisionOfAll || []) { const o = byRid.get(rid); say(`Replaces: ${o ? `"${o.title}" (kept ${day(o.ratified_at)})` : rid}`); }
    if (d.status === "superseded") { const by = all.find((x) => x.id === d.replaced_by); say(by ? `Replaced ${day(d.replaced_at)} by "${by.title}" (${shortId(by.id)}).` : `No longer applies since ${day(d.replaced_at)}.${d.retired_why ? " " + d.retired_why : ""}`); }
    say(`Address: ${d.id}`);
  });
}

async function cmdKeep(argv) {
  const { words, values } = parse(argv, ["--why", "--replaces"], ["--for"]);
  if (!words[0]) throw new Error('say what to keep: npx unlimitless keep "<decision>" --why "<reason>", or npx unlimitless keep <id> for something proposed');
  needPerson("Keeping a decision");
  const project = here();
  const store = require(path.join(LIB, "store"));
  const decisions = require(path.join(LIB, "decisions"));
  const ops = require(path.join(LIB, "ops"));
  const person = decisions.whoAmI(project.root);
  await store.withStore(project.storeDir, async (db) => {
    let out;
    const asProposal = /^[0-9a-f]{6,64}$/.test(words[0]) || /^cand1:/.test(words[0]) ? await store.findProposal(db, words[0]) : { proposal: null, matches: 0 };
    if (asProposal.matches > 1) throw new Error(`"${words[0]}" matches more than one proposal. Use more of its id.`);
    if (asProposal.proposal) {
      if (asProposal.proposal.status !== "open") throw new Error("that one has already been answered.");
      out = await decisions.keepProposal(db, { ...asProposal.proposal, source: { ...(asProposal.proposal.source || {}), yes: "at a terminal" } }, { person, why: values["--why"] });
    } else {
      const { extract } = require(path.join(LIB, "extract"));
      const { triggers, titleOf } = require(path.join(LIB, "extract"));
      const statement = words.join(" ");
      const t = triggers(statement);
      for (const g of values["--for"] || []) t.paths.push({ glob: g, text: g, avoid: false });
      out = await decisions.keep(db, { title: titleOf(statement), statement, why: values["--why"] || null, applies_to: t, person, replaces: values["--replaces"] ? [values["--replaces"]] : [], source: { said: "at the command line", yes: "at a terminal" } });
      void extract;
    }
    const settled = await ops.settle(db, project);
    say(`Kept "${out.decision.title}" (${shortId(out.decision.id)}), as decided by ${person}.`);
    for (const o of out.replaced) say(`It replaces "${o.title}".`);
    if (!out.decision.why) say('No reason was given. Add one any time: npx unlimitless replace ' + shortId(out.decision.id) + ' "<the same decision>" --why "<reason>"');
    if (settled.changed.length) say(`Updated ${settled.changed.filter((f) => !f.startsWith(".unl")).join(", ") || ".unl/decisions/"}.`);
  });
}

async function cmdReplace(argv) {
  const { words, values } = parse(argv, ["--why"], ["--for"]);
  if (words.length < 2) throw new Error('npx unlimitless replace <id> "<the new decision>" --why "<reason>"');
  return cmdKeep([...words.slice(1), "--replaces", words[0], ...(values["--why"] ? ["--why", values["--why"]] : []), ...((values["--for"] || []).flatMap((g) => ["--for", g]))]);
}

async function cmdRetire(argv) {
  const { words, values } = parse(argv, ["--why"]);
  if (!words[0]) throw new Error('npx unlimitless retire <id> --why "<reason>"');
  needPerson("Retiring a decision");
  const project = here();
  const store = require(path.join(LIB, "store"));
  const decisions = require(path.join(LIB, "decisions"));
  const ops = require(path.join(LIB, "ops"));
  await store.withStore(project.storeDir, async (db) => {
    const { decision, done } = await decisions.retire(db, words[0], { why: values["--why"] || null });
    await ops.settle(db, project);
    say(done ? `"${decision.title}" no longer applies. It stays in the record, marked as retired.` : `"${decision.title}" was already replaced.`);
  });
}

async function cmdReview() {
  const project = here();
  if (!process.stdin.isTTY) throw new Error("review asks you questions, so it needs a terminal.");
  const store = require(path.join(LIB, "store"));
  const decisions = require(path.join(LIB, "decisions"));
  const ops = require(path.join(LIB, "ops"));
  const person = decisions.whoAmI(project.root);
  const proposals = await store.withStore(project.storeDir, (db) => store.listProposals(db, "open"));
  let kept = 0, skipped = 0;
  for (const p of proposals) {
    say(`\n${p.content}`);
    if (p.why) say(`  Why: ${p.why}`);
    say(`  ${p.source && p.source.file ? `from ${p.source.file}, line ${p.source.line_start}` : p.proposed_by === "noticed" ? "you said this in a session" : `proposed by ${p.proposed_by || "an agent"}`}`);
    const a = (await ask("  Keep it? [y/n/q] ")).toLowerCase();
    if (a === "q") break;
    if (a.startsWith("y")) {
      let why;
      if (!p.why) { const w = await ask("  Why? (one line, or enter to leave it out) "); why = w || undefined; }
      await store.withStore(project.storeDir, (db) => decisions.keepProposal(db, { ...p, source: { ...(p.source || {}), yes: "at a terminal" } }, { person, why }));
      kept++;
    } else if (a.startsWith("n")) { await store.withStore(project.storeDir, (db) => store.resolveProposal(db, p.id, "skipped")); skipped++; }
  }
  await store.withStore(project.storeDir, async (db) => {
    const all = await store.listDecisions(db, { status: "canonical" });
    const byId = new Map(all.map((d) => [d.id, d]));
    await ops.settle(db, project, { write: false });
    for (const f of (await store.listFlags(db, "open")).filter((x) => x.kind === "contradiction")) {
      const [a, b] = f.decision_ids.map((id) => byId.get(id));
      if (!a || !b) continue;
      say(`\nThese two cannot both hold (${f.detail.why}):`);
      say(`  1. ${a.statement}`);
      say(`  2. ${b.statement}`);
      const pick = await ask("  Which stands? [1/2/skip] ");
      if (pick === "1" || pick === "2") {
        const [win, lose] = pick === "1" ? [a, b] : [b, a];
        await store.replaceDecision(db, lose.id, win.id, { why: "the person chose between two that could not both hold" });
        await store.settleFlag(db, f.id, "settled", `"${win.title}" stands`);
        say(`  "${win.title}" stands.`);
      }
    }
    const settled = await ops.settle(db, project);
    say(`\nKept ${kept}, skipped ${skipped}.${settled.changed.length ? " The files are updated." : ""}`);
  });
}

async function cmdSync() {
  const project = here();
  const ops = require(path.join(LIB, "ops"));
  const out = await ops.sync(project);
  if (out.arrived) say(`${out.arrived} ${out.arrived === 1 ? "decision" : "decisions"} arrived through git and ${out.arrived === 1 ? "is" : "are"} now in the record.`);
  for (const r of out.refused) say(`${r.name} was not taken in: ${r.why}.`);
  say(out.changed.length ? `Updated ${out.changed.length} ${out.changed.length === 1 ? "file" : "files"}.` : "Everything is already current.");
}

async function cmdRemove(argv) {
  const { flags } = parse(argv);
  needPerson("Removing Unl");
  const project = paths.locate(process.cwd());
  if (!project) throw new Error("this folder is not a project.");
  const files = flags.has("--files");
  const a = await ask(files
    ? "Remove Unl from this project, with its decision files and its section in your rules files? [y/N] "
    : "Remove Unl from this project? Your decisions stay readable in your rules files and in .unl/. [y/N] ");
  if (!/^y/i.test(a)) return say("Nothing was removed.");
  const done = require(path.join(LIB, "remove")).remove(project, { files });
  say(done.length ? `Removed ${done.join(", ")}.` : "Unl was not set up here, so there was nothing to remove.");
  say("The copy of Unl in ~/.unl/open is shared by your other projects. Delete that folder to take Unl off this machine.");
}

function cmdReceipt(argv) {
  const { flags } = parse(argv);
  const project = here();
  const journal = require(path.join(LIB, "journal"));
  const receipt = require(path.join(LIB, "receipt"));
  const { readIndex } = require(path.join(LIB, "index"));
  const all = journal.readAll(project.storeDir);
  if (!all.length) return say("No session has run here since Unl was set up.");
  const latest = all.reduce((a, b) => (a.at > b.at ? a : b)).session;
  const events = flags.has("--all") ? all.sort((a, b) => (a.at < b.at ? -1 : 1)) : all.filter((e) => e.session === latest);
  const index = readIndex(project.storeDir);
  const sharing = ["--copy", "--short", "--markdown", "--md", "--share"].some((f) => flags.has(f));
  // A decision's words, reason and the day it was settled, from the index the hooks read. The day Unl first
  // held a decision is the day it was settled only when it was made here, in a session. For one read from a
  // file that day is the day of the import, so where the file gave none the receipt gives none.
  const me = sharing ? require(path.join(LIB, "decisions")).whoAmI(project.root) : null;
  const lookup = (id) => {
    const e = index.decisions.find((d) => d.id === id);
    const g = index.gone && index.gone[id];
    if (e) return { statement: e.statement, why: e.why, settledOn: e.settled || (e.from ? null : (e.kept || "").slice(0, 10)), mine: !!me && e.by === me };
    return g ? { statement: g.statement, why: null, settledOn: null, mine: false } : null;
  };
  const share = require(path.join(LIB, "share"));
  const shareable = require(path.join(LIB, "share", "journal")).fromJournal(events, lookup);
  if (sharing) {
    if (!shareable.length) return say("Unl handed nothing over in that session, so there is no receipt to share.");
    const r = shareable[shareable.length - 1];
    const form = flags.has("--short") ? "short" : flags.has("--markdown") || flags.has("--md") ? "markdown" : "text";
    const text = share.renderReceipt(r, form, { footer: !flags.has("--no-footer") });
    say(text);
    if (r.leftOut.length) say(`\nLeft out of it: ${r.leftOut.join(", ")}.`);
    if (flags.has("--copy")) say(share.copyText(text) ? "\nCopied. Paste it wherever you like." : "\nThis machine has no clipboard command Unl knows, so select the receipt above and copy it.");
    return;
  }
  const line = receipt.line(events);
  say(line || "Unl handed nothing over in that session, because nothing kept here bore on it.");
  for (const l of receipt.detail(events, index)) say("  " + l);
  if (shareable.some((r) => r.kind === "spoke_first")) say("\nTo share the moment Unl spoke first: npx unlimitless receipt --copy");
}

/** Read the project's architecture decision records and show them back. Reads only: nothing is kept here. */
async function cmdAdr(argv) {
  // Where Unl is set up, a question the person has already answered is not shown again.
  let settled = [];
  const project = paths.locate(process.cwd());
  if (paths.isSetUp(project)) {
    const store = require(path.join(LIB, "store"));
    try { settled = await store.withStore(project.storeDir, (db) => require(path.join(LIB, "adr", "store")).settledIds(db)); } catch {}
  }
  process.exitCode = require(path.join(LIB, "adr")).run(argv, { out: say, cwd: process.cwd(), columns: process.stdout.columns || 100, settled });
}

/** The opt-in ping: what it would send, and on, off, show, reset. */
async function cmdTelemetry(argv) {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  process.exitCode = await require(path.join(LIB, "telemetry")).run(argv, { out: say, self: "unl", unlVersion: version });
}

/**
 * Show what Unl would hand over, chosen the way the hook chooses it (lib/choose.js), so this is what an
 * agent would get and not a guess at it.
 *   --candidates   the wide net that is chosen from. It is never what an agent is handed.
 *   --judged       with --json: what was handed and what was read against the work and left out.
 *   --no-judge     what the words of the ask and the place of the file find by themselves.
 */
async function cmdServe(argv) {
  const { values, flags } = parse(argv, ["--prompt", "--path", "--command", "--content", "--host"]);
  const project = here();
  const { readIndex } = require(path.join(LIB, "index"));
  const serve = require(path.join(LIB, "serve"));
  const index = readIndex(project.storeDir);
  const work = { prompt: values["--prompt"] || "", path: values["--path"] || null, command: values["--command"] || "", content: values["--content"] || "" };
  const row = (h) => ({ id: h.entry.id, title: h.entry.title, statement: h.entry.statement, why: h.entry.why, applies: h.entry.kind, kind: h.kind, matched: h.matched, score: h.score, source: h.entry.from ? { file: h.entry.from, lines: h.entry.lines } : null, ...(h.form ? { form: h.form === "held" ? "line" : "full", chosen_by: h.by } : {}) });
  const print = (rows, none) => {
    if (!rows.length) return say(none);
    for (const o of rows) say(`${(o.form === "line" ? "one line" : o.kind).padEnd(9)} ${shortId(o.id)}  ${o.title}${o.matched && o.matched.length ? `   (matched ${o.matched.join(", ")})` : ""}`);
  };
  if (flags.has("--candidates")) {
    const out = serve.forJudge(index, work).map(row);
    if (flags.has("--json")) return say(JSON.stringify(out, null, 2));
    return print(out, "Nothing is kept here yet, so there is nothing to choose from.");
  }
  // A command is read by its own words, with no model; so is everything a crossing decides.
  const crossings = work.path || work.command ? serve.forAction(index, work).filter((h) => h.kind === "crossing") : [];
  let picked = { path: "words", full: work.command && !work.path ? serve.forAction(index, work).filter((h) => h.kind !== "crossing") : [], held: [], left: [], fault: null };
  if (work.path || !work.command) {
    const { choose } = require(path.join(LIB, "choose"));
    picked = await choose(index, work.path ? { prompt: work.prompt, path: work.path, content: work.content } : { prompt: work.prompt }, { host: values["--host"] || "claude", env: flags.has("--no-judge") ? { ...process.env, UNL_JUDGE: "off" } : process.env });
  }
  const handed = [...crossings, ...picked.full, ...picked.held].map(row);
  if (flags.has("--json")) {
    if (!flags.has("--judged")) return say(JSON.stringify(handed, null, 2));
    return say(JSON.stringify({ chosen_by: picked.path, handed, left_out: picked.left.map((h) => ({ ...row(h), why_left_out: "it was read against this work and not picked" })), fault: picked.fault ? { reason: picked.fault.reason, detail: picked.fault.detail } : null }, null, 2));
  }
  print(handed, "Nothing kept here bears on that, so Unl would say nothing.");
  if (picked.fault) say(`Your agent's model could not be asked (${picked.fault.detail || picked.fault.reason}), so this is what the words of the ask find.`);
  else if (picked.path === "off") say("This is what the words of the ask find. `npx unlimitless judge on` has your agent's own model choose instead.");
}

/**
 * One switch, and nothing to read: whether the agent's own model chooses which decisions bear.
 *   unl judge on    it does (how Unl is set up to begin with)
 *   unl judge off   Unl goes by the words of what was asked and the place of the file about to change
 *   unl judge       says which
 * Switching it is the person's act, so it needs a terminal, like every other change to what Unl does here.
 * It shows no meter and no timings. What the choosing costs is one short turn of the agent the person
 * already runs, inside that agent's own usage, and the README says so once.
 */
async function cmdJudge(argv) {
  const { words } = parse(argv);
  const project = here();
  const store = require(path.join(LIB, "store"));
  const judge = require(path.join(LIB, "judge"));
  const { refreshIndex, readIndex, judgeSetting } = require(path.join(LIB, "index"));
  const want = words[0];
  if (want && want !== "on" && want !== "off") throw new Error("npx unlimitless judge on, or npx unlimitless judge off");
  if (want) {
    needPerson("Changing how Unl chooses what bears");
    await store.withStore(project.storeDir, async (db) => {
      await store.setMeta(db, "judge", JSON.stringify({ ...((await judgeSetting(db)) || {}), mode: want }));
      await refreshIndex(db, project.storeDir);
    });
  }
  const on = judge.config(readIndex(project.storeDir)).mode === "on";
  say(on
    ? "Your agent's own model chooses which of your decisions bear on the work. `npx unlimitless judge off` has Unl go by the words of what you ask instead."
    : "Unl goes by the words of what you ask. `npx unlimitless judge on` has your agent's own model choose which decisions bear instead.");
}

/** Every kept decision as a record in the published format, and nothing else: what `conformance.mjs --check` reads. */
async function cmdExport() {
  const project = here();
  const store = require(path.join(LIB, "store"));
  const rows = await store.withStore(project.storeDir, (db) => store.listDecisions(db));
  say(JSON.stringify(rows.map((d) => d.record), null, 2));
}

/**
 * THE STEP UP. The hosted Unl is the same record in every AI the person uses. This
 * command sends nothing (the command it gives, `unl connect`, is the hosted Unl's sign-in, in the same
 * package): it brings the decision pages up to date, says what stands here, and gives the
 * one command that moves the project up. That command opens the hosted account once and reads the pages in
 * .unl/decisions/ as the records they carry, so each decision that still stands arrives with its reason
 * exactly as kept, to be kept there on the person's yes. `--from open-unl` is how the hosted Unl counts
 * an arrival from here; it carries nothing about the person.
 */
async function cmdUp() {
  const project = here();
  const ops = require(path.join(LIB, "ops"));
  const out = await ops.sync(project);
  const n = out.index.count;
  const gone = Object.keys(out.index.gone).length;
  say("Moving this project up to the hosted Unl");
  say("");
  say(`  Here: ${n} ${n === 1 ? "decision stands" : "decisions stand"}${gone ? `, and ${gone} replaced over time stay${gone === 1 ? "s" : ""} on this machine` : ""}.`);
  if (out.changed && out.changed.length) say(`  Brought up to date first: ${out.changed.join(", ")}`);
  say("  The hosted Unl is the same record in every AI you use, including the chat apps and your phone,");
  say("  kept in step across your machines and your team.");
  say("");
  say("  In this folder, run:");
  say("");
  say(`    npx unlimitless connect --from ${UP_TAG}`);
  say("");
  say("  It opens your browser once for your hosted account, and shows you what it will read before it reads it.");
  say("  Each decision in .unl/decisions/ that still stands arrives with its reason exactly as you kept it,");
  say("  and you keep each one there with a yes.");
  say("  This command sent nothing. Nothing leaves this machine until you run that one.");
}

/** The tag the hosted Unl counts an arrival from the open install by (src/services/arrivalFacts.ts OPEN_UNL_TAG). */
const UP_TAG = "open-unl";

/** The conformance check's door: one record or proposal on stdin, its address on stdout. */
function cmdAddress() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  say(input.kind === "proposal" ? proposalId(input.content, input.why) : decisionId(input));
}

const HELP = `Unl keeps what you decided and why, on your own machine, and hands it to your coding agent when it bears.
There is no account and nothing to sign in to.

Usage: npx unlimitless <command>

  init                  Set Unl up in this project. Reads your rules files and keeps them on your yes.
                        Wires Claude Code (Cursor runs the same hooks). Add --codex for Codex.
  status                What Unl holds here and what is waiting for you.
  list                  The decisions kept for this project.
  why <id>              One decision in full.
  keep "<decision>" --why "<reason>"      Keep a decision yourself.
  replace <id> "<decision>" --why "..."   Replace one with another. The old one is marked, never deleted.
  retire <id> --why "..."                 Say one no longer applies.
  review                Go through what is waiting for you.
  sync                  Take in decisions that arrived through git.
  remove                Take Unl out of this project. Add --files to remove the decision files too.
  receipt               What Unl handed your agent in the latest session.
                        Add --copy for the moment Unl spoke first, ready to paste into a post.
  adr                   Read the project's architecture decision records and show them back as decisions.
  telemetry             The opt-in ping. Off until you turn it on. Shows exactly what it would send.
  serve --prompt "..."  Show what Unl would hand over for a prompt, a --path or a --command.
  judge [on|off]        Have your agent's own model choose which decisions bear, or go by the words of the ask.
  export                Every kept decision as a record in the open decision format.
  up                    Move up to the hosted Unl: the one command, and what it carries across.`;

const COMMANDS = { init: cmdInit, status: cmdStatus, list: cmdList, why: cmdWhy, keep: cmdKeep, replace: cmdReplace, retire: cmdRetire, review: cmdReview, sync: cmdSync, remove: cmdRemove, export: cmdExport, up: cmdUp, receipt: cmdReceipt, serve: cmdServe, judge: cmdJudge, address: cmdAddress, adr: cmdAdr, telemetry: cmdTelemetry };

/**
 * Run one command. The one `unl` command people install runs the local commands through this, so a
 * command behaves the same whichever door it came in by. A fault is said plainly and sets the exit code.
 */
async function run(argv) {
  const [cmd, ...rest] = argv;
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  try {
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return say(HELP);
    if (cmd === "--version" || cmd === "-v" || cmd === "version") return say(pkg.version);
    if (cmd === "mcp") return require(path.join(__dirname, "..", "runtime", "mcp.cjs")).main(rest);
    if (!COMMANDS[cmd]) { fail(`there is no command "${cmd}".\n\n${HELP}`); return; }
    await COMMANDS[cmd](rest);
  } catch (err) { fail(err && err.message ? err.message : String(err)); }
}

if (require.main === module) run(process.argv.slice(2));
module.exports = { run, HELP, COMMANDS: Object.keys(COMMANDS).filter((c) => c !== "address") };
void os;
