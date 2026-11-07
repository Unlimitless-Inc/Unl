"use strict";
/*
 * Receipts a person can share, built from what the hooks wrote down.
 *
 * The hooks keep a journal of each session: which decision Unl handed over, the moment it spoke
 * first, what the agent was acting on, and whether the agent went ahead anyway. A shareable receipt
 * is one of those moments told plainly. It is made here from the journal alone, so it says only
 * what the journal can prove: what was handed over, and what the agent went to do before and after.
 *
 * WHAT A RECEIPT SAYS ABOUT A COMMAND. The journal holds the start of the command an agent typed, and
 * that is never printed: a command line can carry a password in more forms than any filter knows.
 * Where Unl spoke first about a command, the receipt gives the decision's own words for it, the ones
 * the person wrote ("git add -A" from "Never `git add -A`"). They are what was crossed, and they are
 * the person's to share. For any other command it gives the program's name and nothing after it.
 *
 * Pure. Events and a way to look a decision up go in, receipts come out.
 */
const { buildReceipt, describeToolCall } = require("./index");

const HOSTS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

const flat = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
/** The command the hooks wrote down, when what they wrote is one: they put a command inside backticks and a file as its path. */
function commandIn(target) {
  const m = String(target || "").trim().match(/^`([\s\S]*)`$/);
  return m ? m[1] : null;
}

/** What the agent was acting on, as a few words: a file by its name, a command by its program. */
function describeTarget(target, tool) {
  const t = String(target || "").trim();
  if (!t) return null;
  const cmd = commandIn(t);
  if (cmd != null) return describeToolCall("Bash", { command: cmd });
  return describeToolCall(tool || "Edit", { file_path: t });
}

/**
 * What the agent was about to do at the moment Unl spoke first. For a command, the decision's own words
 * for it, when the journal shows those words are in the command the agent typed. They come from the
 * decision, never from the command.
 */
function describeCrossing(data) {
  const d = data || {};
  const cmd = commandIn(d.target);
  if (cmd == null) return describeTarget(d.target, d.tool);
  const typed = flat(cmd).toLowerCase();
  const named = (Array.isArray(d.matched) ? d.matched : []).map(flat).find((w) => w && w.length <= 80 && typed.includes(w.toLowerCase()));
  return named ? `run \`${named}\`` : describeTarget(d.target, d.tool);
}

/**
 * Every moment in a session worth a receipt, oldest first.
 *
 * A moment where Unl spoke first about a decision is always one. If it never did in the session,
 * the last decision it handed over is one, so a quiet session still leaves something to show.
 * A stop at the fence (an agent trying to keep a decision itself) names no decision and is not one.
 *
 * What the agent went to do next comes from the one `next` row the hook writes after it speaks first.
 * The agent went ahead when that row says the same call was made again, or when the same session later
 * records that it went ahead on the same decision, by that call or by another the decision also covers.
 * A different session is a different story and is never read into this one.
 *
 * @param events  journal events, in order. Each may carry the `session` it belongs to
 * @param lookup  (decision id) => { statement, why, settledOn, mine } or null
 * @param {{ paths?: "name" | "keep" }} [opts]
 */
function fromJournal(events, lookup, opts = {}) {
  const list = (events || []).filter((e) => e && e.kind);
  const out = [];
  const sameSession = (a, b) => (a.session || null) === (b.session || null);
  const make = (e, fields) => {
    const d = lookup(e.decision);
    if (!d || !d.statement) return;
    try {
      out.push(buildReceipt({ at: e.at, agent: HOSTS[e.host] || null, decision: { statement: d.statement, why: d.why || null, settledOn: d.settledOn || null, mine: d.mine === true }, ...fields }, opts));
    } catch {}
  };
  list.forEach((e, at) => {
    if (e.kind !== "spoke_first" || !e.decision || (e.data && e.data.fence)) return;
    const next = list.find((x) => x.kind === "next" && x.data && x.data.after === e.id && sameSession(x, e));
    const later = list.slice(at + 1).filter((x) => sameSession(x, e));
    const crossed = !!(next && next.data.same) || later.some((x) => x.kind === "went_ahead" && x.decision === e.decision);
    make(e, { kind: "spoke_first", about: describeCrossing(e.data), after: next && !next.data.same ? describeTarget(next.data.target, next.data.tool) : null, crossed });
  });
  if (!out.length) {
    const handed = list.filter((e) => e.kind === "handed" && e.decision);
    const last = handed[handed.length - 1];
    if (last) make(last, { kind: "handed" });
  }
  return out;
}

module.exports = { fromJournal, describeTarget, describeCrossing, HOSTS };
