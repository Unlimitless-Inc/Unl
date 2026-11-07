"use strict";
/*
 * The things a file cannot notice about itself.
 *
 * A rules file is text, so it cannot tell that two of its rules cannot both hold, or that a rule names
 * a file that was deleted last month, or that a rule gives no reason. A record can. Each of these is a
 * question only the person can answer, so each is raised as a flag for them and never settled here.
 *
 * Deterministic and deliberately narrow: a flag is raised only on plain evidence (the same name told
 * to be used in one rule and avoided in another; a named path that is not on disk). A check that
 * cries wolf teaches people to ignore it.
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { shortId } = require("./format");

const flagId = (kind, ...parts) => `${kind}:${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}`;

/** Tools that do one job between them, so choosing two is choosing against yourself. */
const EXCLUSIVE = [
  ["npm", "pnpm", "yarn", "bun"],
  ["jest", "vitest", "mocha"],
  ["eslint", "biome"],
  ["prettier", "biome"],
  ["pip", "poetry", "uv"],
];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const idOf = (d) => d.id;

/** Every name a decision mentions, with whether it says to avoid it. */
function mentions(d) {
  const a = d.applies_to || {};
  return [
    ...(a.commands || []).map((c) => ({ key: "cmd:" + norm(c.text), text: c.text, avoid: !!c.avoid })),
    ...(a.terms || []).map((t) => ({ key: "term:" + norm(t.text), text: t.text, avoid: !!t.avoid })),
    ...(a.paths || []).filter((p) => !p.fromFile).map((p) => ({ key: "path:" + norm(p.glob), text: p.text || p.glob, avoid: !!p.avoid })),
  ];
}

/** The tool a decision tells you to use, when it names one of a set that do the same job. */
function chosenTool(d) {
  const text = norm(`${d.statement}`);
  const out = [];
  for (const family of EXCLUSIVE) {
    for (const tool of family) {
      const use = new RegExp(`\\b(use|uses|using|with|via|run|prefer)\\s+\`?${tool}\`?\\b`).test(text);
      const not = new RegExp(`\\b(not|never|no|avoid|instead of|rather than|don't use|do not use)\\s+\`?${tool}\`?\\b`).test(text);
      if (use && !not) out.push({ family, tool });
    }
  }
  return out;
}

/** Two decisions that cannot both hold. Returns flags; never decides between them. */
function contradictions(decisions) {
  const flags = [];
  const seen = new Set();
  const add = (a, b, detail) => {
    const pair = [a.id, b.id].sort();
    // One question per pair: two rules that disagree in two ways are still one thing to settle.
    const id = flagId("contradiction", ...pair);
    if (seen.has(id)) return;
    seen.add(id);
    flags.push({ id, kind: "contradiction", decision_ids: pair, detail });
  };
  const byKey = new Map();
  for (const d of decisions) for (const m of mentions(d)) {
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push({ d, m });
  }
  for (const [, list] of byKey) {
    const avoid = list.filter((x) => x.m.avoid);
    const use = list.filter((x) => !x.m.avoid);
    for (const a of avoid) for (const u of use) {
      if (a.d.id === u.d.id) continue;
      // Naming a thing is not choosing it. Only a rule that tells you to use it stands against a rule that says avoid it.
      const says = new RegExp(`\\b(use|uses|using|run|prefer|always)\\b[^.]{0,60}${u.m.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(u.d.statement);
      if (says) add(a.d, u.d, { on: a.m.text, why: `one says to avoid \`${a.m.text}\`, the other says to use it` });
    }
  }
  const choices = decisions.flatMap((d) => chosenTool(d).map((c) => ({ d, ...c })));
  for (let i = 0; i < choices.length; i++) for (let j = i + 1; j < choices.length; j++) {
    const a = choices[i], b = choices[j];
    if (a.d.id !== b.d.id && a.family === b.family && a.tool !== b.tool) add(a.d, b.d, { on: `${a.tool} / ${b.tool}`, why: `one says ${a.tool}, the other says ${b.tool}` });
  }
  return flags;
}

/** A decision that names a file, folder or script that is not there any more. */
function deadReferences(decisions, root) {
  const flags = [];
  let scripts = null;
  try { scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts || {}; } catch {}
  for (const d of decisions) {
    const a = d.applies_to || {};
    for (const p of a.paths || []) {
      // A rule that says never to create or commit a file is not broken by the file's absence.
      if (p.fromFile || (p.avoid && /\b(create|add|commit|check in|introduce|generate)\b/i.test(d.statement))) continue;
      const raw = String(p.text || p.glob);
      if (/[*?<>{}]/.test(raw) || /^[~/]/.test(raw) || raw.startsWith("..")) continue;
      // Only a path that names a place inside the project (it has a folder in it) is checked. A bare
      // file name such as `.env` or `package.json` can live anywhere and its absence proves nothing.
      if (!raw.replace(/^\.\//, "").replace(/\/$/, "").includes("/")) continue;
      if (!fs.existsSync(path.join(root, raw))) flags.push({ id: flagId("dead_reference", d.id, raw), kind: "dead_reference", decision_ids: [d.id], detail: { path: raw, why: `it names \`${raw}\`, which is not in this project` } });
    }
    if (scripts) for (const c of a.commands || []) {
      const m = /^(?:npm|pnpm|yarn|bun) run ([\w:.-]+)/.exec(c.text);
      if (m && !c.avoid && !(m[1] in scripts) && !/^(x|y|foo|bar|example|script)$/.test(m[1])) flags.push({ id: flagId("dead_reference", d.id, c.text), kind: "dead_reference", decision_ids: [d.id], detail: { command: c.text, why: `it names the script \`${m[1]}\`, which is not in package.json` } });
    }
  }
  return flags;
}

/** A decision kept without its reason. The reason is what lets an agent get the neighbouring cases right. */
const noReason = (decisions) => decisions.filter((d) => !d.why && !(d.applies_to && d.applies_to.describes)).map((d) => ({ id: flagId("no_reason", d.id), kind: "no_reason", decision_ids: [d.id], detail: { why: "no reason was given" } }));

/** Everything worth the person's attention across the current decisions. */
function runChecks(decisions, root) {
  return [...contradictions(decisions), ...deadReferences(decisions, root), ...noReason(decisions)];
}

module.exports = { runChecks, contradictions, deadReferences, noReason, flagId, mentions, chosenTool, shortId, idOf };
