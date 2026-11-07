"use strict";
/*
 * What a folder of decision records gets wrong about itself, and the one question to ask.
 *
 * WHAT IS LOOKED FOR. Things a file cannot notice about itself and a reader can: a record that
 * still reads as in force when a later one says it replaced it; a record replaced by one that was
 * never accepted; a record that names a successor which is not there; two records that each say the
 * other replaced it; a record in force that names a path the repository no longer has.
 *
 * WHY ONLY ONE QUESTION IS ASKED. Each of these needs the person, because only they know which
 * record stands. A list of ten questions in the first minute is a form, and nobody fills in a form
 * to try a tool. So the checks are ranked by how much damage the wrong answer does, the top one is
 * asked, and the rest are kept and can be listed. If nothing is wrong, nothing is said.
 *
 * WHAT IT NEVER DOES. It does not decide which record stands, and it does not call two records
 * contradictory because their words differ. It reports what the records say about each other and
 * what the repository holds.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { plain } = require("./parse");
const { localPath, titleKey } = require("./chain");

/** The order questions are asked in. The first is the one where a wrong guess serves a replaced decision. */
const ASK_ORDER = ["reads_in_force_but_replaced", "each_replaced_the_other", "partly_replaced", "replaced_by_unsettled", "successor_missing", "replaced_by_nothing_named", "same_role_two_choices", "path_gone"];

const STATE_WORD = { accepted: "accepted", proposed: "proposed", draft: "a draft", rejected: "rejected", deprecated: "deprecated", superseded: "replaced", partly_superseded: "partly replaced", unknown: "in force" };

/** How a record is named to a person: its number and its title, or its title alone. */
function nameOf(r) {
  const num = r.number != null ? String(r.number).padStart(4, "0") : null;
  const title = r.title || path.posix.basename(r.file);
  return num ? `${num} "${title}"` : `"${title}"`;
}

/** A record's status as it wrote it, short enough to quote. */
function statusWords(r) {
  const raw = String(r.status.raw || "").split(/(?<=[.!?])\s/)[0].trim();
  // A status kept as a table has no words worth quoting, so the state it comes to is named.
  if (!raw || raw.startsWith("|")) return STATE_WORD[r.status.state] || r.status.state;
  return `"${raw.length > 60 ? raw.slice(0, 57).replace(/\s+\S*$/, "") + " ..." : raw}"`;
}

const flagId = (kind, files) => crypto.createHash("sha256").update(`${kind}\u0000${[...files].sort().join("\u0000")}`).digest("hex").slice(0, 16);

