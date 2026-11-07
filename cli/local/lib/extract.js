"use strict";
/*
 * Reading what a person already wrote down.
 *
 * A rules file (CLAUDE.md, AGENTS.md, Cursor rules and the like) is a list of decisions somebody made
 * and wrote for their agents. This turns each rule into a possible decision: the rule in the person's
 * own words, the reason if they gave one, the heading it sits under, and the things it names (files,
 * commands, package names) so Unl can tell later when an agent is about to touch one of them.
 *
 * Deterministic on purpose. There is no model here and nothing leaves the machine. Three rules it
 * holds itself to:
 *   1. Never drop the person's words. The statement is the whole rule; only a clause that is plainly
 *      the reason ("because ...", "Why: ...") moves into the reason.
 *   2. Never invent a reason. A rule with none is kept with none and marked, so the person can add it.
 *   3. Read what it finds as a proposal. Nothing read here is a decision until the person says yes.
 */
const { squash, slug } = require("./text");

const RULES_FILE = /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)\.cursorrules$|(^|\/)\.windsurfrules$|(^|\/)\.cursor\/rules\/|(^|\/)copilot-instructions\.md$|(^|\/)\.claude\/rules\//i;

const STRONG = /\b(never|always|must|mustn't|do not|don't|should not|shouldn't|avoid|prefer|forbidden|banned|not allowed|may not|instead of|rather than|no longer|make sure|ensure that|by default)\b|\bwe (use|don't|do not|never|always|prefer|avoid|keep|write|run|ship|deploy|test|name)\b/i;
const SOFT = /\b(should|only|required|requires|need to|needs to|have to|cannot|can't|use|keep|belongs? in|goes? in|go in)\b/i;
// A heading that says the lines under it are rules, and one that says they describe the project.
const RULES_HEADING = /\b(rules?|conventions?|guidelines?|standards?|style|principles?|decisions?|practices?|polic(y|ies)|requirements?|constraints?|invariants?|do'?s|don'?ts?|never|always|must|important|critical|gotchas?|pitfalls?|caveats?|warnings?|workflow|checklist|testing|commits?|pull requests?|review|security|error handling|naming|formatting|lint(ing)?|code quality)\b/i;
const DESCRIBES_HEADING = /\b(overview|about|introduction|structure|layout|architecture|director(y|ies)|tree|map|stack|tech(nolog(y|ies))?|dependenc(y|ies)|components?|modules?|packages?|files?|entry points?|commands?|scripts?|setup|install(ation)?|getting started|usage|quick ?start|environment|configuration|features?|endpoints?|resources|links|references?|glossary|status|roadmap|changelog|what is|project)\b/i;
// "**Name**: what it is", "`path/` (Go): what it holds", "Config guide: `docs/x.md`": a label and its description.
const LABELLED = /^(\*\*[^*]{1,70}\*\*:?|`[^`]{1,80}`|[A-Z][\w /&+.-]{1,40})\s*(\([^)]{0,60}\))?\s*(:|—|–| - )\s*\S/;
// Verbs that say what something is or where it is, as against what to do.
const DESCRIBES = /\b(is located|are located|located in|lives? (in|under|at)|contains?|holds?|represents?|implements?|provides?|is organi[sz]ed|are organi[sz]ed|uses? an? [\w.-]+ (structure|architecture|layout)|is built (with|on)|is written in|consists? of|includes?|handles?|is responsible for|serves? as)\b/i;
// "Handlers live in `src/handlers/` and stay thin": it says where something lives AND what to keep true of
// it. The second half is the decision, so a line like that is not a description.
const NORMATIVE_TAIL = /\b(and|but|so) (stays?|remains?|keeps?|is kept|are kept|must|should|never|always|only|nothing else)\b/i;

/** What the headings above a line say it is, nearest heading first: "rules", "describes", or null when none says. */
function headingSays(headings) {
  const list = Array.isArray(headings) ? headings : String(headings || "").split(" / ");
  for (let i = list.length - 1; i >= 0; i--) {
    const h = String(list[i] || "");
    const r = lastMatch(RULES_HEADING, h), d = lastMatch(DESCRIBES_HEADING, h);
    if (r < 0 && d < 0) continue;
    // Both: the later word is the head of the phrase. "Project rules" is rules; "Rules of the project layout" is rare.
    return r > d ? "rules" : "describes";
  }
  return null;
}
function lastMatch(re, text) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let at = -1, m;
  while ((m = g.exec(text))) { at = m.index; if (m[0] === "") g.lastIndex++; }
  return at;
}
// Verbs an instruction opens with. A list and not a grammar: it only has to tell "Regenerate the types
// after changing the schema" (an instruction) from "The schema lives in config/" (a description).
const IMPERATIVE = new Set(("use run rerun add keep write put make prefer avoid name commit branch verify check test read follow treat pass stage claim file ask call wrap handle return throw log import export format lint document update delete remove create set store start stop push pull merge rebase tag release deploy build rebuild install apply validate sanitize escape quote split group sort place move rename leave skip report surface confirm diagnose never always do don't " +
  "regenerate generate bump ensure open close invoke catch extract drop define declare register configure reset enable disable uninstall publish squash fetch clone review comment annotate fix refactor simplify order save load cache mock stub assert expect cover include exclude respect consider remember wait retry limit cap pin lock unlock sync copy link mirror migrate seed backfill query filter map parse serialize encode decode trim prefix suffix version guard protect restrict allow deny grant revoke rotate sign encrypt hash default raise emit subscribe listen send receive respond reply flag mark track measure monitor alert notify profile optimize benchmark batch chunk stream paginate index search compare inspect debug trace print show display render style reuse share isolate scope organize structure colocate centralize inline schedule queue spawn clean clear prune archive restore revert reproduce triage reopen assign label mention cite describe explain justify state list number capitalize indent align break join " +
  "implement initialize init instantiate inject expose hide wire connect disconnect mount unmount bind unbind attach detach compose derive compute calculate convert cast coerce normalize dedupe deduplicate flatten wrap unwrap await yield defer throttle debounce memoize lazy-load preload prefetch hydrate persist flush reload refresh revalidate invalidate expire bail abort cancel fail succeed exit propagate bubble rethrow swallow ignore suppress silence warn deprecate remove replace substitute swap switch toggle choose pick select reject accept require forbid ban disallow permit enforce honor honour obey adhere stick match mirror model mimic copy duplicate fork extend inherit override overload implement subclass compose delegate proxy forward route dispatch redirect rewrite upgrade downgrade bisect squash amend sign-off cherry-pick stash tag").split(/\s+/));
const KNOWN_BINS = new Set(("git npm npx pnpm yarn bun node deno python python3 pip pip3 uv poetry cargo rustc go make cmake docker kubectl helm terraform railway vercel netlify gh curl wget rm mv cp chmod chown sudo psql mysql sqlite3 redis-cli drizzle drizzle-kit prisma jest vitest mocha pytest tox eslint prettier tsc ts-node tsx webpack vite rollup turbo nx lerna brew apt apt-get dnf yum pacman bash sh zsh source export printenv env cat sed awk grep find xargs ssh scp rsync aws gcloud az flyctl fly supabase firebase wrangler ruff black mypy flake8 bundle rake rails gem php composer dotnet mvn gradle java swift xcodebuild pod flutter dart").split(/\s+/));
const NEGATION = /\b(never|not|don't|do not|doesn't|no|avoid|without|instead of|rather than|banned|forbidden|deprecated|stop|nor)\b/i;
const WHY_MARK = /(\*\*|__)?\b(why|reason|rationale|because)\b\s*(\*\*|__)?\s*[:\-—]\s*(\*\*|__)?/i;
const WHY_JOIN = /\s+(because|so that|since it|since the|since we|since a|since an|as it|otherwise)\b/i;

const stripMd = (s) => String(s || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** Split a markdown document into units (list items with their continuation lines, and paragraphs), each with its heading and lines. */
function units(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let heading = [];
  let cur = null;
  let fence = null;
  let inUnl = false;
  let i = 0;
  // Front matter is settings for the tool that owns the file, never a rule.
  if (/^---\s*$/.test(lines[0] || "")) {
    const end = lines.findIndex((l, n) => n > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  const flush = () => { if (cur && squash(cur.text).length) out.push(cur); cur = null; };
  for (; i < lines.length; i++) {
    const line = lines[i];
    // Unl's own section is written from the record. Reading it back in would be Unl quoting itself.
    if (/<!--\s*unl:begin/.test(line)) { flush(); inUnl = true; continue; }
    if (/<!--\s*unl:end/.test(line)) { inUnl = false; continue; }
    if (inUnl) continue;
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) { if (!fence) { flush(); fence = f[1][0]; } else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    if (/^\s*<!--.*-->\s*$/.test(line) || /^\s*\|.*\|\s*$/.test(line) || /^\s*!\[/.test(line)) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); heading = heading.slice(0, h[1].length - 1); heading[h[1].length - 1] = stripMd(h[2]); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); continue; }
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (b) {
      const indent = b[1].replace(/\t/g, "  ").length;
      // A nested bullet belongs to the rule above it: it is usually the reason or the detail.
      if (cur && cur.kind === "item" && indent > cur.indent) { cur.text += "\n" + b[2]; cur.end = i + 1; cur.children.push(b[2]); continue; }
      flush();
      cur = { kind: "item", indent, text: b[2], start: i + 1, end: i + 1, heading: heading.filter(Boolean), children: [] };
      continue;
    }
    if (!line.trim()) { if (cur && cur.kind === "para") flush(); else if (cur) cur.blank = true; continue; }
    if (cur && cur.kind === "item" && (/^\s{2,}\S/.test(line) || !cur.blank)) { cur.text += " " + line.trim(); cur.end = i + 1; continue; }
    if (cur && cur.kind === "para") { cur.text += " " + line.trim(); cur.end = i + 1; continue; }
    flush();
    cur = { kind: "para", indent: 0, text: line.trim(), start: i + 1, end: i + 1, heading: heading.filter(Boolean), children: [] };
  }
  flush();
  return out;
}

/**
 * Is this unit a rule (something decided), as against a description, a step or a note?
 *
 * A rules file holds two kinds of line: what to do ("never edit the generated schema by hand") and what
 * the project is ("`cli/` (Go): the command line; commands in `cli/cmd/`"). Only the first is a
 * decision. Keeping the second as one is not harmless: it names a path, so it is handed to the agent
 * whenever a file there is touched, and it never bears. Measured on 20 real repositories, lines like that
 * were most of what was wrongly handed before a file.
 *
 * So a line is a rule when it says so in its own words (never, always, must, do not, use, keep, an
 * instruction that opens with a verb). A plain statement with none of those is a rule only under a
 * heading that says its lines are rules ("Conventions", "Code style"), and never when it is a label and
 * its description or says where something lives. Outside a rules file only the plainest rule language
 * counts, so a README's install steps are not read as decisions.
 */
function isRule(text, { rulesFile, kind = "item", heading = "" }) {
  const t = stripMd(text).trim();
  if (t.length < 12 || t.length > 1600) return false;
  if (/^(see|note|todo|tip|example|e\.g\.|i\.e\.)\b/i.test(t) && !STRONG.test(t)) return false;
  if (/^https?:\/\/\S+$/.test(t) || /^\[[^\]]+\]\([^)]+\)$/.test(text.trim())) return false; // a bare link
  const strong = STRONG.test(t);
  // A label and its description is not a rule unless what follows the label is itself rule language.
  const flat = text.trim().replace(/\n/g, " ");
  if (LABELLED.test(flat) && !strong) {
    const rest = stripMd(flat.replace(LABELLED, (m) => m.slice(-1))).trim();
    const firstRest = (rest.replace(/^`/, "").match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
    // "**Scaffold**: `mkdir packages/<name>` ...", "**Configuration schema**: update `config/schema.yaml`": a label and then an instruction.
    const restOrders = IMPERATIVE.has(firstRest) || KNOWN_BINS.has(firstRest) || firstRest === "mkdir";
    if (!restOrders && !SOFT.test(rest)) return false;
    if (restOrders && rulesFile && !DESCRIBES.test(rest)) return true;
  }
  if (strong) return true;
  if (!rulesFile) return false;
  const first = (t.match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
  const describes = DESCRIBES.test(t) && !NORMATIVE_TAIL.test(t);
  if (IMPERATIVE.has(first) && !describes) return true;
  if (SOFT.test(t) && !describes) return true;
  if (kind !== "item" || describes) return false;
  // A plain statement: the nearest heading that says anything says what it is.
  return headingSays(heading) === "rules";
}

