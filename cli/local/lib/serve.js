"use strict";
/*
 * What bears, and when Unl speaks.
 *
 * Two questions, answered from the index with no model and no network:
 *
 *   forPrompt   the person has asked for something. Which kept decisions bear on it?
 *   forAction   the agent is about to edit a file or run a command. Does a kept decision bear on that
 *               file or command, and is the agent about to do the very thing a decision says not to?
 *
 * The standard is the one a person would hold a colleague to: say the thing that matters when it
 * matters, and otherwise say nothing. Silence is a result here, not a failure. Most actions touch no
 * decision, and for those this returns nothing and the hook prints nothing.
 *
 * Unl hands over what the person decided and why. It never tells the agent what to conclude and never
 * decides whether the action may happen: permission belongs to the tool the agent runs in.
 *
 * THREE THINGS LIVE HERE, AND NONE OF THEM CALLS A MODEL.
 *
 *   forPrompt, forAction   what the words of the ask and the place of the file find. This is what is
 *                          handed when the judge is switched off or cannot run. It is broad on purpose:
 *                          a decision that bears and is left out is the failure to avoid, and the agent
 *                          can set aside what does not bear. Each hit says whether it is `sure` (the work
 *                          names the particular thing the decision is about, or sits in its place).
 *   forJudge               the wide net a judge chooses from: every decision while the record is small,
 *                          the nearest ones once it is large. Never handed to the agent as it stands.
 *   crossings              inside forAction: the action is the very thing a decision says not to do.
 *                          That is decided here, with no model, so Unl speaks first at once.
 *
 * The judge itself is in judge.js and the choosing is put together in choose.js.
 *
 * WHY THE WORDS ALONE ARE BROAD AGAIN. For a few hours this handed a decision only when the ask named the
 * particular thing it was about. On 570 pieces of real work in 20 public repositories that made what it
 * handed three times as likely to bear, and it reached a third as many of the decisions that did bear
 * (7 in 100, down from 22). Reaching fewer is the wrong trade: quality is misses first, then noise, then
 * size. So the words find what they found before, and telling what bears from what does not is the
 * judge's work, not a narrower match.
 */
const path = require("path");
const { words } = require("./text");

/**
 * How much to hand over at once. One profile for now; the place a per-model profile plugs in.
 *   maxPerPrompt, maxPerAction   what the words and the place may hand with no judge
 *   maxFull, maxHeld             what a judge may hand in full, and as one line each
 *   maxCandidates                past this many decisions the judge is shown the nearest, not the whole record
 *   maxNet                       how far down the wide net is handed, one line each, when the judge was asked
 *                                and could not answer. Measured on 800 pieces of work: the top 8 of each call
 *                                reach 228 of the 242 bearing decisions the whole net reaches, and the curve is
 *                                flat after that
 */
const PROFILE = { maxPerPrompt: 6, maxPerAction: 3, maxFull: 8, maxHeld: 8, maxCandidates: 60, maxNet: 8 };