/** Paths a record names in code spans, kept only when they look like a file or folder of this repository. */
function pathsNamed(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/`([^`\n]{3,160})`/g)) {
    let p = m[1].trim().replace(/[.,;:]+$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
    if (!/^[\w.@+-]+(?:\/[\w.@+-]+)+\/?$/.test(p)) continue;
    if (p.startsWith("@") || /^(?:https?|www)\b/i.test(p)) continue;
    const last = p.replace(/\/$/, "").split("/").pop();
    if (!p.endsWith("/") && !/\.[A-Za-z0-9]{1,8}$/.test(last)) continue;
    out.add(p);
  }
  return [...out];
}

/** "Use X as Y": the choice and the role it fills. Null for a title in any other shape. */
function roleChoice(title) {
  const m = plain(title).match(/^(?:use|using|adopt|adopting|choose|choosing|select|selecting|pick|standardi[sz]e\s+on)\s+(.+?)\s+as\s+(?:the\s+|our\s+|a\s+|an\s+)?(.+)$/i);
  if (!m) return null;
  return { choice: titleKey(m[1]), role: titleKey(m[2]) };
}

/**
 * Every flag for the linked records.
 *
 * @param records  records already linked by linkRecords
 * @param {{ root?: string, exists?: (rel: string) => boolean, settled?: string[] }} [opts]
 *        `exists` answers whether a repository path is there (defaults to the file system under root).
 *        `settled` lists flag ids the person has already answered, which are not raised again.
 * @returns flags, each { id, kind, ask, files, says, question, options }
 */
function findFlags(records, opts = {}) {
  const root = opts.root || null;
  const exists = opts.exists || ((rel) => (root ? fs.existsSync(path.join(root, rel)) : true));
  const settled = new Set(opts.settled || []);
  const flags = [];
  const add = (kind, recs, f) => {
    const files = recs.map((r) => r.file);
    const id = flagId(kind, [...files, f.key || ""]);
    if (settled.has(id) || flags.some((x) => x.id === id)) return;
    flags.push({ id, kind, ask: ASK_ORDER.includes(kind), files, says: f.says, question: f.question || null, options: f.options || null });
  };

  for (const r of records) {
    // A later record says it replaced this one, and this one does not say so itself.
    if (r.lifecycle === "to_settle" && !r.partlyReplaced) {
      for (const t of r.replacedBy.filter((x) => !x.saidBy.includes("older"))) {
        const reads = r.has.status ? `still reads ${STATE_WORD[r.status.state] || r.status.state}` : "does not say it was replaced";
        add("reads_in_force_but_replaced", [r, t.record], {
          says: `${nameOf(t.record)} says it replaces ${nameOf(r)}, but ${nameOf(r)} ${reads}.`,
          question: `${nameOf(t.record)} says it replaces ${nameOf(r)}, but ${nameOf(r)} ${reads}. Which stands?`,
          options: [`${nameOf(t.record)} stands and ${nameOf(r)} is replaced`, "Both stand", `${nameOf(r)} stands`],
        });
      }
    }
    // The record says it was replaced in part, so some of it still stands.
    if (r.partlyReplaced) {
      const by = r.replacedBy.filter((t) => t.partial || r.status.state === "partly_superseded").map((t) => nameOf(t.record));
      const tail = by.length ? ` by ${by.join(" and ")}` : "";
      const own = r.status.state === "partly_superseded";
      add("partly_replaced", [r, ...r.replacedBy.map((t) => t.record)], {
        says: own ? `${nameOf(r)} says it was partly replaced${tail}.` : `${by.join(" and ")} ${by.length === 1 ? "says it replaces" : "say they replace"} part of ${nameOf(r)}.`,
        question: own ? `${nameOf(r)} says it was partly replaced${tail}. Which part of it still stands?` : `${by.join(" and ")} ${by.length === 1 ? "says it replaces" : "say they replace"} part of ${nameOf(r)}. Which part of ${nameOf(r)} still stands?`,
      });
    }
    // Two records that each say the other replaced it.
    for (const t of r.replacedBy) {
      if (t.record.replacedBy.some((b) => b.record === r) && r.file < t.record.file) {
        add("each_replaced_the_other", [r, t.record], {
          says: `${nameOf(r)} and ${nameOf(t.record)} each say the other replaced it.`,
          question: `${nameOf(r)} and ${nameOf(t.record)} each say the other replaced it. Which stands?`,
          options: [`${nameOf(r)} stands`, `${nameOf(t.record)} stands`, "Neither stands"],
        });
      }
    }
    // This record says it was replaced by one that was never accepted.
    if (r.lifecycle === "replaced") {
      for (const t of r.replacedBy.filter((x) => x.saidBy.includes("older"))) {
        if (["proposed", "draft", "rejected", "deprecated"].includes(t.record.status.state)) {
          const reads = statusWords(t.record);
          add("replaced_by_unsettled", [r, t.record], {
            says: `${nameOf(r)} says it was replaced by ${nameOf(t.record)}, whose status reads ${reads}.`,
            question: `${nameOf(r)} says it was replaced by ${nameOf(t.record)}, but the status of ${nameOf(t.record)} reads ${reads}. Is ${nameOf(r)} still in force?`,
            options: [`Yes, ${nameOf(r)} is still in force`, "No, neither is in force", `${nameOf(t.record)} is in force and its status is out of date`],
          });
        }
      }
      // It names a successor that is not in the folder, or names none at all.
      const named = r.relations.filter((x) => x.rel === "superseded_by");
      const missing = named.filter((x) => x.dead && !x.found);
      if (!r.replacedBy.length && missing.length) {
        const t = missing[0].target;
        const what = t && (t.text || t.href) ? (t.named ? `"${t.text}"` : t.text || t.href) : "another record";
        add("successor_missing", [r], {
          key: what,
          says: `${nameOf(r)} says it was replaced by ${what}, and Unl found no such record in ${r.folder}.`,
          question: `${nameOf(r)} says it was replaced by ${what}, and Unl found no such record in ${r.folder}. What replaced it?`,
        });
      } else if (!r.replacedBy.length && !named.some((x) => x.external)) {
        add("replaced_by_nothing_named", [r], {
          says: `${nameOf(r)} says it was replaced and does not name what replaced it.`,
          question: `${nameOf(r)} says it was replaced and does not name what replaced it. What replaced it?`,
        });
      }
    }
    // Any other tie that points at a record which is not there.
    for (const x of r.relations) {
      if (x.dead && !x.found && x.rel !== "superseded_by") {
        const what = x.target && (x.target.text || x.target.href) ? x.target.text || x.target.href : "another record";
        add("reference_gone", [r], { key: `${x.rel}|${what}`, says: `${nameOf(r)} points at ${what}, which is not in ${r.folder}${x.ambiguous ? " under one number alone" : ""}.` });
      }
    }
    if (r.titleNumber != null && r.number != null && r.titleNumber !== r.number) {
      add("number_differs", [r], { says: `${path.posix.basename(r.file)} is numbered ${r.number} by its file name and ${r.titleNumber} by its title.` });
    }
  }

  // Two or more records under one number make every reference by number ambiguous.
  const byNumber = new Map();
  for (const r of records) {
    if (r.number == null) continue;
    const k = `${r.folder}|${r.number}`;
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k).push(r);
  }
  for (const group of byNumber.values()) {
    if (group.length > 1) add("same_number", group, { says: `${group.length} records in ${group[0].folder} are numbered ${group[0].number}. They are ${group.map((r) => `"${r.title}"`).join(" and ")}.` });
  }

  const current = records.filter((r) => r.lifecycle === "current");

  // Two records in force that fill the same role with different choices.
  const roles = new Map();
  for (const r of current) {
    const rc = roleChoice(r.title);
    if (!rc || !rc.role || !rc.choice) continue;
    const k = `${r.folder}|${rc.role}`;
    if (!roles.has(k)) roles.set(k, []);
    roles.get(k).push({ r, choice: rc.choice });
  }
  for (const group of roles.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].choice === group[j].choice) continue;
        add("same_role_two_choices", [group[i].r, group[j].r], {
          says: `${nameOf(group[i].r)} and ${nameOf(group[j].r)} both read as in force and choose differently for the same thing.`,
          question: `${nameOf(group[i].r)} and ${nameOf(group[j].r)} both read as in force and choose differently for the same thing. Do both stand?`,
          options: ["Both stand", `Only ${nameOf(group[i].r)} stands`, `Only ${nameOf(group[j].r)} stands`],
        });
      }
    }
  }

  // A record in force that names a path the repository no longer has.
  if (root || opts.exists) {
    for (const r of current) {
      const gone = [];
      for (const p of pathsNamed(`${r.text.decision}\n${r.text.context}\n${r.text.consequences}`)) {
        const top = p.split("/")[0];
        if (!exists(top)) continue; // not a path of this repository, so its absence says nothing
        if (!exists(p.replace(/\/$/, ""))) gone.push(p);
      }
      r.pathsGone = gone.slice(0, 3);
      if (gone.length) {
        add("path_gone", [r], {
          key: gone[0],
          says: `${nameOf(r)} names ${gone.slice(0, 3).map((p) => `\`${p}\``).join(", ")}, which ${gone.length === 1 ? "is" : "are"} no longer in this repository.`,
          question: `${nameOf(r)} names \`${gone[0]}\`, which is no longer in this repository. Is ${nameOf(r)} still in force?`,
          options: ["Yes, it is still in force", "No, it no longer applies"],
        });
      }
    }
  }

  // Links out of a record to files of this repository that are not there.
  if (root || opts.exists) {
    for (const r of records) {
      const dead = [];
      const body = `${r.text.decision}\n${r.text.context}\n${r.text.consequences}`;
      for (const m of body.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
        const loc = localPath(m[1], r.file);
        if (!loc || loc.external || !loc.path || loc.path.startsWith("..")) continue;
        if (!exists(loc.path) && !exists(loc.path.replace(/\.html?$/i, ".md"))) dead.push(m[1]);
      }
      if (dead.length) add("link_gone", [r], { key: dead[0], says: `${nameOf(r)} links to ${dead.slice(0, 3).join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in this repository.` });
    }
  }

  return flags;
}

/** The one question to ask: the highest-ranked flag that needs the person. Null when nothing does. */
function pickQuestion(flags) {
  for (const kind of ASK_ORDER) {
    const hit = flags.find((f) => f.kind === kind && f.question);
    if (hit) return hit;
  }
  return null;
}

module.exports = { findFlags, pickQuestion, nameOf, pathsNamed, roleChoice, ASK_ORDER };