/**
 * A line of a rules file that states no rule: what the project is, where something lives, what a folder
 * holds. It is kept all the same, and marked as describing.
 *
 * WHY IT IS KEPT. The person wrote it down for their agents, and it bears on real work more often than its
 * form suggests. Measured on 800 pieces of work in 20 public repositories: when the first minute kept
 * rules only, 105 of the 358 decisions that bore on the work had never been kept at all, and the two
 * labellers sorted 36 of those as description and 40 as plain decisions this test had read wrongly. A
 * line that was never kept can be handed by nothing that comes after.
 *
 * WHY IT IS MARKED. A line that names a folder would arrive on every edit under it if the place alone
 * could hand it, and it almost never bears there (measured: most of what was wrongly handed before a
 * file). So the words and the place never hand a line marked this way. Only a judge that has read the
 * work does, and no reason is asked for it.
 *
 * What is kept is what a rules file is made of: its list items, and the plain statements that say what
 * to do or where something goes. Asides (a note, an example, a bare link) are not.
 */
function isLine(text, kind) {
  const t = stripMd(text).trim();
  if (t.length < 12 || t.length > 1600) return false;
  if (/^(see|note|todo|tip|example|e\.g\.|i\.e\.)\b/i.test(t)) return false;
  if (/^https?:\/\/\S+$/.test(t) || /^\[[^\]]+\]\([^)]+\)$/.test(text.trim())) return false;
  if (kind === "item") return true;
  const first = (t.match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
  return IMPERATIVE.has(first) || SOFT.test(t) || /\b(lives?|belongs?|goes?) (in|under|at)\b/i.test(t);
}

