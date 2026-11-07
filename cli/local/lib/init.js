"use strict";
/*
 * The first minute.
 *
 * One command, in a project, with nothing to sign in to. It reads the rules the person already wrote,
 * shows them back as decisions, and asks one question: keep these? Then it does the two things a file
 * cannot do. It says which decisions give no reason, and it checks them against each other and against
 * the project as it stands. If two cannot both hold it asks which one stands, which is a question only
 * the person can answer. If it finds nothing, it says nothing.
 *
 * Nothing here calls a model and nothing leaves the machine. The choosing of what bears, which does ask
 * the person's own agent (lib/judge.js), starts with their first ask in that agent, not here.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths");
const store = require("./store");
const ops = require("./ops");
const decisions = require("./decisions");
const { discover } = require("./discover");
const runtime = require("./runtime");
const claude = require("./hosts/claude");
const codex = require("./hosts/codex");
const cursor = require("./hosts/cursor");
const adr = require("./adr");
const adrStore = require("./adr/store");
const telemetry = require("./telemetry");
const { atEdge } = require("./history");

/**
 * When each line of a file was last written and by whom, from git, in one call. Empty when the file is not
 * in git. A line whose commit is where a shallow copy's history stops is left out: git names that commit
 * for every older line, so its day and author say when the copy was cut, not when the line was written.
 */
