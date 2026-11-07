"use strict";
/*
 * The view: what the record looks like in the repository.
 *
 * Two things are written, both from the record and never by hand:
 *   .unl/decisions/<name>.md   one readable file per decision, with its reason, date and what it
 *                              replaced, and the full record in a comment so another machine can read
 *                              it back and check it has not been altered.
 *   AGENTS.md, CLAUDE.md       one section, between Unl's own markers, listing the current decisions
 *                              with their reasons and marking the ones that were replaced. Every tool
 *                              that reads a rules file gets them with nothing to connect.
 *
 * Unl writes ONLY between its markers and only its own files. Whatever a person or another tool wrote
 * in a rules file is left exactly as it was.
 */
const fs = require("fs");
const path = require("path");
const { readDecision, shortId } = require("./format");
const { squash } = require("./text");
const { view: viewPaths } = require("./paths");

const BEGIN = "<!-- unl:begin";
const END = "<!-- unl:end -->";
const BEGIN_LINE = `${BEGIN} This section is written by Unl from the decisions kept for this project. Change a decision through your agent or the unl command and this section follows. -->`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_LISTED = 80;
const MAX_REPLACED = 10;

/** A date as a person reads it: 6 Nov 2026. */
function day(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const ends = (s) => (/[.!?]$/.test(s) ? s : s + ".");
/** A reason as a sentence for display: capital first, full stop last. What is stored stays as the person wrote it. */
const asSentence = (s) => ends(String(s).charAt(0).toUpperCase() + String(s).slice(1));
const sameText = (a, b) => squash(a).toLowerCase().replace(/[.`*_]+/g, "") === squash(b).toLowerCase().replace(/[.`*_]+/g, "");

/** A decision as one bold lead and the rest. Where the title is how the statement begins, it is not said twice. */
function lead(d) {
  if (sameText(d.title, d.statement)) return `**${ends(d.statement)}**`;
  const plain = (x) => squash(x).toLowerCase().replace(/[`*_]+/g, "");
  const first = d.statement.split(/(?<=[.!?])\s+/)[0];
  const rest = d.statement.slice(first.length).trim();
  const t = plain(d.title).replace(/[.!?]+$/, "").replace(/\.\.\.$/, "");
  // The title is the first sentence, or the first sentence shortened or without its opening words: say the sentence once.
  if (plain(first).replace(/[.!?]+$/, "") === t || plain(first).includes(t)) return `**${ends(first)}**${rest ? " " + ends(rest) : ""}`;
  return `**${ends(d.title)}** ${ends(d.statement)}`;
}

function appliesLine(d) {
  const a = d.applies_to || {};
  const names = [...(a.paths || []).map((p) => p.glob), ...(a.commands || []).map((c) => c.text), ...(a.terms || []).map((t) => t.text)];
  return [...new Set(names)].slice(0, 12).map((n) => "`" + n + "`").join(", ");
}

/** One decision as its own readable file. */
function decisionFile(d, byId) {
  const lines = [`# ${d.title}`, ""];
  if (!sameText(d.title, d.statement)) lines.push(d.statement, "");
  lines.push(d.why ? `**Why.** ${asSentence(d.why)}` : "_No reason has been given yet._", "");
  const applies = appliesLine(d);
  if (applies) lines.push(`**Applies to.** ${applies}`, "");
  const src = d.source || {};
  const from = src.file ? `, read from ${src.file}${src.author && src.written ? ` (written ${day(src.written)} by ${src.author})` : ""}` : "";
  lines.push(`**Kept** ${day(d.ratified_at)} by ${d.ratified_by}${from}.${src.yes ? ` The yes was given ${src.yes}.` : ""}`);
  for (const rid of (d.record.provenance.wasRevisionOfAll || [])) {
    const old = byId.rulings.get(rid);
    lines.push(`**Replaces** ${old ? `"${old.title}" (kept ${day(old.ratified_at)})` : rid}.`);
  }
  if (d.status === "superseded") {
    const by = d.replaced_by ? byId.ids.get(d.replaced_by) : null;
    lines.push(by ? `**Replaced** ${day(d.replaced_at)} by "${by.title}".` : `**No longer applies** since ${day(d.replaced_at)}${d.retired_why ? `. ${ends(d.retired_why)}` : "."}`);
  }
  const payload = { record: d.record, applies_to: d.applies_to || {}, source: d.source || null, settled_on: d.settled_on || null, replaced_at: d.replaced_at || null, retired_why: d.retired_why || null };
  // "--" cannot appear inside an HTML comment, so it is written escaped and read back unescaped.
  lines.push("", "<!-- unl:record", JSON.stringify(payload).replace(/--/g, "-\\u002d"), "-->", "");
  return lines.join("\n");
}

/** Read a decision file back: the record it carries, or null when it carries none. Never trusts it without recomputing its address. */
function readDecisionFile(text) {
  const m = /<!-- unl:record\s*\n([\s\S]*?)\n-->/.exec(String(text || ""));
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); } catch { return { error: "the record in this file is not valid JSON" }; }
  const check = readDecision(payload.record);
  if (!check.ok) return { error: check.errors[0] };
  return payload;
}

/** The section's text for one rules file. `outside` is that file's text apart from Unl's section, so a rule already written there is not listed twice. */
function section(decisions, outside = "") {
  const ids = new Map(decisions.map((d) => [d.id, d]));
  const current = decisions.filter((d) => d.status === "canonical");
  const gone = decisions.filter((d) => d.status === "superseded").sort((a, b) => String(b.replaced_at).localeCompare(String(a.replaced_at)));
  const flatOutside = squash(outside).toLowerCase();
  // Compared without the closing full stop: where the reason was split off, the file has a comma there.
  const written = (d) => flatOutside.includes(squash(d.statement).toLowerCase().replace(/[.!?]+$/, "").slice(0, 80));
  const listed = current.filter((d) => !written(d));
  const already = current.length - listed.length;
  const out = [BEGIN_LINE, "## Decisions", ""];
  out.push("These are the decisions kept for this project, each with its reason. Work from them. If you are about to go against one, stop and say so first.", "");
  if (already) out.push(`${already} ${already === 1 ? "decision is" : "decisions are"} written out above in this file and kept by Unl as ${already === 1 ? "it stands" : "they stand"}.`, "");
  // What says what to do comes first. What only says what the project is or where something lives is
  // kept too, and listed apart, so nobody reads a description as a rule.
  const about = (d) => !!(d.applies_to && d.applies_to.describes);
  const shown = listed.slice(0, MAX_LISTED);
  for (const d of shown.filter((d) => !about(d))) {
    const head = lead(d);
    out.push(`- ${head}${d.why ? ` Why: ${asSentence(d.why)}` : ""} _(kept ${day(d.ratified_at)})_`);
  }
  if (shown.some(about)) {
    out.push("", "### About the project", "");
    for (const d of shown.filter(about)) out.push(`- ${lead(d)} _(kept ${day(d.ratified_at)})_`);
  }
  if (listed.length > MAX_LISTED) out.push("", `${listed.length - MAX_LISTED} more are in .unl/decisions/.`);
  if (gone.length) {
    out.push("", "### Replaced", "");
    for (const d of gone.slice(0, MAX_REPLACED)) {
      const by = d.replaced_by ? ids.get(d.replaced_by) : null;
      const stale = written(d) ? " The line above in this file still says the old thing." : "";
      out.push(`- ~~${ends(d.statement)}~~ ${by ? `Replaced ${day(d.replaced_at)} by "${by.title}".` : `No longer applies since ${day(d.replaced_at)}.`}${stale}`);
    }
  }
  out.push("", END);
  return out.join("\n");
}

/** A rules file's text with Unl's section removed. */
function withoutSection(text) {
  const s = String(text || "");
  const a = s.indexOf(BEGIN);
  if (a < 0) return s;
  const b = s.indexOf(END, a);
  return b < 0 ? s.slice(0, a) : s.slice(0, a) + s.slice(b + END.length);
}

/** Put the section into a rules file's text: in place when it is already there, at the end when it is not. Nothing else moves. */
function placeSection(text, sectionText) {
  const s = String(text || "");
  const a = s.indexOf(BEGIN);
  if (a >= 0) {
    const b = s.indexOf(END, a);
    return s.slice(0, a) + sectionText + (b < 0 ? "\n" : s.slice(b + END.length));
  }
  if (!s.trim()) return sectionText + "\n";
  return s.replace(/\s*$/, "") + "\n\n" + sectionText + "\n";
}

function writeIfChanged(file, text) {
  let before = null;
  try { before = fs.readFileSync(file, "utf8"); } catch {}
  if (before === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/**
 * Write the whole view for a working tree. `files` are the rules files to keep current (paths inside
 * the project). Returns what changed, by name, so the caller can say it.
 */
function writeView(root, decisions, { files = ["AGENTS.md"] } = {}) {
  const v = viewPaths(root);
  const byId = { ids: new Map(decisions.map((d) => [d.id, d])), rulings: new Map(decisions.map((d) => [d.ruling_id, d])) };
  const changed = [];
  const keepNames = new Set();
  for (const d of decisions) {
    const name = `${d.ruling_id}.md`;
    keepNames.add(name);
    if (writeIfChanged(path.join(v.decisions, name), decisionFile(d, byId))) changed.push(path.join(".unl", "decisions", name));
  }
  if (writeIfChanged(path.join(v.dir, ".gitignore"), "# Unl keeps its working files here. The decisions folder is the part meant for git.\nlocal/\n")) changed.push(path.join(".unl", ".gitignore"));
  if (writeIfChanged(path.join(v.dir, "README.md"), VIEW_README)) changed.push(path.join(".unl", "README.md"));
  for (const rel of files) {
    const file = path.join(root, rel);
    let before = "";
    try { before = fs.readFileSync(file, "utf8"); } catch {}
    const next = placeSection(before, section(decisions, withoutSection(before)));
    if (writeIfChanged(file, next)) changed.push(rel);
  }
  return changed;
}

/** Every decision file in the working tree, read back. Used to take in decisions that arrived through git. */
function readView(root) {
  const dir = viewPaths(root).decisions;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return []; }
  return names.map((name) => {
    const payload = readDecisionFile(fs.readFileSync(path.join(dir, name), "utf8"));
    return { name, ...(payload || { error: "no record in this file" }) };
  });
}

const VIEW_README = `# .unl

This folder is written by Unl, the record of what was decided for this project and why.

\`decisions/\` holds one file per decision. Each says what was decided, the reason, who decided and when,
and what it replaced. They are written from a local database and are safe to commit. A teammate who runs
\`npx unlimitless init\` gets the same decisions from these files.

Do not edit these files by hand. Change a decision by telling your agent, or with the \`unl\` command, and
the files follow.
`;

module.exports = { writeView, readView, section, placeSection, withoutSection, decisionFile, readDecisionFile, day, BEGIN, END, shortId };