/** Sentences of a rule, in order, with nothing dropped. A full stop inside backticks or a file name does not end one. */
function sentences(flat) {
  const out = [];
  let cur = "";
  let tick = false;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    cur += c;
    if (c === "`") tick = !tick;
    if (!tick && /[.!?]/.test(c) && (i + 1 >= flat.length || (flat[i + 1] === " " && /[A-Z"'`*(\[]/.test(flat[i + 2] || "")))) {
      // "e.g." and "i.e." are not sentence ends.
      if (/\b(e\.g|i\.e|etc|vs)\.$/i.test(cur)) continue;
      out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Does this sentence tell someone what to do (as against explaining)? */
function isDirective(sentence) {
  const t = stripMd(sentence).replace(/^[`"'(\[]+/, "").trim();
  const first = (t.match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
  return IMPERATIVE.has(first) || /^(never|always|do not|don't|no |only |must|avoid|prefer)\b/i.test(t);
}

/**
 * Pull the reason out of a rule. Returns { statement, why }. Every word the person wrote stays, in
 * order: the statement is the leading part and the reason is the rest, so statement + why is the rule.
 * A rule that is one instruction and nothing else has no reason, and none is made up for it.
 */
function splitWhy(text) {
  const parts = text.split("\n");
  const head = parts[0];
  const kids = parts.slice(1);
  // A nested bullet that announces itself: "Why: ...", "**Why:** ...", "Because ...".
  const kidWhy = kids.filter((k) => /^\s*(\*\*|__)?(why|reason|rationale|because)\b/i.test(k));
  if (kidWhy.length) {
    const rest = kids.filter((k) => !kidWhy.includes(k));
    const why = squash(kidWhy.map((k) => k.replace(/^\s*(\*\*|__)?(why|reason|rationale|because)\b\s*(\*\*|__)?\s*[:\-—]?\s*(\*\*|__)?\s*/i, "")).join(" "));
    return { statement: squash([head, ...rest].join(" ")), why: why || null };
  }
  const flat = squash(text.replace(/\n/g, " "));
  // An announced reason inside the text: "... Why: ...".
  const m = WHY_MARK.exec(flat);
  if (m && m.index > 8) {
    const why = squash(flat.slice(m.index + m[0].length)).replace(/\)\s*$/, "");
    if (why.length > 3) return { statement: squash(flat.slice(0, m.index)).replace(/[\s(—–-]+$/, ""), why };
  }
  const ss = sentences(flat);
  // A reason joined on with "because", "so that", "otherwise": the statement ends where it starts.
  const k = ss.findIndex((x) => WHY_JOIN.test(" " + x));
  if (k === 0) {
    const j = WHY_JOIN.exec(ss[0]);
    if (j && j.index > 8) {
      const statement = squash(ss[0].slice(0, j.index)).replace(/[,;:(—–-]+$/, "");
      // "because" joins the reason on; it is not part of the reason.
      const why = squash([ss[0].slice(j.index), ...ss.slice(1)].join(" ")).replace(/^because\s+/i, "");
      if (statement.length > 8) return { statement: /[.!?]$/.test(statement) ? statement : statement + ".", why: why.charAt(0).toUpperCase() + why.slice(1) };
    }
  } else if (k > 0) {
    return { statement: ss.slice(0, k).join(" "), why: ss.slice(k).join(" ") };
  }
  // No joining word: the instruction sentences are the statement, and what follows them explains.
  if (ss.length > 1) {
    let n = 1;
    while (n < ss.length && isDirective(ss[n])) n++;
    if (n < ss.length) return { statement: ss.slice(0, n).join(" "), why: ss.slice(n).join(" ") };
  }
  return { statement: flat, why: null };
}

const looksLikePath = (s) => !/\s/.test(s) && !/^https?:/i.test(s) && !/^[-]{1,2}[a-z]/i.test(s) && !/[<>{}$=]/.test(s) &&
  (/^\.{0,2}\/?[\w.@-]+(\/[\w.@*-]+)+\/?$/.test(s) || /^\.[\w-]+(\.[\w*-]+)*$/.test(s) || /^[\w@*-]+(\.[\w*-]+)*\.(md|mdc|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|sql|sh|env|lock|txt|css|scss|html|vue|svelte|ini|cfg|conf|tf|proto|graphql|prisma)$/i.test(s) || /^\*\*?\/|^\*\.[a-z]+$/i.test(s));
function looksLikeCommand(s) {
  const first = s.trim().split(/\s+/)[0] || "";
  if (!/^[a-z][a-z0-9_.+-]*$/.test(first)) return false;
  return KNOWN_BINS.has(first) && (s.trim().includes(" ") || first === s.trim());
}

/** The clause a position sits in: back to the last sentence end, semicolon, comma, " but " or bracket. Used to tell "never X" from "use X". */
function clauseBefore(text, at) {
  const before = text.slice(0, at);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf(", "), before.lastIndexOf(" but "), before.lastIndexOf("("), before.lastIndexOf(": "), before.lastIndexOf(" — "));
  return before.slice(cut < 0 ? 0 : cut);
}

/** The files, commands and names a rule mentions, each marked as something to avoid or not. This is how Unl knows an action touches the rule. */
function triggers(text) {
  const paths = [], commands = [], terms = [];
  const seen = new Set();
  const re = /`([^`\n]{1,120})`/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const avoid = NEGATION.test(clauseBefore(text, m.index));
    if (looksLikeCommand(raw)) commands.push({ text: raw.replace(/\s+/g, " "), avoid });
    else if (looksLikePath(raw)) paths.push({ glob: toGlob(raw), text: raw, avoid });
    else if (/^[\w@/.:+#-]{2,60}$/.test(raw) && !/^\d+$/.test(raw)) terms.push({ text: raw, avoid });
  }
  return { paths, commands, terms };
}

/** A path as written in a rule, as a pattern: a folder covers everything under it. */
function toGlob(p) {
  let g = p.replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  return g;
}

/** How a spoken rule opens ("From now on, ...", "Remember that ..."): part of saying it, not part of its name. */
const OPENER = /^(no[.,!]?\s+|ok(ay)?[.,!]?\s+)?(from now on|going forward|in (the )?future|as a rule|for future reference|remember that|remember to|remember)[,:]?\s+/i;

function titleOf(statement) {
  const bold = /^\s*(?:\*\*|__)(.{4,90}?)(?:\*\*|__)/.exec(statement);
  const plain = stripMd(bold ? bold[1] : statement).replace(/`/g, "");
  // A leading "No." or "Ok." is an answer to something, not the rule.
  const parts = plain.split(/(?<=[.!?])\s+/).filter((x) => !/^(no|yes|ok|okay|right|sure)[.!,]?$/i.test(x.trim()));
  const first = (parts[0] || plain).replace(OPENER, "");
  const t = squash(first).replace(/[.:;,]+$/, "");
  const cut = t.length > 80 ? t.slice(0, 77).replace(/\s+\S*$/, "") + "..." : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** Settings a Cursor rule file carries in its front matter: which files it applies to. */
function frontMatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/.exec(String(text || ""));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Read one file's text into possible decisions. `file` is its path inside the project, used both to
 * judge how strictly to read (a rules file is rules; a README mostly is not) and as where each came from.
 */
function extract(text, file) {
  const rulesFile = RULES_FILE.test(file.replace(/\\/g, "/"));
  const fm = frontMatter(text);
  const fileGlobs = fm.globs ? fm.globs.split(",").map((g) => g.trim()).filter(Boolean) : [];
  const items = [];
  for (const u of units(text)) {
    const rule = isRule(u.text, { rulesFile, kind: u.kind, heading: u.heading });
    if (!rule && !(rulesFile && isLine(u.text, u.kind))) continue;
    const { statement, why } = splitWhy(u.text);
    if (statement.length < 8) continue;
    const t = triggers(u.text.replace(/\n/g, " "));
    // Kept, and marked as a line about the project and not a rule (see isLine).
    if (!rule) t.describes = true;
    for (const g of fileGlobs) t.paths.push({ glob: g, text: g, avoid: false, fromFile: true });
    const section = u.heading[u.heading.length - 1] || null;
    items.push({
      title: titleOf(statement),
      statement,
      why,
      scope: section ? [slug(section, 40)] : [],
      applies_to: t,
      source: { file: file.replace(/\\/g, "/"), line_start: u.start, line_end: u.end, section },
    });
  }
  return items;
}

/** The form two rules are compared in to tell they are the same rule written in two files. */
const sameKey = (statement) => stripMd(statement).toLowerCase().replace(/[`*_"'’.,;:!?()\[\]-]+/g, " ").replace(/\s+/g, " ").trim();

module.exports = { extract, units, isRule, isLine, splitWhy, sentences, isDirective, triggers, titleOf, frontMatter, toGlob, sameKey, RULES_FILE, looksLikePath, looksLikeCommand };