function blameLines(root, file) {
  const out = new Map();
  const r = spawnSync("git", ["blame", "--line-porcelain", "--", file], { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return out;
  let line = 0, time = null, mail = null, unknown = false;
  for (const l of String(r.stdout || "").split("\n")) {
    const h = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(l);
    if (h) { line = Number(h[2]); unknown = /^0+$/.test(h[1]) || atEdge(root, h[1]); continue; }
    if (l.startsWith("author-mail ")) mail = l.slice(12).replace(/^<|>$/g, "").trim();
    if (l.startsWith("author-time ")) time = Number(l.slice(12));
    if (l.startsWith("\t") && line && time && !unknown) out.set(line, { date: new Date(time * 1000).toISOString().slice(0, 10), author: mail || null });
  }
  return out;
}
/** Kept for callers that only want the dates. */
function blameDates(root, file) {
  const out = new Map();
  for (const [line, v] of blameLines(root, file)) out.set(line, v.date);
  return out;
}

function notAProject(dir) {
  const real = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
  const d = real(dir);
  return d === real(os.homedir()) || d === path.parse(d).root;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const where = (d) => (d.source && d.source.file ? `${d.source.file}, line ${d.source.line_start}` : "said in a session");

/**
 * Run the first minute. `io` is { say, ask, tty }: `ask(question)` resolves to the typed answer.
 * `flags` is a Set of command-line flags. Returns a summary of what happened, for the caller and the tests.
 */
async function init({ cwd = process.cwd(), flags = new Set(), io, env = process.env, home = os.homedir() }) {
  const { say, ask } = io;
  if (notAProject(cwd)) {
    say("This is your home folder, not a project. Run this inside the project you want your agent to work from.");
    return { ok: false, reason: "not_a_project" };
  }
  const project = paths.locateForInit(cwd);
  // --yes answers the question without it being asked, and it counts only where a person typed it: at a
  // terminal. Run by a script or by an agent, with nobody there, a flag is not a person and keeps nothing.
  const yes = (flags.has("--yes") || flags.has("-y")) && !!io.tty;
  const flagWithNobody = (flags.has("--yes") || flags.has("-y")) && !io.tty;
  const summary = { ok: true, root: project.root, read: [], kept: 0, waiting: 0, flags: [], written: [], wired: [] };

  say(`Unl is setting up in ${project.root}`);
  say("Your record stays on this machine. There is no account and nothing to sign in to.");

  // What is already written down.
  const files = flags.has("--no-read") ? [] : discover(project.root);
  // Claude Code puts CLAUDE.md in front of the agent on every turn and does not do that for AGENTS.md
  // (measured on Claude Code 2.1.319: a line in AGENTS.md alone was not known to the agent, the same line
  // in CLAUDE.md was). So where Claude Code is being wired, Unl's section goes into CLAUDE.md whether or
  // not one exists yet. Otherwise a rule that applies to every change, which Unl leaves to the rules file,
  // would reach that agent from no file at all.
  const forClaude = !flags.has("--no-wire") && !claude.detect(project.root, { home }).hosted;
  const hadClaudeFile = fs.existsSync(path.join(project.root, "CLAUDE.md"));
  const viewFiles = ["AGENTS.md", ...["CLAUDE.md", "GEMINI.md"].filter((f) => (f === "CLAUDE.md" && forClaude) || fs.existsSync(path.join(project.root, f)))];

  let open = [];
  // The decision records the project already keeps (an ADR folder), read as the decisions they are.
  let records = null;
  await store.withStore(project.storeDir, async (db) => {
    await store.setMeta(db, "view_files", JSON.stringify(viewFiles));
    await ops.takeIn(db, project);
    if (files.length) summary.read = await ops.readFiles(db, project, files);
    if (!flags.has("--no-read")) {
      records = adr.readAdrs(project.root, { settled: await adrStore.settledIds(db) });
      if (records.records.length) summary.records = await adrStore.proposeAdrs(db, project, records);
      else records = null;
    }
    open = (await store.listProposals(db, "open")).filter((p) => p.proposed_by === "import");
    await ops.settle(db, project, { write: false });
  });

  if (summary.read.length) {
    say("");
    say("Reading what you already wrote down");
    const width = Math.max(...summary.read.map((r) => r.file.length)) + 2;
    for (const r of summary.read) {
      if (r.error) say(`  ${r.file.padEnd(width)}${r.error}`);
      else if (r.skipped) say(`  ${r.file.padEnd(width)}already read, unchanged`);
      else {
        const mine = open.filter((p) => p.source && p.source.file === r.file);
        // What the file says to do, and what it only says about the project: both are kept, and told apart.
        const about = mine.filter((p) => p.applies_to && p.applies_to.describes).length;
        const rules = Math.max(0, r.found - about);
        say(`  ${r.file.padEnd(width)}${r.found ? `${plural(rules, "rule", "rules")}, ${mine.filter((p) => p.why).length} with a reason${about ? `, and ${plural(about, "line", "lines")} about the project` : ""}` : "no rules found"}`);
      }
    }
  }

  if (records) {
    say("");
    for (const line of adr.renderShowBack(records, { limit: 6, question: false }).split("\n")) say(line);
  }

  if (open.length) {
    say("");
    // Decision records were shown above, in full; the list here is the rules read from rules files.
    const rules = open.filter((p) => !adrStore.isAdr(p));
    for (const p of rules.slice(0, 8)) say(`  ${p.title || p.content}`);
    if (rules.length > 8) say(`  and ${rules.length - 8} more`);
    if (rules.length) say("");
    let answer = "y";
    if (!yes) {
      if (!io.tty) answer = "";
      else answer = await ask(`Keep ${open.length === 1 ? "this" : `these ${open.length}`} as your ${open.length === 1 ? "decision" : "decisions"}? Your wording is kept exactly. [Y/n] `);
    }
    if (!yes && !io.tty) {
      summary.waiting = open.length;
      say(`${plural(open.length, "possible decision was", "possible decisions were")} read and none is kept yet, because nobody was at a terminal to say yes${flagWithNobody ? " (a flag is not a person)" : ""}.`);
      say("Unl will ask you once, in your agent, the next time you type something there. Or run `npx unlimitless init` yourself in a terminal.");
    } else if (/^n/i.test(answer)) {
      summary.waiting = open.length;
      say("Nothing was kept. They wait until you say so: `npx unlimitless review` goes through them one at a time.");
    } else {
      const person = decisions.whoAmI(project.root);
      const dates = new Map();
      // One yes, one moment: everything kept by it carries the same time.
      const at = new Date();
      await store.withStore(project.storeDir, async (db) => {
        for (const p of open) {
          const f = p.source && p.source.file;
          if (f && !dates.has(f)) dates.set(f, blameLines(project.root, f));
          const wrote = f ? dates.get(f).get(p.source.line_start) || null : null;
          // Who wrote the line is kept beside who said yes to it. They are often not the same person.
          await decisions.keepProposal(db, { ...p, source: { ...(p.source || {}), ...(wrote ? { written: wrote.date, author: wrote.author } : {}), yes: "at a terminal" } }, { person, settled_on: wrote ? wrote.date : null, at });
          if (wrote && wrote.author && wrote.author !== person) summary.byOthers = (summary.byOthers || 0) + 1;
          summary.kept++;
        }
        await ops.settle(db, project, { write: false });
      });
      say(`Kept ${plural(summary.kept, "decision", "decisions")}, as decided by ${person}.`);
      if (summary.byOthers) say(`${plural(summary.byOthers, "of them was", "of them were")} first written by someone else, according to git. Each file in .unl/decisions/ says who.`);
    }
  } else if (!files.length) {
    say("");
    say("There is no rules file here yet, so there is nothing to read. Unl will pick decisions up as you make them.");
  }

  // What a file cannot notice about itself.
  await store.withStore(project.storeDir, async (db) => {
    const all = await store.listDecisions(db, { status: "canonical" });
    const byId = new Map(all.map((d) => [d.id, d]));
    const flagsOpen = await store.listFlags(db, "open");
    const clashes = flagsOpen.filter((f) => f.kind === "contradiction");
    for (const f of clashes) {
      const [a, b] = f.decision_ids.map((id) => byId.get(id));
      if (!a || !b || a.status !== "canonical" || b.status !== "canonical") continue;
      say("");
      say("Two of them cannot both hold");
      say(`  1. "${a.title}"  (${where(a)})`);
      say(`  2. "${b.title}"  (${where(b)})`);
      let pick = "";
      if (io.tty && !yes) pick = (await ask("  Which stands? [1/2/skip] ")).trim();
      if (pick === "1" || pick === "2") {
        const [win, lose] = pick === "1" ? [a, b] : [b, a];
        await store.replaceDecision(db, lose.id, win.id, { why: "the person chose between two that could not both hold" });
        lose.status = "superseded";
        await store.settleFlag(db, f.id, "settled", `"${win.title}" stands`);
        say(`  "${win.title}" stands. The other is marked as replaced.`);
        summary.flags.push({ kind: "contradiction", settled: true });
      } else {
        say("  Left as it is. `npx unlimitless review` asks again whenever you are ready.");
        summary.flags.push({ kind: "contradiction", settled: false });
      }
    }
    // The one question the decision records leave. It is asked once, and not on top of a question above.
    if (records && records.question && !summary.flags.some((f) => f.kind === "contradiction")) {
      const q = records.question;
      const choices = adrStore.choicesFor(q);
      say("");
      say("One question only you can answer");
      say(`  ${q.question}`);
      let did = null;
      if (choices && io.tty && !yes) {
        choices.forEach((c, i) => say(`    ${i + 1}. ${c.charAt(0).toUpperCase()}${c.slice(1)}`));
        const pick = (await ask(`  [${choices.map((_c, i) => i + 1).join("/")}/skip] `)).trim();
        did = await adrStore.answer(db, project, records, q, pick, { person: decisions.whoAmI(project.root) });
      }
      if (did) say(`  ${did}`);
      else if (choices) say("  Left as it is. `npx unlimitless init` asks again whenever you are ready, and `npx unlimitless adr` shows it.");
      else say("  `npx unlimitless adr` shows it again. `npx unlimitless replace` answers it, or editing the record does.");
      summary.flags.push({ kind: "record_question", question: q.kind, settled: !!did });
    }
    const dead = flagsOpen.filter((f) => f.kind === "dead_reference");
    if (dead.length) {
      say("");
      say(dead.length === 1 ? "One names something that is not here" : `${dead.length} name something that is not here`);
      for (const f of dead.slice(0, 6)) {
        const d = byId.get(f.decision_ids[0]);
        if (d) say(`  "${d.title}" ${String(f.detail.why).replace(/^it /, "")}.`);
        summary.flags.push({ kind: "dead_reference" });
      }
      if (dead.length > 6) say(`  and ${dead.length - 6} more, in \`npx unlimitless review\`.`);
    }
    const settled = await ops.settle(db, project);
    summary.written = settled.changed;
    const bare = settled.flags.filter((f) => f.kind === "no_reason").length;
    if (bare) {
      say("");
      say(`${plural(bare, "decision has", "decisions have")} no reason yet. The reason is what lets an agent get the next case right, so tell your agent why whenever one comes up.`);
      summary.flags.push({ kind: "no_reason", count: bare });
    }
  });

  if (summary.written.length) {
    say("");
    say("Written");
    const files = summary.written.filter((f) => !f.startsWith(".unl"));
    for (const f of files) say(`  ${f.padEnd(18)}${f === "AGENTS.md" ? "your decisions with their reasons, for every tool that reads it" : f === "CLAUDE.md" && !hadClaudeFile ? "the same, where Claude Code reads them" : "Unl's section, below your own text"}`);
    const n = summary.written.filter((f) => f.startsWith(path.join(".unl", "decisions"))).length;
    if (n) say(`  ${".unl/decisions/".padEnd(18)}${plural(n, "file", "files")}, one per decision`);
  }

  // The agents on this machine.
  if (!flags.has("--no-wire")) {
    const rt = runtime.install({ env, inPlace: flags.has("--in-place") });
    const found = claude.detect(project.root, { home });
    say("");
    say("Wired");
    if (found.hosted) {
      say("  Claude Code       this folder already reaches the hosted Unl, so no second hook was added");
    } else {
      const h = claude.wireHooks(project.root, rt.hook);
      const m = flags.has("--no-mcp") ? { ok: false, reason: "skipped" } : claude.wireMcp(project.root, rt.mcp, { bin: env.UNL_CLAUDE_BIN || "claude" });
      say(`  Claude Code       hooks ${h.added ? "added to" : "already in"} ${h.file}${m.ok ? ", and the unl server for this folder" : ""}`);
      if (!m.ok && m.reason !== "skipped") say(`                    the unl server was not added (${m.reason}); the hooks work without it`);
      say("                    Cursor runs these same hooks, so it is served here too");
      summary.wired.push({ host: "claude", hooks: h.added, mcp: !!m.ok });
    }
    // Codex and Cursor keep hooks in a file of the person's own that covers every project, so those are
    // written only when asked for.
    if (flags.has("--codex")) {
      const found = codex.detect(home, { env, hookPath: rt.hook });
      if (found.hosted) say("  Codex             Codex already reaches the hosted Unl on this machine, so no second hook was added");
      else {
        const c = codex.wireHooks(home, rt.hook, { env });
        say(`  Codex             hooks ${c.added ? "added to" : c.reason ? "not added to" : "already in"} ${c.file.replace(home, "~")}${c.reason ? ` (${c.reason})` : ""}`);
        if (c.added) say("                    The first time, open Codex and type /hooks. Codex runs a new hook only after you approve it there, once.");
        summary.wired.push({ host: "codex", hooks: c.added });
      }
    }
    if (flags.has("--cursor")) {
      const c = cursor.wireHooks(home, rt.hook, { env });
      say(`  Cursor            hooks ${c.added ? "added to" : c.reason ? "not added to" : "already in"} ${c.file.replace(home, "~")}${c.reason ? ` (${c.reason})` : ""}`);
      summary.wired.push({ host: "cursor", hooks: c.added });
    }
  }

  say("");
  say("Done. Open your agent here and work as normal. Unl stays out of the way and speaks only when a decision is about to be crossed.");
  // The ping is off unless the person turned it on, so for everyone else these lines do nothing at all.
  try {
    const unlVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
    telemetry.record("install", { env, unlVersion });
    if (summary.kept) telemetry.record("decision_kept", { env, count: summary.kept, unlVersion });
    telemetry.flushDetached({ env });
    if (!telemetry.readState(telemetry.homeDir(env)).on) say(telemetry.offerLine("npx unlimitless"));
  } catch {}
  return summary;
}

module.exports = { init, blameDates, blameLines, notAProject };
