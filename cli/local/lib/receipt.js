"use strict";
/*
 * The receipt: what Unl did in a session, said plainly.
 *
 * It says what was SUPPLIED, never what caused the result: "Unl gave your agent this decision", never
 * "your agent used this decision". A journal can prove what was handed over and what the agent did
 * next. It cannot prove why the agent did it, so the receipt does not claim to.
 */
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** Count what happened in a list of journal events. */
function tally(events) {
  const handed = new Set(), spoke = [], went = [], kept = [], changed = new Set();
  for (const e of events) {
    if (e.kind === "handed" && e.decision) handed.add(e.decision);
    else if (e.kind === "spoke_first") { spoke.push(e); if (e.decision) handed.add(e.decision); }
    else if (e.kind === "went_ahead") went.push(e);
    else if (e.kind === "kept") kept.push(e);
    else if (e.kind === "changed_notice" && e.decision) changed.add(e.decision);
  }
  return { handed: handed.size, spoke: spoke.length, went: went.length, kept: kept.length, changed: changed.size, spokeEvents: spoke, wentEvents: went };
}

/** One line for a session. Empty when nothing happened, because then there is nothing to say. */
function line(events) {
  const t = tally(events);
  const parts = [];
  if (t.handed) parts.push(`gave your agent ${n(t.handed, "decision", "decisions")}`);
  if (t.spoke) parts.push(`spoke first ${t.spoke === 1 ? "once" : t.spoke === 2 ? "twice" : t.spoke + " times"}`);
  if (t.kept) parts.push(`kept ${n(t.kept, "decision", "decisions")} on your yes`);
  if (t.changed) parts.push(`told your agent about ${n(t.changed, "decision that changed", "decisions that changed")}`);
  if (!parts.length) return "";
  let s = "Unl " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]) + ".";
  if (t.went) s += ` After Unl spoke, the agent went ahead ${t.went === 1 ? "once" : t.went + " times"}.`;
  return s;
}

/**
 * The one line a session, said when the next session in the project starts (hook.cjs onStart). It is
 * the session's receipt, and the note that the judge could not be asked when that happened in it.
 * Empty when there is nothing to say.
 */
function sessionLine(events, fault) {
  const said = line(events);
  const parts = [said ? said.replace(/^Unl /, "In your last session here, Unl ") : "", fault ? judgeNotice(fault, { past: !said }) : ""].filter(Boolean);
  return parts.join(" ");
}

/** Why a judgement could not be had, in a few plain words. */
const why = (fault) => {
  const d = (fault && fault.data) || {};
  if (d.reason === "timeout") return d.message || "it gave no answer in time";
  if (d.reason === "unavailable") return d.message || "its command was not found";
  return d.message || "it did not answer";
};

/**
 * Said once in a session when the person's own model could not be asked which decisions bear. It says
 * what happened and what Unl did instead, and it is not said again: a helper that is degraded should say
 * so, and should not nag.
 */
function judgeNotice(fault, { past = false } = {}) {
  return `${past ? "In your last session here, " : ""}Unl could not ask your agent's model which decisions bear (${why(fault)}), so it handed the ones the work names and the nearest others as one line each.`;
}

/** The longer form: each decision handed over, when, and at which action. For `unl receipt`. */
function detail(events, index) {
  const title = (id) => {
    const e = index && index.decisions.find((d) => d.id === id);
    const g = index && index.gone[id];
    return e ? e.title : g ? g.title : id;
  };
  const out = [];
  for (const e of events) {
    const at = String(e.at || "").slice(11, 16);
    if (e.kind === "handed") out.push(`${at}  gave your agent "${title(e.decision)}"${e.data && e.data.form === "line" ? " as one line" : ""}${e.data && e.data.on ? ` (${e.data.on})` : ""}`);
    else if (e.kind === "fault" && e.data && e.data.where === "judge") out.push(`${at}  could not ask your agent's model which decisions bear (${why(e)}), so handed the nearest ones as one line each`);
    else if (e.kind === "spoke_first") out.push(`${at}  spoke first: "${title(e.decision)}" before ${e.data && e.data.target ? e.data.target : "an action"}`);
    else if (e.kind === "went_ahead") out.push(`${at}  the agent went ahead with ${e.data && e.data.target ? e.data.target : "the action"}`);
    else if (e.kind === "kept") out.push(`${at}  kept "${title(e.decision)}" on your yes`);
    else if (e.kind === "changed_notice") out.push(`${at}  told your agent that "${title(e.decision)}" had changed`);
  }
  return out;
}

module.exports = { tally, line, sessionLine, detail, judgeNotice };