/** A glob as a regular expression: ** crosses folders, * stays inside one. */
function globToRegex(glob) {
  let re = "";
  const g = String(glob).replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** Does a file (given inside the project, forward slashes) fall under a decision's path? A bare name matches that name in any folder. */
function pathMatches(glob, rel) {
  const g = String(glob).replace(/^\.\//, "");
  if (!g) return false;
  if (globToRegex(g).test(rel)) return true;
  if (!g.includes("/")) return globToRegex(g).test(path.posix.basename(rel));
  // A folder written without a trailing slash covers what is under it.
  return !/[*?]/.test(g) && rel.startsWith(g.replace(/\/$/, "") + "/");
}

const tokens = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);

/** Is the command a decision names being run here? Its words must appear together, in order, as whole words. */
/**
 * The same flag written another way. Only what the tool itself documents as the same switch, and only for
 * commands a rule is likely to forbid; anything not listed is compared as written, so `--force-with-lease`
 * is never read as `--force`. Measured on Codex 0.162: told nothing, the agent ran `git add --all` where
 * the person had kept "never `git add -A`", and a match on the letters let it through.
 */
const FLAG_ALIASES = {
  "git add": { "--all": "-A", "--force": "-f" },
  "git commit": { "--all": "-a", "--no-verify": "-n" },
  "git push": { "--force": "-f" },
  "git clean": { "--force": "-f" },
  "git reset": {},
  "rm": { "--recursive": "-r", "-R": "-r", "--force": "-f" },
};

/** A command as its words in order and its flags as a set: `git -C x add --all src` is git add {-A}. */
function shape(toks) {
  const t = [...toks];
  // git's own options before the subcommand, with their values: `git -C dir add -A` is still `git add -A`.
  if (t[0] === "git") for (let i = 1; i < t.length && t[i].startsWith("-"); ) { if (/^-(C|c)$/.test(t[i])) t.splice(i, 2); else i++; }
  const words = [], flags = new Set();
  for (const x of t) {
    if (x === "--") { words.push(x); continue; }
    if (/^-[A-Za-z]{2,}$/.test(x)) { for (const ch of x.slice(1)) flags.add("-" + ch); continue; } // -rf is -r -f
    if (/^--?[A-Za-z]/.test(x)) { flags.add(x.replace(/=.*$/, "")); continue; }
    words.push(x);
  }
  const key = FLAG_ALIASES[words.slice(0, 2).join(" ")] ? words.slice(0, 2).join(" ") : FLAG_ALIASES[words[0]] ? words[0] : null;
  const alias = key ? FLAG_ALIASES[key] : {};
  return { words, flags: new Set([...flags].map((f) => alias[f] || f)) };
}

/** What runs another command: `sudo git add -A` and `npx drizzle-kit push` are the command after it. */
const WRAPPER = /^(sudo|env|time|nohup|command|exec|npx|bunx)$/;

function commandMatches(named, command) {
  const want = tokens(named).filter((t) => !/[<>]/.test(t));
  // Stop at the first shell joiner in what the rule named: `x | tail` names x.
  const cut = want.findIndex((t) => /^(\||\|\||&&|;|>|>>|2>&1)$/.test(t));
  const head = cut >= 0 ? want.slice(0, cut) : want;
  if (!head.length) return false;
  const rule = shape(head.slice(WRAPPER.test(head[0]) && head.length > 1 ? 1 : 0));
  // Each simple command in what the agent is about to run is looked at by itself.
  for (const part of String(command || "").split(/\|\||&&|[;|\n]|\$\(|`/)) {
    const have = tokens(part.replace(/^[\s(]+/, ""));
    // Skip leading VAR=value assignments and common wrappers so `sudo git add -A` is still `git add -A`.
    let start = 0;
    while (start < have.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(have[start]) || WRAPPER.test(have[start]))) start++;
    const h = have.slice(start);
    if (head.length === 1) { if (h[0] === head[0] || have[0] === head[0]) return true; continue; }
    // The command itself must be the one named, word for word from its start, with every flag the rule names.
    const run = shape(h);
    if (rule.words.length && rule.words.every((w, k) => run.words[k] === w) && [...rule.flags].every((f) => run.flags.has(f))) return true;
  }
  return false;
}

/** Command names that are also ordinary words. Seeing one in a sentence does not mean the command was meant. */
const ORDINARY = new Set("make go find cat env source export time set test sort head tail less more kill top yes true false which who date echo read wait touch sleep watch open say help history type link file cut paste join split diff patch tree clear exit bundle rake swift dart flutter black fly composer helm pod brew node java python sh".split(" "));

/** Does text contain a name as a whole word? */
const hasWord = (text, name) => new RegExp(`(^|[^A-Za-z0-9_@/-])${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(String(text || ""));

/** The words of a prompt scored against one decision. Returns the shared telling words and a score. */
function lexical(index, entry, promptWords) {
  const n = index.count || 1;
  let score = 0;
  const hits = [];
  const k1 = 1.2, b = 0.75;
  for (const w of promptWords) {
    const tf = entry.words[w];
    if (!tf) continue;
    const df = index.df[w] || 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (entry.len / (index.avg_len || 1))));
    if (entry.key.includes(w)) hits.push(w);
  }
  return { score, hits };
}

/** An index written before decisions carried their kind works it out from what the decision names, the same way. */
function kindOfEntry(e) {
  return e.kind || require("./index").kindOf({ paths: e.paths, terms: e.terms });
}

/** What in the ask names something this decision names: a file or folder, a command of several words, an identifier. */
function namedIn(e, text) {
  return [...new Set([
    ...e.commands.filter((c) => tokens(c.text).length > 1 && text.replace(/\s+/g, " ").includes(c.text)).map((c) => c.text),
    ...e.terms.filter((t) => t.text.length >= 4 && hasWord(text, t.text)).map((t) => t.text),
    // A folder is kept as `folder/**`; it is named when the ask names the folder. Any other wildcard is not a name.
    ...e.paths.filter((p) => { const at = String(p.glob).replace(/\/\*\*$/, ""); return !/[*?]/.test(at) && at.includes("/") && text.includes(at); }).map((p) => p.glob),
  ])];
}

/** The commands this decision says to avoid that the ask names: a command of several words as written, or one word that is not an ordinary word. */
function avoidedIn(e, text) {
  const flat = text.replace(/\s+/g, " ");
  return [...new Set(e.commands.filter((c) => c.avoid && (tokens(c.text).length > 1 ? flat.includes(c.text) : !ORDINARY.has(c.text) && c.text.length >= 3 && hasWord(text, c.text))).map((c) => c.text))];
}

/** A name the ask shares with a decision that is too short or too common to be sure of: a three-letter name, a one-word command. */
function looselyNamedIn(e, text) {
  return [...new Set([
    ...e.commands.filter((c) => tokens(c.text).length === 1 && !ORDINARY.has(c.text) && c.text.length >= 3 && hasWord(text, c.text)).map((c) => c.text),
    ...e.terms.filter((t) => t.text.length === 3 && hasWord(text, t.text)).map((t) => t.text),
  ])];
}

/** Every decision the words of the ask find, best first, uncut. */
function promptHits(index, prompt, seen) {
  const text = String(prompt || "");
  const pw = [...new Set(words(text))];
  const out = [];
  for (const e of index.decisions) {
    // A line about the project is never handed on words alone: only a judge that has read the work hands one.
    if (seen.has(e.id) || kindOfEntry(e) === "describes") continue;
    // The ask names the very command a decision says to avoid ("run npm install" where the person kept
    // "use pnpm, never npm"): the crossing is on its way, so this one is sure whatever the decision applies to.
    const avoided = avoidedIn(e, text);
    const named = namedIn(e, text);
    const sure = avoided.length > 0 || (named.length > 0 && kindOfEntry(e) === "particular");
    const loose = looselyNamedIn(e, text);
    const { score, hits } = lexical(index, e, pw);
    const names = [...new Set([...avoided, ...named, ...loose])];
    if (names.length) out.push({ entry: e, kind: "names", matched: names, score: score + 10, sure });
    // One shared word is how noise gets in, so one is not enough.
    else if (hits.length >= 2) out.push({ entry: e, kind: "words", matched: hits, score, sure: false });
  }
  return out.sort((a, b) => b.score - a.score || (a.entry.rid < b.entry.rid ? -1 : 1));
}

/** The best `max` of a ranked list, and after them any sure hit the cut would have dropped. */
function cut(ranked, max) {
  const top = ranked.slice(0, max);
  for (const h of ranked.slice(max)) if (h.sure && top.length < max * 2) top.push(h);
  return top;
}

/**
 * The decisions the words of the ask find. A decision is found when the ask names something the decision
 * names (a file, a folder, a command, an identifier), or shares at least two of the words that tell that
 * decision from the others. This is what is handed when no judge runs, and it is never the whole record.
 * A hit is `sure` when the ask names the particular thing a decision is about, or a command it says to
 * avoid; the rest are found on words and may well not bear.
 */
function forPrompt(index, prompt, { seen = new Set(), profile = PROFILE } = {}) {
  if (!index || !index.count) return [];
  return cut(promptHits(index, prompt, seen), profile.maxPerPrompt);
}

/** Every decision an action touches, uncut: crossings first. */
function actionHits(index, action, seen) {
  const rel = action.path ? String(action.path).replace(/\\/g, "/") : null;
  const command = action.command || "";
  const added = action.content || "";
  const out = [];
  for (const e of index.decisions) {
    let hit = null;
    // A line about the project names a place without saying what to keep true of it, so its place hands nothing.
    const skip = seen.has(e.id) || kindOfEntry(e) === "describes";
    if (command) {
      const c = e.commands.find((x) => x.avoid && commandMatches(x.text, command));
      if (c) hit = { kind: "crossing", matched: [c.text], what: "command", sure: true };
      else if (!skip) {
        const u = e.commands.find((x) => !x.avoid && tokens(x.text).length > 1 && commandMatches(x.text, command));
        if (u) hit = { kind: "bears", matched: [u.text], what: "command", sure: false };
      }
    }
    if (!hit && rel) {
      const no = e.paths.find((p) => p.avoid && pathMatches(p.glob, rel));
      if (no) hit = { kind: "crossing", matched: [no.glob], what: "path", sure: true };
      else if (!skip) {
        const on = e.paths.find((p) => !p.avoid && pathMatches(p.glob, rel));
        // Sure when it is a place in the project, not a bare file name: `package.json` in a rule does not
        // make it about every package.json, only about the one at the root that has exactly that name.
        const placed = kindOfEntry(e) === "particular" && e.paths.some((p) => !p.avoid && (String(p.glob).includes("/") ? pathMatches(p.glob, rel) : p.glob === rel));
        if (on) hit = { kind: "bears", matched: [on.glob], what: "path", sure: placed };
      }
    }
    if (!hit && added && !skip) {
      const t = e.terms.find((x) => x.avoid && x.text.length >= 4 && hasWord(added, x.text));
      if (t) hit = { kind: "bears", matched: [t.text], what: "content", sure: true };
    }
    if (hit) out.push({ entry: e, ...hit });
  }
  const rank = (h) => (h.kind === "crossing" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.entry.rid < b.entry.rid ? -1 : 1));
}

/**
 * The decisions an action touches.
 *   crossing  the action is the thing a decision says not to do: it runs a command the decision says
 *             to avoid, or edits a file the decision says not to touch. Unl speaks first. This holds for
 *             every decision, standing ones too: "never git add -A" applies to every change, and the
 *             moment to say it is the moment the command is about to run.
 *   bears     the action is on a file a decision names, runs a command a decision is about, or adds a
 *             name a decision says to avoid. Unl hands the decision over without stopping anything.
 */
function forAction(index, action, { seen = new Set(), profile = PROFILE } = {}) {
  if (!index || !index.count) return [];
  return cut(actionHits(index, action, seen), profile.maxPerAction);
}

/** Only what is sure, uncut: what a judge may shorten to a line and may never drop. */
function sureFor(index, work, { seen = new Set() } = {}) {
  if (!index || !index.count) return [];
  const hits = work.path || work.command ? actionHits(index, work, seen).filter((h) => h.kind !== "crossing") : promptHits(index, work.prompt, seen);
  return hits.filter((h) => h.sure);
}

/**
 * Everything that MIGHT bear, ranked, with why each was caught. Never handed to the agent as it stands.
 *
 * This is the wide net: the decisions the ask or the action shares a name, a place or telling words
 * with, standing rules included. It finds far more of what bears than the words alone, and most of what
 * it finds does not bear, which is why it goes to a judge and not to the agent.
 */
function candidates(index, { prompt = "", path: file = null, command = "", content = "" } = {}, { limit = PROFILE.maxCandidates } = {}) {
  if (!index || !index.count) return [];
  const rel = file ? String(file).replace(/\\/g, "/") : null;
  const text = [prompt, command, content, rel ? rel.replace(/[\/._-]+/g, " ") : ""].join("\n");
  const tw = [...new Set(words(text))];
  const out = [];
  for (const e of index.decisions) {
    const why = [];
    let score = 0;
    const named = namedIn(e, [prompt, command, content].join("\n"));
    if (named.length) { why.push("names " + named.slice(0, 3).join(", ")); score += 10; }
    if (rel) {
      const on = e.paths.find((p) => pathMatches(p.glob, rel));
      if (on) { why.push("place " + on.glob); score += 8; }
    }
    if (command && e.commands.some((c) => commandMatches(c.text, command))) { why.push("command"); score += 8; }
    const lex = lexical(index, e, tw);
    if (lex.hits.length) { why.push("words " + lex.hits.slice(0, 4).join(", ")); score += lex.score; }
    if (score > 0) out.push({ entry: e, kind: "candidate", matched: why, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.entry.rid < b.entry.rid ? -1 : 1)).slice(0, limit);
}

/**
 * The list a judge is shown, in the record's own order. While the record is small that is every decision
 * not already handed in this session: a reader who understands the work finds what no shared word points
 * at, so nothing is held back from it. Once the record is larger than `maxCandidates` it is the nearest
 * ones from the wide net, because a judge shown hundreds reads none of them well.
 */
function forJudge(index, work, { seen = new Set(), profile = PROFILE } = {}) {
  if (!index || !index.count) return [];
  const wide = candidates(index, work, { limit: Infinity });
  const why = new Map(wide.map((c) => [c.entry.id, c]));
  const open = index.decisions.filter((e) => !seen.has(e.id));
  const chosen = open.length <= profile.maxCandidates ? open : new Set(wide.filter((c) => !seen.has(c.entry.id)).slice(0, profile.maxCandidates).map((c) => c.entry.id));
  const list = Array.isArray(chosen) ? chosen : open.filter((e) => chosen.has(e.id));
  return list.map((e) => why.get(e.id) || { entry: e, kind: "candidate", matched: [], score: 0 });
}

/**
 * Is an agent about to keep, change or retire a decision with its own hands? Only a person does that.
 * Two ways it could try: running Unl's own command for it, or writing straight into the record or the
 * decision files. Reading them, and committing them with git, is ordinary work and is left alone.
 * Returns what it would touch, or null.
 */
function againstTheFence(action) {
  const command = String(action.command || "");
  if (command) {
    for (const part of command.split(/\|\||&&|[;|\n]/)) {
      const c = part.trim();
      if (/(^|\s)(npx\s+(-y\s+|--yes\s+)?(unlimitless|unl-open)|unl|unl-open|node\s+\S*unl\.js)\s+(keep|replace|retire|review)\b/.test(c)) return "the command that keeps, replaces or retires a decision";
      if (/\.git\/unl\b|\.unl\/decisions\b/.test(c) && !/^(ls|cat|head|tail|wc|grep|rg|find|less|stat|file|du|open|code|git\s+(status|diff|log|show|add|commit|restore|checkout|stash|mv|rm))\b/.test(c)) return "Unl's own record of decisions";
    }
  }
  const p = action.path ? String(action.path).replace(/\\/g, "/") : "";
  if (/^\.unl\/decisions\//.test(p) || /^\.git\/unl\//.test(p)) return "Unl's own record of decisions";
  return null;
}

module.exports = { forPrompt, forAction, sureFor, candidates, forJudge, namedIn, againstTheFence, pathMatches, commandMatches, globToRegex, hasWord, lexical, PROFILE };
